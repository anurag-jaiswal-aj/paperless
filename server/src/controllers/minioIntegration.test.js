import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import { CreateMultipartUploadCommand } from '@aws-sdk/client-s3';
import {
  MINIO_TEST_CONFIG,
  startMinioTestContainer,
  emptyTestBucket,
  createTestS3Client,
  createIsolatedTestStorageProvider,
  setupTestStorageEnv
} from '../testUtils/minioTestHelper.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import { StorageReconciliationService } from '../services/storageReconciliationService.js';
import { PrefixSweepService } from '../services/prefixSweepService.js';
import {
  checkDurableDatastoreDrain,
  markQuiesced,
  acquireLease,
  releaseLease,
  BACKUP_LEASE_STATUS
} from '../services/quiescenceService.js';
import BackupLease from '../models/backupLease.js';
import AppWorker from '../models/appWorker.js';
import SubmissionReservation from '../models/submissionReservation.js';
import Response from '../models/response.js';

describe('Phase 2D.1K.9 (Phase K-F): Live MinIO Integration & Remote Storage Failure Suite', () => {
  let replSet;
  let testProvider;
  let s3Client;
  let restoreEnv;

  beforeAll(async () => {
    // 1. Ensure ephemeral MinIO container is healthy and test bucket exists
    await startMinioTestContainer({ ensureBucket: true });

    // 2. Setup environment variables so S3StorageProvider and services connect to MinIO
    const envSetup = setupTestStorageEnv(MINIO_TEST_CONFIG);
    restoreEnv = envSetup.restoreEnv;

    // 3. Start MongoDB Replica Set and initialize collections
    replSet = await startReplSet([StorageJournal, BackupLease, AppWorker, SubmissionReservation, Response]);

    // 4. Create isolated S3 test client and S3StorageProvider
    s3Client = createTestS3Client(MINIO_TEST_CONFIG);
    testProvider = createIsolatedTestStorageProvider(MINIO_TEST_CONFIG);
  }, 45000);

  afterAll(async () => {
    try {
      await emptyTestBucket(MINIO_TEST_CONFIG.BUCKET);
    } catch (_err) {
      // Ignored during teardown
    }
    if (s3Client) await s3Client.destroy();
    if (testProvider) await testProvider.destroy();
    if (restoreEnv) restoreEnv();
    await stopReplSet(replSet);
  }, 30000);

  beforeEach(async () => {
    await emptyTestBucket(MINIO_TEST_CONFIG.BUCKET);
    await StorageJournal.deleteMany({});
    await BackupLease.deleteMany({});
    await AppWorker.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await Response.deleteMany({});
  });

  // =========================================================================
  // SUITE 1: Live MinIO S3 Provider Conformance
  // =========================================================================
  describe('Suite 1: Live MinIO S3 Provider Conformance', () => {
    it('KF-PROV-01: Uploads buffer with custom metadata, verifies ETag and HeadObject', async () => {
      const key = `uploads/kf-test-${crypto.randomUUID()}.txt`;
      const content = Buffer.from('Live MinIO Integration Payload for K-F');
      const metadata = { 'x-correlation-id': 'corr-kf-01', 'x-author': 'lead-coordinator' };

      const uploadRes = await testProvider.uploadFile(content, key, 'text/plain', {
        metadata,
        returnMetadata: true
      });

      expect(uploadRes).toHaveProperty('key', key);
      expect(uploadRes).toHaveProperty('etag');
      expect(uploadRes.etag).toMatch(/^"[a-f0-9]+"/);

      const head = await testProvider.headObject(key);
      expect(head).not.toBeNull();
      expect(head.contentLength).toBe(content.length);
      expect(head.contentType).toBe('text/plain');
      expect(head.etag).toBe(uploadRes.etag);
      expect(head.metadata['x-correlation-id']).toBe('corr-kf-01');
      expect(head.metadata['x-author']).toBe('lead-coordinator');
    });

    it('KF-PROV-02: Downloads file stream, verifies content byte-for-byte', async () => {
      const key = `streams/kf-stream-${crypto.randomUUID()}.bin`;
      const payload = crypto.randomBytes(4096);

      await testProvider.uploadFile(payload, key, 'application/octet-stream');

      const streamRes = await testProvider.getFileStream(key);
      expect(streamRes.contentType).toBe('application/octet-stream');
      expect(streamRes.contentLength).toBe(4096);

      const chunks = [];
      for await (const chunk of streamRes.stream) {
        chunks.push(chunk);
      }
      const downloadedBuffer = Buffer.concat(chunks);
      expect(downloadedBuffer.equals(payload)).toBe(true);
    });

    it('KF-PROV-03: HeadObject on non-existent key returns null without throwing', async () => {
      const nonExistentKey = `ghosts/non-existent-${crypto.randomUUID()}.dat`;
      const head = await testProvider.headObject(nonExistentKey);
      expect(head).toBeNull();
    });

    it('KF-PROV-04: Single-file deletion removes object, subsequent HeadObject returns null', async () => {
      const key = `delete-single/kf-${crypto.randomUUID()}.txt`;
      await testProvider.uploadFile(Buffer.from('To be deleted'), key, 'text/plain');

      const beforeDelete = await testProvider.headObject(key);
      expect(beforeDelete).not.toBeNull();

      await testProvider.deleteFile(key);

      const afterDelete = await testProvider.headObject(key);
      expect(afterDelete).toBeNull();
    });

    it('KF-PROV-05: Batch deletion removes multiple keys in one call with zero failures', async () => {
      const keys = [
        `batch-del/file1-${crypto.randomUUID()}.txt`,
        `batch-del/file2-${crypto.randomUUID()}.txt`,
        `batch-del/file3-${crypto.randomUUID()}.txt`
      ];

      for (const k of keys) {
        await testProvider.uploadFile(Buffer.from(`Data for ${k}`), k, 'text/plain');
      }

      const batchRes = await testProvider.deleteFiles(keys);
      expect(batchRes.success).toBe(true);
      expect(batchRes.failedKeys).toHaveLength(0);
      expect(batchRes.deletedKeys).toHaveLength(3);

      for (const k of keys) {
        const head = await testProvider.headObject(k);
        expect(head).toBeNull();
      }
    });

    it('KF-PROV-06: Pagination: lists 5 objects with maxKeys: 2 across continuation tokens', async () => {
      const prefix = `paginate-test-${crypto.randomUUID().slice(0, 8)}/`;
      const uploadedKeys = [];

      for (let i = 1; i <= 5; i++) {
        const k = `${prefix}item-${i.toString().padStart(2, '0')}.txt`;
        uploadedKeys.push(k);
        await testProvider.uploadFile(Buffer.from(`Item ${i}`), k, 'text/plain');
      }

      // Page 1: maxKeys 2
      const page1 = await testProvider.listObjectsByPrefix(prefix, { maxKeys: 2 });
      expect(page1.keys).toHaveLength(2);
      expect(page1.isTruncated).toBe(true);
      expect(page1.nextContinuationToken).toBeDefined();

      // Page 2: maxKeys 2
      const page2 = await testProvider.listObjectsByPrefix(prefix, {
        maxKeys: 2,
        continuationToken: page1.nextContinuationToken
      });
      expect(page2.keys).toHaveLength(2);
      expect(page2.isTruncated).toBe(true);
      expect(page2.nextContinuationToken).toBeDefined();

      // Page 3: maxKeys 2
      const page3 = await testProvider.listObjectsByPrefix(prefix, {
        maxKeys: 2,
        continuationToken: page2.nextContinuationToken
      });
      expect(page3.keys).toHaveLength(1);
      expect(page3.isTruncated).toBe(false);

      const allDiscovered = [...page1.keys, ...page2.keys, ...page3.keys];
      expect(allDiscovered).toEqual(uploadedKeys);
    });

    it('KF-PROV-07: Multipart upload listing and abort reclaims incomplete parts', async () => {
      const prefix = 'multipart-demo/';
      const targetKey = `${prefix}large-upload-${crypto.randomUUID()}.bin`;

      // 1. Initiate multipart upload
      const createResp = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: MINIO_TEST_CONFIG.BUCKET,
          Key: targetKey
        })
      );
      const uploadId = createResp.UploadId;
      expect(uploadId).toBeDefined();

      // 2. Verify listMultipartUploads finds the open upload
      const listBefore = await testProvider.listMultipartUploads();
      const matching = listBefore.uploads.find((u) => u.key === targetKey && u.uploadId === uploadId);
      expect(matching).toBeDefined();

      // 3. Abort the multipart upload
      const abortOk = await testProvider.abortMultipartUpload(targetKey, uploadId);
      expect(abortOk).toBe(true);

      // 4. Verify listMultipartUploads no longer includes it
      const listAfter = await testProvider.listMultipartUploads();
      const stillPresent = listAfter.uploads.find((u) => u.uploadId === uploadId);
      expect(stillPresent).toBeUndefined();

      // 5. Abort is idempotent
      const secondAbort = await testProvider.abortMultipartUpload(targetKey, uploadId);
      expect(secondAbort).toBe(true);
    });

    it('KF-PROV-08: Bucket reachability probe reports connected status', async () => {
      const check = await testProvider.checkBucketAccess();
      expect(check.ok).toBe(true);
      expect(check.status).toBe('connected');
    });
  });

  // =========================================================================
  // SUITE 2: Remote Race & Fault Injection Scenarios A–E
  // =========================================================================
  describe('Suite 2: Remote Race & Fault Injection Scenarios A through E', () => {
    it('KF-RACE-01 (Scenario A): Late PUT after DELETE (Cancellation Fallacy) creates orphan; sweepPrefix purges it', async () => {
      // Cancellation Fallacy:
      // Client starts PUT. Client cancels or reservation times out. Application sends DELETE.
      // Remote S3/MinIO stream finishes AFTER the DELETE, committing the object.
      const orphanKey = `late-orphan/orphan-${crypto.randomUUID()}.bin`;
      const payload = Buffer.from('Late PUT object payload landing after compensation');

      // 1. Simulate compensation issuing delete before the PUT lands
      await testProvider.deleteFile(orphanKey);

      // 2. Late PUT commits
      await testProvider.uploadFile(payload, orphanKey, 'application/octet-stream');

      // 3. Object exists in MinIO
      const headBefore = await testProvider.headObject(orphanKey);
      expect(headBefore).not.toBeNull();

      // 4. Verify UUID isolation: No Response in MongoDB references this orphanKey
      const matchingResponse = await Response.findOne({ 'answers.files.key': orphanKey });
      expect(matchingResponse).toBeNull();

      // 5. PrefixSweepService sweeps the prefix with a minOrphanAgeMs=0 (mature)
      const sweeper = new PrefixSweepService({
        storageAdapter: testProvider,
        minOrphanAgeMs: 0 // Treat all unreferenced objects as mature orphans
      });

      const sweepResult = await sweeper.sweepPrefix('late-orphan/');
      expect(sweepResult.orphansPurged).toBeGreaterThanOrEqual(1);

      // 6. Verify orphan is purged from MinIO
      const headAfter = await testProvider.headObject(orphanKey);
      expect(headAfter).toBeNull();
    });

    it('KF-RACE-02 (Scenario B): PUT completes before DELETE (Normal Order)', async () => {
      const key = `normal-order/obj-${crypto.randomUUID()}.txt`;
      await testProvider.uploadFile(Buffer.from('Clean payload'), key, 'text/plain');

      const head1 = await testProvider.headObject(key);
      expect(head1).not.toBeNull();

      await testProvider.deleteFile(key);

      const head2 = await testProvider.headObject(key);
      expect(head2).toBeNull();
    });

    it('KF-RACE-03 (Scenario C): Ambiguous DELETE recovered by StorageReconciliationService', async () => {
      const operationId = `op_del_ambig_${crypto.randomUUID().slice(0, 8)}`;
      const destinationKey = `ambig-del/file-${crypto.randomUUID()}.txt`;

      // Object was created in MinIO
      await testProvider.uploadFile(Buffer.from('Content to be ambiguously deleted'), destinationKey, 'text/plain');

      // StorageJournal records an AMBIGUOUS delete operation whose quarantine has expired
      const expiredQuarantine = new Date(Date.now() - 1000);
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        destinationKey,
        quarantinedUntil: expiredQuarantine,
        epoch: 1
      });

      const reconciler = new StorageReconciliationService({
        storageAdapter: testProvider,
        workerId: 'worker_c_test'
      });

      const outcome = await reconciler.reconcileRecord({ operationId });
      expect(outcome.action).toBe('CONFIRMED');

      // Verify object deleted from MinIO
      const head = await testProvider.headObject(destinationKey);
      expect(head).toBeNull();

      // Verify StorageJournal record marked CONFIRMED
      const journalDoc = await StorageJournal.findOne({ operationId });
      expect(journalDoc.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
    });

    it('KF-RACE-04 (Scenario D): Delayed PUT across process restart safely reconciled or purged', async () => {
      const operationId = `op_restart_${crypto.randomUUID().slice(0, 8)}`;
      const destinationKey = `restart-recovery/file-${crypto.randomUUID()}.txt`;

      // 1. Process A writes PENDING journal entry and crashes midway
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.PENDING,
        destinationKey,
        payloadHash: 'hash-abc',
        payloadSize: 100,
        epoch: 1
      });

      // Object was actually written to MinIO by the remote storage stream before crash
      await testProvider.uploadFile(Buffer.from('Orphaned by crash'), destinationKey, 'text/plain');

      // 2. Process B (new worker) boots up and runs reconciliation
      const reconciler = new StorageReconciliationService({
        storageAdapter: testProvider,
        workerId: 'worker_new_proc'
      });

      // No Response document exists in MongoDB referencing this destinationKey, so it must be compensated
      const outcome = await reconciler.reconcileRecord({ operationId });
      expect(outcome.action).toBe('COMPENSATED');

      // Verify MinIO object was removed
      const head = await testProvider.headObject(destinationKey);
      expect(head).toBeNull();

      const journalDoc = await StorageJournal.findOne({ operationId });
      expect(journalDoc.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
    });

    it('KF-RACE-05 (Scenario E): Multi-pass prefix sweep protects young objects and purges mature orphans', async () => {
      const prefix = `multi-pass-${crypto.randomUUID().slice(0, 8)}/`;
      const key = `${prefix}young-then-mature-${crypto.randomUUID()}.txt`;

      await testProvider.uploadFile(Buffer.from('Pass test'), key, 'text/plain');

      // Pass 1: High minOrphanAgeMs (60000ms = 60s). Object is just created (young).
      const sweeperYoung = new PrefixSweepService({
        storageAdapter: testProvider,
        minOrphanAgeMs: 60000
      });

      const pass1 = await sweeperYoung.sweepPrefix(prefix);
      expect(pass1.orphansPurged).toBe(0);

      // Verify object still in MinIO
      const headPass1 = await testProvider.headObject(key);
      expect(headPass1).not.toBeNull();

      // Pass 2: minOrphanAgeMs = 0 (mature threshold). Object is classified as orphan and purged.
      const sweeperMature = new PrefixSweepService({
        storageAdapter: testProvider,
        minOrphanAgeMs: 0
      });

      const pass2 = await sweeperMature.sweepPrefix(prefix);
      expect(pass2.orphansPurged).toBe(1);

      // Verify object deleted
      const headPass2 = await testProvider.headObject(key);
      expect(headPass2).toBeNull();
    });
  });

  // =========================================================================
  // SUITE 3: Stale Worker Takeover & Fencing Verification
  // =========================================================================
  describe('Suite 3: Stale Worker Takeover & Monotonic Lease Fencing', () => {
    it('KF-FENCE-01: Stale worker with expired lease cannot clobber record or mutate storage post-takeover', async () => {
      const operationId = `op_fence_${crypto.randomUUID().slice(0, 8)}`;
      const destinationKey = `fence-test/file-${crypto.randomUUID()}.txt`;

      await testProvider.uploadFile(Buffer.from('Fencing object'), destinationKey, 'text/plain');

      // Worker 1 acquires lock, but lock expires
      const pastLock = new Date(Date.now() - 5000);
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        destinationKey,
        lockedBy: 'worker_stale',
        lockedUntil: pastLock,
        epoch: 1
      });

      // Worker 2 takes over the expired lock via atomic Compare-And-Swap
      const claimRes = await StorageJournal.claimForReconciliation(operationId, 'worker_successor');
      expect(claimRes).not.toBeNull();
      expect(claimRes.epoch).toBe(2);
      expect(claimRes.lockedBy).toBe('worker_successor');

      const worker2 = new StorageReconciliationService({
        storageAdapter: testProvider,
        workerId: 'worker_successor'
      });

      // Stale Worker 1 attempts to reset quarantine or mutate record with old epoch
      const staleReset = await StorageJournal.updateOne(
        {
          operationId,
          status: STORAGE_JOURNAL_STATUS.RECONCILING,
          epoch: 1, // Stale epoch
          lockedBy: 'worker_stale'
        },
        {
          $set: { status: STORAGE_JOURNAL_STATUS.AMBIGUOUS }
        }
      );
      expect(staleReset.matchedCount).toBe(0);

      // Verify Worker 2 safely finishes reconciliation
      const outcome = await worker2.reconcileRecord(claimRes);
      expect(outcome.action).toBe('COMPENSATED');

      const head = await testProvider.headObject(destinationKey);
      expect(head).toBeNull();
    });

    it('KF-FENCE-02: Dual-HEAD stability probe verifies object persistence on live MinIO', async () => {
      const key = `dual-head/stable-${crypto.randomUUID()}.txt`;
      await testProvider.uploadFile(Buffer.from('Dual head stable'), key, 'text/plain');

      const head1 = await testProvider.headObject(key);
      expect(head1).not.toBeNull();

      // Delay 10ms for stability probe simulation
      await new Promise((r) => setTimeout(r, 10));

      const head2 = await testProvider.headObject(key);
      expect(head2).not.toBeNull();
      expect(head2.etag).toBe(head1.etag);
      expect(head2.contentLength).toBe(head1.contentLength);
    });
  });

  // =========================================================================
  // SUITE 4: Cold-Storage Barrier Drain with Live MinIO Operations
  // =========================================================================
  describe('Suite 4: Cold-Storage Barrier Drain with Live MinIO Operations', () => {
    it('KF-BARRIER-01: Active MinIO StorageJournal record strictly blocks quiescence drain', async () => {
      // 1. Acquire backup lease in DRAINING status
      const lease = await acquireLease({
        ttlMs: 60000,
        drainTimeoutMs: 1000
      });
      expect(lease.success).toBe(true);
      const leaseId = lease.leaseId;

      // 2. Insert active StorageJournal record (simulating in-flight MinIO upload)
      await StorageJournal.create({
        operationId: `op_barrier_${crypto.randomUUID().slice(0, 8)}`,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        status: STORAGE_JOURNAL_STATUS.PENDING,
        destinationKey: 'barrier/file.txt',
        epoch: 1
      });

      // 3. Durable datastore drain check must report isDrained: false
      const drainCheck = await checkDurableDatastoreDrain();
      expect(drainCheck.isDrained).toBe(false);
      expect(drainCheck.diagnostics.activeStorageOperations).toBe(1);

      // 4. markQuiesced must reject transition
      const quiesceRes = await markQuiesced(leaseId);
      expect(quiesceRes.success).toBe(false);
      expect(quiesceRes.reason).toBe('DRAIN_PENDING');

      // Cleanup lease
      await releaseLease(leaseId);
    });

    it('KF-BARRIER-02: Complete drain with empty StorageJournal allows clean quiescence transition', async () => {
      // 1. Acquire lease
      const lease = await acquireLease({
        ttlMs: 60000,
        drainTimeoutMs: 1000
      });
      expect(lease.success).toBe(true);
      const leaseId = lease.leaseId;

      // Ensure no active storage or workers
      await StorageJournal.deleteMany({});
      await AppWorker.deleteMany({});
      await SubmissionReservation.deleteMany({});

      // 2. Check drain
      const drainCheck = await checkDurableDatastoreDrain();
      expect(drainCheck.isDrained).toBe(true);

      // 3. markQuiesced succeeds
      const quiesceRes = await markQuiesced(leaseId);
      expect(quiesceRes.success).toBe(true);
      expect(quiesceRes.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

      // 4. Release lease
      await releaseLease(leaseId);
    });
  });
});
