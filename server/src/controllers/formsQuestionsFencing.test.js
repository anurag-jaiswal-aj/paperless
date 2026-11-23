import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';

import Form from '../models/form.js';
import Question from '../models/question.js';
import User from '../models/user.js';
import InstanceLease, { InstanceLeaseSlot } from '../models/instanceLease.js';
import formRoutes from '../routes/formRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import {
  ensureSlotsExist,
  acquireInstanceLease
} from '../services/instanceLeaseService.js';
import { withRequiredTransaction, computeDesignatedSlotId } from '../utils/dbTransaction.js';

let mongoServer;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/forms', formRoutes);
app.use(errorHandler);

const TEST_SECRET = 'test-jwt-secret-kb';
process.env.JWT_SECRET = TEST_SECRET;

const createAuthToken = (user) => {
  return jwt.sign({ id: user._id.toString(), email: user.email }, TEST_SECRET, {
    expiresIn: '1h'
  });
};

describe('Phase K-B: Forms and Questions Transactional Fencing Test Suite', () => {
  let testUser;
  let testUserToken;
  let otherUser;
  let otherUserToken;

  beforeAll(async () => {
    mongoServer = await startReplSet();
    await ensureSlotsExist();
    await acquireInstanceLease();
  }, 60000);

  afterAll(async () => {
    await stopReplSet(mongoServer);
  });

  beforeEach(async () => {
    await Form.deleteMany({});
    await Question.deleteMany({});
    await User.deleteMany({});
    await InstanceLease.deleteMany({});
    await InstanceLeaseSlot.deleteMany({});
    await ensureSlotsExist();
    await acquireInstanceLease({ skipHeartbeat: true });

    testUser = await User.create({
      name: 'KB Test User',
      email: 'kb-test@example.com',
      password: 'Password123!',
      isEmailVerified: true
    });
    testUserToken = createAuthToken(testUser);

    otherUser = await User.create({
      name: 'Other User',
      email: 'other-user@example.com',
      password: 'Password123!',
      isEmailVerified: true
    });
    otherUserToken = createAuthToken(otherUser);
  });

  // =========================================================================
  // Section 1: Fenced Form Creation (F-08 / W-070)
  // =========================================================================
  describe('1. Fenced Form Creation (createForm)', () => {
    it('creates a form inside a fenced transaction and increments the designated slot epoch', async () => {
      const designatedSlotId = computeDesignatedSlotId(testUser._id.toString());
      const slotBefore = await InstanceLeaseSlot.findById(designatedSlotId);
      const epochBefore = slotBefore.fenceEpoch;

      const res = await request(app)
        .post('/api/forms')
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          title: 'Transactional Form',
          description: 'Created inside fenced transaction',
          status: 'draft'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Transactional Form');
      expect(res.body.data.ownerId.toString()).toBe(testUser._id.toString());

      // Verify that designated slot epoch was incremented
      const slotAfter = await InstanceLeaseSlot.findById(designatedSlotId);
      expect(slotAfter.fenceEpoch).toBe(epochBefore + 1);

      // Verify persistence in MongoDB
      const formInDb = await Form.findById(res.body.data._id);
      expect(formInDb).not.toBeNull();
      expect(formInDb.title).toBe('Transactional Form');
    });

    it('rolls back form creation completely if transaction aborts', async () => {
      await expect(
        withRequiredTransaction(async (session) => {
          await Form.create(
            [
              {
                ownerId: testUser._id,
                title: 'Aborted Form',
                status: 'draft'
              }
            ],
            { session }
          );
          throw new Error('INJECTED_ABORT_FOR_TEST');
        }, { partitionKey: testUser._id.toString() })
      ).rejects.toThrow('INJECTED_ABORT_FOR_TEST');

      const found = await Form.findOne({ title: 'Aborted Form' });
      expect(found).toBeNull();
    });
  });

  // =========================================================================
  // Section 2: Fenced Form Update & OCC (F-09 / W-071)
  // =========================================================================
  describe('2. Fenced Form Update & OCC (updateForm)', () => {
    it('updates form inside fenced transaction and increments OCC version', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Initial Title',
        version: 0,
        status: 'draft'
      });

      const designatedSlotId = computeDesignatedSlotId(form._id.toString());
      const slotBefore = await InstanceLeaseSlot.findById(designatedSlotId);
      const epochBefore = slotBefore.fenceEpoch;

      const res = await request(app)
        .put(`/api/forms/${form._id}`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          title: 'Updated Title',
          version: 0
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Updated Title');
      expect(res.body.data.version).toBe(1);

      // Verify designated slot epoch incremented
      const slotAfter = await InstanceLeaseSlot.findById(designatedSlotId);
      expect(slotAfter.fenceEpoch).toBe(epochBefore + 1);

      const updated = await Form.findById(form._id);
      expect(updated.title).toBe('Updated Title');
      expect(updated.version).toBe(1);
    });

    it('rejects update from non-owner user with HTTP 403', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Owned Form',
        version: 0,
        status: 'draft'
      });

      const res = await request(app)
        .put(`/api/forms/${form._id}`)
        .set('Cookie', [`token=${otherUserToken}`])
        .send({
          title: 'Unauthorized Modification',
          version: 0
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects stale version with HTTP 409 Conflict and leaves database unmodified', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'OCC Form',
        version: 1, // already at version 1
        status: 'draft'
      });

      const res = await request(app)
        .put(`/api/forms/${form._id}`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          title: 'Stale Update Attempt',
          version: 0 // sending stale version 0
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Conflict');

      const unmodified = await Form.findById(form._id);
      expect(unmodified.title).toBe('OCC Form');
      expect(unmodified.version).toBe(1);
    });

    it('rolls back form update completely if transaction aborts', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Original Form State',
        version: 0,
        status: 'draft'
      });

      await expect(
        withRequiredTransaction(async (session) => {
          await Form.findByIdAndUpdate(
            form._id,
            { $set: { title: 'Tainted Title' }, $inc: { version: 1 } },
            { session }
          );
          throw new Error('SIMULATED_TRANSACTION_FAILURE');
        }, { partitionKey: form._id.toString() })
      ).rejects.toThrow('SIMULATED_TRANSACTION_FAILURE');

      const reloaded = await Form.findById(form._id);
      expect(reloaded.title).toBe('Original Form State');
      expect(reloaded.version).toBe(0);
    });
  });

  // =========================================================================
  // Section 3: Question Addition & Cascade (F-04 / W-015, Q-02 / W-016)
  // =========================================================================
  describe('3. Question Addition & Atomicity (addQuestion)', () => {
    it('atomically creates Question and increments parent nextQuestionOrder', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Parent Form',
        nextQuestionOrder: 0,
        status: 'draft'
      });

      const res = await request(app)
        .post(`/api/forms/${form._id}/questions`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          type: 'short_text',
          label: 'What is your full name?',
          required: true
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.label).toBe('What is your full name?');
      expect(res.body.data.order).toBe(0);

      // Verify parent Form nextQuestionOrder incremented
      const updatedForm = await Form.findById(form._id);
      expect(updatedForm.nextQuestionOrder).toBe(1);

      // Verify question persisted
      const questionInDb = await Question.findById(res.body.data._id);
      expect(questionInDb).not.toBeNull();
      expect(questionInDb.formId.toString()).toBe(form._id.toString());
    });

    it('rejects question creation with HTTP 409 if form is currently deleting', async () => {
      const deletingForm = await Form.create({
        ownerId: testUser._id,
        title: 'Deleting Form',
        status: 'deleting'
      });

      const res = await request(app)
        .post(`/api/forms/${deletingForm._id}/questions`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          type: 'short_text',
          label: 'Should be rejected'
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('being deleted');

      const count = await Question.countDocuments({ formId: deletingForm._id });
      expect(count).toBe(0);
    });

    it('rolls back parent nextQuestionOrder if question insertion fails', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Rollback Form',
        nextQuestionOrder: 0,
        status: 'draft'
      });

      await expect(
        withRequiredTransaction(async (session) => {
          await Form.findByIdAndUpdate(
            form._id,
            { $inc: { nextQuestionOrder: 1, lifecycleVersion: 1 } },
            { session }
          );
          // Injected failure
          throw new Error('QUESTION_INSERT_FAILED');
        }, { partitionKey: form._id.toString() })
      ).rejects.toThrow('QUESTION_INSERT_FAILED');

      const reloaded = await Form.findById(form._id);
      expect(reloaded.nextQuestionOrder).toBe(0);
      expect(reloaded.lifecycleVersion || 0).toBe(0);
    });
  });

  // =========================================================================
  // Section 4: Question Update & OCC (F-05 / W-017, Q-03 / W-018)
  // =========================================================================
  describe('4. Question Update & OCC (updateQuestion)', () => {
    it('atomically updates Question and bumps parent Form lifecycleVersion', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Lifecycle Form',
        lifecycleVersion: 1,
        status: 'draft'
      });

      const question = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Original Question Label',
        version: 0,
        order: 0
      });

      const res = await request(app)
        .put(`/api/forms/${form._id}/questions/${question._id}`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          label: 'Updated Question Label',
          version: 0
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.label).toBe('Updated Question Label');
      expect(res.body.data.version).toBe(1);

      // Verify parent Form lifecycleVersion bumped
      const updatedForm = await Form.findById(form._id);
      expect(updatedForm.lifecycleVersion).toBe(2);
    });

    it('rejects stale question version update with HTTP 409 Conflict', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'OCC Question Form',
        status: 'draft'
      });

      const question = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Question at V1',
        version: 1,
        order: 0
      });

      const res = await request(app)
        .put(`/api/forms/${form._id}/questions/${question._id}`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          label: 'Stale Question Update',
          version: 0
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Conflict');

      const unmodified = await Question.findById(question._id);
      expect(unmodified.label).toBe('Question at V1');
      expect(unmodified.version).toBe(1);
    });
  });

  // =========================================================================
  // Section 5: Question Deletion & Visibility Cleanup (F-06, Q-04, Q-05)
  // =========================================================================
  describe('5. Question Deletion & Cascade (deleteQuestion)', () => {
    it('atomically deletes Question, clears dependent visibility rules, and bumps form', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Cascade Delete Form',
        lifecycleVersion: 1,
        status: 'draft'
      });

      const q1 = await Question.create({
        formId: form._id,
        type: 'single_choice',
        label: 'Trigger Question',
        order: 0
      });

      const q2 = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Dependent Question',
        order: 1,
        visibilityRule: {
          targetQuestionId: q1._id,
          operator: 'equals',
          value: 'yes'
        }
      });

      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${q1._id}`)
        .set('Cookie', [`token=${testUserToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify q1 deleted
      const q1Check = await Question.findById(q1._id);
      expect(q1Check).toBeNull();

      // Verify q2 visibility rule cleared
      const q2Check = await Question.findById(q2._id);
      expect(q2Check.visibilityRule).toBeNull();

      // Verify parent Form lifecycleVersion incremented
      const updatedForm = await Form.findById(form._id);
      expect(updatedForm.lifecycleVersion).toBe(2);
    });

    it('rolls back question deletion and visibility rule cleanup if transaction fails', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Cascade Rollback Form',
        status: 'draft'
      });

      const q1 = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Q1 Stay Alive',
        order: 0
      });

      const q2 = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Q2 Dependent',
        order: 1,
        visibilityRule: {
          targetQuestionId: q1._id,
          operator: 'equals',
          value: 'yes'
        }
      });

      await expect(
        withRequiredTransaction(async (session) => {
          await Question.updateMany(
            { formId: form._id, 'visibilityRule.targetQuestionId': q1._id },
            { $set: { visibilityRule: null } },
            { session }
          );
          await Question.deleteOne({ _id: q1._id }, { session });
          throw new Error('SIMULATED_DELETE_FAIL');
        }, { partitionKey: form._id.toString() })
      ).rejects.toThrow('SIMULATED_DELETE_FAIL');

      // q1 must still exist
      const q1Check = await Question.findById(q1._id);
      expect(q1Check).not.toBeNull();

      // q2 visibility rule must still be intact
      const q2Check = await Question.findById(q2._id);
      expect(q2Check.visibilityRule).not.toBeNull();
      expect(q2Check.visibilityRule.targetQuestionId.toString()).toBe(q1._id.toString());
    });
  });

  // =========================================================================
  // Section 6: Question Reordering (F-07 / W-022, Q-06 / W-023)
  // =========================================================================
  describe('6. Question Reordering (reorderQuestions)', () => {
    it('atomically reorders questions inside fenced transaction and updates Form', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Reorder Form',
        version: 0,
        status: 'draft'
      });

      const q1 = await Question.create({ formId: form._id, type: 'short_text', label: 'Q1', order: 0 });
      const q2 = await Question.create({ formId: form._id, type: 'short_text', label: 'Q2', order: 1 });

      const res = await request(app)
        .put(`/api/forms/${form._id}/questions/reorder`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          version: 0,
          questionOrders: [
            { questionId: q1._id.toString(), order: 1 },
            { questionId: q2._id.toString(), order: 0 }
          ]
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const q1Reload = await Question.findById(q1._id);
      const q2Reload = await Question.findById(q2._id);
      expect(q1Reload.order).toBe(1);
      expect(q2Reload.order).toBe(0);

      const formReload = await Form.findById(form._id);
      expect(formReload.version).toBe(1);
    });

    it('rejects reorder on stale form version with HTTP 409 Conflict', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Reorder OCC Form',
        version: 1,
        status: 'draft'
      });

      const q1 = await Question.create({ formId: form._id, type: 'short_text', label: 'Q1', order: 0 });

      const res = await request(app)
        .put(`/api/forms/${form._id}/questions/reorder`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          version: 0, // stale
          questionOrders: [{ questionId: q1._id.toString(), order: 0 }]
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Conflict');
    });
  });

  // =========================================================================
  // Section 7: Adversarial Fencing Invalidation
  // =========================================================================
  describe('7. Adversarial Fencing Rejection under Stale Lease', () => {
    it('rejects createForm and creates 0 documents when lease slot is invalidated', async () => {
      const designatedSlotId = computeDesignatedSlotId(testUser._id.toString());

      // Simulate competing takeover by revoking/releasing the designated slot in datastore
      await InstanceLeaseSlot.updateOne(
        { _id: designatedSlotId },
        { $set: { instanceId: 'competing_instance_takeover', status: 'RELEASED' } }
      );

      const res = await request(app)
        .post('/api/forms')
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          title: 'Should Be Fenced Out',
          status: 'draft'
        });

      expect(res.status).toBe(503);
      expect(res.body.message).toContain('fence');

      // Verify zero forms created in database
      const formCount = await Form.countDocuments({ title: 'Should Be Fenced Out' });
      expect(formCount).toBe(0);
    });

    it('rejects updateForm and leaves form unmodified when lease slot is invalidated', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Unmodified Form',
        version: 0,
        status: 'draft'
      });

      const designatedSlotId = computeDesignatedSlotId(form._id.toString());
      await InstanceLeaseSlot.updateOne(
        { _id: designatedSlotId },
        { $set: { instanceId: 'competing_instance_takeover', status: 'RELEASED' } }
      );

      const res = await request(app)
        .put(`/api/forms/${form._id}`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          title: 'Attempted Stale Overwrite',
          version: 0
        });

      expect(res.status).toBe(503);

      const reloaded = await Form.findById(form._id);
      expect(reloaded.title).toBe('Unmodified Form');
      expect(reloaded.version).toBe(0);
    });

    it('rejects addQuestion and creates 0 questions when lease slot is invalidated', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Form Fenced Question',
        nextQuestionOrder: 0,
        status: 'draft'
      });

      const designatedSlotId = computeDesignatedSlotId(form._id.toString());
      await InstanceLeaseSlot.updateOne(
        { _id: designatedSlotId },
        { $set: { instanceId: 'competing_instance_takeover', status: 'RELEASED' } }
      );

      const res = await request(app)
        .post(`/api/forms/${form._id}/questions`)
        .set('Cookie', [`token=${testUserToken}`])
        .send({
          type: 'short_text',
          label: 'Fenced Question'
        });

      expect(res.status).toBe(503);

      const questionCount = await Question.countDocuments({ formId: form._id });
      expect(questionCount).toBe(0);

      const reloadedForm = await Form.findById(form._id);
      expect(reloadedForm.nextQuestionOrder).toBe(0);
    });

    it('rejects deleteQuestion and leaves question intact when lease slot is invalidated', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Form Fenced Delete',
        status: 'draft'
      });

      const q = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Survivor Question',
        order: 0
      });

      const designatedSlotId = computeDesignatedSlotId(form._id.toString());
      await InstanceLeaseSlot.updateOne(
        { _id: designatedSlotId },
        { $set: { instanceId: 'competing_instance_takeover', status: 'RELEASED' } }
      );

      const res = await request(app)
        .delete(`/api/forms/${form._id}/questions/${q._id}`)
        .set('Cookie', [`token=${testUserToken}`]);

      expect(res.status).toBe(503);

      const reloadedQ = await Question.findById(q._id);
      expect(reloadedQ).not.toBeNull();
      expect(reloadedQ.label).toBe('Survivor Question');
    });
  });

  // =========================================================================
  // Section 8: Concurrency & Interleaving Scenarios
  // =========================================================================
  describe('8. High Concurrency & Interleaving Scenarios', () => {
    it('concurrent updateForm requests: exactly one succeeds and one receives 409', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Race Form',
        version: 0,
        status: 'draft'
      });

      const [res1, res2] = await Promise.all([
        request(app)
          .put(`/api/forms/${form._id}`)
          .set('Cookie', [`token=${testUserToken}`])
          .send({ title: 'Race Winner A', version: 0 }),
        request(app)
          .put(`/api/forms/${form._id}`)
          .set('Cookie', [`token=${testUserToken}`])
          .send({ title: 'Race Winner B', version: 0 })
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const finalForm = await Form.findById(form._id);
      expect(finalForm.version).toBe(1);
      expect(['Race Winner A', 'Race Winner B']).toContain(finalForm.title);
    });

    it('concurrent addQuestion requests: allocates unique contiguous orders without collision', async () => {
      const form = await Form.create({
        ownerId: testUser._id,
        title: 'Concurrent Add Form',
        nextQuestionOrder: 0,
        status: 'draft'
      });

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/forms/${form._id}/questions`)
          .set('Cookie', [`token=${testUserToken}`])
          .send({ type: 'short_text', label: 'Concurrent Q1' }),
        request(app)
          .post(`/api/forms/${form._id}/questions`)
          .set('Cookie', [`token=${testUserToken}`])
          .send({ type: 'short_text', label: 'Concurrent Q2' })
      ]);

      const statuses = [res1.status, res2.status];
      expect(statuses).toContain(201);

      if (res1.status === 201 && res2.status === 201) {
        const orders = [res1.body.data.order, res2.body.data.order].sort((a, b) => a - b);
        expect(orders).toEqual([0, 1]);
        const finalForm = await Form.findById(form._id);
        expect(finalForm.nextQuestionOrder).toBe(2);
      } else {
        const successRes = res1.status === 201 ? res1 : res2;
        expect(successRes.body.data.order).toBe(0);
        const finalForm = await Form.findById(form._id);
        expect(finalForm.nextQuestionOrder).toBe(1);
      }
    });
  });
});
