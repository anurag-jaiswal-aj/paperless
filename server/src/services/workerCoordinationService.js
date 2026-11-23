import { EventEmitter } from 'events';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

export class QuiescenceActiveError extends Error {
  constructor(message = 'Backup quiescence is active', code = 'BACKUP_QUIESCENCE_ACTIVE') {
    super(message);
    this.name = 'QuiescenceActiveError';
    this.code = code;
  }
}

/**
 * Set of currently active background worker tasks.
 * Each entry: { taskId, workerName, startedAt, promise }
 */
const activeWorkerTasks = new Set();
const workerDrainEmitter = new EventEmitter();

let workerAdmissionState = 'OPEN'; // 'OPEN' | 'CLOSED' | 'SHUTDOWN'

export const closeWorkerAdmission = (reason = 'QUIESCENCE') => {
  workerAdmissionState = reason === 'SHUTDOWN' ? 'SHUTDOWN' : 'CLOSED';
};

export const openWorkerAdmission = () => {
  workerAdmissionState = 'OPEN';
};

export const isWorkerAdmissionClosed = () => workerAdmissionState !== 'OPEN';

let customQuiescenceChecker = null;

/**
 * Configure an override quiescence checker (e.g. for unit testing or mocking).
 * @param {Function|null} checkerFn - async function returning boolean
 */
export const setQuiescenceChecker = (checkerFn) => {
  customQuiescenceChecker = checkerFn;
};

/**
 * Returns the currently configured quiescence checker.
 * @returns {Function|null}
 */
export const getQuiescenceChecker = () => customQuiescenceChecker;

/**
 * Checks if the system is currently DRAINING or QUIESCED.
 * Dynamic discovery to prevent circular import evaluation cycles.
 * Fails closed in production/staging if database connection is offline.
 *
 * @returns {Promise<boolean>}
 */
export const isQuiescenceActive = async () => {
  if (customQuiescenceChecker) {
    try {
      const customResult = Boolean(await customQuiescenceChecker());
      // ONLY reset if CLOSED, NEVER if SHUTDOWN!
      if (!customResult && workerAdmissionState === 'CLOSED') {
        workerAdmissionState = 'OPEN';
      }
      return customResult;
    } catch {
      return false;
    }
  }

  // Fail closed in production/staging if database connection is not ready
  if (
    mongoose.connection &&
    mongoose.connection.readyState !== 1 &&
    (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging')
  ) {
    return true;
  }

  let active = false;

  try {
    const gateModule = await import('../middleware/quiescenceGate.js');
    if (typeof gateModule.isQuiescenceActive === 'function') {
      active = Boolean(await gateModule.isQuiescenceActive());
    }
  } catch {
    // Fall back to direct quiescenceService lookup
  }

  if (!active) {
    try {
      const serviceModule = await import('./quiescenceService.js');
      const service = serviceModule.default || serviceModule.quiescenceService || serviceModule;
      if (typeof service.isDrainingOrQuiesced === 'function') {
        active = Boolean(await service.isDrainingOrQuiesced());
      } else if (typeof service.isQuiescedOrDraining === 'function') {
        active = Boolean(await service.isQuiescedOrDraining());
      } else if (typeof service.getStatus === 'function') {
        const status = await service.getStatus();
        active = Boolean(
          (status?.status === 'DRAINING' ||
            status?.status === 'QUIESCED' ||
            status?.status === 'RECOVERY_REQUIRED') &&
            !status?.isExpired
        );
      }
    } catch {
      // Fail closed in production/staging if database or service lookup throws
      if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
        return true;
      }
    }
  }

  // ONLY reset if CLOSED, NEVER if SHUTDOWN!
  if (!active && workerAdmissionState === 'CLOSED') {
    workerAdmissionState = 'OPEN';
  }

  return active;
};

/**
 * Inter-batch / item pause check for multi-step or looping workers.
 * Workers should check `if (await shouldPauseWorker()) break;` before each batch/item.
 * Checks both quiescence status and instance lease validity.
 *
 * @returns {Promise<boolean>}
 */
export const shouldPauseWorker = async () => {
  let isLeaseValid = true;
  try {
    const { isInstanceLeaseValid } = await import('./instanceLeaseService.js');
    if (typeof isInstanceLeaseValid === 'function') {
      isLeaseValid = isInstanceLeaseValid();
    }
  } catch {
    // In environments without lease service, default to valid
  }
  if (!isLeaseValid) {
    return true;
  }
  return await isQuiescenceActive();
};

