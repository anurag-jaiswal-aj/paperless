import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import BackupLease from '../models/backupLease.js';
import Form from '../models/form.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import DeletionCleanupJob from '../models/deletionCleanupJob.js';
import AppWorker from '../models/appWorker.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import { StorageReconciliationService } from '../services/storageReconciliationService.js';
import { ReconciliationScheduler } from '../services/reconciliationScheduler.js';
import * as quiescenceService from '../services/quiescenceService.js';
import * as workerCoord from '../services/workerCoordinationService.js';
import { withRequiredTransaction, getInFlightTransactionCount } from '../utils/dbTransaction.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

describe('Phase 2D.1K.11: F-05 & F-06 Remediation & Closure Verification Suite', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await startReplSet([
      BackupLease,
      Form,
      Response,
      SubmissionReservation,
      DeletionCleanupJob,
      AppWorker,
      StorageJournal
    ]);
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    await Promise.all([
      BackupLease.deleteMany({}),
      Form.deleteMany({}),
      Response.deleteMany({}),
      SubmissionReservation.deleteMany({}),
      DeletionCleanupJob.deleteMany({}),
      AppWorker.deleteMany({}),
      StorageJournal.deleteMany({})
    ]);
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    workerCoord.resetWorkerTasks();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // PART 1: FINDING F-05 REMEDIATION VERIFICATION
  // Worker-context propagation, pre-delete lease checks, and stale-worker deletion protection
  // =========================================================================
  describe('Finding F-05: Worker-Context Propagation & Pre-Delete Fencing', () => {
    it('F05-01: ReconciliationScheduler passes workerContext (this) and isWorkerDriven: true to reconcileBatch', async () => {
      const mockReconciler = {
        reconcileBatch: vi.fn().mockResolvedValue({ processedCount: 1, results: [] })
      };

      const scheduler = new ReconciliationScheduler({
        role: 'reconciliation_worker',
        reconciliationService: mockReconciler,
        intervalMs: 100000,
        heartbeatIntervalMs: 100000
      });

      await scheduler.start();
      expect(mockReconciler.workerId).toBe(scheduler.workerId);

      await scheduler.runReconciliationBatch();

      expect(mockReconciler.reconcileBatch).toHaveBeenCalledTimes(1);
      const callArgs = mockReconciler.reconcileBatch.mock.calls[0][0];

      expect(callArgs.isWorkerDriven).toBe(true);
      expect(callArgs.requireWorkerContext).toBe(true);
      expect(callArgs.workerContext).toBe(scheduler);
      expect(callArgs.workerId).toBe(scheduler.workerId);
      expect(typeof callArgs.workerContext.isLeaseValid).toBe('function');
      expect(callArgs.workerContext.isLeaseValid()).toBe(true);

      await scheduler.stop();
    });

    it('F05-02: reconcileBatch skips batch execution if workerContext.isLeaseValid returns false', async () => {
      const mockAdapter = {
        deleteFile: vi.fn().mockResolvedValue({ success: true }),
        headFile: vi.fn().mockResolvedValue(null)
      };
      const reconciler = new StorageReconciliationService({ storageAdapter: mockAdapter });

      const staleContext = {
        workerId: 'stale_worker_1',
        isLeaseValid: vi.fn().mockReturnValue(false)
      };

      const res = await reconciler.reconcileBatch({
        workerContext: staleContext,
        isWorkerDriven: true
      });

      expect(res.skipped).toBe(true);
      expect(res.reason).toBe('LEASE_EXPIRED_PRE_BATCH');
      expect(res.processedCount).toBe(0);
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();
    });

    it('F05-03: reconcileDelete halts before S3 delete when workerContext lease is expired (returns LEASE_EXPIRED_PRE_DELETE)', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockResolvedValue({
          ContentLength: 1024,
          ETag: '"test-etag"'
        }),
        headFile: vi.fn().mockResolvedValue({
          ContentLength: 1024,
          ETag: '"test-etag"'
        }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const workerId = 'worker_test_f05_03';
      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-delete.pdf',
        type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60000)
      });

      // Context simulates an expired lease
      const workerContext = {
        workerId,
        isLeaseValid: vi.fn().mockReturnValue(false),
        localMonotonicDeadlineMs: performance.now() - 1000
      };

      const result = await reconciler.reconcileRecord(op, {
        workerContext,
        isWorkerDriven: true
      });

      expect(result.action).toBe('LEASE_EXPIRED_PRE_DELETE');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();

      // Ensure DB record was NOT confirmed deleted
      const updatedOp = await StorageJournal.findById(op._id);
      expect(updatedOp.status).toBe(STORAGE_JOURNAL_STATUS.RECONCILING);
    });

    it('F05-04: reconcileUploadOrCopy halts before orphan blob S3 delete when workerContext lease is expired', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockResolvedValue({
          ContentLength: 2048,
          ETag: '"etag-upload"',
          Metadata: { 'original-name': 'upload.pdf' }
        }),
        headFile: vi.fn().mockResolvedValue({
          ContentLength: 2048,
          ETag: '"etag-upload"',
          Metadata: { 'original-name': 'upload.pdf' }
        }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const workerId = 'worker_test_f05_04';
      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId,
        probeDelayMs: 1 // fast probe
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-orphan.pdf',
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60000)
      });

      const workerContext = {
        workerId,
        isLeaseValid: vi.fn().mockReturnValue(false),
        localMonotonicDeadlineMs: performance.now() - 1000
      };

      const result = await reconciler.reconcileRecord(op, {
        workerContext,
        isWorkerDriven: true
      });

      expect(result.action).toBe('LEASE_EXPIRED_PRE_DELETE');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();

      const updatedOp = await StorageJournal.findById(op._id);
      expect(updatedOp.status).toBe(STORAGE_JOURNAL_STATUS.RECONCILING);
    });

    it('F05-05: assertWorkerLeaseBeforeDeletion halts with WORKER_IDENTITY_MISMATCH if workerContext.workerId differs from effectiveWorkerId', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockResolvedValue({ ContentLength: 512, ETag: '"etag-5"' }),
        headFile: vi.fn().mockResolvedValue({ ContentLength: 512, ETag: '"etag-5"' }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId: 'worker_legit'
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-spoof.pdf',
        type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: 'worker_legit',
        lockedUntil: new Date(Date.now() + 60000)
      });

      const workerContext = {
        workerId: 'worker_legit',
        isLeaseValid: vi.fn().mockReturnValue(true),
        localMonotonicDeadlineMs: performance.now() + 10000
      };

      const result = await reconciler.reconcileRecord(op, {
        workerContext,
        isWorkerDriven: true,
        workerId: 'worker_impostor' // Mismatch between context and caller option
      });

      expect(result.action).toBe('WORKER_IDENTITY_MISMATCH');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();
    });

    it('F05-06: requireWorkerContext: true without valid workerContext halts with WORKER_CONTEXT_MISSING before S3 delete', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockResolvedValue({ ContentLength: 512, ETag: '"etag-6"' }),
        headFile: vi.fn().mockResolvedValue({ ContentLength: 512, ETag: '"etag-6"' }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId: 'worker_standalone'
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-missing-ctx.pdf',
        type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: 'worker_standalone',
        lockedUntil: new Date(Date.now() + 60000)
      });

      const result = await reconciler.reconcileRecord(op, {
        requireWorkerContext: true
        // workerContext omitted
      });

      expect(result.action).toBe('WORKER_CONTEXT_MISSING');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();
    });

    it('F05-07: Insufficient lease headroom (< 2000ms monotonic) fails closed with LEASE_EXPIRED_PRE_DELETE', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockResolvedValue({ ContentLength: 512, ETag: '"etag-7"' }),
        headFile: vi.fn().mockResolvedValue({ ContentLength: 512, ETag: '"etag-7"' }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const workerId = 'worker_headroom_test';
      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-headroom.pdf',
        type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60000)
      });

      // Lease is technically valid now, but has only 500ms headroom left (< 2000ms threshold)
      const workerContext = {
        workerId,
        isLeaseValid: vi.fn().mockReturnValue(true),
        localMonotonicDeadlineMs: performance.now() + 500
      };

      const result = await reconciler.reconcileRecord(op, {
        workerContext,
        isWorkerDriven: true
      });

      expect(result.action).toBe('LEASE_EXPIRED_PRE_DELETE');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();
    });

    it('F05-08: StorageJournal markCompensated and confirmOperation reject execution when lockedBy does not match (stale worker CAS prevention)', async () => {
      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-cas.pdf',
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 2,
        lockedBy: 'successor_worker',
        lockedUntil: new Date(Date.now() + 60000)
      });

      // Stale predecessor tries to markCompensated with old epoch
      const staleRes = await StorageJournal.markCompensated(op.operationId, 1, {
        lockedBy: 'stale_worker'
      });
      expect(staleRes).toBeNull();

      // Stale predecessor tries to markCompensated with matching epoch but wrong lockedBy
      const wrongWorkerRes = await StorageJournal.markCompensated(op.operationId, 2, {
        lockedBy: 'stale_worker'
      });
      expect(wrongWorkerRes).toBeNull();

      // Legitimate successor can successfully transition
      const legitRes = await StorageJournal.markCompensated(op.operationId, 2, {
        lockedBy: 'successor_worker'
      });
      expect(legitRes).not.toBeNull();
      expect(legitRes.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
    });

    // =========================================================================
    // PHASE 2D.1K.12: NBO-01 CLOSURE & ADVERSARIAL F-05 DELETION TESTS
    // =========================================================================
    it('NBO01-A: Missing object with valid worker executes pre-delete guard and markCompensated with lockedBy', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockRejectedValue({ name: 'NotFound', statusCode: 404 }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const workerId = 'worker_nbo01_a';
      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId,
        probeDelayMs: 0
      });

      const guardSpy = vi.spyOn(reconciler, 'assertWorkerLeaseBeforeDeletion');

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-404-valid.pdf',
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60000)
      });

      const workerContext = {
        workerId,
        isLeaseValid: vi.fn().mockReturnValue(true),
        localMonotonicDeadlineMs: performance.now() + 10000
      };

      const result = await reconciler.reconcileRecord(op, {
        workerContext,
        isWorkerDriven: true
      });

      expect(result.action).toBe('COMPENSATED_404');
      expect(guardSpy).toHaveBeenCalledWith(
        expect.objectContaining({ isWorkerDriven: true, workerId }),
        op.operationId
      );
      expect(mockAdapter.deleteFile).toHaveBeenCalledWith(
        'uploads/form_1/test-404-valid.pdf',
        expect.objectContaining({ workerId })
      );

      const updated = await StorageJournal.findById(op._id);
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
      expect(updated.lockedBy).toBeNull();
      expect(updated.epoch).toBe(2);
    });

    it('NBO01-B: Missing object with expired worker halts before S3 delete and prevents state transition', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockRejectedValue({ name: 'NotFound', statusCode: 404 }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const workerId = 'worker_nbo01_b';
      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId,
        probeDelayMs: 0
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-404-expired.pdf',
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60000)
      });

      const workerContext = {
        workerId,
        isLeaseValid: vi.fn().mockReturnValue(false),
        localMonotonicDeadlineMs: performance.now() - 500
      };

      const result = await reconciler.reconcileRecord(op, {
        workerContext,
        isWorkerDriven: true
      });

      expect(result.action).toBe('LEASE_EXPIRED_PRE_DELETE');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();

      const updated = await StorageJournal.findById(op._id);
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.RECONCILING);
      expect(updated.epoch).toBe(1);
      expect(updated.lockedBy).toBe(workerId);
    });

    it('NBO01-C: Successor claims record; stale worker attempt to markCompensated on 404 is rejected by atomic CAS', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockRejectedValue({ name: 'NotFound', statusCode: 404 }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const staleWorkerId = 'worker_stale_c';
      const successorWorkerId = 'worker_successor_c';

      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId: staleWorkerId,
        probeDelayMs: 0
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-404-race.pdf',
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: staleWorkerId,
        lockedUntil: new Date(Date.now() + 60000)
      });

      const workerContext = {
        workerId: staleWorkerId,
        isLeaseValid: vi.fn().mockReturnValue(true),
        localMonotonicDeadlineMs: performance.now() + 10000
      };

      // Simulate: while stale worker is probing, successor worker claims the record in MongoDB
      await StorageJournal.updateOne(
        { operationId: op.operationId },
        { $set: { lockedBy: successorWorkerId, epoch: 2 } }
      );

      const result = await reconciler.reconcileUploadOrCopy(op, {
        workerContext,
        isWorkerDriven: true,
        workerId: staleWorkerId
      });

      expect(result.action).toBe('STALE_EPOCH_CONFLICT');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();

      // Verify successor state remains completely intact in MongoDB
      const currentInDb = await StorageJournal.findById(op._id);
      expect(currentInDb.lockedBy).toBe(successorWorkerId);
      expect(currentInDb.epoch).toBe(2);
      expect(currentInDb.status).toBe(STORAGE_JOURNAL_STATUS.RECONCILING);
    });

    it('NBO01-D: Missing object when requireWorkerContext: true without valid context fails closed with WORKER_CONTEXT_MISSING', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockRejectedValue({ name: 'NotFound', statusCode: 404 }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const workerId = 'worker_nbo01_d';
      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId,
        probeDelayMs: 0
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-404-missing-ctx.pdf',
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60000)
      });

      const result = await reconciler.reconcileRecord(op, {
        requireWorkerContext: true
        // workerContext intentionally omitted
      });

      expect(result.action).toBe('WORKER_CONTEXT_MISSING');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();

      const updated = await StorageJournal.findById(op._id);
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.RECONCILING);
      expect(updated.epoch).toBe(1);
    });

    it('NBO01-E: Non-worker manual path compatibility: proceeds safely without isWorkerDriven requirement', async () => {
      const mockAdapter = {
        headObject: vi.fn().mockRejectedValue({ name: 'NotFound', statusCode: 404 }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId: 'manual_reconciler',
        probeDelayMs: 0
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-404-manual.pdf',
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: 'manual_reconciler',
        lockedUntil: new Date(Date.now() + 60000)
      });

      // No workerContext or isWorkerDriven passed (manual CLI / admin sweep)
      const result = await reconciler.reconcileRecord(op, {});

      expect(result.action).toBe('COMPENSATED_404');
      expect(mockAdapter.deleteFile).toHaveBeenCalled();

      const updated = await StorageJournal.findById(op._id);
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
      expect(updated.epoch).toBe(2);
    });

    it('NBO01-F: Lease expires between separate checks: immediate pre-delete guard halts dispatch before S3 delete', async () => {
      // NOTE: This test asserts pre-dispatch halting; it does not claim to terminate an already-dispatched remote request on the wire.
      const mockAdapter = {
        headObject: vi.fn().mockRejectedValue({ name: 'NotFound', statusCode: 404 }),
        deleteFile: vi.fn().mockResolvedValue({ success: true })
      };

      const workerId = 'worker_nbo01_f';
      const reconciler = new StorageReconciliationService({
        storageAdapter: mockAdapter,
        workerId,
        probeDelayMs: 0
      });

      const op = await StorageJournal.create({
        operationId: `op_${crypto.randomUUID()}`,
        destinationKey: 'uploads/form_1/test-404-mid-expiry.pdf',
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 1,
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60000)
      });

      // Worker lease is initially valid for batch check, but local monotonic deadline has insufficient headroom (< 2000ms) by the time delete is reached
      let checkCount = 0;
      const workerContext = {
        workerId,
        isLeaseValid: vi.fn().mockImplementation(() => {
          checkCount++;
          // First check (pre-batch) returns true, subsequent check (pre-delete) returns false
          return checkCount === 1;
        }),
        localMonotonicDeadlineMs: performance.now() + 500 // insufficient headroom (< 2000ms)
      };

      const result = await reconciler.reconcileRecord(op, {
        workerContext,
        isWorkerDriven: true
      });

      expect(result.action).toBe('LEASE_EXPIRED_PRE_DELETE');
      expect(mockAdapter.deleteFile).not.toHaveBeenCalled();

      const updated = await StorageJournal.findById(op._id);
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.RECONCILING);
      expect(updated.epoch).toBe(1);
    });
  });

  // =========================================================================
  // PART 2: FINDING F-06 REMEDIATION VERIFICATION
  // Fail-closed MongoDB currentOp handling in Domain 9 quiescence verification
  // =========================================================================
  describe('Finding F-06: Domain 9 CurrentOp Fail-Closed Handling', () => {
    it('F06-01: checkDurableDatastoreDrain returns isDrained: true and transactionDrainVerified: true when currentOp returns zero user transactions', async () => {
      const mockAdmin = {
        command: vi.fn().mockResolvedValue({
          inprog: [
            { ns: 'local.oplog.rs', active: true },
            { ns: 'config.settings', active: true },
            { ns: 'admin.system.users', active: true }
          ]
        })
      };
      vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue(mockAdmin);

      const res = await quiescenceService.checkDurableDatastoreDrain({ strict: true });

      expect(mockAdmin.command).toHaveBeenCalled();
      expect(res.isDrained).toBe(true);
      expect(res.diagnostics.activeTransactions).toBe(0);
      expect(res.diagnostics.transactionCheckStatus).toBe('VERIFIED');
      expect(res.diagnostics.transactionDrainVerified).toBe(true);
      expect(res.diagnostics.physicalBackupAuthorized).toBe(true);
      expect(res.diagnostics.transactionCheckError).toBeNull();
    });

    it('F06-02: checkDurableDatastoreDrain returns isDrained: false, reason: DRAIN_PENDING when currentOp reports active user transactions', async () => {
      const mockAdmin = {
        command: vi.fn().mockResolvedValue({
          inprog: [
            { ns: 'paperless.responses', active: true, desc: 'WiredTiger multi-doc transaction' }
          ]
        })
      };
      vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue(mockAdmin);

      const res = await quiescenceService.checkDurableDatastoreDrain({ strict: true });

      expect(mockAdmin.command).toHaveBeenCalled();
      expect(res.isDrained).toBe(false);
      expect(res.reason).toBe('DRAIN_PENDING');
      expect(res.diagnostics.activeTransactions).toBe(1);
      expect(res.diagnostics.transactionCheckStatus).toBe('VERIFIED');
      expect(res.diagnostics.transactionDrainVerified).toBe(false);
      expect(res.diagnostics.physicalBackupAuthorized).toBe(false);
    });

    it('F06-03: checkDurableDatastoreDrain in strict mode returns isDrained: false, reason: TRANSACTION_DRAIN_UNVERIFIED when currentOp throws Code 13 (Unauthorized)', async () => {
      const authError = new Error('not authorized on admin to execute command { currentOp: 1 }');
      authError.code = 13;
      authError.codeName = 'Unauthorized';

      const mockAdmin = {
        command: vi.fn().mockRejectedValue(authError)
      };
      vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue(mockAdmin);

      const res = await quiescenceService.checkDurableDatastoreDrain({ strict: true });

      expect(mockAdmin.command).toHaveBeenCalled();
      expect(res.isDrained).toBe(false);
      expect(res.reason).toBe('TRANSACTION_DRAIN_UNVERIFIED');
      expect(res.diagnostics.transactionCheckStatus).toBe('UNAUTHORIZED');
      expect(res.diagnostics.transactionDrainVerified).toBe(false);
      expect(res.diagnostics.physicalBackupAuthorized).toBe(false);
      expect(res.diagnostics.transactionCheckError).toEqual(
        expect.objectContaining({
          code: 13,
          codeName: 'Unauthorized',
          type: 'UNAUTHORIZED'
        })
      );
    });

    it('F06-04: checkDurableDatastoreDrain in non-strict mode records transactionDrainVerified: false and physicalBackupAuthorized: false on Code 13 without throwing unhandled rejection', async () => {
      const authError = new Error('not authorized on admin to execute command { currentOp: 1 }');
      authError.code = 13;
      authError.codeName = 'Unauthorized';

      const mockAdmin = {
        command: vi.fn().mockRejectedValue(authError)
      };
      vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue(mockAdmin);

      const res = await quiescenceService.checkDurableDatastoreDrain({ strict: false });

      expect(mockAdmin.command).toHaveBeenCalled();
      // In non-strict mode (unit test mock), datastore drain returns true if business domains are clear,
      // but explicitly marks physicalBackupAuthorized as FALSE and transactionDrainVerified as FALSE!
      expect(res.isDrained).toBe(true);
      expect(res.diagnostics.transactionCheckStatus).toBe('UNAUTHORIZED');
      expect(res.diagnostics.transactionDrainVerified).toBe(false);
      expect(res.diagnostics.physicalBackupAuthorized).toBe(false);
    });

    it('F06-05: checkDurableDatastoreDrain fails closed with DATASTORE_QUERY_FAILED on Code 50 (timeout) or MongoNetworkError across all modes', async () => {
      const timeoutErr = new Error('operation exceeded time limit');
      timeoutErr.code = 50;
      timeoutErr.codeName = 'MaxTimeMSExpired';

      const mockAdmin = {
        command: vi.fn().mockRejectedValue(timeoutErr)
      };
      vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue(mockAdmin);

      // Even in non-strict mode, timeout must fail closed!
      const resNonStrict = await quiescenceService.checkDurableDatastoreDrain({ strict: false });
      expect(resNonStrict.isDrained).toBe(false);
      expect(resNonStrict.reason).toBe('DATASTORE_QUERY_FAILED');
      expect(resNonStrict.diagnostics.transactionCheckStatus).toBe('TIMEOUT');

      // In strict mode, timeout also fails closed!
      const resStrict = await quiescenceService.checkDurableDatastoreDrain({ strict: true });
      expect(resStrict.isDrained).toBe(false);
      expect(resStrict.reason).toBe('DATASTORE_QUERY_FAILED');
      expect(resStrict.diagnostics.transactionCheckStatus).toBe('TIMEOUT');
    });

    it('F06-06: markQuiesced with strict: true rejects transition to QUIESCED with TRANSACTION_DRAIN_UNVERIFIED when currentOp is unauthorized', async () => {
      const authError = new Error('requires clusterAdmin privilege');
      authError.code = 13;
      authError.codeName = 'Unauthorized';

      const mockAdmin = {
        command: vi.fn().mockRejectedValue(authError)
      };
      vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue(mockAdmin);

      const acquireRes = await quiescenceService.acquire({
        reason: 'test_backup_lease',
        durationMs: 30000
      });
      expect(acquireRes.success).toBe(true);
      const leaseId = acquireRes.leaseId;

      const quiesceRes = await quiescenceService.markQuiesced({
        leaseId,
        strict: true
      });

      expect(quiesceRes.success).toBe(false);
      expect(quiesceRes.reason).toBe('TRANSACTION_DRAIN_UNVERIFIED');
      expect(quiesceRes.diagnostics.transactionCheckStatus).toBe('UNAUTHORIZED');
      expect(quiesceRes.diagnostics.transactionDrainVerified).toBe(false);
    });

    it('F06-07: In-process active multi-document transaction tracking (getInFlightTransactionCount) halts drain verification even if currentOp shows 0', async () => {
      const mockAdmin = {
        command: vi.fn().mockResolvedValue({
          inprog: []
        })
      };
      vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue(mockAdmin);

      // Simulate an active in-flight transaction using withRequiredTransaction
      let drainResultDuringTx;
      await withRequiredTransaction(async () => {
        expect(getInFlightTransactionCount()).toBeGreaterThanOrEqual(1);

        // Check drain while transaction is actively executing
        drainResultDuringTx = await quiescenceService.checkDurableDatastoreDrain({ strict: true });
      });

      expect(drainResultDuringTx.isDrained).toBe(false);
      expect(drainResultDuringTx.reason).toBe('DRAIN_PENDING');
      expect(drainResultDuringTx.diagnostics.inProcessActiveTransactions).toBeGreaterThanOrEqual(1);
      expect(drainResultDuringTx.diagnostics.transactionDrainVerified).toBe(false);

      // Once transaction finishes, in-process count drops to 0 and drain passes
      expect(getInFlightTransactionCount()).toBe(0);
      const postTxDrain = await quiescenceService.checkDurableDatastoreDrain({ strict: true });
      expect(postTxDrain.isDrained).toBe(true);
      expect(postTxDrain.diagnostics.transactionDrainVerified).toBe(true);
    });
  });
});
