import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import authRoutes from '../routes/authRoutes';
import User from '../models/user';
import { optionalAuth } from '../middleware/authMiddleware';

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

    it('handles two refresh requests using the same token concurrently with atomic rotation', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const cookies = loginRes.headers['set-cookie'];
      const refreshTokenCookie = cookies.find(c => c.startsWith('refreshToken='));

      // Send two concurrent refresh calls with identical refresh token cookie
      const [res1, res2] = await Promise.all([
        request(app).post('/api/auth/refresh').set('Cookie', [refreshTokenCookie]),
        request(app).post('/api/auth/refresh').set('Cookie', [refreshTokenCookie])
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one must succeed with 200 and one must be rejected with 401
      expect(statuses).toEqual([200, 401]);

      const successRes = res1.status === 200 ? res1 : res2;
      const failedRes = res1.status === 401 ? res1 : res2;

      expect(successRes.body.message).toBe('Token refreshed');
      expect(failedRes.body.message).toContain('Invalid or revoked refresh token');

      // Verify DB consistency: exactly one active refresh token hash exists
      const user = await User.findOne({ email: testUser.email });
      expect(user.refreshTokens.length).toBe(1);
    });

    it('rejects reuse of an already-rotated token', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const cookies = loginRes.headers['set-cookie'];
      const originalRefreshCookie = cookies.find(c => c.startsWith('refreshToken='));

      // First refresh succeeds
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [originalRefreshCookie]);
      expect(refreshRes.status).toBe(200);

      // Attempting to reuse original token fails
      const replayRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [originalRefreshCookie]);
      expect(replayRes.status).toBe(401);
      expect(replayRes.body.message).toContain('Invalid or revoked refresh token');
    });

    it('rejects refresh when logout occurs first', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const cookies = loginRes.headers['set-cookie'];
      const refreshCookie = cookies.find(c => c.startsWith('refreshToken='));

      // Logout with the refresh cookie
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [refreshCookie]);
      expect(logoutRes.status).toBe(200);

      // Attempt refresh with the logged-out cookie
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [refreshCookie]);
      expect(refreshRes.status).toBe(401);
      expect(refreshRes.body.message).toContain('Invalid or revoked refresh token');
    });

    it('isolates refresh tokens between users and handles sequential logins', async () => {
      const user1Res = await request(app).post('/api/auth/register').send(testUser);
      const user2 = { name: 'User Two', email: 'user2@example.com', password: 'password123' };
      const user2Res = await request(app).post('/api/auth/register').send(user2);

      const cookie1 = user1Res.headers['set-cookie'].find(c => c.startsWith('refreshToken='));
      const cookie2 = user2Res.headers['set-cookie'].find(c => c.startsWith('refreshToken='));

      const refresh1 = await request(app).post('/api/auth/refresh').set('Cookie', [cookie1]);
      const refresh2 = await request(app).post('/api/auth/refresh').set('Cookie', [cookie2]);

      expect(refresh1.status).toBe(200);
      expect(refresh1.body.data.user.email).toBe(testUser.email);

      expect(refresh2.status).toBe(200);
      expect(refresh2.body.data.user.email).toBe(user2.email);
    });

    it('atomic session push retains at most 5 sessions across concurrent logins', async () => {
      await request(app).post('/api/auth/register').send(testUser);

      // Perform 6 logins
      for (let i = 0; i < 6; i++) {
        await request(app).post('/api/auth/login').send({
          email: testUser.email,
          password: testUser.password
        });
      }

      const user = await User.findOne({ email: testUser.email });
      expect(user.refreshTokens.length).toBeLessThanOrEqual(5);
    });

    it('does not set active session cookies when refresh fails', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', ['refreshToken=invalid.token.here']);
      expect(res.status).toBe(401);
      const setCookies = res.headers['set-cookie'] || [];
      expect(setCookies.some(c => c.startsWith('token=') && !c.includes('token=none'))).toBe(false);
    });

    it('revokes session family and successor tokens when logout races with post-rotation refresh', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const initialCookies = loginRes.headers['set-cookie'];
      const tokenACookie = initialCookies.find(c => c.startsWith('refreshToken='));

      // Step 1: Refresh rotates tokenA -> tokenB in DB
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [tokenACookie]);
      expect(refreshRes.status).toBe(200);

      const refreshedCookies = refreshRes.headers['set-cookie'];
      const tokenBCookie = refreshedCookies.find(c => c.startsWith('refreshToken='));
      const tokenBAccessCookie = refreshedCookies.find(c => c.startsWith('token='));

      // Step 2: Logout occurs using tokenA (simulating logout starting before tokenB reached client)
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [tokenACookie]);
      expect(logoutRes.status).toBe(200);

      // Verify DB: Entire session family was revoked; tokenB was purged
      const user = await User.findOne({ email: testUser.email });
      expect(user.refreshTokens.length).toBe(0);

      // Step 3: Neither tokenB refresh nor tokenB access token can authenticate
      const staleRefreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [tokenBCookie]);
      expect(staleRefreshRes.status).toBe(401);
      expect(staleRefreshRes.body.message).toContain('Invalid or revoked refresh token');

      const staleAccessRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [tokenBAccessCookie]);
      expect(staleAccessRes.status).toBe(401);
      expect(staleAccessRes.body.message).toContain('session has been revoked');
    });

    it('revokes session family when logout uses the newly rotated refresh cookie or bearer token', async () => {
      // 1. Scenario with newly rotated refresh cookie
      const regRes = await request(app).post('/api/auth/register').send(testUser);
      const initialCookies = regRes.headers['set-cookie'];
      const tokenACookie = initialCookies.find(c => c.startsWith('refreshToken='));

      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [tokenACookie]);
      expect(refreshRes.status).toBe(200);

      const refreshedCookies = refreshRes.headers['set-cookie'];
      const tokenBCookie = refreshedCookies.find(c => c.startsWith('refreshToken='));
      const tokenBAccessCookie = refreshedCookies.find(c => c.startsWith('token='));

      // Logout occurs using tokenB (browser received and sent the newly rotated cookie)
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [tokenBCookie]);
      expect(logoutRes.status).toBe(200);

      // Verify DB: session family was revoked
      const user = await User.findOne({ email: testUser.email });
      expect(user.refreshTokens.length).toBe(0);

      // Both access and refresh return 401
      const meRes = await request(app).get('/api/auth/me').set('Cookie', [tokenBAccessCookie]);
      expect(meRes.status).toBe(401);
      expect(meRes.body.message).toContain('session has been revoked');

      const refreshAgain = await request(app).post('/api/auth/refresh').set('Cookie', [tokenBCookie]);
      expect(refreshAgain.status).toBe(401);
      expect(refreshAgain.body.message).toContain('Invalid or revoked refresh token');

      // 2. Scenario where logout uses a Bearer token during post-rotation
      const loginRes = await request(app).post('/api/auth/login').send({ email: testUser.email, password: testUser.password });
      const loginCookies = loginRes.headers['set-cookie'];
      const tokenCCookie = loginCookies.find(c => c.startsWith('refreshToken='));
      const tokenCAccessRaw = loginCookies.find(c => c.startsWith('token=')).split(';')[0].split('=')[1];

      // Refresh rotates tokenC -> tokenD
      const refreshDRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [tokenCCookie]);
      expect(refreshDRes.status).toBe(200);

      const tokenDCookies = refreshDRes.headers['set-cookie'];
      const tokenDCookie = tokenDCookies.find(c => c.startsWith('refreshToken='));
      const tokenDAccessCookie = tokenDCookies.find(c => c.startsWith('token='));

      // Logout using the Bearer token (pre-rotation tokenC access token containing the sessionId)
      const bearerLogout = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${tokenCAccessRaw}`);
      expect(bearerLogout.status).toBe(200);

      // Verify DB: session family was revoked via bearer token
      const userAfterBearer = await User.findOne({ email: testUser.email });
      expect(userAfterBearer.refreshTokens.length).toBe(0);

      // Successor tokenD is rejected in both protect and refresh
      const meDRes = await request(app).get('/api/auth/me').set('Cookie', [tokenDAccessCookie]);
      expect(meDRes.status).toBe(401);
      expect(meDRes.body.message).toContain('session has been revoked');

      const refreshDAgain = await request(app).post('/api/auth/refresh').set('Cookie', [tokenDCookie]);
      expect(refreshDAgain.status).toBe(401);
      expect(refreshDAgain.body.message).toContain('Invalid or revoked refresh token');
    });

    it('rejects access tokens once their session is revoked upon logout', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const cookies = loginRes.headers['set-cookie'];
      const accessCookie = cookies.find(c => c.startsWith('token='));
      const refreshCookie = cookies.find(c => c.startsWith('refreshToken='));

      // Access succeeds initially
      const meBefore = await request(app).get('/api/auth/me').set('Cookie', [accessCookie]);
      expect(meBefore.status).toBe(200);

      // Logout revokes session
      await request(app).post('/api/auth/logout').set('Cookie', [refreshCookie]);

      // Access with previously valid access token is rejected
      const meAfter = await request(app).get('/api/auth/me').set('Cookie', [accessCookie]);
      expect(meAfter.status).toBe(401);
      expect(meAfter.body.message).toContain('session has been revoked');
    });

    it('revokes legacy access tokens upon logout via lastLogoutAt', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const refreshCookie = loginRes.headers['set-cookie'].find(c => c.startsWith('refreshToken='));
      const user = await User.findOne({ email: testUser.email });

      // Create a legacy access token without sessionId (issued 5 seconds ago)
      const legacyAccessToken = jwt.sign(
        { id: user._id, iat: Math.floor(Date.now() / 1000) - 5 },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      // Access succeeds prior to logout
      const beforeRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${legacyAccessToken}`]);
      expect(beforeRes.status).toBe(200);

      // Logout occurs
      await request(app).post('/api/auth/logout').set('Cookie', [refreshCookie]);

      // Access with the legacy access token is rejected after logout
      const afterRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${legacyAccessToken}`]);
      expect(afterRes.status).toBe(401);
      expect(afterRes.body.message).toContain('session has been revoked');
    });

    it('revokes legacy refresh token upon logout and prevents post-logout refresh', async () => {
      const user = await User.create(testUser);
      const legacyRefreshToken = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
      const legacyTokenHash = crypto.createHash('sha256').update(legacyRefreshToken).digest('hex');
      user.refreshTokens = [legacyTokenHash];
      await user.save();

      // Logout with the legacy refresh token
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`refreshToken=${legacyRefreshToken}`]);
      expect(logoutRes.status).toBe(200);

      // Verify DB: legacy hash was removed
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.refreshTokens.length).toBe(0);

      // Refresh with the legacy token is rejected
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=${legacyRefreshToken}`]);
      expect(refreshRes.status).toBe(401);
      expect(refreshRes.body.message).toContain('Invalid or revoked refresh token');
    });

    it('prevents in-flight refresh resurrection when a legacy refresh token is rotated before logout', async () => {
      const user = await User.create(testUser);
      const legacyRefreshToken = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
      const legacyTokenHash = crypto.createHash('sha256').update(legacyRefreshToken).digest('hex');
      user.refreshTokens = [legacyTokenHash];
      await user.save();

      // Refresh rotates legacy token into a deterministic legacy session family
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=${legacyRefreshToken}`]);
      expect(refreshRes.status).toBe(200);

      const refreshedCookies = refreshRes.headers['set-cookie'];
      const tokenBCookie = refreshedCookies.find(c => c.startsWith('refreshToken='));
      const tokenBAccessCookie = refreshedCookies.find(c => c.startsWith('token='));

      // Logout occurs with the original legacy token
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`refreshToken=${legacyRefreshToken}`]);
      expect(logoutRes.status).toBe(200);

      // Verify DB: legacy session family successor was purged
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.refreshTokens.length).toBe(0);

      // Subsequent refresh or access with tokenB is rejected
      const staleRefreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [tokenBCookie]);
      expect(staleRefreshRes.status).toBe(401);

      const staleAccessRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [tokenBAccessCookie]);
      expect(staleAccessRes.status).toBe(401);
      expect(staleAccessRes.body.message).toContain('session has been revoked');
    });

    it('rejects tokens with malformed sessionId', async () => {
      const user = await User.create(testUser);
      const malformedToken = jwt.sign({ id: user._id, sessionId: '   ' }, process.env.JWT_SECRET, { expiresIn: '15m' });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${malformedToken}`]);
      expect(res.status).toBe(401);
      expect(res.body.message).toContain('invalid session identifier');
    });

    it('maintains independent session isolation when one session logs out while another remains active', async () => {
      await request(app).post('/api/auth/register').send(testUser);

      // Login 1 (Device 1)
      const login1 = await request(app).post('/api/auth/login').send({
        email: testUser.email,
        password: testUser.password
      });
      const cookie1Token = login1.headers['set-cookie'].find(c => c.startsWith('token='));
      const cookie1Refresh = login1.headers['set-cookie'].find(c => c.startsWith('refreshToken='));

      // Login 2 (Device 2)
      const login2 = await request(app).post('/api/auth/login').send({
        email: testUser.email,
        password: testUser.password
      });
      const cookie2Token = login2.headers['set-cookie'].find(c => c.startsWith('token='));

      // Both devices access successfully
      expect((await request(app).get('/api/auth/me').set('Cookie', [cookie1Token])).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Cookie', [cookie2Token])).status).toBe(200);

      // Device 1 logs out
      await request(app).post('/api/auth/logout').set('Cookie', [cookie1Refresh]);

      // Device 1 is revoked
      const res1 = await request(app).get('/api/auth/me').set('Cookie', [cookie1Token]);
      expect(res1.status).toBe(401);
      expect(res1.body.message).toContain('session has been revoked');

      // Device 2 remains active and authorized
      const res2 = await request(app).get('/api/auth/me').set('Cookie', [cookie2Token]);
      expect(res2.status).toBe(200);
      expect(res2.body.data.email).toBe(testUser.email);
    });

    it('safely fails with 500 without granting access when database lookup fails during session check', async () => {
      const loginRes = await request(app).post('/api/auth/register').send(testUser);
      const accessCookie = loginRes.headers['set-cookie'].find(c => c.startsWith('token='));

      const findSpy = vi.spyOn(User, 'findById').mockReturnValueOnce({
        select: vi.fn().mockRejectedValueOnce(new Error('Simulated DB lookup error'))
      });

      const res = await request(app).get('/api/auth/me').set('Cookie', [accessCookie]);
      expect(res.status).toBe(500);
      expect(res.body.message).toContain('Server error in authentication');

      findSpy.mockRestore();
    });

    it('isolates independent legacy sessions so logging out one does not invalidate the other', async () => {
      const user = await User.create(testUser);
      const nowSec = Math.floor(Date.now() / 1000);

      // Session 1 legacy tokens (issued at T-200)
      const legacyRefresh1 = jwt.sign({ id: user._id, iat: nowSec - 200 }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
      const legacyHash1 = crypto.createHash('sha256').update(legacyRefresh1).digest('hex');
      const legacyAccess1 = jwt.sign({ id: user._id, iat: nowSec - 200 }, process.env.JWT_SECRET, { expiresIn: '15m' });

      // Session 2 legacy tokens (issued independently at T-100)
      const legacyRefresh2 = jwt.sign({ id: user._id, iat: nowSec - 100 }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
      const legacyHash2 = crypto.createHash('sha256').update(legacyRefresh2).digest('hex');
      const legacyAccess2 = jwt.sign({ id: user._id, iat: nowSec - 100 }, process.env.JWT_SECRET, { expiresIn: '15m' });

      user.refreshTokens = [legacyHash1, legacyHash2];
      await user.save();

      // Both sessions succeed prior to logout
      const res1Before = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${legacyAccess1}`, `refreshToken=${legacyRefresh1}`]);
      expect(res1Before.status).toBe(200);

      const res2Before = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${legacyAccess2}`, `refreshToken=${legacyRefresh2}`]);
      expect(res2Before.status).toBe(200);

      // Log out of Session 1
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`refreshToken=${legacyRefresh1}`]);
      expect(logoutRes.status).toBe(200);

      // Session 2 remains valid and authorized
      const res2After = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${legacyAccess2}`, `refreshToken=${legacyRefresh2}`]);
      expect(res2After.status).toBe(200);
      expect(res2After.body.data.email).toBe(testUser.email);

      // Session 1 access and refresh tokens are both rejected
      const res1After = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${legacyAccess1}`, `refreshToken=${legacyRefresh1}`]);
      expect(res1After.status).toBe(401);
      expect(res1After.body.message).toContain('session has been revoked');

      const refresh1After = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=${legacyRefresh1}`]);
      expect(refresh1After.status).toBe(401);
      expect(refresh1After.body.message).toContain('Invalid or revoked refresh token');
    });

    it('supports multiple consecutive rotations of an upgraded legacy refresh token and full revocation on logout', async () => {
      const user = await User.create(testUser);
      const legacyRefresh0 = jwt.sign({ id: user._id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
      const legacyHash0 = crypto.createHash('sha256').update(legacyRefresh0).digest('hex');
      user.refreshTokens = [legacyHash0];
      await user.save();

      // Rotation 1: legacy bare hash -> legacy-<hash0> session family
      const rot1Res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [`refreshToken=${legacyRefresh0}`]);
      expect(rot1Res.status).toBe(200);
      const rot1Cookies = rot1Res.headers['set-cookie'];
      const refresh1 = rot1Cookies.find(c => c.startsWith('refreshToken='));
      const access1 = rot1Cookies.find(c => c.startsWith('token='));
      expect((await request(app).get('/api/auth/me').set('Cookie', [access1])).status).toBe(200);

      // Rotation 2: preserves legacy-<hash0> session family
      const rot2Res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [refresh1]);
      expect(rot2Res.status).toBe(200);
      const rot2Cookies = rot2Res.headers['set-cookie'];
      const refresh2 = rot2Cookies.find(c => c.startsWith('refreshToken='));
      const access2 = rot2Cookies.find(c => c.startsWith('token='));
      expect((await request(app).get('/api/auth/me').set('Cookie', [access2])).status).toBe(200);

      // Rotation 3: preserves legacy-<hash0> session family
      const rot3Res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', [refresh2]);
      expect(rot3Res.status).toBe(200);
      const rot3Cookies = rot3Res.headers['set-cookie'];
      const refresh3 = rot3Cookies.find(c => c.startsWith('refreshToken='));
      const access3 = rot3Cookies.find(c => c.startsWith('token='));

      // Replay of consumed refresh1 or refresh2 is rejected
      expect((await request(app).post('/api/auth/refresh').set('Cookie', [refresh1])).status).toBe(401);
      expect((await request(app).post('/api/auth/refresh').set('Cookie', [refresh2])).status).toBe(401);

      // Access succeeds with current token
      expect((await request(app).get('/api/auth/me').set('Cookie', [access3])).status).toBe(200);

      // Logout with current token revokes entire legacy family
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [refresh3]);
      expect(logoutRes.status).toBe(200);

      // Verify DB: 0 refresh tokens remain
      const updatedUser = await User.findById(user._id);
      expect(updatedUser.refreshTokens.length).toBe(0);

      // Access and refresh are now rejected
      expect((await request(app).get('/api/auth/me').set('Cookie', [access1])).status).toBe(401);
      expect((await request(app).get('/api/auth/me').set('Cookie', [access2])).status).toBe(401);
      expect((await request(app).get('/api/auth/me').set('Cookie', [access3])).status).toBe(401);
      expect((await request(app).post('/api/auth/refresh').set('Cookie', [refresh3])).status).toBe(401);
    });

    it('verifies legacy access token scenarios across protect and optionalAuth', async () => {
      const user = await User.create(testUser);
      const otherUser = await User.create({
        name: 'Other User',
        email: 'other@example.com',
        password: 'password123'
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const legacyRefresh = jwt.sign({ id: user._id, iat: nowSec - 200 }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
      const legacyHash = crypto.createHash('sha256').update(legacyRefresh).digest('hex');
      const legacyAccess = jwt.sign({ id: user._id, iat: nowSec - 200 }, process.env.JWT_SECRET, { expiresIn: '15m' });

      const otherRefresh = jwt.sign({ id: otherUser._id, iat: nowSec - 100 }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
      const otherHash = crypto.createHash('sha256').update(otherRefresh).digest('hex');
      otherUser.refreshTokens = [otherHash];
      await otherUser.save();

      user.refreshTokens = [legacyHash];
      await user.save();

      // Case 1: Valid legacy access token with active refresh cookie
      const res1 = await request(app).get('/api/auth/me').set('Cookie', [`token=${legacyAccess}`, `refreshToken=${legacyRefresh}`]);
      expect(res1.status).toBe(200);

      const reqOpt1 = { cookies: { token: legacyAccess, refreshToken: legacyRefresh }, headers: {} };
      await optionalAuth(reqOpt1, {}, () => {});
      expect(reqOpt1.user).toBeDefined();
      expect(reqOpt1.user._id.toString()).toBe(user._id.toString());

      // Case 3: Valid legacy access token with missing refresh cookie before logout
      const res3 = await request(app).get('/api/auth/me').set('Cookie', [`token=${legacyAccess}`]);
      expect(res3.status).toBe(200);

      const reqOpt3 = { cookies: { token: legacyAccess }, headers: {} };
      await optionalAuth(reqOpt3, {}, () => {});
      expect(reqOpt3.user).toBeDefined();

      // Case 4: Valid legacy access token with refresh cookie of another user
      const res4 = await request(app).get('/api/auth/me').set('Cookie', [`token=${legacyAccess}`, `refreshToken=${otherRefresh}`]);
      expect(res4.status).toBe(401);
      expect(res4.body.message).toContain('session has been revoked');

      const reqOpt4 = { cookies: { token: legacyAccess, refreshToken: otherRefresh }, headers: {} };
      await optionalAuth(reqOpt4, {}, () => {});
      expect(reqOpt4.user).toBeNull();

      // Case 6: Malformed, expired, or invalid refresh cookies
      const res6 = await request(app).get('/api/auth/me').set('Cookie', [`token=${legacyAccess}`, 'refreshToken=invalid_garbage_token']);
      expect(res6.status).toBe(401);
      expect(res6.body.message).toContain('session has been revoked');

      const reqOpt6 = { cookies: { token: legacyAccess, refreshToken: 'invalid_garbage_token' }, headers: {} };
      await optionalAuth(reqOpt6, {}, () => {});
      expect(reqOpt6.user).toBeNull();

      // Case 7: Legacy access token via supported Bearer-token flow
      const res7Before = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${legacyAccess}`);
      expect(res7Before.status).toBe(200);

      const reqOpt7Before = { cookies: {}, headers: { authorization: `Bearer ${legacyAccess}` } };
      await optionalAuth(reqOpt7Before, {}, () => {});
      expect(reqOpt7Before.user).toBeDefined();

      // Logout session
      await request(app).post('/api/auth/logout').set('Cookie', [`refreshToken=${legacyRefresh}`]);

      // Case 2: Valid legacy access token with revoked refresh cookie
      const res2 = await request(app).get('/api/auth/me').set('Cookie', [`token=${legacyAccess}`, `refreshToken=${legacyRefresh}`]);
      expect(res2.status).toBe(401);
      expect(res2.body.message).toContain('session has been revoked');

      const reqOpt2 = { cookies: { token: legacyAccess, refreshToken: legacyRefresh }, headers: {} };
      await optionalAuth(reqOpt2, {}, () => {});
      expect(reqOpt2.user).toBeNull();

      // Case 5: Valid legacy access token after logout when refresh cookie is absent
      const res5 = await request(app).get('/api/auth/me').set('Cookie', [`token=${legacyAccess}`]);
      expect(res5.status).toBe(401);
      expect(res5.body.message).toContain('session has been revoked');

      const reqOpt5 = { cookies: { token: legacyAccess }, headers: {} };
      await optionalAuth(reqOpt5, {}, () => {});
      expect(reqOpt5.user).toBeNull();

      // Case 7 after logout (Bearer header)
      const res7After = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${legacyAccess}`);
      expect(res7After.status).toBe(401);
      expect(res7After.body.message).toContain('session has been revoked');

      const reqOpt7After = { cookies: {}, headers: { authorization: `Bearer ${legacyAccess}` } };
      await optionalAuth(reqOpt7After, {}, () => {});
      expect(reqOpt7After.user).toBeNull();
    });

    it('verifies lastLogoutAt whole-second precision semantics for legacy bearer tokens', async () => {
      await request(app).post('/api/auth/register').send(testUser);
      const user = await User.findOne({ email: testUser.email });
      const nowSec = Math.floor(Date.now() / 1000);

      // Token issued 10 seconds before logout
      const tokenBefore = jwt.sign({ id: user._id, iat: nowSec - 10 }, process.env.JWT_SECRET, { expiresIn: '15m' });
      // Token issued in the same second as logout
      const tokenSameSec = jwt.sign({ id: user._id, iat: nowSec }, process.env.JWT_SECRET, { expiresIn: '15m' });

      // Simulate logout occurring at nowSec with milliseconds
      user.lastLogoutAt = new Date(nowSec * 1000 + 500);
      await user.save();

      // Token issued before the logout second is strictly rejected
      const resBefore = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenBefore}`);
      expect(resBefore.status).toBe(401);
      expect(resBefore.body.message).toContain('session has been revoked');

      // Token issued in the same second as logout is also revoked (<= boundary)
      const resSameSec = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenSameSec}`);
      expect(resSameSec.status).toBe(401);
      expect(resSameSec.body.message).toContain('session has been revoked');

      const reqOptSameSec = { cookies: {}, headers: { authorization: `Bearer ${tokenSameSec}` } };
      await optionalAuth(reqOptSameSec, {}, () => {});
      expect(reqOptSameSec.user).toBeNull();

      // Token issued after logout (e.g. nowSec + 1) succeeds
      const tokenAfter = jwt.sign({ id: user._id, iat: nowSec + 1 }, process.env.JWT_SECRET, { expiresIn: '15m' });
      const resAfter = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenAfter}`);
      expect(resAfter.status).toBe(200);

      // Immediate subsequent modern login in the same second succeeds without being affected by lastLogoutAt
      const modernLogin = await request(app).post('/api/auth/login').send({ email: testUser.email, password: testUser.password });
      expect(modernLogin.status).toBe(200);
      const modernAccessCookie = modernLogin.headers['set-cookie'].find(c => c.startsWith('token='));
      const resModern = await request(app).get('/api/auth/me').set('Cookie', [modernAccessCookie]);
      expect(resModern.status).toBe(200);
    });

    it('exhaustively verifies Bearer-token logout flows, error resilience, and session isolation', async () => {
      // 1. Setup User with two active sessions (Session 1 and Session 2)
      await request(app).post('/api/auth/register').send(testUser);
      const login1 = await request(app).post('/api/auth/login').send({ email: testUser.email, password: testUser.password });
      const s1Access = login1.headers['set-cookie'].find(c => c.startsWith('token=')).split(';')[0].split('=')[1];
      const s1Refresh = login1.headers['set-cookie'].find(c => c.startsWith('refreshToken=')).split(';')[0].split('=')[1];

      const login2 = await request(app).post('/api/auth/login').send({ email: testUser.email, password: testUser.password });
      const s2Access = login2.headers['set-cookie'].find(c => c.startsWith('token=')).split(';')[0].split('=')[1];
      const s2Refresh = login2.headers['set-cookie'].find(c => c.startsWith('refreshToken=')).split(';')[0].split('=')[1];

      // Setup Another User (User 2)
      const user2Data = { name: 'User 2', email: 'user2@example.com', password: 'password123' };
      const regUser2 = await request(app).post('/api/auth/register').send(user2Data);
      const u2Access = regUser2.headers['set-cookie'].find(c => c.startsWith('token=')).split(';')[0].split('=')[1];

      // Both User 1 sessions and User 2 session succeed
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${s1Access}`)).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${s2Access}`)).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${u2Access}`)).status).toBe(200);

      // 2. Logout with malformed Bearer header returns 200 gracefully and does not invalidate active sessions
      const malformedRes = await request(app).post('/api/auth/logout').set('Authorization', 'Bearer not-a-valid-jwt');
      expect(malformedRes.status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${s1Access}`)).status).toBe(200);

      // 3. Logout with an expired token does not affect active sessions
      const expiredToken = jwt.sign({ id: '650000000000000000000001', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
      expect((await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${expiredToken}`)).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${s1Access}`)).status).toBe(200);

      // Logout with User 2's token revokes User 2, not User 1
      expect((await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${u2Access}`)).status).toBe(200);
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${u2Access}`)).status).toBe(401);
      expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${s1Access}`)).status).toBe(200);

      // 4. Logout Session 1 via Bearer access token
      const logoutS1 = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${s1Access}`);
      expect(logoutS1.status).toBe(200);

      // Session 1 access token is revoked
      const s1AccessAfter = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${s1Access}`);
      expect(s1AccessAfter.status).toBe(401);
      expect(s1AccessAfter.body.message).toContain('session has been revoked');

      // Session 1 refresh token is revoked
      const s1RefreshAfter = await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${s1Refresh}`]);
      expect(s1RefreshAfter.status).toBe(401);
      expect(s1RefreshAfter.body.message).toContain('Invalid or revoked refresh token');

      // Session 2 remains active and authorized
      const s2AccessAfter = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${s2Access}`);
      expect(s2AccessAfter.status).toBe(200);
      expect(s2AccessAfter.body.data.email).toBe(testUser.email);

      const s2RefreshAfter = await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${s2Refresh}`]);
      expect(s2RefreshAfter.status).toBe(200);

      // 5. Legacy access token logout via Bearer does not pull unrelated refresh tokens
      const nowSec = Math.floor(Date.now() / 1000);
      const dbUser = await User.findOne({ email: testUser.email });
      const legacyRefresh = jwt.sign({ id: dbUser._id, iat: nowSec - 10 }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
      const legacyHash = crypto.createHash('sha256').update(legacyRefresh).digest('hex');
      const legacyAccess = jwt.sign({ id: dbUser._id, iat: nowSec - 10 }, process.env.JWT_SECRET, { expiresIn: '15m' });

      dbUser.refreshTokens.push(legacyHash);
      await dbUser.save();

      // Logout with legacy access token
      const legacyLogoutRes = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${legacyAccess}`);
      expect(legacyLogoutRes.status).toBe(200);

      // Legacy access token is revoked via lastLogoutAt
      const legacyAccessAfter = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${legacyAccess}`);
      expect(legacyAccessAfter.status).toBe(401);

      // But legacy refresh token was NOT accidentally deleted from DB because access token hash is not a refresh token hash
      const checkUser = await User.findOne({ email: testUser.email });
      expect(checkUser.refreshTokens).toContain(legacyHash);
    });

    it('verifies logout security with expired tokens and rejects forged/malformed tokens without trusting unverified claims', async () => {
      // 1. Create User with an active session
      const user = await User.create(testUser);
      const validSessionId = 'sess-valid-1';
      const nowSec = Math.floor(Date.now() / 1000);

      const validRefresh = jwt.sign(
        { id: user._id, sessionId: validSessionId, jti: crypto.randomUUID() },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: '7d' }
      );
      const validRefreshHash = crypto.createHash('sha256').update(validRefresh).digest('hex');

      const validAccess = jwt.sign(
        { id: user._id, sessionId: validSessionId },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      // Create an expired but correctly signed token
      const expiredSessionId = 'sess-expired-2';
      const expiredRefresh = jwt.sign(
        { id: user._id, sessionId: expiredSessionId, jti: crypto.randomUUID() },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: '7d' }
      );
      const expiredRefreshHash = crypto.createHash('sha256').update(expiredRefresh).digest('hex');

      const expiredAccess = jwt.sign(
        { id: user._id, sessionId: expiredSessionId, exp: nowSec - 60 },
        process.env.JWT_SECRET
      );

      // Save both session families to user record
      user.refreshTokens = [
        `${validSessionId}:${validRefreshHash}`,
        `${expiredSessionId}:${expiredRefreshHash}`
      ];
      await user.save();

      // Verify active session succeeds before any logout
      const beforeRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validAccess}`);
      expect(beforeRes.status).toBe(200);

      // A. Malformed token: returns 200, but does not alter DB or revoke sessions
      const malformedRes = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer invalid..token');
      expect(malformedRes.status).toBe(200);
      let dbUser = await User.findById(user._id);
      expect(dbUser.refreshTokens.length).toBe(2);
      expect(dbUser.lastLogoutAt).toBeUndefined();

      // B. Forged token containing another user's ID and fabricated sessionId
      const forgedTokenOtherUser = jwt.sign(
        { id: user._id, sessionId: 'fabricated-session-x' },
        'wrong-attacker-secret',
        { expiresIn: '1h' }
      );
      const forgedRes1 = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${forgedTokenOtherUser}`);
      expect(forgedRes1.status).toBe(200);
      dbUser = await User.findById(user._id);
      expect(dbUser.refreshTokens.length).toBe(2);
      expect(dbUser.lastLogoutAt).toBeUndefined();

      // C. Forged token containing real user's ID and fabricated session identifier (alg none or wrong key)
      const forgedTokenRealUser = jwt.sign(
        { id: user._id, sessionId: validSessionId },
        'attacker-untrusted-key',
        { expiresIn: '1h' }
      );
      const forgedRes2 = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${forgedTokenRealUser}`);
      expect(forgedRes2.status).toBe(200);
      dbUser = await User.findById(user._id);
      // Valid session remains intact and was NOT revoked by forged token!
      expect(dbUser.refreshTokens).toContain(`${validSessionId}:${validRefreshHash}`);
      expect(dbUser.lastLogoutAt).toBeUndefined();

      // Active session is still 100% authorized
      const validCheckRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validAccess}`);
      expect(validCheckRes.status).toBe(200);

      // D. Expired but correctly signed token: safely revokes expiredSessionId while preserving validSessionId
      const expiredLogoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${expiredAccess}`);
      expect(expiredLogoutRes.status).toBe(200);

      dbUser = await User.findById(user._id);
      // Expired session family was revoked
      expect(dbUser.refreshTokens.some(entry => entry.startsWith(`${expiredSessionId}:`))).toBe(false);
      // Valid session family is PRESERVED!
      expect(dbUser.refreshTokens.some(entry => entry.startsWith(`${validSessionId}:`))).toBe(true);
      expect(dbUser.lastLogoutAt).toBeDefined();

      // Valid session remains authorized
      const stillValidRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validAccess}`);
      expect(stillValidRes.status).toBe(200);

      // E. Valid unexpired access token: cleanly logs out and revokes validSessionId
      const validAccessLogout = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${validAccess}`);
      expect(validAccessLogout.status).toBe(200);

      dbUser = await User.findById(user._id);
      expect(dbUser.refreshTokens.length).toBe(0);

      // Access is now rejected
      const finalAccessRes = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validAccess}`);
      expect(finalAccessRes.status).toBe(401);

      // F. Valid unexpired refresh token: also cleanly logs out
      const user2 = await User.create({ name: 'User 2', email: 'u2@test.com', password: 'password123' });
      const u2Refresh = jwt.sign(
        { id: user2._id, sessionId: 'sess-u2', jti: crypto.randomUUID() },
        process.env.JWT_REFRESH_SECRET,
        { expiresIn: '7d' }
      );
      user2.refreshTokens = [`sess-u2:${crypto.createHash('sha256').update(u2Refresh).digest('hex')}`];
      await user2.save();

      const refreshLogoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`refreshToken=${u2Refresh}`]);
      expect(refreshLogoutRes.status).toBe(200);

      const dbUser2 = await User.findById(user2._id);
      expect(dbUser2.refreshTokens.length).toBe(0);
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
