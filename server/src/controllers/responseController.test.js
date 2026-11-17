import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
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
import responseRoutes, {
  upload,
  formatFileSize,
  getMulterErrorMessage,
  createMultipartUploadHandler,
  getSubmissionRateLimitKey,
  getAuthenticatedFormRateLimitKey,
  analyticsLimiter,
  exportLimiter,
  getUserRateLimitKey,
  userAnalyticsLimiter,
  userExportLimiter,
  responseDeletionLimiter,
  preValidateSubmissionForm,
  userResponseReadLimiter,
  userFileDownloadLimiter
} from '../routes/responseRoutes.js';
import {
  formatCsvAnswer,
  sanitizeCsvCell,
  escapeCsvCell,
  escapeHtml,
  isQuestionVisible,
  submitResponse,
  exportResponses,
  downloadResponseFile
} from './responseController.js';
import { errorHandler } from '../middleware/errorHandler.js';
import storageService from '../services/StorageService.js';
import EmailService from '../services/EmailService.js';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

const crc32 = (buf) => {
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
};

const createZipBuffer = (files) => {
  const localHeaders = [];
  const cdHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.from(file.data || '', 'utf8');
    const crc = crc32(dataBuf);

    // Local Header
    const lh = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBuf.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);
    dataBuf.copy(lh, 30 + nameBuf.length);
    localHeaders.push(lh);

    // Central Directory Header
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    cdHeaders.push(cd);

    offset += lh.length;
  }

  const cdBuf = Buffer.concat(cdHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
};

let mongoServer;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/responses', responseRoutes);
app.use(errorHandler);

beforeAll(async () => {
  mongoServer = await startReplSet();
  process.env.JWT_SECRET = 'testsecret';
});

afterAll(async () => {
  await stopReplSet(mongoServer);
});

