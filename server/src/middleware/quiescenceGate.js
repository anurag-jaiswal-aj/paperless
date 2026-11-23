import { EventEmitter } from 'events';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import { isInstanceLeaseValid } from '../services/instanceLeaseService.js';

let inFlightMutationCount = 0;
let standaloneOperationCount = 0;
let mutationAdmissionState = 'OPEN'; // 'OPEN' | 'CLOSED' | 'SHUTDOWN'
const activeMutations = new Set();
const activeOperationPromises = new Set();
const activeDatabaseOperations = new Map();
const activeStorageOperations = new Map();
const unresolvedOperationsMap = new Map();
const drainEmitter = new EventEmitter();
const mutationContextStorage = new AsyncLocalStorage();

export const closeMutationAdmission = (reason = 'QUIESCENCE') => {
  if (reason === 'SHUTDOWN') {
    mutationAdmissionState = 'SHUTDOWN';
  } else if (reason === 'RECOVERY_REQUIRED') {
    mutationAdmissionState = 'RECOVERY_REQUIRED';
  } else {
    mutationAdmissionState = 'CLOSED';
  }
};

export const openMutationAdmission = () => {
  mutationAdmissionState = 'OPEN';
};

export const isMutationAdmissionClosed = () => mutationAdmissionState !== 'OPEN';

// Allow injecting or mocking quiescenceService for testing and dynamic discovery
let injectedQuiescenceService = null;
let resolvedQuiescenceService = null;

export const setQuiescenceService = (service) => {
  injectedQuiescenceService = service;
};

export const getQuiescenceService = async () => {
  if (injectedQuiescenceService) {
    return injectedQuiescenceService;
  }
  if (resolvedQuiescenceService) {
    return resolvedQuiescenceService;
  }
  try {
    const mod = await import('../services/quiescenceService.js');
    resolvedQuiescenceService = mod.default || mod.quiescenceService || mod;
    return resolvedQuiescenceService;
  } catch (err) {
    return null;
  }
};

/**
 * Returns the current total count of active in-flight mutating requests and standalone operations.
 * @returns {number}
 */
export const getInFlightMutationCount = () => inFlightMutationCount;

/**
 * Returns the count of active in-flight HTTP requests (excluding standalone operations).
 * @returns {number}
 */
export const getInFlightHttpMutationCount = () => Math.max(0, inFlightMutationCount - standaloneOperationCount);

/**
 * Returns the current count of active tracked business operations.
 * @returns {number}
 */
export const getActiveOperationCount = () => activeOperationPromises.size;

/**
 * Returns the current count of active database operations.
 * @returns {number}
 */
export const getActiveDatabaseOperationCount = () => activeDatabaseOperations.size;

/**
 * Returns the current count of active storage operations.
 * @returns {number}
 */
export const getActiveStorageOperationCount = () => activeStorageOperations.size;

/**
 * Returns the count of unresolved operations.
 * @returns {number}
 */
export const getUnresolvedOperationCount = () => unresolvedOperationsMap.size;

/**
 * Returns an array of unresolved operations.
 * @returns {Array<object>}
 */
export const getUnresolvedOperations = () => Array.from(unresolvedOperationsMap.values());

/**
 * Record an unresolved operation for administrative auditing.
 * @param {object} op
 */
