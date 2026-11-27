/**
 * PrefixSweepService
 *
 * Implements durable, restart-safe prefix sweeps across S3/MinIO namespaces.
 * Discovers and cleans late PUT orphan blobs, abandoned staging files, and
 * uncommitted upload artifacts with 5-tier reference validation and durable checkpoints.
 *
 * Phase: 2D.1K.8 (Phase K-E)
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import s3Provider from './S3StorageProvider.js';
import { assertStorageMutationAllowed } from './StorageService.js';
import { trackStorageOperation } from '../middleware/quiescenceGate.js';
import StorageJournal, { STORAGE_JOURNAL_STATUS } from '../models/storageJournal.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import { APP_WORKER_ROLE } from '../models/appWorker.js';
import { shouldPauseWorker } from './workerCoordinationService.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_PREFIX_SWEEP_CONFIG = Object.freeze({
  ROLE: APP_WORKER_ROLE.PREFIX_SWEEP || 'prefix_sweep',
  DEFAULT_BATCH_SIZE: 500,
  DEFAULT_MIN_ORPHAN_AGE_MS: 60 * 1000, // 60 seconds minimum age barrier (Tier 0)
  DEFAULT_PREFIXES: Object.freeze(['staging/', 'forms/']),
  DEFAULT_CYCLE_INTERVAL_MS: 60 * 1000
});

export class PrefixSweepService {
  constructor(options = {}) {
    this.storageAdapter = options.storageAdapter || s3Provider;
    this.batchSize = options.batchSize || DEFAULT_PREFIX_SWEEP_CONFIG.DEFAULT_BATCH_SIZE;
    this.minOrphanAgeMs =
      typeof options.minOrphanAgeMs === 'number'
        ? options.minOrphanAgeMs
        : DEFAULT_PREFIX_SWEEP_CONFIG.DEFAULT_MIN_ORPHAN_AGE_MS;
    this.prefixes = options.prefixes || [...DEFAULT_PREFIX_SWEEP_CONFIG.DEFAULT_PREFIXES];
    this.workerId = options.workerId || `prefix_sweep_${crypto.randomUUID().slice(0, 8)}`;
    this.cycleIntervalMs =
      options.cycleIntervalMs || DEFAULT_PREFIX_SWEEP_CONFIG.DEFAULT_CYCLE_INTERVAL_MS;

    this.timer = null;
    this.isCycleInProgress = false;
    this.isStopping = false;
  }

  async sleep(ms) {
    if (ms <= 0) return;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Retrieves durable sweep checkpoint for a given S3 prefix from MongoDB.
   *
   * @param {string} prefix
   * @returns {Promise<{ continuationToken?: string, passNumber: number, lastScannedKey?: string }>}
   */
  async getCheckpoint(prefix) {
    if (!mongoose.connection?.db) return { passNumber: 1 };
    const coll = mongoose.connection.db.collection('sweep_checkpoints');
    const doc = await coll.findOne(
      { _id: prefix },
      { readPreference: 'primary' }
    );
    return doc || { passNumber: 1, continuationToken: null, lastScannedKey: null };
  }

  /**
   * Durably saves sweep checkpoint for an S3 prefix in MongoDB.
   *
   * @param {string} prefix
   * @param {object} updates
   */
  async saveCheckpoint(prefix, updates) {
    if (!mongoose.connection?.db) return;
    const coll = mongoose.connection.db.collection('sweep_checkpoints');
    await coll.updateOne(
      { _id: prefix },
      {
        $set: {
          ...updates,
          updatedAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true, writeConcern: { w: 'majority' } }
    );
  }

  /**
   * 5-Tier Candidate Classification Ladder
   * Never deletes an object merely because it is old or absent from one query.
   *
   * @param {string} key - S3 object key
   * @param {object} [metadata] - Object metadata (e.g., LastModified, ContentLength)
   * @returns {Promise<{ isOrphan: boolean, reason: string, details?: any }>}
   */
  async classifyCandidate(key, metadata = {}, options = {}) {
    const now = new Date();

    // Enforce primary read preference and majority read concern on all existence checks
    const readOpts = {
      readPreference: 'primary',
      readConcern: { level: 'majority' }
    };
    if (options.session) {
      readOpts.session = options.session;
    } else if (options.barrierContext?.session) {
      readOpts.session = options.barrierContext.session;
    }

    // Tier 0: Age barrier - Never purge objects younger than minOrphanAgeMs
    if (metadata.lastModified) {
      const ageMs = now.getTime() - new Date(metadata.lastModified).getTime();
      if (ageMs < this.minOrphanAgeMs) {
        return { isOrphan: false, reason: 'TOO_YOUNG_IN_FLIGHT', details: { ageMs } };
      }
    }

    // Tier 1: Check StorageJournal non-terminal state
    const journalOp = await StorageJournal.findOne({
      destinationKey: key,
      status: {
        $in: [
          STORAGE_JOURNAL_STATUS.PENDING,
          STORAGE_JOURNAL_STATUS.CREATED,
          STORAGE_JOURNAL_STATUS.DISPATCHED,
          STORAGE_JOURNAL_STATUS.CONFIRMED,
          STORAGE_JOURNAL_STATUS.RECONCILING,
          STORAGE_JOURNAL_STATUS.COMMITTED
        ]
      }
    }).setOptions(readOpts).lean();

    if (journalOp) {
      if (journalOp.status === STORAGE_JOURNAL_STATUS.COMMITTED) {
        return {
          isOrphan: false,
          reason: 'JOURNAL_COMMITTED',
          details: { operationId: journalOp.operationId }
        };
      }
      return {
        isOrphan: false,
        reason: 'JOURNAL_ACTIVE_IN_FLIGHT',
        details: { operationId: journalOp.operationId, status: journalOp.status }
      };
    }

    // Tier 2: Check committed Response references
    const isCommittedResponse = await Response.exists({
      'answers.value.key': key,
      commitStatus: 'committed'
    }).setOptions(readOpts);
    if (isCommittedResponse) {
      return { isOrphan: false, reason: 'COMMITTED_RESPONSE_REFERENCE' };
    }

    // Tier 3: Check active or quarantined SubmissionReservations globally (both staged and promoted keys)
    const activeOrQuarantinedReservation = await SubmissionReservation.exists({
      $and: [
        { $or: [{ stagedKeys: key }, { promotedKeys: key }] },
        {
          $or: [
            { status: { $in: ['active', 'committing'] }, expiresAt: { $gt: now } },
            { quarantinedUntil: { $gt: now } }
          ]
        }
      ]
    }).setOptions(readOpts);
    if (activeOrQuarantinedReservation) {
      return { isOrphan: false, reason: 'ACTIVE_SUBMISSION_RESERVATION' };
    }

    // Tier 4: Check if key belongs to an active post-cascade deletion cleanup job
    if (mongoose.connection?.db) {
      const cleanupColl = mongoose.connection.db.collection('deletioncleanupjobs');
      const activeCleanup = await cleanupColl.countDocuments(
        { status: { $in: ['cleaning', 'pending'] } },
        readOpts
      );
      if (activeCleanup > 0) {
        // Deletion jobs handle their own batch sweeps; avoid racing
        return { isOrphan: false, reason: 'ACTIVE_DELETION_CLEANUP_IN_PROGRESS' };
      }
    }

    // Candidate has passed all 5 tiers: strictly unreferenced, age > minOrphanAgeMs, no journal/DB reference
    return { isOrphan: true, reason: 'CONFIRMED_UNREFERENCED_ORPHAN' };
  }

  /**
   * Executes a paginated sweep across a single prefix.
   *
   * @param {string} prefix
   * @param {object} [options]
   * @returns {Promise<{ keysScanned: number, orphansPurged: number, isTruncated: boolean }>}
   */
  async sweepPrefix(prefix, options = {}) {
    const checkpoint = await this.getCheckpoint(prefix);
    let continuationToken = checkpoint.continuationToken || undefined;
    let passNumber = checkpoint.passNumber || 1;

    let keysScanned = 0;
    let orphansPurged = 0;

    const listRes = await this.storageAdapter.listObjectsByPrefix(prefix, {
      continuationToken,
      maxKeys: this.batchSize,
      ...options
    });

    const keys = listRes.keys || [];
    keysScanned = keys.length;

    for (const key of keys) {
      if (this.isStopping || (await shouldPauseWorker())) {
        logger.info('prefix_sweep.paused_for_quiescence', { prefix });
        break;
      }

      // Dual-HEAD / metadata probe to check age and avoid racing with active flush
      let metadata = {};
      try {
        const head = await this.storageAdapter.headObject(key, options);
        metadata = {
          lastModified: head?.LastModified || head?.lastModified,
          contentLength: head?.ContentLength || head?.contentLength,
          etag: head?.ETag || head?.etag
        };
      } catch (err) {
        if (err.name === 'NotFound' || err.statusCode === 404) {
          continue; // Object vanished
        }
      }

      const classification = await this.classifyCandidate(key, metadata, options);
      if (classification.isOrphan) {
        if (this.isStopping || (await shouldPauseWorker())) {
          break;
        }
        try {
          await assertStorageMutationAllowed(options);
          await trackStorageOperation(async () => {
            await this.storageAdapter.deleteFile(key, options);
          });
          orphansPurged += 1;
          logger.info('prefix_sweep.purged_orphan', { key, prefix, reason: classification.reason });
        } catch (delErr) {
          logger.warn('prefix_sweep.delete_failed', { key, error: delErr.message });
          if (
            delErr.code === 'BACKUP_QUIESCENCE_ACTIVE' ||
            delErr.code === 'MUTATION_ADMISSION_CLOSED' ||
            delErr.code === 'INSTANCE_FENCED'
          ) {
            break;
          }
        }
      }

      // Cooperative event-loop micro-yield (NBO-04)
      await this.sleep(0);
    }

    // Update durable checkpoint
    const isTruncated = Boolean(listRes.isTruncated);
    const nextToken = isTruncated ? listRes.nextContinuationToken : null;
    const nextPass = isTruncated ? passNumber : passNumber + 1;

    await this.saveCheckpoint(prefix, {
      continuationToken: nextToken,
      isTruncated,
      passNumber: nextPass,
      lastScannedKey: keys.length > 0 ? keys[keys.length - 1] : checkpoint.lastScannedKey,
      lastRunAt: new Date(),
      totalKeysScanned: (checkpoint.totalKeysScanned || 0) + keysScanned,
      totalOrphansPurged: (checkpoint.totalOrphansPurged || 0) + orphansPurged
    });

    return {
      keysScanned,
      orphansPurged,
      isTruncated,
      passNumber: nextPass
    };
  }

  /**
   * Runs a complete sweep cycle across all configured prefixes.
   *
   * @param {object} [options]
   * @returns {Promise<{ processedPrefixes: number, totalKeysScanned: number, totalOrphansPurged: number }>}
   */
  async runSweepCycle(options = {}) {
    if (this.isCycleInProgress || this.isStopping) {
      return { skipped: true, reason: 'CYCLE_IN_PROGRESS_OR_STOPPING' };
    }

    if (await shouldPauseWorker()) {
      return { skipped: true, reason: 'QUIESCENCE_ACTIVE' };
    }

    this.isCycleInProgress = true;
    let totalKeysScanned = 0;
    let totalOrphansPurged = 0;
    let barrierContext = options.barrierContext || null;
    let ownBarrier = false;

    try {
      if (!barrierContext && !options.session) {
        try {
          const { causalBarrierService } = await import('./causalBarrierService.js');
          barrierContext = await causalBarrierService.establishCausalBarrier({
            role: 'prefix_sweeper',
            timeoutMs: 5000
          });
          ownBarrier = true;
        } catch (barrierErr) {
          logger.warn('prefix_sweep.causal_barrier_failed', { error: barrierErr.message });
          return { skipped: true, reason: 'CAUSAL_BARRIER_FAILED', error: barrierErr.message };
        }
      }

      for (const prefix of this.prefixes) {
        if (this.isStopping || (await shouldPauseWorker())) break;
        const res = await this.sweepPrefix(prefix, { ...options, barrierContext });
        totalKeysScanned += res.keysScanned;
        totalOrphansPurged += res.orphansPurged;
      }

      return {
        processedPrefixes: this.prefixes.length,
        totalKeysScanned,
        totalOrphansPurged
      };
    } finally {
      if (ownBarrier && barrierContext?.session) {
        await barrierContext.session.endSession().catch(() => {});
      }
      this.isCycleInProgress = false;
    }
  }

  /**
   * Starts the background sweeper loop coordinated with AppWorker lease.
   */
  async start() {
    this.isStopping = false;
    if (this.timer) return;

    this.timer = setInterval(async () => {
      try {
        await this.runSweepCycle();
      } catch (err) {
        logger.error('prefix_sweep.cycle_error', { error: err.message });
      }
    }, this.cycleIntervalMs);

    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Gracefully stops the background sweeper.
   */
  async stop() {
    this.isStopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export default new PrefixSweepService();
