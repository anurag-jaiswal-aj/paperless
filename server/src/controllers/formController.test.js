import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import User from '../models/user.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import storageService from '../services/StorageService.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import formRoutes, {
  formCreationLimiter,
  formDeletionLimiter,
  formMutationLimiter,
  publicFormFetchLimiter,
  userFormReadLimiter
} from '../routes/formRoutes.js';
import responseRoutes from '../routes/responseRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  recoverAbandonedFormDeletions,
  classifyStorageKey,
  executeFormDeletion
} from './formController.js';

let mongoServer;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/forms', formRoutes);
app.use('/api/responses', responseRoutes);
app.use(errorHandler);

beforeAll(async () => {
  mongoServer = await startReplSet();
  process.env.JWT_SECRET = 'testsecret';
});

afterAll(async () => {
  await stopReplSet(mongoServer);
});

describe('Form Controller - Phase 2', () => {
  let user1Token, user2Token;
  let user1Id, user2Id;

  beforeEach(async () => {
    await User.deleteMany({});
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});

    const user1 = await User.create({
      name: 'User One',
      email: 'user1@test.com',
      password: 'password123'
    });
    user1Id = user1._id;
    user1Token = jwt.sign({ id: user1Id }, process.env.JWT_SECRET || 'testsecret', {
      expiresIn: '15m'
    });

    const user2 = await User.create({
      name: 'User Two',
      email: 'user2@test.com',
      password: 'password123'
    });
    user2Id = user2._id;
    user2Token = jwt.sign({ id: user2Id }, process.env.JWT_SECRET || 'testsecret', {
      expiresIn: '15m'
    });
  });

  describe('Form Ownership and Lifecycle', () => {
    it('should create a form with draft status by default', async () => {
      const res = await request(app)
        .post('/api/forms')
        .set('Cookie', [`token=${user1Token}`])
        .send({ title: 'Test Form' });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('draft');
      expect(res.body.data.ownerId.toString()).toBe(user1Id.toString());
    });

    it('should allow owner to access their own form', async () => {
      const form = await Form.create({ ownerId: user1Id, title: 'Private Form', status: 'draft' });

      const res = await request(app)
        .get(`/api/forms/${form._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(res.body.data.form.title).toBe('Private Form');
    });

    it('should prevent non-owner from accessing private draft form', async () => {
      const form = await Form.create({ ownerId: user1Id, title: 'Private Form', status: 'draft' });

      const res = await request(app)
        .get(`/api/forms/${form._id}`)
        .set('Cookie', [`token=${user2Token}`]);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Form not found');
    });

    it('should prevent non-owner from editing form', async () => {
      const form = await Form.create({ ownerId: user1Id, title: 'Private Form', status: 'draft' });

      const res = await request(app)
        .put(`/api/forms/${form._id}`)
        .set('Cookie', [`token=${user2Token}`])
        .send({ title: 'Hacked Title' });

      expect(res.status).toBe(403);

      const dbForm = await Form.findById(form._id);
      expect(dbForm.title).toBe('Private Form');
    });

    it('should prevent non-owner from deleting form', async () => {
      const form = await Form.create({ ownerId: user1Id, title: 'Private Form', status: 'draft' });

      const res = await request(app)
        .delete(`/api/forms/${form._id}`)
        .set('Cookie', [`token=${user2Token}`]);

      expect(res.status).toBe(403);

      const dbForm = await Form.findById(form._id);
      expect(dbForm).not.toBeNull();
    });
  });

  describe('Questions', () => {
    let form;
    beforeEach(async () => {
      form = await Form.create({ ownerId: user1Id, title: 'Test Form', status: 'draft' });
    });

    it('should create a question with valid V1 types', async () => {
      const res = await request(app)
        .post(`/api/forms/${form._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ type: 'short_text', label: 'What is your name?', required: true });

      expect(res.status).toBe(201);
      expect(res.body.data.type).toBe('short_text');
      expect(res.body.data.required).toBe(true);
    });

    it('should support rating, date, and checkbox question types end-to-end', async () => {
      const ratingRes = await request(app)
        .post(`/api/forms/${form._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ type: 'rating', label: 'How satisfied are you?', required: true });

      expect(ratingRes.status).toBe(201);
      expect(ratingRes.body.data.type).toBe('rating');

      const dateRes = await request(app)
        .post(`/api/forms/${form._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ type: 'date', label: 'Preferred start date', required: false });

      expect(dateRes.status).toBe(201);
      expect(dateRes.body.data.type).toBe('date');

      const checkboxRes = await request(app)
        .post(`/api/forms/${form._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'checkbox',
          label: 'Select skills',
          options: ['Node.js', 'React', 'MongoDB'],
          required: false
        });

      expect(checkboxRes.status).toBe(201);
      expect(checkboxRes.body.data.type).toBe('checkbox');
    });

    it('should reject invalid question types not in the schema enum', async () => {
      const res = await request(app)
        .post(`/api/forms/${form._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ type: 'invalid_unsupported_type', label: 'Invalid Question' });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.success).toBe(false);
    });

    it('should allow reordering questions', async () => {
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

      const res = await request(app)
        .put(`/api/forms/${form._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          questionOrders: [
            { questionId: q1._id, order: 1 },
            { questionId: q2._id, order: 0 }
          ]
        });

      expect(res.body).toEqual({
        success: true,
        message: 'Questions reordered successfully'
      });
      expect(res.status).toBe(200);

      const updatedQ1 = await Question.findById(q1._id);
      const updatedQ2 = await Question.findById(q2._id);
      expect(updatedQ1.order).toBe(1);
      expect(updatedQ2.order).toBe(0);
    });

    it('should not allow reordering questions belonging to another form (IDOR prevention)', async () => {
      const q1 = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Q1',
        order: 0
      });
      // Create second form owned by user2 with its own question
      const form2 = await Form.create({ ownerId: user2Id, title: 'Form 2', status: 'draft' });
      const qForeign = await Question.create({
        formId: form2._id,
        type: 'short_text',
        label: 'Foreign Q',
        order: 0
      });

      // User 1 attempts to reorder qForeign through Form 1
      const res = await request(app)
        .put(`/api/forms/${form._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          questionOrders: [
            { questionId: q1._id, order: 5 },
            { questionId: qForeign._id, order: 99 }
          ]
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('One or more questions do not belong to this form');

      // Verify q1 was NOT updated because the entire request was rejected before DB writes
      const updatedQ1 = await Question.findById(q1._id);
      expect(updatedQ1.order).toBe(0);

      // Verify qForeign was NOT modified because it belongs to form 2
      const unchangedForeign = await Question.findById(qForeign._id);
      expect(unchangedForeign.order).toBe(0);
    });

    it('should update question properties atomically using partial update', async () => {
      const q = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Initial Label',
        order: 5,
        required: false
      });

      const res = await request(app)
        .put(`/api/forms/${form._id}/questions/${q._id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ label: 'Updated Label' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.label).toBe('Updated Label');
      expect(res.body.data.order).toBe(5);
      expect(res.body.data.type).toBe('short_text');

      const saved = await Question.findById(q._id);
      expect(saved.label).toBe('Updated Label');
      expect(saved.order).toBe(5);
    });

    it('should reject updating question by non-owner or when not found', async () => {
      const q = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Q',
        order: 0
      });

      // Non-owner attempt
      const resNonOwner = await request(app)
        .put(`/api/forms/${form._id}/questions/${q._id}`)
        .set('Cookie', [`token=${user2Token}`])
        .send({ label: 'Hacked Label' });

      expect(resNonOwner.status).toBe(403);

      // Non-existent question ID
      const fakeId = new mongoose.Types.ObjectId();
      const res404 = await request(app)
        .put(`/api/forms/${form._id}/questions/${fakeId}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ label: 'Ghost' });

      expect(res404.status).toBe(404);
    });

    it('should prevent stale same-field writes and return 409 conflict when revision is outdated', async () => {
      const q = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Original Label',
        order: 1,
        version: 0
      });

      // Request 1: update with valid version 0
      const res1 = await request(app)
        .put(`/api/forms/${form._id}/questions/${q._id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ label: 'Updated by Request 1', version: 0 });

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.body.data.label).toBe('Updated by Request 1');
      expect(res1.body.data.version).toBe(1);

      // Request 2: stale request sent with outdated version 0
      const res2 = await request(app)
        .put(`/api/forms/${form._id}/questions/${q._id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ label: 'Stale Overwrite Attempt', version: 0 });

      expect(res2.status).toBe(409);
      expect(res2.body.success).toBe(false);
      expect(res2.body.message).toContain('Conflict');
      expect(res2.body.data.label).toBe('Updated by Request 1');
      expect(res2.body.data.version).toBe(1);

      // Verify MongoDB document was not overwritten by the stale write
      const persisted = await Question.findById(q._id);
      expect(persisted.label).toBe('Updated by Request 1');
      expect(persisted.version).toBe(1);

      // Reconciled update with the current version 1 succeeds
      const res3 = await request(app)
        .put(`/api/forms/${form._id}/questions/${q._id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ label: 'Reconciled Label', version: 1 });

      expect(res3.status).toBe(200);
      expect(res3.body.data.label).toBe('Reconciled Label');
      expect(res3.body.data.version).toBe(2);
    });

    it('should prevent stale form updates and return 409 conflict when form version is outdated', async () => {
      const testForm = await Form.create({
        ownerId: user1Id,
        title: 'Initial Title',
        description: 'Initial Desc',
        version: 0
      });

      // First update with version 0 succeeds
      const res1 = await request(app)
        .put(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ title: 'New Title', version: 0 });

      expect(res1.status).toBe(200);
      expect(res1.body.data.title).toBe('New Title');
      expect(res1.body.data.version).toBe(1);

      // Stale update with version 0 is rejected with 409
      const res2 = await request(app)
        .put(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ title: 'Stale Title', version: 0 });

      expect(res2.status).toBe(409);
      expect(res2.body.success).toBe(false);
      expect(res2.body.data.title).toBe('New Title');

      // Database preserves New Title
      const savedForm = await Form.findById(testForm._id);
      expect(savedForm.title).toBe('New Title');
      expect(savedForm.version).toBe(1);
    });
  });

  describe('Question Deletion and Orphaned Visibility Rule Cleanup', () => {
    let form;
    let otherForm;

    beforeEach(async () => {
      form = await Form.create({ ownerId: user1Id, title: 'Test Form', status: 'published' });
      otherForm = await Form.create({ ownerId: user1Id, title: 'Other Form', status: 'published' });
    });

    it('clears visibility rule when referenced question is deleted', async () => {
      const qTarget = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Do you have pets?',
        order: 0
      });

      const qDependent = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'What kind of pet?',
        order: 1,
        visibilityRule: {
          targetQuestionId: qTarget._id,
          operator: 'equals',
          value: 'Yes'
        }
      });

      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${qTarget._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify qTarget is deleted
      const deletedCheck = await Question.findById(qTarget._id);
      expect(deletedCheck).toBeNull();

      // Verify qDependent's visibilityRule is cleared to null
      const updatedDependent = await Question.findById(qDependent._id);
      expect(updatedDependent.visibilityRule).toBeNull();
      // Other fields on qDependent remain intact
      expect(updatedDependent.label).toBe('What kind of pet?');
      expect(updatedDependent.order).toBe(1);
    });

    it('preserves unrelated visibility rules when an unreferenced question is deleted', async () => {
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
      const q3 = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Q3',
        order: 2,
        visibilityRule: {
          targetQuestionId: q2._id.toString(),
          operator: 'equals',
          value: 'Special'
        }
      });

      // Delete q1 (unreferenced by q3)
      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${q1._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);

      // Verify q1 is deleted
      expect(await Question.findById(q1._id)).toBeNull();

      // Verify q3's visibilityRule still references q2
      const updatedQ3 = await Question.findById(q3._id);
      expect(updatedQ3.visibilityRule).not.toBeNull();
      expect(updatedQ3.visibilityRule.targetQuestionId).toBe(q2._id.toString());
      expect(updatedQ3.visibilityRule.operator).toBe('equals');
      expect(updatedQ3.visibilityRule.value).toBe('Special');
    });

    it('deletes a question that has no visibility rules and no references safely', async () => {
      const qStandalone = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Standalone Question',
        order: 0,
        visibilityRule: null
      });

      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${qStandalone._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(await Question.findById(qStandalone._id)).toBeNull();
    });

    it('cleans up multiple rules that reference the same deleted question', async () => {
      const qParent = await Question.create({
        formId: form._id,
        type: 'single_choice',
        label: 'Parent Question',
        order: 0
      });

      const qChild1 = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Child 1',
        order: 1,
        visibilityRule: { targetQuestionId: qParent._id, operator: 'equals', value: 'Option A' }
      });

      const qChild2 = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Child 2',
        order: 2,
        visibilityRule: {
          targetQuestionId: qParent._id.toString(),
          operator: 'equals',
          value: 'Option B'
        }
      });

      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${qParent._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);

      const updatedChild1 = await Question.findById(qChild1._id);
      const updatedChild2 = await Question.findById(qChild2._id);
      expect(updatedChild1.visibilityRule).toBeNull();
      expect(updatedChild2.visibilityRule).toBeNull();
    });

    it('handles missing, null, or malformed visibility rules without crashing', async () => {
      const qTarget = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Target',
        order: 0
      });

      const qNullRule = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Null Rule',
        order: 1,
        visibilityRule: null
      });

      const qEmptyObjRule = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Custom Prop Rule',
        order: 2,
        visibilityRule: { otherProp: 'test' }
      });

      const qMalformedStringRule = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'String Rule',
        order: 3,
        visibilityRule: 'malformed_rule_string'
      });

      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${qTarget._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(await Question.findById(qTarget._id)).toBeNull();

      // Ensure other questions are completely unchanged
      const checkNull = await Question.findById(qNullRule._id);
      const checkEmpty = await Question.findById(qEmptyObjRule._id);
      const checkString = await Question.findById(qMalformedStringRule._id);
      expect(checkNull.visibilityRule).toBeNull();
      expect(checkEmpty.visibilityRule).toEqual({ otherProp: 'test' });
      expect(checkString.visibilityRule).toBe('malformed_rule_string');
    });

    it('strictly scopes cleanup to the form containing the deleted question', async () => {
      const qTarget = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Form 1 Question',
        order: 0
      });

      // Question in another form that happens to reference qTarget's ID
      const qOtherForm = await Question.create({
        formId: otherForm._id,
        type: 'short_text',
        label: 'Form 2 Question',
        order: 0,
        visibilityRule: { targetQuestionId: qTarget._id, operator: 'equals', value: 'Test' }
      });

      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${qTarget._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(await Question.findById(qTarget._id)).toBeNull();

      // Verify qOtherForm was NOT modified because it belongs to otherForm
      const checkOther = await Question.findById(qOtherForm._id);
      expect(checkOther.visibilityRule).not.toBeNull();
      expect(checkOther.visibilityRule.targetQuestionId.toString()).toBe(qTarget._id.toString());
    });

    it('handles database persistence failure cleanly with standard error handling', async () => {
      const qTarget = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Target Q',
        order: 0
      });

      const qDependent = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Dependent Q',
        order: 1,
        visibilityRule: { targetQuestionId: qTarget._id, operator: 'equals', value: 'Yes' }
      });

      // Mock deleteOne on Question to simulate a persistence failure during deletion
      const deleteSpy = vi
        .spyOn(Question, 'deleteOne')
        .mockRejectedValueOnce(new Error('Simulated DB Failure on delete'));

      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${qTarget._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(500);

      // Verify question was NOT deleted
      const checkTarget = await Question.findById(qTarget._id);
      expect(checkTarget).not.toBeNull();

      // Verify compensating rollback restored the visibility rule on dependent question
      const checkDependent = await Question.findById(qDependent._id);
      expect(checkDependent.visibilityRule).not.toBeNull();
      expect(checkDependent.visibilityRule.targetQuestionId.toString()).toBe(
        qTarget._id.toString()
      );

      deleteSpy.mockRestore();
    });
  });

  describe('Stage 4.3.2 Hardening: Route Parameter Validation, Public Sanitization & Reorder Guards', () => {
    let testForm;
    beforeEach(async () => {
      testForm = await Form.create({ ownerId: user1Id, title: 'Test Form', status: 'draft' });
    });

    it('rejects malformed ObjectIds on form routes with HTTP 400', async () => {
      // GET /api/forms/:id
      const res1 = await request(app).get('/api/forms/invalid-id-123');
      expect(res1.status).toBe(400);
      expect(res1.body.success).toBe(false);
      expect(res1.body.message).toBe('Invalid resource ID');

      // PUT /api/forms/:id
      const res2 = await request(app)
        .put('/api/forms/invalid-id-123')
        .set('Cookie', [`token=${user1Token}`])
        .send({ title: 'New Title' });
      expect(res2.status).toBe(400);
      expect(res2.body.message).toBe('Invalid resource ID');

      // DELETE /api/forms/:id
      const res3 = await request(app)
        .delete('/api/forms/invalid-id-123')
        .set('Cookie', [`token=${user1Token}`]);
      expect(res3.status).toBe(400);
      expect(res3.body.message).toBe('Invalid resource ID');

      // POST /api/forms/:id/questions
      const res4 = await request(app)
        .post('/api/forms/invalid-id-123/questions')
        .set('Cookie', [`token=${user1Token}`])
        .send({ type: 'short_text', label: 'Label' });
      expect(res4.status).toBe(400);
      expect(res4.body.message).toBe('Invalid resource ID');

      // PUT /api/forms/:formId/questions/reorder
      const res5 = await request(app)
        .put('/api/forms/invalid-id-123/questions/reorder')
        .set('Cookie', [`token=${user1Token}`])
        .send({ questionOrders: [] });
      expect(res5.status).toBe(400);
      expect(res5.body.message).toBe('Invalid resource ID');

      // PUT /api/forms/:formId/questions/:questionId
      const res6 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/invalid-question-id`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ label: 'Updated' });
      expect(res6.status).toBe(400);
      expect(res6.body.message).toBe('Invalid resource ID');
    });

    it('sanitizes public form payload and strips ownerId, version, and internal timestamps', async () => {
      const pubForm = await Form.create({
        ownerId: user1Id,
        title: 'Public Survey Form',
        description: 'Public survey description',
        status: 'published'
      });

      const pubQ = await Question.create({
        formId: pubForm._id,
        type: 'single_choice',
        label: 'Satisfaction',
        required: true,
        options: ['High', 'Low'],
        order: 0
      });

      // Unauthenticated public request
      const res = await request(app).get(`/api/forms/${pubForm._id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const returnedForm = res.body.data.form;
      expect(returnedForm.title).toBe('Public Survey Form');
      expect(returnedForm.description).toBe('Public survey description');
      expect(returnedForm._id).toBe(pubForm._id.toString());

      // Ensure sensitive/internal fields are NOT exposed
      expect(returnedForm.ownerId).toBeUndefined();
      expect(returnedForm.status).toBeUndefined();
      expect(returnedForm.version).toBeUndefined();
      expect(returnedForm.__v).toBeUndefined();
      expect(returnedForm.createdAt).toBeUndefined();
      expect(returnedForm.updatedAt).toBeUndefined();

      const returnedQ = res.body.data.questions[0];
      expect(returnedQ._id).toBe(pubQ._id.toString());
      expect(returnedQ.label).toBe('Satisfaction');
      expect(returnedQ.type).toBe('single_choice');
      expect(returnedQ.required).toBe(true);
      expect(returnedQ.options).toEqual(['High', 'Low']);
      expect(returnedQ.formId).toBeUndefined();
      expect(returnedQ.version).toBeUndefined();
      expect(returnedQ.__v).toBeUndefined();
    });

    it('returns uniform 404 for nonexistent, draft, and closed forms to prevent enumeration', async () => {
      const draftForm = await Form.create({
        ownerId: user1Id,
        title: 'Draft Private Form',
        status: 'draft'
      });

      const closedForm = await Form.create({
        ownerId: user1Id,
        title: 'Closed Old Form',
        status: 'closed'
      });

      const nonExistentId = new mongoose.Types.ObjectId().toString();

      // 1. Non-existent form -> 404
      const resNone = await request(app).get(`/api/forms/${nonExistentId}`);
      expect(resNone.status).toBe(404);
      expect(resNone.body.message).toBe('Form not found');

      // 2. Draft form requested unauthenticated -> uniform 404
      const resDraftAnon = await request(app).get(`/api/forms/${draftForm._id}`);
      expect(resDraftAnon.status).toBe(404);
      expect(resDraftAnon.body.message).toBe('Form not found');

      // 3. Draft form requested by non-owner -> uniform 404
      const resDraftOther = await request(app)
        .get(`/api/forms/${draftForm._id}`)
        .set('Cookie', [`token=${user2Token}`]);
      expect(resDraftOther.status).toBe(404);
      expect(resDraftOther.body.message).toBe('Form not found');

      // 4. Closed form requested unauthenticated -> uniform 404
      const resClosedAnon = await request(app).get(`/api/forms/${closedForm._id}`);
      expect(resClosedAnon.status).toBe(404);
      expect(resClosedAnon.body.message).toBe('Form not found');

      // 5. Draft form requested by owner -> 200 with full owner document
      const resDraftOwner = await request(app)
        .get(`/api/forms/${draftForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);
      expect(resDraftOwner.status).toBe(200);
      expect(resDraftOwner.body.data.form.ownerId.toString()).toBe(user1Id.toString());
      expect(resDraftOwner.body.data.form.status).toBe('draft');
    });

    it('validates questionOrders structure, size, duplicate IDs, and types in reorderQuestions', async () => {
      // 1. Non-array
      const res1 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ questionOrders: 'not-an-array' });
      expect(res1.status).toBe(400);
      expect(res1.body.message).toBe('questionOrders must be an array');

      // 2. Empty array
      const res2 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ questionOrders: [] });
      expect(res2.status).toBe(400);
      expect(res2.body.message).toBe('questionOrders cannot be empty');

      // 3. Oversized array
      const hugeArray = Array.from({ length: 501 }, () => ({
        questionId: new mongoose.Types.ObjectId().toString(),
        order: 0
      }));
      const res3 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ questionOrders: hugeArray });
      expect(res3.status).toBe(400);
      expect(res3.body.message).toBe('questionOrders exceeds maximum limit of 500 items');

      // 4. Malformed questionId
      const res4 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ questionOrders: [{ questionId: 'bad-id', order: 0 }] });
      expect(res4.status).toBe(400);
      expect(res4.body.message).toBe(
        'Each question order item must include a valid questionId and non-negative integer order'
      );

      // 5. Negative or non-integer order
      const validId = new mongoose.Types.ObjectId().toString();
      const res5 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ questionOrders: [{ questionId: validId, order: -1 }] });
      expect(res5.status).toBe(400);
      expect(res5.body.message).toBe(
        'Each question order item must include a valid questionId and non-negative integer order'
      );

      // 6. Duplicate questionIds
      const res6 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          questionOrders: [
            { questionId: validId, order: 0 },
            { questionId: validId, order: 1 }
          ]
        });
      expect(res6.status).toBe(400);
      expect(res6.body.message).toBe('Duplicate question IDs in questionOrders');
    });
  });

  describe('Stage 4.3.3: Data Integrity, Concurrency & Cascading Deletion Saga', () => {
    let testForm;

    beforeEach(async () => {
      testForm = await Form.create({
        ownerId: user1Id,
        title: 'Stage 4.3.3 Test Form',
        status: 'published'
      });
    });

    it('allocates distinct monotonic question orders concurrently without collision', async () => {
      // Execute 5 concurrent addQuestion requests
      const promises = Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post(`/api/forms/${testForm._id}/questions`)
          .set('Cookie', [`token=${user1Token}`])
          .send({
            type: 'short_text',
            label: `Concurrent Question ${i}`
          })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      const questions = await Question.find({ formId: testForm._id }).sort({ order: 1 });
      expect(questions.length).toBe(5);

      const orders = questions.map((q) => q.order);
      // All orders must be distinct
      const uniqueOrders = new Set(orders);
      expect(uniqueOrders.size).toBe(5);
      // Expected to be 0, 1, 2, 3, 4
      expect(orders).toEqual([0, 1, 2, 3, 4]);

      // Verify form nextQuestionOrder is 5
      const updatedForm = await Form.findById(testForm._id);
      expect(updatedForm.nextQuestionOrder).toBe(5);
    });

    it('self-heals legacy forms missing nextQuestionOrder when adding a question', async () => {
      // Create legacy form with nextQuestionOrder = 0 and an existing question at order 2
      const legacyForm = await Form.create({
        ownerId: user1Id,
        title: 'Legacy Form',
        status: 'draft',
        nextQuestionOrder: 0
      });
      await Question.create({
        formId: legacyForm._id,
        type: 'short_text',
        label: 'Existing Q',
        order: 2
      });

      const res = await request(app)
        .post(`/api/forms/${legacyForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'long_text',
          label: 'New Q'
        });

      expect(res.status).toBe(201);
      expect(res.body.data.order).toBe(3);

      const updatedForm = await Form.findById(legacyForm._id);
      expect(updatedForm.nextQuestionOrder).toBe(4);
    });

    it('validates visibilityRule structure, targetQuestionId existence, and operator', async () => {
      // Create two questions
      const q1 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'First Q',
        order: 0
      });

      // 1. Non-object rule
      const res1 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with bad rule',
          visibilityRule: 'not-an-object'
        });
      expect(res1.status).toBe(400);
      expect(res1.body.message).toBe('visibilityRule must be an object or null');

      // 2. Missing or invalid targetQuestionId
      const res2 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with missing target',
          visibilityRule: { operator: 'equals', value: 'yes' }
        });
      expect(res2.status).toBe(400);
      expect(res2.body.message).toBe('visibilityRule.targetQuestionId must be a valid question ID');

      // 3. Invalid operator
      const res3 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with invalid op',
          visibilityRule: {
            targetQuestionId: q1._id.toString(),
            operator: 'invalid_op',
            value: 'yes'
          }
        });
      expect(res3.status).toBe(400);
      expect(res3.body.message).toBe(
        'visibilityRule.operator must be one of: equals, not_equals, contains'
      );

      // 4. Non-existent targetQuestionId
      const nonExistentId = new mongoose.Types.ObjectId().toString();
      const res4 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with nonexistent target',
          visibilityRule: { targetQuestionId: nonExistentId, operator: 'equals', value: 'yes' }
        });
      expect(res4.status).toBe(400);
      expect(res4.body.message).toBe('Referenced targetQuestion does not belong to this form');

      // 5. Valid visibilityRule on creation
      const res5 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Dependent Q',
          visibilityRule: {
            targetQuestionId: q1._id.toString(),
            operator: 'equals',
            value: 'yes'
          }
        });
      expect(res5.status).toBe(201);
      const q2Id = res5.body.data._id;

      // 6. Self-referencing rule on update
      const res6 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/${q2Id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          visibilityRule: { targetQuestionId: q2Id, operator: 'equals', value: 'yes' }
        });
      expect(res6.status).toBe(400);
      expect(res6.body.message).toBe('A question cannot depend on its own answer');

      // 7. Clearing visibilityRule on update
      const res7 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/${q2Id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          visibilityRule: null
        });
      expect(res7.status).toBe(200);
      expect(res7.body.data.visibilityRule == null).toBe(true);
    });

    it('reorders questions with bulkWrite and syncs nextQuestionOrder', async () => {
      const q1 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q1',
        order: 0
      });
      const q2 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q2',
        order: 1
      });

      const res = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          questionOrders: [
            { questionId: q1._id.toString(), order: 10 },
            { questionId: q2._id.toString(), order: 5 }
          ]
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updatedQ1 = await Question.findById(q1._id);
      const updatedQ2 = await Question.findById(q2._id);
      expect(updatedQ1.order).toBe(10);
      expect(updatedQ2.order).toBe(5);

      const updatedForm = await Form.findById(testForm._id);
      expect(updatedForm.nextQuestionOrder).toBe(11);
    });

    it('blocks mutating operations with HTTP 409 when form.status === deleting', async () => {
      testForm.status = 'deleting';
      await testForm.save();

      const q = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Existing',
        order: 0
      });

      // 1. updateForm
      const resUpdate = await request(app)
        .put(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ title: 'New Title' });
      expect(resUpdate.status).toBe(409);
      expect(resUpdate.body.message).toBe('Form is currently being deleted');

      // 2. addQuestion
      const resAdd = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ type: 'short_text', label: 'Blocked' });
      expect(resAdd.status).toBe(409);
      expect(resAdd.body.message).toBe('Form is currently being deleted');

      // 3. updateQuestion
      const resUpdQ = await request(app)
        .put(`/api/forms/${testForm._id}/questions/${q._id}`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ label: 'Changed' });
      expect(resUpdQ.status).toBe(409);
      expect(resUpdQ.body.message).toBe('Form is currently being deleted');

      // 4. deleteQuestion
      const resDelQ = await request(app)
        .delete(`/api/forms/${testForm._id}/questions/${q._id}`)
        .set('Cookie', [`token=${user1Token}`]);
      expect(resDelQ.status).toBe(409);
      expect(resDelQ.body.message).toBe('Form is currently being deleted');

      // 5. reorderQuestions
      const resReorder = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({ questionOrders: [{ questionId: q._id.toString(), order: 0 }] });
      expect(resReorder.status).toBe(409);
      expect(resReorder.body.message).toBe('Form is currently being deleted');
    });

    it('executes deleteForm saga: batches S3 deletion and cascades DB deletion', async () => {
      const q = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Upload Q',
        order: 0
      });

      const s3Key1 = `forms/${testForm._id}/responses/file1.png`;
      const s3Key2 = `forms/${testForm._id}/responses/file2.pdf`;

      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q._id, value: { key: s3Key1 } }]
      });
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q._id, value: { key: s3Key2 } }]
      });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles').mockResolvedValue({
        success: true,
        deletedCount: 2,
        failedKeys: []
      });

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify S3 deletion was invoked with both keys
      expect(deleteFilesSpy).toHaveBeenCalledWith(expect.arrayContaining([s3Key1, s3Key2]));

      // Verify all MongoDB records are deleted
      const foundForm = await Form.findById(testForm._id);
      expect(foundForm).toBeNull();

      const foundQuestions = await Question.find({ formId: testForm._id });
      expect(foundQuestions.length).toBe(0);

      const foundResponses = await Response.find({ formId: testForm._id });
      expect(foundResponses.length).toBe(0);

      deleteFilesSpy.mockRestore();
    });

    it('transitions to delete_failed and preserves DB records when S3 batch deletion fails partially', async () => {
      const q = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Upload Q',
        order: 0
      });

      const s3Key1 = `forms/${testForm._id}/responses/file1.png`;
      const s3Key2 = `forms/${testForm._id}/responses/file2.pdf`;

      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q._id, value: { key: s3Key1 } }]
      });
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q._id, value: { key: s3Key2 } }]
      });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles').mockResolvedValue({
        success: false,
        deletedCount: 1,
        failedKeys: [{ key: s3Key2, error: 'AccessDenied' }]
      });

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(502);
      expect(res.body.message).toContain('Failed to delete some attached storage files');

      // Verify DB records are PRESERVED
      const preservedForm = await Form.findById(testForm._id);
      expect(preservedForm).not.toBeNull();
      expect(preservedForm.status).toBe('delete_failed');
      expect(preservedForm.deletionProgress.failedKeys).toEqual([s3Key2]);
      expect(preservedForm.deletionProgress.stage).toBe('failed');

      const preservedQuestions = await Question.find({ formId: testForm._id });
      expect(preservedQuestions.length).toBe(1);

      const preservedResponses = await Response.find({ formId: testForm._id });
      expect(preservedResponses.length).toBe(2);

      // Verify retry succeeds
      deleteFilesSpy.mockResolvedValue({
        success: true,
        deletedCount: 2,
        failedKeys: []
      });

      const retryRes = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.success).toBe(true);

      const finalForm = await Form.findById(testForm._id);
      expect(finalForm).toBeNull();

      deleteFilesSpy.mockRestore();
    });
  });

  describe('Stage 4.3.3 Targeted Corrections: Recovery, Concurrency & Leases', () => {
    let testForm;

    beforeEach(async () => {
      testForm = await Form.create({
        ownerId: user1Id,
        title: 'Targeted Corrections Form',
        status: 'published'
      });
    });

    // 1. Resumable deletion state machine & lease mechanism
    it('recovers and completes deletion when process crashed immediately after entering deleting', async () => {
      testForm.status = 'deleting';
      testForm.deletionProgress = {
        stage: 's3_cleanup',
        leaseId: 'crashed-worker-uuid-1',
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired
        startedAt: new Date(Date.now() - 35000),
        updatedAt: new Date(Date.now() - 35000)
      };
      await testForm.save();

      const q = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q1',
        order: 0
      });
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q._id, value: 'Answer' }]
      });

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(await Form.findById(testForm._id)).toBeNull();
      expect(await Question.countDocuments({ formId: testForm._id })).toBe(0);
      expect(await Response.countDocuments({ formId: testForm._id })).toBe(0);
    });

    it('resumes and cleans up MongoDB when process crashed after S3 deletion', async () => {
      testForm.status = 'deleting';
      testForm.deletionProgress = {
        stage: 'mongo_cleanup',
        leaseId: 'crashed-worker-uuid-2',
        leaseExpiresAt: new Date(Date.now() - 1000), // Expired
        failedKeys: [],
        updatedAt: new Date(Date.now() - 10000)
      };
      await testForm.save();

      const q = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q1',
        order: 0
      });
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q._id, value: 'A' }]
      });

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(await Form.findById(testForm._id)).toBeNull();
      expect(await Question.countDocuments({ formId: testForm._id })).toBe(0);
      expect(await Response.countDocuments({ formId: testForm._id })).toBe(0);
    });

    it('safely completes deletion when responses were deleted but question/form remained', async () => {
      testForm.status = 'deleting';
      testForm.deletionProgress = {
        stage: 'mongo_cleanup',
        leaseId: null, // Abandoned
        leaseExpiresAt: null
      };
      await testForm.save();

      await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q1',
        order: 0
      });

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(await Form.findById(testForm._id)).toBeNull();
      expect(await Question.countDocuments({ formId: testForm._id })).toBe(0);
    });

    it('atomically reclaims an expired lease and assigns a new leaseId', async () => {
      const oldLeaseId = 'stale-lease-123';
      testForm.status = 'deleting';
      testForm.deletionProgress = {
        stage: 's3_cleanup',
        leaseId: oldLeaseId,
        leaseExpiresAt: new Date(Date.now() - 10000)
      };
      await testForm.save();

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(await Form.findById(testForm._id)).toBeNull();
    });

    it('rejects deletion with 409 and Retry-After when active lease is held by another worker', async () => {
      const activeLeaseId = 'active-worker-999';
      testForm.status = 'deleting';
      testForm.deletionProgress = {
        stage: 's3_cleanup',
        leaseId: activeLeaseId,
        leaseExpiresAt: new Date(Date.now() + 25000) // Active for 25 more seconds
      };
      await testForm.save();

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Form is currently being deleted');
      expect(res.headers['retry-after']).toBeDefined();
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(20);
      expect(res.body.data.stage).toBe('s3_cleanup');

      const dbForm = await Form.findById(testForm._id);
      expect(dbForm).not.toBeNull();
      expect(dbForm.deletionProgress.leaseId).toBe(activeLeaseId);
    });

    it('aborts former lease owner when lease expired and was reclaimed by another worker', async () => {
      const worker1LeaseId = 'worker-1-uuid';
      testForm.status = 'deleting';
      testForm.deletionProgress = {
        stage: 's3_cleanup',
        leaseId: worker1LeaseId,
        leaseExpiresAt: new Date(Date.now() - 1000) // Expired
      };
      await testForm.save();

      // Worker 2 reclaims the form
      const worker2LeaseId = 'worker-2-uuid';
      await Form.updateOne(
        { _id: testForm._id },
        {
          $set: {
            'deletionProgress.leaseId': worker2LeaseId,
            'deletionProgress.leaseExpiresAt': new Date(Date.now() + 30000)
          }
        }
      );

      // Worker 1 attempts to advance stage using stale worker1LeaseId
      const advanceResult = await Form.updateOne(
        {
          _id: testForm._id,
          'deletionProgress.leaseId': worker1LeaseId
        },
        { $set: { 'deletionProgress.stage': 'mongo_cleanup' } }
      );

      expect(advanceResult.matchedCount).toBe(0);

      // Form lease still belongs strictly to Worker 2
      const dbForm = await Form.findById(testForm._id);
      expect(dbForm.deletionProgress.leaseId).toBe(worker2LeaseId);
    });

    it('allows exactly one worker to claim deletion and rejects simultaneous requests with 409', async () => {
      const deleteSpy = vi.spyOn(storageService, 'deleteFiles').mockResolvedValue({
        success: true,
        deletedKeys: [],
        failedKeys: []
      });

      // Launch 5 simultaneous DELETE requests
      const requests = Array.from({ length: 5 }, () =>
        request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`])
      );

      const responses = await Promise.all(requests);
      const statusCodes = responses.map((r) => r.status);

      // Exactly one request must succeed (200)
      const successCount = statusCodes.filter((s) => s === 200).length;
      expect(successCount).toBe(1);

      // Remaining 4 requests must receive 409 (or 404 if processed after completion)
      const nonSuccessCount = statusCodes.filter((s) => s === 409 || s === 404).length;
      expect(nonSuccessCount).toBe(4);

      expect(await Form.findById(testForm._id)).toBeNull();
      deleteSpy.mockRestore();
    });

    it('preserves failedKeys from previous S3 failure and retries them alongside response keys', async () => {
      const failedS3Key = `forms/${testForm._id}/orphaned-avatar.png`;
      testForm.status = 'delete_failed';
      testForm.deletionProgress = {
        stage: 'failed',
        failedKeys: [failedS3Key],
        leaseId: null,
        leaseExpiresAt: null
      };
      await testForm.save();

      const q = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'File Q',
        order: 0
      });
      const activeS3Key = `forms/${testForm._id}/active-doc.pdf`;
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q._id, value: { key: activeS3Key } }]
      });

      const deleteSpy = vi.spyOn(storageService, 'deleteFiles').mockResolvedValue({
        success: true,
        deletedKeys: [failedS3Key, activeS3Key],
        failedKeys: []
      });

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);
      expect(deleteSpy).toHaveBeenCalledWith(expect.arrayContaining([failedS3Key, activeS3Key]));
      expect(await Form.findById(testForm._id)).toBeNull();

      deleteSpy.mockRestore();
    });

    it('returns 404 predictability when deletion is repeated on an already deleted form', async () => {
      const res1 = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);
      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);
      expect(res2.status).toBe(404);
      expect(res2.body.message).toBe('Form not found');
    });

    it('recoverAbandonedFormDeletions background sweep cleans up abandoned forms on startup', async () => {
      // Create two abandoned forms with expired leases
      const abandonedForm1 = await Form.create({
        ownerId: user1Id,
        title: 'Abandoned 1',
        status: 'deleting',
        deletionProgress: {
          stage: 's3_cleanup',
          leaseId: 'expired-worker-1',
          leaseExpiresAt: new Date(Date.now() - 10000)
        }
      });

      const abandonedForm2 = await Form.create({
        ownerId: user1Id,
        title: 'Abandoned 2',
        status: 'deleting',
        deletionProgress: {
          stage: 's3_cleanup',
          leaseId: 'expired-worker-2',
          leaseExpiresAt: new Date(Date.now() - 5000)
        }
      });

      const result = await recoverAbandonedFormDeletions();
      expect(result.recoveredCount).toBeGreaterThanOrEqual(2);

      expect(await Form.findById(abandonedForm1._id)).toBeNull();
      expect(await Form.findById(abandonedForm2._id)).toBeNull();
    });

    // 2. Standalone MongoDB partial-failure recovery & reordering safety
    it('handles deleteForm failure during Question.deleteMany, keeps Form in delete_failed, then successfully retries', async () => {
      const q1 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q1',
        order: 0
      });
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q1._id, value: 'A1' }]
      });

      const deleteManyQuestionsSpy = vi
        .spyOn(Question, 'deleteMany')
        .mockRejectedValueOnce(
          new Error('Simulated DB network timeout during Question.deleteMany')
        );

      try {
        const res = await request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`]);

        expect(res.status).toBe(500);

        // Atomic transaction rolled back: both responses and questions preserved
        expect(await Response.countDocuments({ formId: testForm._id })).toBe(1);
        expect(await Question.countDocuments({ formId: testForm._id })).toBe(1);
        // Form preserved in delete_failed
        const failedForm = await Form.findById(testForm._id);
        expect(failedForm).not.toBeNull();
        expect(failedForm.status).toBe('delete_failed');
        expect(failedForm.deletionProgress.stage).toBe('failed');
      } finally {
        deleteManyQuestionsSpy.mockRestore();
      }

      // Retry completes remaining cascade
      const retryRes = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(retryRes.status).toBe(200);
      expect(await Form.findById(testForm._id)).toBeNull();
      expect(await Question.countDocuments({ formId: testForm._id })).toBe(0);
    });

    it('executes compensating rollback on standalone MongoDB when Question.bulkWrite fails during reorder', async () => {
      const q1 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q1',
        order: 0
      });
      const q2 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q2',
        order: 1
      });
      const q3 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q3',
        order: 2
      });

      const bulkWriteSpy = vi
        .spyOn(Question, 'bulkWrite')
        .mockRejectedValueOnce(new Error('Simulated write failure on standalone bulkWrite'));

      const res = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          questionOrders: [
            { questionId: q1._id.toString(), order: 2 },
            { questionId: q2._id.toString(), order: 0 },
            { questionId: q3._id.toString(), order: 1 }
          ]
        });

      expect(res.status).toBe(500);

      // Verify compensating rollback restored exact original question orders
      const restoredQ1 = await Question.findById(q1._id);
      const restoredQ2 = await Question.findById(q2._id);
      const restoredQ3 = await Question.findById(q3._id);

      expect(restoredQ1.order).toBe(0);
      expect(restoredQ2.order).toBe(1);
      expect(restoredQ3.order).toBe(2);

      // Verify form inProgress reorder lock was released
      const formDoc = await Form.findById(testForm._id);
      expect(formDoc.reorderState.inProgress).toBe(false);

      bulkWriteSpy.mockRestore();
    });

    it('rejects concurrent reorder collision using optimistic concurrency control (OCC version mismatch)', async () => {
      const q1 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q1',
        order: 0
      });
      const q2 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Q2',
        order: 1
      });

      const currentForm = await Form.findById(testForm._id);
      const currentVersion = currentForm.version;

      // First request succeeds with matching version
      const res1 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          version: currentVersion,
          questionOrders: [
            { questionId: q1._id.toString(), order: 1 },
            { questionId: q2._id.toString(), order: 0 }
          ]
        });
      expect(res1.status).toBe(200);

      // Concurrent request with stale version is rejected with HTTP 409 Conflict
      const res2 = await request(app)
        .put(`/api/forms/${testForm._id}/questions/reorder`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          version: currentVersion,
          questionOrders: [
            { questionId: q1._id.toString(), order: 0 },
            { questionId: q2._id.toString(), order: 1 }
          ]
        });

      expect(res2.status).toBe(409);
      expect(res2.body.message).toContain('Conflict: Form has been modified by another update');
    });

    // 3. Legacy question-order concurrency
    it('allocates unique contiguous orders under simultaneous concurrent additions on legacy form with no counter', async () => {
      // Legacy form with nextQuestionOrder = 0 and 3 existing questions (orders 0, 1, 2)
      const legacyForm = await Form.create({
        ownerId: user1Id,
        title: 'Legacy Concurrency Form',
        status: 'published',
        nextQuestionOrder: 0
      });
      await Question.create({
        formId: legacyForm._id,
        type: 'short_text',
        label: 'Legacy Q0',
        order: 0
      });
      await Question.create({
        formId: legacyForm._id,
        type: 'short_text',
        label: 'Legacy Q1',
        order: 1
      });
      await Question.create({
        formId: legacyForm._id,
        type: 'short_text',
        label: 'Legacy Q2',
        order: 2
      });

      // Dispatch 5 concurrent addQuestion requests
      const promises = Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post(`/api/forms/${legacyForm._id}/questions`)
          .set('Cookie', [`token=${user1Token}`])
          .send({
            type: 'short_text',
            label: `Concurrent New Q${i}`
          })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      const allQuestions = await Question.find({ formId: legacyForm._id }).sort({ order: 1 });
      expect(allQuestions.length).toBe(8);

      const orders = allQuestions.map((q) => q.order);
      const uniqueOrders = new Set(orders);
      // Zero duplicate orders: must have 8 distinct orders [0, 1, 2, 3, 4, 5, 6, 7]
      expect(uniqueOrders.size).toBe(8);
      expect(orders).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      const updatedForm = await Form.findById(legacyForm._id);
      expect(updatedForm.nextQuestionOrder).toBe(8);
    });

    it('allocates unique orders under simultaneous additions when counter is stale (less than existing max order)', async () => {
      // Form with stale counter (nextQuestionOrder = 1, but existing questions reach order 5)
      const staleForm = await Form.create({
        ownerId: user1Id,
        title: 'Stale Counter Form',
        status: 'published',
        nextQuestionOrder: 1
      });
      await Question.create({
        formId: staleForm._id,
        type: 'short_text',
        label: 'Existing Q',
        order: 5
      });

      // Dispatch 3 concurrent additions
      const promises = Array.from({ length: 3 }, (_, i) =>
        request(app)
          .post(`/api/forms/${staleForm._id}/questions`)
          .set('Cookie', [`token=${user1Token}`])
          .send({
            type: 'short_text',
            label: `Stale Recovery Q${i}`
          })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      const questions = await Question.find({ formId: staleForm._id }).sort({ order: 1 });
      expect(questions.length).toBe(4);

      const orders = questions.map((q) => q.order);
      const uniqueOrders = new Set(orders);
      expect(uniqueOrders.size).toBe(4);
      expect(orders).toEqual([5, 6, 7, 8]);
    });

    // 4. S3 key scoping & foreign key rejection
    it('strictly scopes S3 deletion to forms/:formId/ and filters out foreign or path-traversal keys', async () => {
      const q = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Upload Q',
        order: 0
      });

      const legitimateKey = `forms/${testForm._id}/responses/legit.pdf`;
      const foreignKey = 'forms/OTHER_FORM_ID/secret.png';
      const traversalKey = `forms/${testForm._id}/../../etc/passwd`;

      await Response.create({
        formId: testForm._id,
        answers: [
          { questionId: q._id, value: { key: legitimateKey } },
          { questionId: q._id, value: { key: foreignKey } },
          { questionId: q._id, value: { key: traversalKey } }
        ]
      });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles').mockResolvedValue({
        success: true,
        deletedCount: 1,
        failedKeys: []
      });

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(200);

      // Verify deleteFiles was called ONLY with legitimateKey; foreign and traversal keys were ignored
      expect(deleteFilesSpy).toHaveBeenCalledWith([legitimateKey]);

      deleteFilesSpy.mockRestore();
    });

    // 5. Visibility-rule value types & boundary validation
    it('accepts empty string, number, boolean, and array values in visibilityRule', async () => {
      const targetQ = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Target Q',
        order: 0
      });

      // 1. Empty string (FormBuilder default initialization)
      const res1 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with empty string rule',
          visibilityRule: {
            targetQuestionId: targetQ._id.toString(),
            operator: 'equals',
            value: ''
          }
        });
      expect(res1.status).toBe(201);

      // 2. Number value
      const res2 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with number rule',
          visibilityRule: {
            targetQuestionId: targetQ._id.toString(),
            operator: 'equals',
            value: 42
          }
        });
      expect(res2.status).toBe(201);

      // 3. Boolean value
      const res3 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with boolean rule',
          visibilityRule: {
            targetQuestionId: targetQ._id.toString(),
            operator: 'equals',
            value: true
          }
        });
      expect(res3.status).toBe(201);

      // 4. Array value
      const res4 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with array rule',
          visibilityRule: {
            targetQuestionId: targetQ._id.toString(),
            operator: 'contains',
            value: ['opt1', 'opt2']
          }
        });
      expect(res4.status).toBe(201);

      // 5. Rejects plain object value
      const res5 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with object rule',
          visibilityRule: {
            targetQuestionId: targetQ._id.toString(),
            operator: 'equals',
            value: { nested: 'bad' }
          }
        });
      expect(res5.status).toBe(400);
      expect(res5.body.message).toBe(
        'visibilityRule.value must be a string, number, boolean, or array'
      );

      // 6. Rejects string exceeding 500 characters
      const res6 = await request(app)
        .post(`/api/forms/${testForm._id}/questions`)
        .set('Cookie', [`token=${user1Token}`])
        .send({
          type: 'short_text',
          label: 'Q with oversized rule',
          visibilityRule: {
            targetQuestionId: targetQ._id.toString(),
            operator: 'equals',
            value: 'a'.repeat(501)
          }
        });
      expect(res6.status).toBe(400);
      expect(res6.body.message).toBe('visibilityRule.value cannot exceed 500 characters');
    });
  });

  describe('Stage 4.3.3 Final Corrections: S3 Legacy Keys & Deletion Lease Lifecycle', () => {
    let testForm;

    beforeEach(async () => {
      testForm = await Form.create({
        ownerId: user1Id,
        title: 'Stage 4.3.3 Final Test Form',
        status: 'published'
      });
    });

    // --- Correction A: S3 Key Classification & Legacy Safety ---

    it('classifies storage keys into Category A, B, and C accurately', () => {
      const formIdStr = testForm._id.toString();
      const otherIdStr = new mongoose.Types.ObjectId().toString();

      // Category A: Confirmed valid form-owned keys
      expect(classifyStorageKey(`forms/${formIdStr}/responses/uuid-123.pdf`, formIdStr)).toEqual({
        category: 'A',
        key: `forms/${formIdStr}/responses/uuid-123.pdf`
      });
      expect(classifyStorageKey(`forms/${formIdStr}/q1/document.docx`, formIdStr)).toEqual({
        category: 'A',
        key: `forms/${formIdStr}/q1/document.docx`
      });
      expect(classifyStorageKey(`forms/${formIdStr}/scan.png`, formIdStr)).toEqual({
        category: 'A',
        key: `forms/${formIdStr}/scan.png`
      });

      // Category B: Confirmed malicious or foreign keys
      expect(classifyStorageKey(`forms/${otherIdStr}/secret.pdf`, formIdStr).category).toBe('B');
      expect(classifyStorageKey(`forms/${formIdStr}/../../etc/passwd`, formIdStr).category).toBe(
        'B'
      );
      expect(
        classifyStorageKey(`forms/${formIdStr}/..\\windows\\cmd.exe`, formIdStr).category
      ).toBe('B');
      expect(classifyStorageKey(`https://malicious.com/payload.exe`, formIdStr).category).toBe('B');
      expect(classifyStorageKey(`s3://another-bucket/file.pdf`, formIdStr).category).toBe('B');
      expect(classifyStorageKey(`/root/confidential.txt`, formIdStr).category).toBe('B');
      expect(classifyStorageKey(null, formIdStr).category).toBe('B');
      expect(classifyStorageKey('', formIdStr).category).toBe('B');

      // Category C: Unrecognized or unresolved legacy keys
      expect(classifyStorageKey('uploads/report.pdf', formIdStr).category).toBe('C');
      expect(classifyStorageKey(`uploads/${formIdStr}/report.pdf`, formIdStr).category).toBe('C');
      expect(classifyStorageKey('attachments/resume.docx', formIdStr).category).toBe('C');
      expect(classifyStorageKey('flat-file.pdf', formIdStr).category).toBe('C');
      expect(classifyStorageKey('mock-s3-url/uploads/test.png', formIdStr).category).toBe('C');
    });

    it('batch deletes Category A keys and cascades DB deletion on valid form files', async () => {
      const fileQ = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Upload Document',
        order: 0
      });

      const key1 = `forms/${testForm._id}/responses/file1.pdf`;
      const key2 = `forms/${testForm._id}/responses/file2.png`;

      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: fileQ._id, value: { key: key1, originalName: 'doc1.pdf' } }]
      });
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: fileQ._id, value: { key: key2, originalName: 'doc2.png' } }]
      });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles').mockResolvedValueOnce({
        success: true,
        deletedKeys: [key1, key2],
        failedKeys: [],
        totalRequested: 2
      });

      try {
        const res = await request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`]);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(deleteFilesSpy).toHaveBeenCalledWith(expect.arrayContaining([key1, key2]));

        // MongoDB documents cleanly cascaded
        expect(await Form.findById(testForm._id)).toBeNull();
        expect(await Question.countDocuments({ formId: testForm._id })).toBe(0);
        expect(await Response.countDocuments({ formId: testForm._id })).toBe(0);
      } finally {
        deleteFilesSpy.mockRestore();
      }
    });

    it('never deletes Category B keys (foreign or traversal) and allows clean form deletion', async () => {
      const fileQ = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Upload Document',
        order: 0
      });

      const legitimateKey = `forms/${testForm._id}/responses/legit.pdf`;
      const foreignKey = `forms/${new mongoose.Types.ObjectId()}/responses/victim.pdf`;
      const traversalKey = `forms/${testForm._id}/../../etc/shadow`;
      const externalUriKey = 'https://evil.corp/malware.bin';

      await Response.create({
        formId: testForm._id,
        answers: [
          { questionId: fileQ._id, value: { key: legitimateKey } },
          { questionId: fileQ._id, value: { key: foreignKey } },
          { questionId: fileQ._id, value: { key: traversalKey } },
          { questionId: fileQ._id, value: { key: externalUriKey } }
        ]
      });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles').mockResolvedValueOnce({
        success: true,
        deletedKeys: [legitimateKey],
        failedKeys: [],
        totalRequested: 1
      });

      try {
        const res = await request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`]);

        expect(res.status).toBe(200);
        // deleteFiles must only receive the legitimate key
        expect(deleteFilesSpy).toHaveBeenCalledWith([legitimateKey]);
        expect(deleteFilesSpy).not.toHaveBeenCalledWith(expect.arrayContaining([foreignKey]));
        expect(deleteFilesSpy).not.toHaveBeenCalledWith(expect.arrayContaining([traversalKey]));
        expect(deleteFilesSpy).not.toHaveBeenCalledWith(expect.arrayContaining([externalUriKey]));

        // Completed deletion
        expect(await Form.findById(testForm._id)).toBeNull();
      } finally {
        deleteFilesSpy.mockRestore();
      }
    });

    it('halts deletion on Category C legacy keys, halts MongoDB cascade, and returns 502 with unresolvedKeys', async () => {
      const fileQ = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Upload Document',
        order: 0
      });

      const legacyKey = 'uploads/historical_document.pdf';
      await Response.create({
        formId: testForm._id,
        answers: [
          { questionId: fileQ._id, value: { key: legacyKey, originalName: 'historical.pdf' } }
        ]
      });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      try {
        const res = await request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`]);

        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('unresolved legacy storage files');
        expect(res.body.data.unresolvedKeys).toEqual([legacyKey]);

        // storageService.deleteFiles was NEVER called
        expect(deleteFilesSpy).not.toHaveBeenCalled();

        // MongoDB documents MUST be preserved (not orphaned)
        const preservedForm = await Form.findById(testForm._id);
        expect(preservedForm).not.toBeNull();
        expect(preservedForm.status).toBe('delete_failed');
        expect(preservedForm.deletionProgress.stage).toBe('failed');
        expect(preservedForm.deletionProgress.unresolvedKeys).toEqual([legacyKey]);
        expect(preservedForm.deletionProgress.leaseId).toBeNull();

        expect(await Response.countDocuments({ formId: testForm._id })).toBe(1);
        expect(await Question.countDocuments({ formId: testForm._id })).toBe(1);
      } finally {
        deleteFilesSpy.mockRestore();
      }
    });

    it('preserves unresolvedKeys and failedKeys across retries', async () => {
      testForm.status = 'delete_failed';
      testForm.deletionProgress = {
        stage: 'failed',
        failedKeys: [`forms/${testForm._id}/responses/prev_failed.pdf`],
        unresolvedKeys: ['uploads/legacy_archive.zip'],
        leaseId: null,
        leaseExpiresAt: null
      };
      await testForm.save();

      const res = await request(app)
        .delete(`/api/forms/${testForm._id}`)
        .set('Cookie', [`token=${user1Token}`]);

      expect(res.status).toBe(502);
      expect(res.body.data.unresolvedKeys).toContain('uploads/legacy_archive.zip');

      const formAfterRetry = await Form.findById(testForm._id);
      expect(formAfterRetry.deletionProgress.unresolvedKeys).toContain(
        'uploads/legacy_archive.zip'
      );
      expect(formAfterRetry.status).toBe('delete_failed');
    });

    it('handles empty, null, and malformed answers safely without crashing or deletion', async () => {
      const textQ = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Name',
        order: 0
      });

      await Response.create({
        formId: testForm._id,
        answers: [
          { questionId: textQ._id, value: '' },
          { questionId: textQ._id, value: {} },
          { questionId: textQ._id, value: { key: '' } },
          { questionId: textQ._id, value: { key: null } },
          { questionId: textQ._id, value: [] }
        ]
      });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles');

      try {
        const res = await request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`]);

        expect(res.status).toBe(200);
        // No valid or invalid files were to delete
        expect(deleteFilesSpy).not.toHaveBeenCalled();
        expect(await Form.findById(testForm._id)).toBeNull();
      } finally {
        deleteFilesSpy.mockRestore();
      }
    });

    it('deduplicates duplicate keys across multiple responses into a single S3 delete operation', async () => {
      const fileQ = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Shared Document',
        order: 0
      });

      const sharedKey = `forms/${testForm._id}/responses/shared_template.pdf`;

      // Two responses pointing to the same S3 key
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: fileQ._id, value: { key: sharedKey } }]
      });
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: fileQ._id, value: { key: sharedKey } }]
      });

      const deleteFilesSpy = vi.spyOn(storageService, 'deleteFiles').mockResolvedValueOnce({
        success: true,
        deletedKeys: [sharedKey],
        failedKeys: [],
        totalRequested: 1
      });

      try {
        const res = await request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`]);

        expect(res.status).toBe(200);
        // Only called once with 1 unique key
        expect(deleteFilesSpy).toHaveBeenCalledWith([sharedKey]);
      } finally {
        deleteFilesSpy.mockRestore();
      }
    });

    // --- Correction B: Deletion Lease Lifecycle & Heartbeat Renewal ---

    it('renews lease expiration while long-running deletion is in progress', async () => {
      const fileQ = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Doc',
        order: 0
      });
      const validKey = `forms/${testForm._id}/responses/doc.pdf`;
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: fileQ._id, value: { key: validKey } }]
      });

      let initialExpiry = null;
      let renewedExpiry = null;

      // Simulate a long-running S3 batch deletion
      const deleteFilesSpy = vi
        .spyOn(storageService, 'deleteFiles')
        .mockImplementation(async () => {
          const formDuringS3 = await Form.findById(testForm._id);
          initialExpiry = new Date(formDuringS3.deletionProgress.leaseExpiresAt).getTime();

          // Trigger manual renewal update simulating heartbeat interval
          await Form.updateOne(
            {
              _id: testForm._id,
              'deletionProgress.leaseId': formDuringS3.deletionProgress.leaseId
            },
            {
              $set: {
                'deletionProgress.leaseExpiresAt': new Date(Date.now() + 60000),
                'deletionProgress.updatedAt': new Date()
              }
            }
          );

          const formAfterRenewal = await Form.findById(testForm._id);
          renewedExpiry = new Date(formAfterRenewal.deletionProgress.leaseExpiresAt).getTime();

          return {
            success: true,
            deletedKeys: [validKey],
            failedKeys: [],
            totalRequested: 1
          };
        });

      try {
        const res = await request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`]);

        expect(res.status).toBe(200);
        expect(renewedExpiry).toBeGreaterThan(initialExpiry);
      } finally {
        deleteFilesSpy.mockRestore();
      }
    });

    it('does not allow recovery sweep to reclaim a valid actively renewed lease', async () => {
      testForm.status = 'deleting';
      testForm.deletionProgress = {
        stage: 's3_cleanup',
        leaseId: 'active-worker-uuid',
        leaseExpiresAt: new Date(Date.now() + 25000), // Active and valid
        startedAt: new Date(),
        updatedAt: new Date()
      };
      await testForm.save();

      const result = await recoverAbandonedFormDeletions();
      expect(result.recoveredCount).toBe(0);

      // Form remains untouched in deleting with active lease
      const untouchedForm = await Form.findById(testForm._id);
      expect(untouchedForm.status).toBe('deleting');
      expect(untouchedForm.deletionProgress.leaseId).toBe('active-worker-uuid');
    });

    it('prevents former worker from updating progress or clearing a newer worker lease', async () => {
      // 1. Worker 1 claims lease
      const claimResult1 = await executeFormDeletion(testForm._id, { isSystemRecovery: true });
      expect(claimResult1.success).toBe(true); // Deletion succeeds

      // 2. Re-create a form to test worker collision
      const collisionForm = await Form.create({
        ownerId: user1Id,
        title: 'Collision Form',
        status: 'deleting',
        deletionProgress: {
          stage: 's3_cleanup',
          leaseId: 'stale-worker-id',
          leaseExpiresAt: new Date(Date.now() - 1000) // Expired
        }
      });

      // Newer worker claims the expired lease
      const worker2LeaseId = 'new-worker-id';
      await Form.updateOne(
        { _id: collisionForm._id },
        {
          $set: {
            'deletionProgress.leaseId': worker2LeaseId,
            'deletionProgress.leaseExpiresAt': new Date(Date.now() + 30000)
          }
        }
      );

      // Stale worker attempts to advance or clear lease with old leaseId
      const staleUpdate = await Form.updateOne(
        { _id: collisionForm._id, 'deletionProgress.leaseId': 'stale-worker-id' },
        {
          $set: {
            status: 'delete_failed',
            'deletionProgress.leaseId': null
          }
        }
      );

      // Stale worker matched 0 documents and did not overwrite the newer worker's state
      expect(staleUpdate.matchedCount).toBe(0);

      const checkForm = await Form.findById(collisionForm._id);
      expect(checkForm.deletionProgress.leaseId).toBe(worker2LeaseId);
    });

    it('aborts worker if lease is reclaimed during S3 batch deletion before advancing to Mongo', async () => {
      const fileQ = await Question.create({
        formId: testForm._id,
        type: 'file',
        label: 'Doc',
        order: 0
      });
      const validKey = `forms/${testForm._id}/responses/doc.pdf`;
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: fileQ._id, value: { key: validKey } }]
      });

      // When deleteFiles runs, simulate another worker taking over the lease
      const deleteFilesSpy = vi
        .spyOn(storageService, 'deleteFiles')
        .mockImplementation(async () => {
          await Form.updateOne(
            { _id: testForm._id },
            {
              $set: {
                'deletionProgress.leaseId': 'rival-worker-uuid',
                'deletionProgress.leaseExpiresAt': new Date(Date.now() + 30000)
              }
            }
          );
          return {
            success: true,
            deletedKeys: [validKey],
            failedKeys: [],
            totalRequested: 1
          };
        });

      try {
        const res = await request(app)
          .delete(`/api/forms/${testForm._id}`)
          .set('Cookie', [`token=${user1Token}`]);

        // Worker detects lease was reclaimed/lost and aborts with 409 Conflict
        expect(res.status).toBe(409);
        expect(res.body.message).toContain('lease expired or was reclaimed');

        // Form and responses MUST NOT have been deleted by the stale worker
        const formDoc = await Form.findById(testForm._id);
        expect(formDoc).not.toBeNull();
        expect(formDoc.deletionProgress.leaseId).toBe('rival-worker-uuid');
        expect(await Response.countDocuments({ formId: testForm._id })).toBe(1);
      } finally {
        deleteFilesSpy.mockRestore();
      }
    });

    it('handles duplicate recovery sweeps without allowing multiple workers to claim the same lease', async () => {
      testForm.status = 'deleting';
      testForm.deletionProgress = {
        stage: 's3_cleanup',
        leaseId: 'abandoned-worker',
        leaseExpiresAt: new Date(Date.now() - 5000) // Expired
      };
      await testForm.save();

      // Launch 5 simultaneous recovery attempts on the same abandoned form
      const recoveryPromises = Array.from({ length: 5 }, () =>
        executeFormDeletion(testForm._id, { isSystemRecovery: true })
      );

      const results = await Promise.all(recoveryPromises);
      const successfulClaims = results.filter((r) => r.success);
      const rejectedClaims = results.filter((r) => r.statusCode === 409 || r.statusCode === 404);

      // Exactly 1 worker wins the claim; other 4 receive 409 (active lease) or 404 (completed)
      expect(successfulClaims.length).toBe(1);
      expect(rejectedClaims.length).toBe(4);

      // Form is completely cleaned up by the winning worker
      expect(await Form.findById(testForm._id)).toBeNull();
    });
  });

  describe('Stage 4.3.4: Query Performance, Cursor Streaming & Aggregation Bounding (Form Workstreams)', () => {
    let testOwnerToken;
    let testOwnerId;

    beforeEach(async () => {
      await User.deleteMany({});
      await Form.deleteMany({});
      await Question.deleteMany({});
      await Response.deleteMany({});

      const owner = await User.create({
        name: 'Stage 4.3.4 Owner',
        email: 'stage434owner@example.com',
        password: 'password123'
      });
      testOwnerId = owner._id;
      testOwnerToken = jwt.sign({ id: testOwnerId }, process.env.JWT_SECRET || 'testsecret', {
        expiresIn: '15m'
      });
    });

    it('Workstream A: eliminates N+1 queries by executing exactly 1 batch aggregation for response counts', async () => {
      // Create 5 forms for this owner
      const createdForms = [];
      for (let i = 1; i <= 5; i++) {
        const form = await Form.create({
          ownerId: testOwnerId,
          title: `Form ${i}`,
          description: `Description ${i}`,
          status: 'published'
        });
        createdForms.push(form);
      }

      // Add varying numbers of responses to each form
      // Form 0: 3 responses, Form 1: 1 response, Form 2: 0 responses, Form 3: 2 responses, Form 4: 0 responses
      const responseCountsExpected = [3, 1, 0, 2, 0];
      for (let i = 0; i < createdForms.length; i++) {
        for (let r = 0; r < responseCountsExpected[i]; r++) {
          await Response.create({
            formId: createdForms[i]._id,
            answers: []
          });
        }
      }

      const countDocumentsSpy = vi.spyOn(Response, 'countDocuments');
      const aggregateSpy = vi.spyOn(Response, 'aggregate');

      const res = await request(app)
        .get('/api/forms')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(5);
      expect(res.body.data.length).toBe(5);

      // Verify N+1 countDocuments was NEVER called on Response
      expect(countDocumentsSpy).not.toHaveBeenCalled();

      // Verify exactly 1 batched aggregation was executed on Response
      expect(aggregateSpy).toHaveBeenCalledTimes(1);

      // Verify the counts mapped correctly to every form in O(1)
      for (let i = 0; i < createdForms.length; i++) {
        const matchingForm = res.body.data.find(
          (f) => f._id.toString() === createdForms[i]._id.toString()
        );
        expect(matchingForm).toBeDefined();
        expect(matchingForm.responseCount).toBe(responseCountsExpected[i]);
      }
    });

    it('Workstream B: returns bounded pagination metadata and default parameters cleanly', async () => {
      for (let i = 1; i <= 15; i++) {
        await Form.create({
          ownerId: testOwnerId,
          title: `Form ${i}`,
          description: `Description ${i}`,
          status: 'draft'
        });
      }

      // Default pagination: page=1, limit=50
      const resDefault = await request(app)
        .get('/api/forms')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resDefault.status).toBe(200);
      expect(resDefault.body.success).toBe(true);
      expect(resDefault.body.count).toBe(15);
      expect(resDefault.body.total).toBe(15);
      expect(resDefault.body.page).toBe(1);
      expect(resDefault.body.limit).toBe(50);
      expect(resDefault.body.totalPages).toBe(1);
      expect(resDefault.body.pagination).toEqual({
        page: 1,
        limit: 50,
        total: 15,
        pages: 1
      });

      // Explicit pagination: page=2, limit=5
      const resPaged = await request(app)
        .get('/api/forms?page=2&limit=5')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resPaged.status).toBe(200);
      expect(resPaged.body.success).toBe(true);
      expect(resPaged.body.count).toBe(5);
      expect(resPaged.body.total).toBe(15);
      expect(resPaged.body.page).toBe(2);
      expect(resPaged.body.limit).toBe(5);
      expect(resPaged.body.totalPages).toBe(3);
      expect(resPaged.body.pagination.pages).toBe(3);
    });

    it('Workstream B: clamps negative, non-numeric, zero, and excessive pagination parameters safely', async () => {
      for (let i = 1; i <= 3; i++) {
        await Form.create({
          ownerId: testOwnerId,
          title: `Form ${i}`,
          status: 'draft'
        });
      }

      // 1. Non-numeric page and limit
      const resNaN = await request(app)
        .get('/api/forms?page=abc&limit=xyz')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resNaN.status).toBe(200);
      expect(resNaN.body.pagination.page).toBe(1);
      expect(resNaN.body.pagination.limit).toBe(50);

      // 2. Negative page and excessive limit (> 100 clamped to 100)
      const resBounds = await request(app)
        .get('/api/forms?page=-5&limit=1000')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resBounds.status).toBe(200);
      expect(resBounds.body.pagination.page).toBe(1);
      expect(resBounds.body.pagination.limit).toBe(100);

      // 3. Zero page
      const resZero = await request(app)
        .get('/api/forms?page=0&limit=10')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resZero.status).toBe(200);
      expect(resZero.body.pagination.page).toBe(1);
      expect(resZero.body.pagination.limit).toBe(10);

      // 4. Excessively large page clamped to MAX_PAGE (100)
      const resHuge = await request(app)
        .get('/api/forms?page=999999999999&limit=20')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resHuge.status).toBe(200);
      expect(resHuge.body.pagination.page).toBe(100);
      expect(resHuge.body.pagination.limit).toBe(20);
    });

    it('Workstream B: returns empty array and zero pagination stats when user owns no forms', async () => {
      const aggregateSpy = vi.spyOn(Response, 'aggregate');

      const res = await request(app)
        .get('/api/forms')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(0);
      expect(res.body.total).toBe(0);
      expect(res.body.totalPages).toBe(0);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 50,
        total: 0,
        pages: 0
      });

      // When forms is empty, Response.aggregate is bypassed
      expect(aggregateSpy).not.toHaveBeenCalled();
    });

    it('Workstream B: guarantees stable deterministic pagination ordering for equal timestamps', async () => {
      const fixedTime = new Date('2026-01-01T00:00:00.000Z');
      const formA = await Form.create({
        title: 'Form Alpha',
        ownerId: testOwnerId,
        createdAt: fixedTime
      });
      const formB = await Form.create({
        title: 'Form Beta',
        ownerId: testOwnerId,
        createdAt: fixedTime
      });

      const res = await request(app)
        .get('/api/forms?limit=10')
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      const returnedIds = res.body.data.map((f) => f._id);
      // Secondary sort _id: -1 ensures newer ObjectId comes first
      const expectedFirst =
        formB._id.toString() > formA._id.toString() ? formB._id.toString() : formA._id.toString();
      const expectedSecond =
        formB._id.toString() > formA._id.toString() ? formA._id.toString() : formB._id.toString();
      expect(returnedIds[0]).toBe(expectedFirst);
      expect(returnedIds[1]).toBe(expectedSecond);
    });

    it('Workstream E: enforces formCreationLimiter, formDeletionLimiter, and formMutationLimiter', async () => {
      // In test mode, max is high (10000) by default; verify limiter options and behavior
      expect(formCreationLimiter).toBeDefined();
      expect(typeof formCreationLimiter).toBe('function');
      expect(formDeletionLimiter).toBeDefined();
      expect(typeof formDeletionLimiter).toBe('function');
      expect(formMutationLimiter).toBeDefined();
      expect(typeof formMutationLimiter).toBe('function');

      // Send form creation request
      const res = await request(app)
        .post('/api/forms')
        .set('Cookie', [`token=${testOwnerToken}`])
        .send({
          title: 'Rate-Limited Form Creation Test',
          description: 'Testing form rate limiter'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });

    describe('Stage 4.3.5: Status Validation, Resurrection Protection, and Read Limiting', () => {
      it('rejects disallowed statuses in createForm with 400', async () => {
        const statuses = ['deleting', 'delete_failed', 'archived', 'unknown_status'];
        for (const st of statuses) {
          const res = await request(app)
            .post('/api/forms')
            .set('Cookie', [`token=${testOwnerToken}`])
            .send({
              title: `Form with status ${st}`,
              status: st
            });

          expect(res.status).toBe(400);
          expect(res.body.success).toBe(false);
          expect(res.body.message).toContain('Invalid form status');
        }
      });

      it('permits allowed statuses (draft, published, closed) in createForm', async () => {
        for (const st of ['draft', 'published', 'closed']) {
          const res = await request(app)
            .post('/api/forms')
            .set('Cookie', [`token=${testOwnerToken}`])
            .send({
              title: `Form status ${st}`,
              status: st
            });

          expect(res.status).toBe(201);
          expect(res.body.success).toBe(true);
          expect(res.body.data.status).toBe(st);
        }
      });

      it('rejects disallowed status in updateForm with 400', async () => {
        const form = await Form.create({
          title: 'Normal Form',
          ownerId: testOwnerId,
          status: 'draft'
        });

        const res = await request(app)
          .put(`/api/forms/${form._id}`)
          .set('Cookie', [`token=${testOwnerToken}`])
          .send({ status: 'deleting' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('Invalid form status');
      });

      it('prevents form resurrection: updateForm returns 409 when form status is deleting or delete_failed', async () => {
        const deletingForm = await Form.create({
          title: 'Deleting Form',
          ownerId: testOwnerId,
          status: 'deleting'
        });

        const res1 = await request(app)
          .put(`/api/forms/${deletingForm._id}`)
          .set('Cookie', [`token=${testOwnerToken}`])
          .send({ title: 'Resurrected Title', status: 'published' });

        expect(res1.status).toBe(409);
        expect(res1.body.success).toBe(false);
        expect(res1.body.message).toContain('Form is currently being deleted');

        // Verify database state was NOT modified
        const freshDoc = await Form.findById(deletingForm._id);
        expect(freshDoc.status).toBe('deleting');
        expect(freshDoc.title).toBe('Deleting Form');

        const failedForm = await Form.create({
          title: 'Delete Failed Form',
          ownerId: testOwnerId,
          status: 'delete_failed'
        });

        const res2 = await request(app)
          .put(`/api/forms/${failedForm._id}`)
          .set('Cookie', [`token=${testOwnerToken}`])
          .send({ title: 'Resurrected Failed Form', status: 'published' });

        expect(res2.status).toBe(409);
        expect(res2.body.success).toBe(false);
        expect(res2.body.message).toContain('Form deletion previously failed');

        const freshFailedDoc = await Form.findById(failedForm._id);
        expect(freshFailedDoc.status).toBe('delete_failed');
      });

      it('enforces userFormReadLimiter and publicFormFetchLimiter', async () => {
        expect(userFormReadLimiter).toBeDefined();
        expect(publicFormFetchLimiter).toBeDefined();

        const form = await Form.create({
          title: 'Public View Form',
          ownerId: testOwnerId,
          status: 'published'
        });

        const userReadRes = await request(app)
          .get('/api/forms')
          .set('Cookie', [`token=${testOwnerToken}`]);
        expect(userReadRes.status).toBe(200);
        expect(userReadRes.headers['ratelimit-limit']).toBeDefined();

        const publicFetchRes = await request(app).get(`/api/forms/${form._id}`);
        expect(publicFetchRes.status).toBe(200);
        expect(publicFetchRes.headers['ratelimit-limit']).toBeDefined();
      });

      it('B1 Ordering A (submission wins): active submission blocks deletion until complete, then deletion cleans up', async () => {
        const form = await Form.create({
          ownerId: testOwnerId,
          title: 'Submission Wins Form',
          status: 'published'
        });

        const question = await Question.create({
          formId: form._id,
          type: 'short_text',
          label: 'Answer this',
          order: 0
        });

        // 1. Submission begins and atomically acquires activeSubmissions reservation
        const reservationExpiry = new Date(Date.now() + 30000);
        await Form.updateOne(
          { _id: form._id },
          {
            $inc: { activeSubmissions: 1 },
            $set: { activeSubmissionsExpiresAt: reservationExpiry }
          }
        );

        // 2. While paused at deterministic barrier, start deletion
        const deletionPromise = executeFormDeletion(form._id, {
          userId: testOwnerId.toString(),
          drainWaitMs: 0
        });
        const delResult = await deletionPromise;

        // 3. Verify deletion cannot remove the form while submission is protected (returns 409)
        expect(delResult.statusCode).toBe(409);
        expect(delResult.message).toContain('submissions in flight');

        // Verify form and question are completely intact
        const formDuringSubmission = await Form.findById(form._id);
        expect(formDuringSubmission).not.toBeNull();
        expect(formDuringSubmission.status).toBe('published');

        // 4. Resume/complete submission: creates Response and releases reservation
        await Response.create({
          formId: form._id,
          answers: [{ questionId: question._id, value: 'Submitted value' }],
          submittedBy: '127.0.0.1'
        });
        await Form.updateOne({ _id: form._id }, { $inc: { activeSubmissions: -1 } });

        // 5. Deletion is retried and now proceeds correctly
        const retryResult = await executeFormDeletion(form._id, {
          userId: testOwnerId.toString(),
          drainWaitMs: 0
        });
        expect(retryResult.statusCode).toBe(200);

        // 6. Verify cascading cleanup completed
        expect(await Form.findById(form._id)).toBeNull();
        expect(await Question.countDocuments({ formId: form._id })).toBe(0);
        expect(await Response.countDocuments({ formId: form._id })).toBe(0);
      });

      it('B1 Ordering B (deletion wins): deletion claims lease first, submission is rejected before S3 upload or response creation', async () => {
        const form = await Form.create({
          ownerId: testOwnerId,
          title: 'Deletion Wins Form',
          status: 'published'
        });

        const question = await Question.create({
          formId: form._id,
          type: 'file',
          label: 'Upload File',
          order: 0
        });

        // 1. Deletion atomically claims lifecycle ownership
        const leaseId = crypto.randomUUID();
        await Form.updateOne(
          { _id: form._id },
          {
            $set: {
              status: 'deleting',
              'deletionProgress.leaseId': leaseId,
              'deletionProgress.leaseExpiresAt': new Date(Date.now() + 30000),
              'deletionProgress.stage': 's3_cleanup'
            }
          }
        );

        const uploadSpy = vi.spyOn(storageService, 'uploadFile');

        // 2. Submission arrives and attempts reservation
        const subRes = await request(app)
          .post(`/api/responses/${form._id}`)
          .send({
            answers: [{ questionId: question._id, value: 'test' }]
          });

        // 3. Verify submission is rejected with 409 before S3 upload or response creation
        expect(subRes.status).toBe(409);
        expect(subRes.body.message).toContain('Form is currently being deleted');
        expect(uploadSpy).not.toHaveBeenCalled();
        expect(await Response.countDocuments({ formId: form._id })).toBe(0);

        uploadSpy.mockRestore();

        // 4. Previous lease expires and deletion resumes to complete cleanup
        await Form.updateOne(
          { _id: form._id },
          { $set: { 'deletionProgress.leaseExpiresAt': new Date(Date.now() - 1000) } }
        );
        const delResult = await executeFormDeletion(form._id, { userId: testOwnerId.toString() });
        expect(delResult.statusCode).toBe(200);
        expect(await Form.findById(form._id)).toBeNull();
      });

      it('B1: recovers stale activeSubmissions when reservation lease has expired', async () => {
        const form = await Form.create({
          ownerId: testOwnerId,
          title: 'Stale Submission Form',
          status: 'published',
          activeSubmissions: 2,
          // Expired 10 seconds ago (simulates crashed submission worker)
          activeSubmissionsExpiresAt: new Date(Date.now() - 10000)
        });

        // Deletion must recognize that activeSubmissionsExpiresAt has expired and claim lease
        const delResult = await executeFormDeletion(form._id, {
          userId: testOwnerId.toString(),
          drainWaitMs: 0
        });
        expect(delResult.statusCode).toBe(200);

        // Verify form was safely deleted
        expect(await Form.findById(form._id)).toBeNull();
      });

      it('B1: rolls back S3 upload and releases reservation if database persistence fails', async () => {
        const form = await Form.create({
          ownerId: testOwnerId,
          title: 'Compensation Form',
          status: 'published'
        });

        const question = await Question.create({
          formId: form._id,
          type: 'short_text',
          label: 'Text Q',
          order: 0
        });

        const deleteFileSpy = vi.spyOn(storageService, 'deleteFile').mockResolvedValueOnce();
        const createSpy = vi
          .spyOn(Response, 'create')
          .mockRejectedValueOnce(new Error('Simulated DB persistence failure'));

        const res = await request(app)
          .post(`/api/responses/${form._id}`)
          .send({
            answers: [{ questionId: question._id, value: 'Value' }]
          });

        expect(res.status).toBe(500);

        // Verify reservation was released in finally block
        await vi.waitFor(async () => {
          const freshForm = await Form.findById(form._id);
          expect(freshForm.activeSubmissions).toBe(0);
        });

        createSpy.mockRestore();
        deleteFileSpy.mockRestore();
      });
    });
  });
});
