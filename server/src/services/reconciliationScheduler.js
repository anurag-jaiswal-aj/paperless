/**
 * ReconciliationScheduler
 *
 * Autonomous background scheduler for durable StorageJournal reconciliation.
 * Coordinates with AppWorker role 'storage_reconciliation', enforces atomic CAS
 * lease ownership, runs non-drifting periodic heartbeats, executes bounded batches,
 * respects backup quiescence, and instantly self-fences upon lease loss.
 *
 * Phase: 2D.1K.7 (Phase K-D)
 */

import os from 'os';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import storageReconciliationService from './storageReconciliationService.js';
import AppWorker, { APP_WORKER_ROLE } from '../models/appWorker.js';
import {
  registerWorkerTask,
  isQuiescenceActive,
  shouldPauseWorker
} from './workerCoordinationService.js';
import { getInstanceId } from './instanceLeaseService.js';

export const RECONCILIATION_ROLE = APP_WORKER_ROLE.STORAGE_RECONCILIATION || 'storage_reconciliation';
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 30000; // 30 seconds
export const DEFAULT_RECONCILIATION_LEASE_TTL_MS = 30000; // 30 seconds
export const DEFAULT_RECONCILIATION_HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds
export const DEFAULT_BATCH_LIMIT = 50;
export const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 2;

export const SCHEDULER_STATE = Object.freeze({
  STOPPED: 'STOPPED',
  ACQUIRING: 'ACQUIRING',
  ACTIVE: 'ACTIVE',
  FENCED: 'FENCED',
  DRAINING: 'DRAINING'
});

export class ReconciliationScheduler {
  constructor(options = {}) {
    this.role = options.role || RECONCILIATION_ROLE;
    this.reconciler = options.reconciliationService || storageReconciliationService;
    this.intervalMs = options.intervalMs || DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.leaseTtlMs = options.leaseTtlMs || DEFAULT_RECONCILIATION_LEASE_TTL_MS;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs || DEFAULT_RECONCILIATION_HEARTBEAT_INTERVAL_MS;
    this.batchLimit = options.batchLimit || DEFAULT_BATCH_LIMIT;
    this.probeDelayMs = options.probeDelayMs;

    this.state = SCHEDULER_STATE.STOPPED;
    this.workerId = null;
    this.incarnationId = crypto.randomUUID();
    this.currentEpoch = 0;
    this.heartbeatTimer = null;
    this.batchTimer = null;
    this.isRunningBatch = false;
    this.activeBatchPromise = null;
    this.startPromise = null;
    this.localMonotonicDeadlineMs = 0;
    this.consecutiveHeartbeatFailures = 0;
    this.isFenced = false;
    this.isLeaseValid = this.isLeaseValid.bind(this);

    // Metrics & Telemetry
    this.metrics = {
      batchesRun: 0,
      batchesSkippedQuiescence: 0,
      batchesSkippedInFlight: 0,
      batchesSkippedFenced: 0,
      recordsProcessed: 0,
      confirmedCount: 0,
      compensatedCount: 0,
      quarantineCount: 0,
      abandonedCount: 0,
      errorCount: 0,
      lastBatchAt: null,
      lastBatchDurationMs: 0,
      startedAt: null
    };
  }

  /**
   * Evaluates whether this worker currently holds a valid, unexpired role lease.
   * Evaluated synchronously using the local monotonic watchdog.
   */
  isLeaseValid() {
    if (this.state !== SCHEDULER_STATE.ACTIVE || this.isFenced) {
      return false;
    }
    if (performance.now() >= this.localMonotonicDeadlineMs) {
      return false;
    }
    return true;
  }