/**
 * Returns a shallow copy of the active worker task records.
 * @returns {Array<object>}
 */
export const getActiveWorkerTasks = () => Array.from(activeWorkerTasks);

/**
 * Returns count of currently active worker tasks.
 * @returns {number}
 */
export const getActiveWorkerTaskCount = () => activeWorkerTasks.size;

/**
 * Reset all active worker tasks and listeners (primarily for test cleanup).
 */
export const resetWorkerTasks = () => {
  workerAdmissionState = 'OPEN';
  activeWorkerTasks.clear();
  workerDrainEmitter.removeAllListeners();
  customQuiescenceChecker = null;
};

/**
 * Wait up to timeoutMs for all active worker tasks to complete and deregister.
 *
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<boolean>} True if drained to 0, false if timed out.
 */
export const waitForActiveWorkerTasks = async (timeoutMs = 15000) => {
  if (activeWorkerTasks.size === 0) {
    return true;
  }
  if (timeoutMs <= 0) {
    return activeWorkerTasks.size === 0;
  }

  return new Promise((resolve) => {
    let timer = null;

    const onDrain = () => {
      if (timer) clearTimeout(timer);
      workerDrainEmitter.removeListener('drain', onDrain);
      resolve(true);
    };

    timer = setTimeout(() => {
      workerDrainEmitter.removeListener('drain', onDrain);
      resolve(activeWorkerTasks.size === 0);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    workerDrainEmitter.once('drain', onDrain);

    if (activeWorkerTasks.size === 0) {
      if (timer) clearTimeout(timer);
      workerDrainEmitter.removeListener('drain', onDrain);
      resolve(true);
    }
  });
};

/**
 * Registers an asynchronous background worker task with the quiescence coordination system.
 *
 * Race-free guarantees:
 * 1. Pre-execution check: If the system is DRAINING or QUIESCED, rejects or skips execution immediately.
 * 2. Active tracking: If execution proceeds, task is tracked in activeWorkerTasks so drainInFlight awaits it.
 * 3. Safe settlement: Whether the task resolves or throws, it is safely deregistered from activeWorkerTasks.
 *
 * @param {string} workerName - Name or category of the background worker (e.g. 'recoverAbandonedFormDeletions')
 * @param {Function|Promise} asyncFnOrPromise - Async function (context) => Promise or Promise instance
 * @param {object} [options={}]
 * @param {boolean} [options.rejectOnQuiescence=false] - If true, throws QuiescenceActiveError when quiescence is active
 * @param {boolean} [options.skipOnQuiescence=true] - If true (default), returns { skipped: true, reason: 'BACKUP_QUIESCENCE_ACTIVE' }
 * @param {AbortSignal} [options.signal] - Optional caller AbortSignal
 * @returns {Promise<any>}
 */
export const registerWorkerTask = (workerName, asyncFnOrPromise, options = {}) => {
  // Synchronous admission barrier (shutdown or quiescence active)
  if (workerAdmissionState !== 'OPEN') {
    logger.warn(
      `Worker task "${workerName}" prevented from executing: worker admission closed (quiescence active or shutdown)`,
      {
        event: 'quiescence.worker_gated',
        workerName,
        code: 'BACKUP_QUIESCENCE_ACTIVE'
      }
    );

    if (options.rejectOnQuiescence) {
      return Promise.reject(
        new QuiescenceActiveError(
          `Worker task "${workerName}" rejected: backup quiescence is active`
        )
      );
    }

    if (typeof options.onQuiescence === 'function') {
      const taskId =
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `worker-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      const taskRecord = {
        taskId,
        workerName,
        startedAt: new Date(),
        promise: null,
        isDeregistered: false
      };

      activeWorkerTasks.add(taskRecord);

      const runOnQuiesce = async () => {
        try {
          return await options.onQuiescence();
        } finally {
          taskRecord.isDeregistered = true;
          activeWorkerTasks.delete(taskRecord);
          if (activeWorkerTasks.size === 0) {
            workerDrainEmitter.emit('drain');
          }
        }
      };

      const p = runOnQuiesce();
      taskRecord.promise = p;
      return p;
    }

    if (options.fallbackResult !== undefined) {
      return Promise.resolve(options.fallbackResult);
    }

    return Promise.resolve({
      executed: false,
      skipped: true,
      reason: 'BACKUP_QUIESCENCE_ACTIVE',
      status: 'skipped'
    });
  }

  const isFn = typeof asyncFnOrPromise === 'function';
  const isPromise = asyncFnOrPromise && typeof asyncFnOrPromise.then === 'function';
  if (!isFn && !isPromise) {
    return Promise.reject(
      new TypeError('registerWorkerTask expects an async function or a Promise')
    );
  }

  const taskId =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `worker-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const taskRecord = {
    taskId,
    workerName,
    startedAt: new Date(),
    promise: null,
    isDeregistered: false
  };

  // Synchronously track task so getActiveWorkerTaskCount() is immediately accurate
  // and drainInFlight cannot slip past an un-registered in-flight start.
  activeWorkerTasks.add(taskRecord);

  const execute = async () => {
    try {
      // Check deployment instance lease fencing
      let isLeaseValid = true;
      try {
        const { isInstanceLeaseValid } = await import('./instanceLeaseService.js');
        if (typeof isInstanceLeaseValid === 'function') {
          isLeaseValid = isInstanceLeaseValid();
        }
      } catch {
        // Fall back gracefully if lease service unavailable
      }

      if (!isLeaseValid) {
        logger.warn(
          `Worker task "${workerName}" prevented from executing: instance lease invalid/fenced`,
          {
            event: 'quiescence.worker_fenced',
            workerName,
            code: 'INSTANCE_FENCED'
          }
        );

        if (options.rejectOnQuiescence) {
          throw new QuiescenceActiveError(
            `Worker task "${workerName}" rejected: instance is fenced`,
            'INSTANCE_FENCED'
          );
        }

        return {
          executed: false,
          skipped: true,
          reason: 'INSTANCE_FENCED',
          status: 'skipped'
        };
      }

      const isQuiesced = await isQuiescenceActive();

      if (isQuiesced) {
        logger.info(
          `Worker task "${workerName}" prevented from executing: backup quiescence active`,
          {
            event: 'quiescence.worker_gated',
            workerName,
            code: 'BACKUP_QUIESCENCE_ACTIVE'
          }
        );

        if (options.rejectOnQuiescence) {
          throw new QuiescenceActiveError(
            `Worker task "${workerName}" rejected: backup quiescence is active`
          );
        }

        if (typeof options.onQuiescence === 'function') {
          return await options.onQuiescence();
        }

        if (options.fallbackResult !== undefined) {
          return options.fallbackResult;
        }

        return {
          executed: false,
          skipped: true,
          reason: 'BACKUP_QUIESCENCE_ACTIVE',
          status: 'skipped'
        };
      }

      const context = {
        taskId,
        workerName,
        signal: options.signal,
        shouldPause: () => shouldPauseWorker(),
        isQuiescenceActive: () => isQuiescenceActive()
      };

      if (isFn) {
        return await asyncFnOrPromise(context);
      } else {
        return await asyncFnOrPromise;
      }
    } finally {
      taskRecord.isDeregistered = true;
      activeWorkerTasks.delete(taskRecord);
      if (activeWorkerTasks.size === 0) {
        workerDrainEmitter.emit('drain');
      }
    }
  };

  const trackingPromise = execute();
  taskRecord.promise = trackingPromise;

  return trackingPromise;
};

/**
 * Higher-order helper to wrap any background worker function in an atomic admission registration.
 * @param {string} workerName
 * @param {Function} workerFn
 * @param {object} [defaultOptions={}]
 * @returns {Function}
 */
export const wrapWorker = (workerName, workerFn, defaultOptions = {}) => {
  return (...args) =>
    registerWorkerTask(
      workerName,
      (context) => workerFn(...args, context),
      defaultOptions
    );
};

export default {
  registerWorkerTask,
  wrapWorker,
  getActiveWorkerTasks,
  getActiveWorkerTaskCount,
  waitForActiveWorkerTasks,
  isQuiescenceActive,
  shouldPauseWorker,
  resetWorkerTasks,
  setQuiescenceChecker,
  getQuiescenceChecker,
  closeWorkerAdmission,
  openWorkerAdmission,
  isWorkerAdmissionClosed,
  QuiescenceActiveError
};
