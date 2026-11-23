/**
 * StorageService
 *
 * Primary application-facing abstraction layer for file storage operations.
 * Implements write-ahead StorageJournal tracking for all mutating actions
 * (PutObject, CopyObject, DeleteObject, DeleteObjects) to guarantee
 * transactional consistency and crash-recovery convergence.
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import s3Provider from './S3StorageProvider.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import { logger } from '../utils/logger.js';

export const normalizePayload = async (filePayload) => {
  if (Buffer.isBuffer(filePayload)) {
    const payloadSize = filePayload.length;
    const payloadHash = crypto.createHash('sha256').update(filePayload).digest('hex');
    return { buffer: filePayload, payloadSize, payloadHash };
  }

  if (filePayload && typeof filePayload.pipe === 'function') {
    const chunks = [];
    const hash = crypto.createHash('sha256');
    let payloadSize = 0;

    for await (const chunk of filePayload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      hash.update(buf);
      payloadSize += buf.length;
    }

    const buffer = Buffer.concat(chunks);
    const payloadHash = hash.digest('hex');
    return { buffer, payloadSize, payloadHash };
  }

  if (typeof filePayload === 'string') {
    const buffer = Buffer.from(filePayload, 'utf8');
    const payloadSize = buffer.length;
    const payloadHash = crypto.createHash('sha256').update(buffer).digest('hex');
    return { buffer, payloadSize, payloadHash };
  }

  throw new TypeError('Invalid file payload: Expected Buffer, Stream, or String');
};

const isJournalingActive = () => {
  return Boolean(mongoose.connection && mongoose.connection.readyState === 1);
};

const resolveBucketName = () => {
  return s3Provider.bucket || process.env.S3_BUCKET || 'paperless-storage';
};

class StorageService {
  /**
   * Upload a file to storage with write-ahead journal persistence and cryptographic validation.
   *
   * @param {Buffer|Readable} fileBuffer - The file buffer or stream
   * @param {string} path - Destination S3 key
   * @param {string} mimeType - MIME type
   * @param {object} [options]
   * @param {string} [options.operationId] - Deterministic journal operation UUID
   * @param {string} [options.formId] - Associated Form ID
   * @param {string} [options.reservationLeaseId] - Associated lease ID
   * @param {number} [options.timeoutMs] - Remote command timeout
   * @param {AbortSignal} [options.abortSignal] - Client cancellation signal
   * @param {AbortSignal} [options.signal] - Signal alias
   * @param {number} [options.quarantineMs=40000] - Cooling-off duration on ambiguity
   * @param {boolean} [options.journal=true] - Explicit journal enablement
   * @param {boolean} [options.verifyObject=false] - Issue post-upload HeadObject probe
   * @returns {Promise<string>} The destination S3 key
   */
  async uploadFile(fileBuffer, path, mimeType, options = {}) {
    const { buffer, payloadSize, payloadHash } = await normalizePayload(fileBuffer);
    const operationId = options.operationId || crypto.randomUUID();
    const shouldJournal = options.journal !== false && isJournalingActive();
    const bucket = resolveBucketName();

    if (shouldJournal) {
      // Step 1: Persist write-ahead journal record outside business session
      await StorageJournal.create([
        {
          operationId,
          type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
          bucket,
          destinationKey: path,
          formId: options.formId || null,
          reservationLeaseId: options.reservationLeaseId || null,
          status: STORAGE_JOURNAL_STATUS.DISPATCHED,
          payloadSize,
          payloadHash,
          mimeType,
          quarantinedUntil: null
        }
      ], { session: null });
    }

    let s3Result;
    try {
      // Step 2: Dispatch remote S3 command with bounded timeout & metadata
      s3Result = await s3Provider.uploadFile(buffer, path, mimeType, {
        ...options,
        metadata: {
          'operation-id': operationId,
          'payload-hash': payloadHash
        },
        returnMetadata: true
      });
    } catch (err) {
      // Step 3: Handle ambiguous outcome (never treat abort as proof of non-write)
      if (shouldJournal) {
        const quarantineMs = options.quarantineMs || 40000;
        const quarantinedUntil = new Date(Date.now() + quarantineMs);
        try {
          await StorageJournal.updateOne(
            { operationId },
            {
              $set: {
                status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
                quarantinedUntil,
                errorDetails: `${err.name || 'Error'}: ${err.message}`
              }
            }
          );
        } catch (journalErr) {
          logger.error('storage.journal_update_ambiguous_failed', {
            operationId,
            error: journalErr.message
          });
        }
      }
      throw err;
    }

    const etag = typeof s3Result === 'object' && s3Result !== null ? s3Result.etag : null;
    const returnKey =
      typeof s3Result === 'object' && s3Result !== null
        ? s3Result.key
        : s3Result || path;

    // Step 4: Optional post-write object verification
    if (options.verifyObject) {
      const head = await s3Provider.headObject(path, {
        timeoutMs: options.timeoutMs,
        signal: options.signal || options.abortSignal
      });
      if (!head || head.contentLength !== payloadSize) {
        const verifyErr = new Error(
          `Object size verification failed: expected ${payloadSize}, got ${head?.contentLength}`
        );
        if (shouldJournal) {
          await StorageJournal.updateOne(
            { operationId },
            {
              $set: {
                status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
                quarantinedUntil: new Date(Date.now() + 40000),
                errorDetails: verifyErr.message
              }
            }
          );
        }
        throw verifyErr;
      }
    }

    // Step 5: Mark confirmed upon verified remote completion
    if (shouldJournal) {
      try {
        await StorageJournal.updateOne(
          { operationId },
          {
            $set: {
              status: STORAGE_JOURNAL_STATUS.CONFIRMED,
              etag: etag || null
            }
          }
        );
      } catch (journalErr) {
        logger.warn('storage.journal_update_confirmed_failed', {
          operationId,
          error: journalErr.message
        });
      }
    }

    return returnKey;
  }

  /**
   * Copy an object within storage with journal tracking.
   */
  async copyFile(sourceKey, destinationKey, options = {}) {
    const operationId = options.operationId || crypto.randomUUID();
    const shouldJournal = options.journal !== false && isJournalingActive();
    const bucket = resolveBucketName();

    if (shouldJournal) {
      await StorageJournal.create([
        {
          operationId,
          type: STORAGE_OPERATION_TYPE.COPY_OBJECT,
          bucket,
          sourceKey,
          destinationKey,
          formId: options.formId || null,
          reservationLeaseId: options.reservationLeaseId || null,
          status: STORAGE_JOURNAL_STATUS.DISPATCHED
        }
      ], { session: null });
    }

    let s3Result;
    try {
      s3Result = await s3Provider.copyFile(sourceKey, destinationKey, {
        ...options,
        returnMetadata: true
      });
    } catch (err) {
      if (shouldJournal) {
        const quarantineMs = options.quarantineMs || 40000;
        try {
          await StorageJournal.updateOne(
            { operationId },
            {
              $set: {
                status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
                quarantinedUntil: new Date(Date.now() + quarantineMs),
                errorDetails: `${err.name || 'Error'}: ${err.message}`
              }
            }
          );
        } catch (journalErr) {
          logger.error('storage.journal_copy_ambiguous_failed', {
            operationId,
            error: journalErr.message
          });
        }
      }
      throw err;
    }

    const etag = typeof s3Result === 'object' && s3Result !== null ? s3Result.etag : null;
    const returnKey =
      typeof s3Result === 'object' && s3Result !== null
        ? s3Result.key
        : s3Result || destinationKey;

    if (shouldJournal) {
      try {
        await StorageJournal.updateOne(
          { operationId },
          {
            $set: {
              status: STORAGE_JOURNAL_STATUS.CONFIRMED,
              etag: etag || null
            }
          }
        );
      } catch (journalErr) {
        logger.warn('storage.journal_copy_confirmed_failed', {
          operationId,
          error: journalErr.message
        });
      }
    }

    return returnKey;
  }

  /**
   * Delete a file from storage with journal tracking.
   */
  async deleteFile(path, options = {}) {
    const operationId = options.operationId || crypto.randomUUID();
    const shouldJournal = options.journal !== false && isJournalingActive();
    const bucket = resolveBucketName();

    if (shouldJournal) {
      await StorageJournal.create([
        {
          operationId,
          type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
          bucket,
          destinationKey: path,
          formId: options.formId || null,
          reservationLeaseId: options.reservationLeaseId || null,
          status: STORAGE_JOURNAL_STATUS.DISPATCHED
        }
      ], { session: null });
    }

    try {
      await s3Provider.deleteFile(path, options);
    } catch (err) {
      if (shouldJournal) {
        const quarantineMs = options.quarantineMs || 40000;
        try {
          await StorageJournal.updateOne(
            { operationId },
            {
              $set: {
                status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
                quarantinedUntil: new Date(Date.now() + quarantineMs),
                errorDetails: `${err.name || 'Error'}: ${err.message}`
              }
            }
          );
        } catch (journalErr) {
          logger.error('storage.journal_delete_ambiguous_failed', {
            operationId,
            error: journalErr.message
          });
        }
      }
      throw err;
    }

    if (shouldJournal) {
      try {
        await StorageJournal.updateOne(
          { operationId },
          {
            $set: {
              status: STORAGE_JOURNAL_STATUS.CONFIRMED
            }
          }
        );
      } catch (journalErr) {
        logger.warn('storage.journal_delete_confirmed_failed', {
          operationId,
          error: journalErr.message
        });
      }
    }
  }

  /**
   * Delete multiple files from storage with batch journal tracking.
   */
  async deleteFiles(paths, options = {}) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { success: true, deletedKeys: [], failedKeys: [], totalRequested: 0 };
    }

    const sanitizedKeys = Array.from(
      new Set(
        paths
          .filter((k) => typeof k === 'string')
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      )
    );

    if (sanitizedKeys.length === 0) {
      return { success: true, deletedKeys: [], failedKeys: [], totalRequested: 0 };
    }

    const shouldJournal = options.journal !== false && isJournalingActive();
    const bucket = resolveBucketName();
    const batchMap = new Map();

    if (shouldJournal) {
      const records = sanitizedKeys.map((key) => {
        const opId = crypto.randomUUID();
        batchMap.set(key, opId);
        return {
          operationId: opId,
          type: STORAGE_OPERATION_TYPE.DELETE_OBJECTS,
          bucket,
          destinationKey: key,
          formId: options.formId || null,
          status: STORAGE_JOURNAL_STATUS.DISPATCHED
        };
      });
      try {
        await StorageJournal.insertMany(records, { ordered: false });
      } catch (insertErr) {
        logger.error('storage.journal_batch_insert_failed', { error: insertErr.message });
      }
    }

    let result;
    try {
      result = await s3Provider.deleteFiles(sanitizedKeys, options);
    } catch (batchErr) {
      if (shouldJournal) {
        const opIds = Array.from(batchMap.values());
        try {
          await StorageJournal.updateMany(
            { operationId: { $in: opIds }, status: STORAGE_JOURNAL_STATUS.DISPATCHED },
            {
              $set: {
                status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
                quarantinedUntil: new Date(Date.now() + 40000),
                errorDetails: batchErr.message
              }
            }
          );
        } catch (jErr) {
          logger.error('storage.journal_batch_ambiguous_failed', { error: jErr.message });
        }
      }
      throw batchErr;
    }

    if (shouldJournal) {
      // 1. Confirm successful deletions
      if (result.deletedKeys && result.deletedKeys.length > 0) {
        const confirmedOpIds = result.deletedKeys
          .map((k) => batchMap.get(k))
          .filter(Boolean);
        if (confirmedOpIds.length > 0) {
          try {
            await StorageJournal.updateMany(
              { operationId: { $in: confirmedOpIds } },
              { $set: { status: STORAGE_JOURNAL_STATUS.CONFIRMED } }
            );
          } catch (jErr) {
            logger.warn('storage.journal_batch_confirm_failed', { error: jErr.message });
          }
        }
      }

      // 2. Mark individual failed keys as ambiguous with error details
      if (result.failedKeys && result.failedKeys.length > 0) {
        for (const failure of result.failedKeys) {
          const opId = batchMap.get(failure.key);
          if (opId) {
            try {
              await StorageJournal.updateOne(
                { operationId: opId },
                {
                  $set: {
                    status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
                    quarantinedUntil: new Date(Date.now() + 40000),
                    errorDetails: failure.error || 'Batch deletion failure'
                  }
                }
              );
            } catch (jErr) {
              logger.warn('storage.journal_batch_key_fail_record_failed', {
                key: failure.key,
                error: jErr.message
              });
            }
          }
        }
      }
    }

    return result;
  }

  async getPresignedUrl(path) {
    return s3Provider.getPresignedUrl(path);
  }

  async getFileStream(path, options = {}) {
    return s3Provider.getFileStream(path, options);
  }

  async headObject(path, options = {}) {
    return s3Provider.headObject(path, options);
  }

  async listObjectsByPrefix(prefix, options = {}) {
    return s3Provider.listObjectsByPrefix(prefix, options);
  }

  async checkBucketAccess(timeoutMs = 3000) {
    return s3Provider.checkBucketAccess(timeoutMs);
  }

  async destroy() {
    return s3Provider.destroy();
  }
}

export default new StorageService();
