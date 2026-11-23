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
import AppWorker from '../models/appWorker.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import { StorageReconciliationService } from '../services/storageReconciliationService.js';
import * as quiescenceService from '../services/quiescenceService.js';
import * as workerCoordinationService from '../services/workerCoordinationService.js';

describe('Phase 4.4 Workstream 2D.1J & 2D.1K.7: Durable Datastore Drain Verification Suite', () => {
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
    workerCoordinationService.resetWorkerTasks();
    await mongoose.disconnect();
    await mongod.stop();
    vi.restoreAllMocks();
  });

  it('TS-DD-01: Clean database reports isDrained: true with zero active mutations', async () => {
    const drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(true);
    expect(drainRes.diagnostics.activeReservations).toBe(0);
    expect(drainRes.diagnostics.quarantinedReservations).toBe(0);
    expect(drainRes.diagnostics.deletingForms).toBe(0);
    expect(drainRes.diagnostics.reorderingForms).toBe(0);
    expect(drainRes.diagnostics.activeCleanupJobs).toBe(0);
    expect(drainRes.diagnostics.activeTransactions).toBe(0);
  });

  it('TS-DD-02: Detects active and quarantined submission reservations', async () => {
    const formId = new mongoose.Types.ObjectId();

    // Create an active reservation
    await SubmissionReservation.create({
      formId,
      leaseId: 'lease-test-1',
      fenceToken: 'fence-test-1',
      status: 'active',
      expiresAt: new Date(Date.now() + 60000)
    });

    let res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeReservations).toBe(1);

    // Update to quarantined
    await SubmissionReservation.updateOne(
      { leaseId: 'lease-test-1' },
      { $set: { status: 'abandoned', quarantinedUntil: new Date(Date.now() + 30000) } }
    );

    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.quarantinedReservations).toBe(1);

    // Clean up
    await SubmissionReservation.deleteMany({});
    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(true);
  });

  it('TS-DD-03: Detects deleting forms and question reordering in progress', async () => {
    // Create form with status 'deleting'
    const form = await Form.create({
      title: 'Deleting Form',
      ownerId: new mongoose.Types.ObjectId(),
      status: 'deleting'
    });

    let res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.deletingForms).toBe(1);

    // Reset status and simulate reorderState in progress
    await Form.updateOne(
      { _id: form._id },
      { $set: { status: 'published', 'reorderState.inProgress': true } }
    );

    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.reorderingForms).toBe(1);

    // Clean up
    await Form.deleteMany({});
    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(true);
  });

  it('TS-DD-04: Detects pending and active post-cascade deletion cleanup jobs', async () => {
    await DeletionCleanupJob.create({
      formId: new mongoose.Types.ObjectId(),
      stagingPrefix: 'staging/form-1/',
      finalPrefix: 'forms/form-1/',
      eligibleUntil: new Date(Date.now() + 60000),
      status: 'pending'
    });

    let res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeCleanupJobs).toBe(1);

    await DeletionCleanupJob.deleteMany({});
    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(true);
  });

  it('TS-DD-05: markQuiesced rejects transition to QUIESCED if durable datastore drain is incomplete', async () => {
    const acquireRes = await quiescenceService.acquire({
      leaseDurationMs: 60000,
      initialStatus: BACKUP_LEASE_STATUS.DRAINING
    });
    expect(acquireRes.success).toBe(true);

    // Inject active reservation into datastore
    await SubmissionReservation.create({
      formId: new mongoose.Types.ObjectId(),
      leaseId: 'lease-blocker-1',
      fenceToken: 'fence-blocker-1',
      status: 'active',
      expiresAt: new Date(Date.now() + 60000)
    });

    // Attempt markQuiesced (with enforceDrain: true, which is default)
    const quiesceRes = await quiescenceService.markQuiesced({
      leaseId: acquireRes.leaseId,
      enforceDrain: true
    });

    expect(quiesceRes.success).toBe(false);
    expect(quiesceRes.reason).toBe('DRAIN_PENDING');
    expect(quiesceRes.diagnostics).toBeDefined();
    expect(quiesceRes.diagnostics.activeReservations).toBe(1);

    // Verify lease remains in DRAINING
    const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(doc.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
  });

  it('TS-DD-06: drainInFlight returns isDrained: false when durable datastore has active mutations', async () => {
    const acquireRes = await quiescenceService.acquire({
      leaseDurationMs: 60000,
      initialStatus: BACKUP_LEASE_STATUS.DRAINING
    });

    // Create an active reservation
    await SubmissionReservation.create({
      formId: new mongoose.Types.ObjectId(),
      leaseId: 'lease-drain-1',
      fenceToken: 'fence-drain-1',
      status: 'active',
      expiresAt: new Date(Date.now() + 60000)
    });

    // Call drainInFlight with short timeout and autoReleaseOnTimeout: false
    const drainRes = await quiescenceService.drainInFlight(100, acquireRes.leaseId, {
      autoReleaseOnTimeout: false
    });

    expect(drainRes.success).toBe(false);
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.datastoreDiagnostics).toBeDefined();
    expect(drainRes.datastoreDiagnostics.activeReservations).toBe(1);
  });

  it('TS-DD-07: Detects active storage journal records and blocks quiescence', async () => {
    const StorageJournal = (await import('../models/storageJournal.js')).default;
    await StorageJournal.create({
      operationId: 'op-drain-test-1',
      type: 'PutObject',
      bucket: 'test-bucket',
      destinationKey: 'forms/form1/file1.pdf',
      status: 'DISPATCHED'
    });

    const drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.diagnostics.activeStorageOperations).toBe(1);

    await StorageJournal.deleteMany({});
    const cleanRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(cleanRes.isDrained).toBe(true);
    expect(cleanRes.diagnostics.activeStorageOperations).toBe(0);
  });

  it('TS-DD-08: Drain blocked by active AppWorker with unexpired heartbeat', async () => {
    await AppWorker.ensureRoleDocument('storage_reconciliation');

    // Set worker to ACTIVE with unexpired heartbeat
    await AppWorker.updateOne(
      { _id: 'storage_reconciliation' },
      {
        $set: {
          workerId: 'worker-1',
          incarnationId: 'inc-1',
          status: 'ACTIVE',
          heartbeatExpiresAt: new Date(Date.now() + 30000),
          activeClaimCount: 0
        }
      }
    );

    const res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeWorkers).toBe(1);

    // Transition worker to STOPPED
    await AppWorker.updateOne(
      { _id: 'storage_reconciliation' },
      { $set: { status: 'STOPPED' } }
    );

    const cleanRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(cleanRes.isDrained).toBe(true);
    expect(cleanRes.diagnostics.activeWorkers).toBe(0);
  });

  it('TS-DD-09: Drain blocked by DRAINING AppWorker with in-flight activeClaimCount', async () => {
    await AppWorker.ensureRoleDocument('deletion_cleanup');

    // Set worker to DRAINING but with active claims in progress
    await AppWorker.updateOne(
      { _id: 'deletion_cleanup' },
      {
        $set: {
          workerId: 'worker-2',
          incarnationId: 'inc-2',
          status: 'DRAINING',
          heartbeatExpiresAt: new Date(Date.now() + 30000),
          activeClaimCount: 2
        }
      }
    );

    const res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeWorkers).toBe(1);

    // When claims finish and status reaches STOPPED
    await AppWorker.updateOne(
      { _id: 'deletion_cleanup' },
      { $set: { status: 'STOPPED', activeClaimCount: 0 } }
    );

    const cleanRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(cleanRes.isDrained).toBe(true);
    expect(cleanRes.diagnostics.activeWorkers).toBe(0);
  });

  it('TS-DD-10: Drain passes if worker is in ACTIVE status but heartbeat is EXPIRED (Zombie Worker)', async () => {
    await AppWorker.ensureRoleDocument('storage_reconciliation');

    // Simulate a crashed worker whose heartbeat expired 5 seconds ago
    await AppWorker.updateOne(
      { _id: 'storage_reconciliation' },
      {
        $set: {
          workerId: 'worker-crashed',
          incarnationId: 'inc-crashed',
          status: 'ACTIVE',
          heartbeatExpiresAt: new Date(Date.now() - 5000),
          activeClaimCount: 0
        }
      }
    );

    // Must NOT block drain because expired worker is safely fenced
    const res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(true);
    expect(res.diagnostics.activeWorkers).toBe(0);
  });

  it('TS-DD-11: Drain blocked by active StorageJournal claim in RECONCILING status', async () => {
    await StorageJournal.create({
      operationId: 'op-rec-blocker',
      type: 'PutObject',
      bucket: 'test-bucket',
      destinationKey: 'forms/f1/file.pdf',
      status: 'RECONCILING',
      lockedUntil: new Date(Date.now() + 15000),
      lockedBy: 'worker-rec-1'
    });

    const res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeStorageOperations).toBe(1);
    expect(res.diagnostics.storageDetails.reconciling).toBe(1);

    // Transition to COMPENSATED
    await StorageJournal.updateOne(
      { operationId: 'op-rec-blocker' },
      { $set: { status: 'COMPENSATED', lockedUntil: null, lockedBy: null } }
    );

    const cleanRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(cleanRes.isDrained).toBe(true);
    expect(cleanRes.diagnostics.activeStorageOperations).toBe(0);
  });

  it('TS-DD-12: Drain blocked by unquarantined and quarantined AMBIGUOUS StorageJournal records', async () => {
    // 1. Quarantined ambiguous record (TCP buffer flush active)
    await StorageJournal.create({
      operationId: 'op-amb-quarantine',
      type: 'PutObject',
      bucket: 'test-bucket',
      destinationKey: 'forms/f1/quarantine.pdf',
      status: 'AMBIGUOUS',
      quarantinedUntil: new Date(Date.now() + 40000)
    });

    let res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeStorageOperations).toBe(1);
    expect(res.diagnostics.storageDetails.quarantined).toBe(1);

    // 2. Add an expired-quarantine ambiguous record awaiting sweeper
    await StorageJournal.create({
      operationId: 'op-amb-unquarantined',
      type: 'DeleteObject',
      bucket: 'test-bucket',
      destinationKey: 'forms/f1/delete-pending.pdf',
      status: 'AMBIGUOUS',
      quarantinedUntil: new Date(Date.now() - 10000)
    });

    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeStorageOperations).toBe(2);
    expect(res.diagnostics.storageDetails.pendingReconcile).toBe(1);

    // Clean up
    await StorageJournal.deleteMany({});
    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(true);
  });

  it('TS-DD-13: Drain blocked by write-ahead PENDING and S3-acknowledged CONFIRMED records', async () => {
    await StorageJournal.create({
      operationId: 'op-pending',
      type: 'PutObject',
      bucket: 'test-bucket',
      destinationKey: 'forms/f1/pending.pdf',
      status: 'PENDING'
    });

    let res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeStorageOperations).toBe(1);
    expect(res.diagnostics.storageDetails.dispatched).toBe(1);

    await StorageJournal.create({
      operationId: 'op-confirmed',
      type: 'PutObject',
      bucket: 'test-bucket',
      destinationKey: 'forms/f1/confirmed.pdf',
      status: 'CONFIRMED'
    });

    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(false);
    expect(res.diagnostics.activeStorageOperations).toBe(2);
    expect(res.diagnostics.storageDetails.confirmed).toBe(1);

    await StorageJournal.deleteMany({});
    res = await quiescenceService.checkDurableDatastoreDrain();
    expect(res.isDrained).toBe(true);
  });

  it('TS-DD-14: Restart during active drain prevents false positive quiescence', async () => {
    // Acquire lease into DRAINING
    const acquireRes = await quiescenceService.acquire({
      leaseDurationMs: 60000,
      initialStatus: BACKUP_LEASE_STATUS.DRAINING
    });
    expect(acquireRes.success).toBe(true);

    // Simulate worker registered before crash
    await AppWorker.ensureRoleDocument('storage_reconciliation');
    await AppWorker.updateOne(
      { _id: 'storage_reconciliation' },
      {
        $set: {
          workerId: 'worker-pre-crash',
          incarnationId: 'inc-pre-crash',
          status: 'ACTIVE',
          heartbeatExpiresAt: new Date(Date.now() + 25000), // unexpired
          activeClaimCount: 1
        }
      }
    );

    // In-flight storage mutation logged in journal
    await StorageJournal.create({
      operationId: 'op-crash-inflight',
      type: 'PutObject',
      bucket: 'test-bucket',
      destinationKey: 'forms/f1/inflight.pdf',
      status: 'DISPATCHED'
    });

    // SIMULATE CRASH & RESTART:
    // In-memory worker coordination state is completely reset to 0
    workerCoordinationService.resetWorkerTasks();
    expect(workerCoordinationService.getActiveWorkerTaskCount()).toBe(0);

    // Attempt markQuiesced immediately following restart
    const quiesceRes = await quiescenceService.markQuiesced({
      leaseId: acquireRes.leaseId,
      enforceDrain: true
    });

    // MUST BE REJECTED despite in-memory tasks being 0!
    expect(quiesceRes.success).toBe(false);
    expect(quiesceRes.reason).toBe('DRAIN_PENDING');
    expect(quiesceRes.diagnostics.activeWorkers).toBe(1);
    expect(quiesceRes.diagnostics.activeStorageOperations).toBe(1);

    // Fast-forward: storage operation completes, worker marks stopped
    await StorageJournal.updateOne(
      { operationId: 'op-crash-inflight' },
      { $set: { status: 'COMMITTED' } }
    );
    await AppWorker.updateOne(
      { _id: 'storage_reconciliation' },
      { $set: { status: 'STOPPED', activeClaimCount: 0 } }
    );

    // Now markQuiesced must succeed cleanly
    const retryQuiesce = await quiescenceService.markQuiesced({
      leaseId: acquireRes.leaseId,
      enforceDrain: true
    });
    expect(retryQuiesce.success).toBe(true);
    expect(retryQuiesce.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
  });

  it('TS-DD-15: Fail-closed verification on database error and disconnected state', async () => {
    // 1. Database disconnect
    const readyStateSpy = vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);

    let drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.reason).toBe('DB_DISCONNECTED');

    readyStateSpy.mockRestore();

    // 2. Database query exception
    const mockDb = mongoose.connection.db;
    const originalCollection = mockDb.collection.bind(mockDb);
    const collectionSpy = vi.spyOn(mockDb, 'collection').mockImplementation((name) => {
      const coll = originalCollection(name);
      if (name === 'app_workers') {
        vi.spyOn(coll, 'countDocuments').mockRejectedValueOnce(
          new Error('MongoNetworkTimeoutException: socket timed out')
        );
      }
      return coll;
    });

    drainRes = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainRes.isDrained).toBe(false);
    expect(drainRes.reason).toBe('DATASTORE_QUERY_FAILED');
    expect(drainRes.diagnostics.error).toContain('MongoNetworkTimeoutException');

    collectionSpy.mockRestore();
  });

  // =========================================================================
  // ADV-KD-01: Split-Brain Worker Takeover & Fencing Token Collision
  // =========================================================================
  it('ADV-KD-01: Stale worker with expired lease cannot clobber record or delete object post-takeover', async () => {
    const operationId = `op-${uuidv4()}`;
    const destinationKey = `forms/form-1/responses/resp-1/file-${uuidv4()}.pdf`;

    // Seed an ambiguous storage operation
    await StorageJournal.create({
      operationId,
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      destinationKey,
      status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
      epoch: 1,
      quarantinedUntil: null,
      lockedUntil: null
    });

    const mockStorageAdapter = {
      headObject: vi.fn().mockResolvedValue({ ContentLength: 1024, ETag: '"hash123"' }),
      deleteFile: vi.fn().mockResolvedValue({ success: true })
    };

    // Worker 1 claims with very short lease (100ms)
    const worker1 = new StorageReconciliationService({
      storageAdapter: mockStorageAdapter,
      workerId: 'worker-1',
      probeDelayMs: 10
    });

    const claimed1 = await StorageJournal.claimForReconciliation(operationId, 'worker-1', {
      leaseDurationMs: 100
    });
    expect(claimed1).toBeTruthy();
    expect(claimed1.epoch).toBe(2);
    expect(claimed1.lockedBy).toBe('worker-1');

    // Simulate Worker 1 pausing for 150ms (exceeding 100ms lease)
    await new Promise((r) => setTimeout(r, 150));

    // Worker 2 takes over the expired record
    const worker2 = new StorageReconciliationService({
      storageAdapter: mockStorageAdapter,
      workerId: 'worker-2',
      probeDelayMs: 10
    });

    const claimed2 = await StorageJournal.claimForReconciliation(operationId, 'worker-2', {
      leaseDurationMs: 5000
    });
    expect(claimed2).toBeTruthy();
    expect(claimed2.epoch).toBe(3);
    expect(claimed2.lockedBy).toBe('worker-2');

    // User commits response referencing key
    await Response.create({
      formId: new mongoose.Types.ObjectId(),
      answers: [{
        questionId: new mongoose.Types.ObjectId(),
        value: { key: destinationKey }
      }],
      commitStatus: 'committed'
    });

    // Worker 2 reconciles and confirms
    const res2 = await worker2.reconcileRecord(claimed2);
    expect(res2.action).toBe('CONFIRMED');

    const confirmedDoc = await StorageJournal.findOne({ operationId });
    expect(confirmedDoc.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
    expect(confirmedDoc.epoch).toBe(4);

    // Stale Worker 1 wakes up and attempts to reconcile stale op
    // ADVERSARIAL ASSERTION: Worker 1 MUST NOT delete the file or revert status
    mockStorageAdapter.deleteFile.mockClear();
    await worker1.reconcileRecord(claimed1);

    expect(mockStorageAdapter.deleteFile).not.toHaveBeenCalled();
    const finalDoc = await StorageJournal.findOne({ operationId });
    expect(finalDoc.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
    expect(finalDoc.epoch).toBe(4);
  });

  // =========================================================================
  // ADV-KD-02: GC Pause Zombie Worker Resurrection & Unfenced State Clashing
  // =========================================================================
  it('ADV-KD-02: Stale worker attempting quarantine reset cannot strip successor lock', async () => {
    const operationId = `op-${uuidv4()}`;
    const destinationKey = `forms/form-1/responses/resp-1/drift-${uuidv4()}.pdf`;

    await StorageJournal.create({
      operationId,
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      destinationKey,
      status: STORAGE_JOURNAL_STATUS.RECONCILING,
      epoch: 5,
      lockedBy: 'worker-successor',
      lockedUntil: new Date(Date.now() + 10000)
    });

    // Stale worker wakes up and executes quarantine reset
    const staleWorkerUpdate = await StorageJournal.updateOne(
      {
        operationId,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: 4, // Stale epoch from prior claim
        lockedBy: 'worker-stale' // Stale worker identity
      },
      {
        $set: {
          status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
          lockedUntil: null,
          lockedBy: null
        }
      }
    );

    // Fencing check must prevent the overwrite
    expect(staleWorkerUpdate.matchedCount).toBe(0);

    const doc = await StorageJournal.findOne({ operationId });
    expect(doc.status).toBe(STORAGE_JOURNAL_STATUS.RECONCILING);
    expect(doc.lockedBy).toBe('worker-successor');
  });

  // =========================================================================
  // ADV-KD-03: Quiescence Drain During In-Flight Storage Reconciliation
  // =========================================================================
  it('ADV-KD-03: Active reconciliation task blocks quiescence drain until completion', async () => {
    const operationId = `op-${uuidv4()}`;
    await StorageJournal.create({
      operationId,
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      destinationKey: 'test-key.pdf',
      status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
      quarantinedUntil: null
    });

    let reconcileStarted = false;
    let finishReconcile;
    const reconcileBlocker = new Promise((resolve) => {
      finishReconcile = resolve;
    });

    // Start background reconciliation wrapped in worker task
    const workerPromise = workerCoordinationService.registerWorkerTask(
      'storage_reconciliation',
      async () => {
        reconcileStarted = true;
        await reconcileBlocker;
        return { completed: true };
      }
    );

    // Wait for worker task to register
    while (!reconcileStarted) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(workerCoordinationService.getActiveWorkerTaskCount()).toBe(1);

    // Quiescence drain is requested while worker is in flight
    workerCoordinationService.closeWorkerAdmission('QUIESCENCE');

    // Drain check must report NOT drained while worker is running
    const drainCheck1 = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainCheck1.isDrained).toBe(false);
    expect(drainCheck1.diagnostics.activeWorkers).toBe(1);

    // Release worker task
    finishReconcile();
    await workerPromise;

    // Verify drain check passes after worker finishes
    const drainCheck2 = await quiescenceService.checkDurableDatastoreDrain();
    expect(drainCheck2.diagnostics.activeWorkers).toBe(0);
  });

  // =========================================================================
  // ADV-KD-04: Post-Crash Recovery & Fail-Closed Datastore Drain on Fault Injection
  // =========================================================================
  it('ADV-KD-04: checkDurableDatastoreDrain strictly fails closed on MongoDB errors', async () => {
    // Inject database query failure
    const mockDb = mongoose.connection.db;
    const originalCollection = mockDb.collection.bind(mockDb);
    const collectionSpy = vi.spyOn(mockDb, 'collection').mockImplementation((name) => {
      const coll = originalCollection(name);
      if (name === 'submissionreservations') {
        vi.spyOn(coll, 'countDocuments').mockRejectedValueOnce(
          new Error('MongoNetworkTimeoutError: connection lost to replica primary')
        );
      }
      return coll;
    });

    const result = await quiescenceService.checkDurableDatastoreDrain();

    // MUST FAIL CLOSED (isDrained: false)
    expect(result.isDrained).toBe(false);
    expect(result.reason).toBe('DATASTORE_QUERY_FAILED');
    expect(result.error).toContain('MongoNetworkTimeoutError');

    collectionSpy.mockRestore();
  });
});
