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
import responseRoutes, { upload, formatFileSize, getMulterErrorMessage, createMultipartUploadHandler } from '../routes/responseRoutes.js';
import { formatCsvAnswer, sanitizeCsvCell, escapeCsvCell, isQuestionVisible, submitResponse } from './responseController.js';
import { errorHandler } from '../middleware/errorHandler.js';
import storageService from '../services/StorageService.js';
import { Readable } from 'stream';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import os from 'os';
import fs from 'fs';

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

    it('should validate number type strictly and store clean numeric values', async () => {
      // Reject string word
      let res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: 'twenty' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a number');

      // Reject boolean true
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: true }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a number');

      // Reject boolean false
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: false }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a number');

      // Reject array [10]
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: [10] }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a number');

      // Reject Infinity
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: 'Infinity' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a number');

      // Reject empty or whitespace string
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: '   ' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a number');

      // Reject object
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: { val: 42 } }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a number');

      // Accept numeric string and verify saved as Number
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qNumber._id, value: '42.5' }
        ]
      });
      expect(res.status).toBe(201);

      const saved = await Response.findOne({ formId: form._id }).sort({ createdAt: -1 });
      const numberAns = saved.answers.find(a => a.questionId.toString() === qNumber._id.toString());
      expect(numberAns.value).toBe(42.5);
      expect(typeof numberAns.value).toBe('number');
    });

    it('should validate text types and enforce length bounds', async () => {
      // Reject non-string for short_text
      let res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: { malicious: true } },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a text value');

      // Reject boolean for short_text
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: true },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a text value');

      // Reject short_text exceeding 1000 characters
      const longString = 'a'.repeat(1001);
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: longString },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('exceeds maximum length of 1000 characters');

      // Create long_text question and test bound
      const qLong = await Question.create({
        formId: form._id,
        type: 'long_text',
        label: 'Feedback',
        required: false,
        order: 20
      });

      const oversizedLong = 'x'.repeat(20001);
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qLong._id, value: oversizedLong }
        ]
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('exceeds maximum length of 20000 characters');

      // Accept valid long_text
      const validLong = 'x'.repeat(500);
      res = await request(app).post(`/api/responses/${form._id}`).send({
        answers: [
          { questionId: qText._id, value: 'John' },
          { questionId: qEmail._id, value: 'test@test.com' },
          { questionId: qChoice._id, value: 'Blue' },
          { questionId: qLong._id, value: validLong }
        ]
      });
      expect(res.status).toBe(201);
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

  describe('GET /api/responses/:formId/:responseId/file/:questionId (downloadResponseFile)', () => {
    let owner;
    let nonOwner;
    let ownerToken;
    let nonOwnerToken;
    let fileForm;
    let fileQuestion;
    let fileResponse;

    beforeEach(async () => {
      owner = await User.create({
        name: 'File Owner',
        email: `fileowner-${Date.now()}@test.com`,
        password: 'password123'
      });
      ownerToken = jwt.sign({ id: owner._id }, process.env.JWT_SECRET);

      nonOwner = await User.create({
        name: 'Non Owner',
        email: `nonowner-${Date.now()}@test.com`,
        password: 'password123'
      });
      nonOwnerToken = jwt.sign({ id: nonOwner._id }, process.env.JWT_SECRET);

      fileForm = await Form.create({
        ownerId: owner._id,
        title: 'Form with File',
        status: 'published'
      });

      fileQuestion = await Question.create({
        formId: fileForm._id,
        type: 'file',
        label: 'Upload Document',
        required: true,
        order: 0
      });

      fileResponse = await Response.create({
        formId: fileForm._id,
        answers: [
          {
            questionId: fileQuestion._id,
            value: {
              key: `forms/${fileForm._id}/${fileQuestion._id}/sample-doc.pdf`,
              originalName: 'report-2026.pdf',
              mimeType: 'application/pdf',
              size: 20
            }
          }
        ]
      });
    });

    it('successfully streams an authorized file and returns expected headers', async () => {
      const mockStream = Readable.from(['Sample PDF content!']);
      const spy = vi.spyOn(storageService, 'getFileStream').mockResolvedValueOnce({
        stream: mockStream,
        contentType: 'application/pdf',
        contentLength: 19
      });

      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${fileResponse._id}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/attachment;\s*filename="report-2026\.pdf"/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body.toString()).toBe('Sample PDF content!');
      expect(spy).toHaveBeenCalledWith(`forms/${fileForm._id}/${fileQuestion._id}/sample-doc.pdf`);
    });

    it('returns 404 when object is missing in storage (NoSuchKey)', async () => {
      const noKeyErr = new Error('The specified key does not exist.');
      noKeyErr.name = 'NoSuchKey';
      vi.spyOn(storageService, 'getFileStream').mockRejectedValueOnce(noKeyErr);

      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${fileResponse._id}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('File not found in storage');
    });

    it('returns 500 when storage fails unexpectedly before streaming begins', async () => {
      const storageErr = new Error('S3 connection failure');
      vi.spyOn(storageService, 'getFileStream').mockRejectedValueOnce(storageErr);

      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${fileResponse._id}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });

    it('handles stream failure after response headers are sent without unhandled rejection', async () => {
      const faultyStream = new Readable({
        read() {
          this.push('chunk before failure');
          process.nextTick(() => {
            this.destroy(new Error('Mid-stream failure'));
          });
        }
      });

      vi.spyOn(storageService, 'getFileStream').mockResolvedValueOnce({
        stream: faultyStream,
        contentType: 'text/plain',
        contentLength: 50
      });

      // The connection will be aborted when res.destroy() is called
      try {
        await request(app)
          .get(`/api/responses/${fileForm._id}/${fileResponse._id}/file/${fileQuestion._id}`)
          .set('Cookie', [`token=${ownerToken}`]);
      } catch (err) {
        expect(err).toBeDefined();
      }
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${fileResponse._id}/file/${fileQuestion._id}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('rejects non-owner requests with 403', async () => {
      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${fileResponse._id}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${nonOwnerToken}`]);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Not authorized');
    });

    it('rejects request when response does not exist with 404', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${fakeId}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Response not found');
    });

    it('rejects request when question has no file in response with 404', async () => {
      const fakeQId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${fileResponse._id}/file/${fakeQId}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('File not found in response');
    });

    it('sanitizes filenames containing quotes, CRLF, and control characters preventing header injection', async () => {
      const unsafeResponse = await Response.create({
        formId: fileForm._id,
        answers: [
          {
            questionId: fileQuestion._id,
            value: {
              key: `forms/${fileForm._id}/${fileQuestion._id}/unsafe.pdf`,
              originalName: 'evil\r\nSet-Cookie: injected=true\r\n"quoted" file.pdf',
              mimeType: 'application/pdf',
              size: 15
            }
          }
        ]
      });

      const mockStream = Readable.from(['safe content']);
      vi.spyOn(storageService, 'getFileStream').mockResolvedValueOnce({
        stream: mockStream,
        contentType: 'application/pdf',
        contentLength: 12
      });

      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${unsafeResponse._id}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      const disposition = res.headers['content-disposition'];
      expect(disposition).toBeDefined();
      expect(disposition).not.toContain('\r');
      expect(disposition).not.toContain('\n');
      expect(disposition).toContain('attachment;');
    });

    it('strips directory paths from filenames to prevent path traversal in Content-Disposition', async () => {
      const traversalResponse = await Response.create({
        formId: fileForm._id,
        answers: [
          {
            questionId: fileQuestion._id,
            value: {
              key: `forms/${fileForm._id}/${fileQuestion._id}/sample.pdf`,
              originalName: '../../../../etc/passwd',
              mimeType: 'application/pdf',
              size: 20
            }
          }
        ]
      });

      const mockStream = Readable.from(['safe content']);
      vi.spyOn(storageService, 'getFileStream').mockResolvedValueOnce({
        stream: mockStream,
        contentType: 'application/pdf',
        contentLength: 12
      });

      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${traversalResponse._id}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      const disposition = res.headers['content-disposition'];
      expect(disposition).toBeDefined();
      expect(disposition).toContain('filename="passwd"');
      expect(disposition).not.toContain('..');
      expect(disposition).not.toContain('/etc');
    });

    it('strips Windows directory paths from filenames to prevent path traversal', async () => {
      const winTraversalResponse = await Response.create({
        formId: fileForm._id,
        answers: [
          {
            questionId: fileQuestion._id,
            value: {
              key: `forms/${fileForm._id}/${fileQuestion._id}/sample.pdf`,
              originalName: '..\\..\\windows\\system32\\cmd.exe',
              mimeType: 'application/pdf',
              size: 20
            }
          }
        ]
      });

      const mockStream = Readable.from(['safe content']);
      vi.spyOn(storageService, 'getFileStream').mockResolvedValueOnce({
        stream: mockStream,
        contentType: 'application/pdf',
        contentLength: 12
      });

      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${winTraversalResponse._id}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      const disposition = res.headers['content-disposition'];
      expect(disposition).toBeDefined();
      expect(disposition).toContain('filename="cmd.exe"');
      expect(disposition).not.toContain('..');
      expect(disposition).not.toContain('windows');
    });

    it('safely encodes Unicode filenames with RFC 5987 formatting in Content-Disposition', async () => {
      const unicodeResponse = await Response.create({
        formId: fileForm._id,
        answers: [
          {
            questionId: fileQuestion._id,
            value: {
              key: `forms/${fileForm._id}/${fileQuestion._id}/unicode.pdf`,
              originalName: '日本語-2026.pdf',
              mimeType: 'application/pdf',
              size: 25
            }
          }
        ]
      });

      const mockStream = Readable.from(['unicode file content']);
      vi.spyOn(storageService, 'getFileStream').mockResolvedValueOnce({
        stream: mockStream,
        contentType: 'application/pdf',
        contentLength: 20
      });

      const res = await request(app)
        .get(`/api/responses/${fileForm._id}/${unicodeResponse._id}/file/${fileQuestion._id}`)
        .set('Cookie', [`token=${ownerToken}`]);

      expect(res.status).toBe(200);
      const disposition = res.headers['content-disposition'];
      expect(disposition).toBeDefined();
      expect(disposition).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E-2026.pdf");
    });
  });

  describe('Hardening and Boundary Verification: Input Robustness', () => {
    let robustForm;
    let reqText, optText;
    const upload = multer({ dest: os.tmpdir() });
    const hardeningApp = express();
    hardeningApp.use(express.json());
    hardeningApp.post('/api/responses/:formId', upload.any(), submitResponse);
    hardeningApp.use(errorHandler);

    beforeEach(async () => {
      const user = await User.create({
        name: 'Audit Owner',
        email: 'audit-owner@test.com',
        password: 'password123'
      });

      robustForm = await Form.create({ ownerId: user._id, title: 'Hardening Form', status: 'published' });
      reqText = await Question.create({
        formId: robustForm._id,
        type: 'short_text',
        label: 'Required Name',
        required: true,
        order: 0
      });
      optText = await Question.create({
        formId: robustForm._id,
        type: 'short_text',
        label: 'Optional Notes',
        required: false,
        order: 1
      });
    });

    it('rejects answers payload containing non-object items with HTTP 400 instead of crashing', async () => {
      // Test null item
      let res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [null] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test primitive string item
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: ['not-an-object'] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test numeric item
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [123] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test nested array item
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [[{ questionId: reqText._id, value: 'Test' }]] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test empty object missing questionId
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [{}] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test answer item missing questionId
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [{ value: 'no-question-id' }] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test answer item with empty string questionId
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [{ questionId: '   ', value: 'whitespace-id' }] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test answer item with numeric questionId
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [{ questionId: 12345, value: 'numeric-id' }] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test answer item with malformed string questionId
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [{ questionId: 'not-a-valid-id', value: 'bad-id' }] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Test answer item with 12-byte string questionId
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: [{ questionId: '123456789012', value: '12-char-id' }] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Each answer item must be a valid object');

      // Verify no response was saved to the database
      const count = await Response.countDocuments({ formId: robustForm._id });
      expect(count).toBe(0);
    });

    it('rejects duplicate question IDs with HTTP 400 without persisting', async () => {
      // Test duplicate IDs with identical values
      let res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({
          answers: [
            { questionId: reqText._id, value: 'First Value' },
            { questionId: reqText._id, value: 'First Value' }
          ]
        });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Duplicate answers for the same question are not allowed');

      // Test duplicate IDs with different values
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({
          answers: [
            { questionId: reqText._id, value: 'Initial Value' },
            { questionId: reqText._id, value: 'Conflicting Value' }
          ]
        });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Duplicate answers for the same question are not allowed');

      // Test duplicate IDs with mixed ObjectId and string normalization
      res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({
          answers: [
            { questionId: reqText._id, value: 'ObjectId format' },
            { questionId: reqText._id.toString(), value: 'String format' }
          ]
        });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Duplicate answers for the same question are not allowed');

      // Confirm no document was written to the database
      const count = await Response.countDocuments({ formId: robustForm._id });
      expect(count).toBe(0);
    });

    it('rejects payloads exceeding the 500 answer limit with HTTP 400', async () => {
      const hugeAnswers = Array.from({ length: 501 }, () => ({
        questionId: reqText._id.toString(),
        value: 'spam'
      }));

      const res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({ answers: hugeAnswers });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Answers array exceeds maximum limit of 500 items');

      const count = await Response.countDocuments({ formId: robustForm._id });
      expect(count).toBe(0);
    });

    it('rejects whitespace-only submissions for required text questions', async () => {
      const res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({
          answers: [
            { questionId: reqText._id, value: '    ' }
          ]
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Question "Required Name" is required');

      const count = await Response.countDocuments({ formId: robustForm._id });
      expect(count).toBe(0);
    });

    it('accepts whitespace-only submissions for optional text questions without saving blank answers', async () => {
      const res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({
          answers: [
            { questionId: reqText._id, value: 'Valid Name' },
            { questionId: optText._id, value: '   ' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const saved = await Response.findOne({ formId: robustForm._id });
      expect(saved).toBeDefined();
      expect(saved.answers.length).toBe(1);
      expect(saved.answers[0].questionId.toString()).toBe(reqText._id.toString());
      expect(saved.answers[0].value).toBe('Valid Name');
    });

    it('rejects foreign question IDs with HTTP 400 and prevents partial persistence', async () => {
      const foreignId = new mongoose.Types.ObjectId().toString();
      const res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({
          answers: [
            { questionId: reqText._id, value: 'Legitimate Answer' },
            { questionId: foreignId, value: 'Foreign Question Value' }
          ]
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Question does not belong to this form');

      // Ensure no response is partially persisted
      const count = await Response.countDocuments({ formId: robustForm._id });
      expect(count).toBe(0);
    });

    it('rejects foreign-question submissions without initiating file uploads or creating documents', async () => {
      const fileQuestion = await Question.create({
        formId: robustForm._id,
        type: 'file',
        label: 'Upload Document',
        required: false,
        order: 2
      });

      const uploadSpy = vi.spyOn(storageService, 'uploadFile');
      const foreignId = new mongoose.Types.ObjectId().toString();

      const res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .field('answers', JSON.stringify([
          { questionId: reqText._id, value: 'Valid Name' },
          { questionId: foreignId, value: 'Foreign Value' }
        ]))
        .attach(`file_${fileQuestion._id.toString()}`, Buffer.from('%PDF-1.4\n%EOF\n'), {
          filename: 'valid.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Question does not belong to this form');

      // Verify storageService.uploadFile was never initiated
      expect(uploadSpy).not.toHaveBeenCalled();

      // Verify no response was saved
      const count = await Response.countDocuments({ formId: robustForm._id });
      expect(count).toBe(0);

      uploadSpy.mockRestore();
    });

    it('cleans up temporary files from disk when validation fails', async () => {
      const fileQuestion = await Question.create({
        formId: robustForm._id,
        type: 'file',
        label: 'Upload Document',
        required: false,
        order: 2
      });

      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const foreignId = new mongoose.Types.ObjectId().toString();

      try {
        const res = await request(hardeningApp)
          .post(`/api/responses/${robustForm._id}`)
          .field('answers', JSON.stringify([
            { questionId: reqText._id, value: 'Valid Name' },
            { questionId: foreignId, value: 'Foreign Value' }
          ]))
          .attach(`file_${fileQuestion._id.toString()}`, Buffer.from('%PDF-1.4\n%EOF\n'), {
            filename: 'test-cleanup.pdf',
            contentType: 'application/pdf'
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);

        // Verify fs.unlinkSync was called for the uploaded temporary file
        expect(unlinkSpy).toHaveBeenCalled();
        const unlinkedPath = unlinkSpy.mock.calls[0][0];
        expect(typeof unlinkedPath).toBe('string');
        expect(fs.existsSync(unlinkedPath)).toBe(false);
      } finally {
        unlinkSpy.mockRestore();
      }
    });

    it('allows valid submissions containing only matching form questions to succeed', async () => {
      const res = await request(hardeningApp)
        .post(`/api/responses/${robustForm._id}`)
        .send({
          answers: [
            { questionId: reqText._id, value: 'Legitimate Name' },
            { questionId: optText._id, value: 'Legitimate Notes' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const saved = await Response.findOne({ formId: robustForm._id });
      expect(saved).toBeDefined();
      expect(saved.answers.length).toBe(2);
      expect(saved.answers[0].questionId.toString()).toBe(reqText._id.toString());
      expect(saved.answers[0].value).toBe('Legitimate Name');
      expect(saved.answers[1].questionId.toString()).toBe(optText._id.toString());
      expect(saved.answers[1].value).toBe('Legitimate Notes');
    });

    it('isQuestionVisible unit evaluation handles malformed inputs safely without throwing', () => {
      const targetQId = new mongoose.Types.ObjectId().toString();
      const ruleQuestion = {
        visibilityRule: {
          targetQuestionId: targetQId,
          operator: 'equals',
          value: 'show_it'
        }
      };

      // Non-array answers
      expect(isQuestionVisible(ruleQuestion, null)).toBe(false);
      expect(isQuestionVisible(ruleQuestion, undefined)).toBe(false);
      expect(isQuestionVisible(ruleQuestion, 'not-an-array')).toBe(false);

      // Answers array containing null, undefined, primitive, or malformed elements
      expect(isQuestionVisible(ruleQuestion, [null, undefined, 42, 'string', {}])).toBe(false);

      // Answers array containing valid matching entry
      expect(
        isQuestionVisible(ruleQuestion, [
          null,
          { questionId: targetQId, value: 'show_it' }
        ])
      ).toBe(true);

      // Question without rule or with empty rule
      expect(isQuestionVisible({}, [])).toBe(true);
      expect(isQuestionVisible(null, [])).toBe(true);
      expect(isQuestionVisible({ visibilityRule: {} }, [])).toBe(true);
      expect(isQuestionVisible({ visibilityRule: { targetQuestionId: null } }, [])).toBe(true);

      // Visibility rule operators
      const notEqualQuestion = {
        visibilityRule: {
          targetQuestionId: targetQId,
          operator: 'not_equals',
          value: 'hide_me'
        }
      };
      expect(isQuestionVisible(notEqualQuestion, [{ questionId: targetQId, value: 'other' }])).toBe(true);
      expect(isQuestionVisible(notEqualQuestion, [{ questionId: targetQId, value: 'hide_me' }])).toBe(false);

      const containsQuestion = {
        visibilityRule: {
          targetQuestionId: targetQId,
          operator: 'contains',
          value: 'apple'
        }
      };
      expect(isQuestionVisible(containsQuestion, [{ questionId: targetQId, value: ['orange', 'apple'] }])).toBe(true);
      expect(isQuestionVisible(containsQuestion, [{ questionId: targetQId, value: 'pineapple' }])).toBe(true);
      expect(isQuestionVisible(containsQuestion, [{ questionId: targetQId, value: 'banana' }])).toBe(false);
    });
  });

  describe('SEC-03: Multipart Ingestion Boundaries and Multer Ingestion Limits', () => {
    let multipartForm;
    let fileQ;

    beforeEach(async () => {
      const user = await User.create({
        name: 'Multipart Test Owner',
        email: `owner_${Date.now()}@test.com`,
        password: 'password123'
      });

      multipartForm = await Form.create({
        ownerId: user._id,
        title: 'Multipart Boundary Test Form',
        status: 'published'
      });

      fileQ = await Question.create({
        formId: multipartForm._id,
        type: 'file',
        label: 'Upload Document',
        required: false,
        order: 0
      });
    });

    it('rejects multipart request exceeding files limit (> 10 files) with 400 and cleans up temporary files', async () => {
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

      try {
        let reqBuilder = request(app)
          .post(`/api/responses/${multipartForm._id}`)
          .field('answers', JSON.stringify([]));

        // Attach 11 files (limit is 10)
        for (let i = 1; i <= 11; i++) {
          reqBuilder = reqBuilder.attach(`file_attachment_${i}`, Buffer.from(`file content ${i}`), {
            filename: `document_${i}.txt`,
            contentType: 'text/plain'
          });
        }

        const res = await reqBuilder;

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('Too many files uploaded');

        // Verify no response was created in database
        const savedResponses = await Response.find({ formId: multipartForm._id });
        expect(savedResponses.length).toBe(0);
      } finally {
        unlinkSpy.mockRestore();
      }
    });

    it('rejects multipart request exceeding fields limit (> 50 fields) with 400', async () => {
      let reqBuilder = request(app)
        .post(`/api/responses/${multipartForm._id}`);

      // Add 52 fields (limit is 50)
      for (let i = 1; i <= 52; i++) {
        reqBuilder = reqBuilder.field(`extra_field_${i}`, `value_${i}`);
      }

      const res = await reqBuilder;

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Too many form fields');

      // Verify no response was created in database
      const savedResponses = await Response.find({ formId: multipartForm._id });
      expect(savedResponses.length).toBe(0);
    });

    it('accepts legitimate multipart request with valid file within configured limits', async () => {
      const validPdfBuffer = Buffer.from('%PDF-1.4\n%EOF\n');
      const res = await request(app)
        .post(`/api/responses/${multipartForm._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${fileQ._id.toString()}`, validPdfBuffer, {
          filename: 'valid_attachment.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const savedResponses = await Response.find({ formId: multipartForm._id });
      expect(savedResponses.length).toBe(1);
    });

    it('rejects file exceeding 5MB limit with 400 Bad Request', async () => {
      // 6MB buffer
      const largeBuffer = Buffer.alloc(6 * 1024 * 1024, 0x61);

      const res = await request(app)
        .post(`/api/responses/${multipartForm._id}`)
        .field('answers', JSON.stringify([]))
        .attach(`file_${fileQ._id.toString()}`, largeBuffer, {
          filename: 'oversized.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('File size exceeds maximum limit');

      const savedResponses = await Response.find({ formId: multipartForm._id });
      expect(savedResponses.length).toBe(0);
    });

    it('sanitizes malformed non-Multer client upload errors with generic 400 response without leaking internal details', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        // Send a malformed multipart stream with broken boundary data
        const res = await request(app)
          .post(`/api/responses/${multipartForm._id}`)
          .set('Content-Type', 'multipart/form-data; boundary=test_boundary')
          .send('--test_boundary\r\nContent-Disposition: form-data; name="answers"\r\n\r\nincomplete_data');

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('Invalid upload request');
        // Ensure raw parser errors or internal details are not exposed
        expect(res.body.message).not.toContain('Unexpected end');
        expect(res.body.stack).toBeUndefined();

        const savedResponses = await Response.find({ formId: multipartForm._id });
        expect(savedResponses.length).toBe(0);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('routes unexpected internal upload failures to centralized error handler without swallowing as 400', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const originalAny = upload.any;

      try {
        // Simulate unexpected internal server error during upload (e.g. filesystem permission failure)
        upload.any = vi.fn().mockReturnValue((req, res, cb) => {
          cb(new Error('EACCES: permission denied, open /var/run/secrets/paperless/temp_file'));
        });

        const res = await request(app)
          .post(`/api/responses/${multipartForm._id}`)
          .field('answers', JSON.stringify([]));

        // Must NOT be swallowed as client 400 error; centralized handler returns 500
        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);

        const savedResponses = await Response.find({ formId: multipartForm._id });
        expect(savedResponses.length).toBe(0);
      } finally {
        upload.any = originalAny;
        consoleSpy.mockRestore();
      }
    });

    it('accurately formats file sizes including fractional MiB values without misleading down-rounding', () => {
      expect(formatFileSize(5 * 1024 * 1024)).toBe('5MB');
      expect(formatFileSize(10 * 1024 * 1024)).toBe('10MB');
      expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5MB');
      expect(formatFileSize(512 * 1024)).toBe('512KB');
      expect(formatFileSize(10000000)).toBe('9.54MB');
      expect(formatFileSize(500)).toBe('500 bytes');
      expect(formatFileSize(0)).toBe('5MB');
      expect(formatFileSize(-10)).toBe('5MB');
      expect(formatFileSize('invalid')).toBe('5MB');
    });

    it('generates consistent client error messages for all Multer limit error codes', () => {
      expect(getMulterErrorMessage({ code: 'LIMIT_FILE_SIZE' }, { fileSize: 5242880 })).toBe('File size exceeds maximum limit of 5MB');
      expect(getMulterErrorMessage({ code: 'LIMIT_FILE_COUNT' }, { files: 10 })).toBe('Too many files uploaded (maximum 10 allowed)');
      expect(getMulterErrorMessage({ code: 'LIMIT_FIELD_COUNT' }, { fields: 50 })).toBe('Too many form fields (maximum 50 allowed)');
      expect(getMulterErrorMessage({ code: 'LIMIT_PART_COUNT' }, { parts: 60 })).toBe('Too many multipart parts (maximum 60 allowed)');
      expect(getMulterErrorMessage({ code: 'LIMIT_UNEXPECTED_FILE' })).toBe('Unexpected file field');
      expect(getMulterErrorMessage({ code: 'UNKNOWN_CODE' })).toBe('File upload error');
    });

    it('rejects genuine multipart request exceeding configured parts limit with 400 and cleans up temporary files', async () => {
      const unlinkSpy = vi.spyOn(fs, 'unlink');

      try {
        // Instantiate an isolated Multer instance with parts: 20 to avoid mutating the shared singleton
        const isolatedUpload = multer({
          dest: os.tmpdir(),
          limits: {
            ...upload.limits,
            parts: 20
          }
        });
        const isolatedHandler = createMultipartUploadHandler(isolatedUpload);

        const testApp = express();
        testApp.use(express.json());
        testApp.use(cookieParser());
        testApp.post('/api/responses/:formId', isolatedHandler, submitResponse);
        testApp.use(errorHandler);

        let reqBuilder = request(testApp)
          .post(`/api/responses/${multipartForm._id}`);

        // Attach 5 small files (well within files: 10 limit)
        for (let i = 1; i <= 5; i++) {
          reqBuilder = reqBuilder.attach(`file_${i}`, Buffer.from(`content ${i}`), {
            filename: `doc_${i}.txt`,
            contentType: 'text/plain'
          });
        }

        // Add 16 text fields (well within fields: 50 limit)
        // Total parts = 5 + 16 = 21 (exceeds parts: 20 limit)
        for (let j = 1; j <= 16; j++) {
          reqBuilder = reqBuilder.field(`field_${j}`, `value_${j}`);
        }

        const res = await reqBuilder;

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('Too many multipart parts (maximum 20 allowed)');

        // Verify no response was saved to database
        const savedResponses = await Response.find({ formId: multipartForm._id });
        expect(savedResponses.length).toBe(0);

        // Verify temporary files cleanup occurred via Multer disk storage
        expect(unlinkSpy).toHaveBeenCalled();
      } finally {
        unlinkSpy.mockRestore();
      }
    });
  });
});
