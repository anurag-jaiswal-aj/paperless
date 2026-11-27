/**
 * StorageReconciliationService
 *
 * Background reconciliation and repair service for durable StorageJournal.
 * Enforces dual-HEAD stability probing, two-tier reference checking,
 * and atomic CAS claim locking to safely compensate orphaned blobs
 * and resolve ambiguous outcomes without data loss.
 */

import crypto from 'crypto';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import s3Provider from './S3StorageProvider.js';
import { assertStorageMutationAllowed } from './StorageService.js';
import { trackStorageOperation } from '../middleware/quiescenceGate.js';
import { logger } from '../utils/logger.js';

export class StorageReconciliationService {
  constructor(options = {}) {
    this.storageAdapter = options.storageAdapter || s3Provider;
    this.probeDelayMs = typeof options.probeDelayMs === 'number' ? options.probeDelayMs : 100;
    this.workerId = options.workerId || `worker_${crypto.randomUUID().slice(0, 8)}`;
  }

  async sleep(ms) {
    if (ms <= 0) return;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Asserts worker context validity and monotonic lease deadline prior to destructive S3 deletion.
   * Fails closed if worker context is invalid, expired, or missing in worker-driven execution.
   *
   * @param {object} options
   * @param {string} operationId
   * @returns {{ valid: boolean, action?: string }}
   */
  assertWorkerLeaseBeforeDeletion(options = {}, operationId) {
    const isWorkerDriven = Boolean(options.isWorkerDriven || options.requireWorkerContext);
    const workerContext = options.workerContext;

    if (isWorkerDriven) {
      if (!workerContext || typeof workerContext.isLeaseValid !== 'function') {
        logger.error('storage_reconciliation.worker_context_missing', { operationId });
        return { valid: false, action: 'WORKER_CONTEXT_MISSING' };
      }
      if (!workerContext.isLeaseValid()) {
        logger.warn('storage_reconciliation.worker_lease_expired', {
          operationId,
          workerId: workerContext.workerId
        });
        return { valid: false, action: 'LEASE_EXPIRED_PRE_DELETE' };
      }
      if (options.workerId && workerContext.workerId !== options.workerId) {
        return { valid: false, action: 'WORKER_IDENTITY_MISMATCH' };
      }
      // Monotonic deadline safety margin check (minimum 2000ms headroom required for network I/O)
      if (
        typeof workerContext.localMonotonicDeadlineMs === 'number' &&
        workerContext.localMonotonicDeadlineMs - performance.now() < 2000
      ) {
        logger.warn('storage_reconciliation.insufficient_lease_headroom', {
          operationId,
          headroomMs: workerContext.localMonotonicDeadlineMs - performance.now()
        });
        return { valid: false, action: 'LEASE_EXPIRED_PRE_DELETE' };
      }
    } else if (workerContext && typeof workerContext.isLeaseValid === 'function') {
      if (!workerContext.isLeaseValid()) {
        return { valid: false, action: 'LEASE_EXPIRED_PRE_DELETE' };
      }
      if (options.workerId && workerContext.workerId !== options.workerId) {
        return { valid: false, action: 'WORKER_IDENTITY_MISMATCH' };
      }
    }

    return { valid: true };
  }

  /**
   * Reconciles a single StorageJournal record with atomic CAS claim and dual-HEAD checks.
   *
   * @param {object} op - StorageJournal document or plain object with operationId
   * @param {object} [options]
   * @returns {Promise<{ action: string, operationId: string, details?: any }>}
   */
  async reconcileRecord(op, options = {}) {
    const operationId = op.operationId;
    const workerContext = options.workerContext;
    if (workerContext?.workerId) {
      if (options.workerId && workerContext.workerId !== options.workerId) {
        return { action: 'WORKER_IDENTITY_MISMATCH', operationId };
      }
      if (this.workerId && workerContext.workerId !== this.workerId) {
        return { action: 'WORKER_IDENTITY_MISMATCH', operationId };
      }
    }

    const effectiveWorkerId = workerContext?.workerId || options.workerId || this.workerId;
    const effectiveOptions = { ...options, workerId: effectiveWorkerId };

    // Step 1: Claim record via atomic Compare-And-Swap
    let claimed = op;
    if (op.status !== STORAGE_JOURNAL_STATUS.RECONCILING || op.lockedBy !== effectiveWorkerId) {
      claimed = await StorageJournal.claimForReconciliation(
        operationId,
        effectiveWorkerId,
        effectiveOptions
      );
      if (!claimed) {
        return { action: 'SKIPPED_NOT_CLAIMED', operationId };
      }
    }

    try {
      // Step 2: Handle mutation by operation type
      if (
        claimed.type === STORAGE_OPERATION_TYPE.PUT_OBJECT ||
        claimed.type === STORAGE_OPERATION_TYPE.COPY_OBJECT ||
        claimed.type === STORAGE_OPERATION_TYPE.MULTIPART_UPLOAD
      ) {
        return await this.reconcileUploadOrCopy(claimed, effectiveOptions);
      }

      if (
        claimed.type === STORAGE_OPERATION_TYPE.DELETE_OBJECT ||
        claimed.type === STORAGE_OPERATION_TYPE.DELETE_OBJECTS
      ) {
        return await this.reconcileDelete(claimed, effectiveOptions);
      }

      // Default fallback
      return { action: 'UNRECOGNIZED_TYPE', operationId };
    } catch (err) {
      logger.error('storage_reconciliation.record_failed', {
        operationId,
        error: err.message
      });
      return { action: 'ERROR', operationId, error: err.message };
    }
  }

  async reconcileUploadOrCopy(op, options = {}) {
    const now = new Date();
    const destinationKey = op.destinationKey;
    const effectiveWorkerId = options.workerContext?.workerId || options.workerId || this.workerId;

    const readQueryOptions = {
      readPreference: 'primary',
      readConcern: { level: 'majority' }
    };
    if (options.session) {
      readQueryOptions.session = options.session;
    } else if (options.barrierContext?.session) {
      readQueryOptions.session = options.barrierContext.session;
    }

    // Dual-HEAD Probe 1
    let head1;
    try {
      head1 = await this.storageAdapter.headObject(destinationKey, options);
    } catch (err) {
      if (err.name === 'NotFound' || err.statusCode === 404) {
        head1 = null;
      } else {
        throw err;
      }
    }

    // If Probe 1 returns null (404), check quarantine
    if (!head1) {
      if (op.quarantinedUntil && new Date(op.quarantinedUntil) > now) {
        // Still inside cooling-off period; release lease and wait
        const resetRes = await StorageJournal.updateOne(
          {
            operationId: op.operationId,
            status: STORAGE_JOURNAL_STATUS.RECONCILING,
            epoch: op.epoch,
            lockedBy: effectiveWorkerId
          },
          {
            $set: { status: STORAGE_JOURNAL_STATUS.AMBIGUOUS, lockedUntil: null, lockedBy: null },
            $inc: { epoch: 1 }
          }
        );
        if (resetRes.matchedCount === 0) {
          return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
        }
        return { action: 'SKIPPED_IN_QUARANTINE', operationId: op.operationId };
      }

      // Quarantine expired and object does not exist; mark compensated/abandoned
      // R-KE-01: Prophylactic idempotent delete before marking COMPENSATED to eliminate late-landing packets
      // NBO-01 Hardening: Assert worker lease and verify ownership before issuing remote delete
      const leaseCheck = this.assertWorkerLeaseBeforeDeletion(options, op.operationId);
      if (!leaseCheck.valid) {
        return { action: leaseCheck.action, operationId: op.operationId };
      }

      const stillOwned = await StorageJournal.exists({
        operationId: op.operationId,
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        epoch: op.epoch,
        lockedBy: effectiveWorkerId
      }).setOptions(readQueryOptions);
      if (!stillOwned) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }

      try {
        await this.storageAdapter.deleteFile(destinationKey, options);
      } catch {
        // Idempotent 404 or ignore
      }
      const compRes = await StorageJournal.markCompensated(op.operationId, op.epoch, {
        errorDetails: 'Remote object never materialized (404 NotFound after quarantine)',
        vacuumHours: null,
        lockedBy: effectiveWorkerId
      });
      if (!compRes) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }
      return { action: 'COMPENSATED_404', operationId: op.operationId };
    }

