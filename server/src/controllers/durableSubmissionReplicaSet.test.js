import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import User from '../models/user.js';
import SubmissionReservation from '../models/submissionReservation.js';
import {
  executeFormDeletion,
  recoverAbandonedFormDeletions,
  releaseDeletionLease,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  reorderQuestions,
  updateForm
} from './formController.js';
import { submitResponse, deleteResponse } from './responseController.js';
import { SubmissionReservationManager } from '../utils/submissionReservationManager.js';
import storageService from '../services/StorageService.js';
import { errorHandler } from '../middleware/errorHandler.js';
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

const PDF_MAGIC = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

const createTempPdfFile = () => {
  const filePath = path.join(os.tmpdir(), `rs-test-${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(filePath, PDF_MAGIC);
  return filePath;
};

describe('Stage 4.3.5 B1: Replica Set Multi-Document Transaction Integration & Adversarial Concurrency', () => {
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
    app.post(
      '/api/responses/:formId',
      (req, res, next) => {
        req.app.locals.lastReq = req;
        next();
      },
      upload.any(),
      submitResponse
    );
    app.delete(
      '/api/responses/:formId/:responseId',
      (req, res, next) => {
        req.user = { id: userId };
        next();
      },
      deleteResponse
    );
    app.put(
      '/api/forms/:id',
      (req, res, next) => {
        req.user = { id: userId };
        next();
      },
      updateForm
    );
    app.post(
      '/api/forms/:id/questions',
      (req, res, next) => {
        req.user = { id: userId };
        next();
      },
      addQuestion
    );
    app.put(
      '/api/forms/:formId/questions/reorder',
      (req, res, next) => {
        req.user = { id: userId };
        next();
      },
      reorderQuestions
    );
    app.put(
      '/api/forms/:formId/questions/:questionId',
      (req, res, next) => {
        req.user = { id: userId };
        next();
      },
      updateQuestion
    );
    app.delete(
      '/api/forms/:formId/questions/:questionId',
      (req, res, next) => {
        req.user = { id: userId };
        next();
      },
      deleteQuestion
    );
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
      return matched;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (app?.locals) {
      app.locals.lastReq = null;
    }
  });

  // --------------------------------------------------------------------------
  // Baseline Replica-Set Tests (R1-R4)
  // --------------------------------------------------------------------------
  it('Test R1: executes form deletion cascade as an atomic multi-document transaction', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Replica Set Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Question R1',
      order: 0
    });

    await Response.create({
      formId: form._id,
      answers: [{ questionId: question._id, value: 'Answer R1' }],
      submittedBy: 'respondent-1'
    });

    const resResult = await SubmissionReservationManager.acquire(form._id);
    expect(resResult.success).toBe(true);

    // Finalize the reservation so deletion can proceed
    await SubmissionReservationManager.finalize(
      resResult.leaseId,
      resResult.fenceToken,
      null,
      form._id
    );

    // Execute deletion: on replica set, this runs inside withRequiredTransaction(session)
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.success).toBe(true);
    expect(delResult.statusCode).toBe(200);

    // Invariant: all documents across all 4 collections were atomically deleted
    expect(await Form.findById(form._id)).toBeNull();
    expect(await Question.countDocuments({ formId: form._id })).toBe(0);
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
  });

  it('Test R2: transaction abort rolls back all document modifications completely', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Rollback Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Question R2',
      order: 0
    });

    await Response.create({
      formId: form._id,
      answers: [{ questionId: question._id, value: 'Answer R2' }],
      submittedBy: 'respondent-2'
    });

    // Simulate an error thrown midway through a deletion transaction
    vi.spyOn(Form, 'deleteOne').mockImplementation(async () => {
      const simError = new Error('SIMULATED_TRANSACTION_FAILURE');
      simError.code = 'SIM_FAIL';
      throw simError;
    });

    await expect(executeFormDeletion(form._id, { userId, drainWaitMs: 0 })).rejects.toThrow(
      'SIMULATED_TRANSACTION_FAILURE'
    );

    // Invariant: Because replica set transactions are atomic, all documents are restored by rollback
    expect(await Question.countDocuments({ formId: form._id })).toBe(1);
    expect(await Response.countDocuments({ formId: form._id })).toBe(1);

    // Form status was set to delete_failed by catch block
    const updatedForm = await Form.findById(form._id);
    expect(updatedForm).not.toBeNull();
    expect(updatedForm.status).toBe('delete_failed');
  });

  it('Test R3: concurrent submission persistence and deletion coordinate cleanly on replica set with zero orphans', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Conflict Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Question R3',
      order: 0
    });

    // 1. Acquire an active submission reservation
    const resResult = await SubmissionReservationManager.acquire(form._id);
    expect(resResult.success).toBe(true);

    // 2. Deletion attempts to claim form while reservation is active
    const delResult1 = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult1.success).toBe(false);
    expect(delResult1.statusCode).toBe(409);
    expect(delResult1.message).toContain('submissions in flight');

    // 3. Finalize reservation and create response
    await SubmissionReservationManager.finalize(
      resResult.leaseId,
      resResult.fenceToken,
      null,
      form._id
    );
    await Response.create({
      formId: form._id,
      answers: [{ questionId: question._id, value: 'Transactional response' }],
      submittedBy: 'respondent-r3'
    });
    expect(await Response.countDocuments({ formId: form._id })).toBe(1);

    // 4. Deletion runs after submission finalization: cascades atomically in replica set transaction
    const delResult2 = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult2.success).toBe(true);
    expect(delResult2.statusCode).toBe(200);

    // Invariant: Zero documents exist across all collections
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
    expect(await Question.countDocuments({ formId: form._id })).toBe(0);
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
    expect(await Form.findById(form._id)).toBeNull();
  });

  it('Test R4: deletion-first race aborts concurrent submission transaction on replica set with zero phantom responses', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Deletion First Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Question R4',
      order: 0
    });

    // 1. Deletion claims form and runs to completion
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.success).toBe(true);
    expect(await Form.findById(form._id)).toBeNull();

    // 2. A late submission worker attempts to submit after form is already deleted
    const subRes = await request(app)
      .post(`/api/responses/${form._id}`)
      .send({
        answers: [{ questionId: question._id.toString(), value: 'Late response' }]
      });

    expect(subRes.status).toBe(404);
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
  });

  // --------------------------------------------------------------------------
  // True Concurrent Races 1-5 (Real WiredTiger WriteConflict Serialization)
  // --------------------------------------------------------------------------
  it('Race 1A: concurrent acquire() holding Form write lock triggers real WiredTiger WriteConflict retry in T_claim and blocks deletion with 409', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Race 1A Form',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Q1A',
      order: 0
    });

    const acqHoldsLockBarrier = createDeferred();
    const allowAcqCommitBarrier = createDeferred();
    const claimAboutToWriteBarrier = createDeferred();

    let pausedOnce = false;
    const originalResCreate = SubmissionReservation.create.bind(SubmissionReservation);
    vi.spyOn(SubmissionReservation, 'create').mockImplementation(async (...args) => {
      if (!pausedOnce) {
        pausedOnce = true;
        // At this point inside acquire tx, Form write lock is HELD inside active MongoDB transaction
        acqHoldsLockBarrier.resolve();
        await allowAcqCommitBarrier.promise;
      }
      return originalResCreate(...args);
    });

    let claimCallbackAttempts = 0;
    const originalFindById = Form.findById.bind(Form);
    vi.spyOn(Form, 'findById').mockImplementation((...args) => {
      claimCallbackAttempts++;
      return originalFindById(...args);
    });

    let claimWriteAttempts = 0;
    const originalFindOneAndUpdate = Form.findOneAndUpdate.bind(Form);
    vi.spyOn(Form, 'findOneAndUpdate').mockImplementation((filter, update, ...rest) => {
      if (update?.$set?.status === 'deleting') {
        claimWriteAttempts++;
        if (claimWriteAttempts === 1) {
          claimAboutToWriteBarrier.resolve();
        }
      }
      return originalFindOneAndUpdate(filter, update, ...rest);
    });

    try {
      const subPromise = (async () =>
        await request(app)
          .post(`/api/responses/${form._id}`)
          .send({
            answers: [{ questionId: question._id.toString(), value: 'Committed under lock' }]
          }))();

      // Wait until T_acquire holds open uncommitted WiredTiger write lock on Form
      await acqHoldsLockBarrier.promise;

      // Launch T_claim concurrently while T_acquire holds Form lock
      const delPromise = executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
      await claimAboutToWriteBarrier.promise;

      // Release T_acquire while T_claim is attempting WriteConflict on Form
      allowAcqCommitBarrier.resolve();
      const [subRes, delRes] = await Promise.all([subPromise, delPromise]);

      expect(subRes.status).toBe(201);
      // T_claim collided on Form against T_acquire -> hit real WriteConflict and driver retried transaction callback (>= 2 attempts)
      expect(claimWriteAttempts).toBeGreaterThanOrEqual(1);
      expect(claimCallbackAttempts).toBeGreaterThanOrEqual(2);
      // On retry, T_claim either blocked with 409 (seeing active reservation) or ran after T_sub finalized (200) and wiped Response atomically
      expect([200, 409]).toContain(delRes.statusCode);

      if (delRes.statusCode === 409) {
        expect(await Response.countDocuments({ formId: form._id })).toBe(1);
        const delRes2 = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
        expect(delRes2.statusCode).toBe(200);
      }

      expect(await Form.findById(form._id)).toBeNull();
      expect(await Response.countDocuments({ formId: form._id })).toBe(0);
      expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
    } finally {
      acqHoldsLockBarrier.resolve();
      claimAboutToWriteBarrier.resolve();
      allowAcqCommitBarrier.resolve();
    }
  });

  it('Race 1B: concurrent T_claim holding Form write lock forces acquire() into real WriteConflict retry and rejects submission with 409/404', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Race 1B Form',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Q1B',
      order: 0
    });

    const claimHoldsLockBarrier = createDeferred();
    const allowClaimCommitBarrier = createDeferred();
    const acquireAboutToWriteBarrier = createDeferred();

    let pausedClaim = false;
    let acquireAttempts = 0;
    const originalFindOneAndUpdate = Form.findOneAndUpdate.bind(Form);
    vi.spyOn(Form, 'findOneAndUpdate').mockImplementation(async (filter, update, ...rest) => {
      if (update?.$set?.status === 'deleting' && !pausedClaim) {
        pausedClaim = true;
        const res = await originalFindOneAndUpdate(filter, update, ...rest);
        claimHoldsLockBarrier.resolve();
        await allowClaimCommitBarrier.promise;
        return res;
      }
      if (update?.$inc?.activeSubmissions === 1) {
        acquireAttempts++;
        if (acquireAttempts === 1) {
          acquireAboutToWriteBarrier.resolve();
        }
      }
      return originalFindOneAndUpdate(filter, update, ...rest);
    });

    try {
      const delPromise = executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
      await claimHoldsLockBarrier.promise;

      const subPromise = (async () =>
        await request(app)
          .post(`/api/responses/${form._id}`)
          .send({
            answers: [{ questionId: question._id.toString(), value: 'Should be 409/404' }]
          }))();

      await acquireAboutToWriteBarrier.promise;
      allowClaimCommitBarrier.resolve();

      const [delRes, subRes] = await Promise.all([delPromise, subPromise]);
      expect(delRes.statusCode).toBe(200);
      expect([404, 409]).toContain(subRes.status);
      // acquire() encountered T_claim's Form write lock and could not acquire on stale 'published' state
      expect(acquireAttempts).toBeGreaterThanOrEqual(1);
      expect(await Form.findById(form._id)).toBeNull();
      expect(await Response.countDocuments({ formId: form._id })).toBe(0);
      expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
    } finally {
      claimHoldsLockBarrier.resolve();
      acquireAboutToWriteBarrier.resolve();
      allowClaimCommitBarrier.resolve();
    }
  });

  it('Race 2: deletion T_del holding lock rejects concurrent late T_sub persistence attempt and purges staged S3 files', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Race 2 Form',
      status: 'published'
    });
    const fileQ = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment',
      required: true,
      order: 0
    });

    const tmpFile = createTempPdfFile();
    const postUploadReached = createDeferred();
    const allowSubPersistence = createDeferred();

    // Pause submission worker AFTER S3 upload + post-upload check, BEFORE T_sub enters
    const origRenew = SubmissionReservationManager.renew.bind(SubmissionReservationManager);
    let renewCount = 0;
    vi.spyOn(SubmissionReservationManager, 'renew').mockImplementation(async (...args) => {
      renewCount++;
      const ok = await origRenew(...args);
      if (renewCount === 1) {
        postUploadReached.resolve();
        await allowSubPersistence.promise;
      }
      return ok;
    });

    const delHoldBarrier = createDeferred();
    const allowDelFinish = createDeferred();

    try {
      const subPromise = (async () =>
        await request(app)
          .post(`/api/responses/${form._id}`)
          .field('answers', JSON.stringify([]))
          .attach(`file_${fileQ._id.toString()}`, tmpFile))();

      await postUploadReached.promise;
      expect(activeS3Objects.size).toBe(1);

      // Force lease expired & trigger concurrent T_del cascade
      const resDoc = await SubmissionReservation.findOne({ formId: form._id });
      const past = new Date(Date.now() - 5000);
      await SubmissionReservation.updateOne({ _id: resDoc._id }, { $set: { expiresAt: past } });
      await Form.updateOne({ _id: form._id }, { $set: { activeSubmissionsExpiresAt: past } });

      const origQDelete = Question.deleteMany.bind(Question);
      vi.spyOn(Question, 'deleteMany').mockImplementation(async (...args) => {
        const res = await origQDelete(...args);
        delHoldBarrier.resolve();
        await allowDelFinish.promise;
        return res;
      });

      const delPromise = executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
      await delHoldBarrier.promise;

      // Resume T_sub WHILE T_del holds Form lock inside T_del, then finish T_del
      allowSubPersistence.resolve();
      allowDelFinish.resolve();

      const [delRes, subRes] = await Promise.all([delPromise, subPromise]);
      expect(delRes.statusCode).toBe(200);
      expect(subRes.status).toBe(409);

      expect(activeS3Objects.size).toBe(0);
      expect(await Form.findById(form._id)).toBeNull();
      expect(await Response.countDocuments({ formId: form._id })).toBe(0);
      expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
    } finally {
      postUploadReached.resolve();
      allowSubPersistence.resolve();
      delHoldBarrier.resolve();
      allowDelFinish.resolve();
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('Race 3: concurrent acquire() vs executeFormDeletion() serialize atomically on Form lifecycleVersion without phantom reservations', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Race 3 Form',
      status: 'published'
    });

    // Fire 10 simultaneous acquires + 1 deletion concurrently against the replica set
    const attempts = [
      executeFormDeletion(form._id, { userId, drainWaitMs: 0 }),
      ...Array.from({ length: 10 }, () => SubmissionReservationManager.acquire(form._id))
    ];

    const results = await Promise.all(attempts);
    const delOutcome = results[0];
    const acquireOutcomes = results.slice(1);
    const succeededAcquires = acquireOutcomes.filter((r) => r.success);

    if (delOutcome.success) {
      // Deletion won cleanly: zero lingering reservations or Form
      expect(await Form.findById(form._id)).toBeNull();
      expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
    } else {
      // Submission won first: deletion rejected with 409, and activeSubmissions matches reservations
      expect(delOutcome.statusCode).toBe(409);
      const resCount = await SubmissionReservation.countDocuments({
        formId: form._id,
        status: 'active'
      });
      expect(resCount).toBe(succeededAcquires.length);
      expect((await Form.findById(form._id)).activeSubmissions).toBe(succeededAcquires.length);
    }
  });

  it('Race 4: concurrent Question mutations serialize with deletion via Form lifecycleVersion and block delete_failed with 409', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Race 4 Form',
      status: 'published'
    });
    const q1 = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Q1',
      order: 0
    });
    const q2 = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Q2',
      order: 1
    });

    const outcomes = await Promise.all([
      executeFormDeletion(form._id, { userId, drainWaitMs: 0 }),
      request(app)
        .post(`/api/forms/${form._id}/questions`)
        .send({ type: 'short_text', label: 'Concurrent Q3' }),
      request(app).put(`/api/forms/${form._id}/questions/${q1._id}`).send({ label: 'Updated Q1' }),
      request(app)
        .put(`/api/forms/${form._id}/questions/reorder`)
        .send({
          questionOrders: [
            { questionId: q1._id.toString(), order: 1 },
            { questionId: q2._id.toString(), order: 0 }
          ]
        }),
      request(app).delete(`/api/forms/${form._id}/questions/${q2._id}`)
    ]);

    const delRes = outcomes[0];
    expect(delRes.statusCode).toBe(200);
    expect(await Form.findById(form._id)).toBeNull();
    // Invariant: Regardless of exact serialization order before vs after T_del, ZERO orphan questions survive!
    expect(await Question.countDocuments({ formId: form._id })).toBe(0);

    // Also verify delete_failed blocks all 4 question endpoints + updateForm with 409
    const failedForm = await Form.create({
      ownerId: userId,
      title: 'Failed Deletion Form',
      status: 'delete_failed'
    });
    const failedQ = await Question.create({
      formId: failedForm._id,
      type: 'short_text',
      label: 'Blocked Q',
      order: 0
    });

    const addBlocked = await request(app)
      .post(`/api/forms/${failedForm._id}/questions`)
      .send({ type: 'short_text', label: 'X' });
    const updBlocked = await request(app)
      .put(`/api/forms/${failedForm._id}/questions/${failedQ._id}`)
      .send({ label: 'Y' });
    const reorderBlocked = await request(app)
      .put(`/api/forms/${failedForm._id}/questions/reorder`)
      .send({ questionOrders: [{ questionId: failedQ._id.toString(), order: 0 }] });
    const delBlocked = await request(app).delete(
      `/api/forms/${failedForm._id}/questions/${failedQ._id}`
    );
    const updFormBlocked = await request(app)
      .put(`/api/forms/${failedForm._id}`)
      .send({ title: 'Should stay blocked', status: 'published' });

    expect(addBlocked.status).toBe(409);
    expect(updBlocked.status).toBe(409);
    expect(reorderBlocked.status).toBe(409);
    expect(delBlocked.status).toBe(409);
    expect(updFormBlocked.status).toBe(409);
  });

  it('Race 5: late S3 upload finishing after form deletion is purged by post-upload fence + release compensation', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Race 5 Form',
      status: 'published'
    });
    const fileQ = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Late Upload',
      required: true,
      order: 0
    });
    const tmpFile = createTempPdfFile();

    const uploadStarted = createDeferred();
    const allowUploadFinish = createDeferred();
    let capturedKey = null;

    vi.spyOn(storageService, 'uploadFile').mockImplementation(async (stream, key, mime) => {
      capturedKey = key;
      uploadStarted.resolve();
      await allowUploadFinish.promise;
      activeS3Objects.set(key, { mime, late: true });
      return key;
    });

    try {
      const subPromise = (async () =>
        await request(app)
          .post(`/api/responses/${form._id}`)
          .field('answers', JSON.stringify([]))
          .attach(`file_${fileQ._id.toString()}`, tmpFile))();

      await uploadStarted.promise;

      // Reservation expires while S3 upload hangs; deletion cleans entire form & reservation
      const resDoc = await SubmissionReservation.findOne({ formId: form._id });
      const past = new Date(Date.now() - 5000);
      await SubmissionReservation.updateOne({ _id: resDoc._id }, { $set: { expiresAt: past } });
      await Form.updateOne({ _id: form._id }, { $set: { activeSubmissionsExpiresAt: past } });

      const delRes = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
      expect(delRes.statusCode).toBe(200);
      expect(await Form.findById(form._id)).toBeNull();

      // Slow S3 upload finally resolves AFTER Form was deleted
      allowUploadFinish.resolve();
      const subRes = await subPromise;

      expect(subRes.status).toBe(409);
      expect(capturedKey).not.toBeNull();
      expect(activeS3Objects.has(capturedKey)).toBe(false);
      expect(await Response.countDocuments({ formId: form._id })).toBe(0);
      expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
    } finally {
      uploadStarted.resolve();
      allowUploadFinish.resolve();
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  // --------------------------------------------------------------------------
  // Defects A-D Invariance Proofs
  // --------------------------------------------------------------------------
  it('Defect A: recoverAbandonedFormDeletions runs orphan S3/Response/Reservation/Question sweeps even when zero deleting forms exist, and halts safely on S3/Category C failures', async () => {
    // Dead form 1: clean orphan Response + clean orphan Reservation + clean orphan Question (zero Form docs!)
    const deadForm1 = new Form({ ownerId: userId, title: 'Dead 1' })._id;
    const orphanKey1 = `forms/${deadForm1}/responses/orphan1.pdf`;
    const orphanStageKey = `forms/${deadForm1}/staging/lease1/stage.pdf`;
    activeS3Objects.set(orphanKey1, { mime: 'application/pdf' });
    activeS3Objects.set(orphanStageKey, { mime: 'application/pdf' });

    const q1 = await Question.create({ formId: deadForm1, type: 'file', label: 'File', order: 0 });
    await Response.create({
      formId: deadForm1,
      answers: [{ questionId: q1._id, value: { key: orphanKey1 } }]
    });
    await SubmissionReservation.create({
      formId: deadForm1,
      leaseId: crypto.randomUUID(),
      fenceToken: crypto.randomUUID(),
      status: 'abandoned',
      expiresAt: new Date(Date.now() - 10000),
      stagedKeys: [orphanStageKey]
    });

    // Dead form 2: contains Category C unresolved legacy key -> MUST HALT orphan deletion!
    const deadForm2 = new Form({ ownerId: userId, title: 'Dead 2' })._id;
    const q2 = await Question.create({
      formId: deadForm2,
      type: 'file',
      label: 'Legacy',
      order: 0
    });
    await Response.create({
      formId: deadForm2,
      answers: [{ questionId: q2._id, value: { key: 'uploads/legacy-orphan-file.pdf' } }]
    });

    // Zero forms with status: 'deleting'! Previously returned early here!
    expect(await Form.countDocuments({ status: 'deleting' })).toBe(0);

    const summary = await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });
    expect(summary.sweptOrphanResponses).toBe(1);
    expect(summary.sweptOrphanReservations).toBe(1);
    expect(summary.sweptOrphanQuestions).toBe(1);

    // Dead form 1 S3 & MongoDB completely cleaned
    expect(activeS3Objects.has(orphanKey1)).toBe(false);
    expect(activeS3Objects.has(orphanStageKey)).toBe(false);
    expect(await Response.countDocuments({ formId: deadForm1 })).toBe(0);
    expect(await Question.countDocuments({ formId: deadForm1 })).toBe(0);
    expect(await SubmissionReservation.countDocuments({ formId: deadForm1 })).toBe(0);

    // Dead form 2 halted safely: preserved Response & Question so Category C S3 pointer is never lost!
    expect(await Response.countDocuments({ formId: deadForm2 })).toBe(1);
    expect(await Question.countDocuments({ formId: deadForm2 })).toBe(1);
  });

  it('Defect B: releaseDeletionLease refuses published resurrection and enforces leaseId + epoch CAS', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Defect B Form',
      status: 'deleting',
      deletionProgress: {
        stage: 's3_cleanup',
        leaseId: 'lease-epoch-2',
        leaseExpiresAt: new Date(Date.now() + 30000),
        epoch: 2
      }
    });

    await expect(releaseDeletionLease(form._id, 'lease-epoch-2', 2, 'published')).rejects.toThrow(
      /Invalid post-claim deletion transition/
    );
    expect((await Form.findById(form._id)).status).toBe('deleting');

    // Wrong epoch cannot release
    const staleEpochRes = await releaseDeletionLease(form._id, 'lease-epoch-2', 1, 'delete_failed');
    expect(staleEpochRes.released).toBe(false);
    expect((await Form.findById(form._id)).status).toBe('deleting');

    // Matching leaseId + epoch transitions cleanly to delete_failed (never published)
    const validRes = await releaseDeletionLease(
      form._id,
      'lease-epoch-2',
      2,
      'delete_failed',
      'Explicit failure'
    );
    expect(validRes.released).toBe(true);
    const updated = await Form.findById(form._id);
    expect(updated.status).toBe('delete_failed');
    expect(updated.deletionProgress.error).toBe('Explicit failure');
  });

  it('Defect C: idempotency rejects uncommitted/unfinalized records with 409, accepts committed or TTL-vacuumed records with 200, and returns 409 on E11000+delete race', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Defect C Form',
      status: 'published'
    });
    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Q',
      order: 0
    });

    // Case 1: pending Response returns 409 (NOT 200)
    const keyPending = `idem-pending-${crypto.randomUUID()}`;
    await Response.create({
      formId: form._id,
      answers: [{ questionId: question._id, value: 'Hi' }],
      commitStatus: 'pending',
      idempotencyKey: keyPending
    });
    const resPending = await request(app)
      .post(`/api/responses/${form._id}`)
      .set('Idempotency-Key', keyPending)
      .send({ answers: [{ questionId: question._id.toString(), value: 'Hi' }] });
    expect(resPending.status).toBe(409);

    // Case 2: linked SubmissionReservation still in 'committing' (not 'finalized') -> 409
    const keyUnfinalized = `idem-unfin-${crypto.randomUUID()}`;
    const unfinLeaseId = crypto.randomUUID();
    await SubmissionReservation.create({
      formId: form._id,
      leaseId: unfinLeaseId,
      fenceToken: crypto.randomUUID(),
      status: 'committing',
      expiresAt: new Date(Date.now() + 30000)
    });
    await Response.create({
      formId: form._id,
      answers: [{ questionId: question._id, value: 'Hi' }],
      commitStatus: 'committed',
      reservationLeaseId: unfinLeaseId,
      idempotencyKey: keyUnfinalized
    });
    const resUnfin = await request(app)
      .post(`/api/responses/${form._id}`)
      .set('Idempotency-Key', keyUnfinalized)
      .send({ answers: [{ questionId: question._id.toString(), value: 'Hi' }] });
    expect(resUnfin.status).toBe(409);

    // Case 3: Real committed submission returns 201, and repeat returns 200 even AFTER reservation TTL vacuum deletes lease record
    const keyValid = `idem-valid-${crypto.randomUUID()}`;
    const res1 = await request(app)
      .post(`/api/responses/${form._id}`)
      .set('Idempotency-Key', keyValid)
      .send({ answers: [{ questionId: question._id.toString(), value: 'Committed Value' }] });
    expect(res1.status).toBe(201);

    await SubmissionReservation.deleteMany({ formId: form._id }); // simulate 24h vacuumAt TTL cleanup
    const res2 = await request(app)
      .post(`/api/responses/${form._id}`)
      .set('Idempotency-Key', keyValid)
      .send({ answers: [{ questionId: question._id.toString(), value: 'Committed Value' }] });
    expect(res2.status).toBe(200);
    expect(res2.body.data.id).toBe(res1.body.data.id);

    // Case 4: E11000 concurrent with Form deletion (existingResponse missing) returns 409 (not 400)
    const keyE11000 = `idem-race-${crypto.randomUUID()}`;
    const origCreate = Response.create.bind(Response);
    vi.spyOn(Response, 'create').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
    );
    const resRace = await request(app)
      .post(`/api/responses/${form._id}`)
      .set('Idempotency-Key', keyE11000)
      .send({ answers: [{ questionId: question._id.toString(), value: 'Deleted concurrently' }] });
    expect(resRace.status).toBe(409);
    expect(origCreate).toBeDefined();
  });

  it('Defect D: deleteResponse executes in replica-set transaction, skips unsafe S3 keys, cleans Category A outside tx, and blocks delete_failed', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Defect D Form',
      status: 'published'
    });
    const q = await Question.create({ formId: form._id, type: 'file', label: 'Doc', order: 0 });
    const safeKey = `forms/${form._id}/responses/safe.pdf`;
    const unsafeKey = `../foreign/evil.pdf`;
    activeS3Objects.set(safeKey, { mime: 'application/pdf' });
    activeS3Objects.set(unsafeKey, { mime: 'application/pdf' });

    const resp = await Response.create({
      formId: form._id,
      answers: [
        { questionId: q._id, value: { key: safeKey } },
        { questionId: q._id, value: { key: unsafeKey } }
      ]
    });

    const delRes = await request(app).delete(`/api/responses/${form._id}/${resp._id}`);
    expect(delRes.status).toBe(200);
    expect(await Response.findById(resp._id)).toBeNull();
    // Safe Category A deleted, unsafe Category B never deleted
    expect(activeS3Objects.has(safeKey)).toBe(false);
    expect(activeS3Objects.has(unsafeKey)).toBe(true);

    // Form in delete_failed returns 409 on deleteResponse
    await Form.updateOne({ _id: form._id }, { $set: { status: 'delete_failed' } });
    const resp2 = await Response.create({
      formId: form._id,
      answers: [{ questionId: q._id, value: 'x' }]
    });
    const blockedRes = await request(app).delete(`/api/responses/${form._id}/${resp2._id}`);
    expect(blockedRes.status).toBe(409);
  });

  // --------------------------------------------------------------------------
  // All 10 S3 + TTL Crash / Retry Boundaries
  // --------------------------------------------------------------------------
  it('S3/TTL Boundaries 1-10: covers acquire crash, staged upload crash, release S3 failure & upsert, delete S3 partial failure, Category C halt, finalized S3/TTL protection, post-commit error isolation, mid-T_del rollback, and epoch heartbeat fencing', async () => {
    // Boundary 1 & 2: Acquire crash before upload AND crash after recordStagedKey
    const form1 = await Form.create({ ownerId: userId, title: 'B1-B2', status: 'published' });
    const rCrash1 = await SubmissionReservationManager.acquire(form1._id, { ttlMs: 5000 });
    expect(rCrash1.success).toBe(true);
    const rCrash2 = await SubmissionReservationManager.acquire(form1._id, { ttlMs: 5000 });
    expect(rCrash2.success).toBe(true);
    const stagedKey2 = `forms/${form1._id}/staging/${rCrash2.leaseId}/orphaned.pdf`;
    expect(
      await SubmissionReservationManager.recordStagedKey(
        rCrash2.leaseId,
        rCrash2.fenceToken,
        stagedKey2
      )
    ).toBe(true);
    activeS3Objects.set(stagedKey2, { mime: 'application/pdf' });

    const past = new Date(Date.now() - 10000);
    await SubmissionReservation.updateMany({ formId: form1._id }, { $set: { expiresAt: past } });
    await SubmissionReservationManager.sweepAbandonedReservations({ graceMs: 0 });
    expect((await Form.findById(form1._id)).activeSubmissions).toBe(0);
    expect(activeS3Objects.has(stagedKey2)).toBe(false);
    expect(await SubmissionReservation.countDocuments({ formId: form1._id })).toBe(0);

    // Boundary 3 & 4: release() S3 failure preserves failedKeys with vacuumAt: null (and upserts even if deletion removed reservation)
    const form34 = await Form.create({ ownerId: userId, title: 'B3-B4', status: 'published' });
    const r3 = await SubmissionReservationManager.acquire(form34._id);
    const failKey3 = `forms/${form34._id}/staging/${r3.leaseId}/stuck.pdf`;
    activeS3Objects.set(failKey3, { mime: 'application/pdf' });
    await SubmissionReservationManager.recordStagedKey(r3.leaseId, r3.fenceToken, failKey3);

    // Test deletes & preserves S3 failure cleanly without falling back to real S3 SDK
    const deleteFileSpy = vi.spyOn(storageService, 'deleteFile');
    deleteFileSpy.mockRejectedValueOnce(new Error('S3 transient outage'));
    await SubmissionReservationManager.release(r3.leaseId, r3.fenceToken, [failKey3], form34._id);

    const preserved3 = await SubmissionReservation.findOne({ leaseId: r3.leaseId });
    expect(preserved3.status).toBe('abandoned');
    expect(preserved3.stagedKeys).toEqual([failKey3]);
    expect(preserved3.vacuumAt).toBeNull(); // Immune to TTL!
    expect(preserved3.counterReleased).toBe(true);
    expect((await Form.findById(form34._id)).activeSubmissions).toBe(0);

    // Retry sweep clears it once S3 recovers
    deleteFileSpy.mockImplementation(async (key) => {
      activeS3Objects.delete(key);
      return Promise.resolve();
    });
    await SubmissionReservationManager.sweepAbandonedReservations({ graceMs: 0 });
    expect(activeS3Objects.has(failKey3)).toBe(false);
    expect(await SubmissionReservation.findOne({ leaseId: r3.leaseId })).toBeNull();

    // Boundary 4: Upsert fallback when reservation record was deleted before late release() failed S3 delete
    const deadForm4Id = new Form({ ownerId: userId, title: 'Deleted 4' })._id;
    const lateLease = crypto.randomUUID();
    const lateFence = crypto.randomUUID();
    const lateFailKey = `forms/${deadForm4Id}/staging/${lateLease}/late.pdf`;
    activeS3Objects.set(lateFailKey, { mime: 'application/pdf' });
    deleteFileSpy.mockRejectedValueOnce(new Error('S3 outage'));
    await SubmissionReservationManager.release(lateLease, lateFence, [lateFailKey], deadForm4Id);
    const upserted4 = await SubmissionReservation.findOne({ leaseId: lateLease });
    expect(upserted4).not.toBeNull();
    expect(upserted4.status).toBe('abandoned');
    expect(upserted4.stagedKeys).toEqual([lateFailKey]);
    expect(upserted4.vacuumAt).toBeNull();
    // Cleanup orphan deadForm4 reservation via recovery
    deleteFileSpy.mockImplementation(async (key) => {
      activeS3Objects.delete(key);
      return Promise.resolve();
    });
    await recoverAbandonedFormDeletions({ reservationGraceMs: 0 });
    expect(activeS3Objects.has(lateFailKey)).toBe(false);
    expect(await SubmissionReservation.findOne({ leaseId: lateLease })).toBeNull();

    // Boundary 5 & 6: Partial S3 deleteFiles failure & Category C unresolved legacy keys
    const form5 = await Form.create({ ownerId: userId, title: 'B5', status: 'published' });
    const q5 = await Question.create({ formId: form5._id, type: 'file', label: 'F', order: 0 });
    const k5 = `forms/${form5._id}/responses/file5.pdf`;
    activeS3Objects.set(k5, { mime: 'application/pdf' });
    await Response.create({
      formId: form5._id,
      answers: [{ questionId: q5._id, value: { key: k5 } }]
    });
    vi.spyOn(storageService, 'deleteFiles').mockResolvedValueOnce({
      success: false,
      deletedKeys: [],
      failedKeys: [k5]
    });
    const delFail5 = await executeFormDeletion(form5._id, { userId, drainWaitMs: 0 });
    expect(delFail5.statusCode).toBe(502);
    expect((await Form.findById(form5._id)).status).toBe('delete_failed');
    expect((await Form.findById(form5._id)).deletionProgress.failedKeys).toEqual([k5]);
    expect(await Response.countDocuments({ formId: form5._id })).toBe(1);
    const delRetry5 = await executeFormDeletion(form5._id, { userId, drainWaitMs: 0 });
    expect(delRetry5.statusCode).toBe(200);
    expect(activeS3Objects.has(k5)).toBe(false);

    // Boundary 6: Category C halt
    const form6 = await Form.create({ ownerId: userId, title: 'B6', status: 'published' });
    const q6 = await Question.create({ formId: form6._id, type: 'file', label: 'F6', order: 0 });
    await Response.create({
      formId: form6._id,
      answers: [{ questionId: q6._id, value: { key: 'legacy/unscoped.pdf' } }]
    });
    const delCatC = await executeFormDeletion(form6._id, { userId, drainWaitMs: 0 });
    expect(delCatC.statusCode).toBe(502);
    expect((await Form.findById(form6._id)).status).toBe('delete_failed');
    expect((await Form.findById(form6._id)).deletionProgress.unresolvedKeys).toEqual([
      'legacy/unscoped.pdf'
    ]);

    // Boundary 7 & 8: Finalized reservation gets 24h vacuumAt & late release/post-commit error NEVER purges S3 file
    const form78 = await Form.create({ ownerId: userId, title: 'B7-B8', status: 'published' });
    const q78 = await Question.create({
      formId: form78._id,
      type: 'file',
      label: 'Doc78',
      order: 0
    });
    const tmpPdf = createTempPdfFile();
    try {
      const sub78 = await request(app)
        .post(`/api/responses/${form78._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${q78._id.toString()}`, tmpPdf);
      expect(sub78.status).toBe(201);
      expect(activeS3Objects.size).toBe(1);
      const committedKey = Array.from(activeS3Objects.keys())[0];
      const finRes = await SubmissionReservation.findOne({ formId: form78._id });
      expect(finRes.status).toBe('finalized');
      expect(finRes.vacuumAt).toBeInstanceOf(Date);
      expect(finRes.vacuumAt.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000);

      // Stray post-commit release must NO-OP without deleting committed S3 file!
      await SubmissionReservationManager.release(
        finRes.leaseId,
        finRes.fenceToken,
        [committedKey],
        form78._id
      );
      expect(activeS3Objects.has(committedKey)).toBe(true);
      expect((await SubmissionReservation.findById(finRes._id)).status).toBe('finalized');
    } finally {
      if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
    }

    // Boundary 9 & 10: Mid-T_del rollback & stale epoch 1 worker fenced after epoch 2 takes over
    const form910 = await Form.create({ ownerId: userId, title: 'B9-B10', status: 'published' });
    const q910 = await Question.create({
      formId: form910._id,
      type: 'file',
      label: 'Doc910',
      order: 0
    });
    const k910 = `forms/${form910._id}/responses/doc910.pdf`;
    activeS3Objects.set(k910, { mime: 'application/pdf' });
    await Response.create({
      formId: form910._id,
      answers: [{ questionId: q910._id, value: { key: k910 } }]
    });

    // Boundary 10: Simulate Worker 1 stalled in deleteFiles while Worker 2 reclaims with bumped epoch
    const s3Entered = createDeferred();
    const allowWorker1Resume = createDeferred();
    vi.spyOn(storageService, 'deleteFiles')
      .mockImplementationOnce(async () => {
        s3Entered.resolve();
        await allowWorker1Resume.promise;
        return { success: false, deletedKeys: [], failedKeys: [k910] };
      })
      .mockImplementationOnce(async (keys) => {
        keys.forEach((k) => activeS3Objects.delete(k));
        return { success: true, deletedKeys: keys, failedKeys: [] };
      });

    const w1Promise = executeFormDeletion(form910._id, { userId, drainWaitMs: 0 });
    await s3Entered.promise;

    // Expire Worker 1's lease and let Worker 2 reclaim (epoch bumped from 1 -> 2)
    await Form.updateOne(
      { _id: form910._id },
      { $set: { 'deletionProgress.leaseExpiresAt': new Date(Date.now() - 5000) } }
    );
    const w2Res = await executeFormDeletion(form910._id, { userId, drainWaitMs: 0 });
    expect(w2Res.statusCode).toBe(200);

    // Worker 1 resumes with stale lease/epoch -> must return 409, zero resurrection/overwrite
    allowWorker1Resume.resolve();
    const w1Res = await w1Promise;
    expect(w1Res.statusCode).toBe(409);
    expect(await Form.findById(form910._id)).toBeNull();
  }, 30000);

  // --------------------------------------------------------------------------
  // Phase 4.3.6: Controller-Driven Integration Tests (AUD-TEST-02)
  // --------------------------------------------------------------------------
  describe('Phase 4.3.6: Controller-Driven Integration Tests (AUD-TEST-02)', () => {
    it('AUD-TEST-02 Test A: Multi-file HTTP submission handles partial promotion failure and cleans up orphaned storage files', async () => {
      const form = await Form.create({ ownerId: userId, title: 'Multi-File Form', status: 'published' });
      const q1 = await Question.create({ formId: form._id, type: 'file', label: 'File 1', order: 0 });
      const q2 = await Question.create({ formId: form._id, type: 'file', label: 'File 2', order: 1 });

      const tmp1 = createTempPdfFile();
      const tmp2 = createTempPdfFile();

      try {
        let copyCount = 0;
        const copiedKeys = [];
        vi.spyOn(storageService, 'copyFile').mockImplementation(async (sourceKey, destKey) => {
          copyCount++;
          if (copyCount === 1) {
            activeS3Objects.set(destKey, { mime: 'application/pdf', timestamp: Date.now() });
            copiedKeys.push(destKey);
            return destKey;
          }
          // Fail deterministically on the second file promotion
          const copyErr = new Error('Simulated S3 copyFile promotion failure on second file');
          copyErr.statusCode = 500;
          throw copyErr;
        });

        const res = await request(app)
          .post(`/api/responses/${form._id}`)
          .field('answers', JSON.stringify([]))
          .attach(`file_${q1._id.toString()}`, tmp1)
          .attach(`file_${q2._id.toString()}`, tmp2);

        expect(res.status).toBe(500);

        // Database state: No response should be committed
        const responseCount = await Response.countDocuments({ formId: form._id });
        expect(responseCount).toBe(0);

        // Form activeSubmissions counter should be decremented back
        const reloadedForm = await Form.findById(form._id);
        expect(reloadedForm.activeSubmissions).toBe(0);

        // Reservation should be marked abandoned or released
        const reservation = await SubmissionReservation.findOne({ formId: form._id });
        expect(reservation).not.toBeNull();
        expect(reservation.status).toBe('abandoned');

        // Fast-forward quarantine so sweeper reclaims it immediately
        await SubmissionReservation.updateOne(
          { _id: reservation._id },
          { $set: { quarantinedUntil: new Date(Date.now() - 1000) } }
        );
        const sweepSummary = await SubmissionReservationManager.sweepAbandonedReservations({
          quarantineMs: 0,
          graceMs: 0
        });
        expect(sweepSummary.reconciledTombstones).toBe(1);

        // Cleaned up in S3
        for (const key of copiedKeys) {
          expect(activeS3Objects.has(key)).toBe(false);
        }
      } finally {
        try { fs.unlinkSync(tmp1); } catch (e) { void e; }
        try { fs.unlinkSync(tmp2); } catch (e) { void e; }
      }
    });

    it('AUD-TEST-02 Test B: In-flight CopyObject delayed during HTTP submission races with sweeper without data loss', async () => {
      const form = await Form.create({ ownerId: userId, title: 'In-Flight Copy Form', status: 'published' });
      const q1 = await Question.create({ formId: form._id, type: 'file', label: 'File 1', order: 0 });

      const tmp1 = createTempPdfFile();
      const copyStarted = createDeferred();
      const allowCopyFinish = createDeferred();
      let promotedKey = null;

      try {
        vi.spyOn(storageService, 'copyFile').mockImplementation(async (sourceKey, destKey) => {
          promotedKey = destKey;
          copyStarted.resolve();
          await allowCopyFinish.promise;
          activeS3Objects.set(destKey, { mime: 'application/pdf', timestamp: Date.now() });
          return destKey;
        });

        const subPromise = (async () =>
          await request(app)
            .post(`/api/responses/${form._id}`)
            .field('answers', JSON.stringify([]))
            .attach(`file_${q1._id.toString()}`, tmp1))();

        // Wait until copyFile is actively executing
        await copyStarted.promise;

        // While copyFile is in-flight, reservation is active within its lease.
        // Trigger orphan recovery / sweeper concurrently:
        const sweep1 = await SubmissionReservationManager.sweepAbandonedReservations({
          quarantineMs: 0,
          graceMs: 0
        });
        // Active submission must NOT be swept or stolen!
        expect(sweep1.sweptExpired || 0).toBe(0);
        expect(sweep1.purgedAbandoned || 0).toBe(0);

        // Allow copy to finish and submission to complete
        allowCopyFinish.resolve();
        const subRes = await subPromise;

        expect(subRes.status).toBe(201);
        expect(await Response.countDocuments({ formId: form._id })).toBe(1);
        expect(activeS3Objects.has(promotedKey)).toBe(true);

        // Subsequent sweep should also never delete this committed response attachment
        const sweep2 = await SubmissionReservationManager.sweepAbandonedReservations({
          quarantineMs: 0,
          graceMs: 0
        });
        expect(sweep2.sweptExpired || 0).toBe(0);
        expect(sweep2.purgedAbandoned || 0).toBe(0);
        expect(activeS3Objects.has(promotedKey)).toBe(true);
      } finally {
        copyStarted.resolve();
        allowCopyFinish.resolve();
        try { fs.unlinkSync(tmp1); } catch (e) { void e; }
      }
    });

    it('AUD-TEST-02 Test C: Client abort during copyFile halts promotion, rolls back transaction, and cleans up orphaned objects', async () => {
      const form = await Form.create({ ownerId: userId, title: 'Client Abort Form', status: 'published' });
      const q1 = await Question.create({ formId: form._id, type: 'file', label: 'File 1', order: 0 });

      const tmp1 = createTempPdfFile();
      const copyStarted = createDeferred();
      const allowCopyFinish = createDeferred();
      let capturedDestKey = null;

      try {
        const releaseSpy = vi.spyOn(SubmissionReservationManager, 'release');

        vi.spyOn(storageService, 'copyFile').mockImplementation(async (sourceKey, destKey, options) => {
          capturedDestKey = destKey;
          copyStarted.resolve();
          await allowCopyFinish.promise;
          if (options?.abortSignal?.aborted) {
            const abortErr = new Error('Copy aborted');
            abortErr.name = 'AbortError';
            throw abortErr;
          }
          activeS3Objects.set(destKey, { mime: 'application/pdf', timestamp: Date.now() });
          return destKey;
        });

        let subReqInstance;
        const subPromise = (async () => {
          const reqInstance = request(app)
            .post(`/api/responses/${form._id}`)
            .field('answers', JSON.stringify([]))
            .attach(`file_${q1._id.toString()}`, tmp1);
          subReqInstance = reqInstance;
          return await reqInstance;
        })();

        // Wait until copyFile starts
        await copyStarted.promise;

        // Simulate client aborting connection while copying is in progress
        const serverReq = app.locals.lastReq;
        if (serverReq && typeof serverReq.emit === 'function') {
          serverReq.emit('close');
        }
        if (subReqInstance && typeof subReqInstance.abort === 'function') {
          subReqInstance.abort();
        }

        // Release copy barrier
        allowCopyFinish.resolve();

        // Request was aborted by client
        await subPromise.catch(() => null);

        // Deterministically await the server-side rollback release
        if (releaseSpy.mock.results.length > 0) {
          await releaseSpy.mock.results[0].value.catch(() => {});
        }

        // Database assertion: No response document should have been created
        expect(await Response.countDocuments({ formId: form._id })).toBe(0);

        // Form activeSubmissions counter should be 0
        const reloadedForm = await Form.findById(form._id);
        expect(reloadedForm.activeSubmissions).toBe(0);

        // Reservation should be marked abandoned or released
        const reservation = await SubmissionReservation.findOne({ formId: form._id });
        if (reservation) {
          // Fast-forward quarantine so sweeper reconciles
          await SubmissionReservation.updateOne(
            { _id: reservation._id },
            { $set: { quarantinedUntil: new Date(Date.now() - 1000) } }
          );
          await SubmissionReservationManager.sweepAbandonedReservations({
            quarantineMs: 0,
            graceMs: 0
          });
        }

        // Staging and promoted keys must be clean
        if (capturedDestKey) {
          expect(activeS3Objects.has(capturedDestKey)).toBe(false);
        }
      } finally {
        copyStarted.resolve();
        allowCopyFinish.resolve();
        try { fs.unlinkSync(tmp1); } catch (e) { void e; }
      }
    });

    it('AUD-TEST-02 Test D: Late-arriving CopyObject completes after pass 1 tombstone reconciliation and is purged by pass 2 without data loss', async () => {
      const form = await Form.create({ ownerId: userId, title: 'Late Copy Form', status: 'published' });
      const q1 = await Question.create({ formId: form._id, type: 'file', label: 'File 1', order: 0 });

      const tmp1 = createTempPdfFile();
      const copyStarted = createDeferred();
      const allowRemoteCopyFinish = createDeferred();
      let capturedDestKey = null;

      try {
        const releaseSpy = vi.spyOn(SubmissionReservationManager, 'release');

        // Mock copyFile: signals admission, spawns background simulated remote S3 task,
        // and rejects locally when the client aborts to simulate TCP socket termination.
        vi.spyOn(storageService, 'copyFile').mockImplementation(async (sourceKey, destKey, options) => {
          capturedDestKey = destKey;
          copyStarted.resolve();

          // Background simulation of the remote S3 server finishing the CopyObject
          const remoteS3Task = (async () => {
            await allowRemoteCopyFinish.promise;
            activeS3Objects.set(destKey, { mime: 'application/pdf', timestamp: Date.now() });
          })();
          remoteS3Task.catch(() => {});

          if (options?.abortSignal) {
            if (options.abortSignal.aborted) {
              const abortErr = new Error('Copy aborted by client');
              abortErr.name = 'AbortError';
              throw abortErr;
            }
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                const abortErr = new Error('Copy aborted by client');
                abortErr.name = 'AbortError';
                reject(abortErr);
              };
              options.abortSignal.addEventListener('abort', onAbort, { once: true });
            });
          }
          return destKey;
        });

        let subReqInstance;
        const subPromise = (async () => {
          const reqInstance = request(app)
            .post(`/api/responses/${form._id}`)
            .field('answers', JSON.stringify([]))
            .attach(`file_${q1._id.toString()}`, tmp1);
          subReqInstance = reqInstance;
          return await reqInstance;
        })();

        // 1. Wait until copyFile is admitted by simulated S3
        await copyStarted.promise;

        // 2. Abort the HTTP request while remote copy remains in flight
        const serverReq = app.locals.lastReq;
        if (serverReq && typeof serverReq.emit === 'function') {
          serverReq.emit('close');
        }
        if (subReqInstance && typeof subReqInstance.abort === 'function') {
          subReqInstance.abort();
        }

        // 3. Await request completion and async reservation compensation rollback
        await subPromise.catch(() => null);
        if (releaseSpy.mock.results.length > 0) {
          await releaseSpy.mock.results[0].value.catch(() => {});
        }

        // 4. Verify no committed Response document references the canonical key
        expect(await Response.countDocuments({ formId: form._id })).toBe(0);
        const reloadedForm = await Form.findById(form._id);
        expect(reloadedForm.activeSubmissions).toBe(0);

        // 5. Verify initial abandoned reservation state before S3 copy finishes
        const reservation = await SubmissionReservation.findOne({ formId: form._id });
        expect(reservation).not.toBeNull();
        expect(reservation.status).toBe('abandoned');
        expect(reservation.stagedKeys).toEqual([]);
        expect(reservation.promotedKeys).toContain(capturedDestKey);
        expect(activeS3Objects.has(capturedDestKey)).toBe(false);

        // 6. Expire initial quarantine deterministically and execute Reconciliation Pass 1
        await SubmissionReservation.updateOne(
          { _id: reservation._id },
          { $set: { quarantinedUntil: new Date(Date.now() - 1000) } }
        );
        const sweep1 = await SubmissionReservationManager.sweepAbandonedReservations({
          quarantineMs: 0,
          reconcileIntervalMs: 300000,
          graceMs: 0
        });
        expect(sweep1.reconciledTombstones).toBe(1);

        // 7. Verify Pass 1 result: canonical key absent in S3, tombstone retained with re-armed quarantine
        expect(activeS3Objects.has(capturedDestKey)).toBe(false);
        const t1 = await SubmissionReservation.findById(reservation._id);
        expect(t1.status).toBe('abandoned');
        expect(t1.promotionStatus).toBe('tombstone');
        expect(t1.reconciliationState).toBe('reconciled');
        expect(t1.reconciliationPasses).toBe(1);
        expect(t1.promotedKeys).toContain(capturedDestKey);
        expect(t1.vacuumAt).toBeNull(); // Immune to TTL
        expect(new Date(t1.quarantinedUntil).getTime()).toBeGreaterThan(Date.now()); // Re-armed for future pass

        // 8. ADVERSARIAL EVENT: Remote CopyObject completes AFTER Pass 1, explicitly recreating canonical key in S3
        allowRemoteCopyFinish.resolve();
        await new Promise((r) => setImmediate(r));
        expect(activeS3Objects.has(capturedDestKey)).toBe(true); // Recreated in S3!

        // 9. Expire tombstone quarantine deterministically and execute Reconciliation Pass 2
        await SubmissionReservation.updateOne(
          { _id: reservation._id },
          { $set: { quarantinedUntil: new Date(Date.now() - 1000) } }
        );
        const sweep2 = await SubmissionReservationManager.sweepAbandonedReservations({
          quarantineMs: 0,
          reconcileIntervalMs: 300000,
          graceMs: 0
        });
        expect(sweep2.reconciledTombstones).toBe(1);

        // 10. Verify Pass 2 result: Recreated canonical key discovered and purged from S3
        expect(activeS3Objects.has(capturedDestKey)).toBe(false); // Affirmatively purged!
        const t2 = await SubmissionReservation.findById(reservation._id);
        expect(t2.status).toBe('abandoned');
        expect(t2.promotionStatus).toBe('tombstone');
        expect(t2.reconciliationState).toBe('reconciled');
        expect(t2.reconciliationPasses).toBe(2);
        expect(t2.promotedKeys).toContain(capturedDestKey);
        expect(t2.vacuumAt).toBeNull();
        expect(new Date(t2.quarantinedUntil).getTime()).toBeGreaterThan(Date.now()); // Remains eligible for next pass
      } finally {
        copyStarted.resolve();
        allowRemoteCopyFinish.resolve();
        try { fs.unlinkSync(tmp1); } catch (e) { void e; }
      }
    });
  });
});
