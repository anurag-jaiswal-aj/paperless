import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

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

    const hasCredentials = Boolean(this.region && this.bucket && this.accessKeyId && this.secretAccessKey);
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
        this.initError = new Error(`S3 storage failed to initialize: Missing credentials/config in ${env} environment`);
        console.error(this.initError.message);
      } else {
        // Explicit mock mode only permitted in development and test environments
        this.isMock = true;
        this.initError = null;
        console.log('S3 Storage missing credentials in dev. Using mock fallback.');
      }
    }
  }

  async uploadFile(fileBuffer, path, mimeType) {
    if (!this.client) {
      if (this.isMock) {
        console.log(`[Mock S3 Upload] Path: ${path}, Type: ${mimeType}`);
        if (fileBuffer && typeof fileBuffer.destroy === 'function') {
          fileBuffer.destroy();
        }
        return `mock-s3-url/${path}`;
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: path,
      Body: fileBuffer,
      ContentType: mimeType
    });

    await this.client.send(command);
    // Return key, we don't expose public URLs directly.
    return path;
  }

  async deleteFile(path) {
    if (!this.client) {
      if (this.isMock) {
        console.log(`[Mock S3 Delete] Path: ${path}`);
        return;
      }
      throw this.initError || new Error('S3 storage client is not configured');
    }

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: path
    });

    await this.client.send(command);
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
  async getFileStream(path) {
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

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: path
    });

    const response = await this.client.send(command);
    return {
      stream: response.Body,
      contentType: response.ContentType,
      contentLength: response.ContentLength
    };
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

      if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND' || errorCode === 'EHOSTUNREACH') {
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
}

export { S3StorageProvider };
export default new S3StorageProvider();
