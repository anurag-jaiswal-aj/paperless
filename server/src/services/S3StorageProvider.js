import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

class S3StorageProvider {
  constructor() {
    this.region = process.env.S3_REGION;
    this.bucket = process.env.S3_BUCKET;
    this.accessKeyId = process.env.S3_ACCESS_KEY_ID;
    this.secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    this.endpoint = process.env.S3_ENDPOINT;

    if (!this.region || !this.bucket || !this.accessKeyId || !this.secretAccessKey) {
      if (process.env.NODE_ENV === 'production') {
        console.error('S3 storage failed to initialize: Missing credentials/config in production');
      } else {
        console.log('S3 Storage missing credentials in dev. Using mock fallback.');
      }
      this.client = null;
    } else {
      this.client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey
        },
        ...(this.endpoint ? { endpoint: this.endpoint } : {})
      });
    }
  }

  async uploadFile(fileBuffer, path, mimeType) {
    if (!this.client) {
      console.log(`[Mock S3 Upload] Path: ${path}, Type: ${mimeType}`);
      return `mock-s3-url/${path}`;
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
      console.log(`[Mock S3 Delete] Path: ${path}`);
      return;
    }

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: path
    });

    await this.client.send(command);
  }

  async getPresignedUrl(path, expiresIn = 3600) {
    if (!this.client) {
      return `http://localhost:5000/mock-download/${path}`;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: path
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }
}

export default new S3StorageProvider();
