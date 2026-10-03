import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
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
  });
});
