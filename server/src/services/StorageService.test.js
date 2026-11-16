import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import storageService from './StorageService.js';
import s3Provider, { S3StorageProvider, S3_DEFAULT_TIMEOUTS } from './S3StorageProvider.js';
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
      const result = await storageService.uploadFile(
        Buffer.from('data'),
        'test/path',
        'text/plain'
      );
      expect(spy).toHaveBeenCalledWith(expect.any(Buffer), 'test/path', 'text/plain');
      expect(result).toBe('uploaded-key');
    });

    it('delegates deleteFile to s3Provider', async () => {
      const spy = vi.spyOn(s3Provider, 'deleteFile').mockResolvedValueOnce();
      await storageService.deleteFile('test/path');
      expect(spy).toHaveBeenCalledWith('test/path');
    });

    it('delegates getPresignedUrl to s3Provider', async () => {
      const spy = vi
        .spyOn(s3Provider, 'getPresignedUrl')
        .mockResolvedValueOnce('https://s3.example.com/test');
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

    it('delegates listObjectsByPrefix to s3Provider', async () => {
      const mockResult = { keys: ['test/file1.pdf'], isTruncated: false, keyCount: 1 };
      const spy = vi.spyOn(s3Provider, 'listObjectsByPrefix').mockResolvedValueOnce(mockResult);
      const result = await storageService.listObjectsByPrefix('test/');
      expect(spy).toHaveBeenCalledWith('test/');
      expect(result).toBe(mockResult);
    });

    it('delegates copyFile to s3Provider', async () => {
      const spy = vi.spyOn(s3Provider, 'copyFile').mockResolvedValueOnce('dest/path.pdf');
      const result = await storageService.copyFile('source/path.pdf', 'dest/path.pdf');
      expect(spy).toHaveBeenCalledWith('source/path.pdf', 'dest/path.pdf');
      expect(result).toBe('dest/path.pdf');
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

    it('sends ListObjectsV2Command and returns object keys and pagination tokens', async () => {
      const mockSend = vi.fn().mockResolvedValueOnce({
        Contents: [
          { Key: 'staging/forms/123/lease1/file1.pdf' },
          { Key: 'staging/forms/123/lease1/file2.pdf' }
        ],
        IsTruncated: true,
        NextContinuationToken: 'token-abc',
        KeyCount: 2
      });

      const mockClient = { send: mockSend };
      const originalClient = s3Provider.client;
      s3Provider.client = mockClient;

      try {
        const result = await s3Provider.listObjectsByPrefix('staging/forms/123/', { maxKeys: 10 });
        expect(mockSend).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Prefix: 'staging/forms/123/',
              MaxKeys: 10
            })
          }),
          expect.any(Object)
        );
        expect(result.keys).toEqual([
          'staging/forms/123/lease1/file1.pdf',
          'staging/forms/123/lease1/file2.pdf'
        ]);
        expect(result.isTruncated).toBe(true);
        expect(result.nextContinuationToken).toBe('token-abc');
      } finally {
        s3Provider.client = originalClient;
      }
    });

    it('sends CopyObjectCommand and returns destinationKey on copyFile', async () => {
      const mockSend = vi.fn().mockResolvedValueOnce({});
      const mockClient = { send: mockSend };
      const originalClient = s3Provider.client;
      s3Provider.client = mockClient;

      try {
        const result = await s3Provider.copyFile(
          'staging/forms/123/lease1/file1.pdf',
          'forms/123/responses/file1.pdf',
          { contentType: 'application/pdf' }
        );
        expect(mockSend).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Key: 'forms/123/responses/file1.pdf',
              ContentType: 'application/pdf'
            })
          }),
          expect.any(Object)
        );
        expect(result).toBe('forms/123/responses/file1.pdf');
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

      await expect(
        provider.uploadFile(Buffer.from('data'), 'test.pdf', 'application/pdf')
      ).rejects.toThrow(/Missing credentials\/config in production environment/);
      await expect(provider.getFileStream('test.pdf')).rejects.toThrow(
        /Missing credentials\/config in production environment/
      );
      await expect(provider.getPresignedUrl('test.pdf')).rejects.toThrow(
        /Missing credentials\/config in production environment/
      );
      await expect(provider.deleteFile('test.pdf')).rejects.toThrow(
        /Missing credentials\/config in production environment/
      );
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

      await expect(
        provider.uploadFile(Buffer.from('data'), 'test.pdf', 'application/pdf')
      ).rejects.toThrow(/Missing credentials\/config in staging environment/);
      await expect(provider.getFileStream('test.pdf')).rejects.toThrow(
        /Missing credentials\/config in staging environment/
      );
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

      const uploadResult = await provider.uploadFile(
        Buffer.from('data'),
        'test.pdf',
        'application/pdf'
      );
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
      expect(result).toEqual({
        ok: false,
        status: 'bucket_access_denied',
        error: 'bucket_access_denied'
      });
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

  describe('S3StorageProvider - deleteFiles batch deletion', () => {
    it('handles empty, null, or undefined key inputs gracefully without calling S3', async () => {
      const mockSend = vi.fn();
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.client = { send: mockSend };

      const r1 = await provider.deleteFiles([]);
      expect(r1).toEqual({ success: true, deletedKeys: [], failedKeys: [], totalRequested: 0 });

      const r2 = await provider.deleteFiles(null);
      expect(r2).toEqual({ success: true, deletedKeys: [], failedKeys: [], totalRequested: 0 });

      const r3 = await provider.deleteFiles(undefined);
      expect(r3).toEqual({ success: true, deletedKeys: [], failedKeys: [], totalRequested: 0 });

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('filters out falsy, non-string, or blank keys and deduplicates keys', async () => {
      const mockSend = vi.fn().mockResolvedValueOnce({
        Deleted: [{ Key: 'k1' }, { Key: 'k2' }]
      });
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'test-bucket';
      provider.client = { send: mockSend };

      const result = await provider.deleteFiles([
        'k1',
        'k1',
        '',
        '   ',
        null,
        undefined,
        123,
        '  k2  '
      ]);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const command = mockSend.mock.calls[0][0];
      expect(command.input.Delete.Objects).toEqual([{ Key: 'k1' }, { Key: 'k2' }]);
      expect(result.totalRequested).toBe(2);
      expect(result.deletedKeys).toEqual(['k1', 'k2']);
      expect(result.success).toBe(true);
    });

    it('deletes batch of <= 1000 keys in a single DeleteObjectsCommand', async () => {
      const mockSend = vi.fn().mockResolvedValueOnce({
        Deleted: [{ Key: 'k1' }, { Key: 'k2' }]
      });
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'test-bucket';
      provider.client = { send: mockSend };

      const result = await provider.deleteFiles(['k1', 'k2']);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.deletedKeys).toEqual(['k1', 'k2']);
      expect(result.failedKeys).toEqual([]);
      expect(result.totalRequested).toBe(2);
    });

    it('splits requests into chunks of 1000 when keys exceed 1000', async () => {
      const totalKeys = 2050;
      const allKeys = Array.from({ length: totalKeys }, (_, i) => `key-${i}`);

      const mockSend = vi.fn().mockImplementation((command) => {
        const keysInChunk = command.input.Delete.Objects.map((o) => ({ Key: o.Key }));
        return Promise.resolve({ Deleted: keysInChunk });
      });

      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'test-bucket';
      provider.client = { send: mockSend };

      const result = await provider.deleteFiles(allKeys);

      // 2050 keys should chunk into 1000 + 1000 + 50 = 3 chunks
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(mockSend.mock.calls[0][0].input.Delete.Objects.length).toBe(1000);
      expect(mockSend.mock.calls[1][0].input.Delete.Objects.length).toBe(1000);
      expect(mockSend.mock.calls[2][0].input.Delete.Objects.length).toBe(50);
      expect(result.totalRequested).toBe(2050);
      expect(result.deletedKeys.length).toBe(2050);
      expect(result.failedKeys.length).toBe(0);
      expect(result.success).toBe(true);
    });

    it('handles partial failures returned by S3 in response.Errors', async () => {
      const mockSend = vi.fn().mockResolvedValueOnce({
        Deleted: [{ Key: 'file-success.pdf' }],
        Errors: [{ Key: 'file-locked.pdf', Code: 'AccessDenied', Message: 'Access Denied' }]
      });
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'test-bucket';
      provider.client = { send: mockSend };

      const result = await provider.deleteFiles(['file-success.pdf', 'file-locked.pdf']);

      expect(result.success).toBe(false);
      expect(result.deletedKeys).toEqual(['file-success.pdf']);
      expect(result.failedKeys).toEqual([
        { key: 'file-locked.pdf', error: 'Access Denied', code: 'AccessDenied' }
      ]);
      expect(result.totalRequested).toBe(2);
    });

    it('handles chunk-level network or authorization rejection without crashing', async () => {
      const mockSend = vi.fn().mockRejectedValueOnce(new Error('S3 connection reset'));
      const provider = new S3StorageProvider();
      provider.isMock = false;
      provider.bucket = 'test-bucket';
      provider.client = { send: mockSend };

      const result = await provider.deleteFiles(['file1.pdf', 'file2.pdf']);

      expect(result.success).toBe(false);
      expect(result.deletedKeys).toEqual([]);
      expect(result.failedKeys).toEqual([
        { key: 'file1.pdf', error: 'S3 connection reset', code: 'Error' },
        { key: 'file2.pdf', error: 'S3 connection reset', code: 'Error' }
      ]);
      expect(result.totalRequested).toBe(2);
    });

    it('operates in mock mode when unconfigured in dev/test environment', async () => {
      const provider = new S3StorageProvider();
      provider.client = null;
      provider.isMock = true;

      const result = await provider.deleteFiles(['mock1.pdf', 'mock2.pdf']);
      expect(result.success).toBe(true);
      expect(result.deletedKeys).toEqual(['mock1.pdf', 'mock2.pdf']);
      expect(result.failedKeys).toEqual([]);
      expect(result.totalRequested).toBe(2);
    });

    it('rejects in production when credentials are unconfigured', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.S3_REGION;
      delete process.env.S3_BUCKET;
      delete process.env.S3_ACCESS_KEY_ID;
      delete process.env.S3_SECRET_ACCESS_KEY;

      const provider = new S3StorageProvider();
      await expect(provider.deleteFiles(['file1.pdf'])).rejects.toThrow(
        /Missing credentials\/config in production environment/
      );
    });

    it('delegates deleteFiles from StorageService to s3Provider', async () => {
      const mockResult = { success: true, deletedKeys: ['k1'], failedKeys: [], totalRequested: 1 };
      const spy = vi.spyOn(s3Provider, 'deleteFiles').mockResolvedValueOnce(mockResult);

      const res = await storageService.deleteFiles(['k1']);
      expect(spy).toHaveBeenCalledWith(['k1']);
      expect(res).toBe(mockResult);
    });
  });

  describe('Stage 4.3.5 Batch C: Command Timeouts and Graceful Teardown', () => {
    it('defines bounded default S3 command timeouts', () => {
      expect(S3_DEFAULT_TIMEOUTS).toBeDefined();
      expect(S3_DEFAULT_TIMEOUTS.UPLOAD_TIMEOUT_MS).toBe(30000);
      expect(S3_DEFAULT_TIMEOUTS.DELETE_TIMEOUT_MS).toBe(15000);
      expect(S3_DEFAULT_TIMEOUTS.GET_TIMEOUT_MS).toBe(30000);
    });

    it('delegates destroy from StorageService to s3Provider', async () => {
      const spy = vi.spyOn(s3Provider, 'destroy').mockResolvedValueOnce();
      await storageService.destroy();
      expect(spy).toHaveBeenCalled();
    });

    it('S3StorageProvider destroy destroys active client and nulls client reference', async () => {
      const provider = new S3StorageProvider();
      const mockClient = {
        destroy: vi.fn().mockResolvedValue()
      };
      provider.client = mockClient;

      await provider.destroy();

      expect(mockClient.destroy).toHaveBeenCalledTimes(1);
      expect(provider.client).toBeNull();
    });

    it('passes abortSignal to client.send in uploadFile, deleteFile, deleteFiles, and getFileStream', async () => {
      const provider = new S3StorageProvider();
      const mockSend = vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'DeleteObjectsCommand') {
          return { Deleted: [{ Key: 'test.pdf' }], Errors: [] };
        }
        if (command.constructor.name === 'GetObjectCommand') {
          return { Body: 'mock-body', ContentType: 'application/pdf', ContentLength: 9 };
        }
        return {};
      });

      provider.client = { send: mockSend };
      provider.isMock = false;

      // 1. uploadFile
      await provider.uploadFile(Buffer.from('test'), 'upload.pdf', 'application/pdf');
      expect(mockSend).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ abortSignal: expect.anything() })
      );

      // 2. deleteFile
      await provider.deleteFile('delete.pdf');
      expect(mockSend).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ abortSignal: expect.anything() })
      );

      // 3. deleteFiles
      await provider.deleteFiles(['test.pdf']);
      expect(mockSend).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ abortSignal: expect.anything() })
      );

      // 4. getFileStream
      await provider.getFileStream('get.pdf');
      expect(mockSend).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ abortSignal: expect.anything() })
      );
    });

    it('aborts GetObjectCommand and throws TimeoutError when S3 acquisition exceeds timeoutMs', async () => {
      const provider = new S3StorageProvider();
      provider.isMock = false;

      const mockSend = vi.fn().mockImplementation((_command, { abortSignal }) => {
        return new Promise((_resolve, reject) => {
          if (abortSignal.aborted) {
            return reject(abortSignal.reason);
          }
          abortSignal.addEventListener('abort', () => {
            reject(abortSignal.reason);
          });
        });
      });
      provider.client = { send: mockSend };

      await expect(provider.getFileStream('test.pdf', { timeoutMs: 20 })).rejects.toThrow(
        /timed out after 20ms/
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('clears command acquisition timer so body stream remains open past acquisition timeout', async () => {
      const provider = new S3StorageProvider();
      provider.isMock = false;

      const bodyStream = new Readable({ read() {} });
      const mockSend = vi.fn().mockResolvedValue({
        Body: bodyStream,
        ContentType: 'application/pdf',
        ContentLength: 1000
      });
      provider.client = { send: mockSend };

      const result = await provider.getFileStream('test.pdf', { timeoutMs: 25 });
      expect(result.stream).toBe(bodyStream);

      // Wait 50ms (past the 25ms acquisition timeout)
      await new Promise((r) => setTimeout(r, 50));

      // The stream must not be destroyed by the acquisition timeout
      expect(result.stream.destroyed).toBe(false);
      bodyStream.destroy();
    });

    describe('Stage 4.3.6.1: Delete Operations Abort Signal Propagation', () => {
      it('deleteFile forwards caller abortSignal and aborts when caller signal is pre-aborted', async () => {
        const provider = new S3StorageProvider();
        provider.isMock = false;

        const callerController = new AbortController();
        callerController.abort(new Error('Pre-aborted delete'));

        const mockSend = vi.fn().mockImplementation((_cmd, { abortSignal }) => {
          if (abortSignal?.aborted) {
            return Promise.reject(abortSignal.reason);
          }
          return Promise.resolve({});
        });
        provider.client = { send: mockSend };

        await expect(
          provider.deleteFile('cancel.pdf', { abortSignal: callerController.signal })
        ).rejects.toThrow('Pre-aborted delete');

        expect(mockSend).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ abortSignal: expect.objectContaining({ aborted: true }) })
        );
      });

      it('deleteFile aborts when caller abortSignal is triggered in flight', async () => {
        const provider = new S3StorageProvider();
        provider.isMock = false;

        const callerController = new AbortController();
        const mockSend = vi.fn().mockImplementation((_cmd, { abortSignal }) => {
          return new Promise((_resolve, reject) => {
            abortSignal?.addEventListener('abort', () => {
              reject(abortSignal.reason);
            });
          });
        });
        provider.client = { send: mockSend };

        const deletePromise = provider.deleteFile('slow.pdf', {
          abortSignal: callerController.signal,
          timeoutMs: 5000
        });

        setTimeout(() => {
          callerController.abort(new Error('Caller cancelled delete mid-flight'));
        }, 20);

        await expect(deletePromise).rejects.toThrow('Caller cancelled delete mid-flight');
      });

      it('deleteFile aborts and throws TimeoutError when delete exceeds timeoutMs', async () => {
        const provider = new S3StorageProvider();
        provider.isMock = false;

        const mockSend = vi.fn().mockImplementation((_cmd, { abortSignal }) => {
          return new Promise((_resolve, reject) => {
            abortSignal?.addEventListener('abort', () => {
              reject(abortSignal.reason);
            });
          });
        });
        provider.client = { send: mockSend };

        await expect(provider.deleteFile('hung.pdf', { timeoutMs: 25 })).rejects.toThrow(
          /timed out after 25ms/
        );
      });

      it('deleteFiles forwards caller abortSignal to DeleteObjectsCommand', async () => {
        const provider = new S3StorageProvider();
        provider.isMock = false;

        const callerController = new AbortController();
        let passedSignal = null;

        const mockSend = vi.fn().mockImplementation((_cmd, { abortSignal }) => {
          passedSignal = abortSignal;
          return Promise.resolve({ Deleted: [{ Key: 'k1' }], Errors: [] });
        });
        provider.client = { send: mockSend };

        const result = await provider.deleteFiles(['k1'], { abortSignal: callerController.signal });
        expect(result.success).toBe(true);
        expect(result.deletedKeys).toEqual(['k1']);
        expect(passedSignal).not.toBeNull();
        expect(passedSignal.aborted).toBe(false);
      });

      it('deleteFiles marks all keys aborted when pre-aborted signal is supplied without sending S3 requests', async () => {
        const provider = new S3StorageProvider();
        provider.isMock = false;

        const callerController = new AbortController();
        callerController.abort(new Error('Pre-aborted batch'));

        const mockSend = vi.fn();
        provider.client = { send: mockSend };

        const result = await provider.deleteFiles(['k1', 'k2'], {
          abortSignal: callerController.signal
        });

        expect(result.success).toBe(false);
        expect(result.deletedKeys).toEqual([]);
        expect(result.failedKeys).toHaveLength(2);
        expect(result.failedKeys[0]).toMatchObject({
          key: 'k1',
          error: 'Pre-aborted batch',
          code: 'AbortError'
        });
        expect(result.failedKeys[1]).toMatchObject({
          key: 'k2',
          error: 'Pre-aborted batch',
          code: 'AbortError'
        });
        // S3 client should never have been invoked
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('deleteFiles handles mid-flight caller abort and marks remaining chunks as aborted', async () => {
        const provider = new S3StorageProvider();
        provider.isMock = false;

        const callerController = new AbortController();
        const mockSend = vi.fn().mockImplementation((cmd, { abortSignal }) => {
          // If chunk has k1, abort callerController and throw AbortError
          return new Promise((_resolve, reject) => {
            callerController.abort(new Error('Caller cancelled during chunk 1'));
            if (abortSignal?.aborted) {
              return reject(abortSignal.reason);
            }
            abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
          });
        });
        provider.client = { send: mockSend };

        const result = await provider.deleteFiles(['k1', 'k2'], {
          abortSignal: callerController.signal
        });

        expect(result.success).toBe(false);
        expect(result.failedKeys).toHaveLength(2);
        expect(result.failedKeys.map((f) => f.code)).toEqual(['AbortError', 'AbortError']);
      });

      it('storageService delegates signal options to s3Provider deleteFile and deleteFiles', async () => {
        const deleteFileSpy = vi.spyOn(s3Provider, 'deleteFile').mockResolvedValueOnce();
        const deleteFilesSpy = vi.spyOn(s3Provider, 'deleteFiles').mockResolvedValueOnce({
          success: true,
          deletedKeys: ['k1'],
          failedKeys: [],
          totalRequested: 1
        });

        const controller = new AbortController();
        await storageService.deleteFile('f.pdf', { signal: controller.signal });
        expect(deleteFileSpy).toHaveBeenCalledWith('f.pdf', { signal: controller.signal });

        await storageService.deleteFiles(['k1'], { abortSignal: controller.signal });
        expect(deleteFilesSpy).toHaveBeenCalledWith(['k1'], { abortSignal: controller.signal });
      });
    });
  });
});
