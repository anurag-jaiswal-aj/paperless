import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CreateMultipartUploadCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3StorageProvider } from './S3StorageProvider.js';

const MINIO_ENDPOINT = process.env.TEST_MINIO_ENDPOINT || 'http://127.0.0.1:9010';
const MINIO_ACCESS_KEY = process.env.TEST_MINIO_ACCESS_KEY || 'minio_admin';
const MINIO_SECRET_KEY = process.env.TEST_MINIO_SECRET_KEY || 'minio_password';
const MINIO_BUCKET = process.env.TEST_MINIO_BUCKET || 'paperless-test';
const MINIO_REGION = process.env.TEST_MINIO_REGION || 'us-east-1';

async function isMinioReachable(endpoint) {
  try {
    const res = await fetch(`${endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(2500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe('S3StorageProvider - MinIO Live Integration & API Conformance (Phase 2D.1K.9 / Phase K-F)', () => {
  let minioAvailable = false;
  let provider = null;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    minioAvailable = await isMinioReachable(MINIO_ENDPOINT);
    if (!minioAvailable) {
      console.warn(`MinIO not reachable at ${MINIO_ENDPOINT}; skipping live integration suite.`);
      return;
    }

    process.env.S3_REGION = MINIO_REGION;
    process.env.S3_BUCKET = MINIO_BUCKET;
    process.env.S3_ACCESS_KEY_ID = MINIO_ACCESS_KEY;
    process.env.S3_SECRET_ACCESS_KEY = MINIO_SECRET_KEY;
    process.env.S3_ENDPOINT = MINIO_ENDPOINT;

    provider = new S3StorageProvider();

    // Ensure bucket exists
    try {
      await provider.client.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET }));
    } catch (err) {
      // BucketAlreadyOwnedByYou or BucketAlreadyExists is expected
      if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') {
        // Ignore if already created
      }
    }
  });

  afterAll(async () => {
    if (provider) {
      await provider.destroy();
    }
    process.env = originalEnv;
  });

  describe('1. Connectivity & Bucket Access Verification', () => {
    it('successfully connects to live MinIO and confirms bucket availability', async () => {
      if (!minioAvailable) return;

      const access = await provider.checkBucketAccess();
      expect(access).toEqual({
        ok: true,
        status: 'connected'
      });
    });
  });

  describe('2. Basic CRUD Lifecycle', () => {
    const testKey = `conformance-crud/item-${Date.now()}.txt`;
    const testContent = Buffer.from('Integration test payload for Phase K-F conformance', 'utf8');
    const mimeType = 'text/plain';

    it('executes complete CRUD cycle: PUT, HEAD, GET stream, DELETE, HEAD verification', async () => {
      if (!minioAvailable) return;

      // 1. PUT via uploadBuffer with metadata
      const uploadRes = await provider.uploadBuffer(testKey, testContent, mimeType, {
        metadata: {
          'conformance-phase': '2d-1k-9',
          'test-agent': 'agent-b'
        },
        returnMetadata: true
      });

      expect(uploadRes).toHaveProperty('key', testKey);
      expect(uploadRes).toHaveProperty('etag');
      expect(typeof uploadRes.etag).toBe('string');
      expect(uploadRes.etag.length).toBeGreaterThan(0);

      // 2. HEAD verification
      const head = await provider.headObject(testKey);
      expect(head).not.toBeNull();
      expect(head.contentLength).toBe(testContent.length);
      expect(head.etag).toBe(uploadRes.etag);
      expect(head.contentType).toBe(mimeType);
      expect(head.lastModified).toBeInstanceOf(Date);
      expect(head.exists).toBe(true);
      expect(head.metadata).toMatchObject({
        'conformance-phase': '2d-1k-9',
        'test-agent': 'agent-b'
      });

      // 3. GET stream verification
      const fileStream = await provider.getFileStream(testKey);
      expect(fileStream.contentType).toBe(mimeType);
      expect(fileStream.contentLength).toBe(testContent.length);

      const chunks = [];
      for await (const chunk of fileStream.stream) {
        chunks.push(chunk);
      }
      const downloadedBuffer = Buffer.concat(chunks);
      expect(downloadedBuffer.equals(testContent)).toBe(true);

      // 4. DELETE via deleteObject
      await provider.deleteObject(testKey);

      // 5. Post-DELETE HEAD verification (must return null / 404 mapped)
      const headAfterDelete = await provider.headObject(testKey);
      expect(headAfterDelete).toBeNull();
    });
  });

  describe('3. Pagination Verification', () => {
    const prefix = `conformance-pagination-${Date.now()}/`;
    const totalItems = 5;
    const uploadedKeys = [];

    beforeAll(async () => {
      if (!minioAvailable) return;
      for (let i = 1; i <= totalItems; i++) {
        const key = `${prefix}doc-${String(i).padStart(2, '0')}.dat`;
        await provider.uploadBuffer(key, Buffer.from(`Payload number ${i}`), 'application/octet-stream');
        uploadedKeys.push(key);
      }
    });

    afterAll(async () => {
      if (!minioAvailable || uploadedKeys.length === 0) return;
      await provider.deleteFiles(uploadedKeys);
    });

    it('correctly paginates 5 objects with maxKeys=2 across 3 pages', async () => {
      if (!minioAvailable) return;

      // Page 1: keys 1 & 2
      const page1 = await provider.listObjects(prefix, null, 2);
      expect(page1.keys).toHaveLength(2);
      expect(page1.keys).toEqual([uploadedKeys[0], uploadedKeys[1]]);
      expect(page1.isTruncated).toBe(true);
      expect(page1.nextContinuationToken).toBeDefined();
      expect(typeof page1.nextContinuationToken).toBe('string');
      expect(page1.keyCount).toBe(2);

      // Page 2: keys 3 & 4
      const page2 = await provider.listObjects(prefix, page1.nextContinuationToken, 2);
      expect(page2.keys).toHaveLength(2);
      expect(page2.keys).toEqual([uploadedKeys[2], uploadedKeys[3]]);
      expect(page2.isTruncated).toBe(true);
      expect(page2.nextContinuationToken).toBeDefined();
      expect(typeof page2.nextContinuationToken).toBe('string');
      expect(page2.keyCount).toBe(2);

      // Page 3: key 5 (final page)
      const page3 = await provider.listObjects(prefix, page2.nextContinuationToken, 2);
      expect(page3.keys).toHaveLength(1);
      expect(page3.keys).toEqual([uploadedKeys[4]]);
      expect(page3.isTruncated).toBe(false);
      expect(page3.nextContinuationToken).toBeUndefined();
      expect(page3.keyCount).toBe(1);

      // Union of all pages equals all 5 keys
      const allEnumeratedKeys = [...page1.keys, ...page2.keys, ...page3.keys];
      expect(allEnumeratedKeys).toEqual(uploadedKeys);
    });

    it('supports options object signature for listObjects(prefix, { maxKeys, continuationToken })', async () => {
      if (!minioAvailable) return;

      const res = await provider.listObjects(prefix, { maxKeys: 3 });
      expect(res.keys).toHaveLength(3);
      expect(res.isTruncated).toBe(true);
      expect(res.nextContinuationToken).toBeDefined();

      const res2 = await provider.listObjects(prefix, {
        maxKeys: 3,
        continuationToken: res.nextContinuationToken
      });
      expect(res2.keys).toHaveLength(2);
      expect(res2.isTruncated).toBe(false);
    });
  });

  describe('4. Empty Bucket and Non-Existent Prefix Handling', () => {
    it('returns empty array and isTruncated=false without throwing for non-existent prefix', async () => {
      if (!minioAvailable) return;

      const nonExistentPrefix = `nonexistent-prefix-${Date.now()}-${Math.random().toString(36).substring(2, 9)}/`;
      const result = await provider.listObjects(nonExistentPrefix);

      expect(result).toEqual({
        keys: [],
        isTruncated: false,
        nextContinuationToken: undefined,
        keyCount: 0
      });
    });

    it('returns null on headObject for non-existent key without unhandled exceptions', async () => {
      if (!minioAvailable) return;

      const nonExistentKey = `ghost-folder/nonexistent-file-${Date.now()}.bin`;
      const result = await provider.headObject(nonExistentKey);

      expect(result).toBeNull();
    });
  });

  describe('5. Multipart Upload Listing and Abort Verification', () => {
    it('initiates, enumerates, aborts, and verifies removal of in-progress multipart upload', async () => {
      if (!minioAvailable) return;

      const multipartKey = `staging/multipart-test-${Date.now()}.bin`;

      // 1. Initiate multipart upload via S3Client
      const createCommand = new CreateMultipartUploadCommand({
        Bucket: provider.bucket,
        Key: multipartKey
      });
      const createRes = await provider.client.send(createCommand);
      const uploadId = createRes.UploadId;
      expect(uploadId).toBeDefined();
      expect(typeof uploadId).toBe('string');

      // 2. Verify listMultipartUploads detects the active upload (both string prefix and options signature)
      const listStringPrefix = await provider.listMultipartUploads('staging/');
      const foundInString = listStringPrefix.uploads.find((u) => u.key === multipartKey && u.uploadId === uploadId);
      expect(foundInString).toBeDefined();
      expect(foundInString.key).toBe(multipartKey);
      expect(foundInString.uploadId).toBe(uploadId);
      expect(foundInString.initiated).toBeInstanceOf(Date);

      const listOptionsPrefix = await provider.listMultipartUploads({ prefix: 'staging/' });
      const foundInOptions = listOptionsPrefix.uploads.find((u) => u.key === multipartKey && u.uploadId === uploadId);
      expect(foundInOptions).toBeDefined();

      // 3. Abort the multipart upload
      const abortSuccess = await provider.abortMultipartUpload(multipartKey, uploadId);
      expect(abortSuccess).toBe(true);

      // 4. Verify listMultipartUploads confirms removal
      const listAfterAbort = await provider.listMultipartUploads('staging/');
      const foundAfterAbort = listAfterAbort.uploads.find((u) => u.uploadId === uploadId);
      expect(foundAfterAbort).toBeUndefined();

      // 5. Verify abortMultipartUpload is idempotent on already aborted / completed upload
      const secondAbortSuccess = await provider.abortMultipartUpload(multipartKey, uploadId);
      expect(secondAbortSuccess).toBe(true);
    });
  });

  describe('6. Error Mapping and Status Code Classification', () => {
    it('safely handles non-existent upload abort without crashing (NoSuchUpload / 404)', async () => {
      if (!minioAvailable) return;

      const fakeKey = 'staging/fake-key.dat';
      const fakeUploadId = 'nonexistent-upload-id-1234567890';

      const res = await provider.abortMultipartUpload(fakeKey, fakeUploadId);
      expect(res).toBe(true);
    });

    it('classifies missing bucket error in checkBucketAccess', async () => {
      if (!minioAvailable) return;

      const originalBucket = provider.bucket;
      provider.bucket = `nonexistent-bucket-${Date.now()}`;

      try {
        const status = await provider.checkBucketAccess();
        expect(status).toEqual({
          ok: false,
          status: 'bucket_not_found',
          error: 'bucket_not_found'
        });
      } finally {
        provider.bucket = originalBucket;
      }
    });
  });

  describe('7. API Conformance & Method Signature Interchangeability', () => {
    it('supports uploadBuffer(key, buffer, mimeType) and uploadBuffer(buffer, key, mimeType)', async () => {
      if (!minioAvailable) return;

      const keyA = `conformance-alias/keyA-${Date.now()}.txt`;
      const keyB = `conformance-alias/keyB-${Date.now()}.txt`;
      const buf = Buffer.from('Conformance Buffer Content');

      // Order 1: (key, buffer, mimeType)
      const resA = await provider.uploadBuffer(keyA, buf, 'text/plain');
      expect(resA).toBe(keyA);

      // Order 2: (buffer, key, mimeType)
      const resB = await provider.uploadBuffer(buf, keyB, 'text/plain');
      expect(resB).toBe(keyB);

      // Clean up
      await provider.deleteFiles([keyA, keyB]);
    });

    it('supports deleteObject(key) as equivalent alias to deleteFile(path)', async () => {
      if (!minioAvailable) return;

      const key = `conformance-alias/del-${Date.now()}.txt`;
      await provider.uploadBuffer(key, Buffer.from('To be deleted'), 'text/plain');

      const headBefore = await provider.headObject(key);
      expect(headBefore).not.toBeNull();

      await provider.deleteObject(key);

      const headAfter = await provider.headObject(key);
      expect(headAfter).toBeNull();
    });
  });
});