export const recordUnresolvedOperation = (op) => {
  const id = op.id || `unresolved-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  unresolvedOperationsMap.set(id, { ...op, id, recordedAt: new Date() });
};

/**
 * Clear unresolved operations map (e.g. after manual reconciliation).
 */
export const clearUnresolvedOperations = () => {
  unresolvedOperationsMap.clear();
};

/**
 * Snapshot of all operational accounting metrics.
 * @returns {object}
 */
export const getOperationalAccountingSnapshot = () => ({
  inFlightMutations: inFlightMutationCount,
  activeHttpMutations: Math.max(0, inFlightMutationCount - standaloneOperationCount),
  standaloneOperations: standaloneOperationCount,
  activeDatabaseOperations: activeDatabaseOperations.size,
  activeStorageOperations: activeStorageOperations.size,
  activeOperations: activeOperationPromises.size,
  unresolvedOperations: unresolvedOperationsMap.size,
  isDrained: inFlightMutationCount === 0 && activeOperationPromises.size === 0 && unresolvedOperationsMap.size === 0
});

/**
 * Returns the set of active operation promises.
 * @returns {Set<Promise<any>>}
 */
export const getActiveOperationPromises = () => activeOperationPromises;

/**
 * Helper to check and emit 'drain' if all in-flight requests and operations have drained.
 */
const checkAndEmitDrain = () => {
  if (inFlightMutationCount === 0 && activeOperationPromises.size === 0) {
    drainEmitter.emit('drain');
  }
};

/**
 * Reset in-flight mutation counter and operation tracking (primarily for test cleanup).
 */
export const resetInFlightMutations = () => {
  inFlightMutationCount = 0;
  standaloneOperationCount = 0;
  mutationAdmissionState = 'OPEN';
  activeMutations.clear();
  activeOperationPromises.clear();
  activeDatabaseOperations.clear();
  activeStorageOperations.clear();
  unresolvedOperationsMap.clear();
  drainEmitter.removeAllListeners();
};

/**
 * Track an asynchronous business operation (database write, transaction, S3 promotion/cleanup).
 * Ties the operation to the current HTTP mutation request context if available, or tracks it
 * as a standalone mutation operation.
 *
 * CRITICAL GUARANTEE:
 * A premature HTTP client disconnect (`res.on('close')`) will NOT decrement the in-flight
 * mutation counter if an underlying operation is still pending. The tracking handle is
 * released ONLY when the actual business operation Promise settles (`.finally()`).
 *
 * @param {Promise|Function} promiseOrAsyncFn - Promise or async/synchronous function returning a promise
 * @param {object} [options={}] - Optional overrides (e.g. { req, requestContext })
 * @returns {Promise<any>}
 */
export const trackMutationOperation = (promiseOrAsyncFn, options = {}) => {
  let promise;
  try {
    promise = typeof promiseOrAsyncFn === 'function' ? promiseOrAsyncFn() : promiseOrAsyncFn;
  } catch (syncErr) {
    promise = Promise.reject(syncErr);
  }

  if (!promise || typeof promise.then !== 'function') {
    return Promise.resolve(promise);
  }

  const reqContext =
    options.requestContext ||
    (options.req && (options.req._quiescenceContext || options.req._mutationContext)) ||
    mutationContextStorage.getStore() ||
    null;

  // FIX: If reqContext exists but is ALREADY released (e.g. client disconnected before
  // operation began), track as standalone so in-flight accounting is never dropped!
  let isStandalone = false;
  if (reqContext && !reqContext.isReleased) {
    reqContext.operations.add(promise);
  } else {
    isStandalone = true;
    standaloneOperationCount++;
    inFlightMutationCount++;
  }

  activeOperationPromises.add(promise);

  const opId = options.opId || `op-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const opType = options.operationType || 'general';
  const opRecord = {
    id: opId,
    type: opType,
    description: options.description || options.name || 'unnamed_operation',
    startTime: Date.now(),
    promise
  };

  if (opType === 'database') {
    activeDatabaseOperations.set(opId, opRecord);
  } else if (opType === 'storage') {
    activeStorageOperations.set(opId, opRecord);
  }

  const cleanup = () => {
    activeOperationPromises.delete(promise);
    if (opType === 'database') {
      activeDatabaseOperations.delete(opId);
    } else if (opType === 'storage') {
      activeStorageOperations.delete(opId);
    }

    if (!isStandalone && reqContext && !reqContext.isReleased) {
      reqContext.operations.delete(promise);
      if (reqContext.isHttpClosed || reqContext.isHttpFinished) {
        reqContext.tryRelease();
      }
    } else if (isStandalone) {
      standaloneOperationCount = Math.max(0, standaloneOperationCount - 1);
      inFlightMutationCount = Math.max(0, inFlightMutationCount - 1);
      checkAndEmitDrain();
    }

    if (activeOperationPromises.size === 0) {
      drainEmitter.emit('operationDrain');
    }
    checkAndEmitDrain();
  };

  promise
    .finally(cleanup)
    .catch(() => {});

  return promise;
};

