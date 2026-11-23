/**
 * remoteRaceFaultInjection.test.js
 *
 * Phase 2D.1K.9 (Phase K-F): Remote Race, Delay & Fault Injection Test Suite
 *
 * Implements controlled deterministic test scenarios for the 5 critical race & fault vectors:
 * 1. Scenario A: PUT completes after DELETE (The Cancellation Fallacy)
 * 2. Scenario B: PUT completes before DELETE (Standard Clean Deletion)
 * 3. Scenario C: DELETE completes ambiguously (Network Drops, Timeouts, 500s)
 * 4. Scenario D: Delayed PUT across process restart (Crash Recovery Convergence)
 * 5. Scenario E: Repeated prefix sweeps discovering late objects (Multi-pass age barrier)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import Form from '../models/form.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import DeletionCleanupJob from '../models/deletionCleanupJob.js';
import AppWorker from '../models/appWorker.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';

import storageService from '../services/StorageService.js';
import s3Provider from '../services/S3StorageProvider.js';
import { StorageReconciliationService } from '../services/storageReconciliationService.js';
import { PrefixSweepService } from '../services/prefixSweepService.js';

/**
 * Deterministic Fault Injection Storage Adapter
 * Simulates in-flight delays, network drops, dual-HEAD drift, and out-of-order execution.
 */
class DeterministicFaultStorageAdapter {
  constructor() {
    this.store = new Map();
    this.history = [];
    this.hooks = {
      beforeUpload: null,
      duringUpload: null,
      beforeDelete: null,
      onHead: null
    };
    this.headCounts = new Map();
  }

  reset() {
    this.store.clear();
    this.history = [];
    this.hooks = {
      beforeUpload: null,
      duringUpload: null,
      beforeDelete: null,
      onHead: null
    };
    this.headCounts.clear();
  }

  async uploadFile(streamOrBuffer, key, mimeType, options = {}) {
    this.history.push({ op: 'upload', key, options });

    if (typeof this.hooks.beforeUpload === 'function') {
      await this.hooks.beforeUpload(key, options);
    }

    let buffer;
    if (Buffer.isBuffer(streamOrBuffer)) {
      buffer = streamOrBuffer;
    } else {
      buffer = Buffer.from(streamOrBuffer || '');
    }

    if (options.abortSignal?.aborted || options.signal?.aborted) {
      const err = new Error('Upload aborted by signal');
      err.name = 'AbortError';
      throw err;
    }

    if (typeof this.hooks.duringUpload === 'function') {
      await this.hooks.duringUpload(key, { buffer, options });
    }

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const etag = `"${crypto.createHash('md5').update(buffer).digest('hex')}"`;

    const entry = {
      buffer,
      mime: mimeType,
      size: buffer.length,
      hash,
      etag,
      metadata: options.metadata || {},
      lastModified: options.lastModified || new Date()
    };

    this.store.set(key, entry);
    return options.returnMetadata ? { key, etag } : key;
  }

  async deleteFile(key, options = {}) {
    this.history.push({ op: 'delete', key, options });
    if (typeof this.hooks.beforeDelete === 'function') {
      await this.hooks.beforeDelete(key, options);
    }
    this.store.delete(key);
    return Promise.resolve();
  }

  async deleteFiles(keys, options = {}) {
    for (const k of keys) {
      await this.deleteFile(k, options);
    }
    return { success: true, deletedKeys: keys, failedKeys: [], totalRequested: keys.length };
  }

  async headObject(key, options = {}) {
    this.history.push({ op: 'head', key });
    if (typeof this.hooks.onHead === 'function') {
      await this.hooks.onHead(key, options);
    }
    const count = (this.headCounts.get(key) || 0) + 1;
    this.headCounts.set(key, count);

    const obj = this.store.get(key);
    if (!obj) {
      const err = new Error('NoSuchKey');
      err.name = 'NotFound';
      err.statusCode = 404;
      throw err;
    }

    return {
      ContentLength: obj.size,
      ETag: obj.etag,
      LastModified: obj.lastModified,
      Metadata: obj.metadata
    };
  }

  async listObjectsByPrefix(prefix) {
    const keys = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        keys.push(k);
      }
    }
    return {
      keys,
      isTruncated: false,
      keyCount: keys.length
    };
  }
}

