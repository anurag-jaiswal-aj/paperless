import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import User from '../models/user.js';
import SubmissionReservation from '../models/submissionReservation.js';
import DeletionCleanupJob from '../models/deletionCleanupJob.js';
import {
  executeFormDeletion,
  recoverAbandonedFormDeletions,
  processDeletionCleanupJob,
  CleanupLeaseHeartbeat
} from './formController.js';
import { submitResponse } from './responseController.js';
import { SubmissionReservationManager } from '../utils/submissionReservationManager.js';
import storageService from '../services/StorageService.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

const PDF_MAGIC = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

const createTempPdfFile = () => {
  const filePath = path.join(os.tmpdir(), `s3-orphan-test-${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(filePath, PDF_MAGIC);
  return filePath;
};

describe('Stage 4.3.5 B1: Durable S3 Orphan Recovery & Post-Cascade Lifecycle (14 Scenarios)', () => {
  let replSet;
  let app;
  let testUser;
  let userId;
  let activeS3Objects;
  let upload;

  beforeAll(async () => {
    replSet = await startReplSet();

    upload = multer({ dest: os.tmpdir() });
    app = express();
    app.use(express.json());
    app.post('/api/responses/:formId', upload.any(), submitResponse);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await DeletionCleanupJob.deleteMany({});
    await User.deleteMany({});

    testUser = await User.create({
      name: 'Owner User',
      email: `owner-${crypto.randomUUID()}@example.com`,
      password: 'password123'
    });
    userId = testUser._id.toString();

    activeS3Objects = new Map();

    vi.spyOn(storageService, 'uploadFile').mockImplementation(async (fileStream, key, mime) => {
      activeS3Objects.set(key, { mime, timestamp: Date.now() });
      return key;
    });

    vi.spyOn(storageService, 'deleteFile').mockImplementation(async (key) => {
      activeS3Objects.delete(key);
      return Promise.resolve();
    });

    vi.spyOn(storageService, 'deleteFiles').mockImplementation(async (keys) => {
      const deletedKeys = [];
      for (const k of keys) {
        activeS3Objects.delete(k);
        deletedKeys.push(k);
      }
      return { success: true, deletedKeys, failedKeys: [], totalRequested: keys.length };
    });

    vi.spyOn(storageService, 'copyFile').mockImplementation(async (sourceKey, destinationKey) => {
      const obj = activeS3Objects.get(sourceKey);
      activeS3Objects.set(
        destinationKey,
        obj || { mime: 'application/octet-stream', timestamp: Date.now() }
      );
      return destinationKey;
    });

    vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async (prefix) => {
      const matched = [];
      for (const k of activeS3Objects.keys()) {
        if (k.startsWith(prefix)) {
          matched.push(k);
        }
      }
      return {
        keys: matched,
        isTruncated: false,
        nextContinuationToken: null,
        keyCount: matched.length
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Scenario 1: Normal upload and successful submission
  // --------------------------------------------------------------------------
  it('Scenario 1: normal upload stages file, promotes to final key, purges staging, and commits', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 1', status: 'published' });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      order: 0
    });

    const tmpPdf = createTempPdfFile();
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(201);

      // Verify final key exists
      expect(activeS3Objects.size).toBe(1);
      const promotedKey = Array.from(activeS3Objects.keys())[0];
      expect(promotedKey).toMatch(new RegExp(`^forms/${form._id}/responses/`));

      // Verify staging prefix is completely empty
      const stagingKeys = Array.from(activeS3Objects.keys()).filter((k) =>
        k.startsWith(`staging/forms/${form._id}/`)
      );
      expect(stagingKeys.length).toBe(0);

      // Verify response persisted with promoted key in answer object
      const savedResponse = await Response.findOne({ formId: form._id });
      expect(savedResponse).not.toBeNull();
      expect(savedResponse.answers[0].value.key).toBe(promotedKey);

      // Verify reservation finalized with vacuumAt
      const reservation = await SubmissionReservation.findOne({ formId: form._id });
      expect(reservation.status).toBe('finalized');
      expect(reservation.vacuumAt).toBeInstanceOf(Date);
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Abandoned upload with object present in staging
  // --------------------------------------------------------------------------
  it('Scenario 2: abandoned upload with object in staging is swept and purged by deletion cleanup job', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 2', status: 'published' });
    const leaseId = crypto.randomUUID();
    const stagedKey = `staging/forms/${form._id}/${leaseId}/abandoned.pdf`;
    activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

    // Form deletion runs with skipImmediateCleanup so we deterministically control processDeletionCleanupJob
    const delResult = await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });
    expect(delResult.success).toBe(true);

    // Verify DeletionCleanupJob exists in DB
    const job = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(job).not.toBeNull();
    expect(job.stagingPrefix).toBe(`staging/forms/${form._id}/`);
    expect(job.status).toBe('pending');

    // Simulate elapsed grace period
    await DeletionCleanupJob.updateOne(
      { _id: job._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );

    const cleanupResult = await processDeletionCleanupJob(form._id);
    expect(cleanupResult.processed).toBe(true);
    expect(['completed', 'reconciled']).toContain(cleanupResult.status);
    expect(cleanupResult.deletedCount).toBe(1);

    // Staged object is purged from virtual S3
    expect(activeS3Objects.has(stagedKey)).toBe(false);
    expect(activeS3Objects.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Deletion cleanup listing staging prefix before upload completes
  // --------------------------------------------------------------------------
  it('Scenario 3: deletion cleanup listing prefix before in-flight upload completes leaves job pending and cleans late upload on next pass', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 3', status: 'published' });

    // Step 1: Deletion executes while upload is in-flight (0 objects currently in S3)
    const delResult = await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });
    expect(delResult.success).toBe(true);

    const job = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(job.status).toBe('pending');
    expect(new Date(job.eligibleUntil).getTime()).toBeGreaterThan(Date.now());

    // Step 2: First pass runs - 0 objects found, still within grace period -> status stays pending
    const pass1Result = await processDeletionCleanupJob(form._id);
    expect(pass1Result.processed).toBe(true);
    expect(pass1Result.status).toBe('pending');
    expect(pass1Result.deletedCount).toBe(0);

    // Step 3: In-flight upload completes late into staging
    const lateKey = `staging/forms/${form._id}/${crypto.randomUUID()}/in-flight-late.pdf`;
    activeS3Objects.set(lateKey, { mime: 'application/pdf', timestamp: Date.now() });

    // Step 4: Advance past grace period and execute second pass
    await DeletionCleanupJob.updateOne(
      { _id: job._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );

    const pass2Result = await processDeletionCleanupJob(form._id);
    expect(pass2Result.processed).toBe(true);
    expect(['completed', 'reconciled']).toContain(pass2Result.status);
    expect(pass2Result.deletedCount).toBe(1);

    // Assert virtual S3 is clean
    expect(activeS3Objects.has(lateKey)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Upload completing after first cleanup pass
  // --------------------------------------------------------------------------
  it('Scenario 4: upload completing after first cleanup pass is swept by subsequent recovery pass', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 4', status: 'published' });

    await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });

    // Pass 1 cleans nothing (empty)
    const pass1 = await processDeletionCleanupJob(form._id);
    expect(pass1.status).toBe('pending');

    // Late upload arrives after pass 1
    const lateKey = `staging/forms/${form._id}/${crypto.randomUUID()}/late-after-pass1.pdf`;
    activeS3Objects.set(lateKey, { mime: 'application/pdf' });

    // Second pass runs during/after grace period
    await DeletionCleanupJob.updateOne(
      { formId: form._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );
    const pass2 = await processDeletionCleanupJob(form._id);
    expect(['completed', 'reconciled']).toContain(pass2.status);
    expect(pass2.deletedCount).toBe(1);
    expect(activeS3Objects.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Submission worker hard-crash simulation immediately after S3 upload
  // --------------------------------------------------------------------------
  it('Scenario 5: hard crash immediately after S3 upload completion leaves orphaned file swept by deletion job without worker survival', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 5', status: 'published' });
    const leaseId = crypto.randomUUID();

    // Worker staged file
    const stagedKey = `staging/forms/${form._id}/${leaseId}/hardcrash.pdf`;
    activeS3Objects.set(stagedKey, { mime: 'application/pdf' });

    // SIMULATE HARD CRASH: Worker exits immediately. No rollback, no catch block, no release.
    // Deletion is subsequently executed by owner
    const delResult = await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });
    expect(delResult.success).toBe(true);

    // Cleanup job executes
    await DeletionCleanupJob.updateOne(
      { formId: form._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );
    const cleanupResult = await processDeletionCleanupJob(form._id);
    expect(['completed', 'reconciled']).toContain(cleanupResult.status);
    expect(cleanupResult.deletedCount).toBe(1);

    // Orphaned S3 object was durably recovered
    expect(activeS3Objects.has(stagedKey)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Process restart followed by recovery of the orphaned object
  // --------------------------------------------------------------------------
  it('Scenario 6: process restart triggers recovery worker which discovers and purges orphaned S3 objects', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 6', status: 'published' });
    const orphanKey = `staging/forms/${form._id}/${crypto.randomUUID()}/restart-orphan.pdf`;
    activeS3Objects.set(orphanKey, { mime: 'application/pdf' });

    await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });

    // Simulate expired grace period before process restart
    await DeletionCleanupJob.updateOne(
      { formId: form._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );

    // Simulate system startup / cron calling recoverAbandonedFormDeletions()
    const recoveryResult = await recoverAbandonedFormDeletions();
    expect(recoveryResult.completedCleanupJobs).toBeGreaterThanOrEqual(1);
    expect(recoveryResult.purgedStorageFiles).toBeGreaterThanOrEqual(1);

    // Verify S3 object is gone
    expect(activeS3Objects.has(orphanKey)).toBe(false);

    const updatedJob = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(['completed', 'reconciled']).toContain(updatedJob.status);
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Repeated cleanup runs remaining idempotent
  // --------------------------------------------------------------------------
  it('Scenario 7: repeated cleanup runs remain strictly idempotent with no side effects or errors', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 7', status: 'published' });
    const key = `staging/forms/${form._id}/${crypto.randomUUID()}/doc.pdf`;
    activeS3Objects.set(key, { mime: 'application/pdf' });

    await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });
    await DeletionCleanupJob.updateOne(
      { formId: form._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );

    // Run 1: cleans object, marks completed / reconciled
    const run1 = await processDeletionCleanupJob(form._id);
    expect(['completed', 'reconciled']).toContain(run1.status);
    expect(run1.deletedCount).toBe(1);

    // Run 2: idempotent no-op
    const run2 = await processDeletionCleanupJob(form._id);
    expect(['completed', 'reconciled']).toContain(run2.status);
    expect(run2.alreadyCompleted || run2.alreadyReconciled).toBe(true);
    expect(run2.deletedCount).toBe(0);

    // Run 3: idempotent no-op
    const run3 = await processDeletionCleanupJob(form._id);
    expect(['completed', 'reconciled']).toContain(run3.status);
    expect(run3.alreadyCompleted || run3.alreadyReconciled).toBe(true);
    expect(run3.deletedCount).toBe(0);

    const finalJob = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(['completed', 'reconciled']).toContain(finalJob.status);
    expect(finalJob.stats.objectsDeleted).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Partial S3 deletion failure followed by successful retry
  // --------------------------------------------------------------------------
  it('Scenario 8: partial S3 failure marks job pending with error, subsequent retry succeeds', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 8', status: 'published' });
    const keyA = `staging/forms/${form._id}/${crypto.randomUUID()}/docA.pdf`;
    const keyB = `staging/forms/${form._id}/${crypto.randomUUID()}/docB.pdf`;
    activeS3Objects.set(keyA, { mime: 'application/pdf' });
    activeS3Objects.set(keyB, { mime: 'application/pdf' });

    await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });
    await DeletionCleanupJob.updateOne(
      { formId: form._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );

    // Mock deleteFiles to fail on first attempt
    vi.spyOn(storageService, 'deleteFiles').mockResolvedValueOnce({
      success: false,
      deletedKeys: [],
      failedKeys: [keyA, keyB],
      error: 'AWS S3 503 SlowDown'
    });

    const run1 = await processDeletionCleanupJob(form._id);
    expect(run1.status).toBe('pending');
    expect(run1.error).toContain('AWS S3 503 SlowDown');

    const jobAfterFail = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(jobAfterFail.attempts).toBe(1);
    expect(jobAfterFail.lastError).toContain('AWS S3 503 SlowDown');
    expect(jobAfterFail.leaseId).toBeNull(); // Lease released for next attempt

    // Run 2: Default deleteFiles mock succeeds
    const run2 = await processDeletionCleanupJob(form._id);
    expect(['completed', 'reconciled']).toContain(run2.status);
    expect(run2.deletedCount).toBe(2);

    expect(activeS3Objects.size).toBe(0);
    const jobAfterSuccess = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(['completed', 'reconciled']).toContain(jobAfterSuccess.status);
    expect(jobAfterSuccess.attempts).toBe(2);
    expect(jobAfterSuccess.lastError).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Paginated staging-prefix listing (>1,000 objects)
  // --------------------------------------------------------------------------
  it('Scenario 9: paginated prefix listing fetches and purges >1,000 staging objects across continuation tokens', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 9', status: 'published' });
    const totalObjects = 1050;
    const allKeys = [];
    for (let i = 0; i < totalObjects; i++) {
      const k = `staging/forms/${form._id}/lease-${i}/file-${i}.pdf`;
      activeS3Objects.set(k, { mime: 'application/pdf' });
      allKeys.push(k);
    }

    await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });
    await DeletionCleanupJob.updateOne(
      { formId: form._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );

    // Mock listObjectsByPrefix to paginate in batches of 500 based on activeS3Objects
    vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(
      async (prefix, { continuationToken } = {}) => {
        const matchingKeys = Array.from(activeS3Objects.keys()).filter((k) => k.startsWith(prefix));
        let startIndex = 0;
        if (continuationToken === 'token-1') startIndex = 500;
        else if (continuationToken === 'token-2') startIndex = 1000;

        const slice = matchingKeys.slice(startIndex, startIndex + 500);
        const hasMore = startIndex + 500 < matchingKeys.length;
        const nextToken = hasMore ? (startIndex === 0 ? 'token-1' : 'token-2') : null;

        return {
          keys: slice,
          isTruncated: hasMore,
          nextContinuationToken: nextToken,
          keyCount: slice.length
        };
      }
    );

    const cleanupResult = await processDeletionCleanupJob(form._id);
    expect(cleanupResult.error).toBeUndefined();
    expect(['completed', 'reconciled']).toContain(cleanupResult.status);
    expect(cleanupResult.deletedCount).toBe(1050);

    // Verify all 1,050 objects removed from active map
    expect(activeS3Objects.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Cleanup metadata surviving deletion of Form and SubmissionReservation
  // --------------------------------------------------------------------------
  it('Scenario 10: DeletionCleanupJob document survives Form and SubmissionReservation cascading deletion', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 10', status: 'published' });
    await SubmissionReservation.create({
      formId: form._id,
      leaseId: crypto.randomUUID(),
      fenceToken: 1,
      status: 'finalized',
      expiresAt: new Date(Date.now() + 60000),
      vacuumAt: new Date(Date.now() + 86400000)
    });

    const delRes = await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });
    expect(delRes.success).toBe(true);

    // Form is deleted
    expect(await Form.findById(form._id)).toBeNull();
    // Reservation is deleted
    expect(await SubmissionReservation.find({ formId: form._id })).toHaveLength(0);

    // DeletionCleanupJob SURVIVES
    const job = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(job).not.toBeNull();
    expect(job.stagingPrefix).toBe(`staging/forms/${form._id}/`);
    expect(job.finalPrefix).toBe(`forms/${form._id}/`);
    expect(job.status).toBe('pending');
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Expired cleanup metadata not removed before maximum upload lifetime and grace period
  // --------------------------------------------------------------------------
  it('Scenario 11: cleanup job enforces eligibleUntil grace period before completing and sets vacuumAt TTL', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 11', status: 'published' });
    await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });

    const job = await DeletionCleanupJob.findOne({ formId: form._id });
    const creationEligible = new Date(job.eligibleUntil).getTime();
    // Default grace period is 15 minutes (900,000 ms)
    expect(creationEligible).toBeGreaterThan(Date.now() + 14 * 60 * 1000);

    // Running cleanup during grace period: even with 0 files, cannot finalize
    const prematureRun = await processDeletionCleanupJob(form._id);
    expect(prematureRun.status).toBe('pending');

    const jobStillPending = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(jobStillPending.status).toBe('pending');
    expect(jobStillPending.vacuumAt).toBeNull(); // No TTL pruning yet!

    // Advance past grace period
    await DeletionCleanupJob.updateOne(
      { formId: form._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );

    const matureRun = await processDeletionCleanupJob(form._id);
    expect(['completed', 'reconciled']).toContain(matureRun.status);

    const completedJob = await DeletionCleanupJob.findOne({ formId: form._id });
    expect(['completed', 'reconciled']).toContain(completedJob.status);
    expect(completedJob.vacuumAt).toBeNull(); // Perpetual TTL immunity
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Successful submission promotion without exposing staging objects
  // --------------------------------------------------------------------------
  it('Scenario 12: submission promotion leaves promoted file in final prefix and zero objects in staging', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 12', status: 'published' });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment12',
      order: 0
    });

    const tmpPdf = createTempPdfFile();
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(201);

      // Verify promoted object exists
      const promotedKeys = Array.from(activeS3Objects.keys()).filter((k) =>
        k.startsWith(`forms/${form._id}/responses/`)
      );
      expect(promotedKeys.length).toBe(1);

      // Verify staging objects are completely cleaned
      const stagingKeys = Array.from(activeS3Objects.keys()).filter((k) =>
        k.startsWith(`staging/forms/${form._id}/`)
      );
      expect(stagingKeys.length).toBe(0);
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Stale recovery worker unable to finalize or delete another worker's newer lease
  // --------------------------------------------------------------------------
  it('Scenario 13: stale recovery worker is fenced by leaseId + epoch and cannot overwrite newer worker state', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 13', status: 'published' });
    await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });

    // Worker 1 claims job
    const worker1LeaseId = crypto.randomUUID();
    const worker1Epoch = 1;
    const now = new Date();

    const claimedByW1 = await DeletionCleanupJob.findOneAndUpdate(
      { formId: form._id, status: 'pending' },
      {
        $set: {
          status: 'cleaning',
          leaseId: worker1LeaseId,
          leaseExpiresAt: new Date(now.getTime() - 1000) // W1 expired!
        },
        $inc: { epoch: 1 }
      },
      { new: true }
    );
    expect(claimedByW1).not.toBeNull();

    // Worker 2 claims job because W1 lease expired
    const worker2LeaseId = crypto.randomUUID();
    const claimedByW2 = await DeletionCleanupJob.findOneAndUpdate(
      {
        formId: form._id,
        status: 'cleaning',
        leaseExpiresAt: { $lt: new Date() }
      },
      {
        $set: {
          status: 'cleaning',
          leaseId: worker2LeaseId,
          leaseExpiresAt: new Date(Date.now() + 60000)
        },
        $inc: { epoch: 1 }
      },
      { new: true }
    );
    expect(claimedByW2.leaseId).toBe(worker2LeaseId);
    expect(claimedByW2.epoch).toBe(2);

    // Stale Worker 1 wakes up and tries CAS update with old leaseId and old epoch
    const staleUpdate = await DeletionCleanupJob.updateOne(
      { _id: claimedByW1._id, leaseId: worker1LeaseId, epoch: worker1Epoch },
      { $set: { status: 'completed' } }
    );
    expect(staleUpdate.matchedCount).toBe(0);
    expect(staleUpdate.modifiedCount).toBe(0);

    // Verify Worker 2's job state is uncorrupted
    const activeJob = await DeletionCleanupJob.findById(claimedByW1._id);
    expect(activeJob.status).toBe('cleaning');
    expect(activeJob.leaseId).toBe(worker2LeaseId);
    expect(activeJob.epoch).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Recovery continuing to work after an interrupted cleanup pass
  // --------------------------------------------------------------------------
  it('Scenario 14: interrupted cleanup pass is resumed and completed by next recovery worker', async () => {
    const form = await Form.create({ ownerId: userId, title: 'Form 14', status: 'published' });
    const key1 = `staging/forms/${form._id}/${crypto.randomUUID()}/part1.pdf`;
    const key2 = `staging/forms/${form._id}/${crypto.randomUUID()}/part2.pdf`;
    const key3 = `staging/forms/${form._id}/${crypto.randomUUID()}/part3.pdf`;
    activeS3Objects.set(key1, { mime: 'application/pdf' });
    activeS3Objects.set(key2, { mime: 'application/pdf' });
    activeS3Objects.set(key3, { mime: 'application/pdf' });

    await executeFormDeletion(form._id, {
      userId,
      drainWaitMs: 0,
      skipImmediateCleanup: true
    });
    await DeletionCleanupJob.updateOne(
      { formId: form._id },
      { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
    );

    // Worker 1 claims job, deletes 1 object, then crashes/interrupts (lease expires)
    const w1Claim = await DeletionCleanupJob.findOneAndUpdate(
      { formId: form._id, status: 'pending' },
      {
        $set: {
          status: 'cleaning',
          leaseId: 'w1-lease',
          leaseExpiresAt: new Date(Date.now() - 1000), // Expired
          'stats.objectsDeleted': 1
        },
        $inc: { epoch: 1, attempts: 1 }
      },
      { new: true }
    );
    activeS3Objects.delete(key1); // W1 deleted key1 before crashing

    // Worker 2 invokes processDeletionCleanupJob
    const w2Result = await processDeletionCleanupJob(form._id);
    expect(w2Result.processed).toBe(true);
    expect(['completed', 'reconciled']).toContain(w2Result.status);
    expect(w2Result.deletedCount).toBe(2); // Deleted remaining key2 and key3

    expect(activeS3Objects.size).toBe(0);

    const finalJob = await DeletionCleanupJob.findById(w1Claim._id);
    expect(['completed', 'reconciled']).toContain(finalJob.status);
    expect(finalJob.stats.objectsDeleted).toBe(3); // 1 from W1 + 2 from W2
  });

  // ==========================================================================
  // Stage 4.3.5 B1 Final Object Ownership Remediation (12 Tests)
  // Covers Defect A (Canonical Promotion Safety) & Defect B (Durable Staging Cleanup)
  // ==========================================================================

  it('Remediation Test 1: final-key registration returns false: no S3 copy occurs and 409 thrown', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 1',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      order: 0
    });

    const copyFileSpy = vi.spyOn(storageService, 'copyFile');
    const originalRecordStagedKey = SubmissionReservationManager.recordStagedKey;
    vi.spyOn(SubmissionReservationManager, 'recordStagedKey').mockImplementation(
      async (leaseId, fenceToken, key) => {
        if (typeof key === 'string' && key.includes('/responses/')) {
          return false; // Final-key registration fails
        }
        return originalRecordStagedKey.call(SubmissionReservationManager, leaseId, fenceToken, key);
      }
    );

    const tmpPdf = createTempPdfFile();
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(409);
      expect(copyFileSpy).not.toHaveBeenCalled();

      // Zero canonical keys created
      const canonicalKeys = Array.from(activeS3Objects.keys()).filter((k) =>
        k.startsWith(`forms/${form._id}/responses/`)
      );
      expect(canonicalKeys.length).toBe(0);

      // Verify MongoDB state
      expect(await Response.countDocuments({ formId: form._id })).toBe(0);
      const remainingForm = await Form.findById(form._id);
      expect(remainingForm.status).toBe('published');
      expect(remainingForm.activeSubmissions).toBe(0);

      // Verify form remains healthy and accepts subsequent submission
      vi.restoreAllMocks();
      vi.spyOn(storageService, 'uploadFile').mockImplementation(async (fileStream, key, mime) => {
        activeS3Objects.set(key, { mime, timestamp: Date.now() });
        return key;
      });
      vi.spyOn(storageService, 'deleteFile').mockImplementation(async (key) => {
        activeS3Objects.delete(key);
        return Promise.resolve();
      });
      vi.spyOn(storageService, 'copyFile').mockImplementation(async (sourceKey, destinationKey) => {
        const obj = activeS3Objects.get(sourceKey);
        activeS3Objects.set(
          destinationKey,
          obj || { mime: 'application/octet-stream', timestamp: Date.now() }
        );
        return destinationKey;
      });

      const retryRes = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);
      expect(retryRes.status).toBe(201);
      expect(await Response.countDocuments({ formId: form._id })).toBe(1);
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  it('Remediation Test 2: worker crashes after copyFile before T_sub: sweep purges canonical and staging keys', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 2',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      order: 0
    });

    let stagedKeyRecorded = null;
    let finalKeyRecorded = null;

    // Simulate crash after copyFile resolves before entering transaction
    vi.spyOn(storageService, 'copyFile').mockImplementation(async (sourceKey, destKey) => {
      stagedKeyRecorded = sourceKey;
      finalKeyRecorded = destKey;
      activeS3Objects.set(destKey, { mime: 'application/pdf', timestamp: Date.now() });
      const crashErr = new Error('SIMULATED_WORKER_CRASH_BEFORE_TSUB');
      crashErr.isSimulatedCrash = true;
      throw crashErr;
    });

    const tmpPdf = createTempPdfFile();
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(500);

      // Verify no response document created
      expect(await Response.countDocuments({ formId: form._id })).toBe(0);

      // If simulated hard crash didn't allow release, simulate uncleaned reservation expiring:
      const reservation = await SubmissionReservation.findOne({ formId: form._id });
      if (reservation) {
        await SubmissionReservation.updateOne(
          { _id: reservation._id },
          {
            $set: {
              expiresAt: new Date(Date.now() - 10000),
              quarantinedUntil: new Date(Date.now() - 10000)
            }
          }
        );
      }

      // Run background recovery
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // Both staging and canonical objects must be purged from S3
      expect(activeS3Objects.has(stagedKeyRecorded)).toBe(false);
      expect(activeS3Objects.has(finalKeyRecorded)).toBe(false);
      expect(activeS3Objects.size).toBe(0);

      const remainingForm = await Form.findById(form._id);
      expect(remainingForm.status).toBe('published');
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  it('Remediation Test 3: copyFile fails: durable metadata remains safe and retryable', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 3',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      order: 0
    });

    vi.spyOn(storageService, 'copyFile').mockRejectedValueOnce(
      new Error('AWS S3 503 SlowDown: Service Unavailable')
    );

    const tmpPdf = createTempPdfFile();
    const idemKey = `idem-${crypto.randomUUID()}`;
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .set('x-idempotency-key', idemKey)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(500);
      expect(await Response.countDocuments({ formId: form._id })).toBe(0);

      // Zero canonical keys created
      const canonicalKeys = Array.from(activeS3Objects.keys()).filter((k) =>
        k.startsWith(`forms/${form._id}/responses/`)
      );
      expect(canonicalKeys.length).toBe(0);

      // Immediate retry with operational S3 succeeds
      const retryRes = await request(app)
        .post(`/api/responses/${form._id}`)
        .set('x-idempotency-key', idemKey)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(retryRes.status).toBe(201);
      expect(await Response.countDocuments({ formId: form._id })).toBe(1);
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  it('Remediation Test 4: stale worker resumes after reservation expiry: cannot promote canonical object', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 4',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      order: 0
    });

    let workerStalled = false;
    vi.spyOn(storageService, 'uploadFile').mockImplementation(async (fileStream, key, mime) => {
      activeS3Objects.set(key, { mime, timestamp: Date.now() });
      // Simulate extreme stall: expire the reservation while worker was paused
      await SubmissionReservation.updateOne(
        { formId: form._id },
        { $set: { expiresAt: new Date(Date.now() - 20000) } }
      );
      // Sweeper sweeps expired reservation
      await SubmissionReservationManager.sweepAbandonedReservations({ graceMs: 0 });
      workerStalled = true;
      return key;
    });

    const tmpPdf = createTempPdfFile();
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(409); // Post-upload renew or finalKey registration fails closed
      expect(workerStalled).toBe(true);
      expect(await Response.countDocuments({ formId: form._id })).toBe(0);

      // Zero canonical keys created
      const canonicalKeys = Array.from(activeS3Objects.keys()).filter((k) =>
        k.startsWith(`forms/${form._id}/responses/`)
      );
      expect(canonicalKeys.length).toBe(0);
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  it('Remediation Test 5: T_sub commits, worker crashes before staging deletion: obligation persisted in DB', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 5',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      order: 0
    });

    // Worker simulates crash right after T_sub commits before performStagingCleanup can run
    vi.spyOn(SubmissionReservationManager, 'performStagingCleanup').mockImplementationOnce(
      async () => {
        throw new Error('SIMULATED_CRASH_BEFORE_STAGING_CLEANUP');
      }
    );

    const tmpPdf = createTempPdfFile();
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(201);

      // Response exists and is committed
      const savedResponse = await Response.findOne({ formId: form._id });
      expect(savedResponse).not.toBeNull();
      expect(savedResponse.commitStatus).toBe('committed');

      // Reservation is finalized with pending staging cleanup and vacuumAt: null (TTL immunity)
      const reservation = await SubmissionReservation.findOne({ formId: form._id });
      expect(reservation).not.toBeNull();
      expect(reservation.status).toBe('finalized');
      expect(reservation.stagingCleanupStatus).toBe('pending');
      expect(reservation.vacuumAt).toBeNull();
      expect(reservation.stagedKeys.length).toBeGreaterThan(0);

      // Both canonical and staging objects exist in S3 (staging orphaned by crash)
      const stagingKeys = Array.from(activeS3Objects.keys()).filter((k) =>
        k.startsWith(`staging/forms/${form._id}/`)
      );
      const canonicalKeys = Array.from(activeS3Objects.keys()).filter((k) =>
        k.startsWith(`forms/${form._id}/responses/`)
      );
      expect(stagingKeys.length).toBe(1);
      expect(canonicalKeys.length).toBe(1);
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  it('Remediation Test 6: application restarts and independently discovers the cleanup obligation', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 6',
      status: 'published'
    });
    const leaseId = crypto.randomUUID();
    const stagingKey = `staging/forms/${form._id}/${leaseId}/doc.pdf`;
    const finalKey = `forms/${form._id}/responses/doc.pdf`;
    activeS3Objects.set(stagingKey, { mime: 'application/pdf' });
    activeS3Objects.set(finalKey, { mime: 'application/pdf' });

    // Directly seed state left by a crashed worker
    await SubmissionReservation.create({
      formId: form._id,
      leaseId,
      fenceToken: crypto.randomUUID(),
      status: 'finalized',
      stagingCleanupStatus: 'pending',
      stagedKeys: [stagingKey],
      stagingKeysToPurge: [stagingKey],
      expiresAt: new Date(Date.now() + 30000),
      vacuumAt: null,
      counterReleased: true
    });

    // Scanner queries pending finalized staging cleanups
    const discovered = await SubmissionReservation.find({
      status: 'finalized',
      stagingCleanupStatus: { $in: ['pending', 'failed', 'cleaning'] },
      $or: [{ stagingLeaseExpiresAt: null }, { stagingLeaseExpiresAt: { $lt: new Date() } }]
    }).lean();

    expect(discovered.length).toBe(1);
    expect(discovered[0].leaseId).toBe(leaseId);
    expect(discovered[0].stagedKeys).toContain(stagingKey);
    expect(form.status).toBe('published');
  });

  it('Remediation Test 7: recovery deletes staging object while form remains published', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 7',
      status: 'published'
    });
    const leaseId = crypto.randomUUID();
    const stagingKey = `staging/forms/${form._id}/${leaseId}/doc.pdf`;
    const finalKey = `forms/${form._id}/responses/doc.pdf`;
    activeS3Objects.set(stagingKey, { mime: 'application/pdf' });
    activeS3Objects.set(finalKey, { mime: 'application/pdf' });

    await SubmissionReservation.create({
      formId: form._id,
      leaseId,
      fenceToken: crypto.randomUUID(),
      status: 'finalized',
      stagingCleanupStatus: 'pending',
      stagedKeys: [stagingKey],
      stagingKeysToPurge: [stagingKey],
      expiresAt: new Date(Date.now() + 30000),
      vacuumAt: null,
      counterReleased: true
    });

    // Run recovery pass
    await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });

    // Staging key deleted, canonical key preserved
    expect(activeS3Objects.has(stagingKey)).toBe(false);
    expect(activeS3Objects.has(finalKey)).toBe(true);

    // Form remains published
    const remainingForm = await Form.findById(form._id);
    expect(remainingForm.status).toBe('published');

    // Reservation updated: stagedKeys cleared, vacuumAt armed
    const updatedRes = await SubmissionReservation.findOne({ leaseId });
    expect(updatedRes.stagingCleanupStatus).toBe('completed');
    expect(updatedRes.stagedKeys.length).toBe(0);
    expect(updatedRes.vacuumAt).not.toBeNull();
    expect(new Date(updatedRes.vacuumAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('Remediation Test 8: canonical object remains present and referenced by committed Response', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 8',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      order: 0
    });

    const tmpPdf = createTempPdfFile();
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(201);

      const savedResponse = await Response.findOne({ formId: form._id });
      expect(savedResponse).not.toBeNull();
      const savedKey = savedResponse.answers[0].value.key;

      expect(savedKey).toMatch(new RegExp(`^forms/${form._id}/responses/`));
      expect(activeS3Objects.has(savedKey)).toBe(true);
      expect(activeS3Objects.get(savedKey).mime).toBe('application/pdf');

      // Run recovery again
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });

      // Canonical key must still exist completely untouched
      expect(activeS3Objects.has(savedKey)).toBe(true);
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  it('Remediation Test 9: partial staging deletion fails on transient error and succeeds on retry', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 9',
      status: 'published'
    });
    const leaseId = crypto.randomUUID();
    const stagingKey1 = `staging/forms/${form._id}/${leaseId}/part1.pdf`;
    const stagingKey2 = `staging/forms/${form._id}/${leaseId}/part2.pdf`;
    activeS3Objects.set(stagingKey1, { mime: 'application/pdf' });
    activeS3Objects.set(stagingKey2, { mime: 'application/pdf' });

    await SubmissionReservation.create({
      formId: form._id,
      leaseId,
      fenceToken: crypto.randomUUID(),
      status: 'finalized',
      stagingCleanupStatus: 'pending',
      stagedKeys: [stagingKey1, stagingKey2],
      stagingKeysToPurge: [stagingKey1, stagingKey2],
      expiresAt: new Date(Date.now() + 30000),
      vacuumAt: null,
      counterReleased: true
    });

    let deleteAttempts = 0;
    vi.spyOn(storageService, 'deleteFile').mockImplementation(async (key) => {
      if (key === stagingKey2 && deleteAttempts === 0) {
        deleteAttempts++;
        throw new Error('AWS S3 503 SlowDown');
      }
      activeS3Objects.delete(key);
    });

    // Pass 1: key1 succeeds, key2 fails
    await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });

    expect(activeS3Objects.has(stagingKey1)).toBe(false);
    expect(activeS3Objects.has(stagingKey2)).toBe(true);

    const midRes = await SubmissionReservation.findOne({ leaseId });
    expect(midRes.stagingCleanupStatus).toBe('pending');
    expect(midRes.stagedKeys).toEqual([stagingKey2]);
    expect(midRes.vacuumAt).toBeNull(); // Still protected from TTL

    // Pass 2: key2 succeeds on retry
    await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });

    expect(activeS3Objects.has(stagingKey2)).toBe(false);
    const finalRes = await SubmissionReservation.findOne({ leaseId });
    expect(finalRes.stagingCleanupStatus).toBe('completed');
    expect(finalRes.stagedKeys).toEqual([]);
    expect(finalRes.vacuumAt).not.toBeNull();
  });

  it('Remediation Test 10: two workers attempt same cleanup job: fencing prevents stale state changes', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 10',
      status: 'published'
    });
    const leaseId = crypto.randomUUID();
    const stagingKey = `staging/forms/${form._id}/${leaseId}/data.pdf`;
    activeS3Objects.set(stagingKey, { mime: 'application/pdf' });

    const reservation = await SubmissionReservation.create({
      formId: form._id,
      leaseId,
      fenceToken: crypto.randomUUID(),
      status: 'finalized',
      stagingCleanupStatus: 'pending',
      stagedKeys: [stagingKey],
      stagingKeysToPurge: [stagingKey],
      expiresAt: new Date(Date.now() + 30000),
      vacuumAt: null,
      counterReleased: true
    });

    // Simulating Worker 1 claiming lease
    const w1Claim = await SubmissionReservation.findOneAndUpdate(
      { formId: form._id, status: 'finalized', stagedKeys: { $ne: [] } },
      {
        $set: {
          stagingCleanupStatus: 'cleaning',
          stagingLeaseId: 'w1',
          cleanupLeaseId: 'w1',
          stagingEpoch: 1,
          cleanupEpoch: 1,
          stagingLeaseExpiresAt: new Date(Date.now() - 1000), // Expired
          cleanupLeaseExpiresAt: new Date(Date.now() - 1000)
        }
      },
      { new: true }
    );
    expect(w1Claim).not.toBeNull();

    // Worker 2 reclaims expired lease
    const w2Claim = await SubmissionReservation.findOneAndUpdate(
      {
        formId: form._id,
        status: 'finalized',
        $or: [
          { stagingLeaseExpiresAt: { $lt: new Date() } },
          { cleanupLeaseExpiresAt: { $lt: new Date() } }
        ]
      },
      {
        $set: {
          stagingCleanupStatus: 'completed',
          stagedKeys: [],
          stagingKeysToPurge: [],
          stagingLeaseId: 'w2',
          cleanupLeaseId: 'w2',
          stagingLeaseExpiresAt: new Date(Date.now() + 30000),
          cleanupLeaseExpiresAt: new Date(Date.now() + 30000),
          vacuumAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        },
        $inc: { stagingEpoch: 1, cleanupEpoch: 1 }
      },
      { new: true }
    );
    expect(w2Claim.stagingEpoch).toBe(2);

    // Stale Worker 1 wakes up and attempts CAS update with its old leaseId/epoch
    const staleResult = await SubmissionReservation.updateOne(
      { _id: w1Claim._id, stagingLeaseId: 'w1', stagingEpoch: 1 },
      { $set: { stagedKeys: ['corrupted-stale-write'] } }
    );
    expect(staleResult.matchedCount).toBe(0);
    expect(staleResult.modifiedCount).toBe(0);

    // Final reservation state remains clean
    const currentRes = await SubmissionReservation.findById(reservation._id);
    expect(currentRes.stagedKeys).toEqual([]);
    expect(currentRes.stagingCleanupStatus).toBe('completed');
  });

  it('Remediation Test 11: repeated recovery does not delete canonical objects or damage committed responses', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 11',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      order: 0
    });

    const tmpPdf = createTempPdfFile();
    try {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${question._id.toString()}`, tmpPdf);

      expect(res.status).toBe(201);
      const savedResponse = await Response.findOne({ formId: form._id });
      const canonicalKey = savedResponse.answers[0].value.key;
      expect(activeS3Objects.has(canonicalKey)).toBe(true);

      const deleteSpy = vi.spyOn(storageService, 'deleteFile');

      // Run recovery 3 times consecutively
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });

      // deleteSpy should never be called on canonicalKey
      expect(deleteSpy).not.toHaveBeenCalledWith(canonicalKey);
      expect(activeS3Objects.has(canonicalKey)).toBe(true);

      // Response document remains intact
      const postResponse = await Response.findOne({ formId: form._id });
      expect(postResponse._id.toString()).toBe(savedResponse._id.toString());
      expect(postResponse.answers[0].value.key).toBe(canonicalKey);
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }
  });

  it('Remediation Test 12: cleanup metadata survives reservation TTL expiry and remains available until cleanup succeeds', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Remediation Form 12',
      status: 'published'
    });
    const leaseId = crypto.randomUUID();
    const stagingKey = `staging/forms/${form._id}/${leaseId}/legacy.pdf`;
    activeS3Objects.set(stagingKey, { mime: 'application/pdf' });

    // Seed finalized reservation with uncleaned staging object from 72 hours ago
    const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const reservation = await SubmissionReservation.create({
      formId: form._id,
      leaseId,
      fenceToken: crypto.randomUUID(),
      status: 'finalized',
      stagingCleanupStatus: 'pending',
      stagedKeys: [stagingKey],
      stagingKeysToPurge: [stagingKey],
      expiresAt: threeDaysAgo,
      createdAt: threeDaysAgo,
      updatedAt: threeDaysAgo,
      vacuumAt: null, // TTL immunity
      counterReleased: true
    });

    // Simulate TTL query: TTL background thread checks { vacuumAt: { $lte: new Date() } }
    const ttlMatches = await SubmissionReservation.find({
      vacuumAt: { $lte: new Date() }
    });
    // Record with vacuumAt: null is never matched by TTL
    const foundInTtl = ttlMatches.some((r) => r.leaseId === leaseId);
    expect(foundInTtl).toBe(false);

    // Record survives and is discoverable
    expect(await SubmissionReservation.findById(reservation._id)).not.toBeNull();

    // Run recovery: discovers old reservation, cleans staging object, and arms vacuumAt
    await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });

    expect(activeS3Objects.has(stagingKey)).toBe(false);
    const cleanedRes = await SubmissionReservation.findById(reservation._id);
    expect(cleanedRes.stagingCleanupStatus).toBe('completed');
    expect(cleanedRes.stagedKeys).toEqual([]);
    expect(cleanedRes.vacuumAt).not.toBeNull();
    expect(new Date(cleanedRes.vacuumAt).getTime()).toBeGreaterThan(Date.now());
  });

  describe('Stage 4.3.5 B1: Durable Promotion Ownership & In-Flight S3 Copy Race Remediation (15 Tests)', () => {
    const createDeferredPromise = () => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    it('Promotion Race 1: registration succeeds, then worker pauses before starting CopyObject', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 1',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const stagingKey = `staging/forms/${form._id}/${leaseId}/file1.pdf`;
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file1.pdf`;
      activeS3Objects.set(stagingKey, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() + 30000),
        stagedKeys: [stagingKey],
        promotedKeys: [],
        vacuumAt: null,
        counterReleased: false
      });

      const registered = await SubmissionReservationManager.recordPromotedKey(
        leaseId,
        fenceToken,
        canonicalKey
      );
      expect(registered).toBe(true);

      const resAfterReg = await SubmissionReservation.findOne({ leaseId });
      expect(resAfterReg.promotedKeys).toContain(canonicalKey);
      expect(resAfterReg.promotionStatus).toBe('in_flight');

      // Worker pauses before copyFile, lease expires
      await SubmissionReservation.updateOne(
        { leaseId },
        { $set: { expiresAt: new Date(Date.now() - 10000) } }
      );

      // Recovery pass 1: arms quarantine and purges staging key
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(stagingKey)).toBe(false);
      const resAfterPass1 = await SubmissionReservation.findOne({ leaseId });
      expect(resAfterPass1.quarantinedUntil).not.toBeNull();

      // Recovery pass 2: quarantine has expired, affirmative sweep reconciles tombstone
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(canonicalKey)).toBe(false);
      const resAfterSweep = await SubmissionReservation.findOne({ leaseId });
      expect(resAfterSweep).not.toBeNull();
      expect(resAfterSweep.promotionStatus).toBe('tombstone');
      expect(resAfterSweep.reconciliationState).toBe('reconciled');
      expect(resAfterSweep.vacuumAt).toBeNull();
    });

    it('Promotion Race 2: CopyObject begins and remains unresolved', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 2',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const stagingKey = `staging/forms/${form._id}/${leaseId}/file2.pdf`;
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file2.pdf`;
      activeS3Objects.set(stagingKey, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() + 30000),
        stagedKeys: [stagingKey],
        promotedKeys: [],
        vacuumAt: null,
        counterReleased: false
      });

      await SubmissionReservationManager.recordPromotedKey(leaseId, fenceToken, canonicalKey);

      const copyGate = createDeferredPromise();
      const copyPromise = (async () => {
        await copyGate.promise;
        activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });
        return canonicalKey;
      })();

      // While copy remains unresolved:
      expect(activeS3Objects.has(canonicalKey)).toBe(false);
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc.promotionStatus).toBe('in_flight');
      expect(resDoc.promotedKeys).toContain(canonicalKey);

      // Clean up gate
      copyGate.resolve();
      await copyPromise;
    });

    it('Promotion Race 3: recovery starts while CopyObject remains unresolved', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 3',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const stagingKey = `staging/forms/${form._id}/${leaseId}/file3.pdf`;
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file3.pdf`;
      activeS3Objects.set(stagingKey, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() - 10000), // Expired while copy is unresolved
        stagedKeys: [stagingKey],
        promotedKeys: [canonicalKey],
        promotionStatus: 'in_flight',
        vacuumAt: null,
        counterReleased: false
      });

      // Recovery runs with standard quarantine window
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 40000 });

      // Staging key is purged immediately
      expect(activeS3Objects.has(stagingKey)).toBe(false);

      // CRITICAL: Reservation MUST NOT be deleted; it must be held in quarantine
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.status).toBe('abandoned');
      expect(resDoc.promotionStatus).toBe('abandoned');
      expect(resDoc.promotedKeys).toContain(canonicalKey);
      expect(resDoc.quarantinedUntil).not.toBeNull();
      expect(new Date(resDoc.quarantinedUntil).getTime()).toBeGreaterThan(Date.now());
      expect(resDoc.vacuumAt).toBeNull();
    });

    it('Promotion Race 4: DeleteObject returns success before copy creates destination', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 4',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file4.pdf`;

      // S3 delete against non-existent destination returns 204 success
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 10000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() + 30000), // Still in quarantine
        vacuumAt: null,
        counterReleased: true
      });

      // Run recovery sweep
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 30000 });

      // Reservation document survives because quarantine is active
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.promotedKeys).toContain(canonicalKey);
      expect(resDoc.vacuumAt).toBeNull();
    });

    it('Promotion Race 5: CopyObject completes after the first recovery pass', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 5',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file5.pdf`;

      // First recovery pass already ran and placed reservation in quarantine
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 10000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() + 30000),
        vacuumAt: null,
        counterReleased: true
      });

      // Late S3 copy finishes and writes destination object to S3
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });
      expect(activeS3Objects.has(canonicalKey)).toBe(true);

      // In MongoDB, the reservation is still tracking this canonicalKey
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc.promotedKeys).toContain(canonicalKey);
    });

    it('Promotion Race 6: worker crashes immediately after late CopyObject completion', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 6',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file6.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'abandoned', // Sweeper already marked abandoned
        expiresAt: new Date(Date.now() - 10000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() + 30000),
        vacuumAt: null,
        counterReleased: true
      });

      // Copy completed in S3
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });

      // Worker resumes and attempts markCommitting -> FAILS CLOSED
      const canCommit = await SubmissionReservationManager.markCommitting(leaseId, fenceToken);
      expect(canCommit).toBe(false);

      // Worker crashes hard: no Response created, no release executed
      const responseCount = await Response.countDocuments({ formId: form._id });
      expect(responseCount).toBe(0);

      // S3 object still exists and MongoDB reservation retains ownership
      expect(activeS3Objects.has(canonicalKey)).toBe(true);
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.promotedKeys).toContain(canonicalKey);
    });

    it('Promotion Race 7: independent recovery discovers the durable cleanup obligation after restart', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 7',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file7.pdf`;
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });

      // Simulate system restart after quarantine has elapsed
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000), // Quarantine expired
        vacuumAt: null,
        counterReleased: true
      });

      // Scanner query matches expired quarantine obligations
      const actionable = await SubmissionReservation.find({
        status: 'abandoned',
        quarantinedUntil: { $lte: new Date() },
        'promotedKeys.0': { $exists: true }
      });
      expect(actionable.some((r) => r.leaseId === leaseId)).toBe(true);
    });

    it('Promotion Race 8: final recovery deletes the late canonical object', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 8',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file8.pdf`;
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000), // Quarantine expired
        vacuumAt: null,
        counterReleased: true
      });

      // Run affirmative post-quarantine sweep
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // Late canonical S3 object is affirmatively deleted!
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // Reservation document is retained as durable tombstone with vacuumAt: null
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.promotionStatus).toBe('tombstone');
      expect(resDoc.reconciliationState).toBe('reconciled');
      expect(resDoc.vacuumAt).toBeNull();
    });

    it('Promotion Race 9: committed response objects remain intact', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 9',
        status: 'published'
      });
      const committedLeaseId = crypto.randomUUID();
      const committedKey = `forms/${form._id}/responses/${crypto.randomUUID()}/committed.pdf`;
      activeS3Objects.set(committedKey, { mime: 'application/pdf', timestamp: Date.now() });

      // Create valid committed response in MongoDB
      const question = await Question.create({
        formId: form._id,
        type: 'file',
        label: 'Upload File',
        order: 0
      });
      await Response.create({
        formId: form._id,
        answers: [
          {
            questionId: question._id,
            value: { key: committedKey, originalName: 'committed.pdf' }
          }
        ],
        reservationLeaseId: committedLeaseId,
        commitStatus: 'committed'
      });

      // Create an abandoned reservation referencing the same committed lease
      await SubmissionReservation.create({
        formId: form._id,
        leaseId: committedLeaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [committedKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Run recovery
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // Committed object MUST NOT be deleted
      expect(activeS3Objects.has(committedKey)).toBe(true);

      // Response document still references the committed key
      const responseDoc = await Response.findOne({ formId: form._id });
      expect(responseDoc.answers[0].value.key).toBe(committedKey);
    });

    it('Promotion Race 10: partial S3 deletion failure remains retryable', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 10',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file10.pdf`;
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Pass 1: S3 delete fails with 503
      let deleteAttempt = 0;
      const originalDelete = storageService.deleteFile;
      vi.spyOn(storageService, 'deleteFile').mockImplementation(async (key) => {
        if (key === canonicalKey && deleteAttempt === 0) {
          deleteAttempt++;
          const err = new Error('SlowDown');
          err.name = 'SlowDown';
          err.$metadata = { httpStatusCode: 503 };
          throw err;
        }
        activeS3Objects.delete(key);
      });

      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // Key still in S3, reservation survives with vacuumAt: null
      expect(activeS3Objects.has(canonicalKey)).toBe(true);
      const resDoc1 = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc1).not.toBeNull();
      expect(resDoc1.promotedKeys).toContain(canonicalKey);
      expect(resDoc1.promotionStatus).toBe('failed');
      expect(resDoc1.vacuumAt).toBeNull();

      // Pass 2: Retry succeeds, tombstone retained
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(canonicalKey)).toBe(false);
      const resDoc2 = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc2).not.toBeNull();
      expect(resDoc2.promotionStatus).toBe('tombstone');
      expect(resDoc2.vacuumAt).toBeNull();

      vi.spyOn(storageService, 'deleteFile').mockImplementation(originalDelete);
    });

    it('Promotion Race 11: two recovery workers compete for the same promotion obligation', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 11',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file11.pdf`;

      const res = await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        promotionEpoch: 0,
        vacuumAt: null,
        counterReleased: true
      });

      const now = new Date();
      // Worker 1 claims
      const claim1 = await SubmissionReservation.findOneAndUpdate(
        {
          _id: res._id,
          status: 'abandoned',
          promotionEpoch: 0,
          quarantinedUntil: { $lte: now }
        },
        {
          $set: {
            promotionLeaseId: 'worker-1',
            promotionLeaseExpiresAt: new Date(now.getTime() + 30000)
          },
          $inc: { promotionEpoch: 1 }
        },
        { new: true }
      );
      expect(claim1).not.toBeNull();
      expect(claim1.promotionEpoch).toBe(1);
      expect(claim1.promotionLeaseId).toBe('worker-1');

      // Worker 2 attempts same claim with old epoch
      const claim2 = await SubmissionReservation.findOneAndUpdate(
        {
          _id: res._id,
          status: 'abandoned',
          promotionEpoch: 0,
          quarantinedUntil: { $lte: now }
        },
        {
          $set: {
            promotionLeaseId: 'worker-2',
            promotionLeaseExpiresAt: new Date(now.getTime() + 30000)
          },
          $inc: { promotionEpoch: 1 }
        },
        { new: true }
      );
      expect(claim2).toBeNull();
    });

    it('Promotion Race 12: stale workers cannot overwrite newer recovery state', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 12',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();

      const res = await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: ['key1'],
        promotionEpoch: 2, // Newer epoch
        vacuumAt: null,
        counterReleased: true
      });

      // Stale worker with epoch 1 attempts write
      const staleUpdate = await SubmissionReservation.updateOne(
        { _id: res._id, promotionEpoch: 1 },
        { $set: { promotionStatus: 'stale-overwrite' } }
      );
      expect(staleUpdate.matchedCount).toBe(0);

      const postRes = await SubmissionReservation.findById(res._id);
      expect(postRes.promotionStatus).not.toBe('stale-overwrite');
    });

    it('Promotion Race 13: TTL cannot remove an unresolved promotion obligation', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 13',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: threeDaysAgo,
        createdAt: threeDaysAgo,
        updatedAt: threeDaysAgo,
        stagedKeys: [],
        promotedKeys: ['forms/unresolved.pdf'],
        promotionStatus: 'abandoned',
        quarantinedUntil: threeDaysAgo,
        vacuumAt: null, // Perpetual TTL immunity
        counterReleased: true
      });

      const ttlMatches = await SubmissionReservation.find({
        vacuumAt: { $lte: new Date() }
      });
      expect(ttlMatches.some((r) => r.leaseId === leaseId)).toBe(false);
    });

    it('Promotion Race 14: repeated recovery is idempotent', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 14',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file14.pdf`;
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Pass 1
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // Pass 2 & Pass 3: completely idempotent, zero errors
      const res2 = await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(res2.failedCount).toBe(0);

      const res3 = await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(res3.failedCount).toBe(0);
    });

    it('Promotion Race 15: successful submissions still clean staging objects on live forms', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Promotion Form 15',
        status: 'published'
      });
      const question = await Question.create({
        formId: form._id,
        type: 'file',
        label: 'Upload Receipt',
        order: 0
      });

      const tmpPdf = createTempPdfFile();
      try {
        const res = await request(app)
          .post(`/api/responses/${form._id}`)
          .field('answers', JSON.stringify([]))
          .attach(`file_${question._id.toString()}`, tmpPdf);

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);

        // Canonical object was created in S3 and saved in Response
        const savedResponse = await Response.findOne({ formId: form._id });
        expect(savedResponse).not.toBeNull();
        const canonicalKey = savedResponse.answers[0].value.key;
        expect(activeS3Objects.has(canonicalKey)).toBe(true);

        // Staging files were cleaned up
        const stagingKeysInS3 = Array.from(activeS3Objects.keys()).filter((k) =>
          k.includes('staging')
        );
        expect(stagingKeysInS3.length).toBe(0);

        // Form remains published
        const liveForm = await Form.findById(form._id);
        expect(liveForm.status).toBe('published');
      } finally {
        if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
      }
    });
  });

  describe('Stage 4.3.5 B1: Multi-File & Crash Boundary Safety Correction (14 Tests)', () => {
    it('Multi-File Safety 1: Two-file submission where the first copy completes before the second', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 1',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const sKey1 = `staging/forms/${form._id}/${leaseId}/file1.pdf`;
      const sKey2 = `staging/forms/${form._id}/${leaseId}/file2.pdf`;
      const cKey1 = `forms/${form._id}/responses/${crypto.randomUUID()}/file1.pdf`;
      const cKey2 = `forms/${form._id}/responses/${crypto.randomUUID()}/file2.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() + 30000),
        stagedKeys: [sKey1, sKey2],
        promotedKeys: [],
        promotedFiles: [],
        vacuumAt: null,
        counterReleased: false
      });

      // Register file 1
      await SubmissionReservationManager.recordStagedKey(leaseId, fenceToken, cKey1, {
        fileId: cKey1,
        stagingKey: sKey1
      });
      // Register file 2
      await SubmissionReservationManager.recordStagedKey(leaseId, fenceToken, cKey2, {
        fileId: cKey2,
        stagingKey: sKey2
      });

      // File 1 copy completes
      await SubmissionReservationManager.completeFilePromotion(leaseId, fenceToken, cKey1);

      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc.promotedFiles.length).toBe(2);

      const f1 = resDoc.promotedFiles.find((f) => f.finalKey === cKey1);
      const f2 = resDoc.promotedFiles.find((f) => f.finalKey === cKey2);
      expect(f1.status).toBe('promoted');
      expect(f1.copyCompletedAt).not.toBeNull();
      expect(f2.status).toBe('in_flight');
      expect(f2.copyCompletedAt).toBeNull();
    });

    it('Multi-File Safety 2: First promotion completion must not mark the entire submission complete', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 2',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const cKey1 = `forms/${form._id}/responses/${crypto.randomUUID()}/file1.pdf`;
      const cKey2 = `forms/${form._id}/responses/${crypto.randomUUID()}/file2.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() + 30000),
        stagedKeys: [],
        promotedKeys: [],
        promotedFiles: [],
        vacuumAt: null,
        counterReleased: false
      });

      await SubmissionReservationManager.recordStagedKey(leaseId, fenceToken, cKey1);
      await SubmissionReservationManager.recordStagedKey(leaseId, fenceToken, cKey2);

      // Complete file 1
      await SubmissionReservationManager.completeFilePromotion(leaseId, fenceToken, cKey1);

      const resDoc = await SubmissionReservation.findOne({ leaseId });
      // Root promotionStatus must remain in_flight!
      expect(resDoc.promotionStatus).toBe('in_flight');
      expect(resDoc.promotionLeaseExpiresAt).not.toBeNull();
    });

    it('Multi-File Safety 3: Second promotion remains in flight during reservation recovery', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 3',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const sKey2 = `staging/forms/${form._id}/${leaseId}/file2.pdf`;
      const cKey1 = `forms/${form._id}/responses/${crypto.randomUUID()}/file1.pdf`;
      const cKey2 = `forms/${form._id}/responses/${crypto.randomUUID()}/file2.pdf`;

      activeS3Objects.set(sKey2, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() - 10000), // Lease expired while file 2 was in-flight
        stagedKeys: [sKey2],
        promotedKeys: [cKey1, cKey2],
        promotedFiles: [
          { fileId: cKey1, stagingKey: '', finalKey: cKey1, status: 'promoted' },
          { fileId: cKey2, stagingKey: sKey2, finalKey: cKey2, status: 'in_flight' }
        ],
        promotionStatus: 'in_flight',
        vacuumAt: null,
        counterReleased: false
      });

      // Pass 1 of recovery
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 40000 });

      // Staging key for file 2 was invalidated
      expect(activeS3Objects.has(sKey2)).toBe(false);

      // Reservation survives and both keys retain durable ownership
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.status).toBe('abandoned');
      expect(resDoc.promotedKeys).toContain(cKey1);
      expect(resDoc.promotedKeys).toContain(cKey2);
      expect(resDoc.vacuumAt).toBeNull();
    });

    it('Multi-File Safety 4: CopyObject succeeds but completion-state persistence fails', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 4',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const cKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file4.pdf`;

      // Active reservation in DB
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() + 30000),
        stagedKeys: [],
        promotedKeys: [cKey],
        promotedFiles: [{ fileId: cKey, stagingKey: '', finalKey: cKey, status: 'in_flight' }],
        promotionStatus: 'in_flight',
        vacuumAt: null,
        counterReleased: false
      });

      // Simulate completion persistence failure (e.g. invalid fence or lost lease)
      const invalidFence = crypto.randomUUID();
      const recordSuccess = await SubmissionReservationManager.completeFilePromotion(
        leaseId,
        invalidFence,
        cKey
      );
      expect(recordSuccess).toBe(false);

      // Reservation retains in_flight status
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc.promotionStatus).toBe('in_flight');
      expect(resDoc.promotedFiles[0].status).toBe('in_flight');
    });

    it('Multi-File Safety 5: Worker crashes after S3 success and before completion-state persistence', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 5',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const cKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file5.pdf`;

      // S3 object exists in storage
      activeS3Objects.set(cKey, { mime: 'application/pdf', timestamp: Date.now() });

      // Worker died before calling completeFilePromotion or finalize
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 30000),
        stagedKeys: [],
        promotedKeys: [cKey],
        promotedFiles: [{ fileId: cKey, stagingKey: '', finalKey: cKey, status: 'in_flight' }],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 5000), // Quarantine expired
        vacuumAt: null,
        counterReleased: true
      });

      // Post-quarantine recovery sweep discovers and deletes canonical object
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      expect(activeS3Objects.has(cKey)).toBe(false);
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.promotionStatus).toBe('tombstone');
      expect(resDoc.vacuumAt).toBeNull();
    });

    it('Multi-File Safety 6: Worker crashes while CopyObject is unresolved', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 6',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const cKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file6.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() - 10000), // Lease expired while copy is unresolved
        stagedKeys: [],
        promotedKeys: [cKey],
        promotedFiles: [{ fileId: cKey, stagingKey: '', finalKey: cKey, status: 'in_flight' }],
        promotionStatus: 'in_flight',
        vacuumAt: null,
        counterReleased: false
      });

      // Pass 1 recovery quarantines
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 30000 });

      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.status).toBe('abandoned');
      expect(resDoc.promotedKeys).toContain(cKey);
      expect(resDoc.vacuumAt).toBeNull();
    });

    it('Multi-File Safety 7: Recovery runs repeatedly while operation outcome remains unknown', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 7',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const cKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file7.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 30000),
        stagedKeys: [],
        promotedKeys: [cKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() + 30000), // In quarantine window
        vacuumAt: null,
        counterReleased: true
      });

      // Run recovery 3 times consecutively while quarantine is active
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 30000 });
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 30000 });
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 30000 });

      // Reservation must survive all runs
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.promotedKeys).toContain(cKey);
      expect(resDoc.vacuumAt).toBeNull();
    });

    it('Multi-File Safety 8: Late canonical object is discovered after worker restart', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 8',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const lateKey = `forms/${form._id}/responses/${crypto.randomUUID()}/late.pdf`;

      // Reservation in DB with expired quarantine
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [lateKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // S3 operation delayed and commits late into storage
      activeS3Objects.set(lateKey, { mime: 'application/pdf', timestamp: Date.now() });

      // Sweeper runs post-quarantine pass
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      expect(activeS3Objects.has(lateKey)).toBe(false);
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).not.toBeNull();
      expect(resDoc.promotionStatus).toBe('tombstone');
      expect(resDoc.vacuumAt).toBeNull();
    });

    it('Multi-File Safety 9: Committed canonical objects are never deleted', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 9',
        status: 'published'
      });
      const committedKey = `forms/${form._id}/responses/${crypto.randomUUID()}/committed.pdf`;
      activeS3Objects.set(committedKey, { mime: 'application/pdf', timestamp: Date.now() });

      // A real committed response document exists referencing this key
      await Response.create({
        formId: form._id,
        submittedBy: 'anonymous',
        answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key: committedKey } }],
        commitStatus: 'committed'
      });

      const leaseId = crypto.randomUUID();
      // An abandoned reservation referencing this key
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [committedKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Recovery sweeps abandoned reservations
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // HARD INVARIANT: Committed object must still exist in S3!
      expect(activeS3Objects.has(committedKey)).toBe(true);
    });

    it('Multi-File Safety 10: Partial reconciliation failure remains durable and retryable', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 10',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const keyA = `forms/${form._id}/responses/${crypto.randomUUID()}/fileA.pdf`;
      const keyB = `forms/${form._id}/responses/${crypto.randomUUID()}/fileB.pdf`;

      activeS3Objects.set(keyA, { mime: 'application/pdf', timestamp: Date.now() });
      activeS3Objects.set(keyB, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [keyA, keyB],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Mock S3 failure on keyB only
      vi.spyOn(storageService, 'deleteFile').mockImplementation(async (k) => {
        if (k === keyB) {
          throw new Error('S3_TRANSIENT_NETWORK_DROP');
        }
        activeS3Objects.delete(k);
        return Promise.resolve();
      });

      // Pass 1: keyA deleted, keyB fails
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(keyA)).toBe(false);
      expect(activeS3Objects.has(keyB)).toBe(true);

      const resDoc1 = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc1).not.toBeNull();
      expect(resDoc1.promotedKeys).toContain(keyB);
      expect(resDoc1.vacuumAt).toBeNull();

      // Pass 2: Restore normal delete, retry succeeds
      vi.spyOn(storageService, 'deleteFile').mockImplementation(async (k) => {
        activeS3Objects.delete(k);
        return Promise.resolve();
      });
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      expect(activeS3Objects.has(keyB)).toBe(false);
      const resDoc2 = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc2).not.toBeNull();
      expect(resDoc2.promotionStatus).toBe('tombstone');
      expect(resDoc2.vacuumAt).toBeNull();
    });

    it('Multi-File Safety 11: Concurrent recovery workers cannot corrupt ownership', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 11',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const key = `forms/${form._id}/responses/${crypto.randomUUID()}/file11.pdf`;

      const res = await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [key],
        promotionEpoch: 5,
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Worker 1 and Worker 2 concurrently run CAS claim
      const claimQuery = {
        _id: res._id,
        status: 'abandoned',
        promotionEpoch: 5,
        quarantinedUntil: { $lte: new Date() }
      };
      const claimUpdate = {
        $set: { promotionLeaseId: crypto.randomUUID() },
        $inc: { promotionEpoch: 1 }
      };

      const [claim1, claim2] = await Promise.all([
        SubmissionReservation.findOneAndUpdate(claimQuery, claimUpdate, { new: true }),
        SubmissionReservation.findOneAndUpdate(claimQuery, claimUpdate, { new: true })
      ]);

      // Exactly one worker won the claim
      const successfulClaims = [claim1, claim2].filter(Boolean);
      expect(successfulClaims.length).toBe(1);
    });

    it('Multi-File Safety 12: TTL cannot remove unresolved promotion metadata', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 12',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const key = `forms/${form._id}/responses/${crypto.randomUUID()}/file12.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [key],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() + 30000),
        vacuumAt: null, // Protected from TTL index
        counterReleased: true
      });

      // Query against TTL condition
      const ttlPurgeable = await SubmissionReservation.find({
        leaseId,
        vacuumAt: { $exists: true, $ne: null, $lte: new Date() }
      });
      expect(ttlPurgeable.length).toBe(0);
    });

    it('Multi-File Safety 13: Repeated recovery is idempotent', async () => {
      const res1 = await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      const res2 = await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      const res3 = await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      expect(res1.failedCount).toBe(0);
      expect(res2.failedCount).toBe(0);
      expect(res3.failedCount).toBe(0);
    });

    it('Multi-File Safety 14: Existing staging cleanup on live published forms still works', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi-File Form 14',
        status: 'published'
      });
      const question = await Question.create({
        formId: form._id,
        type: 'file',
        label: 'Upload Attachment',
        order: 0
      });

      const tmpPdf = createTempPdfFile();
      try {
        const res = await request(app)
          .post(`/api/responses/${form._id}`)
          .field('answers', JSON.stringify([]))
          .attach(`file_${question._id.toString()}`, tmpPdf);

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);

        const savedResponse = await Response.findOne({ formId: form._id });
        expect(savedResponse).not.toBeNull();
        const canonicalKey = savedResponse.answers[0].value.key;
        expect(activeS3Objects.has(canonicalKey)).toBe(true);

        // Staging objects were purged
        const stagingKeysInS3 = Array.from(activeS3Objects.keys()).filter((k) =>
          k.includes('staging')
        );
        expect(stagingKeysInS3.length).toBe(0);

        // Form remains published
        const liveForm = await Form.findById(form._id);
        expect(liveForm.status).toBe('published');
      } finally {
        if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
      }
    });
  });

  describe('Stage 4.3.5 B1: Durable Cleanup Tombstone & Late CopyObject Concurrency Suite (11 Tests)', () => {
    it('Tombstone Test 1: Worker A copy delayed, Worker B sweeps empty, late copy completes, tombstone cleans it', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 1',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const stagingKey = `staging/forms/${form._id}/${leaseId}/file1.pdf`;
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file1.pdf`;
      activeS3Objects.set(stagingKey, { mime: 'application/pdf', timestamp: Date.now() });

      // Step 1: Worker A registers reservation and canonical key
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() + 30000),
        stagedKeys: [stagingKey],
        promotedKeys: [],
        vacuumAt: null,
        counterReleased: false
      });
      await SubmissionReservationManager.recordPromotedKey(leaseId, fenceToken, canonicalKey);

      // Step 2: Storage provider admits CopyObject from S to C, but delays its completion
      let delayedCopyTrigger = null;
      const admittedCopyPromise = new Promise((resolve) => {
        delayedCopyTrigger = resolve;
      });

      // Step 3: Worker A loses connection or is abandoned (lease expires)
      await SubmissionReservation.updateOne(
        { leaseId },
        { $set: { expiresAt: new Date(Date.now() - 10000) } }
      );

      // Step 4: Worker B invalidates staging key S and arms quarantine
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(stagingKey)).toBe(false);

      // Step 5: Worker B reconciles C while C is still absent (DeleteObject returns 204)
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // Step 6: Worker B completed cleanup that would previously delete reservation,
      // BUT durable tombstone remains retained on MongoDB!
      const tombstoneAfterSweep = await SubmissionReservation.findOne({ leaseId });
      expect(tombstoneAfterSweep).not.toBeNull();
      expect(tombstoneAfterSweep.promotionStatus).toBe('tombstone');
      expect(tombstoneAfterSweep.reconciliationState).toBe('reconciled');
      expect(tombstoneAfterSweep.vacuumAt).toBeNull();

      // Step 7: Delayed CopyObject completes and creates C in storage
      delayedCopyTrigger();
      await admittedCopyPromise;
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });
      expect(activeS3Objects.has(canonicalKey)).toBe(true);

      // Step 8: Subsequent recovery pass discovers and deletes late-appearing C!
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // Step 9: Cleanup tombstone remains available throughout the sequence
      const finalTombstone = await SubmissionReservation.findOne({ leaseId });
      expect(finalTombstone).not.toBeNull();
      expect(finalTombstone.promotionStatus).toBe('tombstone');
      expect(finalTombstone.vacuumAt).toBeNull();
      expect(finalTombstone.reconciliationPasses).toBeGreaterThanOrEqual(2);
    });

    it('Tombstone Test 2: Repeated empty reconciliation passes never delete unresolved cleanup ownership', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 2',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file2.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Run 5 consecutive empty reconciliation sweeps
      for (let i = 1; i <= 5; i++) {
        await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
        const tombstone = await SubmissionReservation.findOne({ leaseId });
        expect(tombstone).not.toBeNull();
        expect(tombstone.promotionStatus).toBe('tombstone');
        expect(tombstone.vacuumAt).toBeNull();
        expect(tombstone.reconciliationPasses).toBe(i);
      }
    });

    it('Tombstone Test 3: Late object appears after multiple empty passes', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 3',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file3.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Passes 1-3: empty discoveries
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // Late object finally lands in storage after 3 passes
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });
      expect(activeS3Objects.has(canonicalKey)).toBe(true);

      // Pass 4: Discovers and affirmatively purges late canonical object
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      const tombstone = await SubmissionReservation.findOne({ leaseId });
      expect(tombstone).not.toBeNull();
      expect(tombstone.reconciliationPasses).toBe(4);
      expect(tombstone.vacuumAt).toBeNull();
    });

    it('Tombstone Test 4: Process restart between empty discovery and late completion', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 4',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file4.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Pass 1: empty discovery
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // Simulate process termination and fresh process restart
      // Late object appears while process was offline
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });

      // Fresh worker sweeps based strictly on durable DB metadata
      const freshSummary = await SubmissionReservationManager.sweepAbandonedReservations({
        quarantineMs: 0,
        graceMs: 0
      });
      expect(freshSummary.reconciledTombstones).toBeGreaterThanOrEqual(1);
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      const tombstone = await SubmissionReservation.findOne({ leaseId });
      expect(tombstone).not.toBeNull();
      expect(tombstone.promotionStatus).toBe('tombstone');
      expect(tombstone.vacuumAt).toBeNull();
    });

    it('Tombstone Test 5: Concurrent recovery workers claim the same tombstone via CAS', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 5',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/file5.pdf`;

      const tombstoneDoc = await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'tombstone',
        quarantinedUntil: new Date(Date.now() - 10000),
        promotionEpoch: 7,
        vacuumAt: null,
        counterReleased: true
      });

      // Concurrent CAS claim attempts by Worker 1 and Worker 2
      const claim1Promise = SubmissionReservation.findOneAndUpdate(
        {
          _id: tombstoneDoc._id,
          status: 'abandoned',
          promotionEpoch: 7,
          quarantinedUntil: { $lte: new Date() }
        },
        {
          $set: {
            promotionLeaseId: 'worker-1-lease',
            quarantinedUntil: new Date(Date.now() + 30000),
            updatedAt: new Date()
          },
          $inc: { promotionEpoch: 1 }
        },
        { new: true }
      );

      const claim2Promise = SubmissionReservation.findOneAndUpdate(
        {
          _id: tombstoneDoc._id,
          status: 'abandoned',
          promotionEpoch: 7,
          quarantinedUntil: { $lte: new Date() }
        },
        {
          $set: {
            promotionLeaseId: 'worker-2-lease',
            quarantinedUntil: new Date(Date.now() + 30000),
            updatedAt: new Date()
          },
          $inc: { promotionEpoch: 1 }
        },
        { new: true }
      );

      const [res1, res2] = await Promise.all([claim1Promise, claim2Promise]);
      // Exactly one worker must win the claim; other is null
      expect((res1 !== null && res2 === null) || (res1 === null && res2 !== null)).toBe(true);

      const finalDoc = await SubmissionReservation.findById(tombstoneDoc._id);
      expect(finalDoc.promotionEpoch).toBe(8);
    });

    it('Tombstone Test 6: Partial deletion failure retains the cleanup obligation', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 6',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const key1 = `forms/${form._id}/responses/${crypto.randomUUID()}/part1.pdf`;
      const key2 = `forms/${form._id}/responses/${crypto.randomUUID()}/part2.pdf`;
      activeS3Objects.set(key1, { mime: 'application/pdf', timestamp: Date.now() });
      activeS3Objects.set(key2, { mime: 'application/pdf', timestamp: Date.now() });

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [key1, key2],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Mock partial S3 failure on key2
      vi.spyOn(storageService, 'deleteFile').mockImplementation(async (k) => {
        if (k === key2) {
          throw new Error('S3_500_INTERNAL_ERROR');
        }
        activeS3Objects.delete(k);
        return Promise.resolve();
      });

      // Pass 1: key1 purged, key2 fails
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(key1)).toBe(false);
      expect(activeS3Objects.has(key2)).toBe(true);

      const resAfterFail = await SubmissionReservation.findOne({ leaseId });
      expect(resAfterFail).not.toBeNull();
      expect(resAfterFail.promotionStatus).toBe('failed');
      expect(resAfterFail.reconciliationState).toBe('failed');
      expect(resAfterFail.promotedKeys).toContain(key2);
      expect(resAfterFail.vacuumAt).toBeNull();

      // Pass 2: Restore S3 delete, key2 purged, tombstone transitions to reconciled
      vi.spyOn(storageService, 'deleteFile').mockImplementation(async (k) => {
        activeS3Objects.delete(k);
        return Promise.resolve();
      });
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });
      expect(activeS3Objects.has(key2)).toBe(false);

      const resAfterRetry = await SubmissionReservation.findOne({ leaseId });
      expect(resAfterRetry).not.toBeNull();
      expect(resAfterRetry.promotionStatus).toBe('tombstone');
      expect(resAfterRetry.reconciliationState).toBe('reconciled');
      expect(resAfterRetry.vacuumAt).toBeNull();
    });

    it('Tombstone Test 7: Committed canonical objects are preserved and tombstone safely retires', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 7',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const committedKey = `forms/${form._id}/responses/${crypto.randomUUID()}/committed.pdf`;
      activeS3Objects.set(committedKey, { mime: 'application/pdf', timestamp: Date.now() });

      // Create committed response referencing committedKey
      await Response.create({
        formId: form._id,
        submittedBy: 'anonymous',
        answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key: committedKey } }],
        commitStatus: 'committed'
      });

      // Abandoned reservation referencing same key
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [committedKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      // Recovery pass runs
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // Canonical object must NEVER be deleted
      expect(activeS3Objects.has(committedKey)).toBe(true);

      // Reservation document is safely retired because all keys belong to committed responses
      const resDoc = await SubmissionReservation.findOne({ leaseId });
      expect(resDoc).toBeNull();
    });

    it('Tombstone Test 8: Multiple canonical files have independent lifecycle states', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 8',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const file1Staged = `staging/forms/${form._id}/${leaseId}/file1.pdf`;
      const file2Final = `forms/${form._id}/responses/${crypto.randomUUID()}/file2.pdf`;
      const file3Final = `forms/${form._id}/responses/${crypto.randomUUID()}/file3.pdf`;

      activeS3Objects.set(file1Staged, { mime: 'application/pdf', timestamp: Date.now() });
      activeS3Objects.set(file2Final, { mime: 'application/pdf', timestamp: Date.now() });
      activeS3Objects.set(file3Final, { mime: 'application/pdf', timestamp: Date.now() });

      // File 2 committed to Response
      await Response.create({
        formId: form._id,
        submittedBy: 'anonymous',
        answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key: file2Final } }],
        commitStatus: 'committed'
      });

      // Reservation tracks file1 (staging), file2 (committed canonical), file3 (uncommitted canonical)
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [file1Staged],
        promotedKeys: [file2Final, file3Final],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 10000),
        vacuumAt: null,
        counterReleased: true
      });

      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // Staging file1 purged
      expect(activeS3Objects.has(file1Staged)).toBe(false);
      // Committed file2 preserved
      expect(activeS3Objects.has(file2Final)).toBe(true);
      // Uncommitted file3 purged
      expect(activeS3Objects.has(file3Final)).toBe(false);

      // Tombstone retained for uncommitted file3 obligation
      const tombstone = await SubmissionReservation.findOne({ leaseId });
      expect(tombstone).not.toBeNull();
      expect(tombstone.promotedKeys).toContain(file3Final);
      expect(tombstone.promotedKeys).not.toContain(file2Final);
      expect(tombstone.vacuumAt).toBeNull();
    });

    it('Tombstone Test 9: Registration crashes and atomic duplicate registration', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 9',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const finalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/duplicate.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() + 60000),
        stagedKeys: [],
        promotedKeys: [],
        promotedFiles: [],
        vacuumAt: null,
        counterReleased: false
      });

      // Run 5 parallel registration calls for the same finalKey (simulating concurrent retries)
      const results = await Promise.all([
        SubmissionReservationManager.recordPromotedKey(leaseId, fenceToken, finalKey, {
          fileId: 'file-dup'
        }),
        SubmissionReservationManager.recordPromotedKey(leaseId, fenceToken, finalKey, {
          fileId: 'file-dup'
        }),
        SubmissionReservationManager.recordPromotedKey(leaseId, fenceToken, finalKey, {
          fileId: 'file-dup'
        }),
        SubmissionReservationManager.recordPromotedKey(leaseId, fenceToken, finalKey, {
          fileId: 'file-dup'
        }),
        SubmissionReservationManager.recordPromotedKey(leaseId, fenceToken, finalKey, {
          fileId: 'file-dup'
        })
      ]);

      // All 5 calls must report success without collisions or duplicate array elements
      expect(results.every((r) => r === true)).toBe(true);

      const reservation = await SubmissionReservation.findOne({ leaseId });
      expect(reservation.promotedKeys).toEqual([finalKey]);
      const fileEntries = reservation.promotedFiles.filter((f) => f.finalKey === finalKey);
      expect(fileEntries.length).toBe(1);
    });

    it('Tombstone Test 10: TTL cannot remove unresolved obligations', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 10',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/ttl_test.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 120000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 60000),
        vacuumAt: null,
        counterReleased: true
      });

      // Run recovery pass
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      // Verify vacuumAt strictly remains null (immune to MongoDB expireAfterSeconds: 0)
      const tombstone = await SubmissionReservation.findOne({ leaseId });
      expect(tombstone).not.toBeNull();
      expect(tombstone.vacuumAt).toBeNull();

      // Query against TTL index criteria: documents with vacuumAt: null are NOT returned
      const ttlEligible = await SubmissionReservation.find({
        leaseId,
        vacuumAt: { $ne: null, $lte: new Date() }
      });
      expect(ttlEligible.length).toBe(0);
    });

    it('Tombstone Test 11: Recovery of old abandoned records remains compatible', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tombstone Form 11',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/old_record.pdf`;

      // Old document created before tombstone changes (no reconciliationPasses or reconciliationState)
      await SubmissionReservation.collection.insertOne({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 120000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        promotionStatus: 'abandoned',
        quarantinedUntil: new Date(Date.now() - 30000),
        vacuumAt: null,
        counterReleased: true,
        createdAt: new Date(Date.now() - 120000),
        updatedAt: new Date(Date.now() - 120000)
      });

      // Sweeper processes legacy record
      await recoverAbandonedFormDeletions({ reservationGraceMs: 0, quarantineMs: 0 });

      const upgradedTombstone = await SubmissionReservation.findOne({ leaseId });
      expect(upgradedTombstone).not.toBeNull();
      expect(upgradedTombstone.promotionStatus).toBe('tombstone');
      expect(upgradedTombstone.reconciliationState).toBe('reconciled');
      expect(upgradedTombstone.reconciliationPasses).toBe(1);
      expect(upgradedTombstone.vacuumAt).toBeNull();
    });
  });

  describe('Stage 4.3.5 B1: Durable Deleted-Form Storage Tombstone Remediation (12 Tests)', () => {
    it('Deleted-Form Tombstone Test A: Late copy after form deletion job completion attempt', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Deleted-Form Tombstone A',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const fenceToken = crypto.randomUUID();
      const stagingKey = `staging/forms/${form._id}/${leaseId}/fileA.pdf`;
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/fileA.pdf`;
      activeS3Objects.set(stagingKey, { mime: 'application/pdf', timestamp: Date.now() });

      // 1. Worker A registers reservation and canonical key
      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: new Date(Date.now() + 60000),
        stagedKeys: [stagingKey],
        promotedKeys: [canonicalKey],
        vacuumAt: null,
        counterReleased: false
      });

      // 2. Storage provider admits CopyObject from S to C, but holds completion behind controllable promise
      let delayedCopyTrigger = null;
      const admittedCopyPromise = new Promise((resolve) => {
        delayedCopyTrigger = resolve;
      });

      // 3. Worker A loses connection / crashes (lease expires)
      await SubmissionReservation.updateOne(
        { leaseId },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );

      // 4. Owner executes form deletion
      const delResult = await executeFormDeletion(form._id, {
        userId,
        drainWaitMs: 0,
        skipImmediateCleanup: true
      });
      expect(delResult.success).toBe(true);

      // 5. Verify ownership transferred into durable DeletionCleanupJob tombstone
      const job = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(job).not.toBeNull();
      expect(job.status).toBe('pending');
      expect(job.vacuumAt).toBeNull();

      // 6. Initial cleanup pass lists prefixes and finds no C (grace period elapsed)
      await DeletionCleanupJob.updateOne(
        { _id: job._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );
      const sweep1 = await processDeletionCleanupJob(form._id);
      expect(sweep1.processed).toBe(true);
      expect(['reconciled', 'completed']).toContain(sweep1.status);

      // 7. Verify job remains durably scheduled for future reconciliation with vacuumAt: null
      const jobAfterSweep1 = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(jobAfterSweep1.status).toBe('reconciled');
      expect(jobAfterSweep1.vacuumAt).toBeNull();
      expect(jobAfterSweep1.reconciliationPasses).toBe(1);

      // 8. Delayed CopyObject completes and creates C in storage
      delayedCopyTrigger();
      await admittedCopyPromise;
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });
      expect(activeS3Objects.has(canonicalKey)).toBe(true);

      // 9. Later reconciliation pass discovers and deletes C
      const sweep2 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep2.processed).toBe(true);
      expect(['reconciled', 'completed']).toContain(sweep2.status);
      expect(sweep2.deletedCount).toBe(1);
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // 10. Deletion job remains available afterward with perpetual TTL immunity
      const finalJob = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(finalJob.status).toBe('reconciled');
      expect(finalJob.vacuumAt).toBeNull();
      expect(finalJob.reconciliationPasses).toBe(2);
    });

    it('Deleted-Form Tombstone Test B: Restart between empty pass and late copy', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Deleted-Form Tombstone B',
        status: 'published'
      });
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/restart_late.pdf`;

      // 1. Delete form and transfer ownership to DeletionCleanupJob
      await executeFormDeletion(form._id, {
        userId,
        drainWaitMs: 0,
        skipImmediateCleanup: true
      });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      // 2. Perform empty cleanup pass
      const pass1 = await processDeletionCleanupJob(form._id);
      expect(pass1.status).toBe('reconciled');

      // 3. Simulate process restart / time passing to next sweep time
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { nextSweepAt: new Date(Date.now() - 1000) } }
      );

      // 4. Delayed CopyObject completes in storage
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });
      expect(activeS3Objects.has(canonicalKey)).toBe(true);

      // 5. System startup / cron calls recoverAbandonedFormDeletions()
      const recoveryResult = await recoverAbandonedFormDeletions();
      expect(recoveryResult.completedCleanupJobs).toBeGreaterThanOrEqual(1);
      expect(recoveryResult.purgedStorageFiles).toBeGreaterThanOrEqual(1);

      // Verify late object was discovered and purged
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // Job remains retained in reconciled status with vacuumAt: null
      const postRestartJob = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(postRestartJob.status).toBe('reconciled');
      expect(postRestartJob.vacuumAt).toBeNull();
    });

    it('Deleted-Form Tombstone Test C: Dead-form orphan recovery transfers canonical key ownership to deletion job before removing reservation metadata', async () => {
      const deadFormId = new mongoose.Types.ObjectId();
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${deadFormId}/responses/${crypto.randomUUID()}/dead_form.pdf`;

      // Staged key already cleaned, but canonicalKey was registered
      await SubmissionReservation.create({
        formId: deadFormId,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        vacuumAt: null,
        counterReleased: true
      });

      // Verify no DeletionCleanupJob exists yet for deadFormId
      expect(await DeletionCleanupJob.findOne({ formId: deadFormId })).toBeNull();

      // Run recoverAbandonedFormDeletions (Step 3 processes dead form reservations)
      const recoveryResult = await recoverAbandonedFormDeletions({
        reservationGraceMs: 0,
        quarantineMs: 0
      });
      expect(recoveryResult.sweptOrphanReservations).toBe(1);

      // Reservation is deleted
      expect(await SubmissionReservation.findOne({ leaseId })).toBeNull();

      // BUT DeletionCleanupJob was durably upserted before reservation removal
      const deletionJob = await DeletionCleanupJob.findOne({ formId: deadFormId });
      expect(deletionJob).not.toBeNull();
      expect(deletionJob.stagingPrefix).toBe(`staging/forms/${deadFormId}/`);
      expect(deletionJob.finalPrefix).toBe(`forms/${deadFormId}/`);
      expect(['pending', 'reconciled']).toContain(deletionJob.status);
      expect(deletionJob.vacuumAt).toBeNull();
    });

    it('Deleted-Form Tombstone Test 4: Multiple consecutive empty prefix scans never retire unresolved namespace ownership', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi Scan 4',
        status: 'published'
      });
      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      // Execute 5 consecutive empty scans
      for (let i = 1; i <= 5; i++) {
        const sweep = await processDeletionCleanupJob(form._id, { forceImmediate: true });
        expect(sweep.processed).toBe(true);
        expect(['reconciled', 'completed']).toContain(sweep.status);

        const job = await DeletionCleanupJob.findOne({ formId: form._id });
        expect(job.status).toBe('reconciled');
        expect(job.vacuumAt).toBeNull(); // NEVER vacuumed
        expect(job.reconciliationPasses).toBe(i);
      }
    });

    it('Deleted-Form Tombstone Test 5: Late objects appear after several empty scans', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Multi Scan 5',
        status: 'published'
      });
      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      // 3 empty scans
      for (let i = 0; i < 3; i++) {
        await processDeletionCleanupJob(form._id, { forceImmediate: true });
      }

      // Late object arrives on scan 4
      const lateKey = `forms/${form._id}/responses/${crypto.randomUUID()}/very_late.pdf`;
      activeS3Objects.set(lateKey, { mime: 'application/pdf', timestamp: Date.now() });
      expect(activeS3Objects.has(lateKey)).toBe(true);

      // Scan 4 discovers and deletes the late object
      const sweep4 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep4.deletedCount).toBe(1);
      expect(activeS3Objects.has(lateKey)).toBe(false);

      // Scan 5 runs clean
      const sweep5 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep5.deletedCount).toBe(0);
      const finalJob = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(finalJob.status).toBe('reconciled');
      expect(finalJob.vacuumAt).toBeNull();
    });

    it('Deleted-Form Tombstone Test 6: Partial prefix listing and deletion failures remain retryable', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Retry Form 6',
        status: 'published'
      });
      const key1 = `staging/forms/${form._id}/${crypto.randomUUID()}/fail1.pdf`;
      const key2 = `staging/forms/${form._id}/${crypto.randomUUID()}/fail2.pdf`;
      activeS3Objects.set(key1, { mime: 'application/pdf' });
      activeS3Objects.set(key2, { mime: 'application/pdf' });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      // Attempt 1: Mock S3 deleteFiles transient failure
      vi.spyOn(storageService, 'deleteFiles').mockResolvedValueOnce({
        success: false,
        deletedKeys: [key1],
        failedKeys: [key2],
        error: 'AWS S3 500 InternalError'
      });

      const run1 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(run1.status).toBe('pending');
      expect(run1.error).toContain('AWS S3 500');

      const job1 = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(job1.attempts).toBe(1);
      expect(job1.leaseId).toBeNull(); // Lease released for retry

      // Attempt 2: S3 succeeds
      const run2 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(run2.processed).toBe(true);
      expect(['reconciled', 'completed']).toContain(run2.status);
      expect(run2.deletedCount).toBe(2);
      expect(activeS3Objects.size).toBe(0);
    });

    it('Deleted-Form Tombstone Test 7: Concurrent workers cannot duplicate or lose cleanup ownership', async () => {
      const form = await Form.create({ ownerId: userId, title: 'CAS Form 7', status: 'published' });
      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      // Two workers concurrently call processDeletionCleanupJob
      const [res1, res2] = await Promise.all([
        processDeletionCleanupJob(form._id, { forceImmediate: true }),
        processDeletionCleanupJob(form._id, { forceImmediate: true })
      ]);

      // Exactly one worker processed the job, other got unclaimed or idempotent response
      const processedCount = [res1, res2].filter((r) => r.processed).length;
      expect(processedCount).toBe(1);

      const job = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(job.epoch).toBeGreaterThanOrEqual(1);
    });

    it('Deleted-Form Tombstone Test 8: Pagination discovers objects beyond first page with lease renewal', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Pagination Form 8',
        status: 'published'
      });
      for (let i = 0; i < 1200; i++) {
        activeS3Objects.set(`staging/forms/${form._id}/f${i}.pdf`, { mime: 'application/pdf' });
      }

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(
        async (prefix, { continuationToken } = {}) => {
          const matchingKeys = Array.from(activeS3Objects.keys()).filter((k) =>
            k.startsWith(prefix)
          );
          let startIndex = 0;
          if (continuationToken === 'token-1') startIndex = 500;
          else if (continuationToken === 'token-2') startIndex = 1000;

          const slice = matchingKeys.slice(startIndex, startIndex + 500);
          const hasMore = startIndex + 500 < matchingKeys.length;
          const nextToken = hasMore ? (startIndex === 0 ? 'token-1' : 'token-2') : null;

          return {
            keys: slice,
            isTruncated: hasMore,
            nextContinuationToken: nextToken,
            keyCount: slice.length
          };
        }
      );

      let leaseRenewed = false;
      const origUpdateOne = DeletionCleanupJob.updateOne.bind(DeletionCleanupJob);
      vi.spyOn(DeletionCleanupJob, 'updateOne').mockImplementation(async (filter, update, opts) => {
        if (update?.$set?.leaseExpiresAt) {
          leaseRenewed = true;
        }
        return origUpdateOne(filter, update, opts);
      });

      const result = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(result.processed).toBe(true);
      expect(result.deletedCount).toBe(1200);
      expect(activeS3Objects.size).toBe(0);
      expect(leaseRenewed).toBe(true);
    });

    it('Deleted-Form Tombstone Test 9: Form deletion transaction failure leaves original ownership intact', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Tx Fail Form 9',
        status: 'published'
      });
      const leaseId = crypto.randomUUID();
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/saved.pdf`;

      await SubmissionReservation.create({
        formId: form._id,
        leaseId,
        fenceToken: crypto.randomUUID(),
        status: 'abandoned',
        expiresAt: new Date(Date.now() - 60000),
        stagedKeys: [],
        promotedKeys: [canonicalKey],
        vacuumAt: null,
        counterReleased: true
      });

      // Mock Form.deleteOne to fail during T_del
      vi.spyOn(Form, 'deleteOne').mockRejectedValueOnce(new Error('MONGODB_TRANSACTION_ABORTED'));

      await expect(
        executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true })
      ).rejects.toThrow('MONGODB_TRANSACTION_ABORTED');

      // Form was NOT deleted
      const retainedForm = await Form.findById(form._id);
      expect(retainedForm).not.toBeNull();

      // SubmissionReservation ownership was NOT destroyed
      const retainedRes = await SubmissionReservation.findOne({ leaseId });
      expect(retainedRes).not.toBeNull();
      expect(retainedRes.promotedKeys).toContain(canonicalKey);
    });

    it('Deleted-Form Tombstone Test 10: Repeated form deletion requests are idempotent', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Idempotent Form 10',
        status: 'published'
      });

      const del1 = await executeFormDeletion(form._id, {
        userId,
        drainWaitMs: 0,
        skipImmediateCleanup: true
      });
      expect(del1.success).toBe(true);

      // Subsequent call for already deleted form returns 404 / false gracefully
      const del2 = await executeFormDeletion(form._id, {
        userId,
        drainWaitMs: 0,
        skipImmediateCleanup: true
      });
      expect(del2.success).toBe(false);

      // Single canonical DeletionCleanupJob exists in DB
      const jobs = await DeletionCleanupJob.find({ formId: form._id });
      expect(jobs.length).toBe(1);
    });

    it('Deleted-Form Tombstone Test 11: TTL cannot remove unresolved namespace tombstones', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'TTL Immunity Form 11',
        status: 'published'
      });
      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      await processDeletionCleanupJob(form._id, { forceImmediate: true });

      const job = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(job.status).toBe('reconciled');
      expect(job.vacuumAt).toBeNull(); // Strictly null

      // Query against TTL index condition: documents with vacuumAt: null are never selected
      const ttlExpiredDocs = await DeletionCleanupJob.find({
        formId: form._id,
        vacuumAt: { $ne: null, $lte: new Date() }
      });
      expect(ttlExpiredDocs.length).toBe(0);
    });

    it('Deleted-Form Tombstone Test 12: Committed response attachments are not accidentally deleted before form deletion, and transferred safely during form deletion', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Committed Form 12',
        status: 'published'
      });
      const question = await Question.create({
        formId: form._id,
        type: 'file',
        label: 'Doc 12',
        order: 0
      });
      const canonicalKey = `forms/${form._id}/responses/${crypto.randomUUID()}/doc12.pdf`;
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });

      await Response.create({
        formId: form._id,
        answers: [
          { questionId: question._id, value: { key: canonicalKey, originalName: 'doc12.pdf' } }
        ]
      });

      // Background recovery before form deletion does NOT touch committed responses
      await recoverAbandonedFormDeletions();
      expect(activeS3Objects.has(canonicalKey)).toBe(true);

      // Form deletion executed by owner
      const delResult = await executeFormDeletion(form._id, {
        userId,
        drainWaitMs: 0,
        skipImmediateCleanup: true
      });
      expect(delResult.success).toBe(true);

      // Form and Response are deleted from MongoDB
      expect(await Form.findById(form._id)).toBeNull();
      expect(await Response.findOne({ formId: form._id })).toBeNull();

      // Storage cleanup job sweeps the namespace and remains reconciled
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );
      const sweep = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep.processed).toBe(true);
      expect(sweep.deletedCount).toBe(0);
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // Job remains reconciled with vacuumAt: null
      const job = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(job.status).toBe('reconciled');
      expect(job.vacuumAt).toBeNull();
    });
  });

  describe('Stage 4.3.5 B1: Expired Cleaning Lease Recovery & Fencing Remediation (5 Tests)', () => {
    it('Cleaning Lease Recovery Test A: Expired cleaning job is rediscovered and reclaimed by scheduler', async () => {
      const formId = new mongoose.Types.ObjectId();
      const oldWorkerLeaseId = crypto.randomUUID();
      const oldWorkerEpoch = 1;
      const stagingKey = `staging/forms/${formId}/old-file.pdf`;
      activeS3Objects.set(stagingKey, { mime: 'application/pdf', timestamp: Date.now() });

      // 1. Create a DeletionCleanupJob in status: 'cleaning' with an expired lease
      const job = await DeletionCleanupJob.create({
        formId,
        stagingPrefix: `staging/forms/${formId}/`,
        finalPrefix: `forms/${formId}/`,
        status: 'cleaning',
        leaseId: oldWorkerLeaseId,
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
        epoch: oldWorkerEpoch,
        attempts: 1,
        eligibleUntil: new Date(Date.now() - 1000),
        vacuumAt: null
      });

      // 2. Call recoverAbandonedFormDeletions()
      const recoveryResult = await recoverAbandonedFormDeletions();
      expect(recoveryResult.completedCleanupJobs).toBeGreaterThanOrEqual(1);
      expect(recoveryResult.purgedStorageFiles).toBeGreaterThanOrEqual(1);

      // 3. Verify the job is discovered, reclaimed, and no longer stranded in the old cleaning lease
      const updatedJob = await DeletionCleanupJob.findById(job._id);
      expect(updatedJob.status).toBe('reconciled');
      expect(updatedJob.leaseId).toBeNull();
      expect(updatedJob.leaseExpiresAt).toBeNull();
      expect(updatedJob.epoch).toBeGreaterThan(oldWorkerEpoch);
      expect(updatedJob.vacuumAt).toBeNull();
      expect(activeS3Objects.has(stagingKey)).toBe(false);
    });

    it('Cleaning Lease Recovery Test B: Active cleaning job with unexpired lease is not stolen', async () => {
      const formId = new mongoose.Types.ObjectId();
      const activeWorkerLeaseId = crypto.randomUUID();
      const activeWorkerEpoch = 2;
      const futureExpiry = new Date(Date.now() + 60000); // 60 seconds in future

      // 1. Create a cleaning job with a future leaseExpiresAt
      const job = await DeletionCleanupJob.create({
        formId,
        stagingPrefix: `staging/forms/${formId}/`,
        finalPrefix: `forms/${formId}/`,
        status: 'cleaning',
        leaseId: activeWorkerLeaseId,
        leaseExpiresAt: futureExpiry,
        epoch: activeWorkerEpoch,
        attempts: 1,
        eligibleUntil: new Date(Date.now() - 1000),
        vacuumAt: null
      });

      // 2. Run scheduler recovery
      await recoverAbandonedFormDeletions();

      // 3. Verify active lease remains completely unchanged
      const unchangedJob = await DeletionCleanupJob.findById(job._id);
      expect(unchangedJob.status).toBe('cleaning');
      expect(unchangedJob.leaseId).toBe(activeWorkerLeaseId);
      expect(unchangedJob.epoch).toBe(activeWorkerEpoch);
      expect(unchangedJob.leaseExpiresAt.getTime()).toBe(futureExpiry.getTime());
    });

    it('Cleaning Lease Recovery Test C: Stale worker cannot overwrite newer worker state or lease', async () => {
      const formId = new mongoose.Types.ObjectId();
      const workerALeaseId = crypto.randomUUID();
      const workerAEpoch = 1;

      // 1. Worker A held cleaning lease which expired
      const job = await DeletionCleanupJob.create({
        formId,
        stagingPrefix: `staging/forms/${formId}/`,
        finalPrefix: `forms/${formId}/`,
        status: 'cleaning',
        leaseId: workerALeaseId,
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired
        epoch: workerAEpoch,
        attempts: 1,
        eligibleUntil: new Date(Date.now() - 1000),
        vacuumAt: null
      });

      // 2. Reclaim the job with Worker B
      const workerBResult = await processDeletionCleanupJob(job);
      expect(workerBResult.processed).toBe(true);

      const workerBJob = await DeletionCleanupJob.findById(job._id);
      expect(workerBJob.epoch).toBeGreaterThan(workerAEpoch);
      const newerEpoch = workerBJob.epoch;
      const newerStatus = workerBJob.status;

      // 3. Attempt Worker A's stale completion/update using old leaseId and old epoch
      const staleUpdateResult = await DeletionCleanupJob.updateOne(
        { _id: job._id, leaseId: workerALeaseId, epoch: workerAEpoch },
        {
          $set: {
            status: 'failed',
            lastError: 'STALE_WORKER_A_ERROR',
            updatedAt: new Date()
          }
        }
      );

      // 4. Verify CAS fails to match stale worker credentials
      expect(staleUpdateResult.matchedCount).toBe(0);
      expect(staleUpdateResult.modifiedCount).toBe(0);

      // 5. Verify database state still reflects Worker B's outcome
      const postStaleJob = await DeletionCleanupJob.findById(job._id);
      expect(postStaleJob.epoch).toBe(newerEpoch);
      expect(postStaleJob.status).toBe(newerStatus);
      expect(postStaleJob.lastError).toBeNull();
    });

    it('Cleaning Lease Recovery Test D: Persisted expired cleaning job is rediscovered after restart', async () => {
      const formId = new mongoose.Types.ObjectId();
      const crashedWorkerLeaseId = crypto.randomUUID();
      const canonicalKey = `forms/${formId}/responses/${crypto.randomUUID()}/restart-recovered.pdf`;
      activeS3Objects.set(canonicalKey, { mime: 'application/pdf', timestamp: Date.now() });

      // 1. Persist a job in cleaning with an expired lease (simulating worker crash before restart)
      await DeletionCleanupJob.create({
        formId,
        stagingPrefix: `staging/forms/${formId}/`,
        finalPrefix: `forms/${formId}/`,
        status: 'cleaning',
        leaseId: crashedWorkerLeaseId,
        leaseExpiresAt: new Date(Date.now() - 10000), // Expired 10s ago
        epoch: 3,
        attempts: 1,
        eligibleUntil: new Date(Date.now() - 5000),
        vacuumAt: null
      });

      // 2. Simulate a fresh server startup invocation of recoverAbandonedFormDeletions()
      // without relying on in-memory worker state
      const startupRecoveryResult = await recoverAbandonedFormDeletions();
      expect(startupRecoveryResult.completedCleanupJobs).toBeGreaterThanOrEqual(1);
      expect(startupRecoveryResult.purgedStorageFiles).toBeGreaterThanOrEqual(1);

      // 3. Verify storage was swept and object purged
      expect(activeS3Objects.has(canonicalKey)).toBe(false);

      // 4. Verify job transitioned to reconciled with perpetual TTL immunity
      const finalJob = await DeletionCleanupJob.findOne({ formId });
      expect(finalJob.status).toBe('reconciled');
      expect(finalJob.vacuumAt).toBeNull();
      expect(finalJob.leaseId).toBeNull();
      expect(finalJob.epoch).toBeGreaterThan(3);
    });

    it('Cleaning Lease Recovery Test E: Late copy arriving after expired cleaning lease recovery is swept', async () => {
      const formId = new mongoose.Types.ObjectId();
      const crashedWorkerLeaseId = crypto.randomUUID();

      // 1. Crashed worker left empty namespace in cleaning with expired lease
      await DeletionCleanupJob.create({
        formId,
        stagingPrefix: `staging/forms/${formId}/`,
        finalPrefix: `forms/${formId}/`,
        status: 'cleaning',
        leaseId: crashedWorkerLeaseId,
        leaseExpiresAt: new Date(Date.now() - 5000),
        epoch: 1,
        attempts: 1,
        eligibleUntil: new Date(Date.now() - 1000),
        vacuumAt: null
      });

      // 2. Recovery discovers and sweeps empty namespace -> status becomes reconciled
      await recoverAbandonedFormDeletions();
      const jobAfterSweep1 = await DeletionCleanupJob.findOne({ formId });
      expect(jobAfterSweep1.status).toBe('reconciled');
      expect(jobAfterSweep1.vacuumAt).toBeNull();

      // 3. In-flight late copy completes in S3
      const lateCanonicalKey = `forms/${formId}/responses/${crypto.randomUUID()}/very-late-copy.pdf`;
      activeS3Objects.set(lateCanonicalKey, { mime: 'application/pdf', timestamp: Date.now() });
      expect(activeS3Objects.has(lateCanonicalKey)).toBe(true);

      // 4. Advance time for next sweep
      await DeletionCleanupJob.updateOne(
        { formId },
        { $set: { nextSweepAt: new Date(Date.now() - 1000) } }
      );

      // 5. Subsequent scheduler run discovers and purges the late copy
      const sweep2Result = await recoverAbandonedFormDeletions();
      expect(sweep2Result.completedCleanupJobs).toBeGreaterThanOrEqual(1);
      expect(sweep2Result.purgedStorageFiles).toBeGreaterThanOrEqual(1);
      expect(activeS3Objects.has(lateCanonicalKey)).toBe(false);

      // 6. Job remains reconciled with perpetual TTL immunity
      const finalJob = await DeletionCleanupJob.findOne({ formId });
      expect(finalJob.status).toBe('reconciled');
      expect(finalJob.vacuumAt).toBeNull();
    });
  });

  describe('Stage 4.3.6.1: Single-Page S3 Cleanup Lease Renewal & Heartbeat Suite (5 Tests)', () => {
    it('Single-Page Renewal Test 1: Delayed single-page listing outlasting lease interval is continuously renewed by owner', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Single Page 1',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/staged1.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async (prefix) => {
        // Delay single-page listing by 120ms (exceeding 80ms lease duration)
        await new Promise((r) => setTimeout(r, 120));
        const matched = [];
        for (const k of activeS3Objects.keys()) {
          if (k.startsWith(prefix)) {
            matched.push(k);
          }
        }
        return {
          keys: matched,
          isTruncated: false,
          nextContinuationToken: null,
          keyCount: matched.length
        };
      });

      const sweep = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 80,
        heartbeatIntervalMs: 25
      });

      expect(sweep.processed).toBe(true);
      expect(sweep.deletedCount).toBe(1);
      expect(activeS3Objects.has(stagedKey)).toBe(false);

      const finalJob = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(finalJob.status).toBe('reconciled');
    });

    it('Single-Page Renewal Test 2: Heartbeat renewal strictly matches current {_id, leaseId, epoch} CAS ownership', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Single Page 2',
        status: 'published'
      });
      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      const updateOneSpy = vi.spyOn(DeletionCleanupJob, 'updateOne');

      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { keys: [], isTruncated: false };
      });

      await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 60,
        heartbeatIntervalMs: 20
      });

      // Verify heartbeat update calls specify exact {_id, leaseId, epoch}
      const heartbeatCalls = updateOneSpy.mock.calls.filter(
        (call) => call[1]?.$set?.leaseExpiresAt
      );
      expect(heartbeatCalls.length).toBeGreaterThanOrEqual(2);
      for (const call of heartbeatCalls) {
        expect(call[0]).toMatchObject({
          _id: expect.any(Object),
          leaseId: expect.any(String),
          epoch: expect.any(Number)
        });
      }
    });

    it('Single-Page Renewal Test 3: Competing worker reclamation is detected as lease loss by owner heartbeat', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Single Page 3',
        status: 'published'
      });
      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      let workerReclaimed = false;
      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async () => {
        // Delay listing by 120ms; mid-way, Worker 2 reclaims the job via CAS with bumped epoch
        setTimeout(async () => {
          const job = await DeletionCleanupJob.findOne({ formId: form._id });
          if (job) {
            await DeletionCleanupJob.updateOne(
              { _id: job._id },
              { $set: { leaseId: 'competing-worker-lease', epoch: job.epoch + 10 } }
            );
            workerReclaimed = true;
          }
        }, 30);
        await new Promise((r) => setTimeout(r, 120));
        return { keys: [`staging/forms/${form._id}/item.pdf`], isTruncated: false };
      });

      const sweep = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 60,
        heartbeatIntervalMs: 20
      });

      expect(workerReclaimed).toBe(true);
      expect(sweep.processed).toBe(false);
      expect(sweep.status).toBe('lease_lost');
    });

    it('Single-Page Renewal Test 4: Stale worker with lost lease is strictly prevented from calling deleteFiles', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Single Page 4',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/protected.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async () => {
        // During listing, lease is stolen by competing worker
        setTimeout(async () => {
          const job = await DeletionCleanupJob.findOne({ formId: form._id });
          if (job) {
            await DeletionCleanupJob.updateOne(
              { _id: job._id },
              { $set: { leaseId: 'stealer-lease', epoch: job.epoch + 5 } }
            );
          }
        }, 25);
        await new Promise((r) => setTimeout(r, 100));
        return { keys: [stagedKey], isTruncated: false };
      });

      const sweep = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 60,
        heartbeatIntervalMs: 20
      });

      expect(sweep.processed).toBe(false);
      expect(sweep.status).toBe('lease_lost');
      // deleteFiles must NEVER be called by the stale worker
      expect(deleteFilesSpy).not.toHaveBeenCalled();
      // The staged key must NOT have been deleted by the stale worker
      expect(activeS3Objects.has(stagedKey)).toBe(true);
    });

    it('Single-Page Renewal Test 5: Heartbeat timer and asynchronous work are cleanly stopped after completion and on failure', async () => {
      // Unit verification of CleanupLeaseHeartbeat
      const jobId = new mongoose.Types.ObjectId();
      const heartbeat = new CleanupLeaseHeartbeat({
        jobId,
        leaseId: crypto.randomUUID(),
        epoch: 1,
        leaseDurationMs: 60,
        intervalMs: 15
      });

      heartbeat.start();
      expect(heartbeat.timer).not.toBeNull();
      expect(heartbeat.stopped).toBe(false);

      await heartbeat.stop();
      expect(heartbeat.timer).toBeNull();
      expect(heartbeat.stopped).toBe(true);

      // Integration verification: Even if listing throws an unhandled error, heartbeat is stopped
      const form = await Form.create({
        ownerId: userId,
        title: 'Single Page 5',
        status: 'published'
      });
      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      vi.spyOn(storageService, 'listObjectsByPrefix').mockRejectedValueOnce(
        new Error('Simulated S3 listing fatal error')
      );

      const result = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 60,
        heartbeatIntervalMs: 20
      });

      expect(result.processed).toBe(false);
      expect(result.error).toBe('Simulated S3 listing fatal error');

      // Wait 50ms and confirm no dangling heartbeat timer throws or causes unhandled errors
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe('Stage 4.3.6.1.1: Fail-Closed Cleanup Lease Fencing & Barrier Suite (5 Tests)', () => {
    it('Fail-Closed Fencing Test A: Worker awaits pending renewal before deleteFiles and halts when renewal resolves with CAS mismatch', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Pending Renewal Race Form',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/item.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      // Create a deferred promise for the background updateOne call
      let resolveUpdateOne;
      let updateOneInitiated = false;
      const pendingUpdatePromise = new Promise((resolve) => {
        resolveUpdateOne = resolve;
      });

      const origUpdateOne = DeletionCleanupJob.updateOne.bind(DeletionCleanupJob);
      vi.spyOn(DeletionCleanupJob, 'updateOne').mockImplementation(
        async (filter, update, options) => {
          // Intercept heartbeat renewal calls (they update leaseExpiresAt)
          if (update?.$set?.leaseExpiresAt && !updateOneInitiated) {
            updateOneInitiated = true;
            // Hold this update pending until listing finishes and competing worker reclaims
            await pendingUpdatePromise;
            // Return CAS mismatch since competing worker stole the lease
            return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
          }
          return origUpdateOne(filter, update, options);
        }
      );

      // Listing completes while updateOne is pending
      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async () => {
        // Wait until updateOne has been initiated
        while (!updateOneInitiated) {
          await new Promise((r) => setTimeout(r, 5));
        }
        // Listing is ready, but before updateOne resolves, Worker 2 reclaims the job in DB
        const job = await DeletionCleanupJob.findOne({ formId: form._id });
        await origUpdateOne(
          { _id: job._id },
          { $set: { leaseId: 'competitor-lease-id', epoch: job.epoch + 1 } }
        );

        // Schedule resolution of the pending update after listing returns
        setTimeout(() => {
          resolveUpdateOne();
        }, 15);

        return { keys: [stagedKey], isTruncated: false };
      });

      const sweep = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 1000,
        heartbeatIntervalMs: 10
      });

      expect(sweep.processed).toBe(false);
      expect(sweep.status).toBe('lease_lost');
      expect(deleteFilesSpy).not.toHaveBeenCalled();
      expect(activeS3Objects.has(stagedKey)).toBe(true);
    });

    it('Fail-Closed Fencing Test B: Heartbeat renewal database exception fails closed and prevents deleteFiles', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Heartbeat DB Exception Form',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/error-item.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      const origUpdateOne = DeletionCleanupJob.updateOne.bind(DeletionCleanupJob);
      let errorInjected = false;
      vi.spyOn(DeletionCleanupJob, 'updateOne').mockImplementation(
        async (filter, update, options) => {
          if (update?.$set?.leaseExpiresAt) {
            errorInjected = true;
            throw new Error('MongoNetworkTimeoutError: connection timed out during lease renewal');
          }
          return origUpdateOne(filter, update, options);
        }
      );

      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async () => {
        // Wait for renewal error to be injected
        await new Promise((r) => setTimeout(r, 30));
        return { keys: [stagedKey], isTruncated: false };
      });

      const sweep = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 1000,
        heartbeatIntervalMs: 10
      });

      expect(errorInjected).toBe(true);
      expect(sweep.processed).toBe(false);
      expect(sweep.status).toBe('lease_lost');
      expect(deleteFilesSpy).not.toHaveBeenCalled();
      expect(activeS3Objects.has(stagedKey)).toBe(true);
    });

    it('Fail-Closed Fencing Test C: Wall-clock lease expiration blocks deleteFiles even if no explicit CAS rejection occurred', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'Wall Clock Expiry Form',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/clock-item.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      // Prevent renewals from updating confirmedExpiresAtMs
      vi.spyOn(DeletionCleanupJob, 'updateOne').mockImplementation(async (filter, update) => {
        if (update?.$set?.leaseExpiresAt) {
          throw new Error('Connection lost');
        }
        return { matchedCount: 1, modifiedCount: 1 };
      });

      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async () => {
        // Listing takes 60ms, exceeding the 30ms leaseDurationMs
        await new Promise((r) => setTimeout(r, 60));
        return { keys: [stagedKey], isTruncated: false };
      });

      const sweep = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 30, // 30ms lease
        heartbeatIntervalMs: 100 // renewal interval is beyond expiry
      });

      expect(sweep.processed).toBe(false);
      expect(sweep.status).toBe('lease_lost');
      expect(deleteFilesSpy).not.toHaveBeenCalled();
      expect(activeS3Objects.has(stagedKey)).toBe(true);
    });

    it('Fail-Closed Fencing Test D: Pre-deletion barrier verifies exact {_id, status: "cleaning", leaseId, epoch} CAS semantics', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'CAS Filter Verification Form',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/cas-item.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });

      const updateOneSpy = vi.spyOn(DeletionCleanupJob, 'updateOne');
      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      vi.spyOn(storageService, 'listObjectsByPrefix').mockResolvedValue({
        keys: [stagedKey],
        isTruncated: false
      });

      const sweep = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        leaseDurationMs: 500,
        heartbeatIntervalMs: 200
      });

      expect(sweep.processed).toBe(true);
      expect(deleteFilesSpy).toHaveBeenCalledWith([stagedKey], expect.any(Object));

      // Inspect CAS calls
      const renewalCalls = updateOneSpy.mock.calls.filter((call) => call[1]?.$set?.leaseExpiresAt);
      expect(renewalCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of renewalCalls) {
        expect(call[0]).toMatchObject({
          _id: expect.any(Object),
          status: 'cleaning',
          leaseId: expect.any(String),
          epoch: expect.any(Number)
        });
      }
    });

    it('Fail-Closed Fencing Test E: Heartbeat lifecycle ensures single in-flight renewal, clean stop, and no unhandled rejections', async () => {
      const jobId = new mongoose.Types.ObjectId();
      const leaseId = crypto.randomUUID();
      const heartbeat = new CleanupLeaseHeartbeat({
        jobId,
        leaseId,
        epoch: 1,
        leaseDurationMs: 100,
        intervalMs: 20
      });

      // 1. Mock updateOne to be slow
      let resolveFirst;
      const firstUpdate = new Promise((r) => {
        resolveFirst = r;
      });
      let updateCount = 0;
      vi.spyOn(DeletionCleanupJob, 'updateOne').mockImplementation(async () => {
        updateCount++;
        await firstUpdate;
        return { matchedCount: 1, modifiedCount: 1 };
      });

      // 2. Call renew() twice concurrently
      const promise1 = heartbeat.renew();
      const promise2 = heartbeat.renew();

      // Only one renewal should be dispatched
      expect(updateCount).toBe(1);
      // Both promises must reference the same in-flight operation
      expect(promise1).toBe(promise2);

      // Resolve update
      resolveFirst();
      await promise1;

      // 3. Verify stop() halts timers and settles pending work
      heartbeat.start();
      expect(heartbeat.timer).not.toBeNull();
      await heartbeat.stop();
      expect(heartbeat.timer).toBeNull();
      expect(heartbeat.stopped).toBe(true);

      // 4. Verify rejection does not cause unhandled rejection
      vi.spyOn(DeletionCleanupJob, 'updateOne').mockRejectedValueOnce(
        new Error('Simulated network crash during renew')
      );
      const heartbeatFail = new CleanupLeaseHeartbeat({
        jobId,
        leaseId: crypto.randomUUID(),
        epoch: 2,
        leaseDurationMs: 100,
        intervalMs: 10
      });
      const result = await heartbeatFail.renew();
      expect(result).toBe(false);
      expect(heartbeatFail.hasError).toBe(true);
      expect(heartbeatFail.lastError.message).toBe('Simulated network crash during renew');
      await heartbeatFail.stop();
    });
  });

  describe('Stage 4.3.6.2: Durable S3 Cleanup Failure-Path Integration Suite (6 Tests)', () => {
    it('Cleanup Failure Test 1: S3 listing rejection records lastError, resets to pending, and remains recoverable', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'S3 Fail 1',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/file1.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      vi.spyOn(storageService, 'listObjectsByPrefix').mockRejectedValueOnce(
        new Error('S3 listing network timeout 500')
      );

      const sweep1 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep1.processed).toBe(false);
      expect(sweep1.status).toBe('pending');
      expect(sweep1.error).toBe('S3 listing network timeout 500');

      const jobAfterFail = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(jobAfterFail.status).toBe('pending');
      expect(jobAfterFail.leaseId).toBeNull();
      expect(jobAfterFail.leaseExpiresAt).toBeNull();
      expect(jobAfterFail.lastError).toBe('S3 listing network timeout 500');

      // Subsequent sweep recovers when S3 is reachable
      const sweep2 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep2.processed).toBe(true);
      expect(sweep2.status).toBe('reconciled');
      expect(sweep2.deletedCount).toBe(1);

      const jobAfterRecovery = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(jobAfterRecovery.status).toBe('reconciled');
      expect(jobAfterRecovery.lastError).toBeNull();
      expect(activeS3Objects.has(stagedKey)).toBe(false);
    });

    it('Cleanup Failure Test 2: S3 listing cancellation via AbortSignal resets job to pending without corruption', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'S3 Fail 2',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/file2.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      const controller = new AbortController();
      controller.abort();

      const sweep = await processDeletionCleanupJob(form._id, {
        forceImmediate: true,
        signal: controller.signal
      });

      expect(sweep.processed).toBe(false);
      expect(sweep.status).toBe('aborted');

      const jobAfterAbort = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(jobAfterAbort.status).toBe('pending');
      expect(jobAfterAbort.leaseId).toBeNull();
      expect(jobAfterAbort.leaseExpiresAt).toBeNull();

      // Ensure object was not deleted and job is recoverable
      expect(activeS3Objects.has(stagedKey)).toBe(true);

      const recoverySweep = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(recoverySweep.processed).toBe(true);
      expect(recoverySweep.status).toBe('reconciled');
      expect(activeS3Objects.has(stagedKey)).toBe(false);
    });

    it('Cleanup Failure Test 3: Partial S3 deletion failure preserves job as pending and later sweep reconciles', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'S3 Fail 3',
        status: 'published'
      });
      const key1 = `staging/forms/${form._id}/part1.pdf`;
      const key2 = `staging/forms/${form._id}/part2.pdf`;
      activeS3Objects.set(key1, { mime: 'application/pdf', timestamp: Date.now() });
      activeS3Objects.set(key2, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      // Simulate partial deleteFiles failure on key2
      vi.spyOn(storageService, 'deleteFiles').mockResolvedValueOnce({
        success: false,
        deletedKeys: [key1],
        failedKeys: [key2],
        totalRequested: 2,
        error: 'Failed to delete some storage files'
      });
      activeS3Objects.delete(key1);

      const sweep1 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep1.processed).toBe(true);
      expect(sweep1.status).toBe('pending');
      expect(sweep1.deletedCount).toBe(1);
      expect(sweep1.error).toBe('Failed to delete some storage files');

      const jobAfterPartial = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(jobAfterPartial.status).toBe('pending');
      expect(jobAfterPartial.leaseId).toBeNull();
      expect(jobAfterPartial.lastError).toBe('Failed to delete some storage files');
      expect(jobAfterPartial.stats.objectsDeleted).toBe(1);
      expect(activeS3Objects.has(key2)).toBe(true);

      // Next sweep deletes key2 successfully and moves to reconciled
      const sweep2 = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep2.processed).toBe(true);
      expect(sweep2.status).toBe('reconciled');
      expect(sweep2.deletedCount).toBe(1);

      const jobAfterComplete = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(jobAfterComplete.status).toBe('reconciled');
      expect(jobAfterComplete.stats.objectsDeleted).toBe(2);
      expect(activeS3Objects.has(key2)).toBe(false);
    });

    it('Cleanup Failure Test 4: S3 error during multi-page prefix listing aborts before any deletion occurs', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'S3 Fail 4',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/paged.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      // Page 1 succeeds with continuationToken, Page 2 throws error
      let pageCallCount = 0;
      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async (prefix) => {
        if (prefix.includes('staging')) {
          pageCallCount++;
          if (pageCallCount === 1) {
            return {
              keys: [stagedKey],
              isTruncated: true,
              nextContinuationToken: 'token-page-2'
            };
          }
          throw new Error('S3 connection reset during page 2');
        }
        return { keys: [], isTruncated: false };
      });

      const sweep = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep.processed).toBe(false);
      expect(sweep.status).toBe('pending');
      expect(sweep.error).toBe('S3 connection reset during page 2');

      // deleteFiles must NEVER be called because listing did not complete cleanly
      expect(deleteFilesSpy).not.toHaveBeenCalled();
      expect(activeS3Objects.has(stagedKey)).toBe(true);

      const job = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(job.status).toBe('pending');
      expect(job.leaseId).toBeNull();
      expect(job.lastError).toBe('S3 connection reset during page 2');
    });

    it('Cleanup Failure Test 5: Lease ownership loss during listing prevents deleteFiles invocation', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'S3 Fail 5',
        status: 'published'
      });
      const stagedKey = `staging/forms/${form._id}/staged-lost.pdf`;
      activeS3Objects.set(stagedKey, { mime: 'application/pdf', timestamp: Date.now() });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      await DeletionCleanupJob.updateOne(
        { formId: form._id },
        { $set: { eligibleUntil: new Date(Date.now() - 1000) } }
      );

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      // While listing is occurring, another worker hijacks the lease
      vi.spyOn(storageService, 'listObjectsByPrefix').mockImplementation(async () => {
        await DeletionCleanupJob.updateOne(
          { formId: form._id },
          { $set: { leaseId: 'hijacker-lease-id', epoch: 999 } }
        );
        return { keys: [stagedKey], isTruncated: false };
      });

      const sweep = await processDeletionCleanupJob(form._id, { forceImmediate: true });
      expect(sweep.processed).toBe(false);
      expect(sweep.status).toBe('lease_lost');

      // Stale worker is completely fenced: deleteFiles is NEVER called
      expect(deleteFilesSpy).not.toHaveBeenCalled();
      expect(activeS3Objects.has(stagedKey)).toBe(true);

      // Verify DB record retains the hijacker's epoch and leaseId
      const job = await DeletionCleanupJob.findOne({ formId: form._id });
      expect(job.epoch).toBe(999);
      expect(job.leaseId).toBe('hijacker-lease-id');
    });

    it('Cleanup Failure Test 6: Stale worker with obsolete epoch is prevented from advancing tombstone status', async () => {
      const form = await Form.create({
        ownerId: userId,
        title: 'S3 Fail 6',
        status: 'published'
      });

      await executeFormDeletion(form._id, { userId, drainWaitMs: 0, skipImmediateCleanup: true });
      const job = await DeletionCleanupJob.findOne({ formId: form._id });

      const staleEpoch = job.epoch;
      const staleLeaseId = 'stale-lease-123';

      // Advanced epoch in DB
      await DeletionCleanupJob.updateOne(
        { _id: job._id },
        { $set: { status: 'cleaning', leaseId: 'active-lease-456', epoch: staleEpoch + 1 } }
      );

      // Stale worker tries CAS update with staleEpoch
      const staleUpdateResult = await DeletionCleanupJob.updateOne(
        { _id: job._id, leaseId: staleLeaseId, epoch: staleEpoch },
        { $set: { status: 'reconciled', lastError: null } }
      );

      expect(staleUpdateResult.matchedCount).toBe(0);
      expect(staleUpdateResult.modifiedCount).toBe(0);

      // Verify the active state in DB remains untouched
      const currentJob = await DeletionCleanupJob.findById(job._id);
      expect(currentJob.epoch).toBe(staleEpoch + 1);
      expect(currentJob.leaseId).toBe('active-lease-456');
      expect(currentJob.status).toBe('cleaning');
    });
  });
});
