/**
 * StorageService
 *
 * Primary application-facing abstraction layer for file storage operations.
 * Implements write-ahead StorageJournal tracking for all mutating actions
 * (PutObject, CopyObject, DeleteObject, DeleteObjects) to guarantee
 * transactional consistency and crash-recovery convergence.
 */

import crypto from 'crypto';
import { Transform } from 'node:stream';
import mongoose from 'mongoose';
import s3Provider from './S3StorageProvider.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import { trackStorageOperation } from '../middleware/quiescenceGate.js';
import { logger } from '../utils/logger.js';
import { uploadAdmissionService } from './uploadAdmissionService.js';

export const DEFAULT_MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * High-performance, constant-memory pass-through hashing and byte-counting transform.
 * Inspects every chunk in transit, updates SHA-256 state and byte count, enforces internal
 * size limits, and immediately forwards chunks downstream without retaining references.
 */
export class HashingByteCounterTransform extends Transform {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBytes=Infinity] - Maximum allowed byte threshold
   * @param {string} [options.algorithm='sha256'] - Cryptographic hash algorithm
   * @param {import('node:stream').TransformOptions} [options.streamOptions]
   */
  constructor(options = {}) {
    const { maxBytes = Infinity, algorithm = 'sha256', ...streamOptions } = options;
    super({
      ...streamOptions,
      highWaterMark: streamOptions.highWaterMark ?? 64 * 1024
    });

    this.hasher = crypto.createHash(algorithm);
    this.bytesCounted = 0;
    this.maxBytes = maxBytes;
    this.digestHex = null;
    this.completed = false;
  }

  /**
   * Synchronously hashes and counts incoming chunks before forwarding.
   */
  _transform(chunk, encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    const newTotal = this.bytesCounted + buf.length;

    // Fail-closed byte ceiling enforcement
    if (newTotal > this.maxBytes) {
      const err = new Error(`File size exceeds maximum limit of ${this.maxBytes} bytes`);
      err.code = 'LIMIT_FILE_SIZE';
      err.status = 413;
      err.statusCode = 413;
      err.bytesCounted = newTotal;
      err.maxBytes = this.maxBytes;
      return callback(err);
    }

    this.bytesCounted = newTotal;
    this.hasher.update(buf);

    // Pass chunk immediately to downstream consumer; local reference 'buf' falls out of scope
    callback(null, buf);
  }

  /**
   * Finalizes the cryptographic digest upon stream exhaustion.
   */
  _flush(callback) {
    if (!this.digestHex) {
      this.digestHex = this.hasher.digest('hex');
    }
    this.completed = true;
    callback();
  }

  get payloadSize() {
    return this.bytesCounted;
  }

  get payloadHash() {
    return this.digestHex;
  }

  /**
   * Retrieve the final computed metadata. Throws if called before stream completion.
   */
  getMetadata() {
    if (!this.completed || !this.digestHex) {
      throw new Error('Streaming metadata cannot be read before stream finalization');
    }
    return {
      payloadSize: this.bytesCounted,
      payloadHash: this.digestHex
    };
  }
}

/**
 * Bridges source stream, hashing transform, and S3 PutObjectCommand execution.
 * Synchronizes error propagation and abort signals to prevent resource leaks.
 */
