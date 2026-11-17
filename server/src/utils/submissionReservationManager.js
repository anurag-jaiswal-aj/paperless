import crypto from 'crypto';
import Form from '../models/form.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import storageService from '../services/StorageService.js';
import { logger } from './logger.js';
import { withRequiredTransaction } from './dbTransaction.js';

export const SUBMISSION_LEASE_TTL_MS = 30000;
export const HEARTBEAT_INTERVAL_MS = 10000;
export const PROMOTION_QUARANTINE_MS =
  (parseInt(process.env.S3_UPLOAD_TIMEOUT_MS, 10) || 30000) + 10000;

const buildNoActiveDeletionLeaseFilter = (now) => ({
  $or: [
    { 'deletionProgress.leaseId': null },
    { 'deletionProgress.leaseExpiresAt': null },
    { 'deletionProgress.leaseExpiresAt': { $lt: now } }
  ]
});

/**
 * Strict safety barrier validating that a key belongs solely to the temporary staging namespace.
 * Canonical response keys ('forms/.../responses/...') are strictly rejected under all circumstances.
 *
 * @param {string} key
 * @param {string} [expectedFormId]
 * @param {string} [expectedLeaseId]
 * @returns {boolean}
 */
export const isStrictStagingKey = (key, expectedFormId = null, expectedLeaseId = null) => {
  if (typeof key !== 'string' || !key) return false;

  // Rule 1: Canonical response prefix barrier - IMMEDIATE HARD REJECTION
  if (key.includes('/responses/')) {
    return false;
  }

  // Rule 2: Must belong to staging namespace and match form/lease if provided
  if (expectedFormId && expectedLeaseId) {
    const isNewStaging = key.startsWith(`staging/forms/${expectedFormId}/${expectedLeaseId}/`);
    const isOldStaging = key.startsWith(`forms/${expectedFormId}/staging/${expectedLeaseId}/`);
    if (!isNewStaging && !isOldStaging) {
      return false;
    }
  } else {
    if (!key.startsWith('staging/forms/') && !key.includes('/staging/')) {
      return false;
    }
  }

  return !key.includes('..');
};

