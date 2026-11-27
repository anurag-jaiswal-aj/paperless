/**
 * server/src/services/uploadAdmissionService.js
 *
 * Enforces finite active concurrency (P) and bounded FIFO waiting (Q) for file uploads.
 * Eliminates unbounded memory retention and event-loop queue bloat under burst upload traffic.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export class AdmissionError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class AdmissionQueueFullError extends AdmissionError {
  constructor(message = 'Upload admission queue is full. Please retry shortly.') {
    super(message, 'ERR_UPLOAD_ADMISSION_QUEUE_FULL', 429);
  }
}

export class AdmissionTimeoutError extends AdmissionError {
  constructor(message = 'Timed out waiting for upload admission permit.') {
    super(message, 'ERR_UPLOAD_ADMISSION_TIMEOUT', 504);
  }
}

export class AdmissionAbortedError extends AdmissionError {
  constructor(message = 'Upload admission request was canceled by client.') {
    super(message, 'ERR_UPLOAD_ADMISSION_ABORTED', 499);
  }
}

export class AdmissionDrainingError extends AdmissionError {
  constructor(message = 'Upload admission rejected: server is shutting down or draining.') {
    super(message, 'ERR_UPLOAD_ADMISSION_DRAINING', 503);
  }
}

export class AdmissionInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdmissionInvariantError';
  }
}

/**
 * Intrusive Doubly-Linked List Node for O(1) Queue Operations.
 */
class WaiterNode {
  constructor(permitId, resolve, reject, options, enqueuedAt) {
    this.permitId = permitId;
    this.resolve = resolve;
    this.reject = reject;
    this.options = options || {};
    this.enqueuedAt = enqueuedAt;
    this.timeoutId = null;
    this.abortListener = null;
    this.prev = null;
    this.next = null;
    this.settled = false;
  }

  unlink() {
    if (this.prev) this.prev.next = this.next;
    if (this.next) this.next.prev = this.prev;
    this.prev = null;
    this.next = null;
  }
}

/**
 * Sealed capability token representing an active upload permit.
 */
export class UploadPermit {
  #service;
  #permitId;
  #acquiredAt;
  #waitDurationMs;
  #metadata;
  #released = false;

  constructor(service, permitId, acquiredAt, waitDurationMs, metadata = {}) {
    this.#service = service;
    this.#permitId = permitId;
    this.#acquiredAt = acquiredAt;
    this.#waitDurationMs = waitDurationMs;
    this.#metadata = Object.freeze({ ...metadata });
    Object.seal(this);
  }

  get permitId() { return this.#permitId; }
  get acquiredAt() { return this.#acquiredAt; }
  get waitDurationMs() { return this.#waitDurationMs; }
  get metadata() { return this.#metadata; }
  get isReleased() { return this.#released; }

  release() {
    if (this.#released) return false;
    this.#released = true;
    return this.#service._releasePermit(this.#permitId, this.#acquiredAt);
  }

  [Symbol.dispose]() {
    this.release();
  }

  async [Symbol.asyncDispose]() {
    this.release();
  }
}

/**
 * Configuration bounds and safe defaults for upload admission control.
 */
export const UPLOAD_ADMISSION_BOUNDS = Object.freeze({
  MIN_ACTIVE: 1,
  MAX_ACTIVE: 10,
  DEFAULT_ACTIVE: 10,
  MIN_QUEUE: 0,
  MAX_QUEUE: 50,
  DEFAULT_QUEUE: 50,
  MIN_TIMEOUT_MS: 1000,
  MAX_TIMEOUT_MS: 300000,
  DEFAULT_TIMEOUT_MS: 30000
});

/**
 * Validates and clamps an integer setting to explicit safety boundaries.
 */
export function parseBoundedInt(val, min, max, defaultVal, name) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed) || !Number.isInteger(parsed)) {
    logger.warn(`[UploadAdmission] Invalid integer for ${name}: "${val}". Falling back to default: ${defaultVal}`);
    return defaultVal;
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.max(min, Math.min(max, parsed));
    logger.warn(`[UploadAdmission] Value out of bounds for ${name}: ${parsed} (allowed: [${min}, ${max}]). Clamped to ${clamped}.`);
    return clamped;
  }
  return parsed;
}

/**
 * Strictly validates an integer setting against explicit resource-profile boundaries.
 * Fails fast with an actionable Error on empty, whitespace, non-numeric, fractional,
 * or out-of-bounds values.
 */
export function parseStrictBoundedInt(val, min, max, defaultVal, name) {
  if (val === undefined) return defaultVal;
  if (val === null) {
    throw new Error(`[UploadAdmission] ${name} cannot be null. Expected an integer in [${min}, ${max}].`);
  }
  let parsed;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') {
      throw new Error(`[UploadAdmission] ${name} cannot be empty or whitespace. Expected an integer in [${min}, ${max}].`);
    }
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(`[UploadAdmission] Invalid integer for ${name}: "${val}". Expected an integer in [${min}, ${max}].`);
    }
    parsed = Number(trimmed);
  } else if (typeof val === 'number') {
    parsed = val;
  } else {
    throw new Error(`[UploadAdmission] Invalid type for ${name}. Expected an integer in [${min}, ${max}].`);
  }

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`[UploadAdmission] ${name} ("${val}") is not a safe integer. Expected an integer in [${min}, ${max}].`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(
      `${name} (${parsed}) exceeds or violates the configured resource profile limit [${min}, ${max}]. ` +
      `Reduce the value or select a separately validated deployment profile.`
    );
  }
  return parsed;
}

