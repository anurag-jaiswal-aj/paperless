import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import { MongoMemoryServer } from 'mongodb-memory-server';
import authRoutes from '../routes/authRoutes';
import User from '../models/user';

// Mock EmailService
vi.mock('../services/EmailService', () => {
  return {
    default: class MockEmailService {
      async sendEmail() {
        return { id: 'mocked-id' };
      }
    }
  };
});

let mongoServer;
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRoutes);

beforeEach(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  // Reset test env vars
  process.env.JWT_SECRET = 'testsecret';
  process.env.JWT_REFRESH_SECRET = 'testrefreshsecret';
});

afterEach(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  vi.clearAllMocks();
});

describe('Auth Controller', () => {
  const testUser = {
    name: 'Test User',
    email: 'test@example.com',
    password: 'password123'
  };

  describe('POST /api/auth/register', () => {
    it('registers a user successfully and sets secure HttpOnly cookies with Path=/', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send(testUser);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.email).toBe(testUser.email);
      expect(res.body.data.token).toBeUndefined(); // Token not in body
      expect(res.body.data.refreshToken).toBeUndefined();

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();

      const tokenCookie = cookies.find(c => c.startsWith('token='));
      const refreshCookie = cookies.find(c => c.startsWith('refreshToken='));

      expect(tokenCookie).toBeDefined();
      expect(tokenCookie).toContain('HttpOnly');
      expect(tokenCookie).toContain('Path=/');

      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toContain('HttpOnly');
      expect(refreshCookie).toContain('Path=/');
    });

    it('prevents duplicate email registration', async () => {
      await request(app).post('/api/auth/register').send(testUser);
      const res = await request(app).post('/api/auth/register').send(testUser);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/already exists/i);
    });

    it('validates password length', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ ...testUser, password: '123' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request(app).post('/api/auth/register').send(testUser);
    });

    it('logs in with correct credentials and returns correct cookie attributes', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: testUser.email, password: testUser.password });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeUndefined(); // Token not in body

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const tokenCookie = cookies.find(c => c.startsWith('token='));
      expect(tokenCookie).toContain('HttpOnly');
      expect(tokenCookie).toContain('Path=/');
    });

    it('rejects incorrect password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: testUser.email, password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/auth/me', () => {
    it('protects route when unauthenticated', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('returns user data when authenticated via cookie', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const cookies = loginRes.headers['set-cookie'];

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', cookies);

      expect(res.status).toBe(200);
      expect(res.body.data.email).toBe(testUser.email);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears cookies on logout with matching attributes', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(200);

      const cookies = res.headers['set-cookie'];
      const tokenCookie = cookies.find(c => c.startsWith('token=none'));
      const refreshCookie = cookies.find(c => c.startsWith('refreshToken=none'));

      expect(tokenCookie).toBeDefined();
      expect(tokenCookie).toContain('Path=/');
      expect(tokenCookie).toContain('HttpOnly');

      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toContain('Path=/');
      expect(refreshCookie).toContain('HttpOnly');
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('refreshes token using valid refresh cookie', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const cookies = loginRes.headers['set-cookie'];
      const refreshTokenCookie = cookies.find(c => c.startsWith('refreshToken='));

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [refreshTokenCookie]);

      expect(res.status).toBe(200);
      const newCookies = res.headers['set-cookie'];
      expect(newCookies.some(c => c.startsWith('token='))).toBe(true);
      expect(res.body.data?.token).toBeUndefined(); // Token not in body
    });

    it('rejects normal access token passed as refresh token', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const cookies = loginRes.headers['set-cookie'];
      const tokenCookie = cookies.find(c => c.startsWith('token='));
      // Intentionally pass the normal access token named as 'refreshToken' to see if secret validates
      const fakeRefreshCookie = tokenCookie.replace('token=', 'refreshToken=');

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [fakeRefreshCookie]);

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Invalid or expired refresh token');
    });

    it('rejects missing refresh token', async () => {
      const res = await request(app).post('/api/auth/refresh');
      expect(res.status).toBe(401);
    });
  });

  describe('Password Reset Flow', () => {
    beforeEach(async () => {
      await request(app).post('/api/auth/register').send(testUser);
    });

    it('returns generic message for forgot password to prevent email enumeration', async () => {
      const res = await request(app)
        .post('/api/auth/forgotpassword')
        .send({ email: 'nonexistent@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('password reset link has been sent');
    });

    it('generates reset token and mocks email sending', async () => {
      const res = await request(app)
        .post('/api/auth/forgotpassword')
        .send({ email: testUser.email });
      expect(res.status).toBe(200);

      const user = await User.findOne({ email: testUser.email });
      expect(user.resetPasswordToken).toBeDefined();
      expect(user.resetPasswordExpire).toBeDefined();
    });

    it('resets password with valid token and invalidates token', async () => {
      const user = await User.findOne({ email: testUser.email });
      const resetToken = user.getResetPasswordToken();
      await user.save({ validateBeforeSave: false });

      const res = await request(app)
        .put(`/api/auth/resetpassword/${resetToken}`)
        .send({ password: 'newpassword123' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Password reset successful');

      // Verify token is nullified
      const updatedUser = await User.findOne({ email: testUser.email });
      expect(updatedUser.resetPasswordToken).toBeUndefined();

      // Verify old password fails
      const loginOld = await request(app)
        .post('/api/auth/login')
        .send({ email: testUser.email, password: testUser.password });
      expect(loginOld.status).toBe(401);

      // Verify new password works
      const loginNew = await request(app)
        .post('/api/auth/login')
        .send({ email: testUser.email, password: 'newpassword123' });
      expect(loginNew.status).toBe(200);
    });

    it('rejects invalid reset token', async () => {
      const res = await request(app)
        .put('/api/auth/resetpassword/invalidtoken')
        .send({ password: 'newpassword123' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid or expired token');
    });
  });

  describe('Rate Limiting', () => {
    it('actually enforces rate limit after repeated failures', async () => {
      // Limit for forgot password is 10 requests per hour. Loop 11 times.
      let finalStatus = 200;
      for (let i = 0; i < 11; i++) {
        const res = await request(app)
          .post('/api/auth/forgotpassword')
          .send({ email: 'test@example.com' });
        finalStatus = res.status;
      }
      expect(finalStatus).toBe(429); // Too many requests
    });
  });
});
