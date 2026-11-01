import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import storageService from './StorageService.js';
import s3Provider, { S3StorageProvider } from './S3StorageProvider.js';
import { Readable } from 'stream';

describe('StorageService and S3StorageProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('StorageService Interface Delegation', () => {
    it('delegates uploadFile to s3Provider', async () => {
      const spy = vi.spyOn(s3Provider, 'uploadFile').mockResolvedValueOnce('uploaded-key');
      const result = await storageService.uploadFile(Buffer.from('data'), 'test/path', 'text/plain');
      expect(spy).toHaveBeenCalledWith(expect.any(Buffer), 'test/path', 'text/plain');
      expect(result).toBe('uploaded-key');
    });

    it('delegates deleteFile to s3Provider', async () => {
      const spy = vi.spyOn(s3Provider, 'deleteFile').mockResolvedValueOnce();
      await storageService.deleteFile('test/path');
      expect(spy).toHaveBeenCalledWith('test/path');
    });

    it('delegates getPresignedUrl to s3Provider', async () => {
      const spy = vi.spyOn(s3Provider, 'getPresignedUrl').mockResolvedValueOnce('https://s3.example.com/test');
      const result = await storageService.getPresignedUrl('test/path');
      expect(spy).toHaveBeenCalledWith('test/path');
      expect(result).toBe('https://s3.example.com/test');
    });

    it('delegates getFileStream to s3Provider', async () => {
      const mockResult = {
        stream: Readable.from(['content']),
        contentType: 'text/plain',
        contentLength: 7
      };
      const spy = vi.spyOn(s3Provider, 'getFileStream').mockResolvedValueOnce(mockResult);
      const result = await storageService.getFileStream('test/path');
      expect(spy).toHaveBeenCalledWith('test/path');
      expect(result).toBe(mockResult);
    });

    it('delegates checkBucketAccess to s3Provider', async () => {
      const mockResult = { ok: true, status: 'connected' };
      const spy = vi.spyOn(s3Provider, 'checkBucketAccess').mockResolvedValueOnce(mockResult);
      const result = await storageService.checkBucketAccess(2000);
      expect(spy).toHaveBeenCalledWith(2000);
      expect(result).toBe(mockResult);
    });
  });

  describe('S3StorageProvider - Mock fallback when credentials unconfigured', () => {
    it('returns a mock readable stream with metadata when client is null', async () => {
      // In dev/test when credentials are unconfigured, s3Provider.client is null
      const originalClient = s3Provider.client;
      s3Provider.client = null;

      try {
        const fileData = await s3Provider.getFileStream('forms/123/doc.pdf');
        expect(fileData).toBeDefined();
        expect(fileData.contentType).toBe('application/octet-stream');
        expect(typeof fileData.contentLength).toBe('number');
        expect(typeof fileData.stream.pipe).toBe('function');

        let data = '';
        for await (const chunk of fileData.stream) {
          data += chunk.toString();
        }
        expect(data).toContain('Mock file content for forms/123/doc.pdf');
      } finally {
        s3Provider.client = originalClient;
      }
    });
  });

  describe('S3StorageProvider - S3 client integration', () => {
    it('sends GetObjectCommand and returns S3 response body and headers when client is present', async () => {
      const mockStream = Readable.from(['Real S3 object data']);
      const mockSend = vi.fn().mockResolvedValueOnce({
        Body: mockStream,
        ContentType: 'application/pdf',
        ContentLength: 19
      });

      const mockClient = { send: mockSend };
      const originalClient = s3Provider.client;
      s3Provider.client = mockClient;

      try {
        const result = await s3Provider.getFileStream('uploads/report.pdf');
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.contentType).toBe('application/pdf');
        expect(result.contentLength).toBe(19);

        let bodyData = '';
        for await (const chunk of result.stream) {
          bodyData += chunk.toString();
        }
        expect(bodyData).toBe('Real S3 object data');
      } finally {
        s3Provider.client = originalClient;
      }
    });

    it('propagates NoSuchKey storage errors when object is not found', async () => {
      const noSuchKeyErr = new Error('NoSuchKey');
      noSuchKeyErr.name = 'NoSuchKey';
      const mockSend = vi.fn().mockRejectedValueOnce(noSuchKeyErr);

      const mockClient = { send: mockSend };
      const originalClient = s3Provider.client;
      s3Provider.client = mockClient;

      try {
        await expect(s3Provider.getFileStream('missing.pdf')).rejects.toThrow('NoSuchKey');
      } finally {
        s3Provider.client = originalClient;
      }
    });
  });

  describe('S3StorageProvider - Environment and Mock Mode Guarding', () => {
    it('disallows mock storage and throws in production when credentials are missing', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.S3_REGION;
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;

      const provider = new S3StorageProvider();
      expect(provider.client).toBeNull();
      expect(provider.isMock).toBe(false);

      await expect(provider.uploadFile(Buffer.from('data'), 'test.pdf', 'application/pdf'))
        .rejects.toThrow(/Missing credentials\/config in production environment/);
      await expect(provider.getFileStream('test.pdf'))
        .rejects.toThrow(/Missing credentials\/config in production environment/);
      await expect(provider.getPresignedUrl('test.pdf'))
        .rejects.toThrow(/Missing credentials\/config in production environment/);
      await expect(provider.deleteFile('test.pdf'))
        .rejects.toThrow(/Missing credentials\/config in production environment/);
    });

    it('disallows mock storage and throws in staging when credentials are missing', async () => {
      process.env.NODE_ENV = 'staging';
      delete process.env.S3_REGION;
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;

      const provider = new S3StorageProvider();
      expect(provider.client).toBeNull();
      expect(provider.isMock).toBe(false);

      await expect(provider.uploadFile(Buffer.from('data'), 'test.pdf', 'application/pdf'))
        .rejects.toThrow(/Missing credentials\/config in staging environment/);
      await expect(provider.getFileStream('test.pdf'))
        .rejects.toThrow(/Missing credentials\/config in staging environment/);
    });

    it('permits explicit mock mode in development and test environments when credentials are missing', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.S3_REGION;
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;

      const provider = new S3StorageProvider();
      expect(provider.client).toBeNull();
      expect(provider.isMock).toBe(true);

      const uploadResult = await provider.uploadFile(Buffer.from('data'), 'test.pdf', 'application/pdf');
      expect(uploadResult).toBe('mock-s3-url/test.pdf');

      const fileData = await provider.getFileStream('test.pdf');
      expect(fileData).toBeDefined();
      expect(fileData.contentType).toBe('application/octet-stream');
      expect(typeof fileData.stream.pipe).toBe('function');
    });

    it('initializes real S3Client when credentials are provided in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.S3_REGION = 'us-east-1';
      process.env.S3_BUCKET = 'paperless-test';
      process.env.S3_ACCESS_KEY_ID = 'test-key';
      process.env.S3_SECRET_ACCESS_KEY = 'test-secret';

      const provider = new S3StorageProvider();
      expect(provider.client).not.toBeNull();
      expect(provider.isMock).toBe(false);
      expect(provider.initError).toBeNull();
    });
  });

  describe('S3StorageProvider - checkBucketAccess', () => {
    it('returns mock status when provider is in mock mode', async () => {
      const provider = new S3StorageProvider();
      provider.isMock = true;
      provider.client = null;

      const result = await provider.checkBucketAccess();
      expect(result).toEqual({ ok: true, status: 'mock' });
    });

    it('returns misconfigured status when client is unconfigured in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.S3_REGION;
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;

      const provider = new S3StorageProvider();
      const result = await provider.checkBucketAccess();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('misconfigured');
      expect(result.error).toContain('Missing credentials/config');
    });

    it('returns connected status when HeadBucketCommand succeeds', async () => {
      const mockSend = vi.fn().mockResolvedValueOnce({});
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'paperless-test';
      provider.client = { send: mockSend };

      const result = await provider.checkBucketAccess(3000);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const commandArg = mockSend.mock.calls[0][0];
      expect(commandArg.input.Bucket).toBe('paperless-test');
      expect(result).toEqual({ ok: true, status: 'connected' });
    });

    it('returns bucket_not_found on 404 / NotFound error', async () => {
      const notFoundErr = new Error('NotFound');
      notFoundErr.name = 'NotFound';
      notFoundErr.$metadata = { httpStatusCode: 404 };

      const mockSend = vi.fn().mockRejectedValueOnce(notFoundErr);
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'paperless-test';
      provider.client = { send: mockSend };

      const result = await provider.checkBucketAccess();
      expect(result).toEqual({ ok: false, status: 'bucket_not_found', error: 'bucket_not_found' });
    });

    it('returns bucket_access_denied on 403 / AccessDenied error', async () => {
      const accessDeniedErr = new Error('AccessDenied');
      accessDeniedErr.name = 'AccessDenied';
      accessDeniedErr.$metadata = { httpStatusCode: 403 };

      const mockSend = vi.fn().mockRejectedValueOnce(accessDeniedErr);
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'paperless-test';
      provider.client = { send: mockSend };

      const result = await provider.checkBucketAccess();
      expect(result).toEqual({ ok: false, status: 'bucket_access_denied', error: 'bucket_access_denied' });
    });

    it('returns unreachable on connection refused', async () => {
      const connErr = new Error('connect ECONNREFUSED 127.0.0.1:9000');
      connErr.code = 'ECONNREFUSED';

      const mockSend = vi.fn().mockRejectedValueOnce(connErr);
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'paperless-test';
      provider.client = { send: mockSend };

      const result = await provider.checkBucketAccess();
      expect(result).toEqual({ ok: false, status: 'unreachable', error: 'storage_unreachable' });
    });

    it('returns timeout on AbortError or TimeoutError', async () => {
      const timeoutErr = new Error('Request aborted');
      timeoutErr.name = 'AbortError';

      const mockSend = vi.fn().mockRejectedValueOnce(timeoutErr);
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'paperless-test';
      provider.client = { send: mockSend };

      const result = await provider.checkBucketAccess();
      expect(result).toEqual({ ok: false, status: 'timeout', error: 'storage_timeout' });
    });

    it('returns generic error on unexpected exception', async () => {
      const genericErr = new Error('Unexpected S3 crash');

      const mockSend = vi.fn().mockRejectedValueOnce(genericErr);
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'paperless-test';
      provider.client = { send: mockSend };

      const result = await provider.checkBucketAccess();
      expect(result).toEqual({ ok: false, status: 'error', error: 'storage_unavailable' });
    });
  });
});