/**
 * Core UploadAdmissionService Implementation.
 */
export class UploadAdmissionService extends EventEmitter {
  constructor(options = {}) {
    super();

    const envActive = parseStrictBoundedInt(
      process.env.UPLOAD_ADMISSION_MAX_CONCURRENT,
      UPLOAD_ADMISSION_BOUNDS.MIN_ACTIVE,
      UPLOAD_ADMISSION_BOUNDS.MAX_ACTIVE,
      UPLOAD_ADMISSION_BOUNDS.DEFAULT_ACTIVE,
      'UPLOAD_ADMISSION_MAX_CONCURRENT'
    );
    this.maxActive = options.maxActive !== undefined
      ? parseStrictBoundedInt(options.maxActive, UPLOAD_ADMISSION_BOUNDS.MIN_ACTIVE, UPLOAD_ADMISSION_BOUNDS.MAX_ACTIVE, envActive, 'options.maxActive')
      : envActive;

    const envQueue = parseStrictBoundedInt(
      process.env.UPLOAD_ADMISSION_MAX_QUEUE_SIZE,
      UPLOAD_ADMISSION_BOUNDS.MIN_QUEUE,
      UPLOAD_ADMISSION_BOUNDS.MAX_QUEUE,
      UPLOAD_ADMISSION_BOUNDS.DEFAULT_QUEUE,
      'UPLOAD_ADMISSION_MAX_QUEUE_SIZE'
    );
    this.maxQueue = options.maxQueue !== undefined
      ? parseStrictBoundedInt(options.maxQueue, UPLOAD_ADMISSION_BOUNDS.MIN_QUEUE, UPLOAD_ADMISSION_BOUNDS.MAX_QUEUE, envQueue, 'options.maxQueue')
      : envQueue;

    const envTimeout = parseBoundedInt(
      process.env.UPLOAD_ADMISSION_QUEUE_TIMEOUT_MS,
      UPLOAD_ADMISSION_BOUNDS.MIN_TIMEOUT_MS,
      UPLOAD_ADMISSION_BOUNDS.MAX_TIMEOUT_MS,
      UPLOAD_ADMISSION_BOUNDS.DEFAULT_TIMEOUT_MS,
      'UPLOAD_ADMISSION_QUEUE_TIMEOUT_MS'
    );
    this.defaultTimeoutMs = options.defaultTimeoutMs !== undefined && options.defaultTimeoutMs !== null
      ? parseBoundedInt(options.defaultTimeoutMs, UPLOAD_ADMISSION_BOUNDS.MIN_TIMEOUT_MS, UPLOAD_ADMISSION_BOUNDS.MAX_TIMEOUT_MS, envTimeout, 'options.defaultTimeoutMs')
      : envTimeout;

    // Concurrency & Queue Accounting
    this.activePermits = 0;
    this.queuedWaiters = 0;
    this.queueHead = null;
    this.queueTail = null;

    // State Tracking
    this.activePermitsMap = new Map();
    this.isDraining = false;

    // Cumulative Telemetry Counters
    this.totalAcquisitions = 0;
    this.totalReleases = 0;
    this.totalRejectionsQueueFull = 0;
    this.totalRejectionsDraining = 0;
    this.totalTimeouts = 0;
    this.totalAborts = 0;
    this.totalPermitsLeaked = 0;
    this.underflowCount = 0;
  }

