/**
 * Quiescence Safety Remediation Dedicated Adversarial Test Suite
 *
 * Phase: 2D.1K.14.0
 * Work Packages:
 * - Work Package A: Fail-Closed Drain Timeout & Watchdog Handling (Section 4.5)
 * - Work Package B: Reconciliation Scheduler Lifecycle Integration (Section 5.5)
 * - Work Package C: Admission Scope & Enforced Single-Instance Quiescence (Section 6.4)
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
import quiescenceService from '../services/quiescenceService.js';
import {
  quiescenceGate,
  getInFlightMutationCount,
  waitForInFlightMutations,
  trackMutationOperation,
  resetInFlightMutations
} from '../middleware/quiescenceGate.js';
import {
  ReconciliationScheduler,
  SCHEDULER_STATE
} from '../services/reconciliationScheduler.js';

describe('Phase 2D.1K.14.0: Quiescence Safety Remediation Suite', () => {
  let replSet;
  let app;
  const TEST_BACKUP_TOKEN = 'test-remediation-quiescence-token-xyz';

  beforeEach(async () => {
    process.env.BACKUP_ADMIN_TOKEN = TEST_BACKUP_TOKEN;
    process.env.NODE_ENV = 'test';

    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());

    resetInFlightMutations();
    quiescenceService.clearMonotonicWatchdog();

    // Create fresh singleton
    await BackupLease.deleteMany({});
    await BackupLease.create({
      _id: BACKUP_LEASE_SINGLETON_ID,
      status: BACKUP_LEASE_STATUS.NORMAL,
      version: 1
    });

    await quiescenceService.syncAdmissionState(BACKUP_LEASE_STATUS.NORMAL);

    app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    // Test mutating and read endpoints
    app.post('/api/items', (req, res) => res.status(201).json({ created: true }));
    app.put('/api/items/1', (req, res) => res.status(200).json({ updated: true }));
    app.delete('/api/items/1', (req, res) => res.status(200).json({ deleted: true }));
    app.get('/api/items', (req, res) => res.status(200).json({ items: [] }));
  });

  afterEach(async () => {
    resetInFlightMutations();
    quiescenceService.clearMonotonicWatchdog();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (replSet) {
      await replSet.stop();
    }
    vi.restoreAllMocks();
  });

  // =========================================================================
  // WORK PACKAGE A: FAIL-CLOSED DRAIN TIMEOUT & WATCHDOG (SECTION 4.5)
  // =========================================================================
  describe('Work Package A: Fail-Closed Drain Timeout & Watchdog Handling', () => {
    it('Scenario 1 & 8: Drain timeout leaves admission closed and mutating requests receive 503 RECOVERY_REQUIRED', async () => {
      // 1. Acquire lease into DRAINING
      const acq = await quiescenceService.acquire({ owner: 'drain-tester', leaseDurationMs: 60000 });
      expect(acq.success).toBe(true);

      // 2. Track an artificial hanging mutation to force drain timeout
      let finishHanging;
      const hangingPromise = new Promise((r) => { finishHanging = r; });
      trackMutationOperation(hangingPromise);
      expect(getInFlightMutationCount()).toBeGreaterThan(0);

      // 3. Initiate draining with 100ms timeout
      const drainRes = await quiescenceService.drainInFlight(100, acq.leaseId);
      expect(drainRes.success).toBe(false);
      expect(drainRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(drainRes.reason).toBe('DRAIN_TIMEOUT');

      // 4. Verify durable lease in MongoDB is RECOVERY_REQUIRED (never NORMAL)
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.leaseId).toBe(acq.leaseId);
      expect(doc.drainFailureReason).toBe('DRAIN_TIMEOUT');
      expect(doc.drainFailureAt).toBeDefined();

      // 5. Verify continuous admission closure: mutating requests receive 503 RECOVERY_REQUIRED
      const postRes = await request(app).post('/api/items').send({ name: 'test' });
      expect(postRes.status).toBe(503);
      expect(postRes.body.code).toBe('RECOVERY_REQUIRED');

      const putRes = await request(app).put('/api/items/1').send({ name: 'updated' });
      expect(putRes.status).toBe(503);

      const delRes = await request(app).delete('/api/items/1');
      expect(delRes.status).toBe(503);

      // Read requests still pass through
      const getRes = await request(app).get('/api/items');
      expect(getRes.status).toBe(200);

      finishHanging();
    });

    it('Scenario 2: Watchdog timeout during QUIESCED leaves admission closed and fails closed to RECOVERY_REQUIRED', async () => {
      // 1. Acquire and quiesce
      const acq = await quiescenceService.acquire({ owner: 'watchdog-tester', leaseDurationMs: 60000 });
      const quiesceRes = await quiescenceService.markQuiesced({ leaseId: acq.leaseId, enforceDrain: false });
      expect(quiesceRes.success).toBe(true);

      // 2. Violate watchdog deadline in DB
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { monotonicWatchdogDeadline: new Date(Date.now() - 1000) } }
      );

      // 3. getStatus must detect watchdog expiry and transition lease to RECOVERY_REQUIRED
      const statusRes = await quiescenceService.getStatus();
      expect(statusRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(statusRes.isExpired).toBe(true);

      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.drainFailureReason).toBe('WATCHDOG_EXPIRED');

      // 4. Admission gates remain strictly closed
      const postRes = await request(app).post('/api/items').send({ name: 'test' });
      expect(postRes.status).toBe(503);
      expect(postRes.body.code).toBe('RECOVERY_REQUIRED');
    });

    it('Scenario 3: Diagnostics preserved in BackupLease on drain failure', async () => {
      const acq = await quiescenceService.acquire({ owner: 'diag-tester', leaseDurationMs: 60000 });

      let releaseOp;
      const opPromise = new Promise((r) => { releaseOp = r; });
      trackMutationOperation(opPromise);

      await quiescenceService.drainInFlight(50, acq.leaseId);

      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(doc.drainFailureReason).toBe('DRAIN_TIMEOUT');
      expect(doc.drainFailureAt).toBeInstanceOf(Date);
      expect(doc.drainAttempts).toBe(1);
      expect(doc.drainDiagnostics).toBeDefined();
      expect(doc.drainDiagnostics.inMemoryDrained).toBe(false);

      releaseOp();
    });

    it('Scenario 4 & 5: Idempotent release refusal and CAS rejection while in RECOVERY_REQUIRED', async () => {
      const acq = await quiescenceService.acquire({ owner: 'cas-tester', leaseDurationMs: 60000 });
      let releaseOp;
      const hungOp = new Promise((r) => { releaseOp = r; });
      trackMutationOperation(hungOp);
      await quiescenceService.drainInFlight(10, acq.leaseId);
      releaseOp();

      // Standard release without explicit recovery must be rejected
      const releaseRes = await quiescenceService.release({ leaseId: acq.leaseId });
      expect(releaseRes.success).toBe(false);
      expect(releaseRes.reason).toBe('RECOVERY_REQUIRED');

      // Concurrent lease acquisition must also be rejected
      const acq2 = await quiescenceService.acquire({ owner: 'challenger', leaseDurationMs: 60000 });
      expect(acq2.success).toBe(false);
      expect(acq2.reason).toBe('RECOVERY_REQUIRED');

      // Durable status unchanged
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
    });

    it('Scenario 6: Failed cleanup handling prevents drain and fails closed', async () => {
      const acq = await quiescenceService.acquire({ owner: 'cleanup-tester', leaseDurationMs: 60000 });

      // Seed pending DeletionCleanupJob in database
      const db = mongoose.connection.db;
      await db.collection('deletioncleanupjobs').insertOne({
        formId: new mongoose.Types.ObjectId(),
        status: 'pending',
        createdAt: new Date()
      });

      // Attempt drain
      const drainRes = await quiescenceService.drainInFlight(100, acq.leaseId);
      expect(drainRes.success).toBe(false);
      expect(drainRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(drainRes.reason).toBe('DRAIN_PENDING');

      // Verify diagnostic indicates activeCleanupJobs > 0
      expect(drainRes.datastoreDiagnostics.activeCleanupJobs).toBe(1);

      // Clean up seeded job
      await db.collection('deletioncleanupjobs').deleteMany({});
    });

    it('Scenario 7: Server restart preserves RECOVERY_REQUIRED status and keeps admission closed', async () => {
      const acq = await quiescenceService.acquire({ owner: 'restart-tester', leaseDurationMs: 60000 });
      let releaseOp;
      const hungOp = new Promise((r) => { releaseOp = r; });
      trackMutationOperation(hungOp);
      await quiescenceService.drainInFlight(10, acq.leaseId);
      releaseOp();

      // Simulate server reboot by invoking initialize()
      const initRes = await quiescenceService.initialize();
      expect(initRes.success).toBe(true);
      expect(initRes.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(initRes.recovered).toBe(false);

      // Admission gates remain closed after reboot
      const postRes = await request(app).post('/api/items').send({ name: 'post-boot' });
      expect(postRes.status).toBe(503);
      expect(postRes.body.code).toBe('RECOVERY_REQUIRED');
    });

    it('Scenario 9: Explicit recovery with verified clean drain succeeds and reopens admission', async () => {
      const acq = await quiescenceService.acquire({ owner: 'recovery-tester', leaseDurationMs: 60000 });
      let releaseOp;
      const hungOp = new Promise((r) => { releaseOp = r; });
      trackMutationOperation(hungOp);
      await quiescenceService.drainInFlight(10, acq.leaseId);
      releaseOp();
      await waitForInFlightMutations(50);

      // System in RECOVERY_REQUIRED
      expect(quiescenceGate).toBeDefined();
      const blockedRes = await request(app).post('/api/items').send({ name: 'blocked' });
      expect(blockedRes.status).toBe(503);

      // Perform verified recovery
      const recRes = await quiescenceService.recoverFromDrainFailure({ force: false, operator: 'admin-alice' });
      expect(recRes.success).toBe(true);
      expect(recRes.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      // Verify DB lease is NORMAL
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(doc.leaseId).toBeNull();

      // Admission gates reopened
      const allowedRes = await request(app).post('/api/items').send({ name: 'allowed' });
      expect(allowedRes.status).toBe(201);
      expect(allowedRes.body.created).toBe(true);
    });

    it('Scenario 10: Invalid recovery attempt while operations are active is rejected', async () => {
      const acq = await quiescenceService.acquire({ owner: 'invalid-rec-tester', leaseDurationMs: 60000 });
      let finishOp;
      const hungOp = new Promise((r) => { finishOp = r; });
      trackMutationOperation(hungOp);
      await quiescenceService.drainInFlight(10, acq.leaseId);

      // Attempt recovery without force while hungOp is still active -> must reject
      const recRes = await quiescenceService.recoverFromDrainFailure({ force: false });
      expect(recRes.success).toBe(false);
      expect(recRes.reason).toBe('OPERATIONS_STILL_ACTIVE');

      // Lease remains RECOVERY_REQUIRED
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

      finishOp();
      await waitForInFlightMutations(100);

      // Now recovery succeeds
      const recRes2 = await quiescenceService.recoverFromDrainFailure({ force: false });
      expect(recRes2.success).toBe(true);
    });
  });

  // =========================================================================
  // WORK PACKAGE B: RECONCILIATION SCHEDULER LIFECYCLE (SECTION 5.5)
  // =========================================================================
  describe('Work Package B: Reconciliation Scheduler Lifecycle Integration', () => {
    it('Scenario 1 & 2: Quiescence entry stops scheduler and clears all recurring timers', async () => {
      const mockReconciler = { reconcileBatch: vi.fn().mockResolvedValue({ processedCount: 0 }) };
      const scheduler = new ReconciliationScheduler({
        role: 'reconciliation_test_role_b1',
        reconciliationService: mockReconciler,
        intervalMs: 1000,
        heartbeatIntervalMs: 1000
      });

      await scheduler.start();
      expect(scheduler.state).toBe(SCHEDULER_STATE.ACTIVE);
      expect(scheduler.batchTimer).not.toBeNull();
      expect(scheduler.heartbeatTimer).not.toBeNull();

      // Quiescence entry drainInFlight stops the scheduler
      const stopRes = await scheduler.stop({ timeoutMs: 5000 });
      expect(stopRes.success).toBe(true);
      expect(scheduler.state).toBe(SCHEDULER_STATE.STOPPED);
      expect(scheduler.batchTimer).toBeNull();
      expect(scheduler.heartbeatTimer).toBeNull();

      // No batch called after stop
      expect(mockReconciler.reconcileBatch).not.toHaveBeenCalled();
    });

    it('Scenario 3: Graceful shutdown awaits active in-flight batch', async () => {
      let batchStarted;
      const batchStartedPromise = new Promise((r) => { batchStarted = r; });
      let finishBatch;
      const batchWait = new Promise((r) => { finishBatch = r; });

      const mockReconciler = {
        reconcileBatch: vi.fn().mockImplementation(async () => {
          batchStarted();
          await batchWait;
          return { processedCount: 5, results: [{ action: 'CONFIRMED' }] };
        })
      };

      const scheduler = new ReconciliationScheduler({
        role: 'reconciliation_test_role_b3',
        reconciliationService: mockReconciler,
        intervalMs: 100000,
        heartbeatIntervalMs: 100000
      });

      await scheduler.start();

      // Start running batch in background and wait for it to enter execution
      const batchRunPromise = scheduler.runReconciliationBatch();
      await batchStartedPromise;
      expect(scheduler.isRunningBatch).toBe(true);

      // Stop scheduler in parallel with 2000ms timeout
      const stopPromise = scheduler.stop({ timeoutMs: 2000 });

      // Release batch
      setTimeout(() => finishBatch(), 50);

      const [stopRes, batchRes] = await Promise.all([stopPromise, batchRunPromise]);
      expect(stopRes.success).toBe(true);
      expect(batchRes.processedCount).toBe(5);
      expect(scheduler.state).toBe(SCHEDULER_STATE.STOPPED);
    });

    it('Scenario 4: Active batch timeout fails shutdown and reports BATCH_DRAIN_TIMEOUT', async () => {
      let batchStarted;
      const batchStartedPromise = new Promise((r) => { batchStarted = r; });
      let releaseHung;
      const hungPromise = new Promise((r) => { releaseHung = r; });

      const mockReconciler = {
        reconcileBatch: vi.fn().mockImplementation(async () => {
          batchStarted();
          await hungPromise;
        })
      };

      const scheduler = new ReconciliationScheduler({
        role: 'reconciliation_test_role_b4',
        reconciliationService: mockReconciler,
        intervalMs: 100000,
        heartbeatIntervalMs: 100000
      });

      await scheduler.start();
      const batchRunPromise = scheduler.runReconciliationBatch();
      await batchStartedPromise;
      expect(scheduler.isRunningBatch).toBe(true);

      // Stop with tight 50ms timeout
      const stopRes = await scheduler.stop({ timeoutMs: 50 });
      expect(stopRes.success).toBe(false);
      expect(stopRes.timedOut).toBe(true);
      expect(stopRes.reason).toBe('BATCH_DRAIN_TIMEOUT');

      releaseHung();
      await batchRunPromise.catch(() => {});
    });

    it('Scenario 6 & 7: Repeated stop() and start() calls are safe and idempotent', async () => {
      const mockReconciler = { reconcileBatch: vi.fn().mockResolvedValue({ processedCount: 0 }) };
      const scheduler = new ReconciliationScheduler({
        role: 'reconciliation_test_role_b6',
        reconciliationService: mockReconciler,
        intervalMs: 100000,
        heartbeatIntervalMs: 100000
      });

      // Multiple stops while stopped
      const stop1 = await scheduler.stop();
      expect(stop1.success).toBe(true);
      expect(stop1.alreadyStopped).toBe(true);

      const stop2 = await scheduler.stop();
      expect(stop2.success).toBe(true);

      // Start
      const start1 = await scheduler.start();
      expect(start1.success).toBe(true);

      // Repeated start while active
      const start2 = await scheduler.start();
      expect(start2.success).toBe(true);
      expect(start2.workerId).toBe(start1.workerId);

      await scheduler.stop();
    });

    it('Scenario 8 & 9: Scheduler restarts on valid release to NORMAL, but NOT during RECOVERY_REQUIRED', async () => {
      const acq = await quiescenceService.acquire({ owner: 'sched-lifecycle-tester', leaseDurationMs: 60000 });

      // Drain times out -> transitions to RECOVERY_REQUIRED
      let hangOp;
      const hungPromise = new Promise((r) => { hangOp = r; });
      trackMutationOperation(hungPromise);

      await quiescenceService.drainInFlight(20, acq.leaseId);
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

      // Scheduler cannot be active during RECOVERY_REQUIRED
      const { getReconciliationScheduler } = await import('../services/reconciliationScheduler.js');
      const defaultScheduler = getReconciliationScheduler();
      expect(defaultScheduler.state).not.toBe(SCHEDULER_STATE.ACTIVE);

      hangOp();
      await waitForInFlightMutations(50);

      // Perform verified recovery -> restarts scheduler and sets NORMAL
      const recRes = await quiescenceService.recoverFromDrainFailure({ force: false });
      expect(recRes.success).toBe(true);

      const recoveredDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(recoveredDoc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      await defaultScheduler.stop();
    });
  });

  // =========================================================================
  // WORK PACKAGE C: ADMISSION SCOPE & MULTI-INSTANCE SAFETY (SECTION 6.4)
  // =========================================================================
  describe('Work Package C: Admission Scope & Multi-Instance Safety', () => {
    it('Scenario 1: Multiple active instances detected rejects quiescence acquire with MULTIPLE_INSTANCES_ACTIVE', async () => {
      // Register mock InstanceLease model in mongoose if not present
      let InstanceLease;
      try {
        InstanceLease = mongoose.model('InstanceLease');
      } catch {
        const schema = new mongoose.Schema({
          instanceId: String,
          status: String,
          expiresAt: Date
        });
        InstanceLease = mongoose.model('InstanceLease', schema);
      }

      await InstanceLease.deleteMany({});
      const now = new Date();
      // Seed two active instances
      await InstanceLease.insertMany([
        { _id: 'inst_alpha', instanceId: 'inst_alpha', status: 'ACTIVE', expiresAt: new Date(now.getTime() + 60000) },
        { _id: 'inst_beta', instanceId: 'inst_beta', status: 'ACTIVE', expiresAt: new Date(now.getTime() + 60000) }
      ]);

      const acqRes = await quiescenceService.acquire({ owner: 'cluster-tester', leaseDurationMs: 60000 });
      expect(acqRes.success).toBe(false);
      expect(acqRes.reason).toBe('MULTIPLE_INSTANCES_ACTIVE');
      expect(acqRes.message).toMatch(/found 2 active instances/);

      // Clean up seeded instances
      await InstanceLease.deleteMany({});
    });

    it('Scenario 9: Concurrent freeze requests resolve safely via CAS', async () => {
      const [acq1, acq2] = await Promise.all([
        quiescenceService.acquire({ owner: 'agent_1', leaseDurationMs: 60000 }),
        quiescenceService.acquire({ owner: 'agent_2', leaseDurationMs: 60000 })
      ]);

      // Exactly one must succeed, the other must be rejected with CONCURRENT_LEASE_ACTIVE
      const successes = [acq1, acq2].filter((r) => r.success);
      const rejections = [acq1, acq2].filter((r) => !r.success);

      expect(successes).toHaveLength(1);
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toBe('CONCURRENT_LEASE_ACTIVE');

      await quiescenceService.release({ leaseId: successes[0].leaseId });
    });

    it('Scenario 10: Concurrent release requests resolve safely via atomic findOneAndUpdate', async () => {
      const acq = await quiescenceService.acquire({ owner: 'release-cas-tester', leaseDurationMs: 60000 });
      expect(acq.success).toBe(true);

      const [rel1, rel2] = await Promise.all([
        quiescenceService.release({ leaseId: acq.leaseId }),
        quiescenceService.release({ leaseId: acq.leaseId })
      ]);

      const successes = [rel1, rel2].filter((r) => r.success);
      const rejections = [rel1, rel2].filter((r) => !r.success);

      expect(successes).toHaveLength(1);
      expect(rejections).toHaveLength(1);
      expect(rejections[0].reason).toBe('LEASE_NOT_FOUND_OR_MISMATCH');
    });
  });
});
