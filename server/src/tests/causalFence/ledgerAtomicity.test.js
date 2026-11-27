/**
 * Suite 6: Ledger Atomicity & 6-Way Session Rollback
 * File: server/src/tests/causalFence/ledgerAtomicity.test.js
 *
 * Verifies:
 * - 6-way session atomicity: aborting publication transaction rolls back all mutations
 * - StorageJournal.commitInTransaction arms 7-day vacuumAt and increments epoch
 * - performStagingCleanup arms 7-day vacuumAt on original PUT_OBJECT staging journal records
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startReplSet, stopReplSet } from '../../testUtils/replSetHelper.js';
import Form from '../../models/form.js';
import Question from '../../models/question.js';
import Response from '../../models/response.js';
import User from '../../models/user.js';
import SubmissionReservation from '../../models/submissionReservation.js';
import StorageJournal, {
  STORAGE_OPERATION_TYPE,
  STORAGE_JOURNAL_STATUS
} from '../../models/storageJournal.js';
import InstanceLease, { InstanceLeaseSlot } from '../../models/instanceLease.js';
import { withRequiredTransaction, computeDesignatedSlotId } from '../../utils/dbTransaction.js';
import { SubmissionReservationManager } from '../../utils/submissionReservationManager.js';
import storageService from '../../services/StorageService.js';
import * as instanceLeaseService from '../../services/instanceLeaseService.js';

describe('Suite 6: Ledger Atomicity (ledgerAtomicity)', () => {
  let replSet;
  let testUser;

  beforeAll(async () => {
    replSet = await startReplSet([
      Form,
      Question,
      Response,
      User,
      SubmissionReservation,
      StorageJournal,
      InstanceLease,
      InstanceLeaseSlot
    ]);
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await StorageJournal.deleteMany({});

    testUser = await User.create({
      name: 'Ledger User',
      email: `ledger-${Date.now()}@test.com`,
      password: 'password123'
    });

    await instanceLeaseService.ensureInstanceSingletonExists();
    await instanceLeaseService.acquireInstanceLease({ instanceId: 'inst-suite-6', skipHeartbeat: true });
  });

  it('6.1: 6-way session atomicity rolls back all mutations on aborted publication transaction', async () => {
    const form = await Form.create({
      title: 'Atomicity Form',
      ownerId: testUser._id,
      status: 'published',
      published: true,
      activeSubmissions: 1,
      maxSubmissions: 100,
      lifecycleVersion: 1
    });

    const leaseId = 'lease-atomicity-1';
    const fenceToken = 'fence-token-1';
    const reservation = await SubmissionReservation.create({
      formId: form._id,
      leaseId,
      fenceToken,
      status: 'active',
      expiresAt: new Date(Date.now() + 60000),
      barrierGeneration: 0
    });

    const destinationKey = `forms/${form._id}/responses/file-1.pdf`;
    const journalEntry = await StorageJournal.create({
      operationId: 'op-copy-1',
      type: STORAGE_OPERATION_TYPE.COPY_OBJECT,
      status: STORAGE_JOURNAL_STATUS.CONFIRMED,
      destinationKey,
      sourceKey: `staging/forms/${form._id}/${leaseId}/file-1.pdf`,
      formId: form._id,
      epoch: 1,
      vacuumAt: null
    });

    // Determine fence slot for this form
    const slotId = computeDesignatedSlotId(String(form._id));
    const slotBefore = await InstanceLeaseSlot.findById(slotId).lean();
    const initialFenceEpoch = slotBefore.fenceEpoch;

    const responseId = new mongoose.Types.ObjectId();

    let transactionAborted = false;
    try {
      await withRequiredTransaction(async (session) => {
        // 1. Form OCC update
        await Form.updateOne(
          { _id: form._id },
          { $inc: { lifecycleVersion: 1 } },
          { session }
        );

        // 2. Reservation pre-commit
        await SubmissionReservationManager.markCommitting(leaseId, fenceToken, session);

        // 3. Response insert
        await Response.create([
          {
            _id: responseId,
            formId: form._id,
            answers: [],
            payloadHash: 'hash-atomicity',
            reservationLeaseId: leaseId,
            commitStatus: 'committed'
          }
        ], { session });

        // 4. Reservation finalize
        await SubmissionReservationManager.finalize(leaseId, fenceToken, session, form._id);

        // 5. StorageJournal transition to COMMITTED
        await StorageJournal.commitInTransaction([destinationKey], {
          responseId,
          formId: form._id,
          session
        });

        // 6. Slot fence mutation
        await InstanceLeaseSlot.updateOne(
          { _id: slotId },
          { $inc: { fenceEpoch: 1 } },
          { session }
        );

        // Simulate catastrophic abort right before commit
        throw new Error('SIMULATED_ABORT_AFTER_6_WRITES');
      }, { partitionKey: String(form._id) });
    } catch (err) {
      if (err.message === 'SIMULATED_ABORT_AFTER_6_WRITES') {
        transactionAborted = true;
      } else {
        throw err;
      }
    }

    expect(transactionAborted).toBe(true);

    // Verify 6-way rollback in MongoDB
    const formAfter = await Form.findById(form._id).lean();
    expect(formAfter.lifecycleVersion).toBe(1); // Not incremented

    const resvAfter = await SubmissionReservation.findById(reservation._id).lean();
    expect(resvAfter.status).toBe('active'); // Not committing or finalized

    const responseCount = await Response.countDocuments({ _id: responseId });
    expect(responseCount).toBe(0); // Response rolled back

    const journalAfter = await StorageJournal.findById(journalEntry._id).lean();
    expect(journalAfter.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED); // Not COMMITTED
    expect(journalAfter.vacuumAt).toBeNull(); // vacuumAt rolled back

    const slotAfter = await InstanceLeaseSlot.findById(slotId).lean();
    expect(slotAfter.fenceEpoch).toBe(initialFenceEpoch); // Fence epoch rolled back
  });

  it('6.2: StorageJournal.commitInTransaction retains permanent TTL-immune record (vacuumAt: null) and increments epoch', async () => {
    const formId = new mongoose.Types.ObjectId();
    const responseId = new mongoose.Types.ObjectId();
    const destinationKey = `forms/${formId}/responses/verified-file.png`;

    const journal = await StorageJournal.create({
      operationId: 'op-commit-in-tx-1',
      type: STORAGE_OPERATION_TYPE.COPY_OBJECT,
      status: STORAGE_JOURNAL_STATUS.CONFIRMED,
      destinationKey,
      formId,
      epoch: 1,
      vacuumAt: null
    });

    await withRequiredTransaction(async (session) => {
      await StorageJournal.commitInTransaction([destinationKey], {
        responseId,
        formId,
        session
      });
    }, { partitionKey: String(formId) });

    const updated = await StorageJournal.findById(journal._id).lean();
    expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.COMMITTED);
    expect(updated.responseId.toString()).toBe(responseId.toString());
    expect(updated.epoch).toBe(2); // Incremented
    expect(updated.vacuumAt).toBeNull(); // TTL-immune for live committed response
  });

  it('6.3: performStagingCleanup arms 7-day TTL on original PUT_OBJECT staging journal records', async () => {
    const formId = new mongoose.Types.ObjectId();
    const leaseId = 'lease-cleanup-1';
    const stagingKey = `staging/forms/${formId}/${leaseId}/doc-1.pdf`;

    // Original PutObject journal record created during upload
    const stagingJournal = await StorageJournal.create({
      operationId: 'op-put-staging-1',
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      status: STORAGE_JOURNAL_STATUS.CONFIRMED,
      destinationKey: stagingKey,
      formId,
      epoch: 1,
      vacuumAt: null
    });

    // Reservation finalized with staging keys to purge
    await SubmissionReservation.create({
      formId,
      leaseId,
      fenceToken: 'fence-1',
      status: 'finalized',
      stagingCleanupStatus: 'pending',
      stagedKeys: [stagingKey],
      stagingKeysToPurge: [stagingKey],
      expiresAt: new Date(Date.now() + 60000)
    });

    const deleteSpy = vi.spyOn(storageService, 'deleteFile').mockResolvedValue(true);

    const nowBefore = Date.now();
    const result = await SubmissionReservationManager.performStagingCleanup(leaseId, formId);
    const nowAfter = Date.now();

    expect(result.success).toBe(true);
    expect(result.completed).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(stagingKey);

    // Verify original PutObject journal entry was updated with 7-day vacuumAt
    const updatedJournal = await StorageJournal.findById(stagingJournal._id).lean();
    expect(updatedJournal.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
    expect(updatedJournal.epoch).toBe(2); // Incremented
    expect(updatedJournal.vacuumAt).toBeTruthy();

    const expectedMinVacuum = nowBefore + 7 * 24 * 3600 * 1000 - 5000;
    const expectedMaxVacuum = nowAfter + 7 * 24 * 3600 * 1000 + 5000;
    const actualVacuumMs = new Date(updatedJournal.vacuumAt).getTime();
    expect(actualVacuumMs).toBeGreaterThanOrEqual(expectedMinVacuum);
    expect(actualVacuumMs).toBeLessThanOrEqual(expectedMaxVacuum);
  });
});
