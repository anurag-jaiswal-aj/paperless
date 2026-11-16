import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  CopyObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { logger } from '../utils/logger.js';

export const S3_DEFAULT_TIMEOUTS = {
  UPLOAD_TIMEOUT_MS: parseInt(process.env.S3_UPLOAD_TIMEOUT_MS, 10) || 30000,
  DELETE_TIMEOUT_MS: parseInt(process.env.S3_DELETE_TIMEOUT_MS, 10) || 15000,
  GET_TIMEOUT_MS: parseInt(process.env.S3_GET_TIMEOUT_MS, 10) || 30000
};

export const createCancelableTimeoutSignal = (timeoutMs, parentSignal) => {
  const controller = new AbortController();
  const id = setTimeout(() => {
    const err = new Error(`S3 command acquisition timed out after ${timeoutMs}ms`);
    err.name = 'TimeoutError';
    controller.abort(err);
  }, timeoutMs);

  let removeParentListener = null;
  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(id);
      controller.abort(parentSignal.reason);
    } else {
      const onParentAbort = () => {
        clearTimeout(id);
        controller.abort(parentSignal.reason);
      };
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
      removeParentListener = () => parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  const cleanup = () => {
    clearTimeout(id);
    if (removeParentListener) {
      removeParentListener();
    }
  };

  return { signal: controller.signal, cleanup };
};

export const createTimeoutSignal = (timeoutMs, parentSignal) =>
  createCancelableTimeoutSignal(timeoutMs, parentSignal);

class S3StorageProvider {
  constructor() {
    this.init();
  }

