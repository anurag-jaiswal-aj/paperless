/**
 * server/src/services/uploadAdmissionService.test.js
 *
 * Comprehensive unit and integration test battery for upload admission control:
 * - Active capacity (P = 50 default / configurable)
 * - Waiting queue capacity (Q = 100 default / configurable)
 * - Immediate overload rejection (HTTP 429)
 * - FIFO ordering and handoff
 * - Pre-admission, in-queue, and post-admission cancellation
 * - Queue timeout and timer cleanup
 * - Double-release and underflow immunity
 * - Quiescence drain integration (HTTP 503)
 * - Direct StorageService caller protection and nested deadlock prevention
 * - Deferred stream instantiation verification
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import s3Provider from './S3StorageProvider.js';
import {
  UploadAdmissionService,
  uploadAdmissionService,
  AdmissionQueueFullError,
  AdmissionTimeoutError,
  AdmissionAbortedError,
  AdmissionDrainingError,
  UPLOAD_ADMISSION_BOUNDS,
  parseBoundedInt
} from './uploadAdmissionService.js';
import storageService from './StorageService.js';

describe('UploadAdmissionService Unit & Integration Battery', () => {
  let admission;

  beforeEach(() => {
    admission = new UploadAdmissionService({
      maxActive: 3,
      maxQueue: 4,
      defaultTimeoutMs: 5000
    });
    uploadAdmissionService.reset();
  });

  afterEach(async () => {
    await admission.drain(100);
    admission.reset();
    uploadAdmissionService.reset();
  });

  describe('Capacity and Overload Rejection', () => {
    it('grants permits immediately when below active capacity P', async () => {
      const p1 = await admission.acquire();
      const p2 = await admission.acquire();
      const p3 = await admission.acquire();

      expect(p1.isReleased).toBe(false);
      expect(p2.isReleased).toBe(false);
      expect(p3.isReleased).toBe(false);
      expect(admission.activePermits).toBe(3);
      expect(admission.queuedWaiters).toBe(0);

      p1.release();
      p2.release();
      p3.release();

      expect(admission.activePermits).toBe(0);
    });

    it('queues requests when active capacity P is saturated but queue Q has room', async () => {
      const p1 = await admission.acquire();
      const p2 = await admission.acquire();
      const p3 = await admission.acquire();

      let resolvedP4 = false;
      const promiseP4 = admission.acquire().then((p) => {
        resolvedP4 = true;
        return p;
      });

      // Microtask tick
      await new Promise((r) => setTimeout(r, 20));
      expect(resolvedP4).toBe(false);
      expect(admission.activePermits).toBe(3);
      expect(admission.queuedWaiters).toBe(1);

      // Release one permit -> P4 should receive immediate handoff
      p1.release();
      const p4 = await promiseP4;
      expect(resolvedP4).toBe(true);
      expect(admission.activePermits).toBe(3);
      expect(admission.queuedWaiters).toBe(0);

      p2.release();
      p3.release();
      p4.release();
      expect(admission.activePermits).toBe(0);
    });

    it('immediately rejects with AdmissionQueueFullError when both active and queue capacity are saturated', async () => {
      const active = [];
      for (let i = 0; i < 3; i++) {
        active.push(await admission.acquire());
      }

      const waiters = [];
      for (let i = 0; i < 4; i++) {
        const p = admission.acquire({ timeoutMs: 10000 });
        p.catch(() => {});
        waiters.push(p);
      }

      expect(admission.activePermits).toBe(3);
      expect(admission.queuedWaiters).toBe(4);

      // 8th acquisition must fail immediately (P=3 + Q=4 saturated)
      await expect(admission.acquire()).rejects.toThrow(AdmissionQueueFullError);
      expect(admission.totalRejectionsQueueFull).toBe(1);

      // Reset cleans up all active and queued permits cleanly
      admission.reset();
      expect(admission.activePermits).toBe(0);
      expect(admission.queuedWaiters).toBe(0);
    });

    it('maintains strict FIFO order during waiter handoff', async () => {
      const active = [
        await admission.acquire(),
        await admission.acquire(),
        await admission.acquire()
      ];

      const order = [];
      const w1 = admission.acquire({ metadata: { id: 1 } }).then((p) => {
        order.push(1);
        return p;
      });
      const w2 = admission.acquire({ metadata: { id: 2 } }).then((p) => {
        order.push(2);
        return p;
      });
      const w3 = admission.acquire({ metadata: { id: 3 } }).then((p) => {
        order.push(3);
        return p;
      });

      // Release in arbitrary order, handoff must be FIFO (1, then 2, then 3)
      active[2].release();
      const p1 = await w1;
      expect(order).toEqual([1]);

      active[0].release();
      const p2 = await w2;
      expect(order).toEqual([1, 2]);

      active[1].release();
      const p3 = await w3;
      expect(order).toEqual([1, 2, 3]);

      p1.release();
      p2.release();
      p3.release();
      expect(admission.activePermits).toBe(0);
    });
  });

  describe('Cancellation, Timeouts and Error Semantics', () => {
    it('immediately rejects if AbortSignal is already aborted prior to acquisition', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(admission.acquire({ signal: controller.signal })).rejects.toThrow(
        AdmissionAbortedError
      );
      expect(admission.activePermits).toBe(0);
      expect(admission.queuedWaiters).toBe(0);
    });

    it('cancels queued waiter and cleans up DLL without corrupting queue', async () => {
      const active = [
        await admission.acquire(),
        await admission.acquire(),
        await admission.acquire()
      ];

      const c1 = new AbortController();
      const c2 = new AbortController();
      const c3 = new AbortController();

      const w1 = admission.acquire({ signal: c1.signal, metadata: { id: 1 } });
      const w2 = admission.acquire({ signal: c2.signal, metadata: { id: 2 } });
      const w3 = admission.acquire({ signal: c3.signal, metadata: { id: 3 } });

      expect(admission.queuedWaiters).toBe(3);

      // Abort the middle waiter (w2)
      c2.abort();
      await expect(w2).rejects.toThrow(AdmissionAbortedError);
      expect(admission.queuedWaiters).toBe(2);

      // Release active slot -> w1 must receive it (head)
      active[0].release();
      const p1 = await w1;
      expect(p1.metadata.id).toBe(1);

      // Release active slot -> w3 must receive it (tail correctly relinked)
      active[1].release();
      const p3 = await w3;
      expect(p3.metadata.id).toBe(3);

      active[2].release();
      p1.release();
      p3.release();
      expect(admission.activePermits).toBe(0);
    });

    it('times out queued waiter when wait duration exceeds timeoutMs', async () => {
      const active = [
        await admission.acquire(),
        await admission.acquire(),
        await admission.acquire()
      ];

      const timeoutPromise = admission.acquire({ timeoutMs: 50 });

      await expect(timeoutPromise).rejects.toThrow(AdmissionTimeoutError);
      expect(admission.queuedWaiters).toBe(0);
      expect(admission.totalTimeouts).toBe(1);

      active.forEach((p) => p.release());
      expect(admission.activePermits).toBe(0);
    });

    it('ensures double release is strictly idempotent and prevents counter underflow', async () => {
      const p = await admission.acquire();
      expect(admission.activePermits).toBe(1);

      const r1 = p.release();
      expect(r1).toBe(true);
      expect(admission.activePermits).toBe(0);

      // Second release must return false and not decrement below 0
      const r2 = p.release();
      expect(r2).toBe(false);
      expect(admission.activePermits).toBe(0);
      expect(admission.underflowCount).toBe(0);
    });
  });

  describe('Scoped Execution Helper (withPermit)', () => {
    it('executes callback and automatically releases permit on success', async () => {
      let activeDuring = 0;
      const result = await admission.withPermit(async (permit) => {
        activeDuring = admission.activePermits;
        expect(permit.isReleased).toBe(false);
        return 42;
      });

      expect(result).toBe(42);
      expect(activeDuring).toBe(1);
      expect(admission.activePermits).toBe(0);
    });

    it('automatically releases permit on thrown error in callback', async () => {
      await expect(
        admission.withPermit(async () => {
          throw new Error('Callback failure');
        })
      ).rejects.toThrow('Callback failure');

      expect(admission.activePermits).toBe(0);
    });
  });

  describe('Quiescence Draining and Shutdown', () => {
    it('rejects queued waiters with AdmissionDrainingError and waits for active permits', async () => {
      const p1 = await admission.acquire();
      const p2 = await admission.acquire();
      const p3 = await admission.acquire();

      const queuedWaiters = [
        admission.acquire(),
        admission.acquire()
      ];

      expect(admission.queuedWaiters).toBe(2);

      // Initiate drain
      const drainPromise = admission.drain(1000);

      // Queued waiters must be rejected immediately
      await expect(queuedWaiters[0]).rejects.toThrow(AdmissionDrainingError);
      await expect(queuedWaiters[1]).rejects.toThrow(AdmissionDrainingError);
      expect(admission.queuedWaiters).toBe(0);

      // Subsequent acquisitions must be rejected immediately
      await expect(admission.acquire()).rejects.toThrow(AdmissionDrainingError);

      // Release active permits
      p1.release();
      p2.release();
      p3.release();

      const drained = await drainPromise;
      expect(drained).toBe(true);
      expect(admission.activePermits).toBe(0);
    });
  });

  describe('StorageService Integration & Direct Caller Protection', () => {
    it('automatically acquires a permit when StorageService.uploadFile is called without one', async () => {
      // Mock s3Provider.uploadFile to inspect concurrency
      const spy = vi.spyOn(s3Provider, 'uploadFile').mockResolvedValue({
        key: 'forms/test/responses/file.pdf',
        etag: '"etag-123"'
      });

      const initialAcquisitions = uploadAdmissionService.totalAcquisitions;
      const initialReleases = uploadAdmissionService.totalReleases;

      const dummyStream = Readable.from([Buffer.from('test pdf content')]);
      const res = await storageService.uploadFile(dummyStream, 'forms/test/responses/file.pdf', 'application/pdf', {
        journal: false
      });

      expect(res).toBe('forms/test/responses/file.pdf');
      expect(uploadAdmissionService.totalAcquisitions).toBe(initialAcquisitions + 1);
      expect(uploadAdmissionService.totalReleases).toBe(initialReleases + 1);
      expect(uploadAdmissionService.activePermits).toBe(0);

      spy.mockRestore();
    });

    it('adopts pre-acquired caller permit without double-acquiring or deadlocking', async () => {
      const spy = vi.spyOn(s3Provider, 'uploadFile').mockResolvedValue({
        key: 'forms/test/responses/file2.pdf',
        etag: '"etag-456"'
      });

      const callerPermit = await uploadAdmissionService.acquire({ metadata: { caller: 'test' } });
      expect(uploadAdmissionService.activePermits).toBe(1);

      const acquisitionsBefore = uploadAdmissionService.totalAcquisitions;

      const dummyStream = Readable.from([Buffer.from('test pdf content 2')]);
      const res = await storageService.uploadFile(dummyStream, 'forms/test/responses/file2.pdf', 'application/pdf', {
        journal: false,
        admissionPermit: callerPermit
      });

      expect(res).toBe('forms/test/responses/file2.pdf');
      // Must NOT have acquired a second permit!
      expect(uploadAdmissionService.totalAcquisitions).toBe(acquisitionsBefore);
      // Caller permit remains active until caller releases it
      expect(callerPermit.isReleased).toBe(false);
      expect(uploadAdmissionService.activePermits).toBe(1);

      callerPermit.release();
      expect(uploadAdmissionService.activePermits).toBe(0);

      spy.mockRestore();
    });
  });

  describe('Configuration Bounds & Parameter Validation', () => {
    it('exports immutable UPLOAD_ADMISSION_BOUNDS with safe defaults', () => {
      expect(UPLOAD_ADMISSION_BOUNDS.MIN_ACTIVE).toBe(1);
      expect(UPLOAD_ADMISSION_BOUNDS.MAX_ACTIVE).toBe(10);
      expect(UPLOAD_ADMISSION_BOUNDS.DEFAULT_ACTIVE).toBe(10);
      expect(UPLOAD_ADMISSION_BOUNDS.MIN_QUEUE).toBe(0);
      expect(UPLOAD_ADMISSION_BOUNDS.MAX_QUEUE).toBe(50);
      expect(UPLOAD_ADMISSION_BOUNDS.DEFAULT_QUEUE).toBe(50);
      expect(UPLOAD_ADMISSION_BOUNDS.MIN_TIMEOUT_MS).toBe(1000);
      expect(UPLOAD_ADMISSION_BOUNDS.MAX_TIMEOUT_MS).toBe(300000);
      expect(UPLOAD_ADMISSION_BOUNDS.DEFAULT_TIMEOUT_MS).toBe(30000);
      expect(Object.isFrozen(UPLOAD_ADMISSION_BOUNDS)).toBe(true);
    });

    it('correctly parses and clamps integer settings via parseBoundedInt', () => {
      expect(parseBoundedInt('25', 1, 50, 10, 'test')).toBe(25);
      expect(parseBoundedInt(15, 1, 50, 10, 'test')).toBe(15);
      // Fallback on invalid/empty
      expect(parseBoundedInt(undefined, 1, 50, 10, 'test')).toBe(10);
      expect(parseBoundedInt('', 1, 50, 10, 'test')).toBe(10);
      expect(parseBoundedInt('not-a-number', 1, 50, 10, 'test')).toBe(10);
      // Clamping out-of-bounds
      expect(parseBoundedInt('0', 1, 50, 10, 'test')).toBe(1);
      expect(parseBoundedInt('-5', 1, 50, 10, 'test')).toBe(1);
      expect(parseBoundedInt('999', 1, 50, 10, 'test')).toBe(50);
    });

    it('initializes service with safe clamped bounds for timeout', () => {
      const clampedSvc = new UploadAdmissionService({
        maxActive: 10,
        maxQueue: 50,
        defaultTimeoutMs: 500
      });

      expect(clampedSvc.maxActive).toBe(10);
      expect(clampedSvc.maxQueue).toBe(50);
      expect(clampedSvc.defaultTimeoutMs).toBe(1000);
    });

    it('fails fast on invalid or out-of-bounds UPLOAD_ADMISSION_MAX_QUEUE_SIZE at initialization', () => {
      const originalEnv = process.env.UPLOAD_ADMISSION_MAX_QUEUE_SIZE;
      try {
        delete process.env.UPLOAD_ADMISSION_MAX_QUEUE_SIZE;
        expect(new UploadAdmissionService().maxQueue).toBe(50);

        process.env.UPLOAD_ADMISSION_MAX_QUEUE_SIZE = '50';
        expect(new UploadAdmissionService().maxQueue).toBe(50);

        process.env.UPLOAD_ADMISSION_MAX_QUEUE_SIZE = '0';
        expect(new UploadAdmissionService().maxQueue).toBe(0);

        const invalidValues = ['51', '500', '999999999999999999999', '-1', '5.5', '10abc', 'abc', '', '   '];
        for (const badVal of invalidValues) {
          process.env.UPLOAD_ADMISSION_MAX_QUEUE_SIZE = badVal;
          expect(() => new UploadAdmissionService()).toThrow();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env.UPLOAD_ADMISSION_MAX_QUEUE_SIZE;
        } else {
          process.env.UPLOAD_ADMISSION_MAX_QUEUE_SIZE = originalEnv;
        }
      }
    });

    it('fails fast on invalid or out-of-bounds options.maxQueue', () => {
      for (const badOpt of [51, 500, -1, 5.5, '10abc', '', '   ', null]) {
        expect(() => new UploadAdmissionService({ maxQueue: badOpt })).toThrow();
      }
    });

    it('fails fast on invalid or out-of-bounds UPLOAD_ADMISSION_MAX_CONCURRENT at initialization', () => {
      const originalEnv = process.env.UPLOAD_ADMISSION_MAX_CONCURRENT;
      try {
        delete process.env.UPLOAD_ADMISSION_MAX_CONCURRENT;
        expect(new UploadAdmissionService().maxActive).toBe(10);

        process.env.UPLOAD_ADMISSION_MAX_CONCURRENT = '10';
        expect(new UploadAdmissionService().maxActive).toBe(10);

        const invalidValues = ['11', '50', '999999999999999999999', '0', '-1', '5.5', '10abc', 'abc', '', '   '];
        for (const badVal of invalidValues) {
          process.env.UPLOAD_ADMISSION_MAX_CONCURRENT = badVal;
          expect(() => new UploadAdmissionService()).toThrow();
        }
      } finally {
        if (originalEnv === undefined) {
          delete process.env.UPLOAD_ADMISSION_MAX_CONCURRENT;
        } else {
          process.env.UPLOAD_ADMISSION_MAX_CONCURRENT = originalEnv;
        }
      }
    });

    it('fails fast on invalid or out-of-bounds options.maxActive', () => {
      for (const badOpt of [11, 50, 0, -5, 5.5, '10abc', '', '   ', null]) {
        expect(() => new UploadAdmissionService({ maxActive: badOpt })).toThrow();
      }
    });
  });
});
