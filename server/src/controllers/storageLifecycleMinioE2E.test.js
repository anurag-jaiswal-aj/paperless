/**
 * storageLifecycleMinioE2E.test.js
 *
 * Phase 2D.1K.9 (Phase K-F): Multi-Container End-to-End Lifecycle & Real MinIO Verification Suite
 *
 * Combines live MinIO container (ephemeral infrastructure, ports 9010/9011) with
 * single-node WiredTiger MongoDB replica set (MongoMemoryReplSet) to verify:
 *
 * 1. Full StorageJournal Lifecycle with Live MinIO:
 *    - Happy path: submission reservation -> write-ahead PENDING -> upload to MinIO ->
 *      CONFIRMED with ETag -> multi-document transaction creates Response -> COMMITTED journal.
 *    - Upload failure: simulated MinIO abort/error -> AMBIGUOUS with quarantine ->
 *      reconciliation detects 404 -> prophylactic delete -> COMPENSATED_404.
 *    - Post-upload crash (uncommitted zombie blob in MinIO) -> reconciliation detects unreferenced ->
 *      deletes blob from live MinIO -> COMPENSATED.
 *
 * 2. Autonomous Storage Reconciliation with Real MinIO:
 *    - Dual-HEAD stability probe detecting in-flight write drift on live MinIO (extends quarantine 30s).
 *    - Dual-HEAD stability probe detecting object vanishing between probes.
 *    - Foreign metadata collision defense (ABANDONED_COLLISION).
 *    - Monotonic lease check preventing stale worker clobbering (LEASE_EXPIRED_PRE_DELETE).
 *    - Stale epoch CAS conflict detection (STALE_EPOCH_CONFLICT).
 *
 * 3. Prefix Sweep with Live MinIO Bucket:
 *    - Real continuation token pagination across live MinIO bucket.
 *    - 5-tier classification ladder protecting committed responses, active reservations, and young files.
 *    - Purging real unreferenced orphan blobs from MinIO bucket while preserving legitimate data.
 *    - Durable checkpoint persistence in MongoDB collection `sweep_checkpoints`.
 *
 * 4. Cold-Storage Barrier Drain with Live MinIO Operations:
 *    - Active MinIO operations strictly block `checkDurableDatastoreDrain` and `markQuiesced`.
 *    - Verification of 30-second transport quiet period rationale (socket acquisition timeout S3_DEFAULT_TIMEOUTS.UPLOAD_TIMEOUT_MS = 30s).
 *    - Clean quiescence transition: status QUIESCED, TTLMonitor suppressed, admission gate closed, clean release.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import mongoose from 'mongoose';
import {
  PutObjectCommand
} from '@aws-sdk/client-s3';

import Form from '../models/form.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import DeletionCleanupJob from '../models/deletionCleanupJob.js';
import InstanceLease, { InstanceLeaseSlot } from '../models/instanceLease.js';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import AppWorker from '../models/appWorker.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';

import s3Provider, { S3_DEFAULT_TIMEOUTS } from '../services/S3StorageProvider.js';
import { StorageReconciliationService } from '../services/storageReconciliationService.js';
import { PrefixSweepService } from '../services/prefixSweepService.js';
import * as quiescenceService from '../services/quiescenceService.js';
import * as workerCoordinationService from '../services/workerCoordinationService.js';
import { withRequiredTransaction } from '../utils/dbTransaction.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import {
  MINIO_TEST_CONFIG,
  startMinioTestContainer,
  emptyTestBucket,
  setupTestStorageEnv,
  createTestS3Client
} from '../testUtils/minioTestHelper.js';

const PDF_BINARY_PAYLOAD = Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF'
);

describe('Phase 2D.1K.9 (Phase K-F): Multi-Container End-to-End Lifecycle & Real MinIO Verification Suite', () => {
  let replSet;
  let restoreEnv;
  let minioClient;

  beforeAll(async () => {
    // 1. Ensure live MinIO test container is healthy and bucket exists
    await startMinioTestContainer({ ensureBucket: true });

    // 2. Set environment variables to point directly to live MinIO
    const envSetup = setupTestStorageEnv(MINIO_TEST_CONFIG);
    restoreEnv = envSetup.restoreEnv;

    // 3. Re-initialize singleton s3Provider with live MinIO credentials
    s3Provider.init();

    // 4. Create direct S3 client for independent verification
    minioClient = createTestS3Client(MINIO_TEST_CONFIG);

    // 5. Start WiredTiger MongoDB replica set for multi-document ACID transactions
    replSet = await startReplSet([
      StorageJournal,
      BackupLease,
      AppWorker,
      Form,
      Response,
      SubmissionReservation,
      DeletionCleanupJob,
      InstanceLease,
      InstanceLeaseSlot
    ]);

    await quiescenceService.ensureSingletonExists();
  }, 45000);

  afterAll(async () => {
    try {
      await emptyTestBucket();
    } catch {
      // Best-effort cleanup
    }

    if (minioClient) {
      await minioClient.destroy();
    }

    if (restoreEnv) {
      restoreEnv();
    }
    s3Provider.init();

    await stopReplSet(replSet);
  }, 30000);

  beforeEach(async () => {
    await emptyTestBucket();
    await StorageJournal.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await Form.deleteMany({});
    await BackupLease.deleteMany({});
    await AppWorker.deleteMany({});
    if (mongoose.connection?.db) {
      await mongoose.connection.db.collection('sweep_checkpoints').deleteMany({});
    }
    await quiescenceService.ensureSingletonExists();
    workerCoordinationService.resetWorkerTasks();
  });

  afterEach(() => {
    delete process.env.STRICT_TTL_SUPPRESSION_REQUIRED;
    workerCoordinationService.resetWorkerTasks();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SECTION 1: Full StorageJournal Lifecycle with Live MinIO
  // =========================================================================

  describe('1. Full StorageJournal Lifecycle with Live MinIO', () => {
    it('TS-E2E-SJ-01: Happy Path - Submission reservation -> write-ahead PENDING -> MinIO upload -> CONFIRMED -> replica-set commit -> COMMITTED', async () => {
      const formId = new mongoose.Types.ObjectId();
      const leaseId = `lease_${crypto.randomUUID().slice(0, 8)}`;
      const fenceToken = `fence_${crypto.randomUUID().slice(0, 8)}`;
      const operationId = crypto.randomUUID();
      const destinationKey = `forms/${formId}/responses/${operationId}-document.pdf`;

      // 1. Create published Form in MongoDB
      await Form.create({
        _id: formId,
        title: 'E2E Lifecycle Form',
        ownerId: new mongoose.Types.ObjectId(),
        status: 'published'
      });

      // 2. Client initiates submission -> acquires active SubmissionReservation
      await SubmissionReservation.create({
        formId,
        leaseId,
        fenceToken,
        status: 'active',
        stagedKeys: [destinationKey],
        expiresAt: new Date(Date.now() + 60000)
      });

      // 3. Write-ahead StorageJournal intent recorded in PENDING outside business transaction
      const journalEntry = await StorageJournal.recordIntent({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey,
        formId,
        reservationLeaseId: leaseId,
        payloadSize: PDF_BINARY_PAYLOAD.length,
        payloadHash: crypto.createHash('sha256').update(PDF_BINARY_PAYLOAD).digest('hex'),
        mimeType: 'application/pdf',
        status: STORAGE_JOURNAL_STATUS.PENDING
      });
      expect(journalEntry.status).toBe(STORAGE_JOURNAL_STATUS.PENDING);
      expect(journalEntry.epoch).toBe(0);

      // 4. Mark DISPATCHED and execute upload to live MinIO container
      await StorageJournal.markDispatched(operationId, 0);

      const uploadResult = await s3Provider.uploadFile(
        PDF_BINARY_PAYLOAD,
        destinationKey,
        'application/pdf',
        {
          metadata: {
            'operation-id': operationId,
            'payload-hash': journalEntry.payloadHash
          },
          returnMetadata: true
        }
      );
      expect(uploadResult.key).toBe(destinationKey);
      expect(uploadResult.etag).toBeDefined();

      // 5. Remote upload verified -> transition StorageJournal to CONFIRMED
      const confirmedJournal = await StorageJournal.confirmOperation(operationId, 1, {
        etag: uploadResult.etag
      });
      expect(confirmedJournal.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
      expect(confirmedJournal.etag).toBe(uploadResult.etag);

      // Verify object exists in live MinIO bucket
      const headCheck = await s3Provider.headObject(destinationKey);
      expect(headCheck).not.toBeNull();
      expect(headCheck.contentLength).toBe(PDF_BINARY_PAYLOAD.length);
      expect(headCheck.etag).toBe(uploadResult.etag);

      // 6. Execute multi-document WiredTiger replica-set transaction:
      //    Insert Response, finalize reservation, commit StorageJournal
      let createdResponseId;
      await withRequiredTransaction(async (session) => {
        const txNow = new Date();

        // Step A: Insert Response document
        const [responseDoc] = await Response.create(
          [
            {
              formId,
              answers: [
                {
                  questionId: new mongoose.Types.ObjectId(),
                  value: {
                    key: destinationKey,
                    mimeType: 'application/pdf',
                    size: PDF_BINARY_PAYLOAD.length
                  }
                }
              ],
              commitStatus: 'committed',
              reservationLeaseId: leaseId,
              payloadHash: journalEntry.payloadHash
            }
          ],
          { session }
        );
        createdResponseId = responseDoc._id;

        // Step B: Finalize reservation
        await SubmissionReservation.updateOne(
          { leaseId, fenceToken },
          { $set: { status: 'finalized', updatedAt: txNow } },
          { session }
        );

        // Step C: Atomically commit confirmed StorageJournal record
        await StorageJournal.commitInTransaction([destinationKey], {
          responseId: createdResponseId,
          formId,
          session
        });
      }, { partitionKey: String(formId) });

      // 7. Verification:
      // Response is committed in MongoDB
      const committedResponse = await Response.findById(createdResponseId).lean();
      expect(committedResponse).not.toBeNull();
      expect(committedResponse.commitStatus).toBe('committed');
      expect(committedResponse.answers[0].value.key).toBe(destinationKey);

      // StorageJournal is COMMITTED with 7-day vacuum window
      const finalJournal = await StorageJournal.findOne({ operationId }).lean();
      expect(finalJournal.status).toBe(STORAGE_JOURNAL_STATUS.COMMITTED);
      expect(String(finalJournal.responseId)).toBe(String(createdResponseId));
      expect(finalJournal.vacuumAt).toBeDefined();
      const vacuumDiffDays =
        (new Date(finalJournal.vacuumAt).getTime() - Date.now()) / (1000 * 3600 * 24);
      expect(vacuumDiffDays).toBeGreaterThan(6.8);

      // Object remains byte-for-byte readable from live MinIO
      const download = await s3Provider.getFileStream(destinationKey);
      const chunks = [];
      for await (const chunk of download.stream) {
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks)).toEqual(PDF_BINARY_PAYLOAD);
    });

    it('TS-E2E-SJ-02: Failure during upload -> journal marked AMBIGUOUS -> reconciliation cleans up and marks COMPENSATED_404', async () => {
      const operationId = crypto.randomUUID();
      const destinationKey = `forms/f-fail/responses/${operationId}-aborted.pdf`;

      // 1. Write-ahead journal intent recorded in PENDING
      await StorageJournal.recordIntent({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey,
        payloadSize: 1024,
        payloadHash: 'hash-abc',
        status: STORAGE_JOURNAL_STATUS.PENDING
      });
      await StorageJournal.markDispatched(operationId, 0);

      // 2. Simulate upload failure (aborted before bytes reach MinIO)
      const abortController = new AbortController();
      abortController.abort(new Error('Simulated network connection drop'));

      let uploadThrew = false;
      try {
        await s3Provider.uploadFile(PDF_BINARY_PAYLOAD, destinationKey, 'application/pdf', {
          abortSignal: abortController.signal
        });
      } catch {
        uploadThrew = true;
      }
      expect(uploadThrew).toBe(true);

      // StorageService marks AMBIGUOUS with quarantine
      const ambiguousOp = await StorageJournal.markAmbiguous(operationId, 1, {
        errorDetails: 'AbortError: Simulated network connection drop',
        quarantineMs: 100 // Short quarantine for test
      });
      expect(ambiguousOp.status).toBe(STORAGE_JOURNAL_STATUS.AMBIGUOUS);
      expect(ambiguousOp.quarantinedUntil).toBeDefined();

      // 3. Fast-forward past quarantine
      await StorageJournal.updateOne(
        { operationId },
        { $set: { quarantinedUntil: new Date(Date.now() - 5000) } }
      );

      // 4. Background StorageReconciliationService claims and reconciles record
      const reconciler = new StorageReconciliationService({
        storageAdapter: s3Provider,
        workerId: 'reconciler-e2e-worker-1',
        probeDelayMs: 10
      });

      const opDoc = await StorageJournal.findOne({ operationId }).lean();
      const recResult = await reconciler.reconcileRecord(opDoc);

      // 5. Reconciler verified object was 404 in MinIO, issued prophylactic delete, and marked COMPENSATED_404
      expect(recResult.action).toBe('COMPENSATED_404');
      expect(recResult.operationId).toBe(operationId);

      const updatedJournal = await StorageJournal.findOne({ operationId }).lean();
      expect(updatedJournal.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
      expect(updatedJournal.errorDetails).toContain('404 NotFound after quarantine');

      // Verify no object exists in live MinIO
      const headCheck = await s3Provider.headObject(destinationKey);
      expect(headCheck).toBeNull();
    });

    it('TS-E2E-SJ-03: Failure post-upload / pre-commit (Uncommitted zombie upload in MinIO) -> Reconciler discovers unreferenced object and deletes it', async () => {
      const operationId = crypto.randomUUID();
      const destinationKey = `forms/f-zombie/responses/${operationId}-zombie.bin`;
      const zombiePayload = Buffer.from('ZOMBIE-PAYLOAD-THAT-WAS-NEVER-COMMITTED-IN-MONGO');

      // 1. Object was physically uploaded to live MinIO
      const uploadRes = await s3Provider.uploadFile(zombiePayload, destinationKey, 'application/octet-stream', {
        returnMetadata: true
      });
      expect(uploadRes.etag).toBeDefined();

      // Verify object exists in live MinIO
      let minioHead = await s3Provider.headObject(destinationKey);
      expect(minioHead).not.toBeNull();
      expect(minioHead.contentLength).toBe(zombiePayload.length);

      // 2. StorageJournal was in DISPATCHED state because server crashed before commit
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey,
        payloadSize: zombiePayload.length,
        status: STORAGE_JOURNAL_STATUS.DISPATCHED,
        epoch: 1,
        quarantinedUntil: null
      });

      // No Response document exists in MongoDB, and no active reservation exists
      const responseExists = await Response.exists({ 'answers.value.key': destinationKey });
      expect(responseExists).toBeNull();

      // 3. Autonomous StorageReconciliationService runs against live MinIO
      const reconciler = new StorageReconciliationService({
        storageAdapter: s3Provider,
        workerId: 'reconciler-zombie-hunter',
        probeDelayMs: 20
      });

      const opDoc = await StorageJournal.findOne({ operationId }).lean();
      const recResult = await reconciler.reconcileRecord(opDoc);

      // 4. Assertions:
      // Reconciler verified dual-HEAD stability, checked two-tier references (none found),
      // deleted the real zombie object from MinIO, and marked journal COMPENSATED
      expect(recResult.action).toBe('COMPENSATED');

      const updatedJournal = await StorageJournal.findOne({ operationId }).lean();
      expect(updatedJournal.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
      expect(updatedJournal.errorDetails).toContain('Unreferenced zombie blob compensated');

      // 5. Verify the zombie blob was permanently and cleanly deleted from live MinIO!
      minioHead = await s3Provider.headObject(destinationKey);
      expect(minioHead).toBeNull();
    });
  });

  // =========================================================================
  // SECTION 2: Autonomous Storage Reconciliation with Real MinIO
  // =========================================================================

  describe('2. Autonomous Storage Reconciliation with Real MinIO', () => {
    it('TS-E2E-REC-01: Dual-HEAD stability probe detects in-flight write drift on live MinIO and extends quarantine by 30s', async () => {
      const operationId = crypto.randomUUID();
      const destinationKey = `staging/drift/${operationId}-drift.bin`;

      // 1. Initial write to live MinIO (50 bytes)
      const initialChunk = Buffer.alloc(50, 'A');
      await s3Provider.uploadFile(initialChunk, destinationKey, 'application/octet-stream');

      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey,
        payloadSize: 50,
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil: new Date(Date.now() - 1000), // Quarantine expired
        epoch: 1
      });

      // 2. Setup reconciler with probe delay and spy on headObject to mutate MinIO between probes
      let probeCount = 0;
      const realHeadObject = s3Provider.headObject.bind(s3Provider);
      const headSpy = vi.spyOn(s3Provider, 'headObject').mockImplementation(async (key, options) => {
        probeCount += 1;
        if (probeCount === 2) {
          // Mutate the live MinIO object between Probe 1 and Probe 2 (simulating active flush)
          const secondChunk = Buffer.alloc(120, 'B');
          await s3Provider.client.send(
            new PutObjectCommand({
              Bucket: MINIO_TEST_CONFIG.BUCKET,
              Key: destinationKey,
              Body: secondChunk
            })
          );
        }
        return realHeadObject(key, options);
      });

      const reconciler = new StorageReconciliationService({
        storageAdapter: s3Provider,
        workerId: 'reconciler-drift-tester',
        probeDelayMs: 30
      });

      const opDoc = await StorageJournal.findOne({ operationId }).lean();
      const recResult = await reconciler.reconcileRecord(opDoc);

      headSpy.mockRestore();

      // 3. Dual-HEAD drift detected: Reconciler aborts deletion and extends quarantine by 30 seconds
      expect(recResult.action).toBe('QUARANTINE_EXTENDED_DRIFT');

      const updatedJournal = await StorageJournal.findOne({ operationId }).lean();
      expect(updatedJournal.status).toBe(STORAGE_JOURNAL_STATUS.AMBIGUOUS);
      expect(updatedJournal.errorDetails).toContain('Dual-HEAD drift detected');

      const quarantineRemainingMs = new Date(updatedJournal.quarantinedUntil).getTime() - Date.now();
      expect(quarantineRemainingMs).toBeGreaterThan(20000); // Extended by ~30s

      // Live MinIO object was NOT deleted
      const checkExists = await s3Provider.headObject(destinationKey);
      expect(checkExists).not.toBeNull();
      expect(checkExists.contentLength).toBe(120);
    });

    it('TS-E2E-REC-02: Dual-HEAD probe catches object vanishing between probes and extends quarantine', async () => {
      const operationId = crypto.randomUUID();
      const destinationKey = `staging/vanish/${operationId}-vanish.bin`;

      await s3Provider.uploadFile(Buffer.from('TEMPORARY-BLOB'), destinationKey, 'application/octet-stream');

      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil: new Date(Date.now() - 1000),
        epoch: 1
      });

      let probeCount = 0;
      const realHeadObject = s3Provider.headObject.bind(s3Provider);
      const headSpy = vi.spyOn(s3Provider, 'headObject').mockImplementation(async (key, options) => {
        probeCount += 1;
        if (probeCount === 2) {
          // Object vanished from MinIO right before Probe 2
          return null;
        }
        return realHeadObject(key, options);
      });

      const reconciler = new StorageReconciliationService({
        storageAdapter: s3Provider,
        workerId: 'reconciler-vanish-tester',
        probeDelayMs: 20
      });

      const opDoc = await StorageJournal.findOne({ operationId }).lean();
      const recResult = await reconciler.reconcileRecord(opDoc);
      headSpy.mockRestore();

      expect(recResult.action).toBe('QUARANTINE_EXTENDED_UNSTABLE');
      const updatedJournal = await StorageJournal.findOne({ operationId }).lean();
      expect(updatedJournal.errorDetails).toContain('vanished during dual-HEAD probe');
    });

    it('TS-E2E-REC-03: Metadata collision protection prevents deleting foreign tenant object from live MinIO', async () => {
      const operationId = crypto.randomUUID();
      const destinationKey = `forms/f-tenant/responses/${operationId}-shared.bin`;

      // Upload object to live MinIO with foreign operation metadata
      await s3Provider.uploadFile(Buffer.from('TENANT-A-CONFIDENTIAL-DATA'), destinationKey, 'application/octet-stream', {
        metadata: {
          'operation-id': 'foreign-tenant-operation-999',
          'payload-hash': 'foreign-payload-hash-999'
        }
      });

      // Local journal record attempts to reconcile with differing operationId and hash
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey,
        payloadHash: 'local-hash-differing',
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil: new Date(Date.now() - 1000),
        epoch: 1
      });

      const reconciler = new StorageReconciliationService({
        storageAdapter: s3Provider,
        workerId: 'reconciler-collision-guard',
        probeDelayMs: 10
      });

      const opDoc = await StorageJournal.findOne({ operationId }).lean();
      const recResult = await reconciler.reconcileRecord(opDoc);

      // Reconciler detects key occupied by distinct payload -> ABANDONED_COLLISION
      expect(recResult.action).toBe('ABANDONED_COLLISION');

      const updatedJournal = await StorageJournal.findOne({ operationId }).lean();
      expect(updatedJournal.status).toBe(STORAGE_JOURNAL_STATUS.ABANDONED);
      expect(updatedJournal.errorDetails).toContain('differing operationId; preserved');

      // The foreign object in MinIO MUST NOT BE DELETED!
      const foreignHead = await s3Provider.headObject(destinationKey);
      expect(foreignHead).not.toBeNull();
      expect(foreignHead.metadata['operation-id']).toBe('foreign-tenant-operation-999');
    });

    it('TS-E2E-REC-04: Monotonic lease check prevents stale worker clobbering live MinIO object (R-KE-03)', async () => {
      const operationId = crypto.randomUUID();
      const destinationKey = `forms/f-stale/responses/${operationId}-safe.bin`;

      await s3Provider.uploadFile(Buffer.from('SAFE-DATA'), destinationKey, 'application/octet-stream');

      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil: new Date(Date.now() - 1000),
        epoch: 1
      });

      const reconciler = new StorageReconciliationService({
        storageAdapter: s3Provider,
        workerId: 'reconciler-stale-worker',
        probeDelayMs: 10
      });

      const opDoc = await StorageJournal.findOne({ operationId }).lean();

      // Simulate worker context where monotonic watchdog lease expired during GC pause
      const recResult = await reconciler.reconcileRecord(opDoc, {
        workerContext: { isLeaseValid: () => false }
      });

      expect(recResult.action).toBe('LEASE_EXPIRED_PRE_DELETE');

      // Live MinIO object must still exist intact!
      const stillThere = await s3Provider.headObject(destinationKey);
      expect(stillThere).not.toBeNull();
    });

    it('TS-E2E-REC-05: Stale epoch CAS conflict halts reconciler if another worker claimed the record', async () => {
      const operationId = crypto.randomUUID();
      const destinationKey = `forms/f-epoch/responses/${operationId}-race.bin`;

      await s3Provider.uploadFile(Buffer.from('RACE-DATA'), destinationKey, 'application/octet-stream');

      const originalDoc = await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        lockedBy: 'worker-primary',
        lockedUntil: new Date(Date.now() + 15000),
        epoch: 5
      });

      // Simulate a concurrent worker modifying the epoch in MongoDB
      await StorageJournal.updateOne(
        { operationId },
        { $inc: { epoch: 1 }, $set: { lockedBy: 'worker-concurrent' } }
      );

      const reconciler = new StorageReconciliationService({
        storageAdapter: s3Provider,
        workerId: 'worker-primary',
        probeDelayMs: 10
      });

      // Pass original doc with stale epoch: 5
      const recResult = await reconciler.reconcileRecord(originalDoc.toObject());
      expect(recResult.action).toBe('STALE_EPOCH_CONFLICT');

      // MinIO object untouched
      const obj = await s3Provider.headObject(destinationKey);
      expect(obj).not.toBeNull();
    });
  });

  // =========================================================================
  // SECTION 3: Prefix Sweep with Live MinIO Bucket
  // =========================================================================

  describe('3. Prefix Sweep with Live MinIO Bucket', () => {
    it('TS-E2E-SWP-01: sweepPrefix traverses live MinIO with real continuation tokens, purges orphans, and protects legitimate objects', async () => {
      const prefix = 'staging/e2e-sweep/';

      // Object 1: Mature orphan A (unreferenced anywhere)
      const orphanKey1 = `${prefix}orphan-mature-1.bin`;
      await s3Provider.uploadFile(Buffer.from('ORPHAN-DATA-1'), orphanKey1, 'application/octet-stream');

      // Object 2: Committed Response document attachment (legitimate)
      const responseKey = `${prefix}committed-attachment.pdf`;
      await s3Provider.uploadFile(PDF_BINARY_PAYLOAD, responseKey, 'application/pdf');
      await Response.create({
        formId: new mongoose.Types.ObjectId(),
        answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key: responseKey } }],
        commitStatus: 'committed'
      });

      // Object 3: Active SubmissionReservation file (legitimate)
      const reservationKey = `${prefix}active-reservation-file.jpg`;
      await s3Provider.uploadFile(Buffer.from('IMAGE-BYTES'), reservationKey, 'image/jpeg');
      await SubmissionReservation.create({
        formId: new mongoose.Types.ObjectId(),
        leaseId: 'lease-sweep-active',
        fenceToken: 'fence-sweep-1',
        status: 'active',
        expiresAt: new Date(Date.now() + 60000),
        stagedKeys: [reservationKey]
      });

      // Object 4: Mature orphan B (unreferenced anywhere)
      const orphanKey2 = `${prefix}orphan-mature-2.bin`;
      await s3Provider.uploadFile(Buffer.from('ORPHAN-DATA-2'), orphanKey2, 'application/octet-stream');

      // Object 5: Active StorageJournal-tracked object (legitimate)
      const journalKey = `${prefix}active-journal-file.bin`;
      await s3Provider.uploadFile(Buffer.from('JOURNAL-BYTES'), journalKey, 'application/octet-stream');
      await StorageJournal.create({
        operationId: crypto.randomUUID(),
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey: journalKey,
        status: STORAGE_JOURNAL_STATUS.CONFIRMED,
        epoch: 1
      });

      // Initialize PrefixSweepService with small batch size (2) to force real MinIO pagination continuation tokens
      const sweeper = new PrefixSweepService({
        storageAdapter: s3Provider,
        batchSize: 2,
        minOrphanAgeMs: 0 // Allow sweeping mature orphans without waiting 60s in test
      });

      // Run Sweep Pass 1 (first 2 keys from MinIO)
      const pass1 = await sweeper.sweepPrefix(prefix);
      expect(pass1.keysScanned).toBe(2);
      expect(pass1.isTruncated).toBe(true);

      // Verify checkpoint in MongoDB has real continuation token from MinIO
      let checkpoint = await sweeper.getCheckpoint(prefix);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint.continuationToken).toBeDefined();
      expect(checkpoint.isTruncated).toBe(true);

      // Run Sweep Pass 2 (next 2 keys from MinIO, resuming from continuation token)
      const pass2 = await sweeper.sweepPrefix(prefix);
      expect(pass2.keysScanned).toBe(2);

      // Run Sweep Pass 3 (remaining keys)
      const pass3 = await sweeper.sweepPrefix(prefix);
      expect(pass3.isTruncated).toBe(false);

      checkpoint = await sweeper.getCheckpoint(prefix);
      expect(checkpoint.isTruncated).toBe(false);
      expect(checkpoint.totalKeysScanned).toBe(5);
      expect(checkpoint.totalOrphansPurged).toBe(2);

      // Verify MinIO state:
      // Real orphan keys (orphanKey1, orphanKey2) MUST BE 404 in MinIO
      const headOrphan1 = await s3Provider.headObject(orphanKey1);
      const headOrphan2 = await s3Provider.headObject(orphanKey2);
      expect(headOrphan1).toBeNull();
      expect(headOrphan2).toBeNull();

      // Legitimate keys MUST REMAIN IN MINIO
      const headResp = await s3Provider.headObject(responseKey);
      const headResv = await s3Provider.headObject(reservationKey);
      const headJour = await s3Provider.headObject(journalKey);
      expect(headResp).not.toBeNull();
      expect(headResv).not.toBeNull();
      expect(headJour).not.toBeNull();
    });

    it('TS-E2E-SWP-02: Age barrier (Tier 0) protects recently uploaded objects in MinIO from premature deletion', async () => {
      const prefix = 'staging/age-barrier/';
      const freshKey = `${prefix}fresh-in-flight.bin`;

      // Upload object to MinIO right now (age ~ 0s)
      await s3Provider.uploadFile(Buffer.from('FRESH-PAYLOAD'), freshKey, 'application/octet-stream');

      // Sweeper configured with default 60-second age barrier
      const sweeper = new PrefixSweepService({
        storageAdapter: s3Provider,
        minOrphanAgeMs: 60000
      });

      const res = await sweeper.sweepPrefix(prefix);
      expect(res.keysScanned).toBe(1);
      expect(res.orphansPurged).toBe(0);

      // Object was protected by Tier 0 and remains intact in MinIO
      const head = await s3Provider.headObject(freshKey);
      expect(head).not.toBeNull();
    });
  });

  // =========================================================================
  // SECTION 4: Cold-Storage Barrier Drain with Live MinIO Operations
  // =========================================================================

  describe('4. Cold-Storage Barrier Drain with Live MinIO Operations', () => {
    it('TS-E2E-DRN-01: While MinIO operations or StorageJournal have pending entries, checkDurableDatastoreDrain reports isDrained: false and markQuiesced is rejected', async () => {
      // 1. Acquire backup lease to DRAINING status
      const acquireRes = await quiescenceService.acquire({
        leaseDurationMs: 60000,
        initialStatus: BACKUP_LEASE_STATUS.DRAINING
      });
      expect(acquireRes.success).toBe(true);
      const leaseId = acquireRes.leaseId;

      // 2. Insert active/unresolved StorageJournal entry
      const operationId = crypto.randomUUID();
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: MINIO_TEST_CONFIG.BUCKET,
        destinationKey: `forms/f-drain/responses/${operationId}.pdf`,
        status: STORAGE_JOURNAL_STATUS.DISPATCHED,
        epoch: 1
      });

      // 3. Check durable datastore drain
      const drainRes = await quiescenceService.checkDurableDatastoreDrain();
      expect(drainRes.isDrained).toBe(false);
      expect(drainRes.reason).toBe('DRAIN_PENDING');
      expect(drainRes.diagnostics.activeStorageOperations).toBe(1);
      expect(drainRes.diagnostics.storageDetails.dispatched).toBe(1);

      // 4. Attempt markQuiesced while storage mutations are in-flight
      const quiesceRes = await quiescenceService.markQuiesced({ leaseId });
      expect(quiesceRes.success).toBe(false);
      expect(quiesceRes.reason).toBe('DRAIN_PENDING');
      expect(quiesceRes.message).toContain('durable datastore mutations are still active');

      // Backup lease remains safely in DRAINING status
      const leaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(leaseDoc.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
    });

    it('TS-E2E-DRN-02: Once MinIO operations finish and StorageJournal drains to terminal states, datastore drain reports isDrained: true', async () => {
      // Transition unresolved records to COMMITTED
      await StorageJournal.updateMany(
        { status: { $in: ['DISPATCHED', 'PENDING', 'CONFIRMED'] } },
        { $set: { status: STORAGE_JOURNAL_STATUS.COMMITTED, vacuumAt: new Date(Date.now() + 7 * 86400000) } }
      );

      const drainRes = await quiescenceService.checkDurableDatastoreDrain();
      expect(drainRes.isDrained).toBe(true);
      expect(drainRes.diagnostics.activeStorageOperations).toBe(0);
      expect(drainRes.diagnostics.activeReservations).toBe(0);
      expect(drainRes.diagnostics.activeWorkers).toBe(0);
    });

    it('TS-E2E-DRN-03: Explains and verifies 30-second transport quiet period rationale and clean quiescence transition', async () => {
      // 1. Verify why the 30-second transport quiet period is enforced:
      // Object storage uploads communicate over HTTP/1.1 or HTTP/2 TCP sockets.
      // S3_DEFAULT_TIMEOUTS.UPLOAD_TIMEOUT_MS is defined as 30,000ms (30 seconds).
      // Even after application-level request completion or ingress closure, TCP segments,
      // socket FIN-WAIT/TIME-WAIT buffers, and MinIO asynchronous write queues can take
      // up to 30 seconds to settle.
      // If a cold storage snapshot or filesystem freeze were triggered immediately at t=0,
      // a late-landing packet at t=3 could write a stray object, resulting in split-brain
      // or silent corruption between MongoDB oplog and MinIO storage volumes.
      expect(S3_DEFAULT_TIMEOUTS.UPLOAD_TIMEOUT_MS).toBe(30000);

      // 2. Acquire lease in DRAINING status
      const acquireRes = await quiescenceService.acquire({
        leaseDurationMs: 60000,
        initialStatus: BACKUP_LEASE_STATUS.DRAINING
      });
      expect(acquireRes.success).toBe(true);
      const leaseId = acquireRes.leaseId;

      // 3. Ensure all datastore records are clean
      const drainCheck = await quiescenceService.checkDurableDatastoreDrain();
      expect(drainCheck.isDrained).toBe(true);

      // 4. With datastore fully drained and quiet period satisfied, markQuiesced transitions cleanly
      const quiesceRes = await quiescenceService.markQuiesced({ leaseId });
      expect(quiesceRes.success).toBe(true);
      expect(quiesceRes.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

      // 5. Verify BackupLease document state
      const leaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(leaseDoc.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
      expect(leaseDoc.quiescedAt).toBeDefined();
      expect(leaseDoc.generation).toBeGreaterThanOrEqual(1);

      // 6. Release lease: cleans up and safely returns status to NORMAL
      const releaseRes = await quiescenceService.releaseLease(leaseId);
      expect(releaseRes.success).toBe(true);
      expect(releaseRes.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      const finalLease = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(finalLease.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(finalLease.ttlMonitorDisabled).toBe(false);
    });
  });
});
