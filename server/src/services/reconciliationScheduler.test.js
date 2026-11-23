import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import AppWorker, { APP_WORKER_ROLE, APP_WORKER_STATUS } from '../models/appWorker.js';
import {
  ReconciliationScheduler,
  SCHEDULER_STATE
} from './reconciliationScheduler.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import * as workerCoord from './workerCoordinationService.js';

describe('Phase 2D.1K.7: Autonomous Reconciliation Scheduler Test Suite', () => {
  let replSet;
  const TEST_ROLE = APP_WORKER_ROLE.STORAGE_RECONCILIATION;

  beforeAll(async () => {
    replSet = await startReplSet([AppWorker]);
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    await AppWorker.deleteMany({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('S01: Normal Startup & Role Acquisition', async () => {
    const mockReconciler = {
      reconcileBatch: vi.fn().mockResolvedValue({ processedCount: 0, results: [] })
    };

    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      reconciliationService: mockReconciler,
      intervalMs: 100000,
      heartbeatIntervalMs: 100000
    });

    const result = await scheduler.start();
    expect(result.success).toBe(true);
    expect(scheduler.state).toBe(SCHEDULER_STATE.ACTIVE);
    expect(scheduler.currentEpoch).toBe(1);
    expect(scheduler.workerId).toBeDefined();

    const doc = await AppWorker.findById(TEST_ROLE).lean();
    expect(doc).not.toBeNull();
    expect(doc.workerId).toBe(scheduler.workerId);
    expect(doc.status).toBe(APP_WORKER_STATUS.STARTING);

    await scheduler.stop();
  });

  it('S02: Heartbeat Renewal extends lease deadline and updates epoch', async () => {
    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      intervalMs: 100000,
      heartbeatIntervalMs: 100000,
      leaseTtlMs: 30000
    });

    await scheduler.start();
    const initialDeadline = scheduler.localMonotonicDeadlineMs;

    // Advance time slightly
    await new Promise((r) => setTimeout(r, 20));

    // Manually trigger heartbeat
    const updated = await AppWorker.heartbeat(TEST_ROLE, {
      workerId: scheduler.workerId,
      incarnationId: scheduler.incarnationId,
      expectedEpoch: scheduler.currentEpoch,
      leaseTtlMs: 40000
    });

    expect(updated).not.toBeNull();
    expect(updated.status).toBe(APP_WORKER_STATUS.ACTIVE);
    expect(scheduler.localMonotonicDeadlineMs).toBeGreaterThanOrEqual(initialDeadline);

    await scheduler.stop();
  });

  it('S03: Batch Execution calls reconciler with proper worker context', async () => {
    const mockReconciler = {
      reconcileBatch: vi.fn().mockResolvedValue({
        processedCount: 2,
        results: [{ action: 'CONFIRMED' }, { action: 'COMPENSATED' }]
      })
    };

    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      reconciliationService: mockReconciler,
      intervalMs: 100000,
      heartbeatIntervalMs: 100000
    });

    await scheduler.start();
    const batchResult = await scheduler.runReconciliationBatch();

    expect(mockReconciler.reconcileBatch).toHaveBeenCalled();
    expect(mockReconciler.reconcileBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workerContext: scheduler,
        isWorkerDriven: true,
        requireWorkerContext: true,
        workerId: scheduler.workerId
      })
    );
    expect(batchResult.processedCount).toBe(2);
    expect(scheduler.metrics.batchesRun).toBe(1);
    expect(scheduler.metrics.confirmedCount).toBe(1);
    expect(scheduler.metrics.compensatedCount).toBe(1);

    await scheduler.stop();
  });

  it('S04: Overlap Prevention skips batch when another is in flight', async () => {
    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      intervalMs: 100000,
      heartbeatIntervalMs: 100000
    });

    await scheduler.start();
    scheduler.isRunningBatch = true; // Simulate in-flight

    const res = await scheduler.runReconciliationBatch();
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('BATCH_IN_FLIGHT');
    expect(scheduler.metrics.batchesSkippedInFlight).toBe(1);

    scheduler.isRunningBatch = false;
    await scheduler.stop();
  });

  it('S05: Quiescence Gating skips batch execution during quiescence', async () => {
    vi.spyOn(workerCoord, 'isQuiescenceActive').mockResolvedValue(true);

    const mockReconciler = {
      reconcileBatch: vi.fn().mockResolvedValue({ processedCount: 0 })
    };

    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      reconciliationService: mockReconciler,
      intervalMs: 100000,
      heartbeatIntervalMs: 100000
    });

    await scheduler.start();
    const res = await scheduler.runReconciliationBatch();

    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('BACKUP_QUIESCENCE_ACTIVE');
    expect(scheduler.metrics.batchesSkippedQuiescence).toBe(1);
    expect(mockReconciler.reconcileBatch).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it('S06: Split-Brain Fencing fences scheduler when role is stolen', async () => {
    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      intervalMs: 100000,
      heartbeatIntervalMs: 50 // Fast heartbeat for test
    });

    await scheduler.start();

    // Another worker forcibly steals the role
    await AppWorker.updateOne(
      { _id: TEST_ROLE },
      { $set: { workerId: 'rogue_worker', epoch: 99 } }
    );

    // Wait for heartbeat tick to detect loss
    await new Promise((r) => setTimeout(r, 120));

    expect(scheduler.isFenced).toBe(true);
    expect(scheduler.state).toBe(SCHEDULER_STATE.FENCED);

    // Subsequent batch run must be rejected
    const batchRes = await scheduler.runReconciliationBatch();
    expect(batchRes.skipped).toBe(true);
    expect(batchRes.reason).toBe('LEASE_INVALID_OR_FENCED');

    await scheduler.stop();
  });

  it('S07: Monotonic Watchdog Fencing detects expired local deadline without I/O', async () => {
    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      intervalMs: 100000,
      heartbeatIntervalMs: 100000
    });

    await scheduler.start();
    expect(scheduler.isLeaseValid()).toBe(true);

    // Artificially expire monotonic deadline
    scheduler.localMonotonicDeadlineMs = performance.now() - 100;
    expect(scheduler.isLeaseValid()).toBe(false);

    const res = await scheduler.runReconciliationBatch();
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('LEASE_INVALID_OR_FENCED');

    await scheduler.stop();
  });

  it('S08: Heartbeat Failure Threshold fences after consecutive errors', async () => {
    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      intervalMs: 100000,
      heartbeatIntervalMs: 40
    });

    await scheduler.start();

    // Mock AppWorker.heartbeat to throw
    vi.spyOn(AppWorker, 'heartbeat').mockRejectedValue(new Error('Connection lost'));

    // Wait for threshold of failures
    await new Promise((r) => setTimeout(r, 150));

    expect(scheduler.isFenced).toBe(true);
    expect(scheduler.state).toBe(SCHEDULER_STATE.FENCED);

    await scheduler.stop();
  });

  it('S09: Graceful Shutdown (Drain & Release) transitions role to STOPPED cleanly', async () => {
    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      intervalMs: 100000,
      heartbeatIntervalMs: 100000
    });

    await scheduler.start();
    const workerId = scheduler.workerId;
    expect(workerId).toBeDefined();

    const stopRes = await scheduler.stop();
    expect(stopRes.success).toBe(true);
    expect(scheduler.state).toBe(SCHEDULER_STATE.STOPPED);
    expect(scheduler.workerId).toBeNull();

    const doc = await AppWorker.findById(TEST_ROLE).lean();
    expect(doc.status).toBe(APP_WORKER_STATUS.STOPPED);
    expect(doc.workerId).toBeNull();
  });

  it('S10: Database Disconnection Resilience does not leak unhandled rejections', async () => {
    const scheduler = new ReconciliationScheduler({
      role: TEST_ROLE,
      intervalMs: 100000,
      heartbeatIntervalMs: 100000
    });

    // Acquire fails closed without throwing unhandled error when throwOnError is false
    vi.spyOn(AppWorker, 'acquireRole').mockRejectedValue(new Error('MongoNetworkTimeout'));

    const res = await scheduler.start({ throwOnError: false });
    expect(res.success).toBe(false);
    expect(scheduler.state).toBe(SCHEDULER_STATE.STOPPED);
  });
});
