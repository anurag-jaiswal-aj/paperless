import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { v4 as uuidv4 } from 'uuid';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import Form from '../models/form.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import DeletionCleanupJob from '../models/deletionCleanupJob.js';
import AppWorker, { APP_WORKER_ROLE, APP_WORKER_STATUS } from '../models/appWorker.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import { StorageReconciliationService } from '../services/storageReconciliationService.js';
import { PrefixSweepService } from '../services/prefixSweepService.js';
import * as quiescenceService from '../services/quiescenceService.js';
import * as workerCoordinationService from '../services/workerCoordinationService.js';

describe('Phase 4.4 Workstream 2D.1K.8: Phase K-E Cold-Storage Barrier, Staging Quarantine & Late-Object Recovery Verification Suite', () => {
  let mongod;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await BackupLease.init();
    await BackupLease.createIndexes();
    await Form.init();
    await Form.createIndexes();
    await Response.init();
    await Response.createIndexes();
    await SubmissionReservation.init();
    await SubmissionReservation.createIndexes();
    await DeletionCleanupJob.init();
    await DeletionCleanupJob.createIndexes();
    await AppWorker.init();
    await AppWorker.createIndexes();
    await StorageJournal.init();
    await StorageJournal.createIndexes();
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    delete process.env.STRICT_TTL_SUPPRESSION_REQUIRED;
    workerCoordinationService.resetWorkerTasks();
    await mongoose.disconnect();
    await mongod.stop();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SECTION 1: Cold-Storage Barrier & Datastore Drain Fail-Closed Invariants
  // =========================================================================

  it('KE-BARRIER-01: Active worker in app_workers blocks cold-storage barrier drain', async () => {
    const now = new Date();
    await AppWorker.create({
      _id: APP_WORKER_ROLE.STORAGE_RECONCILIATION,
      role: APP_WORKER_ROLE.STORAGE_RECONCILIATION,
      workerId: 'worker-reconciler-1',
      incarnationId: uuidv4(),
      status: APP_WORKER_STATUS.ACTIVE,
      epoch: 1,
      heartbeatExpiresAt: new Date(now.getTime() + 25000),
      activeClaimCount: 0
    });

    const drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.reason).toBe('DRAIN_PENDING');
    expect(drainRes.diagnostics.activeWorkers).toBeGreaterThan(0);
  });

  it('KE-BARRIER-02: Expired quarantine on AMBIGUOUS StorageJournal record strictly blocks drain', async () => {
    // Record was quarantined in the past (quarantinedUntil <= now)
    // Core Invariant: Expired quarantine interval does NOT prove remote operation termination!
    const past = new Date(Date.now() - 60000);
    await StorageJournal.create({
      operationId: uuidv4(),
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      bucket: 'paperless',
      destinationKey: 'forms/form-1/responses/file-1.pdf',
      status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
      quarantinedUntil: past,
      epoch: 1
    });

    const drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.reason).toBe('DRAIN_PENDING');
    expect(drainRes.diagnostics.activeStorageOperations).toBe(1);
    expect(drainRes.diagnostics.unresolvedStorageOperations).toBe(1);
  });

  it('KE-BARRIER-03: Uncleaned staging keys on expired reservation block drain (R-KE-05)', async () => {
    const past = new Date(Date.now() - 60000);
    await SubmissionReservation.create({
      formId: new mongoose.Types.ObjectId(),
      leaseId: 'lease-uncleaned-staging',
      fenceToken: 'fence-1',
      status: 'abandoned',
      expiresAt: past,
      quarantinedUntil: past,
      stagedKeys: ['staging/forms/form-1/lease-1/photo.jpg'],
      stagingCleanupStatus: 'pending'
    });

    const drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.reason).toBe('DRAIN_PENDING');
    expect(drainRes.diagnostics.pendingCleanupReservations).toBeGreaterThan(0);
  });

  it('KE-BARRIER-04: Database query errors strictly fail closed without false positives', async () => {
    const spy = vi.spyOn(mongoose.connection.db, 'collection').mockImplementation(() => {
      throw new Error('Simulated MongoDB connection drop');
    });

    const drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.reason).toBe('DATASTORE_QUERY_FAILED');
    expect(drainRes.error).toContain('Simulated MongoDB connection drop');
    spy.mockRestore();
  });

  it('KE-BARRIER-05: markQuiesced rejects transition if durable datastore drain is pending', async () => {
    // Acquire lease to DRAINING
    const acquireRes = await quiescenceService.acquireLease('backup-session-ke-1', {
      initialLeaseDurationMs: 60000,
      maxAllowedWatchdogDurationMs: 300000
    });
    expect(acquireRes.success).toBe(true);

    // Seed unresolved storage record
    await StorageJournal.create({
      operationId: uuidv4(),
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      bucket: 'paperless',
      destinationKey: 'forms/form-ke/responses/blob-1.pdf',
      status: STORAGE_JOURNAL_STATUS.DISPATCHED,
      epoch: 1
    });

    const quiescedRes = await quiescenceService.markQuiesced(acquireRes.leaseId);
    expect(quiescedRes.success).toBe(false);
    expect(quiescedRes.reason).toBe('DRAIN_PENDING');

    const leaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(leaseDoc.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
  });

  it('KE-BARRIER-06: Restart during active drain re-queries persistent datastore directly', async () => {
    await StorageJournal.create({
      operationId: uuidv4(),
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      bucket: 'paperless',
      destinationKey: 'forms/form-ke-restart/responses/blob-2.pdf',
      status: STORAGE_JOURNAL_STATUS.RECONCILING,
      lockedUntil: new Date(Date.now() + 15000),
      epoch: 1
    });

    // Simulate process memory reset (in-process caches empty)
    workerCoordinationService.resetWorkerTasks();

    const drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.diagnostics.activeStorageOperations).toBe(1);
  });

  // =========================================================================
  // SECTION 2: Late PUT Discovery & Prefix Sweep Candidate Classification
  // =========================================================================

  it('KE-SWEEP-01: Candidate classification protects committed Response attachments', async () => {
    const key = 'forms/f1/responses/photo.jpg';
    await Response.create({
      formId: new mongoose.Types.ObjectId(),
      questionId: new mongoose.Types.ObjectId(),
      answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key } }],
      commitStatus: 'committed'
    });

    const sweeper = new PrefixSweepService({ minOrphanAgeMs: 0 });
    const classification = await sweeper.classifyCandidate(key, { lastModified: new Date(Date.now() - 100000) });
    expect(classification.isOrphan).toBe(false);
    expect(classification.reason).toBe('COMMITTED_RESPONSE_REFERENCE');
  });

  it('KE-SWEEP-02: Candidate classification protects active SubmissionReservation keys', async () => {
    const stagedKey = 'staging/forms/f1/lease-100/doc.pdf';
    await SubmissionReservation.create({
      formId: new mongoose.Types.ObjectId(),
      leaseId: 'lease-100',
      fenceToken: 'fence-100',
      status: 'active',
      expiresAt: new Date(Date.now() + 60000),
      stagedKeys: [stagedKey]
    });

    const sweeper = new PrefixSweepService({ minOrphanAgeMs: 0 });
    const classification = await sweeper.classifyCandidate(stagedKey, { lastModified: new Date(Date.now() - 100000) });
    expect(classification.isOrphan).toBe(false);
    expect(classification.reason).toBe('ACTIVE_SUBMISSION_RESERVATION');
  });

  it('KE-SWEEP-03: Candidate classification protects young objects (< 60s age barrier)', async () => {
    const key = 'staging/forms/f1/lease-fresh/upload.png';
    const sweeper = new PrefixSweepService({ minOrphanAgeMs: 60000 });
    // Object lastModified is only 10s ago
    const classification = await sweeper.classifyCandidate(key, {
      lastModified: new Date(Date.now() - 10000)
    });
    expect(classification.isOrphan).toBe(false);
    expect(classification.reason).toBe('TOO_YOUNG_IN_FLIGHT');
  });

  it('KE-SWEEP-04: Candidate classification confirms unreferenced mature object as orphan', async () => {
    const key = 'staging/forms/f1/lease-old/unreferenced-straggler.bin';
    const sweeper = new PrefixSweepService({ minOrphanAgeMs: 60000 });
    const classification = await sweeper.classifyCandidate(key, {
      lastModified: new Date(Date.now() - 120000)
    });
    expect(classification.isOrphan).toBe(true);
    expect(classification.reason).toBe('CONFIRMED_UNREFERENCED_ORPHAN');
  });

  it('KE-SWEEP-05: sweepPrefix paginates keys, purges orphan, and checkpoints continuation token', async () => {
    const orphanKey = 'staging/forms/f1/orphan-blob.bin';
    const mockStorageAdapter = {
      listObjectsByPrefix: vi.fn().mockResolvedValue({
        keys: [orphanKey],
        isTruncated: true,
        nextContinuationToken: 'token-page-2',
        keyCount: 1
      }),
      headObject: vi.fn().mockResolvedValue({
        LastModified: new Date(Date.now() - 150000),
        ContentLength: 1024
      }),
      deleteFile: vi.fn().mockResolvedValue(true)
    };

    const sweeper = new PrefixSweepService({
      storageAdapter: mockStorageAdapter,
      minOrphanAgeMs: 60000
    });

    const res = await sweeper.sweepPrefix('staging/');
    expect(res.keysScanned).toBe(1);
    expect(res.orphansPurged).toBe(1);
    expect(res.isTruncated).toBe(true);
    expect(mockStorageAdapter.deleteFile).toHaveBeenCalledWith(orphanKey, expect.any(Object));

    // Verify checkpoint persisted in MongoDB
    const checkpoint = await sweeper.getCheckpoint('staging/');
    expect(checkpoint.continuationToken).toBe('token-page-2');
    expect(checkpoint.isTruncated).toBe(true);
  });

  it('KE-SWEEP-06: Restart recovery resumes pagination from saved continuationToken', async () => {
    const mockStorageAdapter = {
      listObjectsByPrefix: vi.fn().mockResolvedValue({
        keys: [],
        isTruncated: false,
        keyCount: 0
      })
    };

    const sweeper = new PrefixSweepService({
      storageAdapter: mockStorageAdapter
    });

    // Seed prior checkpoint from crashed worker
    await sweeper.saveCheckpoint('staging/', {
      continuationToken: 'token-crashed-run',
      isTruncated: true,
      passNumber: 2
    });

    await sweeper.sweepPrefix('staging/');
    expect(mockStorageAdapter.listObjectsByPrefix).toHaveBeenCalledWith(
      'staging/',
      expect.objectContaining({ continuationToken: 'token-crashed-run' })
    );
  });

  // =========================================================================
  // SECTION 3: Safe Deletion & Storage Provider Semantics
  // =========================================================================

  it('KE-SAFE-01: Prophylactic S3 deletion executed before marking COMPENSATED on 404 (R-KE-01)', async () => {
    const operationId = uuidv4();
    const destinationKey = 'forms/f-comp/responses/late-packet.pdf';
    const past = new Date(Date.now() - 50000);

    await StorageJournal.create({
      operationId,
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      bucket: 'paperless',
      destinationKey,
      status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
      quarantinedUntil: past,
      epoch: 1
    });

    const mockStorageAdapter = {
      headObject: vi.fn().mockImplementation(() => {
        const err = new Error('NotFound');
        err.name = 'NotFound';
        err.statusCode = 404;
        throw err;
      }),
      deleteFile: vi.fn().mockResolvedValue(true)
    };

    const reconciler = new StorageReconciliationService({
      storageAdapter: mockStorageAdapter,
      workerId: 'worker-reconciler-safe'
    });

    const op = await StorageJournal.findOne({ operationId }).lean();
    const result = await reconciler.reconcileRecord(op);

    expect(result.action).toBe('COMPENSATED_404');
    // Verify prophylactic delete was issued to S3 to kill any late packet
    expect(mockStorageAdapter.deleteFile).toHaveBeenCalledWith(destinationKey, expect.any(Object));

    const updated = await StorageJournal.findOne({ operationId }).lean();
    expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
  });

  it('KE-SAFE-02: Stale reconciler with expired monotonic lease aborts pre-delete (R-KE-03)', async () => {
    const operationId = uuidv4();
    const destinationKey = 'forms/f-lease/responses/orphan.bin';

    await StorageJournal.create({
      operationId,
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      bucket: 'paperless',
      destinationKey,
      status: STORAGE_JOURNAL_STATUS.RECONCILING,
      lockedBy: 'worker-stale-1',
      lockedUntil: new Date(Date.now() + 10000),
      epoch: 1
    });

    const mockStorageAdapter = {
      headObject: vi.fn().mockResolvedValue({
        ContentLength: 100,
        ETag: '"etag-1"'
      }),
      deleteFile: vi.fn().mockResolvedValue(true)
    };

    const reconciler = new StorageReconciliationService({
      storageAdapter: mockStorageAdapter,
      workerId: 'worker-stale-1',
      probeDelayMs: 0
    });

    const op = await StorageJournal.findOne({ operationId }).lean();
    // Simulate expired monotonic lease context (e.g. after long GC stall)
    const result = await reconciler.reconcileRecord(op, {
      workerContext: { isLeaseValid: () => false }
    });

    expect(result.action).toBe('LEASE_EXPIRED_PRE_DELETE');
    // Ensure remote delete was NEVER called
    expect(mockStorageAdapter.deleteFile).not.toHaveBeenCalled();
  });

  it('KE-SAFE-03: Concurrent reservation with matching staged key extends quarantine (R-KE-04)', async () => {
    const operationId = uuidv4();
    const destinationKey = 'staging/forms/f-race/lease-other/photo.jpg';

    await StorageJournal.create({
      operationId,
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      bucket: 'paperless',
      destinationKey,
      status: STORAGE_JOURNAL_STATUS.RECONCILING,
      reservationLeaseId: 'lease-original',
      lockedBy: 'worker-rec',
      epoch: 1
    });

    // Concurrent user submitted under a DIFFERENT reservation leaseId
    await SubmissionReservation.create({
      formId: new mongoose.Types.ObjectId(),
      leaseId: 'lease-other',
      fenceToken: 'fence-other',
      status: 'active',
      expiresAt: new Date(Date.now() + 45000),
      stagedKeys: [destinationKey]
    });

    const mockStorageAdapter = {
      headObject: vi.fn().mockResolvedValue({
        ContentLength: 500,
        ETag: '"etag-2"'
      }),
      deleteFile: vi.fn().mockResolvedValue(true)
    };

    const reconciler = new StorageReconciliationService({
      storageAdapter: mockStorageAdapter,
      workerId: 'worker-rec',
      probeDelayMs: 0
    });

    const op = await StorageJournal.findOne({ operationId }).lean();
    const result = await reconciler.reconcileRecord(op);

    expect(result.action).toBe('QUARANTINE_EXTENDED_RESERVATION');
    expect(mockStorageAdapter.deleteFile).not.toHaveBeenCalled();

    const updated = await StorageJournal.findOne({ operationId }).lean();
    expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.AMBIGUOUS);
    expect(new Date(updated.quarantinedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  // =========================================================================
  // SECTION 4: TTLMonitor Coordination & Privilege Handling
  // =========================================================================

  it('KE-TTL-01: markQuiesced attempts TTL suppression and records status in BackupLease', async () => {
    const acquireRes = await quiescenceService.acquireLease('lease-ttl-test', {
      initialLeaseDurationMs: 60000,
      maxAllowedWatchdogDurationMs: 300000
    });
    expect(acquireRes.success).toBe(true);

    const quiescedRes = await quiescenceService.markQuiesced(acquireRes.leaseId);
    expect(quiescedRes.success).toBe(true);

    const leaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(leaseDoc.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
  });

  it('KE-TTL-02: Non-clusterAdmin permission failure handles gracefully without crash', async () => {
    const acquireRes = await quiescenceService.acquireLease('lease-ttl-unauth', {
      initialLeaseDurationMs: 60000,
      maxAllowedWatchdogDurationMs: 300000
    });
    expect(acquireRes.success).toBe(true);

    // Mock admin().command to simulate Unauthorized (code 13) for setParameter
    const adminSpy = vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue({
      command: vi.fn().mockRejectedValue(new Error('Unauthorized: requires clusterAdmin privilege'))
    });

    const quiescedRes = await quiescenceService.markQuiesced(acquireRes.leaseId);
    // Non-strict mode should proceed with advisory warning
    expect(quiescedRes.success).toBe(true);

    const leaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(leaseDoc.ttlMonitorDisabled).toBe(false);
    expect(leaseDoc.ttlMonitorError).toContain('Unauthorized');

    adminSpy.mockRestore();
  });

  it('KE-TTL-03: Strict TTL suppression mode fails closed if command fails', async () => {
    process.env.STRICT_TTL_SUPPRESSION_REQUIRED = 'true';

    const acquireRes = await quiescenceService.acquireLease('lease-ttl-strict', {
      initialLeaseDurationMs: 60000,
      maxAllowedWatchdogDurationMs: 300000
    });
    expect(acquireRes.success).toBe(true);

    const adminSpy = vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue({
      command: vi.fn().mockRejectedValue(new Error('Unauthorized: command setParameter failed'))
    });

    const quiescedRes = await quiescenceService.markQuiesced(acquireRes.leaseId);
    expect(quiescedRes.success).toBe(false);
    expect(quiescedRes.reason).toBe('TTL_SUPPRESSION_FAILED');

    adminSpy.mockRestore();
  });

  it('KE-TTL-04: releaseLease safely restores TTLMonitor on return to NORMAL', async () => {
    const acquireRes = await quiescenceService.acquireLease('lease-ttl-restore', {
      initialLeaseDurationMs: 60000,
      maxAllowedWatchdogDurationMs: 300000
    });

    const releaseRes = await quiescenceService.releaseLease(acquireRes.leaseId);
    expect(releaseRes.success).toBe(true);

    const leaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(leaseDoc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
    expect(leaseDoc.ttlMonitorDisabled).toBe(false);
  });
});