    // Delay between probes
    if (this.probeDelayMs > 0) {
      await this.sleep(this.probeDelayMs);
    }

    // Dual-HEAD Probe 2
    let head2;
    try {
      head2 = await this.storageAdapter.headObject(destinationKey, options);
    } catch (err) {
      if (err.name === 'NotFound' || err.statusCode === 404) {
        head2 = null;
      } else {
        throw err;
      }
    }

    if (!head2) {
      // Object vanished between probes; still unstable
      const extendedQuarantine = new Date(Date.now() + 30000);
      const resetRes = await StorageJournal.updateOne(
        {
          operationId: op.operationId,
          status: STORAGE_JOURNAL_STATUS.RECONCILING,
          epoch: op.epoch,
          lockedBy: effectiveWorkerId
        },
        {
          $set: {
            status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
            quarantinedUntil: extendedQuarantine,
            lockedUntil: null,
            lockedBy: null,
            errorDetails: 'Remote object vanished during dual-HEAD probe'
          },
          $inc: { epoch: 1 }
        }
      );
      if (resetRes.matchedCount === 0) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }
      return { action: 'QUARANTINE_EXTENDED_UNSTABLE', operationId: op.operationId };
    }

    // Check for write drift
    const length1 = head1.ContentLength ?? head1.contentLength;
    const length2 = head2.ContentLength ?? head2.contentLength;
    const etag1 = head1.ETag ?? head1.etag;
    const etag2 = head2.ETag ?? head2.etag;

    if (length1 !== length2 || etag1 !== etag2) {
      // Remote write is actively flushing! Extend quarantine by 30 seconds
      const extendedQuarantine = new Date(Date.now() + 30000);
      const resetRes = await StorageJournal.updateOne(
        {
          operationId: op.operationId,
          status: STORAGE_JOURNAL_STATUS.RECONCILING,
          epoch: op.epoch,
          lockedBy: effectiveWorkerId
        },
        {
          $set: {
            status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
            quarantinedUntil: extendedQuarantine,
            lockedUntil: null,
            lockedBy: null,
            errorDetails: 'Remote object still mutating (Dual-HEAD drift detected)'
          },
          $inc: { epoch: 1 }
        }
      );
      if (resetRes.matchedCount === 0) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }
      return { action: 'QUARANTINE_EXTENDED_DRIFT', operationId: op.operationId };
    }

    // Object identity / collision check via metadata
    const metadata = head2.Metadata || head2.metadata || {};
    const remoteOpId = metadata['operation-id'] || metadata.operationId;
    const remoteHash = metadata['payload-hash'] || metadata.payloadHash;

    if (
      remoteOpId &&
      remoteOpId !== op.operationId &&
      remoteHash &&
      op.payloadHash &&
      remoteHash !== op.payloadHash
    ) {
      // Key collision with distinct operation payload; must not delete!
      const abRes = await StorageJournal.markAbandoned(op.operationId, op.epoch, {
        errorDetails: 'Key occupied by distinct payload with differing operationId; preserved',
        lockedBy: effectiveWorkerId
      });
      if (!abRes) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }
      return { action: 'ABANDONED_COLLISION', operationId: op.operationId };
    }

    // Tier 1: Check if committed Response exists referencing this key
    const isCommitted = await Response.exists({
      'answers.value.key': destinationKey,
      commitStatus: 'committed'
    }).setOptions(readQueryOptions);

    if (isCommitted) {
      // Response was successfully committed! File must be preserved!
      const confRes = await StorageJournal.confirmOperation(op.operationId, op.epoch, {
        etag: etag2,
        lockedBy: effectiveWorkerId
      });
      if (!confRes) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }
      return { action: 'CONFIRMED', operationId: op.operationId };
    }

    // Tier 2: Check if active or quarantined user submission reservation exists (globally across leaseId or staged/promoted keys)
    const leaseId = op.reservationLeaseId;
    const activeReservation = await SubmissionReservation.findOne({
      $and: [
        {
          $or: [
            ...(leaseId ? [{ leaseId }] : []),
            { stagedKeys: destinationKey },
            { promotedKeys: destinationKey }
          ]
        },
        {
          $or: [
            { status: { $in: ['active', 'committing'] }, expiresAt: { $gt: now } },
            { quarantinedUntil: { $gt: now } }
          ]
        }
      ]
    }).setOptions(readQueryOptions);

    if (activeReservation) {
      // User session is actively in-progress! Extend quarantine past reservation expiry
      const safeQuarantine = new Date(new Date(activeReservation.expiresAt).getTime() + 10000);
      const resetRes = await StorageJournal.updateOne(
        {
          operationId: op.operationId,
          status: STORAGE_JOURNAL_STATUS.RECONCILING,
          epoch: op.epoch,
          lockedBy: effectiveWorkerId
        },
        {
          $set: {
            status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
            quarantinedUntil: safeQuarantine,
            lockedUntil: null,
            lockedBy: null,
            errorDetails: 'Active user submission reservation in progress'
          },
          $inc: { epoch: 1 }
        }
      );
      if (resetRes.matchedCount === 0) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }
      return { action: 'QUARANTINE_EXTENDED_RESERVATION', operationId: op.operationId };
    }

    // Tier 3: Unreferenced orphan blob -> Safely delete from storage and mark COMPENSATED
    // Check ownership before issuing S3 deletion (Agent E Remediation R-05 & R-KE-03)
    const leaseCheck = this.assertWorkerLeaseBeforeDeletion(options, op.operationId);
    if (!leaseCheck.valid) {
      return { action: leaseCheck.action, operationId: op.operationId };
    }

    const stillOwned = await StorageJournal.exists({
      operationId: op.operationId,
      status: STORAGE_JOURNAL_STATUS.RECONCILING,
      epoch: op.epoch,
      lockedBy: effectiveWorkerId
    }).setOptions(readQueryOptions);
    if (!stillOwned) {
      return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
    }

    let deleteSucceeded = false;
    try {
      await assertStorageMutationAllowed(options);
      await trackStorageOperation(async () => {
        await this.storageAdapter.deleteFile(destinationKey, options);
      });
      deleteSucceeded = true;
    } catch (delErr) {
      logger.warn('storage_reconciliation.delete_orphan_failed', {
        destinationKey,
        error: delErr.message
      });
    }

    if (!deleteSucceeded) {
      // Do NOT mark compensated if remote delete failed! Reset to AMBIGUOUS with quarantine
      await StorageJournal.updateOne(
        { operationId: op.operationId, epoch: op.epoch, lockedBy: effectiveWorkerId },
        {
          $set: {
            status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
            quarantinedUntil: new Date(Date.now() + 30000),
            lockedUntil: null,
            lockedBy: null,
            errorDetails: 'Remote S3 deletion failed during orphan compensation; re-quarantined'
          },
          $inc: { epoch: 1 }
        }
      );
      return { action: 'DELETE_FAILED_REQUARANTINED', operationId: op.operationId };
    }

    const compRes = await StorageJournal.markCompensated(op.operationId, op.epoch, {
      errorDetails: 'Unreferenced zombie blob compensated via DeleteObject',
      lockedBy: effectiveWorkerId
    });
    if (!compRes) {
      return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
    }

    return { action: 'COMPENSATED', operationId: op.operationId };
  }

  async reconcileDelete(op, options = {}) {
    const destinationKey = op.destinationKey;
    const effectiveWorkerId = options.workerContext?.workerId || options.workerId || this.workerId;

    let head;
    try {
      head = await this.storageAdapter.headObject(destinationKey, options);
    } catch (err) {
      if (err.name === 'NotFound' || err.statusCode === 404) {
        head = null;
      } else {
        throw err;
      }
    }

    if (!head) {
      // Object is already gone from S3; deletion confirmed!
      const confRes = await StorageJournal.confirmOperation(op.operationId, op.epoch, {
        lockedBy: effectiveWorkerId
      });
      if (!confRes) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }
      return { action: 'CONFIRMED', operationId: op.operationId };
    }

    // Object still exists in S3; check if Response still exists
    const readQueryOptions = {
      readPreference: 'primary',
      readConcern: { level: 'majority' }
    };
    if (options.session) {
      readQueryOptions.session = options.session;
    } else if (options.barrierContext?.session) {
      readQueryOptions.session = options.barrierContext.session;
    }

    const responseStillExists = await Response.exists({
      'answers.value.key': destinationKey,
      commitStatus: 'committed'
    }).setOptions(readQueryOptions);

    if (responseStillExists) {
      // Response document was NOT deleted; abandon deletion operation to protect user data
      const abRes = await StorageJournal.markAbandoned(op.operationId, op.epoch, {
        errorDetails: 'Response still exists in MongoDB; deletion aborted',
        lockedBy: effectiveWorkerId
      });
      if (!abRes) {
        return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
      }
      return { action: 'ABANDONED_RESPONSE_EXISTS', operationId: op.operationId };
    }

    // F-05 Remediation: Verify worker lease validity and ownership before remote S3 delete
    const leaseCheck = this.assertWorkerLeaseBeforeDeletion(options, op.operationId);
    if (!leaseCheck.valid) {
      return { action: leaseCheck.action, operationId: op.operationId };
    }

    // Check ownership before issuing S3 delete
    const stillOwned = await StorageJournal.exists({
      operationId: op.operationId,
      status: STORAGE_JOURNAL_STATUS.RECONCILING,
      epoch: op.epoch,
      lockedBy: effectiveWorkerId
    }).setOptions(readQueryOptions);
    if (!stillOwned) {
      return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
    }

    // Response is gone, but S3 object remains -> Delete it!
    await this.storageAdapter.deleteFile(destinationKey, options);
    const confRes = await StorageJournal.confirmOperation(op.operationId, op.epoch, {
      lockedBy: effectiveWorkerId
    });
    if (!confRes) {
      return { action: 'STALE_EPOCH_CONFLICT', operationId: op.operationId };
    }
    return { action: 'CONFIRMED', operationId: op.operationId };
  }

  /**
   * Sweeps and reconciles a batch of ambiguous or pending records.
   */
  async reconcileBatch(options = {}) {
    const effectiveWorkerId = options.workerContext?.workerId || options.workerId || this.workerId;
    const effectiveOptions = { ...options, workerId: effectiveWorkerId };

    if (
      effectiveOptions.workerContext?.isLeaseValid &&
      !effectiveOptions.workerContext.isLeaseValid()
    ) {
      return {
        processedCount: 0,
        skipped: true,
        reason: 'LEASE_EXPIRED_PRE_BATCH',
        results: []
      };
    }

    const now = new Date();
    const limit = effectiveOptions.limit || 50;

    const readOpts = {
      readPreference: 'primary',
      readConcern: { level: 'majority' }
    };
    if (effectiveOptions.session) {
      readOpts.session = effectiveOptions.session;
    } else if (effectiveOptions.barrierContext?.session) {
      readOpts.session = effectiveOptions.barrierContext.session;
    }

    const records = await StorageJournal.find({
      status: {
        $in: [
          STORAGE_JOURNAL_STATUS.AMBIGUOUS,
          STORAGE_JOURNAL_STATUS.CREATED,
          STORAGE_JOURNAL_STATUS.PENDING,
          STORAGE_JOURNAL_STATUS.DISPATCHED,
          STORAGE_JOURNAL_STATUS.RECONCILING
        ]
      },
      $or: [{ quarantinedUntil: null }, { quarantinedUntil: { $lte: now } }],
      $and: [
        {
          $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }]
        }
      ]
    }).setOptions(readOpts).limit(limit);

    const results = [];
    for (const record of records) {
      if (
        typeof effectiveOptions.shouldPause === 'function' &&
        (await effectiveOptions.shouldPause())
      ) {
        break;
      }
      if (
        effectiveOptions.workerContext?.isLeaseValid &&
        !effectiveOptions.workerContext.isLeaseValid()
      ) {
        break;
      }
      const result = await this.reconcileRecord(record, effectiveOptions);
      results.push(result);
      await this.sleep(0); // Cooperative event-loop micro-yield (NBO-04)
    }

    return {
      processedCount: results.length,
      results
    };
  }
}

export default new StorageReconciliationService();
