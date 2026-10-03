import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../models/user.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import responseRoutes from '../routes/responseRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';

let mongoServer;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/responses', responseRoutes);
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

describe('Response Controller - Phase 2', () => {
  let form;
  let qText, qNumber, qEmail, qChoice;

  beforeEach(async () => {
    await User.deleteMany({});
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});

    const user = await User.create({
      name: 'Owner',
      email: 'owner@test.com',
      password: 'password123'
    });

    form = await Form.create({ ownerId: user._id, title: 'Survey', status: 'published' });

    qText = await Question.create({ formId: form._id, type: 'short_text', label: 'Name', required: true, order: 0 });
    qNumber = await Question.create({ formId: form._id, type: 'number', label: 'Age', required: false, order: 1 });
    qEmail = await Question.create({ formId: form._id, type: 'email', label: 'Email', required: true, order: 2 });
    qChoice = await Question.create({
      formId: form._id,
      type: 'single_choice',
      label: 'Color',
      required: true,
      options: ['Red', 'Blue', 'Green'],
      order: 3
    });
    await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Why Red?',
      required: true, // It is required, but hidden unless Color == Red
      visibilityRule: {
        targetQuestionId: qChoice._id.toString(),
        operator: 'equals',
        value: 'Red'
      },
      order: 4
    });
  });

  describe('Submission Validation', () => {
    it('should reject submission for draft forms', async () => {
      form.status = 'draft';
      await form.save();

      const res = await request(app).post(`/api/responses/${form._id}`).send({ answers: [] });
      expect(res.status).toBe(403);
    });

    it('should reject missing required field', async () => {
      const res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          // Missing Email
          { questionId: qChoice._id, value: 'Blue' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('required');
    });

    it('should enforce conditional visibility on required fields', async () => {
      // Color is Blue, so 'Why Red?' (qHidden) is not visible, therefore its required flag is ignored
      const res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]
      });
      expect(res.status).toBe(201); // Success
    });

    it('should enforce required flag if condition is met', async () => {
      // Color is Red, so 'Why Red?' is visible and required
      const res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Red' }
          // Missing Why Red?
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('required');
    });

    it('should validate email type', async () => {
      const res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'not-an-email' },
          { questionId: qChoice._id, value: 'Blue' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('valid email');
    });

    it('should validate number type', async () => {
      const res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: 'twenty' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('number');
    });

    it('should validate choice options', async () => {
      const res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Yellow' } // Invalid choice
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('invalid choice');
    });
  });

  describe('File Upload Validation', () => {
    let qFile;
    beforeEach(async () => {
      qFile = await Question.create({ formId: form._id, type: 'file', label: 'Resume', required: true, order: 5 });
    });

    it('should reject missing required file', async () => {
      const res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
          // Missing file
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('required');
    });

    it('should accept valid file submission', async () => {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]))
        .attach(`file_${qFile._id.toString()}`, Buffer.from('%PDF-1.4\n%EOF\n'), {
          filename: 'resume.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(201);

      const response = await Response.findOne({ formId: form._id });
      const fileAnswer = response.answers.find(a => a.questionId.toString() === qFile._id.toString());

      expect(fileAnswer).toBeDefined();
      expect(fileAnswer.value.mimeType).toBe('application/pdf');
      expect(fileAnswer.value.originalName).toBe('resume.pdf');
      expect(fileAnswer.value.key).toContain('forms/');
    });

    it('should reject unsupported file type', async () => {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]))
        .attach(`file_${qFile._id.toString()}`, Buffer.from('%PDF-1.4\n'), {
          filename: 'virus.exe',
          contentType: 'application/x-msdownload'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('unsupported file type');
    });

    it('should reject file with mismatched MIME/content', async () => {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]))
        .attach(`file_${qFile._id.toString()}`, Buffer.from('not really a pdf'), {
          filename: 'virus.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('unrecognized file signature');
    });

    it('should reject file with unrecognized signature', async () => {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]))
        .attach(`file_${qFile._id.toString()}`, Buffer.from('fake unrecognized content'), {
          filename: 'resume.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('unrecognized file signature');
    });

    it('should rollback S3 upload if database fails', async () => {
      const storageService = await import('../services/StorageService.js');
      const deleteSpy = vi.spyOn(storageService.default, 'deleteFile');
      const createSpy = vi.spyOn(Response, 'create').mockRejectedValueOnce(new Error('Simulated DB Failure'));

      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field('answers', JSON.stringify([
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]))
        .attach(`file_${qFile._id.toString()}`, Buffer.from('%PDF-1.4\n'), {
          filename: 'valid.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(500);
      expect(deleteSpy).toHaveBeenCalled();

      createSpy.mockRestore();
      deleteSpy.mockRestore();
    });
  });

  describe('Analytics and Pagination (Phase 4)', () => {
    let ownerToken;

    beforeEach(async () => {
      ownerToken = 'fake-token';
      const user = await User.findOne({ email: 'owner@test.com' });
      const jwt = await import('jsonwebtoken');
      ownerToken = jwt.default.sign({ id: user._id }, process.env.JWT_SECRET);

      // Create some responses
      await Response.create([
        {
          formId: form._id,
          answers: [
            { questionId: qText._id, value: 'Alice' },
            { questionId: qNumber._id, value: 20 },
            { questionId: qChoice._id, value: 'Red' }
          ],
          createdAt: new Date('2023-01-01T10:00:00Z')
        },
        {
          formId: form._id,
          answers: [
            { questionId: qText._id, value: 'Bob' },
            { questionId: qNumber._id, value: 30 },
            { questionId: qChoice._id, value: 'Blue' }
          ],
          createdAt: new Date('2023-01-02T10:00:00Z')
        },
        {
          formId: form._id,
          answers: [
            { questionId: qText._id, value: 'Charlie' },
            { questionId: qNumber._id, value: 40 },
            { questionId: qChoice._id, value: 'Blue' }
          ],
          createdAt: new Date('2023-01-03T10:00:00Z')
        }
      ]);
    });

    it('should paginate responses correctly', async () => {
      const res = await request(app)
        .get(`/api/responses/${form._id}?page=1&limit=2`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.pagination.total).toBe(3);
      expect(res.body.pagination.pages).toBe(2);
    });

    it('should aggregate analytics correctly', async () => {
      const res = await request(app)
        .get(`/api/responses/${form._id}/analytics`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      const data = res.body.data;

      expect(data.summary.totalResponses).toBe(3);
      expect(data.summary.completedResponses).toBe(3);
      expect(data.summary.completionRate).toBe(100);

      const choiceAnalytics = data.analytics.find(a => a.type === 'single_choice');
      expect(choiceAnalytics.data.distribution.find(d => d.option === 'Blue').count).toBe(2);
      expect(choiceAnalytics.data.distribution.find(d => d.option === 'Red').count).toBe(1);

      const numberAnalytics = data.analytics.find(a => a.type === 'number');
      expect(numberAnalytics.data.min).toBe(20);
      expect(numberAnalytics.data.max).toBe(40);
      expect(numberAnalytics.data.average).toBe(30);
    });
  });
});
