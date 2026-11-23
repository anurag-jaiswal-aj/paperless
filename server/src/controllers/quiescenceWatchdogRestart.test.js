import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import quiescenceRoutes from '../routes/quiescenceRoutes.js';
import {
  quiescenceGate,
  resetInFlightMutations,
  setQuiescenceService
} from '../middleware/quiescenceGate.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

const TEST_BACKUP_TOKEN = 'test-watchdog-restart-secret-token-abcdef123456';

describe('Phase 4.4 Workstream 2D.1A: Monotonic Watchdog & Restart-Safe Lease Semantics Suite', () => {
  let replSet;
  let app;
  let savedEnv;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.BACKUP_INTERNAL_TOKEN = TEST_BACKUP_TOKEN;
    process.env.INITIAL_LEASE_MS = '60000';
    process.env.BACKUP_LEASE_DURATION_MS = '60000';
    process.env.MAX_WATCHDOG_LEASE_MS = '180000';
    process.env.BACKUP_MAX_WATCHDOG_MS = '180000';
    process.env.HEARTBEAT_EXTEND_MS = '30000';
    process.env.BACKUP_HEARTBEAT_EXTEND_MS = '30000';

    replSet = await startReplSet([BackupLease]);

    app = express();
    app.use(express.json());

    // Mount Quiescence Admin API
    app.use('/api/admin/quiescence', quiescenceRoutes);

    // Mount Quiescence Gate
    app.use(quiescenceGate);

    // Representative mutating test route
    app.post('/api/test-mutations', (req, res) => {
      res.status(201).json({ success: true, action: 'created', data: req.body });
    });

    // Representative read-only test route
    app.get('/api/test-read', (req, res) => {
      res.status(200).json({ success: true, data: 'read-ok' });
    });
  });

  afterAll(async () => {
    process.env = savedEnv;
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    resetInFlightMutations();
    setQuiescenceService(null);
    quiescenceService.clearMonotonicWatchdog();
    await BackupLease.deleteMany({});
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    resetInFlightMutations();
    setQuiescenceService(null);
    quiescenceService.clearMonotonicWatchdog();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Restart Lifecycle Tests (DRAINING, QUIESCED, ACQUIRING, Expiry boundaries)
  // =========================================================================
  describe('1. Restart Lifecycle Tests', () => {
    it('test restart during DRAINING: restores active lease state, clamps monotonic tracking, and enforces quiescence gate', async () => {
      const activeLeaseId = crypto.randomUUID();
      const now = Date.now();
      const expiresAt = new Date(now + 45000); // 45s in future
      const hardDeadline = new Date(now + 120000); // 120s ceiling

      // Seed unexpired DRAINING lease in MongoDB as if set before process crash/restart
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.DRAINING,
            leaseId: activeLeaseId,
            owner: 'pre-restart-agent-draining',
            grantedAt: new Date(now - 15000),
            expiresAt,
            hardDeadline,
            monotonicWatchdogDeadline: hardDeadline,
            lastHeartbeatAt: new Date(now - 5000),
            drainStartedAt: new Date(now - 15000),
            version: 1
          }
        }
      );

      // Simulate server reboot: quiescenceService.initialize() runs
      const initResult = await quiescenceService.initialize();

      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(false);
      expect(initResult.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(initResult.activeLeaseId).toBe(activeLeaseId);
      expect(initResult.hardDeadline).toBeDefined();

      // Verify in-process monotonic watchdog tracking is active and bounded
      const watchdogState = quiescenceService.getMonotonicWatchdogState();
      expect(watchdogState.leaseId).toBe(activeLeaseId);
      expect(watchdogState.monotonicStartMs).toBeTypeOf('number');
      expect(watchdogState.maxAllowedDurationMs).toBeGreaterThan(0);
      expect(watchdogState.maxAllowedDurationMs).toBeLessThanOrEqual(120000);

      // Verify quiescenceGate immediately blocks mutating requests (503)
      const postRes = await request(app)
        .post('/api/test-mutations')
        .send({ payload: 'should-be-rejected-in-draining' });

      expect(postRes.status).toBe(503);
      expect(postRes.body.code).toBe('BACKUP_QUIESCENCE_ACTIVE');

      // Verify markQuiesced can transition the restored lease to QUIESCED
      const quiesceRes = await quiescenceService.markQuiesced({ leaseId: activeLeaseId });
      expect(quiesceRes.success).toBe(true);
      expect(quiesceRes.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

      // Verify release clears the lease and resets to NORMAL
      const releaseRes = await quiescenceService.release({ leaseId: activeLeaseId });
      expect(releaseRes.success).toBe(true);
      expect(releaseRes.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      // Post-release mutating requests succeed
      const allowedPost = await request(app)
        .post('/api/test-mutations')
        .send({ payload: 'allowed-after-release' });
      expect(allowedPost.status).toBe(201);
    });

    it('test restart during QUIESCED: restores active QUIESCED lease and maintains write barrier while allowing reads', async () => {
      const activeLeaseId = crypto.randomUUID();
      const now = Date.now();
      const expiresAt = new Date(now + 60000);
      const hardDeadline = new Date(now + 150000);

      // Seed unexpired QUIESCED lease in MongoDB
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: activeLeaseId,
            owner: 'pre-restart-agent-quiesced',
            grantedAt: new Date(now - 30000),
            expiresAt,
            hardDeadline,
            monotonicWatchdogDeadline: hardDeadline,
            lastHeartbeatAt: new Date(now - 10000),
            version: 2
          }
        }
      );

      // Server reboot
      const initResult = await quiescenceService.initialize();
      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(false);
      expect(initResult.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
      expect(initResult.activeLeaseId).toBe(activeLeaseId);

      // Mutating operations rejected (503)
      const postRes = await request(app)
        .post('/api/test-mutations')
        .send({ title: 'Mutating during QUIESCED after restart' });
      expect(postRes.status).toBe(503);

      // Read-only operations allowed (200)
      const readRes = await request(app).get('/api/test-read');
      expect(readRes.status).toBe(200);
      expect(readRes.body.data).toBe('read-ok');

      // Heartbeat renewal works on restored lease
      const hbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: activeLeaseId, heartbeatExtendMs: 20000 });
      expect(hbRes.status).toBe(200);
      expect(hbRes.body.success).toBe(true);
      expect(hbRes.body.leaseId).toBe(activeLeaseId);
    });

    it('test restart during ACQUIRING: auto-recovers interrupted/stalled acquisition to NORMAL', async () => {
      const stalledLeaseId = crypto.randomUUID();
      const now = Date.now();

      // Seed an interrupted ACQUIRING state where process crashed before acquiring completed
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.ACQUIRING,
            leaseId: stalledLeaseId,
            owner: 'interrupted-process',
            grantedAt: new Date(now),
            expiresAt: new Date(now + 60000),
            hardDeadline: new Date(now + 180000),
            monotonicWatchdogDeadline: new Date(now + 180000),
            version: 1
          }
        }
      );

      // Server reboot
      const initResult = await quiescenceService.initialize();
      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(true);
      expect(initResult.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(initResult.previousStatus).toBe(BACKUP_LEASE_STATUS.ACQUIRING);

      // Verify DB document was atomically reset to NORMAL
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(doc.leaseId).toBeNull();

      // Immediate new acquire succeeds cleanly
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ owner: 'fresh-worker-after-interrupted-acquire' });

      expect(acqRes.status).toBe(200);
      expect(acqRes.body.success).toBe(true);
      expect(acqRes.body.leaseId).not.toBe(stalledLeaseId);
    });

    it('test restart immediately before expiry: restores active lease clamped to remaining milliseconds, then cleanly expires', async () => {
      const leaseId = crypto.randomUUID();
      const now = Date.now();
      // Expiry is 120ms away
      const expiresAt = new Date(now + 120);
      const hardDeadline = new Date(now + 50000);

      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId,
            owner: 'near-expiry-agent',
            grantedAt: new Date(now - 59880),
            expiresAt,
            hardDeadline,
            monotonicWatchdogDeadline: hardDeadline,
            version: 4
          }
        }
      );

      // Server reboot immediately before expiry
      const initResult = await quiescenceService.initialize();
      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(false);
      expect(initResult.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

      // Check status: remaining duration is small positive number <= 120ms
      const initialStatus = await quiescenceService.getStatus();
      expect(initialStatus.isExpired).toBe(false);
      expect(initialStatus.remainingDurationMs).toBeLessThanOrEqual(120);

      // Wait 150ms for expiry to naturally pass
      await new Promise((r) => setTimeout(r, 150));

      // After natural expiry: getStatus reports NORMAL and isExpired: true
      const postExpiryStatus = await quiescenceService.getStatus();
      expect(postExpiryStatus.isExpired).toBe(true);
      expect(postExpiryStatus.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      // Mutating operations are now admitted
      const postRes = await request(app)
        .post('/api/test-mutations')
        .send({ title: 'Admitted after near-expiry passes' });
      expect(postRes.status).toBe(201);
    });

    it('test restart after expiry: auto-recovers stale expired lease to NORMAL and admits mutations', async () => {
      const expiredLeaseId = crypto.randomUUID();
      const now = Date.now();

      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: expiredLeaseId,
            owner: 'crashed-agent',
            grantedAt: new Date(now - 120000),
            expiresAt: new Date(now - 10000), // Expired 10s ago
            hardDeadline: new Date(now + 60000),
            monotonicWatchdogDeadline: new Date(now + 60000),
            version: 7
          }
        }
      );

      // Server reboot
      const initResult = await quiescenceService.initialize();
      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(true);
      expect(initResult.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(initResult.previousLeaseId).toBe(expiredLeaseId);

      // Verify DB document is cleanly NORMAL
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(doc.leaseId).toBeNull();
      expect(doc.expiresAt).toBeNull();

      // Mutations permitted immediately
      const postRes = await request(app)
        .post('/api/test-mutations')
        .send({ title: 'Admitted after expired restart' });
      expect(postRes.status).toBe(201);
    });
  });

  // =========================================================================
  // 2. Clock Jump & Monotonic Watchdog Safety Tests
  // =========================================================================
  describe('2. Clock Jump & Monotonic Watchdog Safety Tests', () => {
    it('test simulated forward wall-clock jump: fails closed, expires lease safely, and recovers to NORMAL', async () => {
      // 1. Acquire valid active lease
      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          owner: 'forward-jump-tester',
          leaseDurationMs: 60000,
          maxWatchdogMs: 180000
        });

      expect(acqRes.status).toBe(200);
      const leaseId = acqRes.body.leaseId;

      // 2. Simulate forward wall-clock jump (e.g. NTP step forward by 10 minutes)
      const realDateNow = Date.now;
      const jumpDeltaMs = 10 * 60 * 1000; // +10 minutes
      try {
        vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + jumpDeltaMs);

        // Heartbeat renewal must fail closed with 409
        const hbRes = await request(app)
          .post('/api/admin/quiescence/heartbeat')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
          .send({ leaseId, heartbeatExtendMs: 30000 });

        expect(hbRes.status).toBe(409);
        expect(hbRes.body.success).toBe(false);
        expect(['LEASE_EXPIRED', 'WATCHDOG_DEADLINE_EXCEEDED']).toContain(hbRes.body.reason);

        // System status reports expired -> effective status NORMAL
        const statusRes = await request(app)
          .get('/api/admin/quiescence/status')
          .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

        expect(statusRes.status).toBe(200);
        expect(statusRes.body.isExpired).toBe(true);
        expect(statusRes.body.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

        // Quiescence gate fails closed to allow normal traffic
        const postRes = await request(app)
          .post('/api/test-mutations')
          .send({ title: 'Traffic admitted after forward clock jump expires lease' });
        expect(postRes.status).toBe(201);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('test simulated backward wall-clock jump: cannot extend lease beyond hardDeadline and monotonic watchdog ceiling', async () => {
      const leaseDurationMs = 30000;
      const maxWatchdogMs = 60000; // 60s hard limit

      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          owner: 'backward-jump-tester',
          leaseDurationMs,
          maxWatchdogMs
        });

      expect(acqRes.status).toBe(200);
      const { leaseId, hardDeadline } = acqRes.body;
      const hardDeadlineMs = new Date(hardDeadline).getTime();

      // 1. Heartbeat renewal sent within active window
      const hbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId, heartbeatExtendMs: 15000 });

      expect(hbRes.status).toBe(200);
      const newExpiryMs = new Date(hbRes.body.expiresAt).getTime();

      // Invariant: New expiry can NEVER exceed hardDeadline!
      expect(newExpiryMs).toBeLessThanOrEqual(hardDeadlineMs);

      // 2. Now simulate monotonic watchdog exhaustion in the running process
      // Even if wall-clock is somehow in the past, in-process monotonic deadline expires!
      const currentWatchdog = quiescenceService.getMonotonicWatchdogState();
      expect(currentWatchdog.leaseId).toBe(leaseId);

      // Fast-forward the in-process monotonic clock past the deadline
      vi.spyOn(performance, 'now').mockImplementation(
        () => currentWatchdog.monotonicDeadlineMs + 100
      );

      expect(quiescenceService.isMonotonicWatchdogExpired(leaseId)).toBe(true);

      // Attempt heartbeat renewal: MUST be rejected with 409 WATCHDOG_DEADLINE_EXCEEDED
      const expiredHbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId, heartbeatExtendMs: 10000 });

      expect(expiredHbRes.status).toBe(409);
      expect(expiredHbRes.body.success).toBe(false);
      expect(expiredHbRes.body.reason).toBe('WATCHDOG_DEADLINE_EXCEEDED');

      // Status query also reflects monotonic expiry
      const statusRes = await quiescenceService.getStatus();
      expect(statusRes.isExpired).toBe(true);
      expect(statusRes.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(statusRes.remainingDurationMs).toBe(0);
    });

    it('test heartbeat extension clamping at hardDeadline: candidate expiry exceeding hardDeadline is capped exactly at hardDeadline', async () => {
      const leaseDurationMs = 20000;
      const maxWatchdogMs = 50000; // 50s ceiling from grantedAt

      const acqRes = await request(app)
        .post('/api/admin/quiescence/acquire')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          owner: 'clamping-tester',
          leaseDurationMs,
          maxWatchdogMs
        });

      expect(acqRes.status).toBe(200);
      const { leaseId, hardDeadline, monotonicWatchdogDeadline } = acqRes.body;
      const hardDeadlineMs = new Date(hardDeadline || monotonicWatchdogDeadline).getTime();

      // Request massive extension (e.g. 500,000ms), far exceeding the 50s hard deadline
      const hbRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({
          leaseId,
          heartbeatExtendMs: 500000
        });

      expect(hbRes.status).toBe(200);
      expect(hbRes.body.success).toBe(true);

      const cappedExpiryMs = new Date(hbRes.body.expiresAt).getTime();
      // Invariant: Must be capped at EXACTLY hardDeadline
      expect(cappedExpiryMs).toBe(hardDeadlineMs);

      // Verify MongoDB document is capped at hardDeadline
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(new Date(doc.expiresAt).getTime()).toBe(hardDeadlineMs);

      // Subsequent heartbeat attempted when at or past hardDeadline must fail with 409
      vi.spyOn(Date, 'now').mockImplementation(() => hardDeadlineMs + 1000);

      const pastCeilingHb = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId, heartbeatExtendMs: 10000 });

      expect(pastCeilingHb.status).toBe(409);
      expect(pastCeilingHb.body.success).toBe(false);
      expect(pastCeilingHb.body.reason).toBe('WATCHDOG_DEADLINE_EXCEEDED');
    });
  });

  // =========================================================================
  // 3. Model & Timing Helper Verification
  // =========================================================================
  describe('3. Model & Timing Helper Verification', () => {
    it('verifies BackupLease schema definitions for hardDeadline and backward-compatibility alias', async () => {
      const lease = new BackupLease({
        status: BACKUP_LEASE_STATUS.QUIESCED,
        leaseId: 'schema-test-uuid',
        hardDeadline: new Date(Date.now() + 60000),
        monotonicWatchdogDeadline: new Date(Date.now() + 60000)
      });

      expect(lease.hardDeadline).toBeInstanceOf(Date);
      expect(lease.monotonicWatchdogDeadline).toBeInstanceOf(Date);
      expect(lease.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
    });

    it('resolveHardDeadline helper picks the earliest ceiling when both hardDeadline and monotonicWatchdogDeadline exist', () => {
      const earlier = new Date(Date.now() + 30000);
      const later = new Date(Date.now() + 90000);

      // Case 1: hardDeadline is earlier
      const doc1 = { hardDeadline: earlier, monotonicWatchdogDeadline: later };
      expect(quiescenceService.resolveHardDeadline(doc1).getTime()).toBe(earlier.getTime());

      // Case 2: monotonicWatchdogDeadline is earlier (e.g. from an older test mutation)
      const doc2 = { hardDeadline: later, monotonicWatchdogDeadline: earlier };
      expect(quiescenceService.resolveHardDeadline(doc2).getTime()).toBe(earlier.getTime());

      // Case 3: Only hardDeadline is set
      const doc3 = { hardDeadline: earlier, monotonicWatchdogDeadline: null };
      expect(quiescenceService.resolveHardDeadline(doc3).getTime()).toBe(earlier.getTime());

      // Case 4: Only monotonicWatchdogDeadline is set
      const doc4 = { hardDeadline: null, monotonicWatchdogDeadline: earlier };
      expect(quiescenceService.resolveHardDeadline(doc4).getTime()).toBe(earlier.getTime());

      // Case 5: Neither is set
      expect(quiescenceService.resolveHardDeadline({})).toBeNull();
      expect(quiescenceService.resolveHardDeadline(null)).toBeNull();
    });

    it('in-process monotonic watchdog functions behave predictably across active lifecycle', () => {
      const testLeaseId = 'monotonic-unit-uuid';
      quiescenceService.setMonotonicWatchdog(testLeaseId, 5000);

      const state = quiescenceService.getMonotonicWatchdogState();
      expect(state.leaseId).toBe(testLeaseId);
      expect(state.maxAllowedDurationMs).toBe(5000);
      expect(quiescenceService.isMonotonicWatchdogExpired(testLeaseId)).toBe(false);
      expect(quiescenceService.getMonotonicRemainingMs(testLeaseId)).toBeGreaterThan(0);
      expect(quiescenceService.getMonotonicRemainingMs(testLeaseId)).toBeLessThanOrEqual(5000);

      // Clearing watchdog resets state
      quiescenceService.clearMonotonicWatchdog();
      const cleared = quiescenceService.getMonotonicWatchdogState();
      expect(cleared.leaseId).toBeNull();
      expect(quiescenceService.isMonotonicWatchdogExpired(testLeaseId)).toBe(false);
      expect(quiescenceService.getMonotonicRemainingMs(testLeaseId)).toBe(Infinity);
    });
  });

  // =========================================================================
  // 4. Phase 4.4 Workstream 2D.1B: Host-Boot Monotonic & Clock Rollback Hardening Suite
  // =========================================================================
  describe('4. Phase 4.4 Workstream 2D.1B: Host-Boot Monotonic & Clock Rollback Hardening Suite', () => {
    afterEach(() => {
      quiescenceService.resetSystemBootIdForTesting();
      quiescenceService.resetHostMonotonicForTesting();
    });

    it('Scenario 1: Backward wall-clock adjustment followed by restart cannot extend lease beyond original real elapsed limit', async () => {
      // 1. Establish initial host boot and monotonic timeline
      const mockBootId = 'boot-uuid-node-alpha';
      quiescenceService.setSystemBootIdForTesting(mockBootId);

      let currentMonoMs = 100000; // 100s since boot
      quiescenceService.setHostMonotonicForTesting(() => currentMonoMs);

      let mockPerfNow = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => mockPerfNow);

      const grantWallTime = 1700000000000;
      let currentWallTime = grantWallTime;
      vi.spyOn(Date, 'now').mockImplementation(() => currentWallTime);

      // Acquire lease with 180s hard ceiling, 60s initial lease
      const acquireRes = await quiescenceService.acquire({
        owner: 'adversarial-clock-agent',
        initialLeaseMs: 60000,
        maxWatchdogMs: 180000
      });

      expect(acquireRes.success).toBe(true);
      expect(acquireRes.bootId).toBe(mockBootId);
      expect(acquireRes.monotonicHardDeadlineMs).toBe(100000 + 180000); // 280,000ms

      // 2. Allow 150 seconds of real physical elapsed time
      currentMonoMs += 150000; // Mono advances by 150s (now 250,000ms)
      mockPerfNow += 150000;
      currentWallTime += 150000; // Wall advances by 150s

      // Monotonic remaining in P1 is 30s
      expect(quiescenceService.getMonotonicRemainingMs(acquireRes.leaseId)).toBeLessThanOrEqual(30000);

      // 3. Move host wall clock backwards by 2 minutes (120 seconds)
      currentWallTime -= 120000; // Wall clock is shifted backwards!

      // 4. Simulate application restart (reset in-process performance.now, clear in-process watchdog, re-run initialize())
      mockPerfNow = 0; // Fresh process begins performance.now() from 0
      quiescenceService.clearMonotonicWatchdog();

      const initResult = await quiescenceService.initialize();
      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(false); // Still unexpired because 30s remain

      // Reconstructed watchdog MUST be clamped by host monotonic remaining (<= 30,000ms), NOT wall remaining (150,000ms)!
      const reconstructedRemaining = quiescenceService.getMonotonicRemainingMs(acquireRes.leaseId);
      expect(reconstructedRemaining).toBeLessThanOrEqual(30000);
      expect(reconstructedRemaining).toBeGreaterThan(0);

      // 5. Advance another 31 seconds of physical time (total physical time = 181s)
      currentMonoMs += 31000;
      mockPerfNow += 31000;
      currentWallTime += 31000;

      // Watchdog must now be strictly EXPIRED!
      expect(quiescenceService.isMonotonicWatchdogExpired(acquireRes.leaseId)).toBe(true);

      const status = await quiescenceService.getStatus();
      expect(status.isExpired).toBe(true);
      expect(status.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      // Mutating requests must now pass through the gate!
      const postExpiryRes = await request(app)
        .post('/api/test-mutations')
        .send({ test: 'allowed-post-watchdog' });
      expect(postExpiryRes.status).toBe(201);
    });

    it('Scenario 2: Host reboot auto-recovers active lease to NORMAL (fail-closed)', async () => {
      // Seed an unexpired lease created under a previous boot ID
      const priorBootId = 'boot-uuid-prior-lifecycle';
      quiescenceService.setSystemBootIdForTesting(priorBootId);

      const activeLeaseId = crypto.randomUUID();
      const now = Date.now();
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: activeLeaseId,
            owner: 'dead-backup-process',
            grantedAt: new Date(now - 10000),
            expiresAt: new Date(now + 50000), // unexpired wall clock
            hardDeadline: new Date(now + 120000),
            bootId: priorBootId,
            monotonicGrantedAtMs: 50000,
            monotonicHardDeadlineMs: 230000
          }
        }
      );

      // Simulate host reboot: new kernel boot ID generated
      const freshBootId = 'boot-uuid-fresh-boot';
      quiescenceService.setSystemBootIdForTesting(freshBootId);

      // Run initialize() on server startup
      const initResult = await quiescenceService.initialize();

      expect(initResult.success).toBe(true);
      expect(initResult.recovered).toBe(true);
      expect(initResult.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      const updatedDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(updatedDoc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(updatedDoc.leaseId).toBeNull();

      // Mutations are admitted immediately
      const writeRes = await request(app)
        .post('/api/test-mutations')
        .send({ state: 'unlocked-post-reboot' });
      expect(writeRes.status).toBe(201);
    });

    it('Scenario 3: Heartbeat rejected if host rebooted, monotonic deadline exhausted, or clock rolled back', async () => {
      const mockBootId = 'boot-uuid-hb-test';
      quiescenceService.setSystemBootIdForTesting(mockBootId);

      let currentMonoMs = 50000;
      quiescenceService.setHostMonotonicForTesting(() => currentMonoMs);

      const grantTime = 1700000000000;
      let currentWallTime = grantTime;
      vi.spyOn(Date, 'now').mockImplementation(() => currentWallTime);

      const acquireRes = await quiescenceService.acquire({
        owner: 'hb-tester',
        initialLeaseMs: 60000,
        maxWatchdogMs: 180000
      });
      expect(acquireRes.success).toBe(true);
      const leaseId = acquireRes.leaseId;

      // Sub-case 3a: Host reboot during heartbeat attempt
      quiescenceService.setSystemBootIdForTesting('boot-uuid-different-after-reboot');
      const rebootHb = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId });

      expect(rebootHb.status).toBe(409);
      expect(rebootHb.body.reason).toBe('HOST_REBOOT_DETECTED');

      // Restore boot ID
      quiescenceService.setSystemBootIdForTesting(mockBootId);

      // Sub-case 3b: Backward clock rollback before grantedAt
      currentWallTime = grantTime - 10000; // 10 seconds before grant!
      const rollbackHb = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId });

      expect(rollbackHb.status).toBe(409);
      expect(rollbackHb.body.reason).toBe('CLOCK_ROLLBACK_DETECTED');

      // Sub-case 3c: Host monotonic hard ceiling reached
      currentWallTime = grantTime + 10000;
      currentMonoMs = 50000 + 180001; // Past monotonic hard deadline!
      const ceilingHb = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId });

      expect(ceilingHb.status).toBe(409);
      expect(ceilingHb.body.reason).toBe('WATCHDOG_DEADLINE_EXCEEDED');
    });

    it('Scenario 4: Release on expired lease resets DB to NORMAL but alerts caller that quiescence was breached', async () => {
      const acquireRes = await quiescenceService.acquire({
        owner: 'slow-backup-runner',
        initialLeaseMs: 30000
      });
      const leaseId = acquireRes.leaseId;

      // Force lease expiration by setting wall time past expiresAt
      const expiresAtMs = new Date(acquireRes.expiresAt).getTime();
      vi.spyOn(Date, 'now').mockImplementation(() => expiresAtMs + 5000);

      // Backup runner finishes slow operation and calls release
      const releaseRes = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId });

      // Must return 409 Conflict with wasExpired: true so runner knows snapshot was compromised
      expect(releaseRes.status).toBe(409);
      expect(releaseRes.body.success).toBe(false);
      expect(releaseRes.body.wasExpired).toBe(true);
      expect(releaseRes.body.reason).toBe('LEASE_EXPIRED');

      // Database is cleanly reset to NORMAL
      const dbDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(dbDoc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(dbDoc.leaseId).toBeNull();
    });

    it('Scenario 5: Rejects NoSQL injection object in leaseId on release and heartbeat', async () => {
      const noSqlLeaseId = { $ne: null };

      // Release attempt with NoSQL object
      const releaseRes = await request(app)
        .post('/api/admin/quiescence/release')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: noSqlLeaseId });

      expect(releaseRes.status).toBe(400);
      expect(releaseRes.body.message).toMatch(/leaseId is required and must be a non-empty string/);

      // Heartbeat attempt with NoSQL object
      const heartbeatRes = await request(app)
        .post('/api/admin/quiescence/heartbeat')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: noSqlLeaseId });

      expect(heartbeatRes.status).toBe(400);
      expect(heartbeatRes.body.message).toMatch(/leaseId is required and must be a non-empty string/);
    });
  });
});
