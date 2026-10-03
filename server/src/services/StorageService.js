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
   * @returns {Promise<string>} The storage key or URL
   */
  async uploadFile(fileBuffer, path, mimeType) {
    return s3Provider.uploadFile(fileBuffer, path, mimeType);
  }

  /**
   * Delete a file from storage
   * @param {string} path - The path/key of the file to delete
   * @returns {Promise<void>}
   */
  async deleteFile(path) {
    return s3Provider.deleteFile(path);
  }

  /**
   * Get a presigned URL for secure download
   * @param {string} path - The path/key of the file
   * @returns {Promise<string>} The presigned URL
   */
  async getPresignedUrl(path) {
    return s3Provider.getPresignedUrl(path);
  }
}

export default new StorageService();
