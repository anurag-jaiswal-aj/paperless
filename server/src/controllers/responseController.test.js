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
import { formatCsvAnswer, sanitizeCsvCell, escapeCsvCell } from './responseController.js';
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

    it('should validate and save rating questions', async () => {
      const qRating = await Question.create({
        formId: form._id,
        type: 'rating',
        label: 'Overall Experience',
        required: true,
        order: 10
      });

      // Reject non-number
      const resBadType = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: 'excellent' }
        ]
      });
      expect(resBadType.status).toBe(400);
      expect(resBadType.body.message).toContain('must be a rating between 1 and 5');

      // Reject rating < 1
      const resLow = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: 0 }
        ]
      });
      expect(resLow.status).toBe(400);
      expect(resLow.body.message).toContain('must be a rating between 1 and 5');

      // Reject rating > 5
      const resHigh = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: 6 }
        ]
      });
      expect(resHigh.status).toBe(400);
      expect(resHigh.body.message).toContain('must be a rating between 1 and 5');

      // Reject non-integer rating
      const resFloat = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: 4.5 }
        ]
      });
      expect(resFloat.status).toBe(400);
      expect(resFloat.body.message).toContain('must be a rating between 1 and 5');

      // Reject boolean and array values
      const resBool = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: true }
        ]
      });
      expect(resBool.status).toBe(400);
      expect(resBool.body.message).toContain('must be a rating between 1 and 5');

      const resArr = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: [5] }
        ]
      });
      expect(resArr.status).toBe(400);
      expect(resArr.body.message).toContain('must be a rating between 1 and 5');

      // Accept valid rating and store as number
      const resValid = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: '5' }
        ]
      });
      expect(resValid.status).toBe(201);

      const saved = await Response.findOne({ formId: form._id }).sort({ createdAt: -1 });
      const ratingAns = saved.answers.find(a => a.questionId.toString() === qRating._id.toString());
      expect(ratingAns.value).toBe(5);
    });

    it('should validate and save date questions', async () => {
      const qDate = await Question.create({
        formId: form._id,
        type: 'date',
        label: 'Event Date',
        required: true,
        order: 11
      });

      // Reject invalid date string
      const resBad = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qDate._id, value: 'invalid-date-string' }
        ]
      });
      expect(resBad.status).toBe(400);
      expect(resBad.body.message).toContain('must be a valid date');

      // Reject impossible calendar date (Feb 31)
      const resFeb31 = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qDate._id, value: '2026-02-31' }
        ]
      });
      expect(resFeb31.status).toBe(400);
      expect(resFeb31.body.message).toContain('must be a valid date');

      // Reject impossible day in 30-day month (April 31)
      const resApr31 = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qDate._id, value: '2026-04-31' }
        ]
      });
      expect(resApr31.status).toBe(400);
      expect(resApr31.body.message).toContain('must be a valid date');

      // Reject Feb 29 on non-leap year (2025)
      const resNonLeap = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qDate._id, value: '2025-02-29' }
        ]
      });
      expect(resNonLeap.status).toBe(400);
      expect(resNonLeap.body.message).toContain('must be a valid date');

      // Reject century non-leap year (1900-02-29)
      const res1900 = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qDate._id, value: '1900-02-29' }
        ]
      });
      expect(res1900.status).toBe(400);
      expect(res1900.body.message).toContain('must be a valid date');

      // Accept Feb 29 on leap year (2024)
      const resLeap = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qDate._id, value: '2024-02-29' }
        ]
      });
      expect(resLeap.status).toBe(201);

      // Accept valid YYYY-MM-DD date
      const resValid = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qDate._id, value: '2026-10-29' }
        ]
      });
      expect(resValid.status).toBe(201);

      const saved = await Response.findOne({ formId: form._id }).sort({ createdAt: -1 });
      const dateAns = saved.answers.find(a => a.questionId.toString() === qDate._id.toString());
      expect(dateAns.value).toBe('2026-10-29');

      // Reject missing required date
      const resMissingReq = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]
      });
      expect(resMissingReq.status).toBe(400);
      expect(resMissingReq.body.message).toContain('is required');

      // Optional date question can be omitted safely
      const qOptDate = await Question.create({
        formId: form._id,
        type: 'date',
        label: 'Optional Completion Date',
        required: false,
        order: 12
      });
      expect(qOptDate.required).toBe(false);

      const resOptOmitted = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qDate._id, value: '2026-10-29' }
          // qOptDate omitted
        ]
      });
      expect(resOptOmitted.status).toBe(201);
    });

    it('should validate multiple_choice and checkbox array inputs', async () => {
      const qMulti = await Question.create({
        formId: form._id,
        type: 'multiple_choice',
        label: 'Hobbies',
        required: true,
        options: ['Reading', 'Gaming', 'Cooking'],
        order: 12
      });
      const qCheck = await Question.create({
        formId: form._id,
        type: 'checkbox',
        label: 'Languages',
        required: false,
        options: ['JS', 'Python', 'Go'],
        order: 13
      });

      // Reject if value is not an array
      const resNotArray = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qMulti._id, value: 'Reading' }
        ]
      });
      expect(resNotArray.status).toBe(400);
      expect(resNotArray.body.message).toContain('invalid choices');

      // Reject if an option is not in defined options
      const resBadOpt = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qMulti._id, value: ['Reading', 'Skydiving'] }
        ]
      });
      expect(resBadOpt.status).toBe(400);
      expect(resBadOpt.body.message).toContain('invalid choices');

      // Accept valid array
      const resValid = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qMulti._id, value: ['Reading', 'Cooking'] },
          { questionId: qCheck._id, value: ['JS', 'Go'] }
        ]
      });
      expect(resValid.status).toBe(201);
    });

    it('should evaluate conditional visibility rules targeting rating, date, and multiple_choice', async () => {
      const qRating = await Question.create({
        formId: form._id,
        type: 'rating',
        label: 'Satisfaction',
        required: true,
        order: 14
      });
      const qFeedback = await Question.create({
        formId: form._id,
        type: 'short_text',
        label: 'Why 5 stars?',
        required: true,
        visibilityRule: {
          targetQuestionId: qRating._id.toString(),
          operator: 'equals',
          value: '5'
        },
        order: 15
      });

      // Rating is 4: qFeedback is hidden, so required rule is bypassed
      const resHidden = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: 4 }
        ]
      });
      expect(resHidden.status).toBe(201);

      // Rating is 5: qFeedback is visible and required, so submission fails if omitted
      const resVisibleMissing = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: 5 }
        ]
      });
      expect(resVisibleMissing.status).toBe(400);
      expect(resVisibleMissing.body.message).toContain('Why 5 stars?');

      // Rating is 5: qFeedback is provided, so submission succeeds
      const resVisibleSuccess = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qRating._id, value: 5 },
          { questionId: qFeedback._id, value: 'Loved the product!' }
        ]
      });
      expect(resVisibleSuccess.status).toBe(201);
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

    it('should aggregate rating and checkbox analytics correctly', async () => {
      const qRating = await Question.create({
        formId: form._id,
        type: 'rating',
        label: 'Satisfaction',
        required: false,
        order: 20
      });
      const qCheck = await Question.create({
        formId: form._id,
        type: 'checkbox',
        label: 'Interests',
        options: ['Coding', 'Music', 'Design'],
        required: false,
        order: 21
      });

      await Response.create([
        {
          formId: form._id,
          answers: [
            { questionId: qRating._id, value: 5 },
            { questionId: qCheck._id, value: ['Coding', 'Design'] }
          ]
        },
        {
          formId: form._id,
          answers: [
            { questionId: qRating._id, value: 4 },
            { questionId: qCheck._id, value: ['Coding'] }
          ]
        },
        {
          formId: form._id,
          answers: [
            { questionId: qRating._id, value: 5 },
            { questionId: qCheck._id, value: ['Music', 'Design'] }
          ]
        }
      ]);

      const res = await request(app)
        .get(`/api/responses/${form._id}/analytics`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      const data = res.body.data;

      const ratingAnalytics = data.analytics.find(a => a.type === 'rating');
      expect(ratingAnalytics).toBeDefined();
      expect(ratingAnalytics.data.type).toBe('rating');
      expect(ratingAnalytics.data.average).toBe(4.7);
      expect(ratingAnalytics.data.distribution['5']).toBe(2);
      expect(ratingAnalytics.data.distribution['4']).toBe(1);
      expect(ratingAnalytics.data.distribution['1']).toBe(0);

      const checkAnalytics = data.analytics.find(a => a.type === 'checkbox');
      expect(checkAnalytics).toBeDefined();
      expect(checkAnalytics.data.type).toBe('options');
      expect(checkAnalytics.data.distribution.find(d => d.option === 'Coding').count).toBe(2);
      expect(checkAnalytics.data.distribution.find(d => d.option === 'Design').count).toBe(2);
      expect(checkAnalytics.data.distribution.find(d => d.option === 'Music').count).toBe(1);
    });

    it('returns stable 0 values for rating questions with empty responses or invalid entries', async () => {
      const user = await User.findOne({ email: 'owner@test.com' });
      const emptyForm = await Form.create({
        ownerId: user._id,
        title: 'Empty Form',
        status: 'published'
      });
      const qRatingEmpty = await Question.create({
        formId: emptyForm._id,
        type: 'rating',
        label: 'Unrated Service',
        required: false,
        order: 0
      });

      const res = await request(app)
        .get(`/api/responses/${emptyForm._id}/analytics`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      const ratingAnalytics = res.body.data.analytics.find(a => a.questionId.toString() === qRatingEmpty._id.toString());
      expect(ratingAnalytics).toBeDefined();
      expect(ratingAnalytics.data.average).toBe(0);
      expect(ratingAnalytics.data.totalRatings).toBe(0);
      expect(ratingAnalytics.data.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
    });
  });

  describe('CSV Utility Functions Unit Tests', () => {
    it('formatCsvAnswer handles all value variants deterministically', () => {
      expect(formatCsvAnswer(null)).toBe('');
      expect(formatCsvAnswer(undefined)).toBe('');
      expect(formatCsvAnswer(true)).toBe('true');
      expect(formatCsvAnswer(false)).toBe('false');
      expect(formatCsvAnswer(0)).toBe('0');
      expect(formatCsvAnswer(-42)).toBe('-42');
      expect(formatCsvAnswer('simple text')).toBe('simple text');
      expect(formatCsvAnswer(['a', 'b', 'c'])).toBe('a; b; c');
      expect(formatCsvAnswer({ originalName: 'test.docx' })).toBe('test.docx');
      expect(formatCsvAnswer({ key: 'files/test.png' })).toBe('test.png');
      expect(formatCsvAnswer({})).toBe('');
      expect(formatCsvAnswer({ a: 1 })).toBe('{"a":1}');
    });

    it('sanitizeCsvCell neutralizes formula characters without corrupting valid numbers', () => {
      expect(sanitizeCsvCell('=1+1')).toBe('\'=1+1');
      expect(sanitizeCsvCell('+cmd')).toBe('\'+cmd');
      expect(sanitizeCsvCell('-2+3')).toBe('\'-2+3');
      expect(sanitizeCsvCell('@SUM(A1)')).toBe('\'@SUM(A1)');
      expect(sanitizeCsvCell('\t=cmd')).toBe('\'\t=cmd');
      expect(sanitizeCsvCell('\r=cmd')).toBe('\'\r=cmd');
      expect(sanitizeCsvCell(' =SUM()')).toBe('\' =SUM()');

      // Valid numbers must NOT be prefixed
      expect(sanitizeCsvCell('-5')).toBe('-5');
      expect(sanitizeCsvCell('-12.34')).toBe('-12.34');
      expect(sanitizeCsvCell('+42')).toBe('+42');
      expect(sanitizeCsvCell('0')).toBe('0');
      expect(sanitizeCsvCell(100)).toBe('100');
      expect(sanitizeCsvCell(-50)).toBe('-50');

      // Regular text
      expect(sanitizeCsvCell('Standard text')).toBe('Standard text');
      expect(sanitizeCsvCell('')).toBe('');
      expect(sanitizeCsvCell(null)).toBe('');
    });

    it('escapeCsvCell correctly doubles embedded quotes and wraps in quotes', () => {
      expect(escapeCsvCell('hello')).toBe('"hello"');
      expect(escapeCsvCell('he said "hi"')).toBe('"he said ""hi"""');
      expect(escapeCsvCell('line 1\nline 2')).toBe('"line 1\nline 2"');
      expect(escapeCsvCell('')).toBe('""');
      expect(escapeCsvCell(null)).toBe('""');
    });
  });

  describe('CSV Export Security and Correctness', () => {
    let ownerToken;
    let nonOwnerToken;
    let exportForm;
    let qQuotes, qCommas, qNewlines, qArray, qFile, qFormula, qNumberVal, qUnexpected;

    beforeEach(async () => {
      const jwt = await import('jsonwebtoken');
      const owner = await User.findOne({ email: 'owner@test.com' });
      ownerToken = jwt.default.sign({ id: owner._id }, process.env.JWT_SECRET);

      const nonOwner = await User.create({
        name: 'Attacker',
        email: `attacker-${Date.now()}@test.com`,
        password: 'password123'
      });
      nonOwnerToken = jwt.default.sign({ id: nonOwner._id }, process.env.JWT_SECRET);

      exportForm = await Form.create({
        ownerId: owner._id,
        title: 'Export Security Survey',
        status: 'published'
      });

      qQuotes = await Question.create({
        formId: exportForm._id,
        type: 'short_text',
        label: 'Quotes Field',
        order: 0
      });
      qCommas = await Question.create({
        formId: exportForm._id,
        type: 'short_text',
        label: 'Commas Field',
        order: 1
      });
      qNewlines = await Question.create({
        formId: exportForm._id,
        type: 'long_text',
        label: 'Newlines Field',
        order: 2
      });
      qArray = await Question.create({
        formId: exportForm._id,
        type: 'multiple_choice',
        label: 'Array Field',
        order: 3
      });
      qFile = await Question.create({
        formId: exportForm._id,
        type: 'file',
        label: 'File Field',
        order: 4
      });
      qFormula = await Question.create({
        formId: exportForm._id,
        type: 'short_text',
        label: 'Formula Field',
        order: 5
      });
      qNumberVal = await Question.create({
        formId: exportForm._id,
        type: 'number',
        label: 'Number Field',
        order: 6
      });
      qUnexpected = await Question.create({
        formId: exportForm._id,
        type: 'short_text',
        label: 'Unexpected Object Field',
        order: 7
      });
    });

    it('enforces authorization for export endpoint', async () => {
      const unauthRes = await request(app).get(`/api/responses/${exportForm._id}/export?format=csv`);
      expect(unauthRes.status).toBe(401);

      const nonOwnerRes = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${nonOwnerToken}`]);
      expect(nonOwnerRes.status).toBe(403);
      expect(nonOwnerRes.body.success).toBe(false);

      const notFoundRes = await request(app)
        .get(`/api/responses/${new mongoose.Types.ObjectId()}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);
      expect(notFoundRes.status).toBe(404);
    });

    it('correctly escapes embedded double quotes by doubling them', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          { questionId: qQuotes._id, value: 'He said "Hello World" and smiled.' }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).toContain('"He said ""Hello World"" and smiled."');
    });

    it('correctly quotes fields containing commas and prevents column misalignment', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          { questionId: qCommas._id, value: 'Item 1, Item 2, and Item 3' }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).toContain('"Item 1, Item 2, and Item 3"');
    });

    it('correctly handles embedded newlines within quoted fields', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          { questionId: qNewlines._id, value: 'Line 1\nLine 2\r\nLine 3' }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).toContain('"Line 1\nLine 2\r\nLine 3"');
    });

    it('handles empty and omitted values with consistent column alignment', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          { questionId: qQuotes._id, value: '' }
          // other questions are omitted/unanswered
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      const lines = res.text.trim().split(/\r?\n/);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(res.text).toContain('""');
    });

    it('formats array answers cleanly joined by semicolons', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          { questionId: qArray._id, value: ['Red', 'Blue "Navy"', 'Green, Forest'] }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).toContain('"Red; Blue ""Navy""; Green, Forest"');
    });

    it('serializes file-upload objects using original filename and never outputs [object Object]', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          {
            questionId: qFile._id,
            value: {
              key: 'uploads/abc/confidential_document.pdf',
              originalName: 'confidential_document.pdf',
              mimeType: 'application/pdf',
              size: 2048576
            }
          }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).toContain('"confidential_document.pdf"');
      expect(res.text).not.toContain('[object Object]');
    });

    it('serializes unexpected nested objects deterministically without crashing or producing [object Object]', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          {
            questionId: qUnexpected._id,
            value: { customMetric: 'test_metric', score: 100 }
          }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).not.toContain('[object Object]');
      expect(res.text).toContain('"{""customMetric"":""test_metric"",""score"":100}"');
    });

    it('sanitizes formula-like values starting with =, +, -, @ to prevent CSV injection while preserving ordinary numbers', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          { questionId: qFormula._id, value: '=SUM(1,2)' },
          { questionId: qQuotes._id, value: '+cmd|\' /C calc\'!A0' },
          { questionId: qCommas._id, value: '-2+3' },
          { questionId: qNewlines._id, value: '@SUM(A1:A10)' },
          { questionId: qNumberVal._id, value: -25 }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).toContain('"\'=SUM(1,2)"');
      expect(res.text).toContain('"\'@SUM(A1:A10)"');
      expect(res.text).toContain('"\' -2+3"'.replace(' ', ''));
      expect(res.text).toContain('"-25"');
      expect(res.text).not.toContain('"\'-25"');
    });

    it('sanitizes values starting with tabs or carriage returns to prevent control-character formula injection', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          { questionId: qFormula._id, value: '\t=1+1' },
          { questionId: qQuotes._id, value: '\r=cmd' },
          { questionId: qCommas._id, value: '  =2+2' }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).toContain('"\'\t=1+1"');
      expect(res.text).toContain('"\'\r=cmd"');
      expect(res.text).toContain('"\'  =2+2"');
    });

    it('produces consistent row and column alignment across all rows', async () => {
      await Response.create([
        {
          formId: exportForm._id,
          answers: [
            { questionId: qQuotes._id, value: 'Row 1 Quotes' },
            { questionId: qFile._id, value: { originalName: 'r1.pdf' } }
          ]
        },
        {
          formId: exportForm._id,
          answers: [
            { questionId: qFormula._id, value: '=1+1' },
            { questionId: qNumberVal._id, value: 42 }
          ]
        }
      ]);

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=csv`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      const rawCsv = res.text;
      const expectedColumnCount = 9;

      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(`responses-${exportForm._id}.csv`);

      const lines = rawCsv.split('\r\n');
      expect(lines.length).toBe(3); // Header + 2 data rows
      lines.forEach((line) => {
        const matches = line.match(/(?:^|,)(?:"(?:[^"]|"")*")/g);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(expectedColumnCount);
      });
    });

    it('still supports JSON export with identical question and response data', async () => {
      await Response.create({
        formId: exportForm._id,
        answers: [
          { questionId: qQuotes._id, value: 'JSON Test' }
        ]
      });

      const res = await request(app)
        .get(`/api/responses/${exportForm._id}/export?format=json`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.form.id).toBe(exportForm._id.toString());
      expect(res.body.data.questions.length).toBe(8);
      expect(res.body.data.responses.length).toBe(1);
    });
  });
});
