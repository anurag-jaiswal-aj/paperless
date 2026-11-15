/**
 * StorageService
 *
 * Abstraction layer for file storage operations.
 * Isolates the application from the underlying storage provider (e.g., AWS S3).
 *
 * Phase 0: Interface definition only.
 */

import s3Provider from './S3StorageProvider.js';

class StorageService {
  /**
   * Upload a file to storage
   * @param {Buffer} fileBuffer - The file buffer
   * @param {string} path - The destination path/key
   * @param {string} mimeType - The mime type of the file
   * @param {...any} rest - Optional configurations (e.g. timeoutMs)
   * @returns {Promise<string>} The storage key or URL
   */
  async uploadFile(fileBuffer, path, mimeType, ...rest) {
    return s3Provider.uploadFile(fileBuffer, path, mimeType, ...rest);
  }

  /**
   * Delete a file from storage
   * @param {string} path - The path/key of the file to delete
   * @param {...any} rest - Optional configurations (e.g. timeoutMs)
   * @returns {Promise<void>}
   */
  async deleteFile(path, ...rest) {
    return s3Provider.deleteFile(path, ...rest);
  }

  /**
   * Delete multiple files from storage in batch
   * @param {string[]} paths - Array of keys to delete
   * @param {...any} rest - Optional configurations (e.g. timeoutMs)
   * @returns {Promise<{ success: boolean, deletedKeys: string[], failedKeys: Array<{ key: string, error: string }>, totalRequested: number }>}
   */
  async deleteFiles(paths, ...rest) {
    return s3Provider.deleteFiles(paths, ...rest);
  }

  /**
   * Get a presigned URL for secure download
   * @param {string} path - The path/key of the file
   * @returns {Promise<string>} The presigned URL
   */
  async getPresignedUrl(path) {
    return s3Provider.getPresignedUrl(path);
  }

  /**
   * Get a readable stream for a file from storage
   * @param {string} path - The path/key of the file
   * @param {...any} rest - Optional configurations (e.g. timeoutMs)
   * @returns {Promise<{ stream: import('stream').Readable, contentType?: string, contentLength?: number }>}
   */
  async getFileStream(path, ...rest) {
    return s3Provider.getFileStream(path, ...rest);
  }

  /**
   * Lists object keys matching prefix up to maxKeys with continuation-token pagination.
   * @param {string} prefix - S3 key prefix to query
   * @param {...any} rest - Optional configurations (e.g. continuationToken, maxKeys, timeoutMs, signal)
   * @returns {Promise<{ keys: string[], isTruncated: boolean, nextContinuationToken?: string, keyCount: number }>}
   */
  async listObjectsByPrefix(prefix, ...rest) {
    return s3Provider.listObjectsByPrefix(prefix, ...rest);
  }

  /**
   * Copy an object from sourceKey to destinationKey within the storage bucket.
   * @param {string} sourceKey - The source path/key
   * @param {string} destinationKey - The destination path/key
   * @param {...any} rest - Optional configurations (e.g. timeoutMs, signal)
   * @returns {Promise<string>} Destination key
   */
  async copyFile(sourceKey, destinationKey, ...rest) {
    return s3Provider.copyFile(sourceKey, destinationKey, ...rest);
  }

  /**
   * Check storage bucket accessibility
   * @param {number} [timeoutMs=3000] - Timeout in milliseconds
   * @returns {Promise<{ ok: boolean, status: string, error?: string }>}
   */
  async checkBucketAccess(timeoutMs = 3000) {
    return s3Provider.checkBucketAccess(timeoutMs);
  }

  /**
   * Gracefully close and destroy storage provider resources
   * @returns {Promise<void>}
   */
  async destroy() {
    return s3Provider.destroy();
  }
}

export default new StorageService();