/**
 * Track an asynchronous database operation (query, transaction, bulk write).
 *
 * @param {Promise|Function} promiseOrAsyncFn
 * @param {object} [options={}]
 * @returns {Promise<any>}
 */
export const trackDatabaseOperation = (promiseOrAsyncFn, options = {}) => {
  return trackMutationOperation(promiseOrAsyncFn, { ...options, operationType: 'database' });
};

/**
 * Track an asynchronous storage operation (S3/MinIO upload, delete, promote).
 *
 * @param {Promise|Function} promiseOrAsyncFn
 * @param {object} [options={}]
 * @returns {Promise<any>}
 */
export const trackStorageOperation = (promiseOrAsyncFn, options = {}) => {
  return trackMutationOperation(promiseOrAsyncFn, { ...options, operationType: 'storage' });
};

/**
 * Register a scoped asynchronous mutation block.
 *
 * @param {Function} asyncFn - Async function to execute inside the mutation tracking scope.
 * @param {object} [options={}]
 * @returns {Promise<any>}
 */
export const registerMutationScope = async (asyncFn, options = {}) => {
  return trackMutationOperation(asyncFn, options);
};

/**
 * Express middleware helper to wrap a route handler in an automatic mutation scope.
 *
 * @param {Function} handler - Express route handler (req, res, next)
 * @returns {Function} Wrapped handler
 */
export const withMutationScope = (handler) => {
  return async (req, res, next) => {
    const track = req?.trackMutationOperation || trackMutationOperation;
    try {
      return await track(() => handler(req, res, next), { req });
    } catch (err) {
      if (typeof next === 'function') {
        return next(err);
      }
      throw err;
    }
  };
};

/**
 * Wait up to timeoutMs for all active business operations in activeOperationPromises to settle.
 *
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<boolean>} True if all active operations settled, false if timed out.
 */