  /**
   * Starts the autonomous scheduler: acquires role ownership, starts heartbeat,
   * and schedules periodic batch sweeps.
   */
  async start(options = {}) {
    if (this.state === SCHEDULER_STATE.ACTIVE) {
      logger.warn('ReconciliationScheduler already active. start() ignored.', {
        event: 'reconciliation.scheduler_already_active',
        workerId: this.workerId
      });
      return { success: true, workerId: this.workerId };
    }

    if (this.state === SCHEDULER_STATE.ACQUIRING && this.startPromise) {
      return await this.startPromise;
    }

    if (options.intervalMs) this.intervalMs = options.intervalMs;
    if (options.leaseTtlMs) this.leaseTtlMs = options.leaseTtlMs;
    if (options.heartbeatIntervalMs) this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    if (options.limit) this.batchLimit = options.limit;

    this.state = SCHEDULER_STATE.ACQUIRING;
    this.isFenced = false;
    this.consecutiveHeartbeatFailures = 0;

    const instanceId = getInstanceId() || `inst_${crypto.randomUUID().slice(0, 8)}`;
    this.workerId = `${instanceId}:reconciler:${crypto.randomUUID().slice(0, 8)}`;

    logger.info('Acquiring StorageJournal reconciliation role lease...', {
      event: 'reconciliation.role_acquiring',
      role: this.role,
      workerId: this.workerId,
      leaseTtlMs: this.leaseTtlMs
    });

    this.startPromise = (async () => {
      try {
        const acquired = await this.acquireLease();
        if (!acquired) {
          this.state = SCHEDULER_STATE.STOPPED;
          const msg = `Unable to acquire worker lease for role "${this.role}" (held by active worker or DB unavailable)`;
          logger.warn(msg, { event: 'reconciliation.role_acquisition_rejected' });
          if (options.throwOnError) {
            throw new Error(msg);
          }
          return { success: false, reason: 'ROLE_HELD_BY_ANOTHER_WORKER' };
        }

        this.state = SCHEDULER_STATE.ACTIVE;
        this.metrics.startedAt = new Date();
        this.localMonotonicDeadlineMs = performance.now() + this.leaseTtlMs;
        if (this.reconciler && typeof this.reconciler === 'object' && this.reconciler.workerId !== this.workerId) {
          this.reconciler.workerId = this.workerId;
        }

        // Start Heartbeat Timer
        this.startHeartbeat();

        // Start Periodic Batch Execution Timer
        this.startBatchTimer();

        logger.info('✅ StorageJournal Reconciliation Scheduler started successfully', {
          event: 'reconciliation.scheduler_started',
          role: this.role,
          workerId: this.workerId,
          intervalMs: this.intervalMs,
          leaseTtlMs: this.leaseTtlMs,
          batchLimit: this.batchLimit
        });

        return { success: true, workerId: this.workerId };
      } finally {
        this.startPromise = null;
      }
    })();

    return await this.startPromise;
  }

  /**
   * Atomic CAS lease acquisition or takeover on app_workers collection.
   */
  async acquireLease() {
    const params = {
      workerId: this.workerId,
      incarnationId: this.incarnationId,
      leaseTtlMs: this.leaseTtlMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      hostname: os.hostname(),
      pid: process.pid,
      metadata: { schedulerStartedAt: new Date() }
    };

    try {
      // Step 1: Attempt clean acquisition from STOPPED state
      let doc = await AppWorker.acquireRole(this.role, params);

      // Step 2: If clean acquisition returned null, attempt takeover of expired role
      if (!doc) {
        doc = await AppWorker.takeOverRole(this.role, params);
      }

      if (doc && doc.workerId === this.workerId) {
        this.currentEpoch = doc.epoch;
        return true;
      }
      return false;
    } catch (err) {
      logger.error('Error during AppWorker role acquisition', err, {
        event: 'reconciliation.acquire_lease_error',
        role: this.role,
        error: err.message
      });
      return false;
    }
  }