describe('Response Controller - Phase 2', () => {
  let form;
  let qText, qNumber, qEmail, qChoice;

  beforeEach(async () => {
    await User.deleteMany({});
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});

    const user = await User.create({
      name: 'Owner',
      email: 'owner@test.com',
      password: 'password123'
    });

    form = await Form.create({ ownerId: user._id, title: 'Survey', status: 'published' });

    qText = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Name',
      required: true,
      order: 0
    });
    qNumber = await Question.create({
      formId: form._id,
      type: 'number',
      label: 'Age',
      required: false,
      order: 1
    });
    qEmail = await Question.create({
      formId: form._id,
      type: 'email',
      label: 'Email',
      required: true,
      order: 2
    });
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
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      let res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' },
            { questionId: qNumber._id, value: '42.5' }
          ]
        });
      expect(res.status).toBe(201);

      const saved = await Response.findOne({ formId: form._id }).sort({ createdAt: -1 });
      const numberAns = saved.answers.find(
        (a) => a.questionId.toString() === qNumber._id.toString()
      );
      expect(numberAns.value).toBe(42.5);
      expect(typeof numberAns.value).toBe('number');
    });

    it('should validate text types and enforce length bounds', async () => {
      // Reject non-string for short_text
      let res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id, value: { malicious: true } },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ]
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('must be a text value');

      // Reject boolean for short_text
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resBadType = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resLow = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resHigh = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resFloat = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resBool = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' },
            { questionId: qRating._id, value: true }
          ]
        });
      expect(resBool.status).toBe(400);
      expect(resBool.body.message).toContain('must be a rating between 1 and 5');

      const resArr = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resValid = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' },
            { questionId: qRating._id, value: '5' }
          ]
        });
      expect(resValid.status).toBe(201);

      const saved = await Response.findOne({ formId: form._id }).sort({ createdAt: -1 });
      const ratingAns = saved.answers.find(
        (a) => a.questionId.toString() === qRating._id.toString()
      );
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
      const resBad = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resFeb31 = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resApr31 = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resNonLeap = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const res1900 = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resLeap = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' },
            { questionId: qDate._id, value: '2024-02-29' }
          ]
        });
      expect(resLeap.status).toBe(201);

      // Accept valid YYYY-MM-DD date
      const resValid = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' },
            { questionId: qDate._id, value: '2026-10-29' }
          ]
        });
      expect(resValid.status).toBe(201);

      const saved = await Response.findOne({ formId: form._id }).sort({ createdAt: -1 });
      const dateAns = saved.answers.find((a) => a.questionId.toString() === qDate._id.toString());
      expect(dateAns.value).toBe('2026-10-29');

      // Reject missing required date
      const resMissingReq = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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

      const resOptOmitted = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resNotArray = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resBadOpt = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resValid = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resHidden = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' },
            { questionId: qRating._id, value: 4 }
          ]
        });
      expect(resHidden.status).toBe(201);

      // Rating is 5: qFeedback is visible and required, so submission fails if omitted
      const resVisibleMissing = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      const resVisibleSuccess = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
      qFile = await Question.create({
        formId: form._id,
        type: 'file',
        label: 'Resume',
        required: true,
        order: 5
      });
    });

    it('should reject missing required file', async () => {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
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
        .field(
          'answers',
          JSON.stringify([
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ])
        )
        .attach(`file_${qFile._id.toString()}`, Buffer.from('%PDF-1.4\n%EOF\n'), {
          filename: 'resume.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(201);

      const response = await Response.findOne({ formId: form._id });
      const fileAnswer = response.answers.find(
        (a) => a.questionId.toString() === qFile._id.toString()
      );

      expect(fileAnswer).toBeDefined();
      expect(fileAnswer.value.mimeType).toBe('application/pdf');
      expect(fileAnswer.value.originalName).toBe('resume.pdf');
      expect(fileAnswer.value.key).toContain('forms/');
    });

    it('should reject unsupported file type', async () => {
      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field(
          'answers',
          JSON.stringify([
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ])
        )
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
        .field(
          'answers',
          JSON.stringify([
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ])
        )
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
        .field(
          'answers',
          JSON.stringify([
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ])
        )
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
      const createSpy = vi
        .spyOn(Response, 'create')
        .mockRejectedValueOnce(new Error('Simulated DB Failure'));

      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field(
          'answers',
          JSON.stringify([
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ])
        )
        .attach(`file_${qFile._id.toString()}`, Buffer.from('%PDF-1.4\n'), {
          filename: 'valid.pdf',
          contentType: 'application/pdf'
        });

      expect(res.status).toBe(500);
      expect(deleteSpy).toHaveBeenCalled();

      createSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    it('should accept genuine DOCX file upload and persist canonical MIME type', async () => {
      const validDocx = createZipBuffer([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: '<w:document/>' }
      ]);

      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field(
          'answers',
          JSON.stringify([
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ])
        )
        .attach(`file_${qFile._id.toString()}`, validDocx, {
          filename: 'valid.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });

      expect(res.status).toBe(201);
      const response = await Response.findOne({ formId: form._id });
      const fileAnswer = response.answers.find(
        (a) => a.questionId.toString() === qFile._id.toString()
      );
      expect(fileAnswer).toBeDefined();
      expect(fileAnswer.value.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      expect(fileAnswer.value.originalName).toBe('valid.docx');
    });

    it('should reject arbitrary ZIP archive disguised as DOCX', async () => {
      const arbitraryZip = createZipBuffer([{ name: 'random.txt', data: 'not a docx' }]);

      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field(
          'answers',
          JSON.stringify([
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ])
        )
        .attach(`file_${qFile._id.toString()}`, arbitraryZip, {
          filename: 'fake.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('content does not match allowed types');
    });

    it('should reject DOCX archive containing prohibited executable payload', async () => {
      const maliciousDocx = createZipBuffer([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: '<w:document/>' },
        { name: 'malware.exe', data: 'MZ...' }
      ]);

      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .field(
          'answers',
          JSON.stringify([
            { questionId: qText._id, value: 'John' },
            { questionId: qEmail._id, value: 'test@test.com' },
            { questionId: qChoice._id, value: 'Blue' }
          ])
        )
        .attach(`file_${qFile._id.toString()}`, maliciousDocx, {
          filename: 'malicious.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('content does not match allowed types');
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

      const choiceAnalytics = data.analytics.find((a) => a.type === 'single_choice');
      expect(choiceAnalytics.data.distribution.find((d) => d.option === 'Blue').count).toBe(2);
      expect(choiceAnalytics.data.distribution.find((d) => d.option === 'Red').count).toBe(1);

      const numberAnalytics = data.analytics.find((a) => a.type === 'number');
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

      const ratingAnalytics = data.analytics.find((a) => a.type === 'rating');
      expect(ratingAnalytics).toBeDefined();
      expect(ratingAnalytics.data.type).toBe('rating');
      expect(ratingAnalytics.data.average).toBe(4.7);
      expect(ratingAnalytics.data.distribution['5']).toBe(2);
      expect(ratingAnalytics.data.distribution['4']).toBe(1);
      expect(ratingAnalytics.data.distribution['1']).toBe(0);

      const checkAnalytics = data.analytics.find((a) => a.type === 'checkbox');
      expect(checkAnalytics).toBeDefined();
      expect(checkAnalytics.data.type).toBe('options');
      expect(checkAnalytics.data.distribution.find((d) => d.option === 'Coding').count).toBe(2);
      expect(checkAnalytics.data.distribution.find((d) => d.option === 'Design').count).toBe(2);
      expect(checkAnalytics.data.distribution.find((d) => d.option === 'Music').count).toBe(1);
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
      const ratingAnalytics = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qRatingEmpty._id.toString()
      );
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
      expect(sanitizeCsvCell('=1+1')).toBe("'=1+1");
      expect(sanitizeCsvCell('+cmd')).toBe("'+cmd");
      expect(sanitizeCsvCell('-2+3')).toBe("'-2+3");
      expect(sanitizeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
      expect(sanitizeCsvCell('\t=cmd')).toBe("'\t=cmd");
      expect(sanitizeCsvCell('\r=cmd')).toBe("'\r=cmd");
      expect(sanitizeCsvCell(' =SUM()')).toBe("' =SUM()");

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
      const unauthRes = await request(app).get(
        `/api/responses/${exportForm._id}/export?format=csv`
      );
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
        answers: [{ questionId: qQuotes._id, value: 'He said "Hello World" and smiled.' }]
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
        answers: [{ questionId: qCommas._id, value: 'Item 1, Item 2, and Item 3' }]
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
        answers: [{ questionId: qNewlines._id, value: 'Line 1\nLine 2\r\nLine 3' }]
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
        answers: [{ questionId: qArray._id, value: ['Red', 'Blue "Navy"', 'Green, Forest'] }]
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
          { questionId: qQuotes._id, value: "+cmd|' /C calc'!A0" },
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
        answers: [{ questionId: qQuotes._id, value: 'JSON Test' }]
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
      expect(res.headers['content-disposition']).toMatch(
        /attachment;\s*filename="report-2026\.pdf"/
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body.toString()).toBe('Sample PDF content!');
      expect(spy).toHaveBeenCalledWith(
        `forms/${fileForm._id}/${fileQuestion._id}/sample-doc.pdf`,
        expect.anything()
      );
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
      const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

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

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'storage.stream_transmission_failed',
        expect.any(Error),
        expect.objectContaining({
          responseId: fileResponse._id.toString(),
          formId: fileForm._id.toString(),
          questionId: fileQuestion._id.toString()
        })
      );
      loggerErrorSpy.mockRestore();
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).get(
        `/api/responses/${fileForm._id}/${fileResponse._id}/file/${fileQuestion._id}`
      );

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

    describe('P44-SEC-02: Storage Key Boundary & Namespace Classification', () => {
      it('blocks download of foreign-form storage key with 404 and does not call storageService', async () => {
        const foreignFormId = new mongoose.Types.ObjectId();
        const foreignResponse = await Response.create({
          formId: fileForm._id,
          answers: [
            {
              questionId: fileQuestion._id,
              value: {
                key: `forms/${foreignFormId}/${fileQuestion._id}/secret.pdf`,
                originalName: 'secret.pdf',
                mimeType: 'application/pdf',
                size: 25
              }
            }
          ]
        });

        const getStreamSpy = vi.spyOn(storageService, 'getFileStream');
        const warnSpy = vi.spyOn(logger, 'warn');

        const res = await request(app)
          .get(`/api/responses/${fileForm._id}/${foreignResponse._id}/file/${fileQuestion._id}`)
          .set('Cookie', [`token=${ownerToken}`]);

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe('File not found in response');
        expect(getStreamSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          'storage.download_unsafe_key_blocked',
          expect.objectContaining({
            category: 'B',
            formId: fileForm._id.toString()
          })
        );

        getStreamSpy.mockRestore();
        warnSpy.mockRestore();
      });

      it('blocks download of foreign staging storage key with 404', async () => {
        const foreignFormId = new mongoose.Types.ObjectId();
        const foreignStagingResponse = await Response.create({
          formId: fileForm._id,
          answers: [
            {
              questionId: fileQuestion._id,
              value: {
                key: `staging/forms/${foreignFormId}/lease-1/secret.pdf`,
                originalName: 'secret.pdf',
                mimeType: 'application/pdf',
                size: 25
              }
            }
          ]
        });

        const getStreamSpy = vi.spyOn(storageService, 'getFileStream');

        const res = await request(app)
          .get(`/api/responses/${fileForm._id}/${foreignStagingResponse._id}/file/${fileQuestion._id}`)
          .set('Cookie', [`token=${ownerToken}`]);

        expect(res.status).toBe(404);
        expect(res.body.message).toBe('File not found in response');
        expect(getStreamSpy).not.toHaveBeenCalled();
        getStreamSpy.mockRestore();
      });

      it('blocks path traversal storage key with 404 and does not invoke storage', async () => {
        const traversalKeyResponse = await Response.create({
          formId: fileForm._id,
          answers: [
            {
              questionId: fileQuestion._id,
              value: {
                key: `forms/${fileForm._id}/../../etc/passwd`,
                originalName: 'passwd',
                mimeType: 'text/plain',
                size: 25
              }
            }
          ]
        });

        const getStreamSpy = vi.spyOn(storageService, 'getFileStream');

        const res = await request(app)
          .get(`/api/responses/${fileForm._id}/${traversalKeyResponse._id}/file/${fileQuestion._id}`)
          .set('Cookie', [`token=${ownerToken}`]);

        expect(res.status).toBe(404);
        expect(res.body.message).toBe('File not found in response');
        expect(getStreamSpy).not.toHaveBeenCalled();
        getStreamSpy.mockRestore();
      });

      it('blocks external URI storage keys with 404', async () => {
        const uriResponse = await Response.create({
          formId: fileForm._id,
          answers: [
            {
              questionId: fileQuestion._id,
              value: {
                key: 'https://evil.example.com/malware.exe',
                originalName: 'malware.exe',
                mimeType: 'application/octet-stream',
                size: 100
              }
            }
          ]
        });

        const getStreamSpy = vi.spyOn(storageService, 'getFileStream');

        const res = await request(app)
          .get(`/api/responses/${fileForm._id}/${uriResponse._id}/file/${fileQuestion._id}`)
          .set('Cookie', [`token=${ownerToken}`]);

        expect(res.status).toBe(404);
        expect(res.body.message).toBe('File not found in response');
        expect(getStreamSpy).not.toHaveBeenCalled();
        getStreamSpy.mockRestore();
      });

      it('blocks arbitrary bucket / Category C keys outside form namespace with 404', async () => {
        const categoryCResponse = await Response.create({
          formId: fileForm._id,
          answers: [
            {
              questionId: fileQuestion._id,
              value: {
                key: 'backups/mongo-backup.tar.gz',
                originalName: 'mongo-backup.tar.gz',
                mimeType: 'application/gzip',
                size: 1024
              }
            }
          ]
        });

        const getStreamSpy = vi.spyOn(storageService, 'getFileStream');

        const res = await request(app)
          .get(`/api/responses/${fileForm._id}/${categoryCResponse._id}/file/${fileQuestion._id}`)
          .set('Cookie', [`token=${ownerToken}`]);

        expect(res.status).toBe(404);
        expect(res.body.message).toBe('File not found in response');
        expect(getStreamSpy).not.toHaveBeenCalled();
        getStreamSpy.mockRestore();
      });

      it('blocks malformed namespace subpath with double slash with 404', async () => {
        const malformedResponse = await Response.create({
          formId: fileForm._id,
          answers: [
            {
              questionId: fileQuestion._id,
              value: {
                key: `forms/${fileForm._id}//double-slash.pdf`,
                originalName: 'double-slash.pdf',
                mimeType: 'application/pdf',
                size: 50
              }
            }
          ]
        });

        const getStreamSpy = vi.spyOn(storageService, 'getFileStream');

        const res = await request(app)
          .get(`/api/responses/${fileForm._id}/${malformedResponse._id}/file/${fileQuestion._id}`)
          .set('Cookie', [`token=${ownerToken}`]);

        expect(res.status).toBe(404);
        expect(res.body.message).toBe('File not found in response');
        expect(getStreamSpy).not.toHaveBeenCalled();
        getStreamSpy.mockRestore();
      });
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

      robustForm = await Form.create({
        ownerId: user._id,
        title: 'Hardening Form',
        status: 'published'
      });
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
          answers: [{ questionId: reqText._id, value: '    ' }]
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
        .field(
          'answers',
          JSON.stringify([
            { questionId: reqText._id, value: 'Valid Name' },
            { questionId: foreignId, value: 'Foreign Value' }
          ])
        )
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
          .field(
            'answers',
            JSON.stringify([
              { questionId: reqText._id, value: 'Valid Name' },
              { questionId: foreignId, value: 'Foreign Value' }
            ])
          )
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
        isQuestionVisible(ruleQuestion, [null, { questionId: targetQId, value: 'show_it' }])
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
      expect(isQuestionVisible(notEqualQuestion, [{ questionId: targetQId, value: 'other' }])).toBe(
        true
      );
      expect(
        isQuestionVisible(notEqualQuestion, [{ questionId: targetQId, value: 'hide_me' }])
      ).toBe(false);

      const containsQuestion = {
        visibilityRule: {
          targetQuestionId: targetQId,
          operator: 'contains',
          value: 'apple'
        }
      };
      expect(
        isQuestionVisible(containsQuestion, [{ questionId: targetQId, value: ['orange', 'apple'] }])
      ).toBe(true);
      expect(
        isQuestionVisible(containsQuestion, [{ questionId: targetQId, value: 'pineapple' }])
      ).toBe(true);
      expect(
        isQuestionVisible(containsQuestion, [{ questionId: targetQId, value: 'banana' }])
      ).toBe(false);
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
      let reqBuilder = request(app).post(`/api/responses/${multipartForm._id}`);

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
          .send(
            '--test_boundary\r\nContent-Disposition: form-data; name="answers"\r\n\r\nincomplete_data'
          );

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
      expect(getMulterErrorMessage({ code: 'LIMIT_FILE_SIZE' }, { fileSize: 5242880 })).toBe(
        'File size exceeds maximum limit of 5MB'
      );
      expect(getMulterErrorMessage({ code: 'LIMIT_FILE_COUNT' }, { files: 10 })).toBe(
        'Too many files uploaded (maximum 10 allowed)'
      );
      expect(getMulterErrorMessage({ code: 'LIMIT_FIELD_COUNT' }, { fields: 50 })).toBe(
        'Too many form fields (maximum 50 allowed)'
      );
      expect(getMulterErrorMessage({ code: 'LIMIT_PART_COUNT' }, { parts: 60 })).toBe(
        'Too many multipart parts (maximum 60 allowed)'
      );
      expect(getMulterErrorMessage({ code: 'LIMIT_UNEXPECTED_FILE' })).toBe(
        'Unexpected file field'
      );
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

        let reqBuilder = request(testApp).post(`/api/responses/${multipartForm._id}`);

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

  describe('Cleanup Hardening: Temporary File Cleanup in submitResponse finally Block', () => {
    let testOwner;
    let testForm;
    let testTextQuestion;
    let singleUploadApp;
    const singleUpload = multer({ dest: os.tmpdir() });

    beforeEach(async () => {
      testOwner = await User.create({
        name: 'Cleanup Owner',
        email: `cleanup_owner_${Date.now()}_${Math.random().toString(36).substring(7)}@test.com`,
        password: 'password123'
      });

      testForm = await Form.create({
        ownerId: testOwner._id,
        title: 'Cleanup Hardening Form',
        status: 'published'
      });

      testTextQuestion = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Participant Name',
        required: true,
        order: 0
      });

      singleUploadApp = express();
      singleUploadApp.use(express.json());
      singleUploadApp.post(
        '/api/responses/:formId/single',
        singleUpload.single('attachment'),
        submitResponse
      );
      singleUploadApp.use(errorHandler);
    });

    describe('Unit Tests: req.file single file object cleanup', () => {
      it('cleans up temporary file (req.file) on successful submission', async () => {
        const tmpFile = path.join(
          os.tmpdir(),
          `test-file-success-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`
        );
        fs.writeFileSync(tmpFile, 'temporary success file content');
        expect(fs.existsSync(tmpFile)).toBe(true);

        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

        const req = {
          params: { formId: testForm._id.toString() },
          body: {
            answers: [{ questionId: testTextQuestion._id.toString(), value: 'Alice' }]
          },
          file: {
            fieldname: 'attachment',
            originalname: 'alice.txt',
            path: tmpFile,
            size: 30,
            mimetype: 'text/plain'
          },
          ip: '127.0.0.1'
        };

        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis()
        };
        const next = vi.fn();

        try {
          await submitResponse(req, res, next);

          expect(res.status).toHaveBeenCalledWith(201);
          expect(unlinkSpy).toHaveBeenCalledWith(tmpFile);
          expect(fs.existsSync(tmpFile)).toBe(false);
        } finally {
          unlinkSpy.mockRestore();
          if (fs.existsSync(tmpFile)) {
            fs.unlinkSync(tmpFile);
          }
        }
      });

      it('cleans up temporary file (req.file) when validation fails with 400', async () => {
        const tmpFile = path.join(
          os.tmpdir(),
          `test-file-fail-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`
        );
        fs.writeFileSync(tmpFile, 'temporary failure file content');
        expect(fs.existsSync(tmpFile)).toBe(true);

        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

        const req = {
          params: { formId: testForm._id.toString() },
          body: {
            answers: [] // Missing required field Participant Name
          },
          file: {
            fieldname: 'attachment',
            originalname: 'fail.txt',
            path: tmpFile,
            size: 30,
            mimetype: 'text/plain'
          },
          ip: '127.0.0.1'
        };

        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis()
        };
        const next = vi.fn();

        try {
          await submitResponse(req, res, next);

          expect(res.status).toHaveBeenCalledWith(400);
          expect(unlinkSpy).toHaveBeenCalledWith(tmpFile);
          expect(fs.existsSync(tmpFile)).toBe(false);
        } finally {
          unlinkSpy.mockRestore();
          if (fs.existsSync(tmpFile)) {
            fs.unlinkSync(tmpFile);
          }
        }
      });

      it('cleans up temporary file (req.file) when form is not found (404)', async () => {
        const tmpFile = path.join(
          os.tmpdir(),
          `test-file-404-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`
        );
        fs.writeFileSync(tmpFile, 'temporary 404 file content');
        expect(fs.existsSync(tmpFile)).toBe(true);

        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

        const nonExistentFormId = new mongoose.Types.ObjectId().toString();
        const req = {
          params: { formId: nonExistentFormId },
          body: { answers: [] },
          file: {
            fieldname: 'attachment',
            originalname: 'notfound.txt',
            path: tmpFile,
            size: 26,
            mimetype: 'text/plain'
          },
          ip: '127.0.0.1'
        };

        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis()
        };
        const next = vi.fn();

        try {
          await submitResponse(req, res, next);

          expect(res.status).toHaveBeenCalledWith(404);
          expect(unlinkSpy).toHaveBeenCalledWith(tmpFile);
          expect(fs.existsSync(tmpFile)).toBe(false);
        } finally {
          unlinkSpy.mockRestore();
          if (fs.existsSync(tmpFile)) {
            fs.unlinkSync(tmpFile);
          }
        }
      });

      it('cleans up temporary file (req.file) when an unexpected error occurs (500 path)', async () => {
        const tmpFile = path.join(
          os.tmpdir(),
          `test-file-500-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`
        );
        fs.writeFileSync(tmpFile, 'temporary 500 file content');
        expect(fs.existsSync(tmpFile)).toBe(true);

        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
        const findSpy = vi
          .spyOn(Form, 'findById')
          .mockRejectedValueOnce(new Error('Simulated DB crash'));

        const req = {
          params: { formId: testForm._id.toString() },
          body: { answers: [] },
          file: {
            fieldname: 'attachment',
            originalname: 'crash.txt',
            path: tmpFile,
            size: 26,
            mimetype: 'text/plain'
          },
          ip: '127.0.0.1'
        };

        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis()
        };
        const next = vi.fn();

        try {
          await submitResponse(req, res, next);

          expect(next).toHaveBeenCalled();
          expect(next.mock.calls[0][0].message).toBe('Simulated DB crash');
          expect(unlinkSpy).toHaveBeenCalledWith(tmpFile);
          expect(fs.existsSync(tmpFile)).toBe(false);
        } finally {
          findSpy.mockRestore();
          unlinkSpy.mockRestore();
          if (fs.existsSync(tmpFile)) {
            fs.unlinkSync(tmpFile);
          }
        }
      });

      it('handles requests gracefully when req.files and req.file are both absent', async () => {
        const req = {
          params: { formId: testForm._id.toString() },
          body: {
            answers: [{ questionId: testTextQuestion._id.toString(), value: 'No Files' }]
          },
          ip: '127.0.0.1'
        };

        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis()
        };
        const next = vi.fn();

        await expect(submitResponse(req, res, next)).resolves.not.toThrow();
        expect(res.status).toHaveBeenCalledWith(201);
      });
    });

    describe('Unit Tests: req.files array cleanup', () => {
      it('cleans up multiple temporary files (req.files) on successful submission', async () => {
        const tmpFile1 = path.join(
          os.tmpdir(),
          `test-files-multi1-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`
        );
        const tmpFile2 = path.join(
          os.tmpdir(),
          `test-files-multi2-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`
        );
        fs.writeFileSync(tmpFile1, 'file 1 content');
        fs.writeFileSync(tmpFile2, 'file 2 content');

        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

        const req = {
          params: { formId: testForm._id.toString() },
          body: {
            answers: [{ questionId: testTextQuestion._id.toString(), value: 'Multi File' }]
          },
          files: [
            {
              fieldname: 'doc1',
              originalname: 'doc1.tmp',
              path: tmpFile1,
              size: 14,
              mimetype: 'text/plain'
            },
            {
              fieldname: 'doc2',
              originalname: 'doc2.tmp',
              path: tmpFile2,
              size: 14,
              mimetype: 'text/plain'
            }
          ],
          ip: '127.0.0.1'
        };

        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis()
        };
        const next = vi.fn();

        try {
          await submitResponse(req, res, next);

          expect(res.status).toHaveBeenCalledWith(201);
          expect(unlinkSpy).toHaveBeenCalledWith(tmpFile1);
          expect(unlinkSpy).toHaveBeenCalledWith(tmpFile2);
          expect(fs.existsSync(tmpFile1)).toBe(false);
          expect(fs.existsSync(tmpFile2)).toBe(false);
        } finally {
          unlinkSpy.mockRestore();
          if (fs.existsSync(tmpFile1)) fs.unlinkSync(tmpFile1);
          if (fs.existsSync(tmpFile2)) fs.unlinkSync(tmpFile2);
        }
      });

      it('cleans up multiple temporary files (req.files) on validation failure', async () => {
        const tmpFile1 = path.join(
          os.tmpdir(),
          `test-files-fail1-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`
        );
        const tmpFile2 = path.join(
          os.tmpdir(),
          `test-files-fail2-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`
        );
        fs.writeFileSync(tmpFile1, 'fail 1 content');
        fs.writeFileSync(tmpFile2, 'fail 2 content');

        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

        const req = {
          params: { formId: testForm._id.toString() },
          body: {
            answers: [] // Missing required field
          },
          files: [
            {
              fieldname: 'doc1',
              originalname: 'fail1.tmp',
              path: tmpFile1,
              size: 14,
              mimetype: 'text/plain'
            },
            {
              fieldname: 'doc2',
              originalname: 'fail2.tmp',
              path: tmpFile2,
              size: 14,
              mimetype: 'text/plain'
            }
          ],
          ip: '127.0.0.1'
        };

        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn().mockReturnThis()
        };
        const next = vi.fn();

        try {
          await submitResponse(req, res, next);

          expect(res.status).toHaveBeenCalledWith(400);
          expect(unlinkSpy).toHaveBeenCalledWith(tmpFile1);
          expect(unlinkSpy).toHaveBeenCalledWith(tmpFile2);
          expect(fs.existsSync(tmpFile1)).toBe(false);
          expect(fs.existsSync(tmpFile2)).toBe(false);
        } finally {
          unlinkSpy.mockRestore();
          if (fs.existsSync(tmpFile1)) fs.unlinkSync(tmpFile1);
          if (fs.existsSync(tmpFile2)) fs.unlinkSync(tmpFile2);
        }
      });
    });

    describe('Integration Tests: Express middleware with upload.single', () => {
      it('cleans up single temporary file via upload.single middleware on successful submission', async () => {
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

        try {
          const res = await request(singleUploadApp)
            .post(`/api/responses/${testForm._id}/single`)
            .field(
              'answers',
              JSON.stringify([
                { questionId: testTextQuestion._id.toString(), value: 'Success integration test' }
              ])
            )
            .attach('attachment', Buffer.from('Integration upload content'), {
              filename: 'test-single-success.txt',
              contentType: 'text/plain'
            });

          expect(res.status).toBe(201);
          expect(res.body.success).toBe(true);

          expect(unlinkSpy).toHaveBeenCalled();
          const unlinkedPath = unlinkSpy.mock.calls[0][0];
          expect(typeof unlinkedPath).toBe('string');
          expect(fs.existsSync(unlinkedPath)).toBe(false);
        } finally {
          unlinkSpy.mockRestore();
        }
      });

      it('cleans up single temporary file via upload.single middleware on validation failure', async () => {
        const unlinkSpy = vi.spyOn(fs, 'unlinkSync');

        try {
          const res = await request(singleUploadApp)
            .post(`/api/responses/${testForm._id}/single`)
            .field('answers', JSON.stringify([])) // Missing required field
            .attach('attachment', Buffer.from('Integration failure content'), {
              filename: 'test-single-fail.txt',
              contentType: 'text/plain'
            });

          expect(res.status).toBe(400);
          expect(res.body.success).toBe(false);

          expect(unlinkSpy).toHaveBeenCalled();
          const unlinkedPath = unlinkSpy.mock.calls[0][0];
          expect(typeof unlinkedPath).toBe('string');
          expect(fs.existsSync(unlinkedPath)).toBe(false);
        } finally {
          unlinkSpy.mockRestore();
        }
      });
    });
  });

  describe('SEC-04 and SEC-06 Hardening: Filename, Storage Extension, and Rate Limit Keys', () => {
    it('isolates submission rate limit keys per valid form and per IP', () => {
      const validId1 = '507f1f77bcf86cd799439011';
      const validId2 = '507f1f77bcf86cd799439012';
      const key1 = getSubmissionRateLimitKey({ params: { formId: validId1 }, ip: '1.2.3.4' });
      const key2 = getSubmissionRateLimitKey({ params: { formId: validId2 }, ip: '1.2.3.4' });
      const key3 = getSubmissionRateLimitKey({ params: { formId: validId1 }, ip: '5.6.7.8' });

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key1).toContain(validId1);
      expect(key2).toContain(validId2);
    });

    it('collapses arbitrary invalid form IDs to a single invalid rate limit bucket per IP', () => {
      const key1 = getSubmissionRateLimitKey({
        params: { formId: 'random-invalid-1' },
        ip: '1.2.3.4'
      });
      const key2 = getSubmissionRateLimitKey({
        params: { formId: 'random-invalid-2' },
        ip: '1.2.3.4'
      });
      const keyDiffIp = getSubmissionRateLimitKey({
        params: { formId: 'random-invalid-1' },
        ip: '5.6.7.8'
      });

      expect(key1).toBe('invalid:1.2.3.4');
      expect(key2).toBe('invalid:1.2.3.4');
      expect(key1).toBe(key2);
      expect(keyDiffIp).toBe('invalid:5.6.7.8');
    });

    it('preValidateSubmissionForm rejects malformed form IDs before reaching multipart parsing', async () => {
      const req = { params: { formId: 'not-a-valid-24-hex-id' } };
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock };
      const next = vi.fn();

      await preValidateSubmissionForm(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({ success: false, message: 'Invalid resource ID' });
      expect(next).not.toHaveBeenCalled();
    });

    it('preValidateSubmissionForm rejects nonexistent form IDs with 404 before multipart parsing', async () => {
      const nonExistentId = new mongoose.Types.ObjectId().toString();
      const req = { params: { formId: nonExistentId } };
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock };
      const next = vi.fn();

      await preValidateSubmissionForm(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({ success: false, message: 'Form not found' });
      expect(next).not.toHaveBeenCalled();
    });

    it('preValidateSubmissionForm rejects draft/unpublished forms with 403 before multipart parsing', async () => {
      const draftForm = await Form.create({
        ownerId: new mongoose.Types.ObjectId(),
        title: 'Draft Form',
        status: 'draft'
      });

      const req = { params: { formId: draftForm._id.toString() } };
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const res = { status: statusMock };
      const next = vi.fn();

      await preValidateSubmissionForm(req, res, next);

      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: 'This form is not accepting responses'
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('preValidateSubmissionForm attaches targetForm and calls next for published forms', async () => {
      const publishedForm = await Form.create({
        ownerId: new mongoose.Types.ObjectId(),
        title: 'Published Form',
        status: 'published'
      });

      const req = { params: { formId: publishedForm._id.toString() } };
      const res = {};
      const next = vi.fn();

      await preValidateSubmissionForm(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.targetForm).toBeDefined();
      expect(req.targetForm._id.toString()).toBe(publishedForm._id.toString());
    });

    it('generates opaque random filename in multer diskStorage ignoring user fieldname', () => {
      const req = {};
      const file = { fieldname: '../../traversal-payload' };
      let generatedFilename = null;

      upload.storage.getFilename(req, file, (err, filename) => {
        generatedFilename = filename;
      });

      expect(generatedFilename).toMatch(/^upload-[0-9a-f-]+\.tmp$/);
      expect(generatedFilename).not.toContain('..');
      expect(generatedFilename).not.toContain('traversal-payload');
      expect(req._trackedTempFiles).toBeInstanceOf(Set);
      expect(req._trackedTempFiles.size).toBe(1);
    });

    it('derives stored file extension strictly from canonical MIME type regardless of client originalname', async () => {
      const user = await User.create({
        name: 'Safe Ext User',
        email: `safe_ext_${Date.now()}@test.com`,
        password: 'password123'
      });

      const form = await Form.create({
        ownerId: user._id,
        title: 'Safe Extension Form',
        status: 'published'
      });

      const fileQ = await Question.create({
        formId: form._id,
        type: 'file',
        label: 'Attachment',
        required: true,
        order: 0
      });

      const uploadSpy = vi.spyOn(storageService, 'uploadFile');

      try {
        const validPdfBuffer = Buffer.from('%PDF-1.4\n%EOF\n');
        // Client attempts to name the file exploit.php or exploit.exe
        const res = await request(app)
          .post(`/api/responses/${form._id}`)
          .field('answers', JSON.stringify([]))
          .attach(`file_${fileQ._id.toString()}`, validPdfBuffer, {
            filename: 'exploit.exe',
            contentType: 'application/pdf'
          });

        expect(res.status).toBe(201);
        expect(uploadSpy).toHaveBeenCalled();
        const uploadedStorageKey = uploadSpy.mock.calls[0][1];
        const uploadedMime = uploadSpy.mock.calls[0][2];

        // Storage key must end with .pdf (from canonicalMime), NOT .exe
        expect(uploadedStorageKey.endsWith('.pdf')).toBe(true);
        expect(uploadedStorageKey.endsWith('.exe')).toBe(false);
        expect(uploadedMime).toBe('application/pdf');

        const savedResponse = await Response.findOne({ formId: form._id });
        const answer = savedResponse.answers.find(
          (a) => a.questionId.toString() === fileQ._id.toString()
        );
        expect(answer.value.key.endsWith('.pdf')).toBe(true);
        expect(answer.value.originalName).toBe('exploit.exe');
      } finally {
        uploadSpy.mockRestore();
      }
    });
  });

  describe('Stage 4.3.2 Hardening: Route Parameter Validation, Public Response Sanitization & Pagination Safety', () => {
    let testOwner;
    let testOwnerToken;
    let testForm;
    let testQuestion;

    beforeEach(async () => {
      testOwner = await User.create({
        name: 'Stage 432 Owner',
        email: 'stage432-owner@test.com',
        password: 'password123'
      });
      testOwnerToken = jwt.sign({ id: testOwner._id }, process.env.JWT_SECRET);

      testForm = await Form.create({
        ownerId: testOwner._id,
        title: 'Stage 432 Form',
        status: 'published'
      });

      testQuestion = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Feedback',
        required: true,
        order: 0
      });
    });

    it('rejects malformed ObjectIds across all response routes with HTTP 400', async () => {
      const validId = new mongoose.Types.ObjectId().toString();

      // POST /api/responses/:formId
      const resPost = await request(app)
        .post('/api/responses/invalid-form-id')
        .send({ answers: [] });
      expect(resPost.status).toBe(400);
      expect(resPost.body.message).toBe('Invalid resource ID');

      // GET /api/responses/:formId
      const resGet = await request(app)
        .get('/api/responses/invalid-form-id')
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resGet.status).toBe(400);
      expect(resGet.body.message).toBe('Invalid resource ID');

      // GET /api/responses/:formId/analytics
      const resAnalytics = await request(app)
        .get('/api/responses/invalid-form-id/analytics')
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resAnalytics.status).toBe(400);
      expect(resAnalytics.body.message).toBe('Invalid resource ID');

      // GET /api/responses/:formId/export
      const resExport = await request(app)
        .get('/api/responses/invalid-form-id/export')
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resExport.status).toBe(400);
      expect(resExport.body.message).toBe('Invalid resource ID');

      // DELETE /api/responses/:formId/:responseId (invalid formId)
      const resDel1 = await request(app)
        .delete(`/api/responses/invalid-form-id/${validId}`)
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resDel1.status).toBe(400);
      expect(resDel1.body.message).toBe('Invalid resource ID');

      // DELETE /api/responses/:formId/:responseId (invalid responseId)
      const resDel2 = await request(app)
        .delete(`/api/responses/${validId}/invalid-response-id`)
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resDel2.status).toBe(400);
      expect(resDel2.body.message).toBe('Invalid resource ID');

      // GET file with invalid questionId
      const resFile = await request(app)
        .get(`/api/responses/${validId}/${validId}/file/invalid-question-id`)
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resFile.status).toBe(400);
      expect(resFile.body.message).toBe('Invalid resource ID');
    });

    it('sanitizes public submission response and strips submitter IP and internal storage keys', async () => {
      const res = await request(app)
        .post(`/api/responses/${testForm._id}`)
        .send({
          answers: [{ questionId: testQuestion._id, value: 'Great service!' }]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Response submitted successfully');
      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();

      // Ensure sensitive internal fields are stripped from the response body
      expect(res.body.data.submittedBy).toBeUndefined();
      expect(res.body.data.answers).toBeUndefined();
      expect(res.body.data.formId).toBeUndefined();
      expect(res.body.data.__v).toBeUndefined();
    });

    it('handles invalid pagination query parameters gracefully without NaN and applies deterministic sorting', async () => {
      // Seed two responses
      await Response.create([
        {
          formId: testForm._id,
          answers: [{ questionId: testQuestion._id, value: 'Resp 1' }],
          submittedBy: '127.0.0.1'
        },
        {
          formId: testForm._id,
          answers: [{ questionId: testQuestion._id, value: 'Resp 2' }],
          submittedBy: '127.0.0.1'
        }
      ]);

      // 1. Non-numeric page and limit
      const resNaN = await request(app)
        .get(`/api/responses/${testForm._id}?page=abc&limit=xyz`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resNaN.status).toBe(200);
      expect(resNaN.body.pagination.page).toBe(1);
      expect(resNaN.body.pagination.limit).toBe(50);
      expect(Number.isFinite(resNaN.body.pagination.page)).toBe(true);
      expect(Number.isFinite(resNaN.body.pagination.limit)).toBe(true);
      expect(Number.isFinite(resNaN.body.pagination.pages)).toBe(true);

      // 2. Negative page and excessive limit
      const resBounds = await request(app)
        .get(`/api/responses/${testForm._id}?page=-5&limit=1000`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resBounds.status).toBe(200);
      expect(resBounds.body.pagination.page).toBe(1);
      expect(resBounds.body.pagination.limit).toBe(100);

      // 3. Zero page
      const resZero = await request(app)
        .get(`/api/responses/${testForm._id}?page=0&limit=10`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resZero.status).toBe(200);
      expect(resZero.body.pagination.page).toBe(1);
      expect(resZero.body.pagination.limit).toBe(10);

      // 4. Decimal values (truncated safely by parseInt to integers)
      const resDecimal = await request(app)
        .get(`/api/responses/${testForm._id}?page=1.5&limit=2.9`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resDecimal.status).toBe(200);
      expect(resDecimal.body.pagination.page).toBe(1);
      expect(resDecimal.body.pagination.limit).toBe(2);

      // 5. Exponent notation (halts at non-numeric 'e')
      const resExp = await request(app)
        .get(`/api/responses/${testForm._id}?page=1e2&limit=1e10`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resExp.status).toBe(200);
      expect(resExp.body.pagination.page).toBe(1);
      expect(resExp.body.pagination.limit).toBe(1);

      // 6. Excessively large and 50-digit numeric strings (clamped safely)
      const resHuge = await request(app)
        .get(
          `/api/responses/${testForm._id}?page=99999999999999999999999999&limit=99999999999999999999999999`
        )
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resHuge.status).toBe(200);
      expect(resHuge.body.pagination.page).toBe(100000);
      expect(resHuge.body.pagination.limit).toBe(100);

      const resFiftyDigits = await request(app)
        .get(`/api/responses/${testForm._id}?page=${'9'.repeat(50)}`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resFiftyDigits.status).toBe(200);
      expect(resFiftyDigits.body.pagination.page).toBe(100000);

      // 7. Missing parameters (defaults)
      const resDefault = await request(app)
        .get(`/api/responses/${testForm._id}`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(resDefault.status).toBe(200);
      expect(resDefault.body.pagination.page).toBe(1);
      expect(resDefault.body.pagination.limit).toBe(50);
    });
  });

  describe('Stage 4.3.3: Data Integrity, Null-Safety & Deleting State Guards', () => {
    let testOwnerToken;
    let testForm;

    beforeEach(async () => {
      const user = await User.create({
        name: 'Stage 433 Owner',
        email: `stage433owner_${Date.now()}_${Math.random()}@test.com`,
        password: 'password123'
      });
      testOwnerToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'testsecret', {
        expiresIn: '15m'
      });
      testForm = await Form.create({
        ownerId: user._id,
        title: 'Stage 433 Form',
        status: 'published'
      });
    });

    it('blocks responses, analytics, export, file download, and response deletion when form.status === deleting', async () => {
      const q = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Name',
        order: 0
      });
      const response = await Response.create({
        formId: testForm._id,
        answers: [{ questionId: q._id, value: 'Alice' }]
      });

      // Mark form as deleting
      testForm.status = 'deleting';
      await testForm.save();

      // 1. getResponses
      const resList = await request(app)
        .get(`/api/responses/${testForm._id}`)
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resList.status).toBe(409);
      expect(resList.body.message).toBe('Form is currently being deleted');

      // 2. getAnalytics
      const resAnalytics = await request(app)
        .get(`/api/responses/${testForm._id}/analytics`)
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resAnalytics.status).toBe(409);
      expect(resAnalytics.body.message).toBe('Form is currently being deleted');

      // 3. exportResponses
      const resExport = await request(app)
        .get(`/api/responses/${testForm._id}/export`)
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resExport.status).toBe(409);
      expect(resExport.body.message).toBe('Form is currently being deleted');

      // 4. deleteResponse
      const resDelResp = await request(app)
        .delete(`/api/responses/${testForm._id}/${response._id}`)
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resDelResp.status).toBe(409);
      expect(resDelResp.body.message).toBe('Form is currently being deleted');

      // 5. downloadResponseFile
      const resFile = await request(app)
        .get(`/api/responses/${testForm._id}/${response._id}/file/${q._id}`)
        .set('Cookie', [`token=${testOwnerToken}`]);
      expect(resFile.status).toBe(409);
      expect(resFile.body.message).toBe('Form is currently being deleted');
    });

    it('getAnalytics handles answers with null questionId, missing options, prototype keys, and non-numeric values defensively', async () => {
      // Create questions: text, choice with options undefined/null, number, rating
      const choiceQ = await Question.create({
        formId: testForm._id,
        type: 'multiple_choice',
        label: 'Choice Q',
        options: ['Option A', 'Option B'],
        order: 0
      });

      const choiceNoOptsQ = await Question.create({
        formId: testForm._id,
        type: 'multiple_choice',
        label: 'Choice Without Opts',
        options: [],
        order: 1
      });

      const numberQ = await Question.create({
        formId: testForm._id,
        type: 'number',
        label: 'Age',
        order: 2
      });

      const ratingQ = await Question.create({
        formId: testForm._id,
        type: 'rating',
        label: 'Rating',
        order: 3
      });

      // Response 1: standard valid
      await Response.create({
        formId: testForm._id,
        answers: [
          { questionId: choiceQ._id, value: 'Option A' },
          { questionId: numberQ._id, value: 42 },
          { questionId: ratingQ._id, value: 5 }
        ]
      });

      // Response 2: raw MongoDB insertion with null questionId, null numeric value, prototype key, invalid rating
      await Response.collection.insertOne({
        formId: testForm._id,
        answers: [
          { questionId: choiceQ._id, value: 'toString' },
          { questionId: choiceNoOptsQ._id, value: 'Unlisted' },
          { questionId: numberQ._id, value: null },
          { questionId: null, value: 'corrupted answer' },
          { questionId: ratingQ._id, value: 'invalid_rating' }
        ],
        createdAt: new Date()
      });

      // Response 3: empty string on number (should NOT count as 0), out-of-range rating (10 on 1-5 scale)
      await Response.create({
        formId: testForm._id,
        answers: [
          { questionId: choiceQ._id, value: '__proto__' },
          { questionId: numberQ._id, value: '' },
          { questionId: ratingQ._id, value: 10 }
        ]
      });

      // Response 4: answer with an orphaned / foreign questionId (not in form's questions)
      const orphanedQId = new mongoose.Types.ObjectId();
      await Response.create({
        formId: testForm._id,
        answers: [{ questionId: orphanedQId, value: 'Orphan value' }]
      });

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/analytics`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.summary.totalResponses).toBe(4);

      // Verify number analytics: only 1 valid response (42), min=42, max=42, average=42
      const numAnalytics = res.body.data.analytics.find(
        (qa) => qa.questionId.toString() === numberQ._id.toString()
      );
      expect(numAnalytics.data.min).toBe(42);
      expect(numAnalytics.data.max).toBe(42);
      expect(numAnalytics.data.average).toBe(42);

      // Verify choice analytics: prototype keys did not crash optionCounts
      const choiceAnalytics = res.body.data.analytics.find(
        (qa) => qa.questionId.toString() === choiceQ._id.toString()
      );
      const optionA = choiceAnalytics.data.distribution.find((d) => d.option === 'Option A');
      expect(optionA.count).toBe(1);

      // Verify rating analytics: only 1 valid rating (5)
      const ratingAnalytics = res.body.data.analytics.find(
        (qa) => qa.questionId.toString() === ratingQ._id.toString()
      );
      expect(ratingAnalytics.data.average).toBe(5);
      expect(ratingAnalytics.data.totalRatings).toBe(1);
    });
  });

  describe('Stage 4.3.4: Query Performance, Cursor Streaming & Aggregation Bounding (Response Workstreams)', () => {
    let testOwner;
    let testOwnerToken;
    let testForm;

    beforeEach(async () => {
      await User.deleteMany({});
      await Form.deleteMany({});
      await Question.deleteMany({});
      await Response.deleteMany({});

      testOwner = await User.create({
        name: 'Stage 4.3.4 Response Owner',
        email: 'stage434resp@example.com',
        password: 'password123'
      });
      testOwnerToken = jwt.sign({ id: testOwner._id }, process.env.JWT_SECRET || 'testsecret', {
        expiresIn: '15m'
      });

      testForm = await Form.create({
        ownerId: testOwner._id,
        title: 'Stage 4.3.4 Performance Form',
        status: 'published'
      });
    });

    it('Workstream C: eliminates unbounded $push from analytics pipeline and computes bounded metrics', async () => {
      const qText = await Question.create({
        formId: testForm._id,
        type: 'long_text',
        label: 'Detailed Feedback',
        order: 1
      });
      const qChoice = await Question.create({
        formId: testForm._id,
        type: 'multiple_choice',
        label: 'Features Used',
        options: ['Feature Alpha', 'Feature Beta', 'Feature Gamma'],
        order: 2
      });
      const qNum = await Question.create({
        formId: testForm._id,
        type: 'number',
        label: 'Satisfaction Score',
        order: 3
      });
      const qRate = await Question.create({
        formId: testForm._id,
        type: 'rating',
        label: 'Star Rating',
        order: 4
      });

      // Submit responses with large text answers and diverse choice combinations
      await Response.create([
        {
          formId: testForm._id,
          answers: [
            { questionId: qText._id, value: 'A'.repeat(5000) },
            { questionId: qChoice._id, value: ['Feature Alpha', 'Feature Beta'] },
            { questionId: qNum._id, value: 85 },
            { questionId: qRate._id, value: 5 }
          ]
        },
        {
          formId: testForm._id,
          answers: [
            { questionId: qText._id, value: 'B'.repeat(5000) },
            { questionId: qChoice._id, value: 'Feature Alpha' },
            { questionId: qNum._id, value: 95 },
            { questionId: qRate._id, value: 4 }
          ]
        },
        {
          formId: testForm._id,
          answers: [
            { questionId: qText._id, value: 'C'.repeat(5000) },
            { questionId: qChoice._id, value: ['Feature Gamma'] },
            { questionId: qNum._id, value: 'not-a-number' }, // invalid number string ignored
            { questionId: qRate._id, value: 99 } // out of range rating ignored
          ]
        }
      ]);

      const aggregateSpy = vi.spyOn(Response, 'aggregate');

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/analytics`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalResponses).toBe(3);
      expect(res.body.data.summary.totalResponses).toBe(3);
      expect(res.body.data.summary.completedResponses).toBe(3);
      expect(res.body.data.summary.completionRate).toBe(100);

      // Verify that NO pipeline stage executed { values: { $push: '$answers.value' } }
      const executedPipelines = aggregateSpy.mock.calls.map((call) => call[0]);
      for (const pipeline of executedPipelines) {
        for (const stage of pipeline) {
          if (stage.$group) {
            expect(stage.$group.values).toBeUndefined();
          }
        }
      }

      // Check long_text question: only totalAnswers is computed, zero text strings pushed into memory
      const textAnalytics = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qText._id.toString()
      );
      expect(textAnalytics.totalAnswers).toBe(3);
      expect(textAnalytics.data.type).toBe('text');
      expect(textAnalytics.data.count).toBe(3);
      expect(textAnalytics.data.values).toBeUndefined();

      // Check choice question: distribution accurately counts options from both array and scalar answers
      const choiceAnalytics = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qChoice._id.toString()
      );
      expect(choiceAnalytics.totalAnswers).toBe(3);
      const alphaDist = choiceAnalytics.data.distribution.find((d) => d.option === 'Feature Alpha');
      const betaDist = choiceAnalytics.data.distribution.find((d) => d.option === 'Feature Beta');
      const gammaDist = choiceAnalytics.data.distribution.find((d) => d.option === 'Feature Gamma');
      expect(alphaDist.count).toBe(2);
      expect(betaDist.count).toBe(1);
      expect(gammaDist.count).toBe(1);
      expect(choiceAnalytics.data.totalSelections).toBe(4);

      // Check number question: calculated min, max, average without including non-numeric
      const numAnalytics = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qNum._id.toString()
      );
      expect(numAnalytics.data.min).toBe(85);
      expect(numAnalytics.data.max).toBe(95);
      expect(numAnalytics.data.average).toBe(90);

      // Check rating question: calculated average and distribution, discarding out-of-range rating 99
      const rateAnalytics = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qRate._id.toString()
      );
      expect(rateAnalytics.data.distribution['5']).toBe(1);
      expect(rateAnalytics.data.distribution['4']).toBe(1);
      expect(rateAnalytics.data.distribution['1']).toBe(0);
      expect(rateAnalytics.data.totalRatings).toBe(2);
      expect(rateAnalytics.data.average).toBe(4.5);
    });

    it('Workstream D: streams CSV export via MongoDB cursor without in-memory full buffering', async () => {
      const q1 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Full Name',
        order: 1
      });
      const q2 = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Spreadsheet Formula Input',
        order: 2
      });

      await Response.create([
        {
          formId: testForm._id,
          answers: [
            { questionId: q1._id, value: 'Alice "Wonderland"' },
            { questionId: q2._id, value: '=cmd|/c calc!A0' } // Injection attempt
          ]
        },
        {
          formId: testForm._id,
          answers: [
            { questionId: q1._id, value: 'Bob, The Builder' },
            { questionId: q2._id, value: 'Safe string' }
          ]
        }
      ]);

      const cursorSpy = vi.spyOn(Response, 'find');

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/export?format=csv`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(`responses-${testForm._id}.csv`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');

      // Verify Response.find was invoked with lean cursor streaming
      expect(cursorSpy).toHaveBeenCalled();

      const rawCsv = res.text;
      const lines = rawCsv.split('\r\n');
      // Exactly 3 lines: Header + 2 data rows (no trailing newline)
      expect(lines.length).toBe(3);

      // Header row check
      expect(lines[0]).toBe('"Timestamp","Full Name","Spreadsheet Formula Input"');

      // Row 1 check: quote doubling and formula neutralization
      expect(lines[1]).toContain('"Alice ""Wonderland"""');
      expect(lines[1]).toContain('"\'=cmd|/c calc!A0"'); // Single quote prepended to neutralize formula

      // Row 2 check: comma in quotes
      expect(lines[2]).toContain('"Bob, The Builder"');
      expect(lines[2]).toContain('"Safe string"');
    });

    it('Workstream E: validates rate limit key generator and endpoint limiters', () => {
      const validFormId = '507f1f77bcf86cd799439011';
      const userReq = {
        user: { _id: '507f191e810c19729de860ea' },
        params: { formId: validFormId },
        ip: '192.168.1.100'
      };
      const key = getAuthenticatedFormRateLimitKey(userReq);
      expect(key).toBe(`507f191e810c19729de860ea:${validFormId}:192.168.1.100`);

      const anonReq = {
        user: null,
        params: { formId: 'invalid-id' },
        ip: '10.0.0.1'
      };
      const anonKey = getAuthenticatedFormRateLimitKey(anonReq);
      expect(anonKey).toBe('anon:invalid:10.0.0.1');

      expect(analyticsLimiter).toBeDefined();
      expect(exportLimiter).toBeDefined();

      // Verify user-level limiters against multi-form amplification
      const userKey = getUserRateLimitKey(userReq);
      expect(userKey).toBe('507f191e810c19729de860ea');

      const fallbackKey = getUserRateLimitKey({ ip: '192.168.1.1' });
      expect(fallbackKey).toBe('192.168.1.1');

      expect(userAnalyticsLimiter).toBeDefined();
      expect(userExportLimiter).toBeDefined();
      expect(responseDeletionLimiter).toBeDefined();
    });

    it('Workstream C Targeted Correction: bounds high-cardinality choice options into top 20 with explicit Other metadata', async () => {
      const qChoice = await Question.create({
        formId: testForm._id,
        type: 'single_choice',
        label: 'High Cardinality City Selection',
        options: ['City 1', 'City 2'],
        order: 1
      });

      // Submit 30 distinct choice options
      const responsesToInsert = [];
      for (let i = 1; i <= 30; i++) {
        responsesToInsert.push({
          formId: testForm._id,
          answers: [{ questionId: qChoice._id, value: `City ${i}` }]
        });
      }
      await Response.create(responsesToInsert);

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/analytics`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      const choiceItem = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qChoice._id.toString()
      );

      expect(choiceItem).toBeDefined();
      expect(choiceItem.totalAnswers).toBe(30);
      expect(choiceItem.data.totalSelections).toBe(30);
      expect(choiceItem.data.isTruncated).toBe(true);
      expect(choiceItem.data.totalCategories).toBe(30);
      // Bounded at 20 (19 top options + 'Other')
      expect(choiceItem.data.displayedCategories).toBe(20);
      expect(choiceItem.data.distribution.length).toBe(20);

      const otherEntry = choiceItem.data.distribution.find((d) => d.option === 'Other');
      expect(otherEntry).toBeDefined();
      expect(otherEntry.count).toBe(11); // 30 - 19 = 11
      expect(choiceItem.data.otherCount).toBe(11);
    });

    it('Workstream C Targeted Correction: safely handles null and empty answers in analytics without skewing totals', async () => {
      const qNum = await Question.create({
        formId: testForm._id,
        type: 'number',
        label: 'Mixed Type Numeric Field',
        order: 2
      });

      await Response.collection.insertMany([
        {
          formId: testForm._id,
          createdAt: new Date(),
          answers: [{ questionId: qNum._id, value: 100 }]
        },
        {
          formId: testForm._id,
          createdAt: new Date(),
          answers: [{ questionId: qNum._id, value: 200 }]
        },
        {
          formId: testForm._id,
          createdAt: new Date(),
          answers: [{ questionId: qNum._id, value: null }] // null answer
        },
        {
          formId: testForm._id,
          createdAt: new Date(),
          answers: [{ questionId: qNum._id, value: '' }] // empty string
        },
        {
          formId: testForm._id,
          createdAt: new Date(),
          answers: [{ questionId: qNum._id, value: false }] // boolean
        }
      ]);

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/analytics`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      const numItem = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qNum._id.toString()
      );

      expect(numItem).toBeDefined();
      // Only the 2 valid numbers are included in numeric statistics
      expect(numItem.data.min).toBe(100);
      expect(numItem.data.max).toBe(200);
      expect(numItem.data.average).toBe(150);
    });

    it('Workstream D Targeted Correction: distinguishes normal completion from client disconnect and cleans up cursor listeners', async () => {
      const qText = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Feedback Text',
        order: 1
      });

      await Response.create([
        { formId: testForm._id, answers: [{ questionId: qText._id, value: 'Row 1' }] },
        { formId: testForm._id, answers: [{ questionId: qText._id, value: 'Row 2' }] }
      ]);

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/export?format=csv`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      expect(res.text).toContain('Row 1');
      expect(res.text).toContain('Row 2');
    });

    it('Workstream C Final Acceptance: bounds aggregation in MongoDB using $topN returning strictly bounded documents', async () => {
      const qChoice = await Question.create({
        formId: testForm._id,
        type: 'single_choice',
        label: 'Color Preference',
        options: ['Red', 'Blue', 'Green'],
        order: 1
      });

      // Submit votes for 25 distinct colors
      const entries = [];
      for (let i = 1; i <= 25; i++) {
        entries.push({
          formId: testForm._id,
          answers: [{ questionId: qChoice._id, value: `Color ${i}` }]
        });
      }
      await Response.create(entries);

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/analytics`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      const choiceData = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qChoice._id.toString()
      );
      expect(choiceData.data.totalSelections).toBe(25);
      expect(choiceData.data.totalCategories).toBe(25);
      expect(choiceData.data.isTruncated).toBe(true);
      expect(choiceData.data.displayedCategories).toBe(20);
      expect(choiceData.data.otherCount).toBe(6); // 25 - 19 = 6
    });

    it('Workstream C Final Acceptance: preserves distinct answer categories that share first 200 characters', async () => {
      const qChoiceLong = await Question.create({
        formId: testForm._id,
        type: 'dropdown',
        label: 'Long Answer Question',
        options: [],
        order: 2
      });

      const prefix = 'X'.repeat(200);
      const valA = prefix + ' Alpha';
      const valB = prefix + ' Beta';

      await Response.create([
        { formId: testForm._id, answers: [{ questionId: qChoiceLong._id, value: valA }] },
        { formId: testForm._id, answers: [{ questionId: qChoiceLong._id, value: valB }] }
      ]);

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/analytics`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      const choiceData = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qChoiceLong._id.toString()
      );
      expect(choiceData.data.totalCategories).toBe(2);
      expect(choiceData.data.totalSelections).toBe(2);
      expect(choiceData.data.distribution.length).toBe(2);
      // Both long options preserved separately without collapse
      const optNames = choiceData.data.distribution.map((d) => d.option);
      expect(optNames).toContain(valA);
      expect(optNames).toContain(valB);
    });

    it('Workstream C Final Acceptance: preserves predefined zero-count options when under 20 categories', async () => {
      const qZeroVote = await Question.create({
        formId: testForm._id,
        type: 'single_choice',
        label: 'Vote with Zero Option',
        options: ['Yes', 'No', 'Maybe'],
        order: 3
      });

      await Response.create([
        { formId: testForm._id, answers: [{ questionId: qZeroVote._id, value: 'Yes' }] },
        { formId: testForm._id, answers: [{ questionId: qZeroVote._id, value: 'Yes' }] }
      ]);

      const res = await request(app)
        .get(`/api/responses/${testForm._id}/analytics`)
        .set('Cookie', [`token=${testOwnerToken}`]);

      expect(res.status).toBe(200);
      const choiceData = res.body.data.analytics.find(
        (a) => a.questionId.toString() === qZeroVote._id.toString()
      );
      expect(choiceData.data.totalSelections).toBe(2);
      expect(choiceData.data.totalCategories).toBe(3);
      expect(choiceData.data.isTruncated).toBe(false);
      expect(choiceData.data.otherCount).toBe(0);

      const yesOpt = choiceData.data.distribution.find((d) => d.option === 'Yes');
      const noOpt = choiceData.data.distribution.find((d) => d.option === 'No');
      const maybeOpt = choiceData.data.distribution.find((d) => d.option === 'Maybe');

      expect(yesOpt.count).toBe(2);
      expect(yesOpt.percentage).toBe(100);
      expect(noOpt.count).toBe(0);
      expect(noOpt.percentage).toBe(0);
      expect(maybeOpt.count).toBe(0);
      expect(maybeOpt.percentage).toBe(0);
    });

    describe('Stage 4.3.4 Workstream D: Deterministic Backpressure, Disconnect & Cursor Streaming', () => {
      class MockResponse extends EventEmitter {
        constructor() {
          super();
          this.headers = {};
          this.headersSent = false;
          this.writableEnded = false;
          this.destroyed = false;
          this.destroyError = null;
          this.chunks = [];
          this.statusCode = 200;
          this.writeReturns = true;
          this.writeFn = null;
        }

        get writable() {
          return !this.destroyed && !this.writableEnded;
        }

        setHeader(name, value) {
          this.headers[name.toLowerCase()] = value;
          this.headersSent = true;
          return this;
        }

        getHeader(name) {
          return this.headers[name.toLowerCase()];
        }

        write(chunk) {
          if (this.destroyed || this.writableEnded) {
            return false;
          }
          this.chunks.push(chunk);
          if (typeof this.writeFn === 'function') {
            return this.writeFn(chunk);
          }
          return this.writeReturns;
        }

        end(chunk) {
          if (chunk) {
            this.write(chunk);
          }
          this.writableEnded = true;
          this.emit('finish');
          return this;
        }

        destroy(err) {
          this.destroyed = true;
          if (err) {
            this.destroyError = err;
          }
          this.emit('close');
          return this;
        }

        status(code) {
          this.statusCode = code;
          return this;
        }

        json(data) {
          this.jsonData = data;
          this.end();
          return this;
        }
      }

      function createMockCursor(items = [], options = {}) {
        const cursor = {
          items: [...items],
          destroyed: false,
          destroyCalled: false,
          destroyCalls: 0,
          destroy: vi.fn(() => {
            cursor.destroyed = true;
            cursor.destroyCalled = true;
            cursor.destroyCalls++;
            if (options.throwOnDestroy) {
              throw new Error(options.throwOnDestroy);
            }
            if (options.rejectOnDestroy) {
              return Promise.reject(new Error(options.rejectOnDestroy));
            }
            return Promise.resolve();
          }),
          on: vi.fn(),
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < cursor.items.length; i++) {
              if (cursor.destroyed) {
                break;
              }
              if (typeof options.onBeforeYield === 'function') {
                await options.onBeforeYield(cursor.items[i], i);
              }
              if (cursor.destroyed) {
                break;
              }
              if (options.errorOnIndex === i) {
                throw new Error(`Cursor read error at index ${i}`);
              }
              yield cursor.items[i];
            }
          }
        };
        return cursor;
      }

      let formId;
      let ownerId;
      let q1Id;
      let q2Id;
      let mockForm;
      let mockQuestions;
      let mockResponsesData;
      let req;
      let next;

      beforeEach(() => {
        formId = new mongoose.Types.ObjectId();
        ownerId = new mongoose.Types.ObjectId();
        q1Id = new mongoose.Types.ObjectId();
        q2Id = new mongoose.Types.ObjectId();

        mockForm = {
          _id: formId,
          ownerId: ownerId,
          status: 'published',
          title: 'Export Performance Form'
        };

        mockQuestions = [
          { _id: q1Id, label: 'Full Name', order: 1 },
          { _id: q2Id, label: 'Email', order: 2 }
        ];

        mockResponsesData = [
          {
            _id: new mongoose.Types.ObjectId(),
            formId,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            answers: [
              { questionId: q1Id, value: 'User 1' },
              { questionId: q2Id, value: 'user1@example.com' }
            ]
          },
          {
            _id: new mongoose.Types.ObjectId(),
            formId,
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
            answers: [
              { questionId: q1Id, value: 'User 2' },
              { questionId: q2Id, value: 'user2@example.com' }
            ]
          },
          {
            _id: new mongoose.Types.ObjectId(),
            formId,
            createdAt: new Date('2026-01-03T00:00:00.000Z'),
            answers: [
              { questionId: q1Id, value: 'User 3' },
              { questionId: q2Id, value: 'user3@example.com' }
            ]
          }
        ];

        req = {
          params: { formId: formId.toString() },
          user: { id: ownerId.toString() },
          query: { format: 'csv' }
        };

        next = vi.fn();

        vi.spyOn(Form, 'findById').mockResolvedValue(mockForm);
        vi.spyOn(Question, 'find').mockReturnValue({
          sort: vi.fn().mockResolvedValue(mockQuestions)
        });
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      const setupMockCursorFind = (mockCursor) => {
        const query = {
          sort: vi.fn().mockReturnThis(),
          lean: vi.fn().mockReturnThis(),
          cursor: vi.fn().mockReturnValue(mockCursor)
        };
        vi.spyOn(Response, 'find').mockReturnValue(query);
        return query;
      };

      // 1. Disconnect while waiting for drain
      it('1. Disconnect while waiting for drain: halts export, settles promise, writes no further chunks, and destroys cursor', async () => {
        const mockCursor = createMockCursor(mockResponsesData);
        setupMockCursorFind(mockCursor);

        const res = new MockResponse();
        let writeCount = 0;

        // Header accepted (call 1), row 1 triggers backpressure (call 2)
        res.writeFn = () => {
          writeCount++;
          if (writeCount === 1) return true;
          return false;
        };

        let settled = false;
        const exportPromise = exportResponses(req, res, next).then(() => {
          settled = true;
        });

        // Let writeChunk hit backpressure
        await new Promise((r) => setImmediate(r));

        // Verify export is paused waiting for backpressure
        expect(settled).toBe(false);
        expect(writeCount).toBe(2);
        expect(mockCursor.destroyCalled).toBe(false);

        // Client prematurely disconnects before drain
        res.emit('close');

        // Pending operation must settle cleanly
        await exportPromise;
        expect(settled).toBe(true);

        // Verify no subsequent chunks written (Row 2 and Row 3 skipped)
        expect(writeCount).toBe(2);
        // Verify cursor destruction initiated
        expect(mockCursor.destroyCalled).toBe(true);
        // Verify response was not marked ended normally
        expect(res.writableEnded).toBe(false);
      });

      // 2. Normal backpressure
      it('2. Normal backpressure: pauses on false, resumes on drain, and completes normally', async () => {
        const mockCursor = createMockCursor(mockResponsesData);
        setupMockCursorFind(mockCursor);

        const res = new MockResponse();
        let writeCount = 0;
        let simulateBackpressure = true;

        res.writeFn = () => {
          writeCount++;
          if (writeCount === 2 && simulateBackpressure) {
            return false; // Row 1 backpressure
          }
          return true;
        };

        let settled = false;
        const exportPromise = exportResponses(req, res, next).then(() => {
          settled = true;
        });

        await new Promise((r) => setImmediate(r));

        // Paused waiting for backpressure
        expect(settled).toBe(false);
        expect(writeCount).toBe(2);

        // Relieve backpressure and emit drain
        simulateBackpressure = false;
        res.emit('drain');

        await exportPromise;
        expect(settled).toBe(true);

        // All chunks written: Header (1) + Row 1 (2) + Row 2 (3) + Row 3 (4)
        expect(writeCount).toBe(4);
        expect(res.writableEnded).toBe(true);
        expect(mockCursor.destroyCalled).toBe(true);
        expect(next).not.toHaveBeenCalled();
      });

      // 3. Disconnect during active cursor iteration
      it('3. Disconnect during active cursor iteration: halts iteration and cleans up cursor', async () => {
        let yieldedCount = 0;
        const mockCursor = createMockCursor(mockResponsesData, {
          onBeforeYield: async (item, index) => {
            yieldedCount++;
            if (index === 1) {
              // Client disconnects mid-stream on record 2
              res.emit('close');
            }
          }
        });
        setupMockCursorFind(mockCursor);

        const res = new MockResponse();
        let writeCount = 0;
        res.writeFn = () => {
          writeCount++;
          return true;
        };

        await exportResponses(req, res, next);

        // Iteration stopped: Row 3 was never yielded
        expect(yieldedCount).toBe(2);
        expect(writeCount).toBe(2); // Header + Row 1
        expect(mockCursor.destroyCalled).toBe(true);
        expect(res.writableEnded).toBe(false);
      });

      // 4. Disconnect before native cursor initialization
      it('4. Disconnect before native cursor initialization: does not hang and emits no data chunks', async () => {
        const mockCursor = createMockCursor(mockResponsesData);

        const res = new MockResponse();
        let writeCount = 0;
        res.writeFn = () => {
          writeCount++;
          return true;
        };

        // Client disconnects before cursor creation
        vi.spyOn(Response, 'find').mockImplementation(() => {
          res.emit('close');
          return {
            sort: vi.fn().mockReturnThis(),
            lean: vi.fn().mockReturnThis(),
            cursor: vi.fn().mockReturnValue(mockCursor)
          };
        });

        const exportPromise = exportResponses(req, res, next);
        await expect(exportPromise).resolves.toBeUndefined();

        // Only header written before disconnect; no data rows emitted
        expect(writeCount).toBe(1);
        expect(res.chunks.length).toBe(1);
        // Cursor destruction safely executed in finally
        expect(mockCursor.destroyCalled).toBe(true);
        expect(res.writableEnded).toBe(false);
      });

      // 5. Response/write error
      it('5. Response/write error: aborts export, cleans up cursor, and keeps primary error observable', async () => {
        const mockCursor = createMockCursor(mockResponsesData);
        setupMockCursorFind(mockCursor);

        const res = new MockResponse();
        let writeCount = 0;
        res.writeFn = () => {
          writeCount++;
          if (writeCount === 2) {
            return false; // Backpressure on Row 1
          }
          return true;
        };

        const streamError = new Error('EPIPE: client write pipe destroyed');

        const exportPromise = exportResponses(req, res, next);
        await new Promise((r) => setImmediate(r));

        expect(writeCount).toBe(2);

        // Emit error on response while waiting for drain
        res.emit('error', streamError);

        await exportPromise;

        // Export aborted, cursor cleanup initiated
        expect(mockCursor.destroyCalled).toBe(true);
        expect(res.destroyed).toBe(true);
        expect(res.destroyError).toBe(streamError);
        // No subsequent rows written
        expect(writeCount).toBe(2);
      });

      // 6. Cleanup failure
      describe('6. Cleanup failure handling', () => {
        it('does not mask earlier export error when cursor destroy throws synchronously', async () => {
          const primaryError = new Error('Primary database streaming error');
          const cleanupError = new Error('Cursor destroy synchronous crash');

          const mockCursor = {
            destroyed: false,
            destroyCalled: false,
            destroy: vi.fn(() => {
              mockCursor.destroyed = true;
              mockCursor.destroyCalled = true;
              throw cleanupError;
            }),
            // eslint-disable-next-line require-yield
            async *[Symbol.asyncIterator]() {
              throw primaryError;
            }
          };
          setupMockCursorFind(mockCursor);

          const res = new MockResponse();
          res.writeFn = () => true;

          const loggerErrorSpy = vi.spyOn(logger, 'error');

          // exportResponses must settle without throwing or masking
          await expect(exportResponses(req, res, next)).resolves.toBeUndefined();

          expect(mockCursor.destroyCalled).toBe(true);
          // Primary error remains observable on res.destroy
          expect(res.destroyed).toBe(true);
          expect(res.destroyError).toBe(primaryError);

          // Cleanup failure logged separately
          const cleanupLog = loggerErrorSpy.mock.calls.find(
            (call) => call[0] === 'export.cursor_destroy_failed'
          );
          expect(cleanupLog).toBeDefined();
          expect(cleanupLog[1]).toBe(cleanupError);
        });

        it('does not cause unhandled promise rejection when cursor destroy rejects asynchronously', async () => {
          const primaryError = new Error('Primary streaming abort');
          const asyncCleanupError = new Error('Cursor destroy async rejection');

          const mockCursor = {
            destroyed: false,
            destroyCalled: false,
            destroy: vi.fn(() => {
              mockCursor.destroyed = true;
              mockCursor.destroyCalled = true;
              return Promise.reject(asyncCleanupError);
            }),
            // eslint-disable-next-line require-yield
            async *[Symbol.asyncIterator]() {
              throw primaryError;
            }
          };
          setupMockCursorFind(mockCursor);

          const res = new MockResponse();
          res.writeFn = () => true;

          const loggerErrorSpy = vi.spyOn(logger, 'error');

          await expect(exportResponses(req, res, next)).resolves.toBeUndefined();

          expect(mockCursor.destroyCalled).toBe(true);
          expect(res.destroyed).toBe(true);
          expect(res.destroyError).toBe(primaryError);

          const cleanupLog = loggerErrorSpy.mock.calls.find(
            (call) => call[0] === 'export.cursor_destroy_failed'
          );
          expect(cleanupLog).toBeDefined();
          expect(cleanupLog[1]).toBe(asyncCleanupError);
        });
      });

      // 7. Listener cleanup
      describe('7. Listener cleanup verification', () => {
        it('removes temporary drain, close, and error listeners when backpressure resolves via drain', async () => {
          const mockCursor = createMockCursor(mockResponsesData);
          setupMockCursorFind(mockCursor);

          const res = new MockResponse();
          let writeCount = 0;
          let simulateBackpressure = true;

          res.writeFn = () => {
            writeCount++;
            if (writeCount === 2 && simulateBackpressure) {
              return false;
            }
            return true;
          };

          const exportPromise = exportResponses(req, res, next);
          await new Promise((r) => setImmediate(r));

          // During active backpressure:
          // drain: 1, error: 1, close: 2 (1 handleClientDisconnect + 1 writeChunk)
          expect(res.listenerCount('drain')).toBe(1);
          expect(res.listenerCount('error')).toBe(1);
          expect(res.listenerCount('close')).toBe(2);

          simulateBackpressure = false;
          res.emit('drain');

          await exportPromise;

          // After normal export completion, all listeners are removed
          expect(res.listenerCount('drain')).toBe(0);
          expect(res.listenerCount('error')).toBe(0);
          expect(res.listenerCount('close')).toBe(0);
        });

        it('removes temporary drain, close, and error listeners when backpressure resolves via close', async () => {
          const mockCursor = createMockCursor(mockResponsesData);
          setupMockCursorFind(mockCursor);

          const res = new MockResponse();
          let writeCount = 0;
          res.writeFn = () => {
            writeCount++;
            if (writeCount === 2) return false;
            return true;
          };

          const exportPromise = exportResponses(req, res, next);
          await new Promise((r) => setImmediate(r));

          expect(res.listenerCount('drain')).toBe(1);
          expect(res.listenerCount('error')).toBe(1);
          expect(res.listenerCount('close')).toBe(2);

          res.emit('close');

          await exportPromise;

          expect(res.listenerCount('drain')).toBe(0);
          expect(res.listenerCount('error')).toBe(0);
          expect(res.listenerCount('close')).toBe(0);
        });

        it('removes temporary drain, close, and error listeners when backpressure resolves via error', async () => {
          const mockCursor = createMockCursor(mockResponsesData);
          setupMockCursorFind(mockCursor);

          const res = new MockResponse();
          let writeCount = 0;
          res.writeFn = () => {
            writeCount++;
            if (writeCount === 2) return false;
            return true;
          };

          const exportPromise = exportResponses(req, res, next);
          await new Promise((r) => setImmediate(r));

          expect(res.listenerCount('drain')).toBe(1);
          expect(res.listenerCount('error')).toBe(1);
          expect(res.listenerCount('close')).toBe(2);

          res.emit('error', new Error('Transient write stream failure'));

          await exportPromise;

          expect(res.listenerCount('drain')).toBe(0);
          expect(res.listenerCount('error')).toBe(0);
          expect(res.listenerCount('close')).toBe(0);
        });
      });
    });
  });

  describe('Stage 4.3.5: API Privacy, Concurrency Hardening & Operational Resilience', () => {
    let owner, ownerToken, testForm, testQuestion;

    beforeEach(async () => {
      owner = await User.create({
        name: 'Stage435 Owner',
        email: `stage435_${Date.now()}@test.com`,
        password: 'password123'
      });
      ownerToken = jwt.sign({ id: owner._id }, process.env.JWT_SECRET || 'testsecret');

      testForm = await Form.create({
        ownerId: owner._id,
        title: 'Stage 4.3.5 Form',
        status: 'published'
      });

      testQuestion = await Question.create({
        formId: testForm._id,
        type: 'short_text',
        label: 'Feedback',
        required: false,
        order: 0
      });
    });

    describe('Batch A: API Privacy and Read Rate Limiting', () => {
      it('Batch A1: excludes cleartext respondent IP (submittedBy) from getResponses projection', async () => {
        const resp = await Response.create({
          formId: testForm._id,
          answers: [{ questionId: testQuestion._id, value: 'Great service' }],
          submittedBy: '203.0.113.42'
        });

        const res = await request(app)
          .get(`/api/responses/${testForm._id}`)
          .set('Cookie', [`token=${ownerToken}`]);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].submittedBy).toBeUndefined();

        // Verify underlying database record still retains submittedBy for audit logs
        const dbRecord = await Response.findById(resp._id);
        expect(dbRecord.submittedBy).toBe('203.0.113.42');
      });

      it('Batch A2: userResponseReadLimiter and userFileDownloadLimiter are configured', async () => {
        expect(userResponseReadLimiter).toBeDefined();
        expect(typeof userResponseReadLimiter).toBe('function');
        expect(userFileDownloadLimiter).toBeDefined();
        expect(typeof userFileDownloadLimiter).toBe('function');

        const res = await request(app)
          .get(`/api/responses/${testForm._id}`)
          .set('Cookie', [`token=${ownerToken}`]);

        expect(res.status).toBe(200);
        expect(res.headers['ratelimit-limit']).toBeDefined();
      });
    });

    describe('Batch B: Concurrency Hardening and Idempotency', () => {
      it('Batch B1: aborts submission with 409 and deletes S3 files if form enters deleting status before persistence', async () => {
        const uploadSpy = vi
          .spyOn(storageService, 'uploadFile')
          .mockResolvedValue('forms/test/key.pdf');
        const deleteSpy = vi.spyOn(storageService, 'deleteFile').mockResolvedValue();

        // Simulate form being deleted right after preValidateSubmissionForm
        // Form status is modified to 'deleting' in DB
        testForm.status = 'deleting';
        await testForm.save();

        // Pass stale req.targetForm simulating multipart upload delay
        const mockReq = {
          params: { formId: testForm._id.toString() },
          targetForm: { _id: testForm._id, status: 'published', ownerId: owner._id },
          body: {
            answers: JSON.stringify([{ questionId: testQuestion._id.toString(), value: 'Test' }])
          },
          files: [],
          headers: {},
          ip: '127.0.0.1'
        };
        const mockRes = {
          statusCode: null,
          body: null,
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(data) {
            this.body = data;
            return this;
          }
        };
        const next = vi.fn();

        await submitResponse(mockReq, mockRes, next);

        expect(mockRes.statusCode).toBe(409);
        expect(mockRes.body.success).toBe(false);
        expect(mockRes.body.message).toContain('Form is currently being deleted');

        // Confirm zero responses were created in the database
        const count = await Response.countDocuments({ formId: testForm._id });
        expect(count).toBe(0);

        uploadSpy.mockRestore();
        deleteSpy.mockRestore();
      });

      it('Batch B3: sequential retry with same key and identical payload returns existing result (HTTP 200)', async () => {
        const idempotencyKey = `idem_${Date.now()}_abc`;

        const res1 = await request(app)
          .post(`/api/responses/${testForm._id}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            answers: [{ questionId: testQuestion._id, value: 'Initial submit' }]
          });

        expect(res1.status).toBe(201);
        expect(res1.body.success).toBe(true);
        const firstResponseId = res1.body.data.id;

        // Second submission with identical Idempotency-Key and identical payload
        const res2 = await request(app)
          .post(`/api/responses/${testForm._id}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            answers: [{ questionId: testQuestion._id, value: 'Initial submit' }]
          });

        expect(res2.status).toBe(200);
        expect(res2.body.success).toBe(true);
        expect(res2.body.message).toBe('Response already submitted');
        expect(res2.body.data.id).toBe(firstResponseId);

        // Confirm only 1 response document was persisted
        const count = await Response.countDocuments({ formId: testForm._id });
        expect(count).toBe(1);
      });

      it('Batch B3: same idempotency key with different payload returns 409 Conflict', async () => {
        const idempotencyKey = `idem_diff_${Date.now()}`;

        const res1 = await request(app)
          .post(`/api/responses/${testForm._id}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            answers: [{ questionId: testQuestion._id, value: 'Original Payload' }]
          });
        expect(res1.status).toBe(201);

        // Reusing same key with DIFFERENT payload must be rejected
        const res2 = await request(app)
          .post(`/api/responses/${testForm._id}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            answers: [{ questionId: testQuestion._id, value: 'Different Modified Payload' }]
          });

        expect(res2.status).toBe(409);
        expect(res2.body.success).toBe(false);
        expect(res2.body.message).toMatch(/different submission payload/i);

        // Confirm only original response was persisted
        const count = await Response.countDocuments({ formId: testForm._id });
        expect(count).toBe(1);
      });

      it('Batch B3: handles two simultaneous concurrent submissions with the same key deterministically', async () => {
        const idempotencyKey = `idem_concurrent_${Date.now()}`;
        const payload = {
          answers: [{ questionId: testQuestion._id, value: 'Concurrent Test' }]
        };

        const [res1, res2] = await Promise.all([
          request(app)
            .post(`/api/responses/${testForm._id}`)
            .set('Idempotency-Key', idempotencyKey)
            .send(payload),
          request(app)
            .post(`/api/responses/${testForm._id}`)
            .set('Idempotency-Key', idempotencyKey)
            .send(payload)
        ]);

        const statuses = [res1.status, res2.status].sort();
        expect(statuses).toEqual([200, 201]);

        expect(res1.body.data.id).toBe(res2.body.data.id);
        const count = await Response.countDocuments({ formId: testForm._id, idempotencyKey });
        expect(count).toBe(1);
      });

      it('Batch B3: requests without an idempotency key create separate responses', async () => {
        const payload = {
          answers: [{ questionId: testQuestion._id, value: 'Non-idempotent submission' }]
        };

        const res1 = await request(app).post(`/api/responses/${testForm._id}`).send(payload);
        const res2 = await request(app).post(`/api/responses/${testForm._id}`).send(payload);

        expect(res1.status).toBe(201);
        expect(res2.status).toBe(201);
        expect(res1.body.data.id).not.toBe(res2.body.data.id);
      });
    });

    describe('Batch C: S3 Disconnect Cleanup and Asynchronous Email', () => {
      it('Batch C4: submission responds immediately without blocking on EmailService', async () => {
        const sendEmailSpy = vi
          .spyOn(EmailService.prototype, 'sendEmail')
          .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500)));

        const startTime = Date.now();
        const res = await request(app)
          .post(`/api/responses/${testForm._id}`)
          .send({
            answers: [{ questionId: testQuestion._id, value: 'Non-blocking email test' }]
          });

        const elapsed = Date.now() - startTime;
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        // Elapsed time should be well below the 500ms artificial email delay
        expect(elapsed).toBeLessThan(400);

        sendEmailSpy.mockRestore();
      });

      it('Batch C1/C2: body stream inactivity watchdog destroys stalled stream', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const stalledStream = new Readable({
          read() {
            // Emits initial chunk then stalls indefinitely
            this.push('initial-chunk');
          }
        });

        const fileQuestion = await Question.create({
          formId: testForm._id,
          type: 'file',
          label: 'Attachment',
          order: 1
        });

        const fileResponse = await Response.create({
          formId: testForm._id,
          answers: [
            {
              questionId: fileQuestion._id,
              value: {
                key: `forms/${testForm._id}/responses/stall-test.pdf`,
                originalName: 'stall.pdf',
                mimeType: 'application/pdf',
                size: 100
              }
            }
          ]
        });

        vi.spyOn(storageService, 'getFileStream').mockResolvedValueOnce({
          stream: stalledStream,
          contentType: 'application/pdf',
          contentLength: 100
        });

        const { PassThrough } = await import('stream');
        const resStream = new PassThrough();
        resStream.setHeader = vi.fn();
        resStream.removeHeader = vi.fn();
        resStream.headersSent = true;

        const req = {
          params: {
            formId: testForm._id.toString(),
            responseId: fileResponse._id.toString(),
            questionId: fileQuestion._id.toString()
          },
          user: { id: testForm.ownerId.toString() }
        };
        const next = vi.fn();

        downloadResponseFile(req, resStream, next);
        await new Promise((resolve) => resStream.once('pipe', resolve));

        // Advance timers to trigger the 30s inactivity watchdog
        await vi.advanceTimersByTimeAsync(30000);

        expect(stalledStream.destroyed).toBe(true);
        vi.useRealTimers();
      });

      it('Batch C2: client disconnect mid-stream destroys S3 stream and logs info', async () => {
        let streamDestroyed = false;
        const activeStream = new Readable({
          read() {
            this.push('streaming-data');
          },
          destroy(err, cb) {
            streamDestroyed = true;
            cb(err);
          }
        });

        const fileQuestion = await Question.create({
          formId: testForm._id,
          type: 'file',
          label: 'Attachment 2',
          order: 2
        });

        const fileResponse = await Response.create({
          formId: testForm._id,
          answers: [
            {
              questionId: fileQuestion._id,
              value: {
                key: `forms/${testForm._id}/responses/disc-test.pdf`,
                originalName: 'disc.pdf',
                mimeType: 'application/pdf',
                size: 200
              }
            }
          ]
        });

        vi.spyOn(storageService, 'getFileStream').mockResolvedValueOnce({
          stream: activeStream,
          contentType: 'application/pdf',
          contentLength: 200
        });

        const { PassThrough } = await import('stream');
        const resStream = new PassThrough();
        resStream.setHeader = vi.fn();
        resStream.removeHeader = vi.fn();
        resStream.headersSent = true;

        const req = {
          params: {
            formId: testForm._id.toString(),
            responseId: fileResponse._id.toString(),
            questionId: fileQuestion._id.toString()
          },
          user: { id: testForm.ownerId.toString() }
        };
        const next = vi.fn();

        downloadResponseFile(req, resStream, next);
        await new Promise((resolve) => resStream.once('pipe', resolve));

        // Client disconnects
        resStream.emit('close');

        expect(activeStream.destroyed).toBe(true);
        expect(streamDestroyed).toBe(true);
      });
    });
  });

  describe('Stage 4.3.6.2: Submission Email Notification Failure Resilience Suite (5 Tests)', () => {
    it('Email Failure Test 1: Email provider rejection after successful response save does not fail submission', async () => {
      const emailSpy = vi
        .spyOn(EmailService.prototype, 'sendEmail')
        .mockRejectedValueOnce(new Error('Resend provider HTTP 500 error'));
      const warnSpy = vi.spyOn(logger, 'warn');

      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id.toString(), value: 'Alice' },
            { questionId: qEmail._id.toString(), value: 'alice@example.com' },
            { questionId: qChoice._id.toString(), value: 'Blue' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.id).toBeDefined();

      // Wait for setImmediate and User.findById to settle
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(emailSpy).toHaveBeenCalled();
      const savedResponse = await Response.findById(res.body.data.id);
      expect(savedResponse).not.toBeNull();
      expect(savedResponse.formId.toString()).toBe(form._id.toString());
      expect(warnSpy).toHaveBeenCalledWith(
        'notification.email_failed',
        expect.any(Error),
        expect.objectContaining({ formId: form._id })
      );
    });

    it('Email Failure Test 2: Synchronous email invocation failure in background does not fail submission', async () => {
      vi.spyOn(EmailService.prototype, 'sendEmail').mockImplementationOnce(() => {
        throw new Error('Synchronous crash in email dispatch');
      });
      const warnSpy = vi.spyOn(logger, 'warn');

      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id.toString(), value: 'Bob' },
            { questionId: qEmail._id.toString(), value: 'bob@example.com' },
            { questionId: qChoice._id.toString(), value: 'Blue' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      // Wait for setImmediate and User.findById to settle
      await new Promise((resolve) => setTimeout(resolve, 30));

      const count = await Response.countDocuments({ formId: form._id });
      expect(count).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        'notification.email_failed',
        expect.any(Error),
        expect.objectContaining({ formId: form._id })
      );
    });

    it('Email Failure Test 3: Missing form owner gracefully completes submission without email dispatch or crash', async () => {
      // Create a form with a non-existent owner ID
      const missingOwnerId = new mongoose.Types.ObjectId();
      const orphanForm = await Form.create({
        ownerId: missingOwnerId,
        title: 'Orphan Owner Form',
        status: 'published'
      });
      const orphanQ = await Question.create({
        formId: orphanForm._id,
        type: 'short_text',
        label: 'Feedback',
        required: true,
        order: 0
      });

      const emailSpy = vi.spyOn(EmailService.prototype, 'sendEmail');

      const res = await request(app)
        .post(`/api/responses/${orphanForm._id}`)
        .send({
          answers: [{ questionId: orphanQ._id.toString(), value: 'Great service' }]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      await new Promise((resolve) => setImmediate(resolve));

      // No email should be sent if owner is missing
      expect(emailSpy).not.toHaveBeenCalled();
      const saved = await Response.findOne({ formId: orphanForm._id });
      expect(saved).not.toBeNull();
    });

    it('Email Failure Test 4: Email timeout after HTTP response has been returned does not mutate response or throw', async () => {
      vi.spyOn(EmailService.prototype, 'sendEmail').mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('TimeoutError: Email request timed out after 5000ms');
      });

      const res = await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [
            { questionId: qText._id.toString(), value: 'Charlie' },
            { questionId: qEmail._id.toString(), value: 'charlie@example.com' },
            { questionId: qChoice._id.toString(), value: 'Blue' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      // Wait 50ms for asynchronous timeout to fire in background
      await new Promise((resolve) => setTimeout(resolve, 50));

      const responses = await Response.find({ formId: form._id });
      expect(responses).toHaveLength(1);
      expect(responses[0]._id.toString()).toBe(res.body.data.id);
    });

    it('Email Failure Test 5: Late asynchronous rejection does not trigger unhandled promise rejections or duplicate responses', async () => {
      let unhandledCaught = null;
      const unhandledHandler = (err) => {
        unhandledCaught = err;
      };
      process.on('unhandledRejection', unhandledHandler);

      try {
        vi.spyOn(EmailService.prototype, 'sendEmail').mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('Late asynchronous provider rejection');
        });

        const res = await request(app)
          .post(`/api/responses/${form._id}`)
          .send({
            answers: [
              { questionId: qText._id.toString(), value: 'Diana' },
              { questionId: qEmail._id.toString(), value: 'diana@example.com' },
              { questionId: qChoice._id.toString(), value: 'Blue' }
            ]
          });

        expect(res.status).toBe(201);

        // Wait 40ms to ensure the async rejection settles
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(unhandledCaught).toBeNull();
        const count = await Response.countDocuments({ formId: form._id });
        expect(count).toBe(1);
      } finally {
        process.removeListener('unhandledRejection', unhandledHandler);
      }
    });
  });

  describe('Maintenance Task 2: Secure Email HTML Escaping (AUD-SEC-01)', () => {
    it('escapes malicious script tags in form title for email HTML while preserving subject', async () => {
      const maliciousTitle = '<script>alert(1)</script>';
      const xssForm = await Form.create({
        ownerId: form.ownerId,
        title: maliciousTitle,
        status: 'published'
      });
      const q = await Question.create({
        formId: xssForm._id,
        type: 'short_text',
        label: 'Feedback',
        required: true,
        order: 0
      });

      const emailSpy = vi
        .spyOn(EmailService.prototype, 'sendEmail')
        .mockResolvedValueOnce({ success: true });

      const res = await request(app)
        .post(`/api/responses/${xssForm._id}`)
        .send({
          answers: [{ questionId: q._id.toString(), value: 'Testing XSS' }]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      // Wait for setImmediate and User.findById to settle
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(emailSpy).toHaveBeenCalledTimes(1);
      const emailOptions = emailSpy.mock.calls[0][0];

      // Plain text subject preserves original title
      expect(emailOptions.subject).toBe(`New submission for form: ${maliciousTitle}`);

      // HTML body encodes tags as text and does not interpret script tag
      expect(emailOptions.html).toContain('<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>');
      expect(emailOptions.html).not.toContain('<script>');
      expect(emailOptions.html).not.toContain('</script>');
    });

    it('escapes complex titles containing angle brackets, quotes, and ampersands', async () => {
      const complexTitle = 'Client Intake <Q1> & "Review"';
      const complexForm = await Form.create({
        ownerId: form.ownerId,
        title: complexTitle,
        status: 'published'
      });
      const q = await Question.create({
        formId: complexForm._id,
        type: 'short_text',
        label: 'Feedback',
        required: true,
        order: 0
      });

      const emailSpy = vi
        .spyOn(EmailService.prototype, 'sendEmail')
        .mockResolvedValueOnce({ success: true });

      const res = await request(app)
        .post(`/api/responses/${complexForm._id}`)
        .send({
          answers: [{ questionId: q._id.toString(), value: 'Testing Complex Title' }]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(emailSpy).toHaveBeenCalledTimes(1);
      const emailOptions = emailSpy.mock.calls[0][0];

      // Plain text subject preserves original title
      expect(emailOptions.subject).toBe(`New submission for form: ${complexTitle}`);

      // HTML body encodes <, >, &, and "
      expect(emailOptions.html).toContain(
        '<strong>Client Intake &lt;Q1&gt; &amp; &quot;Review&quot;</strong>'
      );
      expect(emailOptions.html).not.toContain('<Q1>');
      expect(emailOptions.html).not.toContain('"Review"');
    });

    it('renders ordinary titles cleanly in email notification HTML and subject', async () => {
      const normalTitle = 'Customer Satisfaction Survey 2026';
      const normalForm = await Form.create({
        ownerId: form.ownerId,
        title: normalTitle,
        status: 'published'
      });
      const q = await Question.create({
        formId: normalForm._id,
        type: 'short_text',
        label: 'Feedback',
        required: true,
        order: 0
      });

      const emailSpy = vi
        .spyOn(EmailService.prototype, 'sendEmail')
        .mockResolvedValueOnce({ success: true });

      const res = await request(app)
        .post(`/api/responses/${normalForm._id}`)
        .send({
          answers: [{ questionId: q._id.toString(), value: 'Clean feedback' }]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(emailSpy).toHaveBeenCalledTimes(1);
      const emailOptions = emailSpy.mock.calls[0][0];

      expect(emailOptions.subject).toBe(`New submission for form: ${normalTitle}`);
      expect(emailOptions.html).toContain(`<strong>${normalTitle}</strong>`);
      expect(emailOptions.html).toContain(
        `<a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard">View Responses</a>`
      );
    });

    it('escapes single quotes correctly in form titles', async () => {
      const titleWithSingleQuote = "O'Connor & Sons 'Priority' Intake";
      const quoteForm = await Form.create({
        ownerId: form.ownerId,
        title: titleWithSingleQuote,
        status: 'published'
      });
      const q = await Question.create({
        formId: quoteForm._id,
        type: 'short_text',
        label: 'Feedback',
        required: true,
        order: 0
      });

      const emailSpy = vi
        .spyOn(EmailService.prototype, 'sendEmail')
        .mockResolvedValueOnce({ success: true });

      const res = await request(app)
        .post(`/api/responses/${quoteForm._id}`)
        .send({
          answers: [{ questionId: q._id.toString(), value: 'Quote feedback' }]
        });

      expect(res.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(emailSpy).toHaveBeenCalledTimes(1);
      const emailOptions = emailSpy.mock.calls[0][0];
      expect(emailOptions.html).toContain(
        '<strong>O&#39;Connor &amp; Sons &#39;Priority&#39; Intake</strong>'
      );
    });

    it('escapeHtml helper handles all entity requirements and boundary inputs', () => {
      expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(escapeHtml('Client Intake <Q1> & "Review"')).toBe(
        'Client Intake &lt;Q1&gt; &amp; &quot;Review&quot;'
      );
      expect(escapeHtml("Tom's & Jerry's")).toBe('Tom&#39;s &amp; Jerry&#39;s');
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(42)).toBe('42');
    });
  });
});