export const waitForActiveOperations = async (timeoutMs = 15000) => {
  if (activeOperationPromises.size === 0) {
    return true;
  }
  if (timeoutMs <= 0) {
    return activeOperationPromises.size === 0;
  }

  return new Promise((resolve) => {
    let timer = null;

    const onOperationDrain = () => {
      if (activeOperationPromises.size === 0) {
        if (timer) clearTimeout(timer);
        drainEmitter.removeListener('operationDrain', onOperationDrain);
        resolve(true);
      }
    };

    timer = setTimeout(() => {
      drainEmitter.removeListener('operationDrain', onOperationDrain);
      resolve(activeOperationPromises.size === 0);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    drainEmitter.on('operationDrain', onOperationDrain);

    if (activeOperationPromises.size === 0) {
      if (timer) clearTimeout(timer);
      drainEmitter.removeListener('operationDrain', onOperationDrain);
      resolve(true);
    }
  });
};

/**
 * Wait up to timeoutMs for all active in-flight mutating HTTP requests and business operations to settle.
 *
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<boolean>} True if drained to 0, false if timed out.
 */
export const waitForInFlightMutations = async (timeoutMs = 15000) => {
  if (inFlightMutationCount === 0 && activeOperationPromises.size === 0) {
    return true;
  }
  if (timeoutMs <= 0) {
    return inFlightMutationCount === 0 && activeOperationPromises.size === 0;
  }

  return new Promise((resolve) => {
    let timer = null;

    const onDrain = () => {
      if (inFlightMutationCount === 0 && activeOperationPromises.size === 0) {
        if (timer) clearTimeout(timer);
        drainEmitter.removeListener('drain', onDrain);
        resolve(true);
      }
    };

    timer = setTimeout(() => {
      drainEmitter.removeListener('drain', onDrain);
      resolve(inFlightMutationCount === 0 && activeOperationPromises.size === 0);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    drainEmitter.on('drain', onDrain);

    // Double-check if count reached 0 right as listener was attached
    if (inFlightMutationCount === 0 && activeOperationPromises.size === 0) {
      if (timer) clearTimeout(timer);
      drainEmitter.removeListener('drain', onDrain);
      resolve(true);
    }
  });
};

/**
 * Coordinated draining during lease acquisition:
 * Waits for in-flight HTTP mutations and operation promises,
 * then waits for active background deletion tasks.
 *
 * @param {number} [drainTimeoutMs=15000]
 * @returns {Promise<boolean>} True if fully drained within timeout, false otherwise.
 */
export const drainInFlight = async (drainTimeoutMs = 15000) => {
  const startMonoMs = performance.now();

  // 1. Wait for in-flight HTTP mutations and active business operations
  const mutationsDrained = await waitForInFlightMutations(drainTimeoutMs);
  if (!mutationsDrained) {
    logger.warn('quiescence.drain_timed_out_mutations', {
      event: 'quiescence.drain_failed',
      reason: 'in_flight_mutations_timeout',
      remainingMutations: inFlightMutationCount,
      remainingOperations: activeOperationPromises.size
    });
    return false;
  }

  const elapsedAfterMutations = performance.now() - startMonoMs;
  const remainingForOps = Math.max(0, drainTimeoutMs - elapsedAfterMutations);
  const operationsDrained = await waitForActiveOperations(remainingForOps);
  if (!operationsDrained) {
    logger.warn('quiescence.drain_timed_out_operations', {
      event: 'quiescence.drain_failed',
      reason: 'active_operations_timeout',
      remainingOperations: activeOperationPromises.size
    });
    return false;
  }

  const elapsed = performance.now() - startMonoMs;
  const remainingMs = Math.max(0, drainTimeoutMs - elapsed);

  // 2. Wait for active deletion tasks from formController
  try {
    const { waitForActiveDeletionTasks } = await import('../controllers/formController.js');
    if (typeof waitForActiveDeletionTasks === 'function') {
      const deletionsDrained = await waitForActiveDeletionTasks(remainingMs);
      if (!deletionsDrained) {
        logger.warn('quiescence.drain_timed_out_deletions', {
          event: 'quiescence.drain_failed',
          reason: 'active_deletion_tasks_timeout'
        });
        return false;
      }
    }
  } catch (err) {
    // If formController not available, skip gracefully
  }

  // 3. Wait for active worker coordination tasks from workerCoordinationService
  const elapsedWorkers = performance.now() - startMonoMs;
  const remainingWorkerMs = Math.max(0, drainTimeoutMs - elapsedWorkers);
  try {
    const { waitForActiveWorkerTasks } = await import('../services/workerCoordinationService.js');
    if (typeof waitForActiveWorkerTasks === 'function') {
      const workersDrained = await waitForActiveWorkerTasks(remainingWorkerMs);
      if (!workersDrained) {
        logger.warn('quiescence.drain_timed_out_workers', {
          event: 'quiescence.drain_failed',
          reason: 'active_worker_tasks_timeout'
        });
        return false;
      }
    }
  } catch (err) {
    // If workerCoordinationService not available, skip gracefully
  }

  return true;
};

/**
 * Helper to check if quiescence is active (DRAINING or QUIESCED).
 * Used by formController and background periodic timers.
 *
 * @returns {Promise<boolean>}
 */
export const isQuiescenceActive = async () => {
  if (injectedQuiescenceService) {
    const service = injectedQuiescenceService;
    if (typeof service.isQuiescedOrDraining === 'function') {
      return Boolean(await service.isQuiescedOrDraining());
    }
    if (typeof service.isDrainingOrQuiesced === 'function') {
      return Boolean(await service.isDrainingOrQuiesced());
    }
    if (typeof service.getLeaseStatus === 'function') {
      const lease = await service.getLeaseStatus();
      const status = lease?.status;
      return (status === 'DRAINING' || status === 'QUIESCED') && !lease?.isExpired;
    }
    if (typeof service.getStatus === 'function') {
      const lease = await service.getStatus();
      const status = lease?.status;
      return (status === 'DRAINING' || status === 'QUIESCED') && !lease?.isExpired;
    }
    return false;
  }

  if (mongoose.connection && mongoose.connection.readyState === 1) {
    const service = await getQuiescenceService();
    if (service) {
      if (typeof service.isQuiescedOrDraining === 'function') {
        return Boolean(await service.isQuiescedOrDraining());
      }
      if (typeof service.isDrainingOrQuiesced === 'function') {
        return Boolean(await service.isDrainingOrQuiesced());
      }
      if (typeof service.getLeaseStatus === 'function') {
        const lease = await service.getLeaseStatus();
        const status = lease?.status;
        return (status === 'DRAINING' || status === 'QUIESCED' || status === 'RECOVERY_REQUIRED') && !lease?.isExpired;
      }
      if (typeof service.getStatus === 'function') {
        const lease = await service.getStatus();
        const status = lease?.status;
        return (status === 'DRAINING' || status === 'QUIESCED' || status === 'RECOVERY_REQUIRED') && !lease?.isExpired;
      }
    }
  }

  return false;
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Express middleware to gate mutating requests during quiescence / draining.
 */
export const quiescenceGate = async (req, res, next) => {
  try {
    const rawUrl = req.originalUrl || req.url || req.path || '';
    const strippedPath = rawUrl.split('?')[0] || '/';
    const pathname = path.posix.normalize(strippedPath).replace(/\/+$/, '') || '/';
    const method = (req.method || '').toUpperCase();

    // 1. Allowlist: Quiescence administrative routes must ALWAYS bypass the gate!
    if (pathname === '/api/admin/quiescence' || pathname.startsWith('/api/admin/quiescence/')) {
      return next();
    }

    // 2. Read requests (GET, HEAD, OPTIONS) must ALWAYS bypass the gate
    if (READ_ONLY_METHODS.has(method)) {
      return next();
    }

    // 3. Health & readiness checks must ALWAYS bypass the gate
    const isHealthOrReadiness =
      pathname === '/health' ||
      pathname.startsWith('/health/') ||
      pathname === '/ready' ||
      pathname.startsWith('/ready/') ||
      pathname === '/api/health' ||
      pathname.startsWith('/api/health/') ||
      pathname === '/api/ready' ||
      pathname.startsWith('/api/ready/');

    if (isHealthOrReadiness) {
      return next();
    }

    // Non-mutating methods bypass
    if (!MUTATING_METHODS.has(method)) {
      return next();
    }

    // 3b. Synchronous admission barrier (shutdown or closed admission)
    if (mutationAdmissionState !== 'OPEN') {
      const isShutdown = mutationAdmissionState === 'SHUTDOWN';
      const isRecovery = mutationAdmissionState === 'RECOVERY_REQUIRED';
      const code = isShutdown
        ? 'SERVER_SHUTTING_DOWN'
        : isRecovery
        ? 'RECOVERY_REQUIRED'
        : 'BACKUP_QUIESCENCE_ACTIVE';
      const errorMessage = isShutdown
        ? 'Service temporarily unavailable: server is shutting down.'
        : isRecovery
        ? 'Service temporarily unavailable: system is in recovery required state.'
        : 'System is undergoing scheduled maintenance/backup';
      logger.warn('Quiescence gate rejecting mutating request: admission is closed', {
        event: 'quiescence.admission_closed',
        method,
        path: pathname,
        code
      });
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        success: false,
        message: errorMessage,
        error: errorMessage,
        code
      });
    }

    // 3c. Single-instance deployment lease fencing check
    if (!isInstanceLeaseValid()) {
      logger.warn('Quiescence gate rejecting mutating request: instance deployment lease is invalid or fenced', {
        event: 'quiescence.instance_fenced',
        method,
        path: pathname
      });
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        error: 'Service temporarily unavailable: instance is fenced or undergoing failover.',
        code: 'INSTANCE_FENCED'
      });
    }

    // 4. Resolve quiescence status
    let isQuiesced = false;
    let isRecoveryRequired = false;
    let resolvedLease = null;

    if (injectedQuiescenceService) {
      const service = injectedQuiescenceService;
      if (typeof service.getStatus === 'function') {
        resolvedLease = await service.getStatus();
      } else if (typeof service.getLeaseStatus === 'function') {
        resolvedLease = await service.getLeaseStatus();
      } else if (typeof service.isQuiescedOrDraining === 'function') {
        isQuiesced = Boolean(await service.isQuiescedOrDraining());
      } else if (typeof service.isDrainingOrQuiesced === 'function') {
        isQuiesced = Boolean(await service.isDrainingOrQuiesced());
      }
    } else if (mongoose.connection && mongoose.connection.readyState === 1) {
      const service = await getQuiescenceService();
      if (service) {
        if (typeof service.getStatus === 'function') {
          resolvedLease = await service.getStatus();
        } else if (typeof service.getLeaseStatus === 'function') {
          resolvedLease = await service.getLeaseStatus();
        } else if (typeof service.isQuiescedOrDraining === 'function') {
          isQuiesced = Boolean(await service.isQuiescedOrDraining());
        } else if (typeof service.isDrainingOrQuiesced === 'function') {
          isQuiesced = Boolean(await service.isDrainingOrQuiesced());
        }
      }
    } else if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
      // Database connection not ready in production/staging environment: fail closed on mutating requests
      logger.warn('Quiescence gate rejecting mutating request: database connection not ready', {
        event: 'quiescence.db_not_ready',
        method,
        path: pathname
      });
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        error: 'Service temporarily unavailable. Please retry shortly.',
        code: 'DATABASE_UNAVAILABLE'
      });
    }

    if (resolvedLease) {
      const status = resolvedLease.status;
      if (status === 'RECOVERY_REQUIRED') {
        isRecoveryRequired = true;
      } else {
        isQuiesced = (status === 'DRAINING' || status === 'QUIESCED') && !resolvedLease.isExpired;
      }
    }

    if (isRecoveryRequired) {
      closeMutationAdmission('RECOVERY_REQUIRED');
      logger.warn('Quiescence gate rejecting mutating request: durable status is RECOVERY_REQUIRED', {
        event: 'quiescence.durable_recovery_required',
        method,
        path: pathname
      });
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        success: false,
        message: 'Service temporarily unavailable: system is in recovery required state.',
        error: 'Service temporarily unavailable: system is in recovery required state.',
        code: 'RECOVERY_REQUIRED'
      });
    }

    // 5. If status is DRAINING or QUIESCED, reject mutating requests with 503
    if (isQuiesced) {
      logger.warn('Quiescence gate rejected mutating request', {
        event: 'quiescence.write_rejected',
        method,
        path: pathname,
        code: 'BACKUP_QUIESCENCE_ACTIVE'
      });
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        error: 'System is undergoing scheduled maintenance/backup',
        code: 'BACKUP_QUIESCENCE_ACTIVE'
      });
    }

    // 6. Mutating request accepted through gate: track in-flight
    inFlightMutationCount++;

    const requestContext = {
      req,
      res,
      operations: new Set(),
      isHttpClosed: false,
      isHttpFinished: false,
      isReleased: false,
      tryRelease: null
    };

    activeMutations.add(requestContext);
    req._quiescenceContext = requestContext;
    res._quiescenceContext = requestContext;

    req.trackMutationOperation = (promiseOrAsyncFn) =>
      trackMutationOperation(promiseOrAsyncFn, { requestContext });
    req.registerMutationScope = (asyncFn) =>
      registerMutationScope(asyncFn, { requestContext });

    const tryRelease = () => {
      if (requestContext.isReleased) return;

      // Cannot release if there are still operations executing
      if (requestContext.operations.size > 0) {
        return;
      }

      // Can only release if HTTP finished or closed
      if (!requestContext.isHttpFinished && !requestContext.isHttpClosed) {
        return;
      }

      requestContext.isReleased = true;
      inFlightMutationCount = Math.max(0, inFlightMutationCount - 1);
      activeMutations.delete(requestContext);

      if (typeof res.removeListener === 'function') {
        res.removeListener('finish', onFinish);
        res.removeListener('close', onClose);
      }
      if (typeof req.removeListener === 'function') {
        req.removeListener('aborted', onAbort);
      }

      checkAndEmitDrain();
    };

    requestContext.tryRelease = tryRelease;

    const onFinish = () => {
      requestContext.isHttpFinished = true;
      tryRelease();
    };

    const onClose = () => {
      requestContext.isHttpClosed = true;
      tryRelease();
    };

    const onAbort = () => {
      requestContext.isHttpClosed = true;
      tryRelease();
    };

    if (typeof res.on === 'function') {
      res.on('finish', onFinish);
      res.on('close', onClose);
    }
    if (typeof req.on === 'function') {
      req.on('aborted', onAbort);
    }

    return mutationContextStorage.run(requestContext, () => next());
  } catch (err) {
    return next(err);
  }
};

export default quiescenceGate;
