import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import request from 'supertest';
import User from '../models/user.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import { connectDB, readinessHandler } from '../server.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  ReplicaSetRequiredError,
  verifyReplicaSetTopology,
  withRequiredTransaction,
  supportsTransactions
} from '../utils/dbTransaction.js';
import { SubmissionReservationManager } from '../utils/submissionReservationManager.js';
import {
  executeFormDeletion,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  reorderQuestions
} from './formController.js';
import { submitResponse, deleteResponse } from './responseController.js';

describe('Standalone MongoDB Fail-Closed Enforcement (No Fallback)', () => {
  let standaloneServer;
  let standaloneUri;
  let app;
  let owner;
  let ownerId;

  beforeAll(async () => {
    standaloneServer = await MongoMemoryServer.create();
    standaloneUri = standaloneServer.getUri();
    await mongoose.connect(standaloneUri);

    app = express();
    app.use(express.json());
    app.get('/health/ready', readinessHandler);
    app.post('/api/responses/:formId', submitResponse);
    app.delete(
      '/api/responses/:formId/:responseId',
      (req, res, next) => {
        req.user = { id: ownerId };
        next();
      },
      deleteResponse
    );
    app.post(
      '/api/forms/:id/questions',
      (req, res, next) => {
        req.user = { id: ownerId };
        next();
      },
      addQuestion
    );
    app.put(
      '/api/forms/:formId/questions/reorder',
      (req, res, next) => {
        req.user = { id: ownerId };
        next();
      },
      reorderQuestions
    );
    app.put(
      '/api/forms/:formId/questions/:questionId',
      (req, res, next) => {
        req.user = { id: ownerId };
        next();
      },
      updateQuestion
    );
    app.delete(
      '/api/forms/:formId/questions/:questionId',
      (req, res, next) => {
        req.user = { id: ownerId };
        next();
      },
      deleteQuestion
    );
    app.use(errorHandler);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (standaloneServer) {
      await standaloneServer.stop();
    }
  });

  beforeEach(async () => {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(standaloneUri);
    }
    await User.deleteMany({});
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});

    owner = await User.create({
      name: 'Standalone Owner',
      email: `standalone-${Date.now()}@example.com`,
      password: 'password123'
    });
    ownerId = owner._id.toString();
  });

  it('rejects standalone topology in supportsTransactions, verifyReplicaSetTopology, and withRequiredTransaction', async () => {
    expect(supportsTransactions(mongoose.connection)).toBe(false);

    await expect(verifyReplicaSetTopology(mongoose.connection)).rejects.toBeInstanceOf(
      ReplicaSetRequiredError
    );

    let callbackExecuted = false;
    await expect(
      withRequiredTransaction(async () => {
        callbackExecuted = true;
      })
    ).rejects.toThrow(/replica[- ]set/i);
    expect(callbackExecuted).toBe(false);
  });

  it('readinessHandler returns 503 not_ready on connected standalone MongoDB', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.database).toBe('disconnected');
  });

  it('connectDB fails closed on standalone MongoMemoryServer URI and closes the connection', async () => {
    await mongoose.disconnect();
    await expect(connectDB(standaloneUri, false)).rejects.toBeInstanceOf(ReplicaSetRequiredError);
    expect(mongoose.connection.readyState).toBe(0);
    // Reconnect for subsequent tests
    await mongoose.connect(standaloneUri);
  });

  it('fails closed without partial mutations on submitResponse, acquire, executeFormDeletion, deleteResponse, and question endpoints', async () => {
    const form = await Form.create({
      ownerId,
      title: 'Standalone Refused Form',
      status: 'published',
      version: 0
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
    const resp = await Response.create({
      formId: form._id,
      answers: [{ questionId: q1._id, value: 'Existing' }]
    });

    // 1. SubmissionReservationManager.acquire fails closed
    await expect(SubmissionReservationManager.acquire(form._id)).rejects.toBeInstanceOf(
      ReplicaSetRequiredError
    );
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);

    // 2. submitResponse fails closed with 503 and creates zero documents
    const subRes = await request(app)
      .post(`/api/responses/${form._id}`)
      .send({ answers: [{ questionId: q1._id.toString(), value: 'Should fail closed' }] });
    expect(subRes.status).toBe(503);
    expect(await Response.countDocuments({ formId: form._id })).toBe(1);
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);

    // 3. executeFormDeletion fails closed without mutating Form.status or Response
    await expect(
      executeFormDeletion(form._id, { userId: ownerId, drainWaitMs: 0 })
    ).rejects.toBeInstanceOf(ReplicaSetRequiredError);
    const unchangedForm = await Form.findById(form._id);
    expect(unchangedForm.status).toBe('published');
    expect(unchangedForm.deletionProgress.leaseId).toBeNull();
    expect(await Response.countDocuments({ formId: form._id })).toBe(1);

    // 4. Question add/update/delete/reorder fail closed with 503 and zero mutations
    const addRes = await request(app)
      .post(`/api/forms/${form._id}/questions`)
      .send({ type: 'short_text', label: 'Blocked Q3' });
    expect(addRes.status).toBe(503);
    expect(await Question.countDocuments({ formId: form._id })).toBe(2);

    const updRes = await request(app)
      .put(`/api/forms/${form._id}/questions/${q1._id}`)
      .send({ label: 'Blocked Update' });
    expect(updRes.status).toBe(503);
    expect((await Question.findById(q1._id)).label).toBe('Q1');

    const reorderRes = await request(app)
      .put(`/api/forms/${form._id}/questions/reorder`)
      .send({
        questionOrders: [
          { questionId: q1._id.toString(), order: 1 },
          { questionId: q2._id.toString(), order: 0 }
        ]
      });
    expect(reorderRes.status).toBe(503);
    expect((await Question.findById(q1._id)).order).toBe(0);

    const delQRes = await request(app).delete(`/api/forms/${form._id}/questions/${q2._id}`);
    expect(delQRes.status).toBe(503);
    expect(await Question.countDocuments({ formId: form._id })).toBe(2);

    // 5. deleteResponse fails closed with 503 and preserves existing Response
    const delRespRes = await request(app).delete(`/api/responses/${form._id}/${resp._id}`);
    expect(delRespRes.status).toBe(503);
    expect(await Response.countDocuments({ formId: form._id })).toBe(1);
  });
});
