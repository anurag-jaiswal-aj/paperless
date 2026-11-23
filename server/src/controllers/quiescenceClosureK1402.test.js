/**
 * Dedicated Adversarial Test Suite for Phase 2D.1K.14.0.2
 * Quiescence State-Machine Closure & Invariant Verification
 *
 * Verifies:
 * - Finding F1 / INV-3: Elimination of force-recovery safety bypass
 * - Finding F2 / INV-4: State-aware expiration & fix soft-expiration reopening
 * - Finding F3 / INV-5: Interrupted DRAINING/QUIESCED startup recovery fail-closed
 * - Finding F4 / INV-7: Explicit TTLMonitor suppression via PAPERLESS_DISABLE_TTL_MONITOR=1
 * - Finding F5 / INV-8, INV-9: Single-instance admission safety & fail-closed error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import BackupLease, {
  BACKUP_LEASE_STATUS,
  BACKUP_LEASE_SINGLETON_ID
} from '../models/backupLease.js';
import InstanceLease, {
  INSTANCE_LEASE_SINGLETON_ID,
  INSTANCE_LEASE_STATUS
} from '../models/instanceLease.js';
import quiescenceService, {
  isTtlMonitorDisabledByConfig
} from '../services/quiescenceService.js';
import {
  quiescenceGate,
  getInFlightMutationCount,
  trackMutationOperation,
  resetInFlightMutations,
  closeMutationAdmission,
  openMutationAdmission,
  isMutationAdmissionClosed
} from '../middleware/quiescenceGate.js';
import {
  acquireInstanceLease,
  ensureInstanceSingletonExists
} from '../services/instanceLeaseService.js';
import {
  getReconciliationScheduler,
  SCHEDULER_STATE
} from '../services/reconciliationScheduler.js';

describe('Phase 2D.1K.14.0.2: Quiescence State-Machine Closure & Adversarial Verification', () => {
  let replSet;
  let app;
  const TEST_BACKUP_TOKEN = 'test-token-k1402-closure-32charslong!!';

  beforeEach(async () => {
    process.env.BACKUP_ADMIN_TOKEN = TEST_BACKUP_TOKEN;
    process.env.NODE_ENV = 'test';
    delete process.env.PAPERLESS_DISABLE_TTL_MONITOR;

    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());

    resetInFlightMutations();
    quiescenceService.clearMonotonicWatchdog();

    // Reset collections
    await BackupLease.deleteMany({});
    await BackupLease.create({
      _id: BACKUP_LEASE_SINGLETON_ID,
      status: BACKUP_LEASE_STATUS.NORMAL,
      version: 1
    });

    await InstanceLease.deleteMany({});
    await ensureInstanceSingletonExists();

    await quiescenceService.syncAdmissionState(BACKUP_LEASE_STATUS.NORMAL);

    app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    app.post('/api/test-mutation', (req, res) => {
      res.status(200).json({ success: true, mutated: true });
    });

    app.get('/api/test-read', (req, res) => {
      res.status(200).json({ success: true, read: true });
    });
  });

  afterEach(async () => {
    delete process.env.PAPERLESS_DISABLE_TTL_MONITOR;
    resetInFlightMutations();
    quiescenceService.clearMonotonicWatchdog();
    vi.restoreAllMocks();
    if (mongoose.connection?.readyState === 1) {
      await mongoose.disconnect();
    }
    if (replSet) {
      await replSet.stop();
    }
  });

  // =========================================================================
  // Group 1: Finding F1 & Invariant INV-3 (Elimination of Force-Recovery Bypass)
  // =========================================================================
  describe('Group 1: F1 & INV-3 — Elimination of Force Recovery Bypass', () => {
    it('F1-01: recoverFromDrainFailure({ force: true }) cannot bypass active in-flight mutations', async () => {
      // Put lease into RECOVERY_REQUIRED
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED, drainFailureReason: 'TEST_TIMEOUT' } }
      );
      closeMutationAdmission('RECOVERY_REQUIRED');

      // Inject active in-flight mutation
      let resolveOp;
      const pendingPromise = new Promise((resolve) => { resolveOp = resolve; });
      trackMutationOperation(pendingPromise);

      try {
        expect(getInFlightMutationCount()).toBeGreaterThan(0);

        // Attempt recovery with force: true
        const res = await quiescenceService.recoverFromDrainFailure({ force: true, operator: 'admin' });

        // Assert recovery was rejected
        expect(res.success).toBe(false);
        expect(res.reason).toBe('OPERATIONS_STILL_ACTIVE');

        // Assert persisted lease remains in RECOVERY_REQUIRED
        const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
        expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

        // Assert admission remains closed
        expect(isMutationAdmissionClosed()).toBe(true);

        const httpRes = await request(app).post('/api/test-mutation').send({ data: 1 });
        expect(httpRes.status).toBe(503);
        expect(httpRes.body.code).toBe('RECOVERY_REQUIRED');
      } finally {
        if (resolveOp) resolveOp();
        await new Promise((r) => setImmediate(r));
      }
    });

    it('F1-02: recoverFromDrainFailure({ force: true }) cannot bypass failed durable datastore drain', async () => {
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED, drainFailureReason: 'TEST_TIMEOUT' } }
      );
      closeMutationAdmission('RECOVERY_REQUIRED');

      // Insert uncleaned deleting form in MongoDB to simulate active deletion cascade
      await mongoose.connection.collection('forms').insertOne({
        title: 'Deleting Form Test',
        status: 'deleting'
      });

      try {
        const res = await quiescenceService.recoverFromDrainFailure({ force: true, operator: 'admin' });

        expect(res.success).toBe(false);
        expect(['DATASTORE_NOT_DRAINED', 'DRAIN_PENDING']).toContain(res.reason);

        // Assert persisted state preserved
        const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
        expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
        expect(isMutationAdmissionClosed()).toBe(true);
      } finally {
        await mongoose.connection.collection('forms').deleteMany({});
      }
    });

    it('F1-03: recoverFromDrainFailure({ force: true }) cannot bypass an active reconciliation scheduler', async () => {
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED, drainFailureReason: 'TEST_TIMEOUT' } }
      );
      closeMutationAdmission('RECOVERY_REQUIRED');

      const scheduler = getReconciliationScheduler();
      const origState = scheduler.state;
      const origRunning = scheduler.isRunningBatch;
      scheduler.state = SCHEDULER_STATE.ACTIVE;
      scheduler.isRunningBatch = true;

      try {
        const res = await quiescenceService.recoverFromDrainFailure({ force: true, operator: 'admin' });
        expect(res.success).toBe(false);
        expect(res.reason).toBe('SCHEDULER_STILL_ACTIVE');

        const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
        expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      } finally {
        scheduler.state = origState;
        scheduler.isRunningBatch = origRunning;
      }
    });

    it('F1-04: release({ forceRecovery: true }) routes through strict recovery and cannot bypass active checks', async () => {
      const leaseId = 'test-lease-recovering-123';
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
            leaseId,
            drainFailureReason: 'DRAIN_TIMEOUT'
          }
        }
      );
      closeMutationAdmission('RECOVERY_REQUIRED');

      // Active mutation present
      let resolveOp;
      const pendingPromise = new Promise((resolve) => { resolveOp = resolve; });
      trackMutationOperation(pendingPromise);

      try {
        const releaseRes = await quiescenceService.release({ leaseId, forceRecovery: true });
        expect(releaseRes.success).toBe(false);
        expect(releaseRes.reason).toBe('OPERATIONS_STILL_ACTIVE');

        const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
        expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      } finally {
        if (resolveOp) resolveOp();
        await new Promise((r) => setImmediate(r));
      }
    });

    it('F1-05: recoverFromDrainFailure succeeds and reopens admission ONLY when all safety conditions pass', async () => {
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED, drainFailureReason: 'TEST_FAIL' } }
      );
      closeMutationAdmission('RECOVERY_REQUIRED');

      const scheduler = getReconciliationScheduler();
      scheduler.state = SCHEDULER_STATE.STOPPED;
      scheduler.isRunningBatch = false;

      const res = await quiescenceService.recoverFromDrainFailure({ force: true, operator: 'admin' });
      expect(res.success).toBe(true);
      expect(res.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(isMutationAdmissionClosed()).toBe(false);

      const httpRes = await request(app).post('/api/test-mutation').send({ data: 1 });
      expect(httpRes.status).toBe(200);
      expect(httpRes.body.mutated).toBe(true);
    });
  });

  // =========================================================================
  // Group 2: Finding F2 & Invariant INV-4 (State-Aware Expiration)
  // =========================================================================
  describe('Group 2: F2 & INV-4 — Fix Soft-Expiration Admission Reopening', () => {
    it('F2-01: DRAINING lease with expired expiresAt but unexpired hardDeadline transitions fail-closed to RECOVERY_REQUIRED', async () => {
      const past = new Date(Date.now() - 5000);
      const futureHard = new Date(Date.now() + 60000);
      const leaseId = 'test-soft-draining-lease';

      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.DRAINING,
            leaseId,
            expiresAt: past,
            hardDeadline: futureHard,
            monotonicHardDeadlineMs: Date.now() + 60000,
            bootId: quiescenceService.getSystemBootId(),
            version: 1
          }
        }
      );
      closeMutationAdmission();

      // Check status
      const statusRes = await quiescenceService.getStatus();

      // Assert effective status is RECOVERY_REQUIRED, NOT NORMAL
      expect(statusRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

      // Assert persisted status in MongoDB was transitioned to RECOVERY_REQUIRED
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.drainFailureReason).toBe('HEARTBEAT_EXPIRED_BEFORE_HARD_DEADLINE');

      // Assert admission remains closed
      expect(isMutationAdmissionClosed()).toBe(true);
      const httpRes = await request(app).post('/api/test-mutation').send({});
      expect(httpRes.status).toBe(503);
      expect(httpRes.body.code).toBe('RECOVERY_REQUIRED');
    });

    it('F2-02: QUIESCED lease with expired expiresAt but unexpired hardDeadline transitions fail-closed to RECOVERY_REQUIRED', async () => {
      const past = new Date(Date.now() - 5000);
      const futureHard = new Date(Date.now() + 60000);
      const leaseId = 'test-soft-quiesced-lease';

      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId,
            expiresAt: past,
            hardDeadline: futureHard,
            monotonicHardDeadlineMs: Date.now() + 60000,
            bootId: quiescenceService.getSystemBootId(),
            version: 1
          }
        }
      );
      closeMutationAdmission();

      const statusRes = await quiescenceService.getStatus();
      expect(statusRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.drainFailureReason).toBe('HEARTBEAT_EXPIRED_BEFORE_HARD_DEADLINE');
      expect(isMutationAdmissionClosed()).toBe(true);
    });

    it('F2-03: Hard deadline expiration during DRAINING transitions to RECOVERY_REQUIRED with WATCHDOG_EXPIRED', async () => {
      const pastHard = new Date(Date.now() - 5000);
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.DRAINING,
            leaseId: 'hard-expire-draining',
            expiresAt: pastHard,
            hardDeadline: pastHard,
            version: 1
          }
        }
      );

      const statusRes = await quiescenceService.getStatus();
      expect(statusRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.drainFailureReason).toBe('WATCHDOG_EXPIRED');
    });

    it('F2-04: Repeated getStatus() calls are idempotent and do not oscillate', async () => {
      const past = new Date(Date.now() - 2000);
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.DRAINING,
            leaseId: 'idempotent-lease',
            expiresAt: past,
            hardDeadline: new Date(Date.now() + 30000),
            version: 1
          }
        }
      );

      const res1 = await quiescenceService.getStatus();
      const res2 = await quiescenceService.getStatus();
      const res3 = await quiescenceService.getStatus();

      expect(res1.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(res2.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(res3.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(isMutationAdmissionClosed()).toBe(true);
    });

    it('F2-05: Normal lease expiration while already in NORMAL status stays NORMAL', async () => {
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.NORMAL,
            leaseId: null,
            expiresAt: null
          }
        }
      );
      openMutationAdmission();

      const statusRes = await quiescenceService.getStatus();
      expect(statusRes.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(isMutationAdmissionClosed()).toBe(false);
    });
  });

  // =========================================================================
  // Group 3: Finding F3 & Invariant INV-5 (Interrupted DRAINING Startup Recovery)
  // =========================================================================
  describe('Group 3: F3 & INV-5 — Interrupted DRAINING Startup Recovery', () => {
    it('F3-01: Startup with persisted DRAINING transitions to RECOVERY_REQUIRED, NOT NORMAL', async () => {
      const leaseId = 'interrupted-draining-lease';
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.DRAINING,
            leaseId,
            owner: 'runner-node-1',
            bootId: 'old-boot-id-abc',
            drainStartedAt: new Date(Date.now() - 10000),
            version: 1
          }
        }
      );

      const initRes = await quiescenceService.initialize();
      expect(initRes.success).toBe(true);
      expect(initRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(initRes.recovered).toBe(false);

      // Verify persisted state
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.lastKnownHealthyState).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(doc.drainFailureReason).toBe('INTERRUPTED_BY_REBOOT');
      expect(doc.drainDiagnostics).toBeDefined();
      expect(doc.drainDiagnostics.interruptedLeaseId).toBe(leaseId);

      // Verify admission is closed
      expect(isMutationAdmissionClosed()).toBe(true);
      const httpRes = await request(app).post('/api/test-mutation').send({});
      expect(httpRes.status).toBe(503);
      expect(httpRes.body.code).toBe('RECOVERY_REQUIRED');
    });

    it('F3-02: Startup with persisted QUIESCED transitions to RECOVERY_REQUIRED', async () => {
      const leaseId = 'interrupted-quiesced-lease';
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId,
            owner: 'backup-runner',
            bootId: 'reboot-boot-xyz',
            version: 1
          }
        }
      );

      const initRes = await quiescenceService.initialize();
      expect(initRes.success).toBe(true);
      expect(initRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.drainDiagnostics.interruptedStatus).toBe(BACKUP_LEASE_STATUS.QUIESCED);
      expect(isMutationAdmissionClosed()).toBe(true);
    });

    it('F3-03: Startup with persisted RECOVERY_REQUIRED preserves RECOVERY_REQUIRED', async () => {
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
            drainFailureReason: 'PREVIOUS_WATCHDOG_FAIL'
          }
        }
      );

      const initRes = await quiescenceService.initialize();
      expect(initRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.drainFailureReason).toBe('PREVIOUS_WATCHDOG_FAIL');
      expect(isMutationAdmissionClosed()).toBe(true);
    });

    it('F3-04: Startup with legitimately persisted NORMAL opens admission and returns NORMAL', async () => {
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.NORMAL,
            leaseId: null
          }
        }
      );

      const initRes = await quiescenceService.initialize();
      expect(initRes.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(isMutationAdmissionClosed()).toBe(false);

      const httpRes = await request(app).post('/api/test-mutation').send({});
      expect(httpRes.status).toBe(200);
    });

    it('F3-05: Database disconnection during initialize() fails closed to RECOVERY_REQUIRED', async () => {
      // Disconnect DB
      await mongoose.disconnect();

      const initRes = await quiescenceService.initialize();
      expect(initRes.success).toBe(false);
      expect(initRes.reason).toBe('DB_DISCONNECTED');
      expect(initRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(isMutationAdmissionClosed()).toBe(true);

      // Reconnect for cleanup
      await mongoose.connect(replSet.getUri());
    });
  });

  // =========================================================================
  // Group 4: Finding F4 & Invariant INV-7 (Explicit TTLMonitor Suppression)
  // =========================================================================
  describe('Group 4: F4 & INV-7 — Explicit TTLMonitor Suppression', () => {
    it('F4-01: isTtlMonitorDisabledByConfig parses environment variables correctly', () => {
      expect(isTtlMonitorDisabledByConfig({ PAPERLESS_DISABLE_TTL_MONITOR: '1' })).toBe(true);
      expect(isTtlMonitorDisabledByConfig({ PAPERLESS_DISABLE_TTL_MONITOR: 'true' })).toBe(true);
      expect(isTtlMonitorDisabledByConfig({ PAPERLESS_DISABLE_TTL_MONITOR: '0' })).toBe(false);
      expect(isTtlMonitorDisabledByConfig({ PAPERLESS_DISABLE_TTL_MONITOR: 'false' })).toBe(false);
      expect(isTtlMonitorDisabledByConfig({})).toBe(false);
    });

    it('F4-02: PAPERLESS_DISABLE_TTL_MONITOR=1 suppresses TTLMonitor restoration on release()', async () => {
      process.env.PAPERLESS_DISABLE_TTL_MONITOR = '1';

      const mockCommand = vi.fn().mockImplementation(async (cmd) => {
        if (cmd?.currentOp) return { inprog: [] };
        return { ok: 1 };
      });
      const adminSpy = vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue({
        command: mockCommand
      });

      try {
        const leaseRes = await quiescenceService.acquire({ leaseDurationMs: 60000 });
        expect(leaseRes.success).toBe(true);

        const releaseRes = await quiescenceService.release({ leaseId: leaseRes.leaseId });
        expect(releaseRes.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

        // Ensure no command({ setParameter: 1, ttlMonitorEnabled: true }) was issued
        const enableCalls = mockCommand.mock.calls.filter(
          (args) => args[0]?.setParameter === 1 && args[0]?.ttlMonitorEnabled === true
        );
        expect(enableCalls.length).toBe(0);
      } finally {
        adminSpy.mockRestore();
      }
    });

    it('F4-03: PAPERLESS_DISABLE_TTL_MONITOR=1 suppresses TTLMonitor restoration on recoverFromDrainFailure()', async () => {
      process.env.PAPERLESS_DISABLE_TTL_MONITOR = '1';

      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED } }
      );

      const mockCommand = vi.fn().mockImplementation(async (cmd) => {
        if (cmd?.currentOp) return { inprog: [] };
        return { ok: 1 };
      });
      const adminSpy = vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue({
        command: mockCommand
      });

      const scheduler = getReconciliationScheduler();
      scheduler.state = SCHEDULER_STATE.STOPPED;
      scheduler.isRunningBatch = false;

      try {
        const recRes = await quiescenceService.recoverFromDrainFailure({ operator: 'admin' });
        expect(recRes.success).toBe(true);

        const enableCalls = mockCommand.mock.calls.filter(
          (args) => args[0]?.setParameter === 1 && args[0]?.ttlMonitorEnabled === true
        );
        expect(enableCalls.length).toBe(0);
      } finally {
        adminSpy.mockRestore();
      }
    });

    it('F4-04: PAPERLESS_DISABLE_TTL_MONITOR=1 enforces disabled TTL state during initialize()', async () => {
      process.env.PAPERLESS_DISABLE_TTL_MONITOR = '1';

      const mockCommand = vi.fn().mockImplementation(async (cmd) => {
        if (cmd?.currentOp) return { inprog: [] };
        return { ok: 1 };
      });
      const adminSpy = vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue({
        command: mockCommand
      });

      try {
        const initRes = await quiescenceService.initialize({ env: process.env });
        expect(initRes.success).toBe(true);

        // Verify that ttlMonitorEnabled: false command was issued
        const disableCalls = mockCommand.mock.calls.filter(
          (args) => args[0]?.setParameter === 1 && args[0]?.ttlMonitorEnabled === false
        );
        expect(disableCalls.length).toBeGreaterThanOrEqual(1);

        // Verify no enable call was issued
        const enableCalls = mockCommand.mock.calls.filter(
          (args) => args[0]?.setParameter === 1 && args[0]?.ttlMonitorEnabled === true
        );
        expect(enableCalls.length).toBe(0);
      } finally {
        adminSpy.mockRestore();
      }
    });

    it('F4-05: MongoDB command failure under PAPERLESS_DISABLE_TTL_MONITOR=1 fails closed', async () => {
      process.env.PAPERLESS_DISABLE_TTL_MONITOR = '1';

      const adminSpy = vi.spyOn(mongoose.connection.db, 'admin').mockReturnValue({
        command: vi.fn().mockRejectedValue(new Error('Unauthorized to setParameter'))
      });

      try {
        const initRes = await quiescenceService.initialize({ env: process.env });
        expect(initRes.success).toBe(false);
        expect(initRes.reason).toBe('TTL_MONITOR_COMMAND_FAILED');
        expect(initRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
        expect(isMutationAdmissionClosed()).toBe(true);
      } finally {
        adminSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // Group 5: Finding F5 & Invariants INV-8, INV-9 (Single-Instance Admission)
  // =========================================================================
  describe('Group 5: F5 & Invariants INV-8, INV-9 — Single-Instance Safety & Fail-Closed Errors', () => {
    it('F5-01: Database error during instance count check fails closed with INSTANCE_CHECK_FAILED (INV-9)', async () => {
      vi.spyOn(InstanceLease, 'countDocuments').mockRejectedValueOnce(
        new Error('MongoDB cluster topology timeout')
      );

      const acquireRes = await quiescenceService.acquire({ leaseDurationMs: 30000 });
      expect(acquireRes.success).toBe(false);
      expect(acquireRes.reason).toBe('INSTANCE_CHECK_FAILED');
      expect(acquireRes.message).toContain('Database error during single-instance verification');

      // Assert lease was not acquired
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(doc.leaseId).toBeNull();
    });

    it('F5-02: Instance registration is rejected with SYSTEM_QUIESCENCE_ACTIVE during DRAINING or QUIESCED', async () => {
      // Put BackupLease into DRAINING
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.DRAINING,
            leaseId: 'active-quiescence-session',
            expiresAt: new Date(Date.now() + 60000)
          }
        }
      );

      // Attempt to register new instance
      const regRes = await acquireInstanceLease({ instanceId: 'inst-secondary-boot' });
      expect(regRes.success).toBe(false);
      expect(regRes.reason).toBe('SYSTEM_QUIESCENCE_ACTIVE');
      expect(regRes.message).toContain('Cannot register application instance while system is actively in quiescence');
    });

    it('F5-03: quiescenceGate rejects mutating requests when durable status is RECOVERY_REQUIRED even if gate was OPEN', async () => {
      // Durable status in Mongo is RECOVERY_REQUIRED
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
            drainFailureReason: 'TEST_RECOVER_REQUIRED'
          }
        }
      );

      // In-memory gate was mistakenly OPEN
      openMutationAdmission();
      expect(isMutationAdmissionClosed()).toBe(false);

      // Mutating request arrives
      const httpRes = await request(app).post('/api/test-mutation').send({ field: 'val' });
      expect(httpRes.status).toBe(503);
      expect(httpRes.body.code).toBe('RECOVERY_REQUIRED');

      // Assert gate was latched closed
      expect(isMutationAdmissionClosed()).toBe(true);
    });

    it('F5-04: Multiple active instances reject quiescence acquisition with MULTIPLE_INSTANCES_ACTIVE', async () => {
      // Create two active instance leases
      await InstanceLease.create({
        _id: 'extra_slot_1',
        instanceId: 'inst-1',
        status: INSTANCE_LEASE_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() + 60000)
      });
      await InstanceLease.create({
        _id: 'extra_slot_2',
        instanceId: 'inst-2',
        status: INSTANCE_LEASE_STATUS.ACTIVE,
        expiresAt: new Date(Date.now() + 60000)
      });

      const acquireRes = await quiescenceService.acquire({ leaseDurationMs: 30000 });
      expect(acquireRes.success).toBe(false);
      expect(acquireRes.reason).toBe('MULTIPLE_INSTANCES_ACTIVE');
    });

    it('F5-05: Legitimate single instance startup succeeds and acquires leader lease', async () => {
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { status: BACKUP_LEASE_STATUS.NORMAL } }
      );

      const regRes = await acquireInstanceLease({ instanceId: 'inst-primary-leader' });
      expect(regRes.success).toBe(true);
      expect(regRes.instanceId).toBe('inst-primary-leader');

      const leaseDoc = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID);
      expect(leaseDoc.status).toBe(INSTANCE_LEASE_STATUS.ACTIVE);
      expect(leaseDoc.instanceId).toBe('inst-primary-leader');
    });
  });
});