export async function executeStreamUpload({
  sourceStream,
  transform,
  uploadFn,
  parentSignal
}) {
  const uploadAbortController = new AbortController();
  const linkedSignal = uploadAbortController.signal;

  let parentCleanup = () => {};
  if (parentSignal) {
    if (parentSignal.aborted) {
      uploadAbortController.abort(parentSignal.reason);
    } else {
      const onParentAbort = () => uploadAbortController.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
      parentCleanup = () => parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  const destroyAll = (err) => {
    if (sourceStream && typeof sourceStream.destroy === 'function' && !sourceStream.destroyed) {
      sourceStream.destroy(err);
    }
    if (transform && typeof transform.destroy === 'function' && !transform.destroyed) {
      transform.destroy(err);
    }
  };

  transform.once('error', (err) => {
    uploadAbortController.abort(err);
    if (sourceStream && typeof sourceStream.destroy === 'function' && !sourceStream.destroyed) {
      sourceStream.destroy(err);
    }
  });

  if (sourceStream && typeof sourceStream.once === 'function') {
    sourceStream.once('error', (err) => {
      uploadAbortController.abort(err);
      if (transform && typeof transform.destroy === 'function' && !transform.destroyed) {
        transform.destroy(err);
      }
    });
    sourceStream.pipe(transform);
  }

  try {
    const result = await uploadFn(transform, linkedSignal);
    return result;
  } catch (err) {
    destroyAll(err);
    throw err;
  } finally {
    parentCleanup();
    destroyAll();
  }
}

export const normalizePayload = async (filePayload) => {
  if (Buffer.isBuffer(filePayload)) {
    const payloadSize = filePayload.length;
    const payloadHash = crypto.createHash('sha256').update(filePayload).digest('hex');
    return { buffer: filePayload, payloadSize, payloadHash };
  }

  if (filePayload && typeof filePayload.pipe === 'function') {
    const transform = new HashingByteCounterTransform();
    const chunks = [];
    await new Promise((resolve, reject) => {
      filePayload.on('error', reject);
      transform.on('error', reject);
      transform.on('data', (chunk) => chunks.push(chunk));
      transform.on('end', resolve);
      filePayload.pipe(transform);
    });
    const buffer = Buffer.concat(chunks);
    return { buffer, payloadSize: transform.payloadSize, payloadHash: transform.payloadHash };
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

/**
 * Enforces the application storage mutation barrier when backup quiescence is active.
 *
 * @param {object} [options={}]
 */
export const assertStorageMutationAllowed = async (options = {}) => {
  if (options && options.bypassQuiescenceBarrier === true) return;
  try {
    const { isQuiescenceActive, isMutationAdmissionClosed } =
      await import('../middleware/quiescenceGate.js');
    if (typeof isMutationAdmissionClosed === 'function' && isMutationAdmissionClosed()) {
      const err = new Error('Storage mutation rejected: mutation admission is closed');
      err.code = 'MUTATION_ADMISSION_CLOSED';
      err.status = 503;
      err.statusCode = 503;
      throw err;
    }

    const { isInstanceLeaseValid } = await import('./instanceLeaseService.js');
    if (typeof isInstanceLeaseValid === 'function' && !isInstanceLeaseValid()) {
      const err = new Error('Storage mutation rejected: instance deployment lease is invalid');
      err.code = 'INSTANCE_FENCED';
      err.status = 503;
      err.statusCode = 503;
      throw err;
    }

    if (await isQuiescenceActive()) {
      const err = new Error('Storage mutation rejected: backup quiescence is active');
      err.code = 'BACKUP_QUIESCENCE_ACTIVE';
      err.status = 503;
      err.statusCode = 503;
      throw err;
    }
  } catch (err) {
    if (
      err.code === 'BACKUP_QUIESCENCE_ACTIVE' ||
      err.code === 'MUTATION_ADMISSION_CLOSED' ||
      err.code === 'INSTANCE_FENCED'
    ) {
      throw err;
    }
  }
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
    await assertStorageMutationAllowed(options);

    const existingPermit = options.admissionPermit;
    const hasCallerPermit =
      existingPermit &&
      typeof existingPermit.release === 'function' &&
      !existingPermit.isReleased;

    const executeUpload = async () => {
      return trackStorageOperation(
        async () => {
        const operationId = options.operationId || crypto.randomUUID();
        const shouldJournal = options.journal !== false && isJournalingActive();
        const bucket = resolveBucketName();
        const maxBytes = options.maxSizeBytes || options.maxUploadFileSize || DEFAULT_MAX_UPLOAD_SIZE;

        const isStream = fileBuffer && typeof fileBuffer.pipe === 'function';
        let initialPayloadSize = null;
        let initialPayloadHash = null;
        let bufferToUpload = null;
        let streamTransform = null;

        if (Buffer.isBuffer(fileBuffer)) {
          if (fileBuffer.length > maxBytes) {
            const err = new Error(`File size exceeds maximum limit of ${maxBytes} bytes`);
            err.code = 'LIMIT_FILE_SIZE';
            err.status = 413;
            err.statusCode = 413;
            throw err;
          }
          bufferToUpload = fileBuffer;
          initialPayloadSize = fileBuffer.length;
          initialPayloadHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        } else if (typeof fileBuffer === 'string') {
          const buf = Buffer.from(fileBuffer, 'utf8');
          if (buf.length > maxBytes) {
            const err = new Error(`File size exceeds maximum limit of ${maxBytes} bytes`);
            err.code = 'LIMIT_FILE_SIZE';
            err.status = 413;
            err.statusCode = 413;
            throw err;
          }
          bufferToUpload = buf;
          initialPayloadSize = buf.length;
          initialPayloadHash = crypto.createHash('sha256').update(buf).digest('hex');
        } else if (isStream) {
          streamTransform = new HashingByteCounterTransform({ maxBytes });
        } else {
          throw new TypeError('Invalid file payload: Expected Buffer, Stream, or String');
        }

        if (shouldJournal) {
          // Step 1: Persist write-ahead journal record outside business session
          await StorageJournal.create(
            [
              {
                operationId,
                type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
                bucket,
                destinationKey: path,
                formId: options.formId || null,
                reservationLeaseId: options.reservationLeaseId || null,
                status: STORAGE_JOURNAL_STATUS.DISPATCHED,
                payloadSize: initialPayloadSize,
                payloadHash: initialPayloadHash,
                mimeType,
                quarantinedUntil: null
              }
            ],
            { session: null }
          );
        }

        let s3Result;
        try {
          // Step 2: Dispatch remote S3 command with bounded timeout & metadata
          const s3Options = {
            ...options,
            metadata: {
              'operation-id': operationId,
              ...(initialPayloadHash ? { 'payload-hash': initialPayloadHash } : {})
            },
            returnMetadata: true
          };

          if (isStream) {
            s3Result = await executeStreamUpload({
              sourceStream: fileBuffer,
              transform: streamTransform,
              uploadFn: (streamPayload, linkedSignal) =>
                s3Provider.uploadFile(streamPayload, path, mimeType, {
                  ...s3Options,
                  abortSignal: linkedSignal
                }),
              parentSignal: options.abortSignal || options.signal
            });
          } else {
            s3Result = await s3Provider.uploadFile(bufferToUpload, path, mimeType, s3Options);
          }
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
          typeof s3Result === 'object' && s3Result !== null ? (s3Result.key || s3Result.Key || path) : s3Result || path;

        const finalPayloadSize = isStream ? streamTransform.payloadSize : initialPayloadSize;
        const finalPayloadHash = isStream ? streamTransform.payloadHash : initialPayloadHash;

        // Step 4: Optional post-write object verification
        if (options.verifyObject) {
          const head = await s3Provider.headObject(path, {
            timeoutMs: options.timeoutMs,
            signal: options.signal || options.abortSignal
          });
          if (!head || head.contentLength !== finalPayloadSize) {
            const verifyErr = new Error(
              `Object size verification failed: expected ${finalPayloadSize}, got ${head?.contentLength}`
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
                  etag: etag || null,
                  payloadSize: finalPayloadSize,
                  payloadHash: finalPayloadHash
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

        if (options.returnMetadata) {
          return {
            key: returnKey,
            payloadSize: finalPayloadSize,
            payloadHash: finalPayloadHash,
            etag: etag || null
          };
        }

        return returnKey;
      },
      { name: 'StorageService.uploadFile', destinationKey: path }
    );
    };

    if (hasCallerPermit) {
      return executeUpload();
    } else {
      return uploadAdmissionService.withPermit(
        {
          signal: options.abortSignal || options.signal,
          timeoutMs: options.timeoutMs,
          metadata: { path, mimeType, formId: options.formId }
        },
        () => executeUpload()
      );
    }
  }

  /**
   * Copy an object within storage with journal tracking.
   */
  async copyFile(sourceKey, destinationKey, options = {}) {
    await assertStorageMutationAllowed(options);
    return trackStorageOperation(
      async () => {
        const operationId = options.operationId || crypto.randomUUID();
        const shouldJournal = options.journal !== false && isJournalingActive();
        const bucket = resolveBucketName();
        const payloadSize = typeof options.payloadSize === 'number' ? options.payloadSize : null;
        const payloadHash = options.payloadHash || null;

        if (shouldJournal) {
          await StorageJournal.create(
            [
              {
                operationId,
                type: STORAGE_OPERATION_TYPE.COPY_OBJECT,
                bucket,
                sourceKey,
                destinationKey,
                payloadSize,
                payloadHash,
                formId: options.formId || null,
                responseId: options.responseId || null,
                reservationLeaseId: options.reservationLeaseId || null,
                status: STORAGE_JOURNAL_STATUS.DISPATCHED
              }
            ],
            { session: null }
          );
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
            const confRes = await StorageJournal.updateOne(
              { operationId },
              {
                $set: {
                  status: STORAGE_JOURNAL_STATUS.CONFIRMED,
                  etag: etag || null
                }
              }
            );
            if (confRes.matchedCount === 0) {
              throw new Error(`StorageJournal operation ${operationId} not found to confirm`);
            }
          } catch (journalErr) {
            logger.error('storage.journal_copy_confirmed_failed', {
              operationId,
              error: journalErr.message
            });
            throw journalErr;
          }
        }

        return returnKey;
      },
      { name: 'StorageService.copyFile', sourceKey, destinationKey }
    );
  }

  /**
   * Delete a file from storage with journal tracking.
   */
  async deleteFile(path, options = {}) {
    await assertStorageMutationAllowed(options);
    return trackStorageOperation(
      async () => {
        const operationId = options.operationId || crypto.randomUUID();
        const shouldJournal = options.journal !== false && isJournalingActive();
        const bucket = resolveBucketName();

        if (shouldJournal) {
          await StorageJournal.create(
            [
              {
                operationId,
                type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
                bucket,
                destinationKey: path,
                formId: options.formId || null,
                reservationLeaseId: options.reservationLeaseId || null,
                status: STORAGE_JOURNAL_STATUS.DISPATCHED
              }
            ],
            { session: null }
          );
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
                  status: STORAGE_JOURNAL_STATUS.CONFIRMED,
                  vacuumAt: new Date(Date.now() + 7 * 24 * 3600 * 1000)
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
      },
      { name: 'StorageService.deleteFile', destinationKey: path }
    );
  }

  /**
   * Delete multiple files from storage with batch journal tracking.
   */
  async deleteFiles(paths, options = {}) {
    await assertStorageMutationAllowed(options);
    return trackStorageOperation(
      async () => {
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
            const confirmedOpIds = result.deletedKeys.map((k) => batchMap.get(k)).filter(Boolean);
            if (confirmedOpIds.length > 0) {
              try {
                await StorageJournal.updateMany(
                  { operationId: { $in: confirmedOpIds } },
                  {
                    $set: {
                      status: STORAGE_JOURNAL_STATUS.CONFIRMED,
                      vacuumAt: new Date(Date.now() + 7 * 24 * 3600 * 1000)
                    }
                  }
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
      },
      { name: 'StorageService.deleteFiles', paths }
    );
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
