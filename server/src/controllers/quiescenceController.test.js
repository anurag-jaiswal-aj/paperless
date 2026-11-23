import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import quiescenceRoutes from '../routes/quiescenceRoutes.js';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID
} from '../models/backupLease.js';

describe('QuiescenceController & API Hardening Suite', () => {
  let mongod;
  let app;
  const TEST_BACKUP_TOKEN = 'test-backup-internal-secret-token-xyz-123';
  const originalEnv = process.env.BACKUP_INTERNAL_TOKEN;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await BackupLease.init();
    await BackupLease.createIndexes();

    process.env.BACKUP_INTERNAL_TOKEN = TEST_BACKUP_TOKEN;

    // Create an isolated Express application mounting quiescenceRoutes
    app = express();
    app.use(express.json());
    app.use('/api/admin/quiescence', quiescenceRoutes);
  });

  afterEach(async () => {
    process.env.BACKUP_INTERNAL_TOKEN = originalEnv;
    await mongoose.disconnect();
    await mongod.stop();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Authentication Middleware & Fail-Closed Security Policy
  // =========================================================================
  describe('Authentication Middleware (validateBackupToken)', () => {
    it('fails closed with HTTP 503 when BACKUP_INTERNAL_TOKEN is unset', async () => {
      delete process.env.BACKUP_INTERNAL_TOKEN;

      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Backup administrative interface disabled');
    });

    it('fails closed with HTTP 503 when BACKUP_INTERNAL_TOKEN is empty or whitespace', async () => {
      process.env.BACKUP_INTERNAL_TOKEN = '   ';

      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Backup administrative interface disabled');
    });

    it('rejects with HTTP 401 when Authorization header is completely missing', async () => {
      const res = await request(app).get('/api/admin/quiescence/status');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Unauthorized/i);
    });

    it('rejects with HTTP 401 when Authorization header does not use Bearer scheme', async () => {
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Basic ${TEST_BACKUP_TOKEN}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Unauthorized/i);
    });

    it('rejects with HTTP 401 when Bearer token is empty', async () => {
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', 'Bearer ');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Unauthorized/i);
    });

    it('rejects with HTTP 401 when provided token is wrong (different content)', async () => {
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', 'Bearer invalid-secret-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Unauthorized/i);
    });

    it('rejects with HTTP 401 when provided token is wrong length', async () => {
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}-extra-suffix`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Unauthorized/i);
    });

    it('never leaks the configured token or client token in response body', async () => {
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', 'Bearer malicious-attacker-payload');

      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain(TEST_BACKUP_TOKEN);
      expect(bodyStr).not.toContain('malicious-attacker-payload');
    });

    it('authenticates successfully when valid Bearer token is supplied', async () => {
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('NORMAL');
    });
  });

  // =========================================================================
  // 2. POST /api/admin/quiescence/acquire
  // =========================================================================
  describe('POST /api/admin/quiescence/acquire', () => {
    it('acquires distributed backup lease and returns 200 with lease metadata', async () => {
      const res = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          owner: 'backup-agent-pod-1',
          leaseDurationMs: 45000,
          maxWatchdogMs: 180000
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.leaseId).toBeDefined();
      expect(res.body.status).toBe('DRAINING');
      expect(res.body.owner).toBe('backup-agent-pod-1');
      expect(res.body.expiresAt).toBeDefined();
      expect(res.body.monotonicWatchdogDeadline).toBeDefined();

      // Verify in DB
      const dbDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(dbDoc.leaseId).toBe(res.body.leaseId);
      expect(dbDoc.status).toBe('DRAINING');
    });

    it('returns 409 Conflict when a concurrent lease is already active', async () => {
      // First acquire succeeds
      const first = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'agent-1' });
      expect(first.status).toBe(200);

      // Second acquire conflicts
      const second = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'agent-2' });

      expect(second.status).toBe(409);
      expect(second.body.success).toBe(false);
      expect(second.body.reason).toBe('CONCURRENT_LEASE_ACTIVE');
      expect(second.body.currentLease).toBeDefined();
      expect(second.body.currentLease.leaseId).toBe(first.body.leaseId);
      expect(second.body.currentLease.owner).toBe('agent-1');
    });
  });

  // =========================================================================
  // 3. POST /api/admin/quiescence/heartbeat
  // =========================================================================
  describe('POST /api/admin/quiescence/heartbeat', () => {
    it('returns 400 Bad Request when leaseId is omitted from request body', async () => {
      const res = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/leaseId is required/i);
    });

    it('renews active lease and returns 200 with updated expiresAt', async () => {
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseDurationMs: 20000, maxWatchdogMs: 120000 });

      const leaseId = acqRes.body.leaseId;
      const originalExpiresAt = new Date(acqRes.body.expiresAt).getTime();

      const hbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId, heartbeatExtendMs: 40000 });

      expect(hbRes.status).toBe(200);
      expect(hbRes.body.success).toBe(true);
      expect(hbRes.body.leaseId).toBe(leaseId);
      expect(new Date(hbRes.body.expiresAt).getTime()).toBeGreaterThan(originalExpiresAt);
    });

    it('returns 409 Conflict when heartbeat is sent for non-matching or expired lease', async () => {
      const res = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: 'non-matching-lease-id' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.reason).toBe('LEASE_NOT_FOUND_OR_MISMATCH');
    });
  });

  // =========================================================================
  // 4. POST /api/admin/quiescence/release
  // =========================================================================
  describe('POST /api/admin/quiescence/release', () => {
    it('returns 400 Bad Request when leaseId is omitted from request body', async () => {
      const res = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/leaseId is required/i);
    });

    it('releases active lease and returns 200 with status NORMAL', async () => {
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({});

      const leaseId = acqRes.body.leaseId;

      const relRes = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId });

      expect(relRes.status).toBe(200);
      expect(relRes.body.success).toBe(true);
      expect(relRes.body.status).toBe('NORMAL');

      // Verify DB document is reset
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe('NORMAL');
      expect(doc.leaseId).toBeNull();
    });

    it('returns 409 Conflict when leaseId does not match active lease', async () => {
      await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({});

      const relRes = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: 'wrong-uuid-during-release' });

      expect(relRes.status).toBe(409);
      expect(relRes.body.success).toBe(false);
      expect(relRes.body.reason).toBe('LEASE_NOT_FOUND_OR_MISMATCH');
    });
  });

  // =========================================================================
  // 5. GET /api/admin/quiescence/status
  // =========================================================================
  describe('GET /api/admin/quiescence/status', () => {
    it('returns current durable status when system is in NORMAL state', async () => {
      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('NORMAL');
      expect(res.body.isQuiesced).toBe(false);
      expect(res.body.isExpired).toBe(false);
      expect(res.body.leaseId).toBeNull();
    });

    it('reflects updated state across lease lifecycle: acquire -> markQuiesced -> release', async () => {
      // 1. Acquire
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'lifecycle-tester' });
      const leaseId = acqRes.body.leaseId;

      let statusRes = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);
      expect(statusRes.body.status).toBe('DRAINING');
      expect(statusRes.body.leaseId).toBe(leaseId);
      expect(statusRes.body.isQuiesced).toBe(false);

      // 2. Mark Quiesced
      const qRes = await request(app)
        .post('/api/admin/quiescence/quiesce')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId });
      expect(qRes.status).toBe(200);

      statusRes = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);
      expect(statusRes.body.status).toBe('QUIESCED');
      expect(statusRes.body.isQuiesced).toBe(true);

      // 3. Release
      const relRes = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId });
      expect(relRes.status).toBe(200);

      statusRes = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);
      expect(statusRes.body.status).toBe('NORMAL');
      expect(statusRes.body.isQuiesced).toBe(false);
      expect(statusRes.body.leaseId).toBeNull();
    });
  });
});