  /**
   * Runs the periodic heartbeat loop to renew the lease in MongoDB.
   */
  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(async () => {
      if (this.state !== SCHEDULER_STATE.ACTIVE && this.state !== SCHEDULER_STATE.DRAINING) {
        return;
      }

      try {
        const updated = await AppWorker.heartbeat(this.role, {
          workerId: this.workerId,
          incarnationId: this.incarnationId,
          expectedEpoch: this.currentEpoch,
          leaseTtlMs: this.leaseTtlMs
        });

        if (updated) {
          this.consecutiveHeartbeatFailures = 0;
          this.localMonotonicDeadlineMs = performance.now() + this.leaseTtlMs;
          this.currentEpoch = updated.epoch;
        } else {
          // Lease was stolen, expired, or epoch mismatched! Self-fence immediately
          this.consecutiveHeartbeatFailures++;
          logger.fatal('StorageJournal reconciliation role lease lost or stolen! Self-fencing.', {
            event: 'reconciliation.ownership_lost',
            role: this.role,
            workerId: this.workerId,
            currentEpoch: this.currentEpoch
          });
          this.fenceWorker();
        }
      } catch (err) {
        this.consecutiveHeartbeatFailures++;
        logger.warn('Reconciliation scheduler heartbeat error', {
          event: 'reconciliation.heartbeat_failed',
          failures: this.consecutiveHeartbeatFailures,
          error: err.message
        });

        if (this.consecutiveHeartbeatFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES) {
          logger.error('Max consecutive heartbeat failures reached. Fencing reconciler.', {
            event: 'reconciliation.heartbeat_threshold_exceeded'
          });
          this.fenceWorker();
        }
      }
    }, this.heartbeatIntervalMs);

    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * Immediately fences this worker: stops batch timers and prevents mutations.
   */
  fenceWorker() {
    this.isFenced = true;
    this.state = SCHEDULER_STATE.FENCED;
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Starts the batch execution timer.
   */
  startBatchTimer() {
    if (this.batchTimer) clearInterval(this.batchTimer);

    this.batchTimer = setInterval(async () => {
      await this.runReconciliationBatch();
    }, this.intervalMs);

    if (this.batchTimer.unref) this.batchTimer.unref();
  }

  /**
   * Executes a single bounded reconciliation batch.
   * Enforces zero-I/O monotonic watchdog fencing, non-overlapping guard,
   * quiescence checking, and structured telemetry.
   */
  async runReconciliationBatch() {
    if (!this.isLeaseValid()) {
      this.metrics.batchesSkippedFenced++;
      return { skipped: true, reason: 'LEASE_INVALID_OR_FENCED' };
    }

    if (this.isRunningBatch) {
      this.metrics.batchesSkippedInFlight++;
      logger.debug('Reconciliation batch skipped: previous batch still in flight', {
        event: 'reconciliation.batch_skipped_in_flight'
      });
      return { skipped: true, reason: 'BATCH_IN_FLIGHT' };
    }

    this.isRunningBatch = true;
    const batchStart = Date.now();

    try {
      this.activeBatchPromise = registerWorkerTask(
        'storage_reconciliation',
        async () => {
          if (!this.isLeaseValid()) {
            return { skipped: true, reason: 'LEASE_INVALID_MID_FLIGHT' };
          }

          const quiesced = await isQuiescenceActive();
          if (quiesced) {
            this.metrics.batchesSkippedQuiescence++;
            return { skipped: true, reason: 'BACKUP_QUIESCENCE_ACTIVE' };
          }

          // Execute batch with shouldPause hook checking lease and quiescence,
          // propagating workerContext to enforce lease validation on deletions
          const batchResult = await this.reconciler.reconcileBatch({
            limit: this.batchLimit,
            probeDelayMs: this.probeDelayMs,
            workerId: this.workerId,
            workerContext: this,
            isWorkerDriven: true,
            requireWorkerContext: true,
            shouldPause: async () => {
              if (!this.isLeaseValid()) return true;
              return await shouldPauseWorker();
            }
          });

          return batchResult;
        },
        { rejectOnQuiescence: false }
      );

      const result = await this.activeBatchPromise;
      const durationMs = Date.now() - batchStart;

      this.metrics.batchesRun++;
      this.metrics.lastBatchAt = new Date();
      this.metrics.lastBatchDurationMs = durationMs;

      if (result && !result.skipped) {
        const count = result.processedCount || 0;
        this.metrics.recordsProcessed += count;

        if (Array.isArray(result.results)) {
          for (const item of result.results) {
            if (item.action === 'CONFIRMED') this.metrics.confirmedCount++;
            else if (item.action?.startsWith('COMPENSATED')) this.metrics.compensatedCount++;
            else if (item.action?.startsWith('QUARANTINE')) this.metrics.quarantineCount++;
            else if (item.action?.startsWith('ABANDONED')) this.metrics.abandonedCount++;
            else if (item.action === 'ERROR') this.metrics.errorCount++;
          }
        }

        if (count > 0) {
          logger.info('Reconciliation batch completed', {
            event: 'reconciliation.batch_completed',
            processedCount: count,
            durationMs,
            workerId: this.workerId
          });
        }
      }

      return result;
    } catch (err) {
      this.metrics.errorCount++;
      logger.error('Unexpected error during reconciliation batch', err, {
        event: 'reconciliation.batch_error',
        error: err.message
      });
      return { error: err.message };
    } finally {
      this.isRunningBatch = false;
      this.activeBatchPromise = null;
    }
  }

  /**
   * Graceful shutdown: marks draining, awaits in-flight batch, and releases role lease.
   *
   * @param {object} [options={}]
   * @param {number} [options.timeoutMs=5000]
   */
  async stop(options = {}) {
    if (this.state === SCHEDULER_STATE.STOPPED) {
      return { success: true, alreadyStopped: true };
    }

    const timeoutMs = options.timeoutMs || 5000;
    this.state = SCHEDULER_STATE.DRAINING;

    logger.info('Stopping ReconciliationScheduler...', {
      event: 'reconciliation.scheduler_stopping',
      role: this.role,
      workerId: this.workerId,
      timeoutMs
    });

    // Clear timers immediately to prevent new executions
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Step 1: Mark role as DRAINING in MongoDB
    if (this.workerId) {
      try {
        await AppWorker.markDraining(this.role, {
          workerId: this.workerId,
          incarnationId: this.incarnationId,
          expectedEpoch: this.currentEpoch
        });
      } catch (drainingErr) {
        logger.warn('Failed to mark role DRAINING during shutdown', {
          event: 'reconciliation.mark_draining_warning',
          error: drainingErr.message
        });
      }
    }

    // Step 2: Await in-flight batch completion up to timeoutMs
    let timedOut = false;
    if (this.isRunningBatch && this.activeBatchPromise) {
      try {
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), timeoutMs));
        const result = await Promise.race([
          this.activeBatchPromise.then(() => 'DONE').catch(() => 'DONE'),
          timeoutPromise
        ]);
        if (result === 'TIMEOUT' || this.isRunningBatch) {
          timedOut = true;
        }
      } catch {
        // ignore errors during graceful drain wait
      }
    }

    if (timedOut) {
      logger.warn('ReconciliationScheduler stop timed out waiting for active batch', {
        event: 'reconciliation.stop_timeout',
        role: this.role,
        workerId: this.workerId,
        timeoutMs
      });
      return { success: false, timedOut: true, reason: 'BATCH_DRAIN_TIMEOUT' };
    }

    // Step 3: Release role lease in MongoDB cleanly
    if (this.workerId) {
      try {
        await AppWorker.releaseRole(this.role, {
          workerId: this.workerId,
          incarnationId: this.incarnationId,
          expectedEpoch: this.currentEpoch
        });
        logger.info('✅ Reconciliation role lease released cleanly', {
          event: 'reconciliation.role_released',
          role: this.role,
          workerId: this.workerId
        });
      } catch (releaseErr) {
        logger.warn('Failed to release role lease during shutdown', {
          event: 'reconciliation.release_warning',
          error: releaseErr.message
        });
      }
    }

    this.state = SCHEDULER_STATE.STOPPED;
    this.isFenced = false;
    this.workerId = null;

    return { success: true };
  }
}

const defaultScheduler = new ReconciliationScheduler();
export const getReconciliationScheduler = () => defaultScheduler;
export default defaultScheduler;
