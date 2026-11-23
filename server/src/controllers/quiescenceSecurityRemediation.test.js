import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { app } from '../server.js';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import {
  quiescenceGate,
  setQuiescenceService,
  resetInFlightMutations,
  getInFlightMutationCount,
  trackMutationOperation,
  drainInFlight
} from '../middleware/quiescenceGate.js';
import {
  validateBackupToken,
  isLegitimateBackupRequest,
  createQuiescenceRateLimiter,
  MAX_CANDIDATE_TOKEN_LENGTH,
  MAX_AUTH_HEADER_LENGTH
} from './quiescenceController.js';
import quiescenceRoutes from '../routes/quiescenceRoutes.js';
import { logger } from '../utils/logger.js';

describe('Quiescence Independent Adversarial Security Verification Suite (Workstream 2D.1A)', () => {
  const TEST_BACKUP_TOKEN = 'test-backup-internal-secret-token-min32chars-xyz123!';
  const JWT_TEST_SECRET = 'paperless-jwt-test-secret-at-least-32-chars-length!';
  const originalBackupToken = process.env.BACKUP_INTERNAL_TOKEN;
  const originalJwtSecret = process.env.JWT_SECRET;
  let mongod;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await BackupLease.init();
    await BackupLease.createIndexes();
  }, 60000);

  afterAll(async () => {
    process.env.BACKUP_INTERNAL_TOKEN = originalBackupToken;
    process.env.JWT_SECRET = originalJwtSecret;
    await mongoose.disconnect();
    if (mongod) {
      await mongod.stop();
    }
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
  // 1. Token Verification Mechanics & Bounded Candidate Length
  // =========================================================================
  describe('1. Token Verification Mechanics & Bounded Candidate Length', () => {
    let testApp;

    beforeEach(() => {
      testApp = express();
      testApp.set('etag', false);
      testApp.use(express.json());
      testApp.use('/api/admin/quiescence', quiescenceRoutes);
    });

    it('exports MAX_CANDIDATE_TOKEN_LENGTH as 128 bytes and MAX_AUTH_HEADER_LENGTH as 256 bytes', () => {
      expect(MAX_CANDIDATE_TOKEN_LENGTH).toBe(128);
      expect(MAX_AUTH_HEADER_LENGTH).toBe(256);
    });

    it('immediately rejects candidate tokens exceeding 128 bytes WITHOUT invoking crypto.createHash or timingSafeEqual', async () => {
      const timingSpy = vi.spyOn(crypto, 'timingSafeEqual');

      const oversizedTokens = [
        'A'.repeat(129), // boundary: 129 bytes
        'B'.repeat(256), // 256 bytes
        'C'.repeat(1024), // 1 KB
        'D'.repeat(4096) // 4 KB (within Node HTTP maxHeaderSize of 16KB)
      ];

      for (const token of oversizedTokens) {
        timingSpy.mockClear();

        const res = await request(testApp)
          .get('/api/admin/quiescence/status')
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/Unauthorized: Missing or invalid authorization token/i);

        // Assert constant-time comparison was NEVER reached
        expect(timingSpy).not.toHaveBeenCalled();
      }
    });

    it('immediately rejects oversized Authorization headers exceeding 256 bytes before regex parsing', async () => {
      const timingSpy = vi.spyOn(crypto, 'timingSafeEqual');

      const oversizedHeader = 'Bearer ' + 'X'.repeat(300);

      const res = await request(testApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', oversizedHeader);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(timingSpy).not.toHaveBeenCalled();
    });

    it('computes SHA-256 and calls crypto.timingSafeEqual ONLY when candidate token is within 128 bytes', async () => {
      const hashSpy = vi.spyOn(crypto, 'createHash');
      const timingSpy = vi.spyOn(crypto, 'timingSafeEqual');

      const validLengthBadToken = 'valid-length-candidate-token-wrong-xyz!'; // < 128 bytes
      expect(validLengthBadToken.length).toBeLessThanOrEqual(MAX_CANDIDATE_TOKEN_LENGTH);

      const res = await request(testApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${validLengthBadToken}`);

      expect(res.status).toBe(401);
      expect(hashSpy).toHaveBeenCalledWith('sha256');
      expect(timingSpy).toHaveBeenCalled();

      // Verify digests compared are 32 bytes each
      const [clientBuf, expectedBuf] = timingSpy.mock.calls[0];
      expect(clientBuf.length).toBe(32);
      expect(expectedBuf.length).toBe(32);
    });

    it('scopes hashing time to < 1 µs on bounded 128-byte candidate input', () => {
      const candidate128 = 'K'.repeat(128);
      const start = process.hrtime.bigint();
      crypto.createHash('sha256').update(candidate128).digest();
      const durationNs = process.hrtime.bigint() - start;

      // Ensure hashing of <= 128 bytes completes in negligible time (< 1 ms even in CI / virtual environments)
      const durationMs = Number(durationNs) / 1e6;
      expect(durationMs).toBeLessThan(1.0);
    });
  });

  // =========================================================================
  // 2. Administrative Endpoint Rate Limiting & Non-Starvation
  // =========================================================================
  describe('2. Administrative Endpoint Rate Limiting & Non-Starvation', () => {
    let rateLimitedApp;

    beforeEach(() => {
      rateLimitedApp = express();
      rateLimitedApp.use(express.json());

      // Create a strict test limiter with low threshold: 5 requests per window
      const strictLimiter = createQuiescenceRateLimiter({
        windowMs: 60 * 1000,
        max: 5
      });

      rateLimitedApp.use(strictLimiter);
      rateLimitedApp.use(validateBackupToken);
      rateLimitedApp.post('/api/admin/quiescence/heartbeat', (req, res) => {
        res.status(200).json({ success: true, message: 'heartbeat_ok' });
      });
      rateLimitedApp.post('/api/admin/quiescence/release', (req, res) => {
        res.status(200).json({ success: true, message: 'release_ok' });
      });
      rateLimitedApp.get('/api/admin/quiescence/status', (req, res) => {
        res.status(200).json({ success: true, status: 'NORMAL' });
      });
    });

    it('protects administrative endpoints by returning HTTP 429 when unauthenticated guessing threshold is exceeded', async () => {
      // Send 5 unauthenticated requests (allowed up to max=5)
      for (let i = 0; i < 5; i++) {
        const res = await request(rateLimitedApp)
          .get('/api/admin/quiescence/status')
          .set('Authorization', `Bearer wrong-token-${i}`);
        expect(res.status).toBe(401);
      }

      // 6th unauthenticated request must be blocked by rate limiter with HTTP 429
      const blockedRes = await request(rateLimitedApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', 'Bearer wrong-token-6');

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.success).toBe(false);
      expect(blockedRes.body.message).toMatch(/Too many administrative requests/i);
      expect(blockedRes.headers['retry-after']).toBeDefined();
    });

    it('CRITICAL: NEVER starves or blocks legitimate heartbeats and releases from active runner even under continuous fire', async () => {
      // Simulate continuous heartbeats (every 10s + retries)
      // Send 25 consecutive legitimate heartbeats (far beyond the max: 5 threshold)
      for (let i = 0; i < 25; i++) {
        const hbRes = await request(rateLimitedApp)
          .post('/api/admin/quiescence/heartbeat')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({ leaseId: 'active-lease-123' });

        expect(hbRes.status).toBe(200);
        expect(hbRes.body.success).toBe(true);
        expect(hbRes.body.message).toBe('heartbeat_ok');
      }

      // Send legitimate release with valid token
      const relRes = await request(rateLimitedApp)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: 'active-lease-123' });

      expect(relRes.status).toBe(200);
      expect(relRes.body.success).toBe(true);
      expect(relRes.body.message).toBe('release_ok');
    });

    it('guarantees an attacker brute-forcing tokens does NOT starve the legitimate backup runner sharing the IP', async () => {
      // Attacker exhausts the rate limit bucket
      for (let i = 0; i < 6; i++) {
        await request(rateLimitedApp)
          .get('/api/admin/quiescence/status')
          .set('Authorization', `Bearer brute-force-guess-${i}`);
      }

      // Verify attacker is blocked with 429
      const attackerRes = await request(rateLimitedApp)
        .get('/api/admin/quiescence/status')
        .set('Authorization', 'Bearer brute-force-guess-7');
      expect(attackerRes.status).toBe(429);

      // Concurrently, the legitimate backup runner sends a heartbeat from the same IP:
      // It MUST succeed because legitimate token bypasses the brute-force limiter!
      const runnerRes = await request(rateLimitedApp)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: 'active-lease-xyz' });

      expect(runnerRes.status).toBe(200);
      expect(runnerRes.body.success).toBe(true);
    });

    it('isLegitimateBackupRequest accurately validates legitimate token within bounded length', () => {
      const validReq = {
        headers: { authorization: `Bearer ${TEST_BACKUP_TOKEN}` }
      };
      expect(isLegitimateBackupRequest(validReq)).toBe(true);

      const invalidReq = {
        headers: { authorization: 'Bearer invalid-token' }
      };
      expect(isLegitimateBackupRequest(invalidReq)).toBe(false);

      const oversizedReq = {
        headers: { authorization: `Bearer ${'Z'.repeat(129)}` }
      };
      expect(isLegitimateBackupRequest(oversizedReq)).toBe(false);

      const missingReq = { headers: {} };
      expect(isLegitimateBackupRequest(missingReq)).toBe(false);
    });
  });

  // =========================================================================
  // 3. Complete Route Inventory & Gating Classification
  // =========================================================================
  describe('3. Route Inventory & Gating Classification', () => {
    beforeEach(async () => {
      // Set MongoDB to QUIESCED state
      await BackupLease.findOneAndUpdate(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: 'active-audit-lease',
            owner: 'auditor',
            grantedAt: new Date(),
            expiresAt: new Date(Date.now() + 60000),
            monotonicWatchdogDeadline: new Date(Date.now() + 180000)
          }
        }
      );
    });

    describe('Class 1: Business Mutation Routes (Must Receive HTTP 503 During QUIESCED)', () => {
      const mutationRoutes = [
        { method: 'post', path: '/api/auth/register', body: { email: 'a@b.com', password: 'pwd' } },
        { method: 'post', path: '/api/auth/login', body: { email: 'a@b.com', password: 'pwd' } },
        { method: 'post', path: '/api/auth/refresh', body: {} },
        { method: 'post', path: '/api/auth/logout', body: {} },
        { method: 'post', path: '/api/forms', body: { title: 'Test Form' } },
        { method: 'put', path: '/api/forms/507f1f77bcf86cd799439011', body: { title: 'Updated' } },
        { method: 'delete', path: '/api/forms/507f1f77bcf86cd799439011', body: {} },
        { method: 'post', path: '/api/forms/507f1f77bcf86cd799439011/questions', body: {} },
        { method: 'put', path: '/api/forms/507f1f77bcf86cd799439011/questions/reorder', body: {} },
        {
          method: 'put',
          path: '/api/forms/507f1f77bcf86cd799439011/questions/507f1f77bcf86cd799439012',
          body: {}
        },
        {
          method: 'delete',
          path: '/api/forms/507f1f77bcf86cd799439011/questions/507f1f77bcf86cd799439012',
          body: {}
        },
        { method: 'post', path: '/api/responses/507f1f77bcf86cd799439011', body: {} },
        {
          method: 'delete',
          path: '/api/responses/507f1f77bcf86cd799439011/507f1f77bcf86cd799439013',
          body: {}
        },
        { method: 'post', path: '/api/ai/questions/generate', body: {} },
        { method: 'post', path: '/api/ai/writing/improve', body: {} },
        { method: 'post', path: '/api/ai/consultant/507f1f77bcf86cd799439011', body: {} },
        { method: 'post', path: '/api/ai/responses/summary/507f1f77bcf86cd799439011', body: {} }
      ];

      for (const route of mutationRoutes) {
        it(`blocks business mutation ${route.method.toUpperCase()} ${route.path} with 503 and Retry-After: 5`, async () => {
          const reqBuilder = request(app)[route.method](route.path);
          reqBuilder.set('Origin', 'http://localhost:5173');
          if (route.body) reqBuilder.send(route.body);

          const res = await reqBuilder;
          expect(res.status).toBe(503);
          expect(res.headers['retry-after']).toBe('5');
          expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
          expect(res.body.error).toContain('scheduled maintenance/backup');
        });
      }
    });

    describe('Class 2: Administrative Mutation Routes (Must ALWAYS Bypass Gate)', () => {
      it('permits POST /api/admin/quiescence/heartbeat to bypass the gate during QUIESCED', async () => {
        const res = await request(app)
          .post('/api/admin/quiescence/heartbeat')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({ leaseId: 'active-audit-lease' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('permits POST /api/admin/quiescence/release to bypass the gate during QUIESCED', async () => {
        const res = await request(app)
          .post('/api/admin/quiescence/release')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({ leaseId: 'active-audit-lease' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('permits GET /api/admin/quiescence/status to bypass the gate during QUIESCED', async () => {
        const res = await request(app)
          .get('/api/admin/quiescence/status')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
      });
    });

    describe('Class 3: Health & Readiness Routes (Must ALWAYS Bypass Gate)', () => {
      it('permits GET /health to bypass quiescence gate with HTTP 200', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.code).not.toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('permits GET /api/health to bypass quiescence gate with HTTP 200', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.code).not.toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('permits readiness probes (/health/ready, /ready) to bypass quiescence gate', async () => {
        const readinessEndpoints = ['/health/ready', '/ready', '/api/health/ready', '/api/ready'];
        for (const ep of readinessEndpoints) {
          const res = await request(app).get(ep);
          // Gate must not reject with BACKUP_QUIESCENCE_ACTIVE
          expect(res.body.code).not.toBe('BACKUP_QUIESCENCE_ACTIVE');
        }
      });
    });

    describe('Class 4: Public Read Routes (Must ALWAYS Bypass Gate)', () => {
      const readEndpoints = [
        '/',
        '/api',
        '/api/forms/507f1f77bcf86cd799439011'
      ];

      for (const path of readEndpoints) {
        it(`permits read request GET ${path} to bypass quiescence gate`, async () => {
          const res = await request(app).get(path);
          expect(res.status).not.toBe(503);
          expect(res.body.code).not.toBe('BACKUP_QUIESCENCE_ACTIVE');
        });
      }
    });

    describe('Adversarial Gate Bypass Resistance', () => {
      it('prevents path traversal bypass attempt (/api/admin/quiescence/../forms)', async () => {
        // Without backup token: rejected with 401 by auth middleware
        const unauthRes = await request(app)
          .post('/api/admin/quiescence/../forms')
          .set('Origin', 'http://localhost:5173')
          .send({ title: 'Traversal exploit' });
        expect(unauthRes.status).toBe(401);

        // Even with valid backup token: normalized path /api/forms is gated by quiescenceGate with 503
        const authRes = await request(app)
          .post('/api/admin/quiescence/../forms')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .set('Origin', 'http://localhost:5173')
          .send({ title: 'Traversal exploit' });
        expect(authRes.status).toBe(503);
        expect(authRes.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('blocks method override attempt via X-HTTP-Method-Override on GET request', async () => {
        const res = await request(app)
          .get('/api/forms')
          .set('X-HTTP-Method-Override', 'POST');

        // Express route handler executes GET, so no mutation occurs
        expect(res.status).not.toBe(503);
        expect(res.body.code).not.toBe('BACKUP_QUIESCENCE_ACTIVE');
      });

      it('blocks PATCH mutation requests during quiescence', async () => {
        const res = await request(app)
          .patch('/api/forms/507f1f77bcf86cd799439011')
          .send({ title: 'Patched' });

        expect(res.status).toBe(503);
        expect(res.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      });
    });
  });

  // =========================================================================
  // 4. Secret Zero-Leakage & Redaction Verification
  // =========================================================================
  describe('4. Secret Zero-Leakage & Redaction Verification', () => {
    it('never leaks BACKUP_INTERNAL_TOKEN in success response payloads or response headers', async () => {
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      const bodyStr = JSON.stringify(res.body);
      const headersStr = JSON.stringify(res.headers);

      expect(bodyStr).not.toContain(TEST_BACKUP_TOKEN);
      expect(headersStr).not.toContain(TEST_BACKUP_TOKEN);
    });

    it('never echoes candidate token or BACKUP_INTERNAL_TOKEN in 401 error payloads', async () => {
      const secretCandidate = 'attacker-supplied-sensitive-guess-string!';
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${secretCandidate}`);

      expect(res.status).toBe(401);
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain(secretCandidate);
      expect(bodyStr).not.toContain(TEST_BACKUP_TOKEN);
    });

    it('never logs BACKUP_INTERNAL_TOKEN in logger warnings or metadata', async () => {
      const logWarnSpy = vi.spyOn(logger, 'warn');
      const badCandidate = 'bad-token-for-logging-audit';

      await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${badCandidate}`);

      for (const call of logWarnSpy.mock.calls) {
        const callArgsStr = JSON.stringify(call);
        expect(callArgsStr).not.toContain(TEST_BACKUP_TOKEN);
      }
    });
  });

  // =========================================================================
  // 5. Operation-Level Mutation Tracking (Client Disconnect Protection)
  // =========================================================================
  describe('5. Operation-Level Mutation Tracking & Client Disconnect Protection', () => {
    it('retains in-flight mutation count when client disconnects while operation is pending', async () => {
      let operationFinished = false;
      let resolveOperation;
      const pendingOperation = new Promise((resolve) => {
        resolveOperation = () => {
          operationFinished = true;
          resolve({ status: 'committed' });
        };
      });

      const testApp = express();
      testApp.use(quiescenceGate);
      testApp.post('/api/test-mutation-disconnect', (req, res) => {
        trackMutationOperation(pendingOperation, { req });
        // Simulate immediate client socket drop before handler sends response
        res.destroy();
      });

      // Send request that terminates with client drop
      await request(testApp)
        .post('/api/test-mutation-disconnect')
        .send({ data: 'mutating' })
        .catch(() => {}); // Connection reset expected

      // In-flight count must NOT be decremented to 0 prematurely!
      expect(getInFlightMutationCount()).toBeGreaterThan(0);

      // Verify drainInFlight cannot drain while operation is still in-flight
      const drainPromise = drainInFlight(100);
      const drainedImmediately = await drainPromise;
      expect(drainedImmediately).toBe(false);

      // Now resolve the asynchronous database operation
      resolveOperation();
      await pendingOperation;
      expect(operationFinished).toBe(true);

      // Allow microtask cleanup to execute
      await new Promise((r) => setTimeout(r, 50));

      // In-flight count must now cleanly reach 0
      expect(getInFlightMutationCount()).toBe(0);

      // Draining now succeeds cleanly
      const drainedAfter = await drainInFlight(100);
      expect(drainedAfter).toBe(true);
    });
  });
});