export class SubmissionReservationManager {
  /**
   * Atomically acquires an independent submission reservation inside a mandatory
   * MongoDB replica-set transaction, coordinating Form write-lock state and
   * SubmissionReservation creation so concurrent form deletion cannot proceed unseen.
   *
   * @param {string|mongoose.Types.ObjectId} formId
   * @param {object} [options]
   * @param {number} [options.ttlMs=30000]
   * @param {string} [options.submittedBy='anonymous']
   * @returns {Promise<{ success: boolean, statusCode?: number, message?: string, leaseId?: string, fenceToken?: string, expiresAt?: Date, form?: object }>}
   */
  static async acquire(formId, options = {}) {
    const ttlMs = options.ttlMs || SUBMISSION_LEASE_TTL_MS;
    const leaseId = crypto.randomUUID();
    const fenceToken = crypto.randomUUID();

    return withRequiredTransaction(async (session) => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlMs);

      const updatedForm = await Form.findOneAndUpdate(
        {
          _id: formId,
          status: 'published',
          ...buildNoActiveDeletionLeaseFilter(now)
        },
        {
          $inc: { activeSubmissions: 1, lifecycleVersion: 1 },
          $max: { activeSubmissionsExpiresAt: expiresAt },
          $set: { updatedAt: now }
        },
        { session, new: true }
      );

      if (!updatedForm) {
        const existingForm = await Form.findById(formId).session(session);
        if (!existingForm) {
          return { success: false, statusCode: 404, message: 'Form not found' };
        }
        const hasActiveDeletionLease = Boolean(
          existingForm.deletionProgress?.leaseId &&
          existingForm.deletionProgress?.leaseExpiresAt &&
          new Date(existingForm.deletionProgress.leaseExpiresAt) >= now
        );
        if (['deleting', 'delete_failed'].includes(existingForm.status) || hasActiveDeletionLease) {
          return { success: false, statusCode: 409, message: 'Form is currently being deleted' };
        }
        return { success: false, statusCode: 403, message: 'This form is not accepting responses' };
      }

      await SubmissionReservation.create(
        [
          {
            formId,
            leaseId,
            fenceToken,
            status: 'active',
            expiresAt,
            vacuumAt: null,
            stagedKeys: [],
            counterReleased: false,
            submittedBy: options.submittedBy || 'anonymous',
            createdAt: now,
            updatedAt: now
          }
        ],
        { session }
      );

      return {
        success: true,
        leaseId,
        fenceToken,
        expiresAt,
        form: updatedForm
      };
    });
  }

  /**
   * Heartbeat renewal during long-running multipart uploads.
   * Extends reservation expiry inside a transaction while Form remains published and unlocked.
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @param {string|mongoose.Types.ObjectId} formId
   * @param {number} [ttlMs=30000]
   * @returns {Promise<boolean>} - true if lease renewed; false if revoked or expired
   */
  static async renew(leaseId, fenceToken, formId, ttlMs = SUBMISSION_LEASE_TTL_MS) {
    return withRequiredTransaction(async (session) => {
      const now = new Date();
      const newExpiresAt = new Date(now.getTime() + ttlMs);

      const existingReservation = await SubmissionReservation.findOne({
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: { $gt: now }
      })
        .select('formId')
        .session(session)
        .lean();

      if (!existingReservation) {
        return false;
      }

      const targetFormId = formId || existingReservation.formId;
      if (targetFormId) {
        const formValid = await Form.exists({
          _id: targetFormId,
          status: 'published',
          ...buildNoActiveDeletionLeaseFilter(now)
        }).session(session);

        if (!formValid) {
          return false;
        }
      }

      const updated = await SubmissionReservation.findOneAndUpdate(
        { leaseId, fenceToken, status: 'active', expiresAt: { $gt: now } },
        { $set: { expiresAt: newExpiresAt, updatedAt: now } },
        { session, new: true }
      );

      if (!updated) {
        return false;
      }

      if (targetFormId) {
        await Form.updateOne(
          { _id: targetFormId, status: 'published' },
          { $max: { activeSubmissionsExpiresAt: newExpiresAt } },
          { session }
        );
      }

      return true;
    });
  }

  /**
   * Track staged or promoted S3 key associated with an active, unexpired reservation.
   * Staging keys ('staging/...') are recorded into stagedKeys.
   * Promoted canonical keys ('forms/...') are recorded into promotedKeys.
   * Fails closed (returns false / propagates DB errors) rather than swallowing errors.
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @param {string} s3Key
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  static async recordStagedKey(leaseId, fenceToken, s3Key, options = {}) {
    const isPromotedCanonical =
      typeof s3Key === 'string' && s3Key.includes('/responses/') && !s3Key.includes('staging');
    if (isPromotedCanonical) {
      return this.recordPromotedKey(leaseId, fenceToken, s3Key, options);
    }

    const now = new Date();
    const result = await SubmissionReservation.updateOne(
      {
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: { $gt: now }
      },
      {
        $addToSet: { stagedKeys: s3Key },
        $set: { updatedAt: now }
      }
    );
    return result.matchedCount > 0;
  }

  /**
   * Record canonical promoted key prior to S3 copy and transactional commit.
   * Atomically transitions promotionStatus to 'in_flight' and sets promotionLeaseExpiresAt.
   * Also tracks individual file state in promotedFiles.
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @param {string} finalKey
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  static async recordPromotedKey(leaseId, fenceToken, finalKey, options = {}) {
    const now = new Date();
    const ttlMs = options.ttlMs || PROMOTION_QUARANTINE_MS;
    const promotionLeaseExpiresAt = new Date(now.getTime() + ttlMs);

    const fileEntry = {
      fileId: options.fileId || finalKey,
      stagingKey: options.stagingKey || '',
      finalKey,
      status: 'in_flight',
      copyInitiatedAt: now,
      copyCompletedAt: null,
      reconciliationPasses: 0,
      etag: null,
      error: null
    };

    // 1. Atomically update existing entry for this finalKey if present
    const updateExisting = await SubmissionReservation.updateOne(
      {
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: { $gt: now },
        'promotedFiles.finalKey': finalKey
      },
      {
        $addToSet: { promotedKeys: finalKey },
        $set: {
          'promotedFiles.$.fileId': fileEntry.fileId,
          'promotedFiles.$.stagingKey': fileEntry.stagingKey,
          'promotedFiles.$.status': 'in_flight',
          'promotedFiles.$.copyInitiatedAt': now,
          'promotedFiles.$.copyCompletedAt': null,
          'promotedFiles.$.etag': null,
          'promotedFiles.$.error': null,
          promotionStatus: 'in_flight',
          promotionLeaseExpiresAt,
          updatedAt: now
        },
        $inc: { promotionEpoch: 1 }
      }
    );
    if (updateExisting.matchedCount > 0) {
      return true;
    }

    // 2. Atomically push new entry if finalKey is not in array
    const insertNew = await SubmissionReservation.updateOne(
      {
        leaseId,
        fenceToken,
        status: 'active',
        expiresAt: { $gt: now },
        'promotedFiles.finalKey': { $ne: finalKey }
      },
      {
        $addToSet: { promotedKeys: finalKey },
        $push: { promotedFiles: fileEntry },
        $set: {
          promotionStatus: 'in_flight',
          promotionLeaseExpiresAt,
          updatedAt: now
        },
        $inc: { promotionEpoch: 1 }
      }
    );
    if (insertNew.matchedCount > 0) {
      return true;
    }

    // 3. Concurrency check: verify if a concurrent registration call inserted finalKey
    const existingDoc = await SubmissionReservation.findOne({
      leaseId,
      fenceToken,
      status: 'active',
      expiresAt: { $gt: now },
      'promotedFiles.finalKey': finalKey
    })
      .select('_id')
      .lean();

    return !!existingDoc;
  }

  /**
   * Mark promotion completed for a specific file after storageService.copyFile returns successfully.
   * Updates only this file's status in promotedFiles without marking the entire reservation complete.
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @param {string} finalKey
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  static async completeFilePromotion(leaseId, fenceToken, finalKey, options = {}) {
    const now = new Date();
    const result = await SubmissionReservation.updateOne(
      {
        leaseId,
        fenceToken,
        status: { $in: ['active', 'committing'] },
        'promotedFiles.finalKey': finalKey
      },
      {
        $set: {
          'promotedFiles.$.status': 'promoted',
          'promotedFiles.$.copyCompletedAt': now,
          'promotedFiles.$.etag': options.etag || null,
          updatedAt: now
        }
      }
    );
    if (result.matchedCount > 0) {
      return true;
    }

    // Fallback if record was initialized without promotedFiles subdocument
    const fallback = await SubmissionReservation.updateOne(
      {
        leaseId,
        fenceToken,
        status: { $in: ['active', 'committing'] }
      },
      {
        $addToSet: { promotedKeys: finalKey },
        $push: {
          promotedFiles: {
            fileId: finalKey,
            stagingKey: options.stagingKey || '',
            finalKey,
            status: 'promoted',
            copyInitiatedAt: now,
            copyCompletedAt: now,
            reconciliationPasses: 0,
            etag: options.etag || null,
            error: null
          }
        },
        $set: { updatedAt: now }
      }
    );
    return fallback.matchedCount > 0;
  }

  /**
   * Mark the entire promotion batch completed after all files in the submission have completed copying.
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @returns {Promise<boolean>}
   */
  static async completeBatchPromotion(leaseId, fenceToken) {
    const now = new Date();
    const result = await SubmissionReservation.updateOne(
      {
        leaseId,
        fenceToken,
        status: { $in: ['active', 'committing'] }
      },
      {
        $set: {
          promotionStatus: 'completed',
          promotionLeaseExpiresAt: null,
          updatedAt: now
        }
      }
    );
    return result.matchedCount > 0;
  }

  /**
   * Backwards-compatible alias for completeBatchPromotion.
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @returns {Promise<boolean>}
   */
  static async completePromotion(leaseId, fenceToken) {
    return this.completeBatchPromotion(leaseId, fenceToken);
  }

  /**
   * Atomically transitions reservation from 'active' to 'committing' via CAS,
   * extending lease duration to provide an unexpired persistence window for Response.create.
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @param {object} [session] - Mongoose ClientSession (required in transactional callers)
   * @param {number} [ttlMs=30000]
   * @returns {Promise<boolean>}
   */
  static async markCommitting(
    leaseId,
    fenceToken,
    session = null,
    ttlMs = SUBMISSION_LEASE_TTL_MS
  ) {
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + ttlMs);

    const query = {
      leaseId,
      fenceToken,
      status: 'active',
      expiresAt: { $gt: now }
    };
    const update = {
      $set: {
        status: 'committing',
        expiresAt: newExpiresAt,
        updatedAt: now
      }
    };
    const options = session ? { session, new: true } : { new: true };

    const reservation = await SubmissionReservation.findOneAndUpdate(query, update, options);
    if (!reservation) {
      return false;
    }

    // When session is active, caller already write-locked Form inside the same transaction.
    // Avoid redundant writes inside transactions, and never swallow transient tx errors.
    if (!session && reservation.formId) {
      await Form.updateOne(
        { _id: reservation.formId, status: 'published' },
        { $max: { activeSubmissionsExpiresAt: newExpiresAt } }
      );
    }

    return true;
  }

  /**
   * Fencing check & atomic finalization after persisting response to MongoDB.
   * Uses counterReleased flag so activeSubmissions is decremented at most once.
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @param {object} [session] - Mongoose ClientSession
   * @param {string|mongoose.Types.ObjectId} [formId] - Optional Form ObjectId
   * @returns {Promise<boolean>} - true if successfully finalized; false if lease was lost
   */
  static async finalize(leaseId, fenceToken, session = null, formId = null, stagingKeys = null) {
    const now = new Date();
    const query = {
      leaseId,
      fenceToken,
      status: { $in: ['active', 'committing'] },
      expiresAt: { $gt: now }
    };

    let keysToPurge = stagingKeys;
    if (keysToPurge === null) {
      const existingRes = await SubmissionReservation.findOne(
        { leaseId, fenceToken },
        'stagedKeys',
        session ? { session } : {}
      ).lean();
      keysToPurge = existingRes?.stagedKeys || [];
    }

    const hasStaged = Array.isArray(keysToPurge) && keysToPurge.length > 0;
    const update = {
      $set: {
        status: 'finalized',
        promotionStatus: 'completed',
        promotionLeaseExpiresAt: null,
        quarantinedUntil: null,
        stagingCleanupStatus: hasStaged ? 'pending' : 'not_required',
        stagedKeys: hasStaged ? keysToPurge : [],
        stagingKeysToPurge: hasStaged ? keysToPurge : [],
        vacuumAt: hasStaged ? null : new Date(now.getTime() + 24 * 60 * 60 * 1000),
        counterReleased: true,
        updatedAt: now
      }
    };
    const options = session ? { session, new: false } : { new: false };

    const previousReservation = await SubmissionReservation.findOneAndUpdate(
      query,
      update,
      options
    );
    if (!previousReservation) {
      return false;
    }

    const targetFormId = formId || previousReservation.formId;
    if (targetFormId && !previousReservation.counterReleased) {
      await Form.updateOne(
        { _id: targetFormId, activeSubmissions: { $gt: 0 } },
        { $inc: { activeSubmissions: -1 } },
        session ? { session } : {}
      );
    }

    return true;
  }

  /**
   * Cleanup compensation on error, client abort, or rejection.
   * Never deletes S3 objects or alters state if the reservation was already finalized.
   * Preserves failed S3 keys on abandoned records with vacuumAt: null (even via upsert
   * if the reservation record was deleted before late S3 cleanup failed).
   *
   * @param {string} leaseId
   * @param {string} fenceToken
   * @param {string[]} [keysToPurge=[]]
   * @param {string|mongoose.Types.ObjectId} [formId]
   */
  static async release(leaseId, fenceToken, keysToPurge = [], formId = null) {
    const now = new Date();
    const allKeysToPurge = new Set(Array.isArray(keysToPurge) ? keysToPurge : []);

    let existing = null;
    try {
      existing = await SubmissionReservation.findOne({ leaseId, fenceToken }).lean();
      if (existing?.status === 'finalized') {
        return;
      }
      if (existing && Array.isArray(existing.stagedKeys)) {
        for (const k of existing.stagedKeys) {
          allKeysToPurge.add(k);
        }
      }
      if (existing && Array.isArray(existing.promotedKeys)) {
        for (const k of existing.promotedKeys) {
          allKeysToPurge.add(k);
        }
      }
    } catch (e) {
      // Proceed to atomic claim / purge attempt
    }

    let claimedForRelease = null;
    let shouldDecrementCounter = false;
    try {
      claimedForRelease = await SubmissionReservation.findOneAndUpdate(
        { leaseId, fenceToken, status: { $ne: 'finalized' } },
        {
          $set: {
            status: 'abandoned',
            counterReleased: true,
            vacuumAt: null,
            updatedAt: now
          }
        },
        { new: false }
      ).lean();

      if (claimedForRelease) {
        if (Array.isArray(claimedForRelease.stagedKeys)) {
          for (const k of claimedForRelease.stagedKeys) {
            allKeysToPurge.add(k);
          }
        }
        if (Array.isArray(claimedForRelease.promotedKeys)) {
          for (const k of claimedForRelease.promotedKeys) {
            allKeysToPurge.add(k);
          }
        }
        shouldDecrementCounter = !claimedForRelease.counterReleased;
      } else {
        const latest = await SubmissionReservation.findOne({ leaseId }).select('status').lean();
        if (latest?.status === 'finalized') {
          return;
        }
      }
    } catch (claimErr) {
      logger.warn('reservation.release_claim_failed', { leaseId, error: claimErr.message });
    }

    const targetFormId = formId || claimedForRelease?.formId || existing?.formId || null;

    // 1. Separate canonical promoted keys from temporary staging keys
    const canonicalPromotedKeys = new Set();
    const stagingKeysToPurge = new Set();

    for (const key of allKeysToPurge) {
      if (typeof key === 'string') {
        if (key.includes('/responses/') && !key.includes('staging')) {
          canonicalPromotedKeys.add(key);
        } else {
          stagingKeysToPurge.add(key);
        }
      }
    }
    if (Array.isArray(claimedForRelease?.promotedKeys)) {
      for (const k of claimedForRelease.promotedKeys) {
        if (typeof k === 'string' && k.includes('/responses/') && !k.includes('staging')) {
          canonicalPromotedKeys.add(k);
        }
      }
    }
    if (Array.isArray(existing?.promotedKeys)) {
      for (const k of existing.promotedKeys) {
        if (typeof k === 'string' && k.includes('/responses/') && !k.includes('staging')) {
          canonicalPromotedKeys.add(k);
        }
      }
    }
    const uniquePromotedKeys = Array.from(canonicalPromotedKeys);

    // 2. Purge ONLY staging files immediately from S3 outside MongoDB transactions.
    // SOURCE INVALIDATION BARRIER: Deleting staging keys prevents any future S3 CopyObject from starting.
    // NEVER delete canonical keys immediately in release(), because an S3 CopyObject may still be in flight!
    const failedStaging = [];
    for (const key of stagingKeysToPurge) {
      try {
        await storageService.deleteFile(key);
      } catch (err) {
        logger.warn('storage.reservation_release_s3_failed', { key, error: err.message });
        failedStaging.push(key);
      }
    }

    // 3. Delete clean staging-only reservations, or durably quarantine/preserve promoted reservations
    try {
      if (uniquePromotedKeys.length > 0) {
        // Critical: S3 copy operations may still be in-flight server-side.
        // Never delete reservations with promoted keys immediately; place into durable quarantine.
        const quarantinedUntil = new Date(now.getTime() + PROMOTION_QUARANTINE_MS);

        const updateFields = {
          status: 'abandoned',
          promotedKeys: uniquePromotedKeys,
          stagedKeys: failedStaging,
          quarantinedUntil,
          promotionStatus: 'abandoned',
          reconciliationState: 'idle',
          counterReleased: true,
          vacuumAt: null,
          updatedAt: new Date()
        };

        if (targetFormId) {
          await SubmissionReservation.updateOne(
            { leaseId, fenceToken, status: { $ne: 'finalized' } },
            {
              $set: updateFields,
              $setOnInsert: {
                formId: targetFormId,
                leaseId,
                fenceToken,
                expiresAt: claimedForRelease?.expiresAt || existing?.expiresAt || now,
                submittedBy: claimedForRelease?.submittedBy || existing?.submittedBy || 'anonymous',
                createdAt: now
              }
            },
            { upsert: true }
          );
        } else {
          await SubmissionReservation.updateOne(
            { leaseId, fenceToken, status: { $ne: 'finalized' } },
            {
              $set: updateFields
            }
          );
        }
      } else if (failedStaging.length === 0) {
        await SubmissionReservation.deleteOne({
          leaseId,
          fenceToken,
          status: { $ne: 'finalized' }
        });
      } else if (targetFormId) {
        await SubmissionReservation.updateOne(
          { leaseId, fenceToken, status: { $ne: 'finalized' } },
          {
            $set: {
              status: 'abandoned',
              stagedKeys: failedStaging,
              vacuumAt: null,
              counterReleased: true,
              updatedAt: new Date()
            },
            $setOnInsert: {
              formId: targetFormId,
              leaseId,
              fenceToken,
              expiresAt: claimedForRelease?.expiresAt || existing?.expiresAt || now,
              submittedBy: claimedForRelease?.submittedBy || existing?.submittedBy || 'anonymous',
              createdAt: now
            }
          },
          { upsert: true }
        );
      } else {
        await SubmissionReservation.updateOne(
          { leaseId, fenceToken, status: { $ne: 'finalized' } },
          {
            $set: {
              status: 'abandoned',
              stagedKeys: failedStaging,
              vacuumAt: null,
              counterReleased: true,
              updatedAt: new Date()
            }
          }
        );
      }
    } catch (delErr) {
      logger.warn('reservation.release_delete_failed', { leaseId, error: delErr.message });
    }

    // 3. Decrement legacy activeSubmissions counter at most once if form is not deleting
    if (targetFormId && shouldDecrementCounter) {
      try {
        await Form.updateOne(
          {
            _id: targetFormId,
            status: { $ne: 'deleting' },
            activeSubmissions: { $gt: 0 }
          },
          { $inc: { activeSubmissions: -1 } }
        );
      } catch (formErr) {
        // Ignored if form was already deleted
      }
    }
  }

  /**
   * Sweep expired active/committing reservations and abandoned reservations on live forms,
   * releasing leaked activeSubmissions counters once and cleaning staged S3 keys outside tx.
   *
   * @param {object} [options]
   * @param {number} [options.batchSize=50]
   * @param {number} [options.graceMs=5000]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ sweptExpired: number, purgedAbandoned: number, failedKeysCount: number }>}
   */
  static async sweepAbandonedReservations(options = {}) {
    const { batchSize = 50, graceMs = 5000, signal } = options;
    const quarantineMs =
      options.quarantineMs !== undefined ? options.quarantineMs : PROMOTION_QUARANTINE_MS;
    const summary = { sweptExpired: 0, purgedAbandoned: 0, failedKeysCount: 0 };

    if (signal?.aborted) {
      return summary;
    }

    const now = new Date();
    const staleCutoff = new Date(now.getTime() - graceMs);

    // 1. Transition expired active/committing reservations on non-deleting forms to abandoned
    const expiredDocs = await SubmissionReservation.find({
      status: { $in: ['active', 'committing'] },
      expiresAt: { $lte: staleCutoff }
    })
      .limit(batchSize)
      .lean();

    for (const doc of expiredDocs) {
      if (signal?.aborted) break;
      try {
        const form = await Form.findById(doc.formId)
          .select('status deletionProgress.leaseExpiresAt')
          .lean();
        if (
          form?.status === 'deleting' &&
          form?.deletionProgress?.leaseExpiresAt &&
          new Date(form.deletionProgress.leaseExpiresAt) > now
        ) {
          continue;
        }

        const prev = await SubmissionReservation.findOneAndUpdate(
          {
            _id: doc._id,
            status: { $in: ['active', 'committing'] },
            expiresAt: { $lte: staleCutoff }
          },
          {
            $set: {
              status: 'abandoned',
              counterReleased: true,
              vacuumAt: null,
              updatedAt: new Date()
            }
          },
          { new: false }
        ).lean();

        if (prev) {
          summary.sweptExpired += 1;
          if (!prev.counterReleased && form && form.status !== 'deleting') {
            await Form.updateOne(
              { _id: prev.formId, status: { $ne: 'deleting' }, activeSubmissions: { $gt: 0 } },
              { $inc: { activeSubmissions: -1 } }
            );
          }
        }
      } catch (err) {
        logger.warn('reservation.sweep_expired_failed', {
          reservationId: doc._id,
          error: err.message
        });
      }
    }

    // 2. Clean up abandoned reservations with durable quarantine and affirmative canonical sweeps
    const abandonedDocs = await SubmissionReservation.find({
      status: 'abandoned',
      $or: [{ quarantinedUntil: null }, { quarantinedUntil: { $lte: now } }]
    })
      .sort({ quarantinedUntil: 1, createdAt: 1 })
      .limit(batchSize)
      .lean();

    for (const doc of abandonedDocs) {
      if (signal?.aborted) break;
      try {
        let promotedKeys = Array.isArray(doc.promotedKeys) ? doc.promotedKeys : [];

        // Safety Barrier 1: Per-key check if canonical promoted keys belong to a committed Response
        if (promotedKeys.length > 0 && doc.formId) {
          const uncommittedKeys = [];
          for (const key of promotedKeys) {
            const isCommitted = await Response.exists({
              formId: doc.formId,
              'answers.value.key': key,
              commitStatus: 'committed'
            });
            if (!isCommitted) {
              uncommittedKeys.push(key);
            }
          }

          if (uncommittedKeys.length < promotedKeys.length) {
            await SubmissionReservation.updateOne(
              { _id: doc._id },
              { $set: { promotedKeys: uncommittedKeys, updatedAt: new Date() } }
            );
            promotedKeys = uncommittedKeys;
          }

          if (promotedKeys.length === 0) {
            // All canonical keys belong to committed Responses! Never delete them from S3.
            const stagingKeys = doc.stagedKeys || [];
            if (stagingKeys.length === 0) {
              await SubmissionReservation.deleteOne({ _id: doc._id });
              summary.purgedAbandoned += 1;
              continue;
            }
          }
        }

        // Safety Barrier 2: Quarantine window for unresolved canonical promoted keys
        if (promotedKeys.length > 0) {
          if (!doc.quarantinedUntil) {
            // First sweeper pass on this abandoned promotion:
            // Purge staging keys immediately (source can be deleted).
            const failedStaged = [];
            for (const key of doc.stagedKeys || []) {
              if (signal?.aborted) {
                failedStaged.push(key);
                continue;
              }
              try {
                await storageService.deleteFile(key);
              } catch (s3Err) {
                logger.warn('reservation.sweep_staged_s3_failed', {
                  key,
                  reservationId: doc._id,
                  error: s3Err.message
                });
                failedStaged.push(key);
              }
            }

            // Arm quarantine window so any in-flight S3 copy can complete or time out.
            const quarantinedUntil = new Date(now.getTime() + quarantineMs);
            await SubmissionReservation.updateOne(
              { _id: doc._id, status: 'abandoned' },
              {
                $set: {
                  stagedKeys: failedStaged,
                  quarantinedUntil,
                  promotionStatus: 'abandoned',
                  reconciliationState: 'idle',
                  reconciliationPasses: 0,
                  vacuumAt: null,
                  counterReleased: true,
                  updatedAt: new Date()
                }
              }
            );
            // Do NOT delete the document!
            continue;
          }

          if (new Date(doc.quarantinedUntil) > now) {
            // Still in quarantine window; in-flight S3 copy may still be processing.
            // Do NOT delete the document!
            continue;
          }

          // Quarantine has expired (quarantinedUntil <= now).
          // CAS claim to ensure single recovery worker executes affirmative sweep:
          const epochMatcher = doc.promotionEpoch
            ? doc.promotionEpoch
            : { $in: [0, null, undefined] };
          const claimed = await SubmissionReservation.findOneAndUpdate(
            {
              _id: doc._id,
              status: 'abandoned',
              promotionEpoch: epochMatcher,
              quarantinedUntil: { $lte: now }
            },
            {
              $set: {
                promotionLeaseId: crypto.randomUUID(),
                promotionLeaseExpiresAt: new Date(now.getTime() + 30000),
                quarantinedUntil: new Date(now.getTime() + 30000),
                updatedAt: new Date()
              },
              $inc: { promotionEpoch: 1 }
            },
            { new: true }
          ).lean();

          if (!claimed) {
            // Claimed by another worker or state changed; skip
            continue;
          }

          // Affirmative post-quarantine sweep of canonical promoted keys
          const uncommittedPromoted = [];
          for (const key of claimed.promotedKeys || []) {
            if (signal?.aborted) {
              uncommittedPromoted.push(key);
              continue;
            }
            // Per-key safety barrier: never delete a committed response object
            const isCommitted = await Response.exists({
              formId: claimed.formId,
              'answers.value.key': key,
              commitStatus: 'committed'
            });
            if (!isCommitted) {
              uncommittedPromoted.push(key);
            }
          }

          // If ALL canonical keys belong to committed Responses, safely delete document!
          if (uncommittedPromoted.length === 0) {
            const failedStagedOnly = [];
            for (const key of claimed.stagedKeys || []) {
              try {
                await storageService.deleteFile(key);
              } catch (s3Err) {
                failedStagedOnly.push(key);
              }
            }
            if (failedStagedOnly.length === 0) {
              const delRes = await SubmissionReservation.deleteOne({
                _id: claimed._id,
                promotionEpoch: claimed.promotionEpoch
              });
              if (delRes.deletedCount > 0) {
                summary.purgedAbandoned += 1;
              }
            } else {
              await SubmissionReservation.updateOne(
                { _id: claimed._id, promotionEpoch: claimed.promotionEpoch },
                {
                  $set: {
                    promotedKeys: [],
                    stagedKeys: failedStagedOnly,
                    promotionStatus: 'none',
                    quarantinedUntil: null,
                    vacuumAt: null,
                    updatedAt: new Date()
                  }
                }
              );
            }
            continue;
          }

          const failedPromoted = [];
          for (const key of uncommittedPromoted) {
            if (signal?.aborted) {
              failedPromoted.push(key);
              continue;
            }
            try {
              await storageService.deleteFile(key);
            } catch (s3Err) {
              logger.warn('reservation.sweep_promoted_s3_failed', {
                key,
                reservationId: doc._id,
                error: s3Err.message
              });
              failedPromoted.push(key);
            }
          }

          // Also purge any remaining staging keys
          const failedStaged = [];
          for (const key of claimed.stagedKeys || []) {
            if (signal?.aborted) {
              failedStaged.push(key);
              continue;
            }
            try {
              await storageService.deleteFile(key);
            } catch (s3Err) {
              logger.warn('reservation.sweep_staged_s3_failed', {
                key,
                reservationId: doc._id,
                error: s3Err.message
              });
              failedStaged.push(key);
            }
          }

          if (failedPromoted.length === 0 && failedStaged.length === 0) {
            // RETAIN THE CLEANUP TOMBSTONE ON LIVE FORMS:
            // S3 DeleteObject returning 204 or key not found does NOT prove an admitted
            // CopyObject cannot still complete. Retain durable cleanup tombstone for periodic
            // affirmative reconciliation until form deletion or response commitment.
            const reconcileIntervalMs =
              options.reconcileIntervalMs !== undefined
                ? options.reconcileIntervalMs
                : quarantineMs === 0
                  ? 0
                  : 300000;
            const nextQuarantinedUntil = new Date(now.getTime() + reconcileIntervalMs);
            const nextPass = (claimed.reconciliationPasses || 0) + 1;

            const updateRes = await SubmissionReservation.updateOne(
              { _id: claimed._id, promotionEpoch: claimed.promotionEpoch },
              {
                $set: {
                  status: 'abandoned',
                  promotionStatus: 'tombstone',
                  reconciliationState: 'reconciled',
                  reconciliationPasses: nextPass,
                  lastReconciledAt: now,
                  quarantinedUntil: nextQuarantinedUntil,
                  stagedKeys: [],
                  promotedKeys: uncommittedPromoted,
                  promotionLeaseId: null,
                  promotionLeaseExpiresAt: null,
                  vacuumAt: null, // STRICTLY IMMUNE TO TTL
                  counterReleased: true,
                  updatedAt: now
                }
              }
            );
            if (updateRes.matchedCount > 0) {
              summary.reconciledTombstones = (summary.reconciledTombstones || 0) + 1;
            }
          } else {
            summary.failedKeysCount += failedPromoted.length + failedStaged.length;
            await SubmissionReservation.updateOne(
              { _id: claimed._id, promotionEpoch: claimed.promotionEpoch },
              {
                $set: {
                  promotedKeys: failedPromoted,
                  stagedKeys: failedStaged,
                  promotionStatus: 'failed',
                  reconciliationState: 'failed',
                  quarantinedUntil: new Date(now.getTime() + (quarantineMs === 0 ? 0 : 10000)),
                  promotionLeaseId: null,
                  promotionLeaseExpiresAt: null,
                  vacuumAt: null,
                  counterReleased: true,
                  updatedAt: new Date()
                }
              }
            );
          }
          continue;
        }

        // Staging-only cleanup (no promotedKeys)
        const keysToClean = doc.stagedKeys || [];
        const failedKeys = [];
        for (const key of keysToClean) {
          if (signal?.aborted) {
            failedKeys.push(key);
            continue;
          }
          try {
            await storageService.deleteFile(key);
          } catch (s3Err) {
            logger.warn('reservation.sweep_abandoned_s3_failed', {
              key,
              reservationId: doc._id,
              error: s3Err.message
            });
            failedKeys.push(key);
          }
        }

        if (failedKeys.length === 0) {
          await SubmissionReservation.deleteOne({ _id: doc._id, status: 'abandoned' });
          summary.purgedAbandoned += 1;
        } else {
          summary.failedKeysCount += failedKeys.length;
          await SubmissionReservation.updateOne(
            { _id: doc._id, status: 'abandoned' },
            {
              $set: {
                stagedKeys: failedKeys,
                promotedKeys: [],
                vacuumAt: null,
                counterReleased: true,
                updatedAt: new Date()
              }
            }
          );
        }
      } catch (err) {
        logger.warn('reservation.sweep_abandoned_failed', {
          reservationId: doc._id,
          error: err.message
        });
      }
    }

    return summary;
  }

  /**
   * Atomically performs durable staging cleanup for a finalized submission reservation.
   * Can be invoked immediately post-commit (fast path) or by periodic recovery (slow path).
   * Uses CAS lease fencing to guarantee mutual exclusion and protect against concurrent workers.
   *
   * @param {string} leaseId
   * @param {string|mongoose.Types.ObjectId} [formId]
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.leaseTtlMs=30000]
   * @returns {Promise<{ success: boolean, completed: boolean, purgedCount?: number, failedKeysCount?: number }>}
   */
  static async performStagingCleanup(leaseId, formId = null, options = {}) {
    const { signal, leaseTtlMs = 30000 } = options;
    if (signal?.aborted) {
      return { success: false, completed: false, reason: 'aborted' };
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs);
    const workerLeaseToken = crypto.randomUUID();

    // 1. CAS Claim: Acquire worker lease on finalized reservation requiring staging cleanup
    const claimQuery = {
      leaseId,
      status: 'finalized',
      stagingCleanupStatus: { $in: ['pending', 'cleaning', 'failed'] },
      $or: [{ stagingLeaseExpiresAt: null }, { stagingLeaseExpiresAt: { $lt: now } }]
    };
    if (formId) {
      claimQuery.formId = formId;
    }

    const claimed = await SubmissionReservation.findOneAndUpdate(
      claimQuery,
      {
        $set: {
          stagingCleanupStatus: 'cleaning',
          stagingLeaseId: workerLeaseToken,
          cleanupLeaseId: workerLeaseToken,
          stagingLeaseExpiresAt: leaseExpiresAt,
          cleanupLeaseExpiresAt: leaseExpiresAt,
          updatedAt: now
        },
        $inc: { stagingAttempts: 1, stagingEpoch: 1, cleanupEpoch: 1 }
      },
      { new: true }
    );

    if (!claimed) {
      return { success: true, completed: false, reason: 'not_claimed' };
    }

    const keysToPurge = claimed.stagingKeysToPurge?.length
      ? claimed.stagingKeysToPurge
      : claimed.stagedKeys || [];

    if (keysToPurge.length === 0) {
      // Nothing to purge, mark completed and arm vacuumAt
      await SubmissionReservation.updateOne(
        {
          _id: claimed._id,
          stagingEpoch: claimed.stagingEpoch,
          stagingLeaseId: workerLeaseToken
        },
        {
          $set: {
            stagingCleanupStatus: 'completed',
            stagedKeys: [],
            stagingKeysToPurge: [],
            stagingLeaseId: null,
            cleanupLeaseId: null,
            stagingLeaseExpiresAt: null,
            cleanupLeaseExpiresAt: null,
            stagingLastError: null,
            vacuumAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            updatedAt: new Date()
          }
        }
      );
      return { success: true, completed: true, purgedCount: 0 };
    }

    // 2. Validate and purge each staging key from S3
    const deletedKeys = [];
    const failedKeys = [];
    let lastError = null;

    for (const key of keysToPurge) {
      if (signal?.aborted) {
        failedKeys.push(key);
        continue;
      }

      // STRICT SAFETY BARRIER: Under no circumstances delete a canonical response key!
      const isSafe = isStrictStagingKey(key, claimed.formId?.toString(), claimed.leaseId);

      if (!isSafe) {
        logger.fatal('security.canonical_key_deletion_prevented', {
          formId: claimed.formId,
          leaseId: claimed.leaseId,
          corruptedKey: key
        });
        continue;
      }

      try {
        await storageService.deleteFile(key);
        deletedKeys.push(key);
      } catch (err) {
        logger.warn('reservation.staging_cleanup_s3_failed', {
          leaseId: claimed.leaseId,
          key,
          error: err.message
        });
        lastError = err;
        failedKeys.push(key);
      }
    }

    // 3. Update reservation status based on outcome
    const postCleanupNow = new Date();
    if (failedKeys.length === 0) {
      const updateRes = await SubmissionReservation.updateOne(
        {
          _id: claimed._id,
          stagingEpoch: claimed.stagingEpoch,
          stagingLeaseId: workerLeaseToken
        },
        {
          $set: {
            stagingCleanupStatus: 'completed',
            stagedKeys: [],
            stagingKeysToPurge: [],
            stagingLeaseId: null,
            cleanupLeaseId: null,
            stagingLeaseExpiresAt: null,
            cleanupLeaseExpiresAt: null,
            stagingLastError: null,
            vacuumAt: new Date(postCleanupNow.getTime() + 24 * 60 * 60 * 1000), // Arm 24h retention
            updatedAt: postCleanupNow
          }
        }
      );

      return {
        success: true,
        completed: updateRes.modifiedCount > 0,
        purgedCount: deletedKeys.length
      };
    } else {
      await SubmissionReservation.updateOne(
        {
          _id: claimed._id,
          stagingEpoch: claimed.stagingEpoch,
          stagingLeaseId: workerLeaseToken
        },
        {
          $set: {
            stagingCleanupStatus: claimed.stagingAttempts >= 10 ? 'failed' : 'pending',
            stagedKeys: failedKeys,
            stagingKeysToPurge: failedKeys,
            stagingLeaseId: null,
            cleanupLeaseId: null,
            stagingLeaseExpiresAt: null,
            cleanupLeaseExpiresAt: null,
            stagingLastError: lastError?.message || 'S3 delete failed',
            vacuumAt: null, // IMMUNE TO TTL: preserve record until clean!
            updatedAt: postCleanupNow
          }
        }
      );

      return {
        success: false,
        completed: false,
        purgedCount: deletedKeys.length,
        failedKeysCount: failedKeys.length
      };
    }
  }

  /**
   * Alias for performStagingCleanup.
   */
  static async executeStagingCleanup(leaseId, formId = null, options = {}) {
    return this.performStagingCleanup(leaseId, formId, options);
  }

  /**
   * Sweeps finalized submission reservations with pending or failed staging cleanups on live forms.
   *
   * @param {object} [options]
   * @param {number} [options.batchSize=50]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ completedCount: number, purgedCount: number, failedCount: number }>}
   */
  static async sweepFinalizedStagingCleanups(options = {}) {
    const { batchSize = 50, signal } = options;
    const summary = { completedCount: 0, purgedCount: 0, failedCount: 0 };

    if (signal?.aborted) {
      return summary;
    }

    const now = new Date();
    const pendingJobs = await SubmissionReservation.find({
      status: 'finalized',
      stagingCleanupStatus: { $in: ['pending', 'cleaning', 'failed'] },
      $or: [{ stagingLeaseExpiresAt: null }, { stagingLeaseExpiresAt: { $lt: now } }]
    })
      .limit(batchSize)
      .lean();

    for (const job of pendingJobs) {
      if (signal?.aborted) break;
      try {
        const res = await this.performStagingCleanup(job.leaseId, job.formId, { signal });
        if (res.completed) {
          summary.completedCount += 1;
          summary.purgedCount += res.purgedCount || 0;
        } else if (res.failedKeysCount > 0) {
          summary.failedCount += 1;
        }
      } catch (err) {
        summary.failedCount += 1;
        logger.warn('reservation.sweep_staging_cleanup_failed', {
          leaseId: job.leaseId,
          error: err.message
        });
      }
    }

    return summary;
  }

  /**
   * Alias for sweepFinalizedStagingCleanups.
   */
  static async sweepPendingStagingCleanups(options = {}) {
    return this.sweepFinalizedStagingCleanups(options);
  }

  /**
   * Count active or committing, unexpired submissions for a form.
   *
   * @param {string|mongoose.Types.ObjectId} formId
   * @returns {Promise<number>}
   */
  static async countActive(formId) {
    const now = new Date();
    return await SubmissionReservation.countDocuments({
      formId,
      status: { $in: ['active', 'committing'] },
      expiresAt: { $gt: now }
    });
  }

  /**
   * Bounded drain polling loop for active or committing submissions.
   *
   * @param {string|mongoose.Types.ObjectId} formId
   * @param {number} [drainWaitMs=1000]
   * @returns {Promise<{ remainingCount: number, maxExpiry: number }>}
   */
  static async drainActive(formId, drainWaitMs = 1000) {
    const start = Date.now();
    let activeRecords = await SubmissionReservation.find({
      formId,
      status: { $in: ['active', 'committing'] },
      expiresAt: { $gt: new Date() }
    }).lean();

    while (activeRecords.length > 0 && Date.now() - start < drainWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      activeRecords = await SubmissionReservation.find({
        formId,
        status: { $in: ['active', 'committing'] },
        expiresAt: { $gt: new Date() }
      }).lean();
    }

    const maxExpiry =
      activeRecords.length > 0
        ? Math.max(...activeRecords.map((r) => new Date(r.expiresAt).getTime()))
        : Date.now();

    return {
      remainingCount: activeRecords.length,
      maxExpiry
    };
  }
}

export default SubmissionReservationManager;
