import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoServerError } from 'mongodb';
import InstanceLease, {
  INSTANCE_LEASE_SINGLETON_ID,
  INSTANCE_LEASE_STATUS,
  InstanceLeaseSlot
} from '../models/instanceLease.js';
import * as instanceLeaseService from '../services/instanceLeaseService.js';
import { withRequiredTransaction } from '../utils/dbTransaction.js';
import Form from '../models/form.js';
import User from '../models/user.js';
import SubmissionReservation from '../models/submissionReservation.js';
import EmailService from '../services/EmailService.js';
import { register, forgotPassword } from './authController.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('Phase 4.4 Workstream 2D.1K.3: 16-Slot Transactional Fencing & Auth Verification Suite', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await startReplSet([InstanceLease, InstanceLeaseSlot, Form, User, SubmissionReservation]);
  });

  afterAll(async () => {
    instanceLeaseService.stopHeartbeat();
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    instanceLeaseService.stopHeartbeat();
    instanceLeaseService.resetFencedForTesting();
    instanceLeaseService.resetSystemUptimeForTesting();
    instanceLeaseService.resetLocalLeaseDeadlineForTesting();
    await InstanceLease.deleteMany({});
    await InstanceLeaseSlot.deleteMany({});
    await Form.deleteMany({});
    await User.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await instanceLeaseService.ensureInstanceSingletonExists();
    await instanceLeaseService.ensureSlotsExist();
  });

  afterEach(async () => {
    instanceLeaseService.stopHeartbeat();
    instanceLeaseService.resetFencedForTesting();
    instanceLeaseService.resetSystemUptimeForTesting();
    instanceLeaseService.resetLocalLeaseDeadlineForTesting();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: Core 16-Slot Transactional Fencing Tests
  // =========================================================================

  it('TS-TF-01: Dual-fencing with transactional conditional write updates designated slot fenceEpoch', async () => {
    // 1. Instance A acquires lease
    const acquireRes = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });
    expect(acquireRes.success).toBe(true);

    const partitionKey = 'partition-test-slot-1';
    // Calculate designated slot
    let hash = 0;
    for (let i = 0; i < partitionKey.length; i++) {
      hash = (hash << 5) - hash + partitionKey.charCodeAt(i);
      hash |= 0;
    }
    const slotId = `slot_${Math.abs(hash) % 16}`;
    const initialSlot = await InstanceLeaseSlot.findById(slotId).lean();
    const initialEpoch = initialSlot.fenceEpoch || 0;

    // 2. Execute a transaction via withRequiredTransaction
    const createdForm = await withRequiredTransaction(async (session) => {
      const form = new Form({
        title: 'Fenced Form Test',
        ownerId: new mongoose.Types.ObjectId(),
        status: 'draft'
      });
      await form.save({ session });
      return form;
    }, { partitionKey });

    expect(createdForm).toBeDefined();
    expect(createdForm.title).toBe('Fenced Form Test');

    // 3. Verify that the designated slot recorded activity and bumped fenceEpoch in WiredTiger
    const updatedSlot = await InstanceLeaseSlot.findById(slotId).lean();
    expect(updatedSlot.lastTouchAt).toBeDefined();
    expect(updatedSlot.fenceEpoch).toBe(initialEpoch + 1);

    // Verify form was committed
    const found = await Form.findById(createdForm._id).lean();
    expect(found).not.toBeNull();
  });

  // =========================================================================
  // Section 2: The 12 Mandated Integration & Failure-Injection Tests (TS-K-A-01 to TS-K-A-12)
  // =========================================================================

  it('TS-K-A-01: In-flight transaction started under old lease cannot commit after takeover', async () => {
    // 1. Leader A acquires deployment lease
    const acquireA = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });
    expect(acquireA.success).toBe(true);

    const partitionKey = 'test-form-partition-1';
    const txStartedDeferred = createDeferred();
    const takeoverDoneDeferred = createDeferred();

    // 2. Start in-flight transaction on Leader A
    const txPromise = withRequiredTransaction(async (session) => {
      const form = new Form({
        title: 'Zombie In-Flight Form',
        ownerId: new mongoose.Types.ObjectId(),
        status: 'draft'
      });
      await form.save({ session });

      // Signal that write occurred
      txStartedDeferred.resolve();

      // Await Standby Takeover completion
      await takeoverDoneDeferred.promise;
    }, { partitionKey });

    // Wait until Leader A has executed uncommitted write
    await txStartedDeferred.promise;

    // 3. Simulate lease expiration in datastore to allow takeover
    await InstanceLease.updateOne(
      { _id: INSTANCE_LEASE_SINGLETON_ID },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    // 4. Standby Leader B performs takeover
    const takeoverRes = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-B',
      leaseTtlMs: 30000,
      quarantineCooldownMs: 0,
      skipHeartbeat: true
    });
    expect(takeoverRes.success).toBe(true);

    // Condition E-5: Restore Leader A identity in memory so Leader A's resuming transaction
    // checks its own instanceId ('inst-A') against the slots now owned by 'inst-B'
    instanceLeaseService.setActiveInstanceIdForTesting('inst-A');

    // 5. Release Leader A to attempt commit
    takeoverDoneDeferred.resolve();

    // 6. Assert transaction on Leader A fails with InstanceFencedError
    await expect(txPromise).rejects.toThrow(/InstanceFencedError|fenced|lease slot/i);

    // 7. Verify WiredTiger rollback: Stale form must NOT exist
    const formCount = await Form.countDocuments({ title: 'Zombie In-Flight Form' });
    expect(formCount).toBe(0);

    // 8. Verify datastore state remains consistently owned by inst-B
    const singleton = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(singleton.instanceId).toBe('inst-B');
  });

  it('TS-K-A-02: Concurrent takeover attempts cannot leave singleton and slots inconsistent', async () => {
    // Reset singleton to expired/released state
    await InstanceLease.updateOne(
      { _id: INSTANCE_LEASE_SINGLETON_ID },
      { $set: { status: INSTANCE_LEASE_STATUS.RELEASED, expiresAt: new Date(0) } }
    );

    // Both Instance B and Instance C attempt takeover simultaneously
    const [resB, resC] = await Promise.all([
      instanceLeaseService.acquireInstanceLease({
        instanceId: 'inst-B',
        leaseTtlMs: 30000,
        quarantineCooldownMs: 0,
        skipHeartbeat: true
      }),
      instanceLeaseService.acquireInstanceLease({
        instanceId: 'inst-C',
        leaseTtlMs: 30000,
        quarantineCooldownMs: 0,
        skipHeartbeat: true
      })
    ]);

    // Exactly one instance must succeed, one must fail
    const successes = [resB, resC].filter((r) => r.success);
    const failures = [resB, resC].filter((r) => !r.success);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const winnerInstanceId = successes[0].instanceId || (resB.success ? 'inst-B' : 'inst-C');
    const loserInstanceId = winnerInstanceId === 'inst-B' ? 'inst-C' : 'inst-B';

    // 1. Verify Singleton consistency
    const singleton = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(singleton.instanceId).toBe(winnerInstanceId);
    expect(singleton.status).toBe(INSTANCE_LEASE_STATUS.ACTIVE);

    // 2. Verify all 16 Slots consistency
    const slots = await InstanceLeaseSlot.find({}).lean();
    expect(slots).toHaveLength(16);
    for (const slot of slots) {
      expect(slot.instanceId).toBe(winnerInstanceId);
      expect(slot.status).toBe(INSTANCE_LEASE_STATUS.ACTIVE);
      expect(slot.version).toBe(singleton.version);
    }

    // 3. Verify zero slots belong to loser instance
    const loserSlots = await InstanceLeaseSlot.countDocuments({ instanceId: loserInstanceId });
    expect(loserSlots).toBe(0);
  });

  it('TS-K-A-03: Missing slots cause initialization to fail closed', async () => {
    await InstanceLeaseSlot.deleteMany({});

    // Seed only 15 slots (slot_15 is missing)
    const partialSlots = Array.from({ length: 15 }, (_, i) => ({
      _id: `slot_${i}`,
      slotIndex: i,
      instanceId: null,
      version: 0,
      status: INSTANCE_LEASE_STATUS.RELEASED,
      expiresAt: new Date(0),
      lastTouchAt: null,
      fenceEpoch: 0
    }));
    await InstanceLeaseSlot.insertMany(partialSlots);

    // Mock bulkWrite to simulate a no-op failure where slot_15 is not inserted
    const bulkWriteSpy = vi.spyOn(InstanceLeaseSlot, 'bulkWrite').mockResolvedValueOnce({ ok: 1 });

    // ensureSlotsExist must fail closed because count !== 16
    await expect(instanceLeaseService.ensureSlotsExist()).rejects.toThrow(
      /Slot verification failed|expected 16 slots/i
    );

    bulkWriteSpy.mockRestore();
  });

  it('TS-K-A-04: Existing slots missing legacy fenceEpoch are migrated safely', async () => {
    await InstanceLeaseSlot.deleteMany({});
    const rawCollection = mongoose.connection.collection('app_instance_lease_slots');

    // Insert 16 legacy slots without fenceEpoch directly into collection
    const legacyDocs = Array.from({ length: 16 }, (_, i) => ({
      _id: `slot_${i}`,
      slotIndex: i,
      instanceId: null,
      version: 0,
      status: 'RELEASED',
      expiresAt: new Date(0),
      lastTouchAt: null
      // fenceEpoch field omitted
    }));
    await rawCollection.insertMany(legacyDocs);

    // Verify missing fenceEpoch pre-migration
    const preCount = await rawCollection.countDocuments({ fenceEpoch: { $exists: false } });
    expect(preCount).toBe(16);

    // Execute migration via ensureSlotsExist
    await instanceLeaseService.ensureSlotsExist();

    // Verify post-migration state
    const postMissing = await rawCollection.countDocuments({ fenceEpoch: { $exists: false } });
    expect(postMissing).toBe(0);

    const postZero = await InstanceLeaseSlot.countDocuments({ fenceEpoch: 0 });
    expect(postZero).toBe(16);
  });

  it('TS-K-A-05: Existing nonzero epochs are never reset by migration', async () => {
    await InstanceLeaseSlot.deleteMany({});
    const rawCollection = mongoose.connection.collection('app_instance_lease_slots');

    // Seed slot_0 with 42, slot_1 with 99, and slots 2-15 without fenceEpoch
    const docs = [
      { _id: 'slot_0', slotIndex: 0, fenceEpoch: 42, status: 'RELEASED', expiresAt: new Date(0) },
      { _id: 'slot_1', slotIndex: 1, fenceEpoch: 99, status: 'RELEASED', expiresAt: new Date(0) },
      ...Array.from({ length: 14 }, (_, i) => ({
        _id: `slot_${i + 2}`,
        slotIndex: i + 2,
        status: 'RELEASED',
        expiresAt: new Date(0)
      }))
    ];
    await rawCollection.insertMany(docs);

    // Run ensureSlotsExist
    await instanceLeaseService.ensureSlotsExist();

    // Assert preserved epochs
    const slot0 = await InstanceLeaseSlot.findById('slot_0').lean();
    expect(slot0.fenceEpoch).toBe(42);

    const slot1 = await InstanceLeaseSlot.findById('slot_1').lean();
    expect(slot1.fenceEpoch).toBe(99);

    const slot2 = await InstanceLeaseSlot.findById('slot_2').lean();
    expect(slot2.fenceEpoch).toBe(0);

    // Assert idempotency on second run
    await instanceLeaseService.ensureSlotsExist();
    const slot0Again = await InstanceLeaseSlot.findById('slot_0').lean();
    expect(slot0Again.fenceEpoch).toBe(42);
  });

  it('TS-K-A-06: All 16 slots are validated before fenced transactions proceed', async () => {
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    // Corrupt the slot pool by deleting slot_4
    await InstanceLeaseSlot.deleteOne({ _id: 'slot_4' });

    // Compute a partition key that deterministically hashes to slot_4
    // Find key where hash % 16 === 4
    let targetKey = 'slot_4_key';
    for (let k = 0; k < 1000; k++) {
      const candidate = `test_key_${k}`;
      let h = 0;
      for (let i = 0; i < candidate.length; i++) {
        h = (h << 5) - h + candidate.charCodeAt(i);
        h |= 0;
      }
      if (Math.abs(h) % 16 === 4) {
        targetKey = candidate;
        break;
      }
    }

    const txPromise = withRequiredTransaction(async (session) => {
      const form = new Form({
        title: 'Corrupted Slot Pool Form',
        ownerId: new mongoose.Types.ObjectId()
      });
      await form.save({ session });
    }, { partitionKey: targetKey });

    // verifyTransactionalFence must fail closed on matchedCount !== 1
    await expect(txPromise).rejects.toThrow(/InstanceFencedError|slot_4 no longer held/i);

    const count = await Form.countDocuments({ title: 'Corrupted Slot Pool Form' });
    expect(count).toBe(0);
  });

  it('TS-K-A-07: Same-slot transaction contention behaves correctly (write conflict & retry)', async () => {
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    const slotBefore = await InstanceLeaseSlot.findById('slot_0').lean();
    const initialEpoch = slotBefore.fenceEpoch || 0;

    // Find partition key mapping to slot_0
    let partitionKey = 'slot_0_key';
    for (let k = 0; k < 1000; k++) {
      const candidate = `key_${k}`;
      let h = 0;
      for (let i = 0; i < candidate.length; i++) {
        h = (h << 5) - h + candidate.charCodeAt(i);
        h |= 0;
      }
      if (Math.abs(h) % 16 === 0) {
        partitionKey = candidate;
        break;
      }
    }

    const runTx = (title) =>
      withRequiredTransaction(
        async (session) => {
          const form = new Form({
            title,
            ownerId: new mongoose.Types.ObjectId()
          });
          await form.save({ session });
          return form;
        },
        { partitionKey }
      );

    // Run both transactions concurrently
    const [form1, form2] = await Promise.all([
      runTx('Contention Form 1'),
      runTx('Contention Form 2')
    ]);

    expect(form1).toBeDefined();
    expect(form2).toBeDefined();

    // Verify both forms committed in WiredTiger
    expect(await Form.countDocuments({ title: 'Contention Form 1' })).toBe(1);
    expect(await Form.countDocuments({ title: 'Contention Form 2' })).toBe(1);

    // Verify sequential monotonic increments: exactly initial + 2
    const slotAfter = await InstanceLeaseSlot.findById('slot_0').lean();
    expect(slotAfter.fenceEpoch).toBe(initialEpoch + 2);
  });

  it('TS-K-A-08: Selected fencing slot remains stable across driver callback retries', async () => {
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    const capturedSlotIds = [];
    let attemptCount = 0;

    const originalVerifyFence = instanceLeaseService.verifyTransactionalFence;
    const fenceSpy = vi.spyOn(instanceLeaseService, 'verifyTransactionalFence')
      .mockImplementation(async (session, options) => {
        capturedSlotIds.push(options?.slotId);
        attemptCount++;
        if (attemptCount === 1) {
          // Inject transient conflict on attempt 1 using authentic MongoServerError
          const transientError = new MongoServerError({ message: 'Simulated transient write conflict' });
          transientError.addErrorLabel('TransientTransactionError');
          throw transientError;
        }
        return originalVerifyFence(session, options);
      });

    await withRequiredTransaction(
      async (session) => {
        const form = new Form({
          title: 'Stable Slot Retry Form',
          ownerId: new mongoose.Types.ObjectId()
        });
        await form.save({ session });
      },
      { partitionKey: 'test-retry-partition' }
    );

    fenceSpy.mockRestore();

    // Must have executed 2 attempts
    expect(attemptCount).toBe(2);
    expect(capturedSlotIds).toHaveLength(2);
    expect(capturedSlotIds[0]).toBeDefined();
    // Outer-scope closure invariant: attempt 1 slot MUST equal attempt 2 slot
    expect(capturedSlotIds[0]).toBe(capturedSlotIds[1]);
  });

  it('TS-K-A-09: Session propagation is maintained across all auth reads and writes', async () => {
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    // 1. Verify User.create session plumbing in register
    const userCreateSpy = vi.spyOn(User, 'create');

    // Force fence failure during registration transaction to verify rollback
    vi.spyOn(instanceLeaseService, 'verifyTransactionalFence').mockRejectedValueOnce(
      new instanceLeaseService.InstanceFencedError('Datastore transactional fence failed: simulated registration abort')
    );

    const reqReg = {
      body: {
        name: 'Session Test User',
        email: 'session-test@example.com',
        password: 'password123'
      }
    };
    const resReg = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      cookie: vi.fn().mockReturnThis()
    };
    let regError = null;
    const nextReg = (err) => { regError = err; };

    await register(reqReg, resReg, nextReg);

    // Assert session was passed into User.create
    expect(userCreateSpy).toHaveBeenCalled();
    const createOpts = userCreateSpy.mock.calls[0][1];
    expect(createOpts?.session).toBeDefined();
    expect(regError).toBeDefined();

    // Assert rollback: user does NOT exist
    const userInDb = await User.findOne({ email: 'session-test@example.com' });
    expect(userInDb).toBeNull();

    userCreateSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('TS-K-A-10: Failed fence causes complete transaction abort without retry spinning', async () => {
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    let formId;
    const startTime = Date.now();

    const txPromise = withRequiredTransaction(async (session) => {
      const form = new Form({
        title: 'Failed Fence Rollback Form',
        ownerId: new mongoose.Types.ObjectId()
      });
      await form.save({ session });
      formId = form._id;

      // Simulate leader loss during transaction execution
      instanceLeaseService.markFencedForTesting();
    }, { partitionKey: 'test-fencing-rollback' });

    await expect(txPromise).rejects.toThrow(instanceLeaseService.InstanceFencedError);
    const duration = Date.now() - startTime;

    // Must fail immediately without spinning through driver retries (Condition K-A.3)
    expect(duration).toBeLessThan(3000);

    // Verify complete WiredTiger rollback
    const found = await Form.findById(formId);
    expect(found).toBeNull();
  });

  it('TS-K-A-11: Callback retry does not duplicate external side effects (emails/cookies)', async () => {
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    // Create active user
    await User.create({
      name: 'Forgot Password User',
      email: 'forgot-side-effect@example.com',
      password: 'Password123!'
    });

    const sendEmailSpy = vi.spyOn(EmailService.prototype, 'sendEmail')
      .mockResolvedValue({ id: 'msg-123' });

    // Simulate a transient write conflict on attempt 1 of the transaction
    let attempt = 0;
    const origFind = User.findByIdAndUpdate;
    const findSpy = vi.spyOn(User, 'findByIdAndUpdate').mockImplementation(function (...args) {
      attempt++;
      if (attempt === 1) {
        const conflict = new MongoServerError({ message: 'Transient write conflict in auth update' });
        conflict.addErrorLabel('TransientTransactionError');
        throw conflict;
      }
      return origFind.apply(User, args);
    });

    const req = { body: { email: 'forgot-side-effect@example.com' } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };
    const next = vi.fn();

    await forgotPassword(req, res, next);

    // Assert transaction retried and succeeded
    expect(attempt).toBe(2);

    // Assert Email was sent EXACTLY ONCE
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);

    findSpy.mockRestore();
    sendEmailSpy.mockRestore();
  });

  it('TS-K-A-12: Incomplete takeover rolls back completely', async () => {
    // Leader A holds lease and slots
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    const initialSingleton = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    const initialVersion = initialSingleton.version;

    // Expire lease to allow takeover attempt
    await InstanceLease.updateOne(
      { _id: INSTANCE_LEASE_SINGLETON_ID },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    // Inject failure during InstanceLeaseSlot.updateMany inside takeover transaction
    const origUpdateMany = InstanceLeaseSlot.updateMany.bind(InstanceLeaseSlot);
    const slotUpdateSpy = vi.spyOn(InstanceLeaseSlot, 'updateMany').mockImplementation(function (...args) {
      if (args[2]?.session) {
        throw new Error('Simulated network disconnect during slot update');
      }
      return origUpdateMany(...args);
    });

    const takeoverRes = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-B',
      quarantineCooldownMs: 0,
      skipHeartbeat: true
    });

    expect(takeoverRes.success).toBe(false);
    slotUpdateSpy.mockRestore();

    // 1. Verify Singleton was rolled back to inst-A
    const currentSingleton = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(currentSingleton.instanceId).toBe('inst-A');
    expect(currentSingleton.version).toBe(initialVersion);

    // 2. Verify all 16 slots remain owned by inst-A
    const slots = await InstanceLeaseSlot.find({}).lean();
    expect(slots).toHaveLength(16);
    for (const slot of slots) {
      expect(slot.instanceId).toBe('inst-A');
    }
  });
});