  /**
   * Acquire an upload permit.
   *
   * @param {Object} [options={}]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.timeoutMs]
   * @param {Object} [options.metadata]
   * @returns {Promise<UploadPermit>}
   */
  async acquire(options = {}) {
    const { signal, timeoutMs, metadata = {} } = options;

    if (this.isDraining) {
      this.totalRejectionsDraining++;
      throw new AdmissionDrainingError();
    }

    if (signal?.aborted) {
      this.totalAborts++;
      throw new AdmissionAbortedError();
    }

    // Fast-path: Immediate grant if below active capacity
    if (this.activePermits < this.maxActive) {
      this.activePermits++;
      const permitId = crypto.randomUUID();
      const acquiredAt = Date.now();
      this.activePermitsMap.set(permitId, { acquiredAt, metadata });
      this.totalAcquisitions++;

      return new UploadPermit(this, permitId, acquiredAt, 0, metadata);
    }

    // Capacity full: Check if queue is saturated
    if (this.queuedWaiters >= this.maxQueue) {
      this.totalRejectionsQueueFull++;
      throw new AdmissionQueueFullError();
    }

    // Enqueue waiter
    return new Promise((resolve, reject) => {
      const permitId = crypto.randomUUID();
      const enqueuedAt = Date.now();
      const node = new WaiterNode(permitId, resolve, reject, options, enqueuedAt);

      // Append to DLL tail
      this._enqueue(node);
      this.queuedWaiters++;

      // Setup AbortSignal listener
      if (signal) {
        node.abortListener = () => {
          if (node.settled) return;
          node.settled = true;
          this._removeWaiter(node);
          this.totalAborts++;
          reject(new AdmissionAbortedError());
        };
        signal.addEventListener('abort', node.abortListener, { once: true });
      }

      // Setup Queue Timeout
      const effectiveTimeout = timeoutMs !== undefined && timeoutMs !== null
        ? timeoutMs
        : this.defaultTimeoutMs;

      if (effectiveTimeout > 0 && Number.isFinite(effectiveTimeout)) {
        node.timeoutId = setTimeout(() => {
          if (node.settled) return;
          node.settled = true;
          this._removeWaiter(node);
          this.totalTimeouts++;
          reject(new AdmissionTimeoutError());
        }, effectiveTimeout);

        node.timeoutId.unref?.();
      }
    });
  }

  /**
   * Scoped execution helper ensuring release in finally block.
   */
  async withPermit(options, fn) {
    if (typeof options === 'function') {
      fn = options;
      options = {};
    }
    const permit = await this.acquire(options);
    try {
      return await fn(permit);
    } finally {
      permit.release();
    }
  }

  /**
   * Internal release method called by UploadPermit.release().
   */
  _releasePermit(permitId) {
    if (!this.activePermitsMap.has(permitId)) {
      this.underflowCount++;
      return false;
    }

    this.activePermitsMap.delete(permitId);
    this.totalReleases++;

    // Try to hand off to next valid queued waiter
    while (this.queueHead) {
      const nextWaiter = this._dequeueHead();
      if (!nextWaiter || nextWaiter.settled) {
        continue;
      }

      nextWaiter.settled = true;
      if (nextWaiter.timeoutId) {
        clearTimeout(nextWaiter.timeoutId);
        nextWaiter.timeoutId = null;
      }
      if (nextWaiter.abortListener && nextWaiter.options.signal) {
        nextWaiter.options.signal.removeEventListener('abort', nextWaiter.abortListener);
        nextWaiter.abortListener = null;
      }

      const newPermitId = crypto.randomUUID();
      const now = Date.now();
      const waitDurationMs = now - nextWaiter.enqueuedAt;

      this.activePermitsMap.set(newPermitId, {
        acquiredAt: now,
        metadata: nextWaiter.options.metadata
      });
      this.totalAcquisitions++;

      const permit = new UploadPermit(
        this,
        newPermitId,
        now,
        waitDurationMs,
        nextWaiter.options.metadata
      );

      nextWaiter.resolve(permit);
      return true; // Active capacity handed off; count remains unchanged
    }

    // No queued waiters: decrement active count
    this.activePermits = Math.max(0, this.activePermits - 1);

    if (this.isDraining && this.activePermits === 0) {
      this.emit('drained');
    }

    return true;
  }