describe('Phase 2D.1K.9 (Phase K-F): Remote Race, Delay & Fault Injection Suite', () => {
  let mongod;
  let faultAdapter;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());

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

    faultAdapter = new DeterministicFaultStorageAdapter();
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SCENARIO A: PUT Completes After DELETE (The Cancellation Fallacy)
  // =========================================================================
  describe('Scenario A: PUT completes after DELETE (The Cancellation Fallacy)', () => {
    it('A1: Late PUT completing after DELETE creates orphan in S3, but UUIDv4 keys guarantee isolation from subsequent responses', async () => {
      const formId = new mongoose.Types.ObjectId();
      const leaseId1 = `lease_${uuidv4().slice(0, 8)}`;
      const fileId1 = uuidv4();
      const safeExt = 'pdf';
      const stagingKey1 = `staging/forms/${formId}/${leaseId1}/${fileId1}.${safeExt}`;
      const payload1 = Buffer.from('Orphan File Content That Landed Late');

      // Controlled delay barrier: in-flight PUT will be delayed until after DELETE completes
      let resolvePutStream;
      const putStreamPromise = new Promise((resolve) => {
        resolvePutStream = resolve;
      });

      faultAdapter.hooks.duringUpload = async (key) => {
        if (key === stagingKey1) {
          // Pause upload simulation until client aborts and issues delete
          await putStreamPromise;
        }
      };

      // 1. Client initiates PUT stream for file 1
      const uploadPromise = faultAdapter.uploadFile(payload1, stagingKey1, 'application/pdf');

      // 2. Client aborts/cancels reservation while PUT is in flight
      // Application issues DELETE to cancel
      await faultAdapter.deleteFile(stagingKey1);

      // Verify that at this exact instant, S3 store does not have the object
      expect(faultAdapter.store.has(stagingKey1)).toBe(false);

      // 3. S3 server-side PUT completes late (stream finishes committing)
      resolvePutStream();
      await uploadPromise;

      // Result: Orphan blob now exists in S3!
      expect(faultAdapter.store.has(stagingKey1)).toBe(true);

      // 4. Verify Paperless survival aspect (a):
      // A subsequent user submits a response to the same form and question.
      // Every submission generates an independent UUIDv4 key.
      const leaseId2 = `lease_${uuidv4().slice(0, 8)}`;
      const fileId2 = uuidv4();
      const stagingKey2 = `staging/forms/${formId}/${leaseId2}/${fileId2}.${safeExt}`;
      const finalKey2 = `forms/${formId}/responses/${fileId2}.${safeExt}`;
      const payload2 = Buffer.from('Legitimate User Response Content');

      await faultAdapter.uploadFile(payload2, stagingKey2, 'application/pdf');

      // Save Response document referencing legitimate key 2
      const responseDoc = await Response.create({
        formId,
        answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key: finalKey2 } }],
        commitStatus: 'committed'
      });

      // Assert UUIDv4 keys completely isolate the responses:
      // The orphan key1 and legitimate key2 are mathematically distinct
      expect(stagingKey1).not.toBe(stagingKey2);
      expect(stagingKey1).not.toBe(finalKey2);

      // The legitimate response references ONLY key 2
      const fetchedResponse = await Response.findById(responseDoc._id).lean();
      expect(fetchedResponse.answers[0].value.key).toBe(finalKey2);

      // S3 contains both keys, but user data is completely uncorrupted
      expect(faultAdapter.store.has(stagingKey1)).toBe(true);
      expect(faultAdapter.store.has(stagingKey2)).toBe(true);
      expect(faultAdapter.store.get(stagingKey2).buffer.toString()).toBe('Legitimate User Response Content');
    });

    it('A2: Reverse prefix sweep discovers unreferenced late orphan and purges it once age exceeds barrier', async () => {
      const formId = new mongoose.Types.ObjectId();
      const leaseId = `lease_${uuidv4().slice(0, 8)}`;
      const fileId = uuidv4();
      const orphanKey = `staging/forms/${formId}/${leaseId}/${fileId}.pdf`;

      // Seed late orphan in S3 whose age is older than the 60s barrier
      faultAdapter.store.set(orphanKey, {
        buffer: Buffer.from('Orphan File Content'),
        mime: 'application/pdf',
        size: 19,
        etag: '"orphan-etag"',
        metadata: {},
        lastModified: new Date(Date.now() - 75000) // 75 seconds old
      });

      const sweeper = new PrefixSweepService({
        storageAdapter: faultAdapter,
        minOrphanAgeMs: 60000 // 60s barrier
      });

      // Verify classification
      const classification = await sweeper.classifyCandidate(orphanKey, {
        lastModified: new Date(Date.now() - 75000)
      });
      expect(classification.isOrphan).toBe(true);
      expect(classification.reason).toBe('CONFIRMED_UNREFERENCED_ORPHAN');

      // Execute prefix sweep
      const sweepResult = await sweeper.sweepPrefix('staging/');
      expect(sweepResult.keysScanned).toBe(1);
      expect(sweepResult.orphansPurged).toBe(1);

      // Verify orphan was purged from S3
      expect(faultAdapter.store.has(orphanKey)).toBe(false);

      // Verify subsequent HEAD returns NotFound (404)
      await expect(faultAdapter.headObject(orphanKey)).rejects.toThrow('NoSuchKey');
    });
  });

  // =========================================================================
  // SCENARIO B: PUT Completes Before DELETE
  // =========================================================================
  describe('Scenario B: PUT completes before DELETE (Standard Clean Deletion)', () => {
    it('B1: Standard clean deletion removes object from S3 and transitions StorageJournal to CONFIRMED', async () => {
      const destinationKey = `forms/${uuidv4()}/responses/${uuidv4()}.pdf`;
      const payload = Buffer.from('Standard File Content');

      // 1. Upload file through StorageService with journal tracking
      vi.spyOn(s3Provider, 'uploadFile').mockImplementation(async (buf, path, mime, opts) => {
        return faultAdapter.uploadFile(buf, path, mime, opts);
      });
      vi.spyOn(s3Provider, 'deleteFile').mockImplementation(async (path, opts) => {
        return faultAdapter.deleteFile(path, opts);
      });
      vi.spyOn(s3Provider, 'headObject').mockImplementation(async (path, opts) => {
        try {
          return await faultAdapter.headObject(path, opts);
        } catch (err) {
          if (err.name === 'NotFound' || err.statusCode === 404) {
            return null;
          }
          throw err;
        }
      });

      const uploadOpId = uuidv4();
      await storageService.uploadFile(payload, destinationKey, 'application/pdf', {
        operationId: uploadOpId
      });

      // Verify PUT completed and is confirmed in StorageJournal
      const uploadJournal = await StorageJournal.findOne({ operationId: uploadOpId }).lean();
      expect(uploadJournal.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
      expect(faultAdapter.store.has(destinationKey)).toBe(true);

      // Verify HEAD returns exists: true with correct size
      const headBefore = await storageService.headObject(destinationKey);
      expect(headBefore.ContentLength).toBe(payload.length);

      // 2. Perform clean deletion
      const deleteOpId = uuidv4();
      await storageService.deleteFile(destinationKey, {
        operationId: deleteOpId
      });

      // Verify deletion confirmed in StorageJournal
      const deleteJournal = await StorageJournal.findOne({ operationId: deleteOpId }).lean();
      expect(deleteJournal.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
      expect(deleteJournal.type).toBe(STORAGE_OPERATION_TYPE.DELETE_OBJECT);

      // 3. Verify object is removed and subsequent HEAD returns exists: false (404)
      expect(faultAdapter.store.has(destinationKey)).toBe(false);
      const headAfter = await s3Provider.headObject(destinationKey);
      expect(headAfter).toBeNull();
    });
  });

  // =========================================================================
  // SCENARIO C: DELETE Completes Ambiguously
  // =========================================================================
  describe('Scenario C: DELETE completes ambiguously (Network Drops & Timeouts)', () => {
    it('C1: Network failure/timeout during DELETE marks StorageJournal AMBIGUOUS with quarantine barrier', async () => {
      const destinationKey = `forms/${uuidv4()}/responses/${uuidv4()}.pdf`;
      const operationId = uuidv4();

      // Seed S3 store with object
      faultAdapter.store.set(destinationKey, {
        buffer: Buffer.from('To be deleted'),
        size: 13,
        etag: '"etag-c1"',
        lastModified: new Date()
      });

      // Mock s3Provider.deleteFile to throw a network timeout
      vi.spyOn(s3Provider, 'deleteFile').mockRejectedValueOnce(
        Object.assign(new Error('S3 DELETE timed out after 15000ms'), { name: 'TimeoutError' })
      );

      // Attempt deletion via StorageService
      await expect(
        storageService.deleteFile(destinationKey, {
          operationId,
          quarantineMs: 40000
        })
      ).rejects.toThrow('S3 DELETE timed out');

      // Verify StorageJournal status is AMBIGUOUS
      const journalDoc = await StorageJournal.findOne({ operationId }).lean();
      expect(journalDoc.status).toBe(STORAGE_JOURNAL_STATUS.AMBIGUOUS);
      expect(journalDoc.destinationKey).toBe(destinationKey);
      expect(journalDoc.errorDetails).toContain('TimeoutError');
      expect(new Date(journalDoc.quarantinedUntil).getTime()).toBeGreaterThan(Date.now() + 35000);
    });

    it('C2: Reconciler resolves ambiguous delete when object was actually deleted remotely (Probe returns 404)', async () => {
      const destinationKey = `forms/${uuidv4()}/responses/${uuidv4()}.pdf`;
      const operationId = uuidv4();
      const past = new Date(Date.now() - 50000); // Quarantine expired

      // Journal recorded AMBIGUOUS
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
        bucket: 'paperless',
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil: past,
        epoch: 0
      });

      // S3 store does NOT have object (remote S3 processed delete before network drop)
      expect(faultAdapter.store.has(destinationKey)).toBe(false);

      const reconciler = new StorageReconciliationService({
        storageAdapter: faultAdapter,
        workerId: 'worker_c2',
        probeDelayMs: 0
      });

      const op = await StorageJournal.findOne({ operationId }).lean();
      const result = await reconciler.reconcileRecord(op);

      expect(result.action).toBe('CONFIRMED');

      // Verify journal updated to CONFIRMED
      const updated = await StorageJournal.findOne({ operationId }).lean();
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
    });

    it('C3: Reconciler resolves ambiguous delete when object remained in S3 by performing idempotent DELETE retry', async () => {
      const destinationKey = `forms/${uuidv4()}/responses/${uuidv4()}.pdf`;
      const operationId = uuidv4();
      const past = new Date(Date.now() - 50000); // Quarantine expired

      // Journal recorded AMBIGUOUS
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
        bucket: 'paperless',
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil: past,
        epoch: 0
      });

      // S3 store STILL holds the object (delete command was lost in flight)
      faultAdapter.store.set(destinationKey, {
        buffer: Buffer.from('Surviving Object'),
        size: 16,
        etag: '"etag-c3"',
        lastModified: new Date()
      });

      // MongoDB Response does NOT exist (response was already deleted from DB)
      const responseExists = await Response.exists({ 'answers.value.key': destinationKey });
      expect(responseExists).toBeNull();

      const reconciler = new StorageReconciliationService({
        storageAdapter: faultAdapter,
        workerId: 'worker_c3',
        probeDelayMs: 0
      });

      const op = await StorageJournal.findOne({ operationId }).lean();
      const result = await reconciler.reconcileRecord(op);

      expect(result.action).toBe('CONFIRMED');

      // Assert idempotent delete was executed and object is gone from S3
      expect(faultAdapter.store.has(destinationKey)).toBe(false);

      // Verify journal status is CONFIRMED
      const updated = await StorageJournal.findOne({ operationId }).lean();
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
    });

    it('C4: Ambiguous delete safely ABANDONS deletion if Response document still exists in MongoDB', async () => {
      const destinationKey = `forms/${uuidv4()}/responses/${uuidv4()}.pdf`;
      const operationId = uuidv4();
      const past = new Date(Date.now() - 50000);

      // Seed Response document (e.g. deletion transaction aborted in MongoDB)
      await Response.create({
        formId: new mongoose.Types.ObjectId(),
        answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key: destinationKey } }],
        commitStatus: 'committed'
      });

      // Journal recorded AMBIGUOUS delete
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
        bucket: 'paperless',
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil: past,
        epoch: 0
      });

      // Object exists in S3
      faultAdapter.store.set(destinationKey, {
        buffer: Buffer.from('Protected User Data'),
        size: 19,
        etag: '"etag-c4"',
        lastModified: new Date()
      });

      const reconciler = new StorageReconciliationService({
        storageAdapter: faultAdapter,
        workerId: 'worker_c4',
        probeDelayMs: 0
      });

      const op = await StorageJournal.findOne({ operationId }).lean();
      const result = await reconciler.reconcileRecord(op);

      expect(result.action).toBe('ABANDONED_RESPONSE_EXISTS');

      // Assert S3 object was PRESERVED
      expect(faultAdapter.store.has(destinationKey)).toBe(true);

      // Verify journal marked ABANDONED
      const updated = await StorageJournal.findOne({ operationId }).lean();
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.ABANDONED);
    });
  });

  // =========================================================================
  // SCENARIO D: Delayed PUT Across Process Restart
  // =========================================================================
  describe('Scenario D: Delayed PUT across process restart (Crash Recovery Convergence)', () => {
    it('D1: Process crashes after initiating PUT; restarted worker checks S3 HEAD, finds committed Response, and reconciles journal to CONFIRMED', async () => {
      const destinationKey = `forms/${uuidv4()}/responses/${uuidv4()}.pdf`;
      const operationId = uuidv4();
      const etag = '"etag-d1-stable"';

      // 1. Prior process initiated PUT, recorded DISPATCHED, but crashed before confirming
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: 'paperless',
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.DISPATCHED,
        payloadSize: 100,
        epoch: 0
      });

      // S3 object materialized successfully
      faultAdapter.store.set(destinationKey, {
        buffer: Buffer.alloc(100),
        size: 100,
        etag,
        metadata: { 'operation-id': operationId },
        lastModified: new Date(Date.now() - 10000)
      });

      // Response document committed successfully in MongoDB
      await Response.create({
        formId: new mongoose.Types.ObjectId(),
        answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key: destinationKey } }],
        commitStatus: 'committed'
      });

      // 2. New worker boots up and discovers unresolved record
      const reconciler = new StorageReconciliationService({
        storageAdapter: faultAdapter,
        workerId: 'worker_d1_boot',
        probeDelayMs: 0
      });

      const op = await StorageJournal.findOne({ operationId }).lean();
      const result = await reconciler.reconcileRecord(op);

      expect(result.action).toBe('CONFIRMED');

      // S3 object is preserved
      expect(faultAdapter.store.has(destinationKey)).toBe(true);

      // Journal record transitioned to CONFIRMED with ETag
      const updated = await StorageJournal.findOne({ operationId }).lean();
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
      expect(updated.etag).toBe(etag);
    });

    it('D2: Process crashes after initiating PUT; restarted worker finds S3 object but NO Response -> purges orphan and COMPENSATES journal', async () => {
      const destinationKey = `forms/${uuidv4()}/responses/${uuidv4()}.pdf`;
      const operationId = uuidv4();
      const etag = '"etag-d2-orphan"';

      // Prior process crashed; journal is DISPATCHED
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: 'paperless',
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.DISPATCHED,
        payloadSize: 150,
        epoch: 0
      });

      // S3 object materialized, but client never committed response
      faultAdapter.store.set(destinationKey, {
        buffer: Buffer.alloc(150),
        size: 150,
        etag,
        metadata: { 'operation-id': operationId },
        lastModified: new Date(Date.now() - 10000)
      });

      // Ensure no response exists
      const responseExists = await Response.exists({ 'answers.value.key': destinationKey });
      expect(responseExists).toBeNull();

      // New worker reconciles
      const reconciler = new StorageReconciliationService({
        storageAdapter: faultAdapter,
        workerId: 'worker_d2_boot',
        probeDelayMs: 0
      });

      const op = await StorageJournal.findOne({ operationId }).lean();
      const result = await reconciler.reconcileRecord(op);

      expect(result.action).toBe('COMPENSATED');

      // Assert orphan was deleted from S3
      expect(faultAdapter.store.has(destinationKey)).toBe(false);

      // Journal record transitioned to COMPENSATED
      const updated = await StorageJournal.findOne({ operationId }).lean();
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
      expect(updated.errorDetails).toContain('Unreferenced zombie blob compensated');
    });

    it('D3: Process crashes after initiating PUT; S3 object never materialized (404) -> issues prophylactic delete and COMPENSATES on 404', async () => {
      const destinationKey = `forms/${uuidv4()}/responses/${uuidv4()}.pdf`;
      const operationId = uuidv4();
      const past = new Date(Date.now() - 50000);

      // Prior process recorded AMBIGUOUS
      await StorageJournal.create({
        operationId,
        type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
        bucket: 'paperless',
        destinationKey,
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil: past,
        epoch: 0
      });

      // S3 object does not exist (upload failed)
      expect(faultAdapter.store.has(destinationKey)).toBe(false);

      const deleteSpy = vi.spyOn(faultAdapter, 'deleteFile');

      const reconciler = new StorageReconciliationService({
        storageAdapter: faultAdapter,
        workerId: 'worker_d3_boot',
        probeDelayMs: 0
      });

      const op = await StorageJournal.findOne({ operationId }).lean();
      const result = await reconciler.reconcileRecord(op);

      expect(result.action).toBe('COMPENSATED_404');
      // Prophylactic idempotent delete was issued (R-KE-01)
      expect(deleteSpy).toHaveBeenCalledWith(destinationKey, expect.any(Object));

      const updated = await StorageJournal.findOne({ operationId }).lean();
      expect(updated.status).toBe(STORAGE_JOURNAL_STATUS.COMPENSATED);
    });
  });

  // =========================================================================
  // SCENARIO E: Repeated Prefix Sweeps Discovering Late Objects
  // =========================================================================
  describe('Scenario E: Repeated prefix sweeps discovering late objects', () => {
    it('E1: Object appearing late after cancellation is retained on Run 1 (< barrier) and purged on Run 2 (> barrier)', async () => {
      const formId = new mongoose.Types.ObjectId();
      const leaseId = `lease_${uuidv4().slice(0, 8)}`;
      const fileId = uuidv4();
      const lateKey = `staging/forms/${formId}/${leaseId}/${fileId}.pdf`;

      const sweeper = new PrefixSweepService({
        storageAdapter: faultAdapter,
        minOrphanAgeMs: 60000 // 60-second quarantine barrier
      });

      // --- RUN 1: Object is young (15 seconds old, < 60s barrier) ---
      const now = Date.now();
      faultAdapter.store.set(lateKey, {
        buffer: Buffer.from('Late Landing File Content'),
        size: 25,
        etag: '"etag-e1"',
        metadata: {},
        lastModified: new Date(now - 15000) // 15 seconds old
      });

      // Run 1 of sweepPrefix
      const run1Result = await sweeper.sweepPrefix('staging/');
      expect(run1Result.keysScanned).toBe(1);
      expect(run1Result.orphansPurged).toBe(0);

      // Assert object was RETAINED in S3
      expect(faultAdapter.store.has(lateKey)).toBe(true);

      // Verify checkpoint recorded scan without purge
      let checkpoint = await sweeper.getCheckpoint('staging/');
      expect(checkpoint.totalKeysScanned).toBe(1);
      expect(checkpoint.totalOrphansPurged).toBe(0);

      // --- RUN 2: Time advances; object is now mature (75 seconds old, > 60s barrier) ---
      faultAdapter.store.set(lateKey, {
        ...faultAdapter.store.get(lateKey),
        lastModified: new Date(now - 75000) // 75 seconds old
      });

      // Run 2 of sweepPrefix
      const run2Result = await sweeper.sweepPrefix('staging/');
      expect(run2Result.keysScanned).toBe(1);
      expect(run2Result.orphansPurged).toBe(1);

      // Assert object was PURGED from S3
      expect(faultAdapter.store.has(lateKey)).toBe(false);

      // Verify subsequent HEAD returns NotFound (404)
      await expect(faultAdapter.headObject(lateKey)).rejects.toThrow('NoSuchKey');

      // Verify checkpoint recorded cumulative metrics
      checkpoint = await sweeper.getCheckpoint('staging/');
      expect(checkpoint.totalKeysScanned).toBe(2);
      expect(checkpoint.totalOrphansPurged).toBe(1);
    });
  });
});
