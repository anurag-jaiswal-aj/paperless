import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../models/user.js';
import authRoutes from '../routes/authRoutes.js';
import { csrfProtection } from '../middleware/csrfProtection.js';
import requestCorrelation from '../middleware/requestCorrelation.js';
import { getDiagnosticCounters, resetDiagnosticCounters } from './SecurityAuditService.js';
import { logger } from '../utils/logger.js';
import {
  setLoginProtectionComponents,
  resetLoginProtectionComponents
} from '../controllers/authController.js';

describe('Security Audit Integration Tests', () => {
  let mongoServer;
  let app;
  let loggedEvents;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test_jwt_secret_paperless_integration_123';
    process.env.JWT_REFRESH_SECRET = 'test_jwt_refresh_secret_integration_123';
    process.env.LOGIN_PROTECTION_HMAC_SECRET = 'paperless-test-hmac-secret-at-least-32-bytes-long';
    process.env.FRONTEND_URL = 'http://localhost:5173';
    process.env.NODE_ENV = 'production';
    process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = 'true';

    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    app = express();
    // SEC-423-06: Mount requestCorrelation middleware at the entry point of the pipeline
    app.use(requestCorrelation);
    app.use(express.json());
    app.use(cookieParser());
    app.use(csrfProtection);
    app.use('/api/auth', authRoutes);
  });

  afterAll(async () => {
    await resetLoginProtectionComponents();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await resetLoginProtectionComponents();
    resetDiagnosticCounters();
    loggedEvents = [];

    // Intercept logger methods to capture audit emissions
    vi.spyOn(logger, 'info').mockImplementation((event, payload) => {
      loggedEvents.push({ level: 'info', event, payload });
    });
    vi.spyOn(logger, 'warn').mockImplementation((event, payload) => {
      loggedEvents.push({ level: 'warn', event, payload });
    });

    await User.deleteMany({});
  });

  it('emits security.auth.login.success with correlated requestId and strips raw userId (SEC-423-01, SEC-423-06)', async () => {
    const email = 'audit-success@example.com';
    const password = 'CorrectPassword123!';

    // Register user first
    await request(app)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'Audit User', email, password })
      .expect(201);

    loggedEvents = [];
    resetDiagnosticCounters();

    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email, password })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(getDiagnosticCounters().auth_login_success_total).toBe(1);

    const successLog = loggedEvents.find((l) => l.event === 'security.auth.login.success');
    expect(successLog).toBeDefined();
    expect(successLog.payload.audit).toBe(true);
    expect(successLog.payload.outcome).toBe('success');
    expect(successLog.payload.emailMasked).toBe('au***@example.com');

    // SEC-423-01: Raw user and session identifiers must NOT be emitted
    expect(successLog.payload.userId).toBeUndefined();
    expect(successLog.payload.sessionId).toBeUndefined();

    // SEC-423-06: Server-generated requestId propagated from AsyncLocalStorage
    expect(res.headers['x-request-id']).toBeDefined();
    expect(successLog.payload.requestId).toBeDefined();
    expect(successLog.payload.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects client-supplied X-Request-ID and enforces server-generated UUID (SEC-423-02, SEC-423-06)', async () => {
    const email = 'client-id-test@example.com';
    const password = 'CorrectPassword123!';

    await request(app)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'Client ID User', email, password })
      .expect(201);

    loggedEvents = [];
    resetDiagnosticCounters();

    const forgedRequestId = 'forged-attacker-client-id-999';

    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .set('X-Request-ID', forgedRequestId)
      .send({ email, password })
      .expect(200);

    // Verify response header is a server-generated UUID v4, NOT the attacker's forged string
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).not.toBe(forgedRequestId);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const successLog = loggedEvents.find((l) => l.event === 'security.auth.login.success');
    expect(successLog).toBeDefined();
    // Audit log must match server-generated ID and not the forged client header
    expect(successLog.payload.requestId).toBe(res.headers['x-request-id']);
    expect(successLog.payload.requestId).not.toBe(forgedRequestId);
  });

  it('emits security.auth.login.failure and increments auth_login_failure_total on invalid credentials', async () => {
    const email = 'audit-fail@example.com';
    const password = 'CorrectPassword123!';

    await request(app)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'Audit User Fail', email, password })
      .expect(201);

    loggedEvents = [];
    resetDiagnosticCounters();

    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email, password: 'WrongPassword123!' })
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(getDiagnosticCounters().auth_login_failure_total).toBe(1);

    const failLog = loggedEvents.find((l) => l.event === 'security.auth.login.failure');
    expect(failLog).toBeDefined();
    expect(failLog.level).toBe('warn');
    expect(failLog.payload.outcome).toBe('failure');
    expect(failLog.payload.emailMasked).toBe('au***@example.com');
    expect(failLog.payload.accountExists).toBe(true);
    expect(failLog.payload.reason).toBe('invalid_credentials');
    expect(failLog.payload.requestId).toBe(res.headers['x-request-id']);
    expect(failLog.payload.userId).toBeUndefined();
    expect(failLog.payload.sessionId).toBeUndefined();
  });

  it('emits security.auth.lockout when pair lockout is initiated', async () => {
    const email = 'audit-lockout@example.com';

    const mockCoordinator = {
      draining: false,
      tryAcquireAdmission: vi.fn(() => ({
        settleLookupFailure: vi.fn(),
        settleFailure: vi.fn(),
        settleSuccess: vi.fn(),
        isSettled: false,
        clientDisconnected: false,
        releaseIpSlot: vi.fn()
      }))
    };

    const mockWorkerPool = {
      workers: new Map([['worker-1', {}]]),
      executeCompare: vi.fn(async () => ({ isMatch: false }))
    };

    const mockProtectionService = {
      checkPairLockout: vi.fn(async () => ({ isLocked: false, revision: 1 })),
      recordPairFailureAtomic: vi.fn(async () => ({
        status: 'LOCKOUT_INITIATED',
        retryAfterSeconds: 60,
        failedAttempts: 5
      })),
      recordAccountFailureAtomic: vi.fn(async () => ({ delayMs: 0 })),
      deriveIpHash: vi.fn(() => 'mock-hash-lockout-123')
    };

    setLoginProtectionComponents({
      coordinator: mockCoordinator,
      workerPool: mockWorkerPool,
      protectionService: mockProtectionService
    });

    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email, password: 'BadPassword123!' })
      .expect(429);

    expect(res.body.success).toBe(false);
    expect(res.headers['retry-after']).toBe('60');
    expect(getDiagnosticCounters().auth_lockout_active_total).toBe(1);

    const lockoutLog = loggedEvents.find((l) => l.event === 'security.auth.lockout');
    expect(lockoutLog).toBeDefined();
    expect(lockoutLog.payload.outcome).toBe('blocked');
    expect(lockoutLog.payload.stage).toBe('post_failure');
    expect(lockoutLog.payload.status).toBe('LOCKOUT_INITIATED');
    expect(lockoutLog.payload.retryAfterSeconds).toBe(60);
    expect(lockoutLog.payload.failedAttempts).toBe(5);
    expect(lockoutLog.payload.requestId).toBe(res.headers['x-request-id']);

    // Reset components to real singletons
    await resetLoginProtectionComponents();
  });

  it('increments auth_session_revoked_total on authenticated logout with valid session (SEC-423-05)', async () => {
    const email = 'audit-logout@example.com';
    const password = 'CorrectPassword123!';

    await request(app)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'Logout User', email, password })
      .expect(201);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email, password })
      .expect(200);

    const cookies = loginRes.headers['set-cookie'];
    expect(cookies).toBeDefined();

    loggedEvents = [];
    resetDiagnosticCounters();

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', cookies)
      .expect(200);

    expect(res.body.success).toBe(true);
    // SEC-423-05: Authenticated logout with confirmed session revocation increments counter
    expect(getDiagnosticCounters().auth_session_revoked_total).toBe(1);

    const logoutLog = loggedEvents.find((l) => l.event === 'security.auth.logout');
    expect(logoutLog).toBeDefined();
    expect(logoutLog.payload.outcome).toBe('success');
    expect(logoutLog.payload.requestId).toBe(res.headers['x-request-id']);
    // SEC-423-01: Raw user and session identifiers must NOT be emitted
    expect(logoutLog.payload.userId).toBeUndefined();
    expect(logoutLog.payload.sessionId).toBeUndefined();
  });

  it('does NOT increment auth_session_revoked_total on unauthenticated logout (SEC-423-05)', async () => {
    loggedEvents = [];
    resetDiagnosticCounters();

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(res.body.success).toBe(true);
    // Unauthenticated logout: no session was revoked in database
    expect(getDiagnosticCounters().auth_session_revoked_total).toBe(0);

    const logoutLog = loggedEvents.find((l) => l.event === 'security.auth.logout');
    expect(logoutLog).toBeDefined();
    expect(logoutLog.payload.outcome).toBe('success');
    expect(logoutLog.payload.userId).toBeUndefined();
    expect(logoutLog.payload.sessionId).toBeUndefined();
  });

  it('emits security.auth.lockout on pre-check lockout with compute bypassed', async () => {
    const email = 'audit-precheck@example.com';

    const mockCoordinator = {
      draining: false,
      tryAcquireAdmission: vi.fn(() => ({
        settleLookupFailure: vi.fn(),
        settleFailure: vi.fn(),
        settleSuccess: vi.fn(),
        isSettled: false,
        clientDisconnected: false,
        releaseIpSlot: vi.fn()
      }))
    };

    const mockProtectionService = {
      checkPairLockout: vi.fn(async () => ({ isLocked: true, retryAfterSeconds: 300 })),
      deriveIpHash: vi.fn(() => 'mock-hash-precheck-456')
    };

    setLoginProtectionComponents({
      coordinator: mockCoordinator,
      workerPool: undefined,
      protectionService: mockProtectionService
    });

    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email, password: 'AnyPassword123!' })
      .expect(429);

    expect(res.body.success).toBe(false);
    expect(res.headers['retry-after']).toBe('300');
    expect(getDiagnosticCounters().auth_lockout_active_total).toBe(1);

    const lockoutLog = loggedEvents.find((l) => l.event === 'security.auth.lockout');
    expect(lockoutLog).toBeDefined();
    expect(lockoutLog.payload.outcome).toBe('blocked');
    expect(lockoutLog.payload.stage).toBe('pre_check');
    expect(lockoutLog.payload.retryAfterSeconds).toBe(300);

    await resetLoginProtectionComponents();
  });

  it('emits security.auth.delay.applied when advisory spray delay is triggered', async () => {
    const email = 'audit-spray@example.com';

    const mockCoordinator = {
      draining: false,
      tryAcquireAdmission: vi.fn(() => ({
        settleLookupFailure: vi.fn(),
        settleFailure: vi.fn(),
        settleSuccess: vi.fn(),
        isSettled: false,
        clientDisconnected: false,
        releaseIpSlot: vi.fn()
      }))
    };

    const mockWorkerPool = {
      workers: new Map([['worker-1', {}]]),
      executeCompare: vi.fn(async () => ({ isMatch: false }))
    };

    const mockProtectionService = {
      checkPairLockout: vi.fn(async () => ({ isLocked: false, revision: 1 })),
      recordPairFailureAtomic: vi.fn(async () => ({
        status: 'OK',
        failedAttempts: 1
      })),
      recordAccountFailureAtomic: vi.fn(async () => ({ delayMs: 25, distinctIps: 3 })),
      deriveIpHash: vi.fn(() => 'mock-hash-spray-789')
    };

    setLoginProtectionComponents({
      coordinator: mockCoordinator,
      workerPool: mockWorkerPool,
      protectionService: mockProtectionService
    });

    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email, password: 'WrongPassword123!' })
      .expect(401);

    expect(res.body.success).toBe(false);
    expect(getDiagnosticCounters().auth_delay_applied_total).toBe(1);

    const sprayLog = loggedEvents.find((l) => l.event === 'security.auth.delay.applied');
    expect(sprayLog).toBeDefined();
    expect(sprayLog.payload.outcome).toBe('applied');
    expect(sprayLog.payload.delayMs).toBe(25);
    expect(sprayLog.payload.distinctIpsCount).toBe(3);

    await resetLoginProtectionComponents();
  });

  it('emits security.auth.password_reset.requested without accountExists (SEC-423-04)', async () => {
    const res = await request(app)
      .post('/api/auth/forgotpassword')
      .set('Origin', 'http://localhost:5173')
      .send({ email: 'nonexistent@example.com' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(getDiagnosticCounters().auth_password_reset_request_total).toBe(1);

    const pwLog = loggedEvents.find((l) => l.event === 'security.auth.password_reset.requested');
    expect(pwLog).toBeDefined();
    expect(pwLog.payload.outcome).toBe('requested');
    expect(pwLog.payload.emailMasked).toBe('no***@example.com');
    // SEC-423-04: accountExists must NOT be emitted
    expect(pwLog.payload.accountExists).toBeUndefined();
    expect(pwLog.payload.userId).toBeUndefined();
    expect(pwLog.payload.sessionId).toBeUndefined();
  });

  it('emits security.auth.password_reset.completed without userId (SEC-423-01)', async () => {
    const email = 'audit-reset@example.com';
    const password = 'OldPassword123!';

    const regRes = await request(app)
      .post('/api/auth/register')
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'Reset User', email, password })
      .expect(201);

    const user = await User.findById(regRes.body.data.user.id);
    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });

    loggedEvents = [];
    resetDiagnosticCounters();

    const res = await request(app)
      .post('/api/auth/resetpassword')
      .set('Origin', 'http://localhost:5173')
      .send({ token: resetToken, password: 'NewSecurePassword123!' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(getDiagnosticCounters().auth_password_reset_success_total).toBe(1);
    expect(getDiagnosticCounters().auth_session_revoked_total).toBe(1);

    const resetLog = loggedEvents.find((l) => l.event === 'security.auth.password_reset.completed');
    expect(resetLog).toBeDefined();
    expect(resetLog.payload.outcome).toBe('success');
    // SEC-423-01: Raw user and session identifiers must NOT be emitted
    expect(resetLog.payload.userId).toBeUndefined();
    expect(resetLog.payload.sessionId).toBeUndefined();
  });

  it('emits security.csrf.rejected and increments security_csrf_rejection_total on untrusted origin', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://untrusted-attacker.com')
      .send({ email: 'test@example.com', password: 'password123' })
      .expect(403);

    expect(res.body.success).toBe(false);
    expect(getDiagnosticCounters().security_csrf_rejection_total).toBe(1);

    const csrfLog = loggedEvents.find((l) => l.event === 'security.csrf.rejected');
    expect(csrfLog).toBeDefined();
    expect(csrfLog.level).toBe('warn');
    expect(csrfLog.payload.outcome).toBe('rejected');
    expect(csrfLog.payload.origin).toBe('http://untrusted-attacker.com');
    expect(csrfLog.payload.reason).toBe('untrusted_origin');
  });
});