  _enqueue(node) {
    if (!this.queueHead) {
      this.queueHead = node;
      this.queueTail = node;
    } else {
      this.queueTail.next = node;
      node.prev = this.queueTail;
      this.queueTail = node;
    }
  }

  _dequeueHead() {
    if (!this.queueHead) return null;
    const node = this.queueHead;
    this.queueHead = node.next;
    if (this.queueHead) {
      this.queueHead.prev = null;
    } else {
      this.queueTail = null;
    }
    node.prev = null;
    node.next = null;
    this.queuedWaiters = Math.max(0, this.queuedWaiters - 1);
    return node;
  }

  _removeWaiter(node) {
    if (node.timeoutId) {
      clearTimeout(node.timeoutId);
      node.timeoutId = null;
    }
    if (node.abortListener && node.options.signal) {
      node.options.signal.removeEventListener('abort', node.abortListener);
      node.abortListener = null;
    }

    if (node === this.queueHead && node === this.queueTail) {
      this.queueHead = null;
      this.queueTail = null;
    } else if (node === this.queueHead) {
      this.queueHead = node.next;
      if (this.queueHead) this.queueHead.prev = null;
    } else if (node === this.queueTail) {
      this.queueTail = node.prev;
      if (this.queueTail) this.queueTail.next = null;
    } else {
      node.unlink();
    }

    this.queuedWaiters = Math.max(0, this.queuedWaiters - 1);
  }

  /**
   * Drain active permits and reject queue for graceful shutdown.
   */
  async drain(timeoutMs = 15000) {
    this.isDraining = true;

    // Purge queued waiters immediately
    while (this.queueHead) {
      const waiter = this._dequeueHead();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
      if (waiter.abortListener && waiter.options.signal) {
        waiter.options.signal.removeEventListener('abort', waiter.abortListener);
      }
      this.totalRejectionsDraining++;
      waiter.reject(new AdmissionDrainingError());
    }

    if (this.activePermits === 0) {
      return true;
    }

    return new Promise((resolve) => {
      let timer = null;
      const onDrained = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };

      this.once('drained', onDrained);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.removeListener('drained', onDrained);
          logger.warn('upload_admission.drain_timed_out', {
            activePermits: this.activePermits,
            timeoutMs
          });
          resolve(false);
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  /**
   * Reset internal state (for testing).
   */
  reset() {
    // Purge any remaining waiters
    while (this.queueHead) {
      const waiter = this._dequeueHead();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
      if (waiter.abortListener && waiter.options.signal) {
        waiter.options.signal.removeEventListener('abort', waiter.abortListener);
      }
      waiter.reject(new AdmissionAbortedError('Resetting admission service'));
    }

    this.activePermits = 0;
    this.queuedWaiters = 0;
    this.queueHead = null;
    this.queueTail = null;
    this.activePermitsMap.clear();
    this.isDraining = false;
    this.totalAcquisitions = 0;
    this.totalReleases = 0;
    this.totalRejectionsQueueFull = 0;
    this.totalRejectionsDraining = 0;
    this.totalTimeouts = 0;
    this.totalAborts = 0;
    this.totalPermitsLeaked = 0;
    this.underflowCount = 0;
    this.removeAllListeners();
  }

  getDiagnostics() {
    return {
      config: {
        maxActive: this.maxActive,
        maxQueue: this.maxQueue,
        defaultTimeoutMs: this.defaultTimeoutMs
      },
      state: {
        activePermits: this.activePermits,
        queuedWaiters: this.queuedWaiters,
        isDraining: this.isDraining
      },
      counters: {
        totalAcquisitions: this.totalAcquisitions,
        totalReleases: this.totalReleases,
        totalRejectionsQueueFull: this.totalRejectionsQueueFull,
        totalRejectionsDraining: this.totalRejectionsDraining,
        totalTimeouts: this.totalTimeouts,
        totalAborts: this.totalAborts,
        totalPermitsLeaked: this.totalPermitsLeaked,
        underflowCount: this.underflowCount
      }
    };
  }
}

export const uploadAdmissionService = new UploadAdmissionService();
export default uploadAdmissionService;
