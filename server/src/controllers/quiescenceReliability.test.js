import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import quiescenceRoutes from '../routes/quiescenceRoutes.js';
import {
  quiescenceGate,
  getInFlightMutationCount,
  resetInFlightMutations,
  setQuiescenceService
} from '../middleware/quiescenceGate.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

const TEST_BACKUP_TOKEN = 'test-reliability-secret-token-abcdef123456';

describe('Phase 4.4 Workstream 2D.1: Quiescence Reliability, Concurrency & Failure Recovery Suite', () => {
  let replSet;
  let app;
  let savedEnv;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.BACKUP_INTERNAL_TOKEN = TEST_BACKUP_TOKEN;
    process.env.BACKUP_LEASE_DURATION_MS = '60000';
    process.env.BACKUP_MAX_WATCHDOG_MS = '180000';
    process.env.BACKUP_HEARTBEAT_EXTEND_MS = '30000';

    replSet = await startReplSet([BackupLease]);

    app = express();
    app.use(express.json());

    // Mount Quiescence Admin API
    app.use('/api/admin/quiescence', quiescenceRoutes);

    // Mount Quiescence Write-Rejection Gate
    app.use(quiescenceGate);

    // Mount representative mutating routes
    app.post('/api/test-mutations', (req, res) => {
      res.status(201).json({ success: true, action: 'created', data: req.body });
    });

    app.put('/api/test-mutations/:id', (req, res) => {
      res.status(200).json({ success: true, action: 'updated', id: req.params.id });
    });

    app.delete('/api/test-mutations/:id', (req, res) => {
      res.status(200).json({ success: true, action: 'deleted', id: req.params.id });
    });

    // Mount representative read-only routes
    app.get('/api/test-read', (req, res) => {
      res.status(200).json({ success: true, items: ['alpha', 'beta', 'gamma'] });
    });

    // Mount health and readiness routes
    app.get(
      ['/health', '/ready', '/health/ready', '/api/health', '/api/ready', '/api/health/ready'],
      (req, res) => {
        res.status(200).json({ status: 'ok', uptime: process.uptime() });
      }
    );
  });

  afterAll(async () => {
    process.env = savedEnv;
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    resetInFlightMutations();
    setQuiescenceService(null);
    await BackupLease.deleteMany({});
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    resetInFlightMutations();
    setQuiescenceService(null);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Concurrency Race Tests
  // =========================================================================
  describe('1. Concurrency Race Tests', () => {
    it('10 concurrent requests attempting to acquire the backup lease simultaneously: exactly 1 succeeds (200) and 9 fail with 409 Conflict without state corruption', async () => {
      const concurrencyCount = 10;
      const owners = Array.from({ length: concurrencyCount }, (_, i) => `parallel-worker-${i}`);

      // Dispatch 10 parallel acquire requests simultaneously
      const acquirePromises = owners.map((owner) =>
        request(app)
          .post('/api/admin/quiescence/acquire')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({
            owner,
            leaseDurationMs: 60000,
            maxWatchdogMs: 180000
          })
      );

      const responses = await Promise.all(acquirePromises);

      const successes = responses.filter((res) => res.status === 200 || res.status === 201);
      const conflicts = responses.filter((res) => res.status === 409);

      // Invariant: Exactly 1 winner, exactly 9 conflicts
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(concurrencyCount - 1);

      // Verify winner payload
      const winner = successes[0].body;
      expect(winner.success).toBe(true);
      expect(typeof winner.leaseId).toBe('string');
      expect(winner.leaseId.length).toBeGreaterThan(0);
      expect(winner.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(new Date(winner.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(owners).toContain(winner.owner);

      // Verify all 9 losers received structured 409 Conflict without crashes
      for (const conflictRes of conflicts) {
        expect(conflictRes.body.success).toBe(false);
        expect(conflictRes.body.reason).toBe('CONCURRENT_LEASE_ACTIVE');
        expect(conflictRes.body.currentLease).toBeDefined();
        expect(conflictRes.body.currentLease.leaseId).toBe(winner.leaseId);
      }

      // Verify database state: Exactly one singleton document in backup_leases collection, version incremented once
      const leaseDocs = await BackupLease.find({}).lean();
      expect(leaseDocs).toHaveLength(1);

      const durableDoc = leaseDocs[0];
      expect(durableDoc._id).toBe(BACKUP_LEASE_SINGLETON_ID);
      expect(durableDoc.leaseId).toBe(winner.leaseId);
      expect(durableDoc.owner).toBe(winner.owner);
      expect(durableDoc.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(durableDoc.version).toBe(1);
    });

    it('concurrent heartbeats with the same valid leaseId: both succeed idempotently and extend the lease', async () => {
      // 1. Acquire lease
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'concurrent-hb-worker', leaseDurationMs: 30000, maxWatchdogMs: 180000 });

      expect(acqRes.status).toBe(200);
      const validLeaseId = acqRes.body.leaseId;
      const initialExpiresAt = new Date(acqRes.body.expiresAt).getTime();

      // Small delay to ensure timestamp progression
      await new Promise((r) => setTimeout(r, 20));

      // 2. Dispatch two simultaneous heartbeats for the same valid leaseId
      const [hb1, hb2] = await Promise.all([
        request(app)
          .post('/api/admin/quiescence/heartbeat')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({ leaseId: validLeaseId, heartbeatExtendMs: 45000 }),
        request(app)
          .post('/api/admin/quiescence/heartbeat')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({ leaseId: validLeaseId, heartbeatExtendMs: 45000 })
      ]);

      // Both must succeed idempotently with HTTP 200
      expect(hb1.status).toBe(200);
      expect(hb2.status).toBe(200);
      expect(hb1.body.success).toBe(true);
      expect(hb2.body.success).toBe(true);
      expect(hb1.body.leaseId).toBe(validLeaseId);
      expect(hb2.body.leaseId).toBe(validLeaseId);

      // Verify the lease in DB was extended into the future
      const updatedDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(updatedDoc.leaseId).toBe(validLeaseId);
      expect(new Date(updatedDoc.expiresAt).getTime()).toBeGreaterThan(initialExpiresAt);
    });

    it('heartbeat with invalid or mismatched leaseId: fails with 409 Conflict and preserves active lease', async () => {
      // Acquire active lease
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'authoritative-worker', leaseDurationMs: 60000 });

      expect(acqRes.status).toBe(200);
      const authoritativeLeaseId = acqRes.body.leaseId;

      // Heartbeat with completely mismatched UUID
      const bogusLeaseId = crypto.randomUUID();
      const hbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: bogusLeaseId, heartbeatExtendMs: 30000 });

      expect(hbRes.status).toBe(409);
      expect(hbRes.body.success).toBe(false);
      expect(hbRes.body.reason).toBe('LEASE_NOT_FOUND_OR_MISMATCH');

      // Verify active lease was NOT mutated
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.leaseId).toBe(authoritativeLeaseId);
      expect(doc.owner).toBe('authoritative-worker');
    });
  });

  // =========================================================================
  // 2. Lifecycle & Expiry Tests
  // =========================================================================
  describe('2. Lifecycle & Expiry Tests', () => {
    it('lease expiry: when a lease expires (now > expiresAt), subsequent acquire request succeeds (stale lease recovery)', async () => {
      const now = Date.now();
      const expiredLeaseId = crypto.randomUUID();

      // Seed an expired lease in MongoDB
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: expiredLeaseId,
            owner: 'dead-worker',
            grantedAt: new Date(now - 120000),
            expiresAt: new Date(now - 5000), // expired 5 seconds ago
            lastHeartbeatAt: new Date(now - 60000),
            monotonicWatchdogDeadline: new Date(now + 60000),
            version: 3
          }
        }
      );

      // Verify getStatus reports effective NORMAL
      const statusCheck = await quiescenceService.getStatus();
      expect(statusCheck.isExpired).toBe(true);
      expect(statusCheck.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      // New acquire request arrives
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'fresh-worker', leaseDurationMs: 45000 });

      expect(acqRes.status).toBe(200);
      expect(acqRes.body.success).toBe(true);
      expect(acqRes.body.leaseId).toBeDefined();
      expect(acqRes.body.leaseId).not.toBe(expiredLeaseId);
      expect(acqRes.body.owner).toBe('fresh-worker');

      // Verify DB now holds the fresh lease
      const freshDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(freshDoc.leaseId).toBe(acqRes.body.leaseId);
      expect(freshDoc.owner).toBe('fresh-worker');
      expect(freshDoc.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(freshDoc.version).toBe(4);
    });

    it('heartbeat on expired lease: must fail with 409 Conflict and not extend expiry', async () => {
      const now = Date.now();
      const expiredLeaseId = crypto.randomUUID();
      const pastExpiry = new Date(now - 2000);

      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: expiredLeaseId,
            owner: 'abandoned-worker',
            grantedAt: new Date(now - 60000),
            expiresAt: pastExpiry,
            monotonicWatchdogDeadline: new Date(now + 120000),
            version: 1
          }
        }
      );

      const hbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: expiredLeaseId, heartbeatExtendMs: 30000 });

      expect(hbRes.status).toBe(409);
      expect(hbRes.body.success).toBe(false);
      expect(hbRes.body.reason).toBe('LEASE_EXPIRED');

      // Expiry must remain in the past
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.expiresAt.getTime()).toBe(pastExpiry.getTime());
    });

    it('release with mismatched leaseId: fails with 409 Conflict and leaves active lease untouched', async () => {
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'legit-worker', leaseDurationMs: 60000 });

      const legitLeaseId = acqRes.body.leaseId;

      const releaseRes = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: 'unauthorized-uuid-7777' });

      expect(releaseRes.status).toBe(409);
      expect(releaseRes.body.success).toBe(false);
      expect(releaseRes.body.reason).toBe('LEASE_NOT_FOUND_OR_MISMATCH');

      // Verify active lease still exists in DB
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.leaseId).toBe(legitLeaseId);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
    });

    it('release with valid leaseId: atomically resets state to NORMAL and allows immediate new acquisition', async () => {
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'worker-to-release', leaseDurationMs: 60000 });

      const leaseId = acqRes.body.leaseId;

      // Release with valid leaseId
      const releaseRes = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId });

      expect(releaseRes.status).toBe(200);
      expect(releaseRes.body.success).toBe(true);
      expect(releaseRes.body.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      // Verify DB state is cleanly reset to NORMAL
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(doc.leaseId).toBeNull();
      expect(doc.owner).toBeNull();
      expect(doc.expiresAt).toBeNull();

      // Immediate re-acquisition must succeed without 409 Conflict
      const nextAcqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'immediate-next-worker', leaseDurationMs: 60000 });

      expect(nextAcqRes.status).toBe(200);
      expect(nextAcqRes.body.success).toBe(true);
      expect(nextAcqRes.body.leaseId).toBeDefined();
      expect(nextAcqRes.body.leaseId).not.toBe(leaseId);
    });
  });

  // =========================================================================
  // 3. Application Restart & Durability Tests
  // =========================================================================
  describe('3. Application Restart & Durability Tests', () => {
    it('server restart with active unexpired lease in MongoDB: loads durable state, detects lease, and immediately enforces quiescence gate (rejecting mutating requests with 503)', async () => {
      const activeLeaseId = crypto.randomUUID();
      const futureExpiry = new Date(Date.now() + 120000); // 2 minutes in future
      const futureWatchdog = new Date(Date.now() + 300000);

      // 1. Durably persist an active QUIESCED lease in MongoDB (as if another server or previous process set it)
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: activeLeaseId,
            owner: 'pre-restart-backup-agent',
            grantedAt: new Date(),
            expiresAt: futureExpiry,
            monotonicWatchdogDeadline: futureWatchdog,
            lastHeartbeatAt: new Date(),
            version: 2
          }
        }
      );

      // 2. Simulate complete application restart:
      // Clear in-memory gate tracking and call quiescenceService.initialize() as server boots
      resetInFlightMutations();
      const initResult = await quiescenceService.initialize();

      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(false);
      expect(initResult.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
      expect(initResult.activeLeaseId).toBe(activeLeaseId);

      // 3. Verify quiescenceGate immediately enforces write rejection across mutating endpoints
      const mutatingPost = await request(app)
        .post('/api/test-mutations')
        .send({ title: 'Should be rejected' });

      expect(mutatingPost.status).toBe(503);
      expect(mutatingPost.headers['retry-after']).toBe('5');
      expect(mutatingPost.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
      expect(mutatingPost.body.error).toContain('maintenance');

      const mutatingDelete = await request(app).delete('/api/test-mutations/12345');
      expect(mutatingDelete.status).toBe(503);
      expect(mutatingDelete.headers['retry-after']).toBe('5');

      // 4. Verify read-only requests are NOT blocked during active quiescence
      const readRes = await request(app).get('/api/test-read');
      expect(readRes.status).toBe(200);
      expect(readRes.body.success).toBe(true);

      // 5. Verify health & readiness checks pass through cleanly
      const healthRes = await request(app).get('/health/ready');
      expect(healthRes.status).toBe(200);

      // 6. Verify admin quiescence management endpoint is accessible to release the lease
      const releaseRes = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: activeLeaseId });

      expect(releaseRes.status).toBe(200);

      // 7. Mutating requests should now succeed immediately after release
      const unblockedPost = await request(app)
        .post('/api/test-mutations')
        .send({ title: 'Should now succeed' });

      expect(unblockedPost.status).toBe(201);
      expect(unblockedPost.body.success).toBe(true);
    });

    it('server restart with expired lease in MongoDB (expiresAt < now): server restart auto-recovers state to NORMAL', async () => {
      const expiredLeaseId = crypto.randomUUID();
      const pastExpiry = new Date(Date.now() - 30000); // Expired 30 seconds ago

      // 1. Durably seed an expired lease in MongoDB
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: expiredLeaseId,
            owner: 'crashed-backup-process',
            grantedAt: new Date(Date.now() - 90000),
            expiresAt: pastExpiry,
            monotonicWatchdogDeadline: new Date(Date.now() + 60000),
            version: 5
          }
        }
      );

      // 2. Simulate server boot: quiescenceService.initialize() runs
      resetInFlightMutations();
      const initResult = await quiescenceService.initialize();

      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(true);
      expect(initResult.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(initResult.previousLeaseId).toBe(expiredLeaseId);

      // 3. Verify durable DB state was atomically updated to NORMAL
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(doc.leaseId).toBeNull();
      expect(doc.owner).toBeNull();
      expect(doc.expiresAt).toBeNull();
      expect(doc.version).toBe(6);

      // 4. Verify quiescenceGate admits mutating requests without 503
      const postRes = await request(app)
        .post('/api/test-mutations')
        .send({ title: 'Admitted on recovered normal status' });

      expect(postRes.status).toBe(201);
      expect(postRes.body.success).toBe(true);
    });
  });

  // =========================================================================
  // 4. Monotonic Watchdog Ceiling Tests
  // =========================================================================
  describe('4. Monotonic Watchdog Ceiling Tests', () => {
    it('continuous heartbeats cannot extend the lease beyond the absolute server-side ceiling (monotonicWatchdogDeadline)', async () => {
      const initialLeaseMs = 15000;
      const maxWatchdogMs = 45000; // Absolute ceiling: 45s from grantedAt

      // Acquire lease with strict ceiling
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          owner: 'watchdog-tester',
          leaseDurationMs: initialLeaseMs,
          maxWatchdogMs
        });

      expect(acqRes.status).toBe(200);
      const { leaseId, monotonicWatchdogDeadline } = acqRes.body;
      const watchdogDeadlineMs = new Date(monotonicWatchdogDeadline).getTime();

      // Send a heartbeat asking to extend by 120s (well beyond 45s ceiling)
      const hbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          leaseId,
          heartbeatExtendMs: 120000
        });

      expect(hbRes.status).toBe(200);
      expect(hbRes.body.success).toBe(true);

      const currentExpiryMs = new Date(hbRes.body.expiresAt).getTime();
      // Invariant: expiresAt can NEVER exceed monotonicWatchdogDeadline
      expect(currentExpiryMs).toBeLessThanOrEqual(watchdogDeadlineMs);

      // Verify final DB state is hard-capped at monotonicWatchdogDeadline
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.expiresAt.getTime()).toBeLessThanOrEqual(watchdogDeadlineMs);
    });

    it('heartbeat attempt beyond the watchdog ceiling must fail and mark the lease expired/tainted', async () => {
      const now = Date.now();
      const leaseId = crypto.randomUUID();

      // Seed a lease whose monotonicWatchdogDeadline has passed
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId,
            owner: 'long-running-agent',
            grantedAt: new Date(now - 190000),
            expiresAt: new Date(now + 10000), // unexpired lease duration, but watchdog deadline is in the past!
            monotonicWatchdogDeadline: new Date(now - 1000), // Ceiling violated 1 second ago
            version: 1
          }
        }
      );

      // Attempt heartbeat past watchdog deadline
      const hbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId, heartbeatExtendMs: 15000 });

      expect(hbRes.status).toBe(409);
      expect(hbRes.body.success).toBe(false);
      expect(hbRes.body.reason).toBe('WATCHDOG_DEADLINE_EXCEEDED');

      // Verify getStatus reports the lease as expired/tainted
      const statusRes = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.isExpired).toBe(true);
      expect(statusRes.body.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      await quiescenceService.recoverFromDrainFailure({ force: true });
    });
  });

  // =========================================================================
  // 5. Drain Timeout Abort Tests
  // =========================================================================
  describe('5. Drain Timeout Abort Tests', () => {
    it('in-flight mutation hangs or does not finish within drainTimeoutMs: aborts safely, resets lease to NORMAL, and does not leave system stuck in DRAINING', async () => {
      // 1. First, while status is NORMAL, start the in-flight mutating request
      let finishHungMutation;
      const hungPromise = new Promise((resolve) => {
        finishHungMutation = resolve;
      });

      const hungApp = express();
      hungApp.use(quiescenceGate);
      hungApp.post('/api/hung-operation', async (req, res) => {
        await hungPromise;
        res.status(200).json({ completed: true });
      });

      const server = http.createServer(hungApp);
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;

      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/hung-operation',
        method: 'POST'
      });
      clientReq.end();

      // Wait a tick for mutation to enter handler and register in getInFlightMutationCount()
      await new Promise((r) => setTimeout(r, 60));
      expect(getInFlightMutationCount()).toBe(1);

      // 2. NOW acquire lease into DRAINING status while the request is already in-flight
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          owner: 'drain-abort-tester',
          leaseDurationMs: 60000
        });

      expect(acqRes.status).toBe(200);
      const leaseId = acqRes.body.leaseId;
      expect(acqRes.body.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

      // 3. Initiate draining with a short timeout (150ms)
      const drainResult = await quiescenceService.drainInFlight(150, leaseId);

      // Must time out safely
      expect(drainResult.success).toBe(false);
      expect(drainResult.reason).toBe('DRAIN_TIMEOUT');

      // 4. Verify durable lease in MongoDB was safely transitioned fail-closed to RECOVERY_REQUIRED
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.leaseId).toBe(leaseId);
      expect(doc.drainFailureReason).toBe('DRAIN_TIMEOUT');

      // 5. Cleanup hung request and close server
      finishHungMutation();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => server.close(resolve));
      expect(getInFlightMutationCount()).toBe(0);

      // 6. Verify subsequent lease acquisition is REJECTED while in RECOVERY_REQUIRED
      const blockedAcq = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'new-worker-after-abort', leaseDurationMs: 60000 });

      expect(blockedAcq.status).toBe(409);

      // 7. Perform explicit recovery, then subsequent acquisition succeeds
      const recoveryResult = await quiescenceService.recoverFromDrainFailure({ force: true });
      expect(recoveryResult.success).toBe(true);

      const retryAcq = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'new-worker-after-abort', leaseDurationMs: 60000 });

      expect(retryAcq.status).toBe(200);
      expect(retryAcq.body.success).toBe(true);
      expect(retryAcq.body.leaseId).toBeDefined();
    });

    it('in-flight mutation finishes within drainTimeoutMs: successfully transitions lease to QUIESCED', async () => {
      // 1. While status is NORMAL, start in-flight mutation that finishes in 50ms
      let finishQuickMutation;
      const quickPromise = new Promise((resolve) => {
        finishQuickMutation = resolve;
      });

      const quickApp = express();
      quickApp.use(quiescenceGate);
      quickApp.post('/api/quick-operation', async (req, res) => {
        await quickPromise;
        res.status(200).json({ done: true });
      });

      const quickServer = http.createServer(quickApp);
      await new Promise((resolve) => quickServer.listen(0, resolve));
      const quickPort = quickServer.address().port;

      const quickReq = http.request({
        hostname: '127.0.0.1',
        port: quickPort,
        path: '/api/quick-operation',
        method: 'POST'
      });
      quickReq.end();

      await new Promise((r) => setTimeout(r, 60));
      expect(getInFlightMutationCount()).toBe(1);

      // 2. Acquire lease into DRAINING status
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          owner: 'drain-success-tester',
          leaseDurationMs: 60000
        });

      expect(acqRes.status).toBe(200);
      const leaseId = acqRes.body.leaseId;

      // Finish mutation in 50ms
      setTimeout(() => {
        finishQuickMutation();
      }, 50);

      // 3. Initiate draining with generous timeout (2000ms)
      const drainResult = await quiescenceService.drainInFlight(2000, leaseId);
      expect(drainResult.success).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => quickServer.close(resolve));
      expect(getInFlightMutationCount()).toBe(0);

      // 4. Verify lease in MongoDB transitioned to QUIESCED
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
      expect(doc.leaseId).toBe(leaseId);
      expect(doc.owner).toBe('drain-success-tester');
    });
  });
});
