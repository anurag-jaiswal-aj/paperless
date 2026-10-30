import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../models/user.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import jwt from 'jsonwebtoken';
import formRoutes from '../routes/formRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';

let mongoServer;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/forms', formRoutes);
app.use(errorHandler);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  process.env.JWT_SECRET = 'testsecret';
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Form Controller - Phase 2', () => {
  let user1Token, user2Token;
  let user1Id, user2Id;

  beforeEach(async () => {
    await User.deleteMany({});
    await Form.deleteMany({});
    await Question.deleteMany({});

    const user1 = await User.create({
      name: 'User One',
      email: 'user1@test.com',
      password: 'password123'
    });
    user1Id = user1._id;
    user1Token = jwt.sign({ id: user1Id }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '15m' });

    const user2 = await User.create({
      name: 'User Two',
      email: 'user2@test.com',
      password: 'password123'
    });
    user2Id = user2._id;
    user2Token = jwt.sign({ id: user2Id }, process.env.JWT_SECRET || 'testsecret', { expiresIn: '15m' });
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

      expect(res.status).toBe(403);
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
      const q1 = await Question.create({ formId: form._id, type: 'short_text', label: 'Q1', order: 0 });
      const q2 = await Question.create({ formId: form._id, type: 'short_text', label: 'Q2', order: 1 });

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
      const q1 = await Question.create({ formId: form._id, type: 'short_text', label: 'Q1', order: 0 });
      // Create second form owned by user2 with its own question
      const form2 = await Form.create({ ownerId: user2Id, title: 'Form 2', status: 'draft' });
      const qForeign = await Question.create({ formId: form2._id, type: 'short_text', label: 'Foreign Q', order: 0 });

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

      expect(res.status).toBe(200);

      // Verify q1 was updated because it belongs to form 1
      const updatedQ1 = await Question.findById(q1._id);
      expect(updatedQ1.order).toBe(5);

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
      const q1 = await Question.create({ formId: form._id, type: 'short_text', label: 'Q1', order: 0 });
      const q2 = await Question.create({ formId: form._id, type: 'short_text', label: 'Q2', order: 1 });
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
        visibilityRule: { targetQuestionId: qParent._id.toString(), operator: 'equals', value: 'Option B' }
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
      const deleteSpy = vi.spyOn(Question, 'deleteOne').mockRejectedValueOnce(new Error('Simulated DB Failure on delete'));

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
      expect(checkDependent.visibilityRule.targetQuestionId.toString()).toBe(qTarget._id.toString());

      deleteSpy.mockRestore();
    });
  });
});
