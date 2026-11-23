import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import {
  registerWorkerTask,
  getActiveWorkerTaskCount,
  waitForActiveWorkerTasks,
  shouldPauseWorker,
  isQuiescenceActive,
  resetWorkerTasks,
  closeWorkerAdmission,
  openWorkerAdmission,
  isWorkerAdmissionClosed,
  QuiescenceActiveError
} from '../services/workerCoordinationService.js';
import {
  drainInFlight,
  resetInFlightMutations
} from '../middleware/quiescenceGate.js';

describe('Quiescence Worker Race & Drain Coordination Suite (Workstream 2D.1A)', () => {
  let mongod;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  beforeEach(async () => {
    await BackupLease.deleteMany({});
    await quiescenceService.ensureSingletonExists();
    resetWorkerTasks();
    resetInFlightMutations();
  });

  afterEach(() => {
    resetWorkerTasks();
    resetInFlightMutations();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Test 1: Worker checks NORMAL immediately before quiescence acquisition
  // =========================================================================
  it('1. Worker checks NORMAL immediately before quiescence acquisition: race-free drain or gating', async () => {
    // 1. Initial state is NORMAL
    const initialCheck = await isQuiescenceActive();
    expect(initialCheck).toBe(false);

    // Case A: Worker registers task BEFORE lease is acquired -> drainInFlight must await worker
    let workerFinished = false;
    let workerStarted = false;

    const workerTaskPromise = registerWorkerTask('testWorkerA', async () => {
      workerStarted = true;
      // Simulate asynchronous multi-step work
      await new Promise((r) => setTimeout(r, 60));
      workerFinished = true;
      return { processed: true };
    });

    expect(getActiveWorkerTaskCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(workerStarted).toBe(true);

    // Concurrently, administrator acquires backup lease
    const acquireResult = await quiescenceService.acquire({ owner: 'backup-agent-1' });
    expect(acquireResult.success).toBe(true);
    expect(acquireResult.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

    // Quiescence coordinator runs drainInFlight: must wait for workerTaskPromise
    const drainResult = await drainInFlight(1000);
    expect(drainResult).toBe(true);
    expect(workerFinished).toBe(true);
    expect(getActiveWorkerTaskCount()).toBe(0);

    const workerResult = await workerTaskPromise;
    expect(workerResult).toEqual({ processed: true });

    // Case B: Worker checked NORMAL at t0, but lease transitioned to DRAINING before worker registers
    // System is now DRAINING or QUIESCED
    expect(await isQuiescenceActive()).toBe(true);

    let lateWorkerRan = false;
    const lateWorkerResult = await registerWorkerTask('lateWorker', async () => {
      lateWorkerRan = true;
      return { success: true };
    });

    // Worker was cleanly prevented from running mutations
    expect(lateWorkerRan).toBe(false);
    expect(lateWorkerResult.skipped).toBe(true);
    expect(lateWorkerResult.reason).toBe('BACKUP_QUIESCENCE_ACTIVE');
  });

  // =========================================================================
  // Test 2: Quiescence begins while a worker is starting
  // =========================================================================
  it('2. Quiescence begins while a worker is starting: cleanly rejects or skips execution', async () => {
    // Acquire lease: transitions to DRAINING
    const acquireResult = await quiescenceService.acquire({ owner: 'backup-runner' });
    expect(acquireResult.success).toBe(true);
    expect(acquireResult.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

    let executedDefault = false;
    let executedStrict = false;

    // 1. Default mode: skips cleanly and returns skipped status
    const defaultResult = await registerWorkerTask(
      'sweepFinalizedStagingCleanups',
      async () => {
        executedDefault = true;
        return { completed: 1 };
      }
    );

    expect(executedDefault).toBe(false);
    expect(defaultResult.executed).toBe(false);
    expect(defaultResult.skipped).toBe(true);
    expect(defaultResult.reason).toBe('BACKUP_QUIESCENCE_ACTIVE');

    // 2. Strict mode (rejectOnQuiescence: true): rejects with QuiescenceActiveError
    await expect(
      registerWorkerTask(
        'executeDeletionCleanupJob',
        async () => {
          executedStrict = true;
        },
        { rejectOnQuiescence: true }
      )
    ).rejects.toThrow(QuiescenceActiveError);

    expect(executedStrict).toBe(false);
    expect(getActiveWorkerTaskCount()).toBe(0);
  });

  // =========================================================================
  // Test 3: Worker is already processing a multi-step storage operation
  // =========================================================================
  it('3. Worker is already processing a multi-step storage operation: pauses/breaks on DRAINING cleanly', async () => {
    const processedItems = [];
    const totalItems = [1, 2, 3, 4, 5];

    let workerPaused = false;

    // Start multi-step worker task
    const workerPromise = registerWorkerTask('multiStepStorageWorker', async (context) => {
      for (const item of totalItems) {
        // Inter-item pause check
        if (await context.shouldPause()) {
          workerPaused = true;
          break;
        }

        // Simulate item processing
        processedItems.push(item);
        await new Promise((r) => setTimeout(r, 20));
      }

      return { processedCount: processedItems.length, paused: workerPaused };
    });

    // Allow worker to process items 1 and 2
    await new Promise((r) => setTimeout(r, 60));
    expect(processedItems.length).toBeGreaterThanOrEqual(1);

    // Quiescence begins: acquire lease (transitions to DRAINING)
    const lease = await quiescenceService.acquire({ owner: 'backup-coord' });
    expect(lease.success).toBe(true);

    // Draining commences
    const drained = await drainInFlight(2000);
    expect(drained).toBe(true);

    const workerResult = await workerPromise;
    expect(workerResult.paused).toBe(true);
    expect(workerResult.processedCount).toBeLessThan(totalItems.length);
    expect(getActiveWorkerTaskCount()).toBe(0);
  });

  // =========================================================================
  // Test 4: Worker attempts to schedule another operation during DRAINING
  // =========================================================================
  it('4. Worker attempts to schedule another operation during DRAINING: rejected with BACKUP_QUIESCENCE_ACTIVE', async () => {
    // Acquire lease -> status is DRAINING
    const lease = await quiescenceService.acquire({ owner: 'backup-coord' });
    expect(lease.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

    let scheduled = false;

    // Attempt to register during DRAINING with strict rejection
    try {
      await registerWorkerTask(
        'scheduledSweepJob',
        async () => {
          scheduled = true;
        },
        { rejectOnQuiescence: true }
      );
      expect.fail('Should have thrown QuiescenceActiveError');
    } catch (err) {
      expect(err).toBeInstanceOf(QuiescenceActiveError);
      expect(err.code).toBe('BACKUP_QUIESCENCE_ACTIVE');
    }

    expect(scheduled).toBe(false);
    expect(getActiveWorkerTaskCount()).toBe(0);
  });

  // =========================================================================
  // Test 5: Application restarts during worker coordination
  // =========================================================================
  it('5. Application restarts during worker coordination: restores durable state and prevents worker starvation', async () => {
    // 1. Acquire lease in DB with 60s validity
    const lease = await quiescenceService.acquire({
      owner: 'backup-runner',
      leaseDurationMs: 60000,
      initialStatus: BACKUP_LEASE_STATUS.QUIESCED
    });
    expect(lease.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

    // 2. Simulate node process restart: clear in-memory state
    resetWorkerTasks();
    resetInFlightMutations();
    expect(getActiveWorkerTaskCount()).toBe(0);

    // 3. Application startup initialization: quiescenceService.initialize()
    const initResult = await quiescenceService.initialize();
    expect(initResult.success).toBe(true);
    expect(initResult.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
    expect(initResult.activeLeaseId).toBe(lease.leaseId);

    // 4. Background worker attempts to start post-restart: must be gated
    let ranPostRestart = false;
    const postRestartResult = await registerWorkerTask('startupWorker', async () => {
      ranPostRestart = true;
    });

    expect(ranPostRestart).toBe(false);
    expect(postRestartResult.skipped).toBe(true);

    // 5. Simulate stale lease recovery on restart (lease expired in DB before restart)
    await BackupLease.updateOne(
      { _id: BACKUP_LEASE_SINGLETON_ID },
      { $set: { expiresAt: new Date(Date.now() - 5000) } }
    );

    const staleInitResult = await quiescenceService.initialize();
    expect(staleInitResult.success).toBe(true);
    expect(staleInitResult.recovered).toBe(true);
    expect(staleInitResult.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

    // Worker can now run cleanly without starvation
    let ranAfterRecovery = false;
    await registerWorkerTask('recoveredWorker', async () => {
      ranAfterRecovery = true;
    });
    expect(ranAfterRecovery).toBe(true);
  });

  // =========================================================================
  // Test 6: Worker fails while draining
  // =========================================================================
  it('6. Worker fails while draining: safely deregisters from activeWorkerTasks and does not deadlock drain', async () => {
    // Start worker that will throw an asynchronous error
    let thrown = false;

    const failingWorkerPromise = registerWorkerTask('failingWorker', async () => {
      await new Promise((r) => setTimeout(r, 20));
      thrown = true;
      throw new Error('S3 connection reset during upload');
    });

    expect(getActiveWorkerTaskCount()).toBe(1);

    // Draining starts while worker is in flight
    const drainPromise = waitForActiveWorkerTasks(1000);

    // Worker throws, but must be caught
    await expect(failingWorkerPromise).rejects.toThrow('S3 connection reset during upload');
    expect(thrown).toBe(true);

    // Drain must complete successfully without deadlocking
    const drainResult = await drainPromise;
    expect(drainResult).toBe(true);
    expect(getActiveWorkerTaskCount()).toBe(0);
  });

  // =========================================================================
  // Test 7: Lease expires during worker pause
  // =========================================================================
  it('7. Lease expires during worker pause: worker detects expiry and safely resumes', async () => {
    // 1. Acquire lease with short 50ms duration
    const lease = await quiescenceService.acquire({
      owner: 'short-lived-agent',
      leaseDurationMs: 50
    });
    expect(lease.success).toBe(true);
    expect(await isQuiescenceActive()).toBe(true);

    // Worker checks shouldPauseWorker -> true
    expect(await shouldPauseWorker()).toBe(true);

    // 2. Wait for lease to expire
    await new Promise((r) => setTimeout(r, 70));

    // Worker checks shouldPauseWorker -> false (stale lease auto-detected as expired/NORMAL)
    const isPausedAfterExpiry = await shouldPauseWorker();
    expect(isPausedAfterExpiry).toBe(false);

    // Worker can now proceed with task execution
    let executedAfterExpiry = false;
    const result = await registerWorkerTask('resumedWorker', async () => {
      executedAfterExpiry = true;
      return { success: true };
    });

    expect(executedAfterExpiry).toBe(true);
    expect(result).toEqual({ success: true });
    expect(getActiveWorkerTaskCount()).toBe(0);
  });

  // =========================================================================
  // Test 8: Worker resumes after normal release
  // =========================================================================
  it('8. Worker resumes after normal release: transitions to NORMAL and resumes full operation', async () => {
    // 1. Acquire lease: DRAINING/QUIESCED
    const lease = await quiescenceService.acquire({ owner: 'admin-backup' });
    expect(lease.success).toBe(true);

    // Verify worker is gated during active lease
    let blockedRun = false;
    const blockedResult = await registerWorkerTask('gatedWorker', async () => {
      blockedRun = true;
    });
    expect(blockedRun).toBe(false);
    expect(blockedResult.skipped).toBe(true);

    // 2. Administrator completes backup and releases lease
    const releaseResult = await quiescenceService.release({ leaseId: lease.leaseId });
    expect(releaseResult.success).toBe(true);
    expect(releaseResult.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

    // Verify quiescence status is now NORMAL
    expect(await isQuiescenceActive()).toBe(false);
    expect(await shouldPauseWorker()).toBe(false);

    // 3. Worker executes task normally post-release
    let executedPostRelease = false;
    const postReleaseResult = await registerWorkerTask('resumedWorker', async () => {
      executedPostRelease = true;
      return { itemsSwept: 42 };
    });

    expect(executedPostRelease).toBe(true);
    expect(postReleaseResult).toEqual({ itemsSwept: 42 });
    expect(getActiveWorkerTaskCount()).toBe(0);
  });

  // =========================================================================
  // Test 9: TS-WA-01 - 50 concurrent worker registrations during transition to QUIESCED
  // =========================================================================
  it('9. TS-WA-01: 50 concurrent worker registrations during transition to QUIESCED result in exactly 0 mutations past QUIESCED', async () => {
    // 1. Acquire lease
    const lease = await quiescenceService.acquire({ owner: 'backup-agent-stress' });
    expect(lease.success).toBe(true);

    // Drain existing
    await drainInFlight(1000);

    // Transition to QUIESCED
    const quiesced = await quiescenceService.transitionToQuiesced({ leaseId: lease.leaseId });
    expect(quiesced.success).toBe(true);
    expect(quiesced.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

    // Concurrently fire 50 worker registrations
    let executedCount = 0;
    const workerPromises = Array.from({ length: 50 }).map((_, i) =>
      registerWorkerTask(`stress-worker-${i}`, async () => {
        executedCount++;
        return { done: true };
      })
    );

    const results = await Promise.all(workerPromises);

    // Exactly 0 workers must execute mutations
    expect(executedCount).toBe(0);
    expect(results.every((r) => r.skipped === true && r.reason === 'BACKUP_QUIESCENCE_ACTIVE')).toBe(true);
    expect(getActiveWorkerTaskCount()).toBe(0);
  });

  // =========================================================================
  // Test 10: TS-WA-02 - Sub-5ms synchronous rejection once worker admission is closed
  // =========================================================================
  it('10. TS-WA-02: Sub-5ms synchronous rejection once worker admission is closed', async () => {
    closeWorkerAdmission();
    expect(isWorkerAdmissionClosed()).toBe(true);

    const start = performance.now();
    const result = await registerWorkerTask('fastRejectWorker', async () => {
      throw new Error('Should never run');
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(5); // Sub-5ms rejection guarantee
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('BACKUP_QUIESCENCE_ACTIVE');
    expect(getActiveWorkerTaskCount()).toBe(0);

    // Reopen admission
    openWorkerAdmission();
    expect(isWorkerAdmissionClosed()).toBe(false);
  });

  // =========================================================================
  // Test 11: TS-WA-03 - Externally held promise drain blocking
  // =========================================================================
  it('11. TS-WA-03: Externally held promise drain blocking (drainInFlight awaits active worker tasks)', async () => {
    let workerFinished = false;

    // Start a worker with a 150ms delay
    const workerPromise = registerWorkerTask('longWorker', async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      workerFinished = true;
      return { completed: true };
    });

    expect(getActiveWorkerTaskCount()).toBe(1);

    // drainInFlight with 500ms budget must await the worker to completion
    const drainResult = await drainInFlight(500);
    expect(drainResult).toBe(true);
    expect(workerFinished).toBe(true);
    expect(getActiveWorkerTaskCount()).toBe(0);

    const workerRes = await workerPromise;
    expect(workerRes.completed).toBe(true);
  });

  // =========================================================================
  // Test 12: TS-WA-04 - Double-delete race test (no premature drain while onQuiescence executes)
  // =========================================================================
  it('12. TS-WA-04: Double-delete race test (active task record retained until onQuiescence settles)', async () => {
    // Transition to QUIESCED
    const lease = await quiescenceService.acquire({ owner: 'backup-agent' });
    await drainInFlight(1000);
    await quiescenceService.transitionToQuiesced({ leaseId: lease.leaseId });

    let onQuiescenceFinished = false;

    // Register a worker with an asynchronous onQuiescence hook
    const workerPromise = registerWorkerTask(
      'cleanupOnQuiesceWorker',
      async () => ({ mutated: true }),
      {
        onQuiescence: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          onQuiescenceFinished = true;
          return { handledOnQuiesce: true };
        }
      }
    );

    // While onQuiescence is executing, task MUST still be tracked in active tasks
    // to prevent drainInFlight from racing past in-flight quiescence handlers
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getActiveWorkerTaskCount()).toBe(1);

    const res = await workerPromise;
    expect(onQuiescenceFinished).toBe(true);
    expect(res).toEqual({ handledOnQuiesce: true });
    expect(getActiveWorkerTaskCount()).toBe(0);
  });
});