  init() {
    this.region = process.env.S3_REGION;
    this.bucket = process.env.S3_BUCKET;
    this.accessKeyId = process.env.S3_ACCESS_KEY_ID;
    this.secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    this.endpoint = process.env.S3_ENDPOINT;

    const hasCredentials = Boolean(
      this.region && this.bucket && this.accessKeyId && this.secretAccessKey
    );
    const env = process.env.NODE_ENV;
    const isProductionOrStaging = env === 'production' || env === 'staging';

    if (hasCredentials) {
      this.client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey
        },
        ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {})
      });
      this.isMock = false;
      this.initError = null;
    } else {
      this.client = null;
      if (isProductionOrStaging) {
        this.isMock = false;
        this.initError = new Error(
          `S3 storage failed to initialize: Missing credentials/config in ${env} environment`
        );
        logger.error('storage.s3_init_failed', { error: this.initError.message, env });
      } else {
        // Explicit mock mode only permitted in development and test environments
        this.isMock = true;
        this.initError = null;
        logger.debug('storage.s3_mock_fallback', {
          message: 'S3 Storage missing credentials in dev. Using mock fallback.'
        });
      }
    }
  }

  async uploadFile(fileBuffer, path, mimeType, options = {}) {
    if (!this.client) {
      if (this.isMock) {
        logger.debug('storage.s3_mock_upload', { path, mimeType });
        if (fileBuffer && typeof fileBuffer.destroy === 'function') {
          fileBuffer.destroy();
        }
        return `mock-s3-url/${path}`;
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const timeoutMs = options.timeoutMs || S3_DEFAULT_TIMEOUTS.UPLOAD_TIMEOUT_MS;
    const parentSignal = options.abortSignal || options.signal;
    const { signal, cleanup } = createTimeoutSignal(timeoutMs, parentSignal);

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: fileBuffer,
        ContentType: mimeType
      });

      await this.client.send(command, { abortSignal: signal });
      // Return key, we don't expose public URLs directly.
      return path;
    } finally {
      cleanup();
    }
  }

  async deleteFile(path, options = {}) {
    if (!this.client) {
      if (this.isMock) {
        logger.debug('storage.s3_mock_delete', { path });
        return;
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const timeoutMs = options.timeoutMs || S3_DEFAULT_TIMEOUTS.DELETE_TIMEOUT_MS;
    const parentSignal = options.abortSignal || options.signal;
    const { signal, cleanup } = createTimeoutSignal(timeoutMs, parentSignal);

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: path
      });

      await this.client.send(command, { abortSignal: signal });
    } finally {
      cleanup();
    }
  }

  /**
   * Delete multiple files/objects from storage in bounded batches of up to 1,000 keys.
   *
   * @param {string[]} keys - Array of S3 keys to delete
   * @param {object} [options] - Optional configurations
   * @param {number} [options.timeoutMs] - Timeout per batch chunk
   * @param {AbortSignal} [options.abortSignal] - Optional cancellation signal
   * @param {AbortSignal} [options.signal] - Alias for abortSignal
   * @returns {Promise<{
   *   success: boolean,
   *   deletedKeys: string[],
   *   failedKeys: Array<{ key: string, error: string, code?: string }>,
   *   totalRequested: number
   * }>}
   */
  async deleteFiles(keys, options = {}) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return {
        success: true,
        deletedKeys: [],
        failedKeys: [],
        totalRequested: 0
      };
    }

    // Deduplicate and filter non-string / blank keys
    const sanitizedKeys = Array.from(
      new Set(
        keys
          .filter((k) => typeof k === 'string')
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      )
    );

    if (sanitizedKeys.length === 0) {
      return {
        success: true,
        deletedKeys: [],
        failedKeys: [],
        totalRequested: 0
      };
    }

    if (!this.client) {
      if (this.isMock) {
        logger.debug('storage.s3_mock_delete_batch', { count: sanitizedKeys.length });
        return {
          success: true,
          deletedKeys: sanitizedKeys,
          failedKeys: [],
          totalRequested: sanitizedKeys.length
        };
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const timeoutMs = options.timeoutMs || S3_DEFAULT_TIMEOUTS.DELETE_TIMEOUT_MS;
    const parentSignal = options.abortSignal || options.signal;
    const CHUNK_SIZE = 1000;
    const deletedKeys = [];
    const failedKeys = [];

    for (let i = 0; i < sanitizedKeys.length; i += CHUNK_SIZE) {
      if (parentSignal?.aborted) {
        const remainingKeys = sanitizedKeys.slice(i);
        const abortCode =
          parentSignal.reason?.name && parentSignal.reason.name !== 'Error'
            ? parentSignal.reason.name
            : 'AbortError';
        for (const key of remainingKeys) {
          failedKeys.push({
            key,
            error: parentSignal.reason?.message || 'Delete operation aborted',
            code: abortCode
          });
        }
        break;
      }

      const chunk = sanitizedKeys.slice(i, i + CHUNK_SIZE);
      const { signal, cleanup } = createTimeoutSignal(timeoutMs, parentSignal);

      try {
        const command = new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: chunk.map((key) => ({ Key: key })),
            Quiet: false
          }
        });

        const response = await this.client.send(command, { abortSignal: signal });

        const chunkDeleted = new Set();
        if (Array.isArray(response?.Deleted)) {
          for (const item of response.Deleted) {
            if (item.Key) {
              deletedKeys.push(item.Key);
              chunkDeleted.add(item.Key);
            }
          }
        }

        const chunkFailed = new Set();
        if (Array.isArray(response?.Errors) && response.Errors.length > 0) {
          for (const err of response.Errors) {
            const key = err.Key || 'unknown';
            failedKeys.push({
              key,
              error: err.Message || err.Code || 'DeleteFailed',
              code: err.Code
            });
            chunkFailed.add(key);
          }
          logger.warn('storage.s3_batch_delete_partial_errors', {
            bucket: this.bucket,
            errorCount: response.Errors.length,
            errors: response.Errors
          });
        }

        // Safeguard against unacknowledged keys in the chunk
        for (const key of chunk) {
          if (!chunkDeleted.has(key) && !chunkFailed.has(key)) {
            failedKeys.push({
              key,
              error: 'Unacknowledged by S3 batch response',
              code: 'Unacknowledged'
            });
          }
        }
      } catch (chunkError) {
        logger.error('storage.s3_batch_delete_chunk_failed', {
          bucket: this.bucket,
          chunkSize: chunk.length,
          error: chunkError.message
        });

        const abortCode =
          parentSignal?.reason?.name && parentSignal.reason.name !== 'Error'
            ? parentSignal.reason.name
            : 'AbortError';

        for (const key of chunk) {
          failedKeys.push({
            key,
            error: chunkError.message || 'ChunkDeleteFailed',
            code: parentSignal?.aborted
              ? abortCode
              : chunkError.name || chunkError.code || 'ChunkError'
          });
        }

        // If parent signal was aborted, do not proceed to subsequent chunks
        if (parentSignal?.aborted) {
          const remainingKeys = sanitizedKeys.slice(i + CHUNK_SIZE);
          for (const key of remainingKeys) {
            failedKeys.push({
              key,
              error: parentSignal.reason?.message || 'Delete operation aborted',
              code: abortCode
            });
          }
          break;
        }
      } finally {
        cleanup();
      }
    }

    return {
      success: failedKeys.length === 0,
      deletedKeys,
      failedKeys,
      totalRequested: sanitizedKeys.length
    };
  }

  async getPresignedUrl(path, expiresIn = 3600) {
    if (!this.client) {
      if (this.isMock) {
        return `http://localhost:5000/mock-download/${path}`;
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: path
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  /**
   * Retrieves a file object from storage as a readable stream
   * @param {string} path - The storage key/path of the file
   * @returns {Promise<{ stream: import('stream').Readable, contentType?: string, contentLength?: number }>}
   */
  async getFileStream(path, options = {}) {
    if (!this.client) {
      if (this.isMock) {
        const mockContent = Buffer.from(`Mock file content for ${path}`);
        return {
          stream: Readable.from(mockContent),
          contentType: 'application/octet-stream',
          contentLength: mockContent.length
        };
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const timeoutMs = options.timeoutMs || S3_DEFAULT_TIMEOUTS.GET_TIMEOUT_MS;
    const parentSignal = options.abortSignal || options.signal;
    const { signal, cleanup } = createCancelableTimeoutSignal(timeoutMs, parentSignal);

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: path
      });

      const response = await this.client.send(command, { abortSignal: signal });
      return {
        stream: response.Body,
        contentType: response.ContentType,
        contentLength: response.ContentLength
      };
    } finally {
      cleanup();
    }
  }

  /**
   * Lists object keys matching prefix up to maxKeys with continuation-token pagination.
   *
   * @param {string} prefix - S3 key prefix to query
   * @param {object} [options]
   * @param {string} [options.continuationToken] - S3 ContinuationToken for next page
   * @param {number} [options.maxKeys=1000] - Max keys per page (<= 1000)
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.abortSignal]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ keys: string[], isTruncated: boolean, nextContinuationToken?: string, keyCount: number }>}
   */
  async listObjectsByPrefix(prefix, options = {}) {
    if (!this.client) {
      if (this.isMock) {
        logger.debug('storage.s3_mock_list_objects', { prefix });
        return {
          keys: [],
          isTruncated: false,
          nextContinuationToken: undefined,
          keyCount: 0
        };
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const timeoutMs = options.timeoutMs || S3_DEFAULT_TIMEOUTS.GET_TIMEOUT_MS;
    const parentSignal = options.abortSignal || options.signal;
    const { signal, cleanup } = createCancelableTimeoutSignal(timeoutMs, parentSignal);

    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: options.maxKeys || 1000,
        ContinuationToken: options.continuationToken
      });

      const response = await this.client.send(command, { abortSignal: signal });
      const keys = (response.Contents || []).map((obj) => obj.Key).filter(Boolean);

      return {
        keys,
        isTruncated: Boolean(response.IsTruncated),
        nextContinuationToken: response.NextContinuationToken,
        keyCount: response.KeyCount || keys.length
      };
    } finally {
      cleanup();
    }
  }

  /**
   * Copies an S3 object from sourceKey to destinationKey within the configured bucket.
   *
   * @param {string} sourceKey - Source S3 object key
   * @param {string} destinationKey - Destination S3 object key
   * @param {object} [options]
   * @param {string} [options.contentType] - Optional replacement Content-Type
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.abortSignal]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<string>} - Returns the destinationKey
   */
  async copyFile(sourceKey, destinationKey, options = {}) {
    if (!this.client) {
      if (this.isMock) {
        logger.debug('storage.s3_mock_copy_file', { sourceKey, destinationKey });
        return destinationKey;
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const timeoutMs = options.timeoutMs || S3_DEFAULT_TIMEOUTS.UPLOAD_TIMEOUT_MS;
    const parentSignal = options.abortSignal || options.signal;
    const { signal, cleanup } = createCancelableTimeoutSignal(timeoutMs, parentSignal);

    try {
      // In AWS S3 CopyObjectCommand, CopySource must be bucket-qualified: `${bucket}/${key}`
      const encodedSourceKey = sourceKey
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const copySource = `${this.bucket}/${encodedSourceKey}`;

      const command = new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: copySource,
        Key: destinationKey,
        ...(options.contentType ? { ContentType: options.contentType } : {})
      });

      await this.client.send(command, { abortSignal: signal });
      return destinationKey;
    } finally {
      cleanup();
    }
  }

  /**
   * Checks S3/MinIO bucket reachability and availability.
   *
   * @param {number} [timeoutMs=3000] - Timeout in milliseconds
   * @returns {Promise<{ ok: boolean, status: string, error?: string }>}
   */
  async checkBucketAccess(timeoutMs = 3000) {
    if (this.isMock) {
      return { ok: true, status: 'mock' };
    }

    if (!this.client || this.initError) {
      return {
        ok: false,
        status: 'misconfigured',
        error: this.initError ? this.initError.message : 'Storage client not initialized'
      };
    }

    let timeoutId;
    let abortSignal;

    if (typeof AbortSignal.timeout === 'function') {
      abortSignal = AbortSignal.timeout(timeoutMs);
    } else {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      abortSignal = controller.signal;
    }

    try {
      const command = new HeadBucketCommand({
        Bucket: this.bucket
      });

      await this.client.send(command, { abortSignal });

      return {
        ok: true,
        status: 'connected'
      };
    } catch (error) {
      const httpStatus = error?.$metadata?.httpStatusCode;
      const errorName = error?.name;
      const errorCode = error?.code;

      if (errorName === 'AbortError' || errorName === 'TimeoutError') {
        return { ok: false, status: 'timeout', error: 'storage_timeout' };
      }

      if (httpStatus === 404 || errorName === 'NotFound' || errorName === 'NoSuchBucket') {
        return { ok: false, status: 'bucket_not_found', error: 'bucket_not_found' };
      }

      if (httpStatus === 403 || errorName === 'AccessDenied') {
        return { ok: false, status: 'bucket_access_denied', error: 'bucket_access_denied' };
      }

      if (
        errorCode === 'ECONNREFUSED' ||
        errorCode === 'ENOTFOUND' ||
        errorCode === 'EHOSTUNREACH'
      ) {
        return { ok: false, status: 'unreachable', error: 'storage_unreachable' };
      }

      return {
        ok: false,
        status: 'error',
        error: 'storage_unavailable'
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Gracefully close and destroy the underlying S3 client.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this.client && typeof this.client.destroy === 'function') {
      try {
        await this.client.destroy();
      } catch (err) {
        logger.warn('storage.s3_client_destroy_failed', { error: err.message });
      } finally {
        this.client = null;
      }
    }
  }
}

export { S3StorageProvider };
export default new S3StorageProvider();
