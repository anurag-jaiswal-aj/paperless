import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  MINIO_TEST_CONFIG,
  isMinioHealthy,
  isTcpPortOpen,
  waitForMinioReady,
  createTestS3Client,
  ensureTestBucket,
  emptyTestBucket,
  setupTestStorageEnv,
  createIsolatedTestStorageProvider,
  startMinioTestContainer
} from './minioTestHelper.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';

describe('Phase 2D.1K.9 (Phase K-F): MinIO Test Helper & Container Infrastructure', () => {
  beforeAll(async () => {
    // Ensure container is up and bucket is ready
    await startMinioTestContainer({ ensureBucket: true });
  });

  afterAll(async () => {
    // Clean up test bucket keys
    await emptyTestBucket();
  });

  describe('Configuration & Connectivity Probes', () => {
    it('defines isolated non-colliding ports and credentials', () => {
      expect(MINIO_TEST_CONFIG.S3_PORT).toBe(9010);
      expect(MINIO_TEST_CONFIG.CONSOLE_PORT).toBe(9011);
      expect(MINIO_TEST_CONFIG.BUCKET).toBe('paperless-kf-test');
      expect(MINIO_TEST_CONFIG.ACCESS_KEY_ID).toBe('minio_admin');
      expect(MINIO_TEST_CONFIG.SECRET_ACCESS_KEY).toBe('minio_password');
      expect(MINIO_TEST_CONFIG.ENDPOINT).toBe('http://127.0.0.1:9010');
      expect(MINIO_TEST_CONFIG.HEALTH_URL).toBe('http://127.0.0.1:9010/minio/health/ready');
    });

    it('probes HTTP readiness endpoint successfully (200 OK)', async () => {
      const healthy = await isMinioHealthy(MINIO_TEST_CONFIG.HEALTH_URL);
      expect(healthy).toBe(true);
    });

    it('probes TCP port 9010 successfully', async () => {
      const open = await isTcpPortOpen(MINIO_TEST_CONFIG.S3_PORT, '127.0.0.1');
      expect(open).toBe(true);
    });

    it('waitForMinioReady returns true within timeout', async () => {
      const ready = await waitForMinioReady({ maxWaitMs: 3000, intervalMs: 100 });
      expect(ready).toBe(true);
    });
  });

  describe('Bucket Management & Lifecycle Operations', () => {
    it('ensures test bucket is provisioned and idempotent', async () => {
      await expect(ensureTestBucket(MINIO_TEST_CONFIG.BUCKET)).resolves.not.toThrow();
      await expect(ensureTestBucket(MINIO_TEST_CONFIG.BUCKET)).resolves.not.toThrow();
    });

    it('uploads test objects and empties test bucket idempotently', async () => {
      const client = createTestS3Client();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: MINIO_TEST_CONFIG.BUCKET,
            Key: 'temp/probe-1.txt',
            Body: 'probe content 1'
          })
        );
        await client.send(
          new PutObjectCommand({
            Bucket: MINIO_TEST_CONFIG.BUCKET,
            Key: 'temp/probe-2.txt',
            Body: 'probe content 2'
          })
        );

        const count = await emptyTestBucket(MINIO_TEST_CONFIG.BUCKET);
        expect(count).toBeGreaterThanOrEqual(2);

        // Subsequent empty should return 0 deleted
        const emptyCount = await emptyTestBucket(MINIO_TEST_CONFIG.BUCKET);
        expect(emptyCount).toBe(0);
      } finally {
        await client.destroy();
      }
    });
  });

  describe('S3StorageProvider Integration', () => {
    it('establishes live connection via S3StorageProvider and verifies bucket status', async () => {
      const provider = createIsolatedTestStorageProvider();
      try {
        const bucketStatus = await provider.checkBucketAccess();
        expect(bucketStatus.ok).toBe(true);
        expect(bucketStatus.status).toBe('connected');
      } finally {
        await provider.destroy();
      }
    });

    it('executes upload, download stream, and deletion through S3StorageProvider', async () => {
      const provider = createIsolatedTestStorageProvider();
      const testKey = 'integration/sample-kf-document.pdf';
      const fileData = Buffer.from('KF-TEST-BINARY-CONTENT-PAYLOAD');

      try {
        // Upload
        const uploadResult = await provider.uploadFile(fileData, testKey, 'application/pdf', {
          returnMetadata: true
        });
        expect(uploadResult).toBeDefined();
        expect(uploadResult.key).toBe(testKey);
        expect(uploadResult.etag).toBeDefined();

        // Download stream
        const downloadResult = await provider.getFileStream(testKey);
        expect(downloadResult).toBeDefined();
        expect(downloadResult.contentType).toBe('application/pdf');

        const chunks = [];
        for await (const chunk of downloadResult.stream) {
          chunks.push(chunk);
        }
        const downloadedBuffer = Buffer.concat(chunks);
        expect(downloadedBuffer.toString()).toBe(fileData.toString());

        // Delete
        await expect(provider.deleteFile(testKey)).resolves.not.toThrow();
      } finally {
        await provider.destroy();
      }
    });

    it('correctly sets and restores environment variables via setupTestStorageEnv', () => {
      const originalEndpoint = process.env.S3_ENDPOINT;
      const { restoreEnv } = setupTestStorageEnv();

      expect(process.env.S3_ENDPOINT).toBe('http://127.0.0.1:9010');
      expect(process.env.S3_BUCKET).toBe('paperless-kf-test');
      expect(process.env.S3_ACCESS_KEY_ID).toBe('minio_admin');
      expect(process.env.S3_SECRET_ACCESS_KEY).toBe('minio_password');

      restoreEnv();
      expect(process.env.S3_ENDPOINT).toBe(originalEndpoint);
    });
  });
});
