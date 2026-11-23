import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import AppWorker, { APP_WORKER_STATUS, APP_WORKER_ROLE } from './appWorker.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

describe('Phase 2D.1K.7: Durable AppWorker Model & Lease Protocol Test Suite', () => {
  let replSet;
  const TEST_ROLE = APP_WORKER_ROLE.STORAGE_RECONCILIATION;

  beforeAll(async () => {
    replSet = await startReplSet([AppWorker]);
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    await AppWorker.deleteMany({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TS-WORKER-01: First clean acquisition initializes role with epoch 1 and STARTING status', async () => {
    const worker = await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      leaseTtlMs: 30000
    });

    expect(worker).toBeDefined();
    expect(worker._id).toBe(TEST_ROLE);
    expect(worker.role).toBe(TEST_ROLE);
    expect(worker.workerId).toBe('worker_A');
    expect(worker.incarnationId).toBe('inc_A_001');
    expect(worker.status).toBe(APP_WORKER_STATUS.STARTING);
    expect(worker.epoch).toBe(1);
    expect(worker.activeClaimCount).toBe(0);
    expect(worker.heartbeatExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('TS-WORKER-02: Duplicate acquisition fails closed while active lease is held', async () => {
    // Worker A acquires role
    const workerA = await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });
    expect(workerA).not.toBeNull();

    // Worker B attempts concurrent acquisition
    const workerB = await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_B',
      incarnationId: 'inc_B_001'
    });

    expect(workerB).toBeNull();

    const current = await AppWorker.findById(TEST_ROLE).lean();
    expect(current.workerId).toBe('worker_A');
    expect(current.epoch).toBe(1);
  });

  it('TS-WORKER-03: Graceful heartbeat extends expiration and promotes STARTING to ACTIVE', async () => {
    const workerA = await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      leaseTtlMs: 30000
    });

    const initialExpiresAt = workerA.heartbeatExpiresAt;

    // Small delay
    await new Promise((resolve) => setTimeout(resolve, 50));

    const renewed = await AppWorker.heartbeat(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1,
      leaseTtlMs: 45000
    });

    expect(renewed).not.toBeNull();
    expect(renewed.status).toBe(APP_WORKER_STATUS.ACTIVE);
    expect(renewed.epoch).toBe(1);
    expect(renewed.heartbeatExpiresAt.getTime()).toBeGreaterThan(initialExpiresAt.getTime());
  });

  it('TS-WORKER-04: Heartbeat on expired lease fails closed without resurrecting zombie', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });

    // Simulate expired lease
    const past = new Date(Date.now() - 5000);
    await AppWorker.updateOne(
      { _id: TEST_ROLE },
      { $set: { heartbeatExpiresAt: past, status: APP_WORKER_STATUS.ACTIVE } }
    );

    // Heartbeat attempt after expiration
    const renewed = await AppWorker.heartbeat(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1
    });

    expect(renewed).toBeNull();
  });

  it('TS-WORKER-05: Takeover of expired lease increments epoch and reassigns ownership', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });

    // Manually expire Worker A's lease
    await AppWorker.updateOne(
      { _id: TEST_ROLE },
      { $set: { heartbeatExpiresAt: new Date(Date.now() - 1000) } }
    );

    // Worker B takes over
    const workerB = await AppWorker.takeOverRole(TEST_ROLE, {
      workerId: 'worker_B',
      incarnationId: 'inc_B_001',
      leaseTtlMs: 30000
    });

    expect(workerB).not.toBeNull();
    expect(workerB.workerId).toBe('worker_B');
    expect(workerB.incarnationId).toBe('inc_B_001');
    expect(workerB.epoch).toBe(2); // Incremented from 1 to 2
    expect(workerB.status).toBe(APP_WORKER_STATUS.ACTIVE);
  });

  it('TS-WORKER-06: Stale worker heartbeat is rejected post-takeover', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });

    // Worker B takes over
    await AppWorker.updateOne(
      { _id: TEST_ROLE },
      { $set: { heartbeatExpiresAt: new Date(Date.now() - 1000) } }
    );
    await AppWorker.takeOverRole(TEST_ROLE, {
      workerId: 'worker_B',
      incarnationId: 'inc_B_001'
    });

    // Stale Worker A wakes up and attempts heartbeat with old epoch
    const staleHeartbeat = await AppWorker.heartbeat(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1
    });

    expect(staleHeartbeat).toBeNull();

    // Verify Worker B remains undisturbed
    const current = await AppWorker.findById(TEST_ROLE).lean();
    expect(current.workerId).toBe('worker_B');
    expect(current.epoch).toBe(2);
  });

  it('TS-WORKER-07: Stale worker release is rejected post-takeover', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });

    // Worker B takes over
    await AppWorker.updateOne(
      { _id: TEST_ROLE },
      { $set: { heartbeatExpiresAt: new Date(Date.now() - 1000) } }
    );
    await AppWorker.takeOverRole(TEST_ROLE, {
      workerId: 'worker_B',
      incarnationId: 'inc_B_001'
    });

    // Stale Worker A attempts releaseRole
    const staleRelease = await AppWorker.releaseRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1
    });

    expect(staleRelease).toBeNull();

    // Verify Worker B's active lease is not clobbered
    const current = await AppWorker.findById(TEST_ROLE).lean();
    expect(current.workerId).toBe('worker_B');
    expect(current.status).toBe(APP_WORKER_STATUS.ACTIVE);
  });

  it('TS-WORKER-08: Complete graceful drain and release transitions to STOPPED with epoch bump', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });

    // 1. Mark DRAINING
    const drainingDoc = await AppWorker.markDraining(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1
    });
    expect(drainingDoc.status).toBe(APP_WORKER_STATUS.DRAINING);

    // 2. Release role cleanly
    const releasedDoc = await AppWorker.releaseRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1
    });

    expect(releasedDoc.status).toBe(APP_WORKER_STATUS.STOPPED);
    expect(releasedDoc.workerId).toBeNull();
    expect(releasedDoc.incarnationId).toBeNull();
    expect(releasedDoc.epoch).toBe(2); // Incremented on release

    // 3. New worker can acquire immediately without waiting for TTL
    const newWorker = await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_C',
      incarnationId: 'inc_C_001'
    });
    expect(newWorker).not.toBeNull();
    expect(newWorker.workerId).toBe('worker_C');
    expect(newWorker.epoch).toBe(3);
  });

  it('TS-WORKER-09: Heartbeat in DRAINING status preserves DRAINING and does not revert to ACTIVE', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });
    await AppWorker.markDraining(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1
    });

    const renewed = await AppWorker.heartbeat(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1,
      status: APP_WORKER_STATUS.DRAINING
    });

    expect(renewed).not.toBeNull();
    expect(renewed.status).toBe(APP_WORKER_STATUS.DRAINING);
  });

  it('TS-WORKER-10: recoverExpiredRoles marks EXPIRED when activeClaimCount is 0', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });

    // Expire with activeClaimCount: 0
    await AppWorker.updateOne(
      { _id: TEST_ROLE },
      { $set: { heartbeatExpiresAt: new Date(Date.now() - 5000), activeClaimCount: 0 } }
    );

    const report = await AppWorker.recoverExpiredRoles();
    expect(report.recoveredCount).toBe(1);
    expect(report.expiredCount).toBe(1);
    expect(report.recoveryRequiredCount).toBe(0);

    const doc = await AppWorker.findById(TEST_ROLE).lean();
    expect(doc.status).toBe(APP_WORKER_STATUS.EXPIRED);
  });

  it('TS-WORKER-11: recoverExpiredRoles marks RECOVERY_REQUIRED when activeClaimCount > 0', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });

    // Expire with active claims trapped in flight
    await AppWorker.updateOne(
      { _id: TEST_ROLE },
      { $set: { heartbeatExpiresAt: new Date(Date.now() - 5000), activeClaimCount: 3 } }
    );

    const report = await AppWorker.recoverExpiredRoles();
    expect(report.recoveredCount).toBe(1);
    expect(report.recoveryRequiredCount).toBe(1);
    expect(report.expiredCount).toBe(0);

    const doc = await AppWorker.findById(TEST_ROLE).lean();
    expect(doc.status).toBe(APP_WORKER_STATUS.RECOVERY_REQUIRED);
  });

  it('TS-WORKER-12: Incarnation ID mismatch fences out rebooted worker with stale packets', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_BOOT_1'
    });

    // Stale packet from previous incarnation attempts heartbeat
    const result = await AppWorker.heartbeat(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_BOOT_OLD',
      expectedEpoch: 1
    });

    expect(result).toBeNull();
  });

  it('TS-WORKER-13: Active claim tracking accurately adjusts claims and fences on epoch change', async () => {
    await AppWorker.acquireRole(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001'
    });

    // Increment claims
    const claim1 = await AppWorker.adjustActiveClaims(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 1,
      delta: 1
    });
    expect(claim1.activeClaimCount).toBe(1);

    // Stale attempt with wrong epoch fails
    const claimFail = await AppWorker.adjustActiveClaims(TEST_ROLE, {
      workerId: 'worker_A',
      incarnationId: 'inc_A_001',
      expectedEpoch: 99,
      delta: 1
    });
    expect(claimFail).toBeNull();
  });
});
