import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../models/user.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import authRoutes from '../routes/authRoutes.js';
import formRoutes from '../routes/formRoutes.js';
import responseRoutes from '../routes/responseRoutes.js';
import { csrfProtection, isTrustedOrigin } from './csrfProtection.js';
import { createGracefulShutdown } from '../server.js';
import { errorHandler } from './errorHandler.js';

let mongoServer;
let testApp;
let validUser;
let authToken;
let refreshTokenVal;

const TRUSTED_ORIGIN = 'http://localhost:5173';
const UNTRUSTED_ORIGIN = 'http://malicious-site.example.com';

beforeAll(async () => {
  process.env.JWT_SECRET = 'test_jwt_secret_key_123456';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_key_123456';
  process.env.FRONTEND_URL = TRUSTED_ORIGIN;
  process.env.NODE_ENV = 'production';

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  // Build full integration app mirroring server.js pipeline
  testApp = express();
  testApp.use(express.json({ limit: '100kb' }));
  testApp.use(express.urlencoded({ extended: true, limit: '100kb' }));
  testApp.use(cookieParser());
  testApp.use(csrfProtection);

  // Health and readiness probes
  testApp.get('/health', (req, res) => {
    res.status(200).json({ success: true, status: 'live' });
  });

  testApp.get('/health/ready', (req, res) => {
    const isDbReady = mongoose.connection.readyState === 1;
    res.status(isDbReady ? 200 : 503).json({
      success: isDbReady,
      status: isDbReady ? 'ready' : 'not_ready',
      database: isDbReady ? 'connected' : 'disconnected'
    });
  });

  testApp.use('/api/auth', authRoutes);
  testApp.use('/api/forms', formRoutes);
  testApp.use('/api/responses', responseRoutes);
  testApp.use(errorHandler);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await Form.deleteMany({});
  await Question.deleteMany({});
  await Response.deleteMany({});

  validUser = await User.create({
    name: 'CSRF Test User',
    email: 'csrf@test.com',
    password: 'password123'
  });

  const sessionId = 'session_test_12345';
  authToken = jwt.sign(
    { id: validUser._id, sessionId },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  refreshTokenVal = jwt.sign(
    { id: validUser._id, sessionId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '7d' }
  );

  // Register session with correct SHA-256 hash in user model
  const tokenHash = crypto.createHash('sha256').update(refreshTokenVal).digest('hex');
  await User.findByIdAndUpdate(validUser._id, {
    $push: {
      refreshTokens: `${sessionId}:${tokenHash}`
    }
  });
});

describe('CSRF Protection and Origin Validation', () => {
  describe('Origin Parsing and Matching Helpers', () => {
    it('correctly matches configured trusted origins', () => {
      expect(isTrustedOrigin(TRUSTED_ORIGIN)).toBe(true);
      expect(isTrustedOrigin('http://localhost:5173/')).toBe(true);
      expect(isTrustedOrigin(UNTRUSTED_ORIGIN)).toBe(false);
      expect(isTrustedOrigin('null')).toBe(false);
      expect(isTrustedOrigin(null)).toBe(false);
      expect(isTrustedOrigin('')).toBe(false);
      expect(isTrustedOrigin('invalid-url')).toBe(false);
      expect(isTrustedOrigin('http://localhost:5173.attacker.com')).toBe(false);
      expect(isTrustedOrigin('http://attacker.com/localhost:5173')).toBe(false);
    });
  });

  describe('Safe HTTP Methods (GET, HEAD, OPTIONS)', () => {
    it('allows GET requests regardless of Origin header', async () => {
      const res = await request(testApp)
        .get('/health')
        .set('Origin', UNTRUSTED_ORIGIN);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('live');
    });

    it('allows GET requests with missing Origin header', async () => {
      const res = await request(testApp).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('live');
    });
  });

  describe('Authenticated State-Changing Routes (Forms Mutation)', () => {
    it('allows authenticated POST when Origin matches trusted frontend', async () => {
      const res = await request(testApp)
        .post('/api/forms')
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', [`token=${authToken}`])
        .send({ title: 'New Legitimate Form' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('New Legitimate Form');
    });

    it('rejects authenticated POST when Origin is untrusted', async () => {
      const res = await request(testApp)
        .post('/api/forms')
        .set('Origin', UNTRUSTED_ORIGIN)
        .set('Cookie', [`token=${authToken}`])
        .send({ title: 'Malicious Cross-Site Form' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/forbidden|untrusted/i);

      // Verify no form was created in database
      const formsCount = await Form.countDocuments();
      expect(formsCount).toBe(0);
    });

    it('rejects authenticated POST when Origin is explicitly null', async () => {
      const res = await request(testApp)
        .post('/api/forms')
        .set('Origin', 'null')
        .set('Cookie', [`token=${authToken}`])
        .send({ title: 'Sandboxed Null Origin Form' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects authenticated POST when Origin is missing and auth cookies are present', async () => {
      const res = await request(testApp)
        .post('/api/forms')
        .set('Cookie', [`token=${authToken}`])
        .send({ title: 'Missing Origin With Cookie' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/forbidden|untrusted/i);
    });

    it('rejects URL-encoded form POST from untrusted origin (simulating browser HTML form CSRF)', async () => {
      const res = await request(testApp)
        .post('/api/forms')
        .set('Origin', UNTRUSTED_ORIGIN)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('Cookie', [`token=${authToken}`])
        .send('title=Forged+Form+Title');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);

      const count = await Form.countDocuments();
      expect(count).toBe(0);
    });

    it('allows non-browser API clients using Bearer authentication without cookies', async () => {
      const res = await request(testApp)
        .post('/api/forms')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'CLI Created Form' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('CLI Created Form');
    });

    it('rejects authenticated POST when Origin is untrusted even if Bearer token is provided', async () => {
      const res = await request(testApp)
        .post('/api/forms')
        .set('Origin', UNTRUSTED_ORIGIN)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Cross-Site Form With Stolen Bearer' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/forbidden|untrusted/i);
    });

    it('rejects state-changing POST when cookies are present alongside Bearer token with missing Origin', async () => {
      const res = await request(testApp)
        .post('/api/forms')
        .set('Cookie', [`token=${authToken}`])
        .set('Authorization', `Bearer ${authToken}`)
        .send({ title: 'Ambiguous Auth Missing Origin' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/forbidden|untrusted/i);
    });
  });

  describe('Session Mutation Routes (Refresh and Logout)', () => {
    it('allows refresh request from trusted Origin', async () => {
      const res = await request(testApp)
        .post('/api/auth/refresh')
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', [`refreshToken=${refreshTokenVal}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects refresh request from untrusted Origin', async () => {
      const res = await request(testApp)
        .post('/api/auth/refresh')
        .set('Origin', UNTRUSTED_ORIGIN)
        .set('Cookie', [`refreshToken=${refreshTokenVal}`]);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('rejects refresh request with missing Origin when cookies are present', async () => {
      const res = await request(testApp)
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=${refreshTokenVal}`]);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('allows logout request from trusted Origin', async () => {
      const res = await request(testApp)
        .post('/api/auth/logout')
        .set('Origin', TRUSTED_ORIGIN)
        .set('Cookie', [`refreshToken=${refreshTokenVal}`]);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('rejects logout request from untrusted Origin', async () => {
      const res = await request(testApp)
        .post('/api/auth/logout')
        .set('Origin', UNTRUSTED_ORIGIN)
        .set('Cookie', [`refreshToken=${refreshTokenVal}`]);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('allows programmatic Bearer logout without cookies and without Origin', async () => {
      const res = await request(testApp)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Public Form Submission Access Model', () => {
    let publishedForm;
    let question;

    beforeEach(async () => {
      publishedForm = await Form.create({
        title: 'Public Feedback Form',
        ownerId: validUser._id,
        status: 'published'
      });

      question = await Question.create({
        formId: publishedForm._id,
        type: 'short_text',
        label: 'Your Feedback',
        required: true,
        order: 0
      });

      publishedForm.questions = [question._id];
      await publishedForm.save();
    });

    it('allows anonymous respondent to submit a form response without Origin header', async () => {
      const res = await request(testApp)
        .post(`/api/responses/${publishedForm._id}`)
        .send({
          answers: [
            { questionId: question._id.toString(), value: 'Great platform!' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const count = await Response.countDocuments({ formId: publishedForm._id });
      expect(count).toBe(1);
    });

    it('allows respondent to submit form response from external embedded site Origin', async () => {
      const res = await request(testApp)
        .post(`/api/responses/${publishedForm._id}`)
        .set('Origin', 'https://embedded-partner.com')
        .send({
          answers: [
            { questionId: question._id.toString(), value: 'Embedded response' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('allows anonymous respondent to submit a form response with trailing slash', async () => {
      const res = await request(testApp)
        .post(`/api/responses/${publishedForm._id}/`)
        .set('Origin', 'https://embedded-partner.com')
        .send({
          answers: [
            { questionId: question._id.toString(), value: 'Embedded response with trailing slash' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('allows respondent to submit form response with query strings attached', async () => {
      const res = await request(testApp)
        .post(`/api/responses/${publishedForm._id}/?ref=newsletter&utm_source=email`)
        .send({
          answers: [
            { questionId: question._id.toString(), value: 'Response with query string' }
          ]
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it('does not exempt subpaths such as export or file endpoints', async () => {
      const res = await request(testApp)
        .post(`/api/responses/${publishedForm._id}/export`)
        .set('Origin', UNTRUSTED_ORIGIN)
        .send({});

      expect(res.status).toBe(403);
    });
  });

  describe('Database Readiness Probe', () => {
    it('returns HTTP 200 when MongoDB is connected', async () => {
      const res = await request(testApp).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('ready');
      expect(res.body.database).toBe('connected');
    });

    it('returns HTTP 503 when MongoDB is not connected', async () => {
      const spy = vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
      try {
        const res = await request(testApp).get('/health/ready');
        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.status).toBe('not_ready');
        expect(res.body.database).toBe('disconnected');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('Graceful Shutdown', () => {
    it('invokes exitFn(0) exactly once on successful normal shutdown', async () => {
      let serverCloseCount = 0;
      let dbCloseCount = 0;
      const mockExit = vi.fn();

      const mockServer = {
        close: (cb) => {
          serverCloseCount += 1;
          cb(null);
        }
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {
            dbCloseCount += 1;
          }
        }
      };

      const shutdown = createGracefulShutdown(mockServer, mockMongoose, mockExit);
      await shutdown('SIGTERM');

      expect(serverCloseCount).toBe(1);
      expect(dbCloseCount).toBe(1);
      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('ignores duplicate shutdown signals and does not start parallel cleanup', async () => {
      let serverCloseCount = 0;
      const mockExit = vi.fn();

      const mockServer = {
        close: (cb) => {
          serverCloseCount += 1;
          cb(null);
        }
      };
      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {}
        }
      };

      const shutdown = createGracefulShutdown(mockServer, mockMongoose, mockExit);

      const first = shutdown('SIGTERM');
      const second = shutdown('SIGTERM');
      const third = shutdown('SIGINT');

      await Promise.all([first, second, third]);

      expect(serverCloseCount).toBe(1);
      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('exits with code 1 when shutdown is triggered by an unhandled rejection', async () => {
      const mockExit = vi.fn();
      const mockServer = { close: (cb) => cb(null) };
      const mockMongoose = { connection: { readyState: 1, close: async () => {} } };

      const shutdown = createGracefulShutdown(mockServer, mockMongoose, mockExit);
      await shutdown('unhandledRejection');

      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('exits with code 1 when shutdown is triggered by an uncaughtException', async () => {
      const mockExit = vi.fn();
      const mockServer = { close: (cb) => cb(null) };
      const mockMongoose = { connection: { readyState: 1, close: async () => {} } };

      const shutdown = createGracefulShutdown(mockServer, mockMongoose, mockExit);
      await shutdown('uncaughtException');

      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('invokes exitFn(1) exactly once on cleanup failure', async () => {
      const mockExit = vi.fn();
      const mockServer = {
        close: (cb) => {
          cb(new Error('Failed to close server'));
        }
      };
      const mockMongoose = { connection: { readyState: 1, close: async () => {} } };

      const shutdown = createGracefulShutdown(mockServer, mockMongoose, mockExit);
      await shutdown('SIGINT');

      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('invokes exitFn(1) exactly once on timeout, and ignores cleanup resolving after timeout', async () => {
      let lateCallback = null;
      const mockExit = vi.fn();

      const hangingServer = {
        close: (cb) => {
          lateCallback = cb;
        }
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {}
        }
      };

      const shutdown = createGracefulShutdown(hangingServer, mockMongoose, mockExit, 30);
      shutdown('SIGTERM');

      // Wait past timeout (30ms)
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);

      // Cleanup subsequently resolves late
      if (lateCallback) {
        lateCallback(null);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Must not invoke exitFn a second time or change exit code
      expect(mockExit).toHaveBeenCalledTimes(1);
    });

    it('ignores cleanup rejecting after timeout and does not invoke exitFn a second time', async () => {
      let lateCallback = null;
      const mockExit = vi.fn();

      const hangingServer = {
        close: (cb) => {
          lateCallback = cb;
        }
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {}
        }
      };

      const shutdown = createGracefulShutdown(hangingServer, mockMongoose, mockExit, 30);
      shutdown('SIGTERM');

      // Wait past timeout (30ms)
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);

      // Cleanup subsequently rejects late with error
      if (lateCallback) {
        lateCallback(new Error('Delayed socket close error'));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Must not invoke exitFn a second time
      expect(mockExit).toHaveBeenCalledTimes(1);
    });
  });
});
