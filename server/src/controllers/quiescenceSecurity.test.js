import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import { app } from '../server.js';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import {
  quiescenceGate,
  setQuiescenceService,
  resetInFlightMutations
} from '../middleware/quiescenceGate.js';
import { validateBackupToken } from './quiescenceController.js';
import quiescenceRoutes from '../routes/quiescenceRoutes.js';
import { logger } from '../utils/logger.js';

describe('Quiescence Adversarial Security & Boundary Verification Suite (Workstream 2D.1)', () => {
  const TEST_BACKUP_TOKEN = 'test-backup-internal-secret-token-min32chars-xyz123!';
  const JWT_TEST_SECRET = 'paperless-jwt-test-secret-at-least-32-chars-length!';
  const originalBackupToken = process.env.BACKUP_INTERNAL_TOKEN;
  const originalJwtSecret = process.env.JWT_SECRET;
  let mongod;

  beforeAll(async () => {
    mongod = await startReplSet([BackupLease]);
  }, 60000);

  afterAll(async () => {
    process.env.BACKUP_INTERNAL_TOKEN = originalBackupToken;
    process.env.JWT_SECRET = originalJwtSecret;
    await stopReplSet(mongod);
  });

  beforeEach(async () => {
    process.env.BACKUP_INTERNAL_TOKEN = TEST_BACKUP_TOKEN;
    process.env.JWT_SECRET = JWT_TEST_SECRET;
    resetInFlightMutations();
    setQuiescenceService(null);

    // Reset MongoDB lease singleton to NORMAL state
    await BackupLease.findOneAndUpdate(
      { _id: BACKUP_LEASE_SINGLETON_ID },
      {
        $set: {
          status: BACKUP_LEASE_STATUS.NORMAL,
          leaseId: null,
          owner: null,
          grantedAt: null,
          expiresAt: null,
          lastHeartbeatAt: null,
          monotonicWatchdogDeadline: null,
          drainStartedAt: null
        },
        $setOnInsert: { version: 0 }
      },
      { upsert: true, new: true }
    );
  });

  afterEach(() => {
    resetInFlightMutations();
    setQuiescenceService(null);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SECTION 1: Authentication & Authorization Security on /api/admin/quiescence/*
  // =========================================================================
  describe('1. Authentication & Authorization Security', () => {
    let testApp;

    beforeEach(() => {
      testApp = express();
      testApp.use(express.json());
      testApp.use('/api/admin/quiescence', quiescenceRoutes);
    });

    describe('Fail-Closed Enforcement When BACKUP_INTERNAL_TOKEN Is Unconfigured', () => {
      it('fails closed with HTTP 503 when BACKUP_INTERNAL_TOKEN is undefined', async () => {
        delete process.env.BACKUP_INTERNAL_TOKEN;

        const endpoints = [
          { method: 'get', path: '/api/admin/quiescence/status' },
          { method: 'post', path: '/api/admin/quiescence/acquire' },
          { method: 'post', path: '/api/admin/quiescence/heartbeat' },
          { method: 'post', path: '/api/admin/quiescence/release' }
        ];

        for (const ep of endpoints) {
          const res = await request(testApp)
            [ep.method](ep.path)
            .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

          expect(res.status).toBe(503);
          expect(res.body.success).toBe(false);
          expect(res.body.message).toBe('Backup administrative interface disabled');
        }
      });

      it('fails closed with HTTP 503 when BACKUP_INTERNAL_TOKEN is empty or whitespace', async () => {
        const invalidTokens = ['', '   ', '\t\n'];

        for (const emptyVal of invalidTokens) {
          process.env.BACKUP_INTERNAL_TOKEN = emptyVal;

          const res = await request(testApp)
            .get('/api/admin/quiescence/status')
            .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

          expect(res.status).toBe(503);
          expect(res.body.success).toBe(false);
          expect(res.body.message).toBe('Backup administrative interface disabled');
        }
      });
    });

    describe('Missing, Empty, and Malformed Authorization Headers', () => {
      it('rejects with HTTP 401 when Authorization header is completely missing', async () => {
        const endpoints = [
          { method: 'get', path: '/api/admin/quiescence/status' },
          { method: 'post', path: '/api/admin/quiescence/acquire' },
          { method: 'post', path: '/api/admin/quiescence/heartbeat' },
          { method: 'post', path: '/api/admin/quiescence/release' }
        ];

        for (const ep of endpoints) {
          const res = await request(testApp)[ep.method](ep.path);

          expect(res.status).toBe(401);
          expect(res.body.success).toBe(false);
          expect(res.body.message).toMatch(/Unauthorized: Missing or invalid authorization token/i);
        }
      });

      it('rejects with HTTP 401 when Authorization header is empty Bearer', async () => {
        const malformedHeaders = [
          'Bearer',
          'Bearer ',
          'Bearer    ',
          'bearer',
          'bearer ',
          'BEARER '
        ];

        for (const headerVal of malformedHeaders) {
          const res = await request(testApp)
            .get('/api/admin/quiescence/status')
            .set('Authorization', headerVal);

          expect(res.status).toBe(401);
          expect(res.body.success).toBe(false);
          expect(res.body.message).toMatch(/Unauthorized: Missing or invalid authorization token/i);
        }
      });

      it('rejects with HTTP 401 on non-Bearer schemes or garbage headers', async () => {
        const invalidSchemes = [
          'Basic dXNlcjpwYXNz',
          'Token some-token-here',
          'Digest username="test"',
          'OAuth 1234567890',
          'null',
          'undefined',
          'Bearer malformed!@#$%^&*()',
          'NotABearerToken'
        ];

        for (const headerVal of invalidSchemes) {
          const res = await request(testApp)
            .get('/api/admin/quiescence/status')
            .set('Authorization', headerVal);

          expect(res.status).toBe(401);
          expect(res.body.success).toBe(false);
          expect(res.body.message).toMatch(/Unauthorized: Missing or invalid authorization token/i);
        }
      });
    });

    describe('Invalid Bearer Tokens & Tampering Attempts', () => {
      it('rejects with HTTP 401 when token content differs but length matches', async () => {
        // Alter single character in valid token
        const alteredToken =
          TEST_BACKUP_TOKEN.slice(0, -1) + (TEST_BACKUP_TOKEN.slice(-1) === 'X' ? 'Y' : 'X');

        const res = await request(testApp)
          .get('/api/admin/quiescence/status')
          .set('Authorization', `Bearer ${alteredToken}`);

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/Unauthorized: Missing or invalid authorization token/i);
      });

      it('rejects with HTTP 401 on arbitrary random tokens of varying lengths', async () => {
        const badTokens = [
          'short',
          crypto.randomBytes(8).toString('hex'),
          crypto.randomBytes(32).toString('hex'),
          crypto.randomBytes(64).toString('hex'),
          'A'.repeat(512)
        ];

        for (const token of badTokens) {
          const res = await request(testApp)
            .get('/api/admin/quiescence/status')
            .set('Authorization', `Bearer ${token}`);

          expect(res.status).toBe(401);
          expect(res.body.success).toBe(false);
        }
      });
    });

    describe('Public & User Session JWT Token Rejection', () => {
      it('rejects a valid user JWT session token with HTTP 401: public users must NEVER access quiescence', async () => {
        const dummyUserId = new mongoose.Types.ObjectId().toString();
        const dummySessionId = crypto.randomUUID();

        // Sign a genuine user access token using the application JWT secret
        const validUserJwt = jwt.sign(
          { id: dummyUserId, sessionId: dummySessionId, email: 'admin@example.com' },
          JWT_TEST_SECRET,
          { expiresIn: '15m' }
        );

        const endpoints = [
          { method: 'get', path: '/api/admin/quiescence/status' },
          { method: 'post', path: '/api/admin/quiescence/acquire', body: { owner: 'attacker' } },
          { method: 'post', path: '/api/admin/quiescence/heartbeat', body: { leaseId: 'fake-id' } },
          { method: 'post', path: '/api/admin/quiescence/release', body: { leaseId: 'fake-id' } }
        ];

        for (const ep of endpoints) {
          const reqBuilder = request(testApp)[ep.method](ep.path);
          reqBuilder.set('Authorization', `Bearer ${validUserJwt}`);
          if (ep.body) reqBuilder.send(ep.body);

          const res = await reqBuilder;
          expect(res.status).toBe(401);
          expect(res.body.success).toBe(false);
          expect(res.body.message).toMatch(/Unauthorized: Missing or invalid authorization token/i);
        }
      });

      it('rejects requests presenting user JWT in ambient cookie without valid backup bearer token', async () => {
        const validUserJwt = jwt.sign(
          { id: new mongoose.Types.ObjectId().toString(), sessionId: crypto.randomUUID() },
          JWT_TEST_SECRET,
          { expiresIn: '15m' }
        );

        const res = await request(testApp)
          .get('/api/admin/quiescence/status')
          .set('Cookie', `token=${validUserJwt}`);

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      });
    });

    describe('Constant-Time Verification Against Side-Channel Timing Attacks', () => {
      it('executes crypto.timingSafeEqual on fixed-length digests to neutralize timing side-channels', async () => {
        const timingSpy = vi.spyOn(crypto, 'timingSafeEqual');

        const candidateToken = 'incorrect-token-arbitrary-length-test';
        const res = await request(testApp)
          .get('/api/admin/quiescence/status')
          .set('Authorization', `Bearer ${candidateToken}`);

        expect(res.status).toBe(401);
        expect(timingSpy).toHaveBeenCalled();

        // Verify arguments passed to timingSafeEqual are equal-length 32-byte SHA-256 buffers
        const [bufA, bufB] = timingSpy.mock.calls[0];
        expect(Buffer.isBuffer(bufA)).toBe(true);
        expect(Buffer.isBuffer(bufB)).toBe(true);
        expect(bufA.length).toBe(32);
        expect(bufB.length).toBe(32);
      });

      it('validates validateBackupToken middleware unit behavior directly', () => {
        const next = vi.fn();
        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn()
        };

        // 1. Valid token invokes next()
        const validReq = {
          headers: { authorization: `Bearer ${TEST_BACKUP_TOKEN}` }
        };
        validateBackupToken(validReq, res, next);
        expect(next).toHaveBeenCalledTimes(1);

        // 2. Missing token returns 401
        const invalidReq = { headers: {} };
        validateBackupToken(invalidReq, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
      });

      it('does not throw RangeError or leak timing when candidate token length differs from secret', async () => {
        // In plain timingSafeEqual without hashing, unequal lengths throw RangeError.
        // The implementation hashes both first, ensuring 32-byte buffers invariant to input length.
        const variousLengthTokens = [
          'a',
          'ab',
          'a'.repeat(31),
          'a'.repeat(TEST_BACKUP_TOKEN.length),
          'a'.repeat(100),
          'a'.repeat(1000)
        ];

        for (const token of variousLengthTokens) {
          const res = await request(testApp)
            .get('/api/admin/quiescence/status')
            .set('Authorization', `Bearer ${token}`);

          expect(res.status).toBe(401);
          expect(res.body.success).toBe(false);
        }
      });
    });
  });

  // =========================================================================
  // SECTION 2: Secret Leakage & Redaction
  // =========================================================================
  describe('2. Secret Leakage & Redaction Verification', () => {
    let testApp;

    beforeEach(() => {
      testApp = express();
      testApp.use(express.json());
      testApp.use('/api/admin/quiescence', quiescenceRoutes);
    });

    it('NEVER leaks or echoes BACKUP_INTERNAL_TOKEN in response bodies or headers on success', async () => {
      const res = await request(testApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      expect(res.status).toBe(200);

      const bodyStr = JSON.stringify(res.body);
      const headersStr = JSON.stringify(res.headers);

      expect(bodyStr).not.toContain(TEST_BACKUP_TOKEN);
      expect(headersStr).not.toContain(TEST_BACKUP_TOKEN);
    });

    it('NEVER leaks or echoes candidate or configured tokens in error response payloads', async () => {
      const badCandidateToken = 'attacker-secret-probe-1234567890';

      const res = await request(testApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${badCandidateToken}`);

      expect(res.status).toBe(401);

      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain(TEST_BACKUP_TOKEN);
      expect(bodyStr).not.toContain(badCandidateToken);
    });

    it('NEVER logs BACKUP_INTERNAL_TOKEN in application logger messages or metadata', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const errorSpy = vi.spyOn(logger, 'error');
      const infoSpy = vi.spyOn(logger, 'info');

      // 1. Trigger failed authentication
      await request(testApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', 'Bearer invalid-token');

      // 2. Trigger disabled configuration
      delete process.env.BACKUP_INTERNAL_TOKEN;
      await request(testApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      process.env.BACKUP_INTERNAL_TOKEN = TEST_BACKUP_TOKEN;

      // 3. Trigger successful operation
      await request(testApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      const allLogCalls = [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...infoSpy.mock.calls];

      expect(allLogCalls.length).toBeGreaterThan(0);

      for (const callArgs of allLogCalls) {
        const serialized = JSON.stringify(callArgs);
        expect(serialized).not.toContain(TEST_BACKUP_TOKEN);
      }
    });
  });

  // =========================================================================
  // SECTION 3: Route Gating Bypass Attempts During Quiescence
  // =========================================================================
  describe('3. Route Gating Bypass Resistance During Quiescence', () => {
    describe('Direct End-to-End Testing on Full Server Application (app)', () => {
      let activeLeaseId;

      beforeEach(async () => {
        // Acquire genuine quiescence lease in MongoDB and transition directly to QUIESCED
        const acquireResult = await quiescenceService.acquire({
          owner: 'backup-security-verifier',
          initialStatus: BACKUP_LEASE_STATUS.QUIESCED,
          initialLeaseMs: 60000
        });

        expect(acquireResult.success).toBe(true);
        expect(acquireResult.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
        activeLeaseId = acquireResult.leaseId;
      });

      afterEach(async () => {
        // Release lease back to NORMAL
        if (activeLeaseId) {
          await quiescenceService.release({ leaseId: activeLeaseId });
        }
      });

      it('blocks POST /api/forms with HTTP 503 and Retry-After: 5 during quiescence', async () => {
        const res = await request(app)
          .post('/api/forms')
          .set('Origin', 'http://localhost:5173')
          .send({ title: 'Adversarial Form Create Attempt' });

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
        expect(res.body.error).toMatch(/System is undergoing scheduled maintenance\/backup/i);
      });

      it('blocks PUT /api/forms/:id with HTTP 503 and Retry-After: 5 during quiescence', async () => {
        const fakeFormId = new mongoose.Types.ObjectId().toString();
        const res = await request(app)
          .put(`/api/forms/${fakeFormId}`)
          .set('Origin', 'http://localhost:5173')
          .send({ title: 'Adversarial Form Update Attempt' });

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('blocks DELETE /api/forms/:id with HTTP 503 and Retry-After: 5 during quiescence', async () => {
        const fakeFormId = new mongoose.Types.ObjectId().toString();
        const res = await request(app)
          .delete(`/api/forms/${fakeFormId}`)
          .set('Origin', 'http://localhost:5173');

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('blocks POST /api/responses/:formId with HTTP 503 and Retry-After: 5 during quiescence', async () => {
        const fakeFormId = new mongoose.Types.ObjectId().toString();
        const res = await request(app)
          .post(`/api/responses/${fakeFormId}`)
          .set('Origin', 'http://localhost:5173')
          .send({ answers: [] });

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('blocks POST /api/auth/register with HTTP 503 and Retry-After: 5 during quiescence', async () => {
        const res = await request(app)
          .post('/api/auth/register')
          .set('Origin', 'http://localhost:5173')
          .send({
            name: 'Adversarial User',
            email: 'adversary@example.com',
            password: 'ValidPassword123!'
          });

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('blocks POST /api/auth/login with HTTP 503 and Retry-After: 5 during quiescence', async () => {
        const res = await request(app)
          .post('/api/auth/login')
          .set('Origin', 'http://localhost:5173')
          .send({
            email: 'user@example.com',
            password: 'Password123!'
          });

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('ALLOWS read-only GET /health to function during quiescence (HTTP 200)', async () => {
        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('live');
        expect(res.body.code).toBeUndefined();
      });

      it('ALLOWS read-only GET /api/health to function during quiescence (HTTP 200)', async () => {
        const res = await request(app).get('/api/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('live');
      });

      it('ALLOWS readiness probe GET /health/ready to bypass quiescence gate', async () => {
        const res = await request(app).get('/health/ready');

        // Readiness probe executes its own health check and is not blocked by quiescence gate
        expect(res.body.code).not.toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('ALLOWS read-only GET /api/forms/:id to bypass quiescence gate', async () => {
        const fakeFormId = new mongoose.Types.ObjectId().toString();
        const res = await request(app).get(`/api/forms/${fakeFormId}`);

        // The request passes the quiescence gate and reaches formController (returns 404 for nonexistent form)
        expect(res.status).not.toBe(503);
        expect(res.body.code).not.toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('ALLOWS /api/admin/quiescence/* endpoints to ALWAYS bypass the quiescence gate', async () => {
        // Status query
        const statusRes = await request(app)
          .get('/api/admin/quiescence/status')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

        expect(statusRes.status).toBe(200);
        expect(statusRes.body.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

        // Heartbeat renewal
        const heartbeatRes = await request(app)
          .post('/api/admin/quiescence/heartbeat')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({ leaseId: activeLeaseId });

        expect(heartbeatRes.status).toBe(200);
        expect(heartbeatRes.body.success).toBe(true);

        // Lease release
        const releaseRes = await request(app)
          .post('/api/admin/quiescence/release')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({ leaseId: activeLeaseId });

        expect(releaseRes.status).toBe(200);
        expect(releaseRes.body.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      });

      it('restores normal business route mutations immediately after lease is released to NORMAL', async () => {
        // Release lease
        await quiescenceService.release({ leaseId: activeLeaseId });

        // Verify POST /api/auth/register is no longer blocked by quiescence gate
        const res = await request(app)
          .post('/api/auth/register')
          .set('Origin', 'http://localhost:5173')
          .send({
            name: 'Normal User',
            email: 'normal@example.com',
            password: 'ValidPassword123!'
          });

        expect(res.status).not.toBe(503);
        expect(res.body.code).not.toBe('BACKUP_QUIESCENCE_ACTIVE');
      });
    });

    describe('QuiescenceGate Isolation & Boundary Conditions', () => {
      it('blocks mutating requests when status is DRAINING as well as QUIESCED', async () => {
        setQuiescenceService({
          isDrainingOrQuiesced: async () => true
        });

        const testApp = express();
        testApp.use(quiescenceGate);
        testApp.post('/api/any-business-route', (req, res) => res.status(200).json({ ok: true }));

        const res = await request(testApp).post('/api/any-business-route');

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('allows HEAD and OPTIONS requests through cleanly during quiescence', async () => {
        setQuiescenceService({
          isDrainingOrQuiesced: async () => true
        });

        const testApp = express();
        testApp.use(quiescenceGate);
        testApp.head('/api/resource', (req, res) => res.status(200).end());
        testApp.options('/api/resource', (req, res) => res.status(204).end());

        const headRes = await request(testApp).head('/api/resource');
        expect(headRes.status).toBe(200);

        const optionsRes = await request(testApp).options('/api/resource');
        expect(optionsRes.status).toBe(204);
      });
    });
  });

  // =========================================================================
  // SECTION 4: Container Privilege & Network Boundary Review (Automated)
  // =========================================================================
  describe('4. Container Privilege & Network Boundary Verification', () => {
    const rootDir = path.resolve(__dirname, '../../../');
    const prodComposePath = path.join(rootDir, 'docker-compose.yml');
    const stagingComposePath = path.join(rootDir, 'docker-compose.staging.yml');

    it('verifies production docker-compose.yml enforces strict least-privilege container constraints', () => {
      expect(fs.existsSync(prodComposePath)).toBe(true);
      const content = fs.readFileSync(prodComposePath, 'utf8');
      const compose = yaml.load(content);

      expect(compose.services).toBeDefined();
      expect(compose.services.backup).toBeDefined();
      const backup = compose.services.backup;

      // 1. Privileged container verification: privileged must be false or omitted (never true)
      expect(backup.privileged).not.toBe(true);

      // 2. Security opt: no-new-privileges:true
      expect(backup.security_opt).toBeDefined();
      expect(backup.security_opt).toContain('no-new-privileges:true');

      // 3. Capabilities: cap_drop: [ALL]
      expect(backup.cap_drop).toBeDefined();
      expect(backup.cap_drop).toContain('ALL');

      // 4. Read-only filesystem with tmpfs
      expect(backup.read_only).toBe(true);
      expect(backup.tmpfs).toBeDefined();
      expect(backup.tmpfs).toContain('/tmp:mode=1777,size=128M');

      // 5. Non-root user: "10001:10001"
      expect(backup.user).toBe('10001:10001');

      // 6. Absolute prohibition of Docker socket mount (/var/run/docker.sock)
      const volumes = backup.volumes || [];
      const hasDockerSocket = volumes.some((v) => String(v).includes('docker.sock'));
      expect(hasDockerSocket).toBe(false);

      // 7. Dedicated persistent backup spool volume
      expect(volumes).toContain('backup_spool:/backup/spool');
      expect(compose.volumes).toBeDefined();
      expect(compose.volumes.backup_spool).toBeDefined();

      // 8. Strict network isolation: attached ONLY to backend-network, NOT frontend-network
      expect(backup.networks).toBeDefined();
      expect(backup.networks).toContain('backend-network');
      expect(backup.networks).not.toContain('frontend-network');

      // 9. No exposed host ports
      expect(backup.ports).toBeUndefined();
    });

    it('verifies staging docker-compose.staging.yml enforces identical least-privilege container constraints', () => {
      expect(fs.existsSync(stagingComposePath)).toBe(true);
      const content = fs.readFileSync(stagingComposePath, 'utf8');
      const compose = yaml.load(content);

      expect(compose.services).toBeDefined();
      expect(compose.services.backup).toBeDefined();
      const backup = compose.services.backup;

      // 1. Privileged container verification
      expect(backup.privileged).not.toBe(true);

      // 2. Security opt: no-new-privileges:true
      expect(backup.security_opt).toBeDefined();
      expect(backup.security_opt).toContain('no-new-privileges:true');

      // 3. Capabilities: cap_drop: [ALL]
      expect(backup.cap_drop).toBeDefined();
      expect(backup.cap_drop).toContain('ALL');

      // 4. Read-only root filesystem with tmpfs
      expect(backup.read_only).toBe(true);
      expect(backup.tmpfs).toBeDefined();
      expect(backup.tmpfs).toContain('/tmp:mode=1777,size=128M');

      // 5. Dedicated non-root user: "10001:10001"
      expect(backup.user).toBe('10001:10001');

      // 6. Absolute prohibition of Docker socket mount
      const volumes = backup.volumes || [];
      const hasDockerSocket = volumes.some((v) => String(v).includes('docker.sock'));
      expect(hasDockerSocket).toBe(false);

      // 7. Staging backup spool volume
      expect(volumes).toContain('staging_backup_spool:/backup/spool');
      expect(compose.volumes).toBeDefined();
      expect(compose.volumes.staging_backup_spool).toBeDefined();

      // 8. Strict network boundary: ONLY staging-backend-network, NOT staging-frontend-network
      expect(backup.networks).toBeDefined();
      expect(backup.networks).toContain('staging-backend-network');
      expect(backup.networks).not.toContain('staging-frontend-network');

      // 9. No exposed host ports
      expect(backup.ports).toBeUndefined();
    });

    it('verifies dedicated backup Dockerfile creates non-root user 10001:10001 and strict directory layout', () => {
      const dockerfilePath = path.join(rootDir, 'backup/Dockerfile');
      expect(fs.existsSync(dockerfilePath)).toBe(true);
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

      // Non-root user and group creation
      expect(dockerfile).toMatch(/addgroup\s+-g\s+10001/);
      expect(dockerfile).toMatch(/adduser\s+-u\s+10001/);
      expect(dockerfile).toMatch(/USER\s+10001:10001/);

      // Required directory layout
      expect(dockerfile).toContain('/backup/config');
      expect(dockerfile).toContain('/backup/spool');
      expect(dockerfile).toContain('/backup/manifests');
      expect(dockerfile).toContain('/backup/logs');
      expect(dockerfile).toContain('/backup/temporary');

      // Strict permissions
      expect(dockerfile).toMatch(/chmod\s+-R\s+750\s+\/backup/);
      expect(dockerfile).toMatch(/chown\s+-R\s+10001:10001\s+\/backup/);
    });
  });
});
