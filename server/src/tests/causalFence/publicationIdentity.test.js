/**
 * Suite 5: Publication Identity & Reservation Safety
 * File: server/src/tests/causalFence/publicationIdentity.test.js
 *
 * Verifies:
 * - Pre-generation of stable responseId and publicationAttemptId across transaction retries
 * - Idempotency key arbitration and 200 idempotent replay
 * - Compound unique index { formId: 1, idempotencyKey: 1 } enforcement
 * - Anonymous submissions (null idempotency key) partial index isolation
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import multer from 'multer';
import os from 'os';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { startReplSet, stopReplSet } from '../../testUtils/replSetHelper.js';
import Form from '../../models/form.js';
import Question from '../../models/question.js';
import Response from '../../models/response.js';
import User from '../../models/user.js';
import SubmissionReservation from '../../models/submissionReservation.js';
import StorageJournal from '../../models/storageJournal.js';
import { submitResponse } from '../../controllers/responseController.js';
import { withRequiredTransaction } from '../../utils/dbTransaction.js';
import * as instanceLeaseService from '../../services/instanceLeaseService.js';

describe('Suite 5: Publication Identity & Reservation Safety (publicationIdentity)', () => {
  let replSet;
  let app;
  let testUser;

  beforeAll(async () => {
    replSet = await startReplSet([
      Form,
      Question,
      Response,
      User,
      SubmissionReservation,
      StorageJournal
    ]);

    const upload = multer({ dest: os.tmpdir() });
    app = express();
    app.use(express.json());
    app.post('/api/forms/:formId/responses', upload.any(), submitResponse);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message });
    });
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
      name: 'Identity Test User',
      email: `identity-${Date.now()}@test.com`,
      password: 'password123'
    });

    await instanceLeaseService.ensureInstanceSingletonExists();
    await instanceLeaseService.acquireInstanceLease({ instanceId: 'inst-suite-5', skipHeartbeat: true });
  });

  it('5.1: Pre-generated responseId remains identical across transaction callback retries', async () => {
    const form = await Form.create({
      title: 'Retry Identity Form',
      ownerId: testUser._id,
      status: 'published',
      published: true,
      activeSubmissions: 0,
      maxSubmissions: 100
    });

    const preGeneratedId = new mongoose.Types.ObjectId();
    const publicationAttemptId = crypto.randomUUID();
    let attemptCount = 0;
    const insertedIds = [];

    await withRequiredTransaction(async (session) => {
      attemptCount++;
      const docData = {
        _id: preGeneratedId,
        formId: form._id,
        answers: [],
        payloadHash: 'dummy-hash',
        commitStatus: 'committed',
        publicationAttemptId
      };

      if (attemptCount === 1) {
        // Record ID on attempt 1, then simulate TransientTransactionError (write conflict)
        insertedIds.push(docData._id.toString());
        throw new mongoose.mongo.MongoServerError({
          message: 'WriteConflict on slot',
          errorLabels: ['TransientTransactionError']
        });
      }

      // Attempt 2: Successful insert
      insertedIds.push(docData._id.toString());
      const [created] = await Response.create([docData], { session });
      return created;
    }, { partitionKey: String(form._id) });

    expect(attemptCount).toBe(2);
    expect(insertedIds.length).toBe(2);
    expect(insertedIds[0]).toBe(insertedIds[1]);
    expect(insertedIds[0]).toBe(preGeneratedId.toString());

    // Verify stored doc
    const stored = await Response.findById(preGeneratedId).lean();
    expect(stored).toBeTruthy();
    expect(stored._id.toString()).toBe(preGeneratedId.toString());
    expect(stored.publicationAttemptId).toBe(publicationAttemptId);
  });

  it('5.2: Idempotent replay with same Idempotency-Key returns 200 with idempotentReplay: true', async () => {
    const form = await Form.create({
      title: 'Idempotency Form',
      ownerId: testUser._id,
      status: 'published',
      published: true,
      activeSubmissions: 0,
      maxSubmissions: 100
    });

    const question = await Question.create({
      formId: form._id,
      label: 'Your Name',
      type: 'short_text',
      required: false,
      order: 0
    });

    const idempotencyKey = 'idem-unique-key-12345';

    // 1st request: Success 201
    const res1 = await request(app)
      .post(`/api/forms/${form._id}/responses`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        answers: [{ questionId: question._id.toString(), value: 'Alice' }]
      });

    expect(res1.status).toBe(201);
    expect(res1.body.success).toBe(true);
    const createdId = res1.body.data.id;
    expect(createdId).toBeTruthy();

    // 2nd request: Idempotent replay 200
    const res2 = await request(app)
      .post(`/api/forms/${form._id}/responses`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        answers: [{ questionId: question._id.toString(), value: 'Alice' }]
      });

    expect(res2.status).toBe(200);
    expect(res2.body.success).toBe(true);
    expect(res2.body.message).toBe('Response already submitted');
    expect(res2.body.data.id).toBe(createdId);

    // Verify only ONE response document was created in MongoDB
    const count = await Response.countDocuments({ formId: form._id });
    expect(count).toBe(1);
  });

  it('5.3: Compound unique index prevents duplicate responses and arbitrates concurrent race', async () => {
    const form = await Form.create({
      title: 'Race Form',
      ownerId: testUser._id,
      status: 'published',
      published: true,
      activeSubmissions: 0,
      maxSubmissions: 100
    });

    const idempotencyKey = 'race-key-999';

    // Directly insert Response 1
    const resp1 = await Response.create({
      formId: form._id,
      answers: [],
      payloadHash: 'hash-1',
      idempotencyKey,
      commitStatus: 'committed'
    });

    expect(resp1).toBeTruthy();

    // Attempting to insert another Response with same (formId, idempotencyKey) must throw E11000
    let duplicateError = null;
    try {
      await Response.create({
        formId: form._id,
        answers: [],
        payloadHash: 'hash-2',
        idempotencyKey,
        commitStatus: 'committed'
      });
    } catch (err) {
      duplicateError = err;
    }

    expect(duplicateError).toBeTruthy();
    expect(duplicateError.code).toBe(11000);

    // Verify exactly one response exists
    const count = await Response.countDocuments({ formId: form._id, idempotencyKey });
    expect(count).toBe(1);
  });

  it('5.4: Anonymous submissions (null/omitted idempotencyKey) do not collide under partial unique index', async () => {
    const form = await Form.create({
      title: 'Anonymous Form',
      ownerId: testUser._id,
      status: 'published',
      published: true,
      activeSubmissions: 0,
      maxSubmissions: 100
    });

    const question = await Question.create({
      formId: form._id,
      label: 'Feedback',
      type: 'short_text',
      required: false,
      order: 0
    });

    // Request 1 without Idempotency-Key
    const res1 = await request(app)
      .post(`/api/forms/${form._id}/responses`)
      .send({
        answers: [{ questionId: question._id.toString(), value: 'First submission' }]
      });

    expect(res1.status).toBe(201);
    expect(res1.body.success).toBe(true);

    // Request 2 without Idempotency-Key
    const res2 = await request(app)
      .post(`/api/forms/${form._id}/responses`)
      .send({
        answers: [{ questionId: question._id.toString(), value: 'Second submission' }]
      });

    expect(res2.status).toBe(201);
    expect(res2.body.success).toBe(true);

    expect(res1.body.data.id).toBeTruthy();
    expect(res2.body.data.id).toBeTruthy();
    expect(res1.body.data.id).not.toBe(res2.body.data.id);

    const count = await Response.countDocuments({ formId: form._id });
    expect(count).toBe(2);
  });
});
