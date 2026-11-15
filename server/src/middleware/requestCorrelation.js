import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logger, setLogContextProvider } from '../utils/logger.js';

/**
 * AsyncLocalStorage instance for storing request-scoped context across asynchronous call chains.
 */
export const asyncLocalStorage = new AsyncLocalStorage();

// Register ambient context provider with logger so application logs automatically include active requestId
setLogContextProvider(() => {
  const store = asyncLocalStorage.getStore();
  if (!store || !store.requestId) return null;
  return { requestId: store.requestId };
});

/**
 * WeakSet to track event emitters that have already been wrapped.
 */
const BOUND_EMITTERS = new WeakSet();

/**
 * WeakMap to map original listeners to their AsyncResource-bound wrappers so removeListener works.
 */
const LISTENER_MAP = new WeakMap();

/**
 * Binds an EventEmitter's listener registration methods so registered listeners
 * retain the active AsyncLocalStorage context when triggered asynchronously.
 *
 * @param {Object} emitter - EventEmitter instance (e.g. req or res)
 */
function bindEventEmitter(emitter) {
  if (!emitter || typeof emitter.on !== 'function' || BOUND_EMITTERS.has(emitter)) {
    return;
  }
  BOUND_EMITTERS.add(emitter);

  const originalOn = emitter.on;
  const originalOnce = emitter.once;
  const originalRemove = emitter.removeListener;

  emitter.on = function (event, listener) {
    if (typeof listener === 'function') {
      const bound = AsyncResource.bind(listener);
      LISTENER_MAP.set(listener, bound);
      return originalOn.call(this, event, bound);
    }
    return originalOn.apply(this, arguments);
  };
  emitter.addListener = emitter.on;

  if (typeof originalOnce === 'function') {
    emitter.once = function (event, listener) {
      if (typeof listener === 'function') {
        const bound = AsyncResource.bind(listener);
        LISTENER_MAP.set(listener, bound);
        return originalOnce.call(this, event, bound);
      }
      return originalOnce.apply(this, arguments);
    };
  }

  if (typeof originalRemove === 'function') {
    emitter.removeListener = function (event, listener) {
      const target = LISTENER_MAP.get(listener) || listener;
      return originalRemove.call(this, event, target);
    };
    emitter.off = emitter.removeListener;
  }
}

/**
 * Retrieves the current request context object, or null if outside a request lifecycle.
 * Must not throw under any circumstances.
 *
 * @returns {Object|null} The current store context object, or null.
 */
export function getRequestContext() {
  try {
    const store = asyncLocalStorage.getStore();
    return store || null;
  } catch {
    return null;
  }
}

/**
 * Retrieves the active server-generated request ID, or null if outside a request lifecycle.
 * Must not throw under any circumstances.
 *
 * @returns {string|null} The active requestId, or null.
 */
export function getRequestId() {
  try {
    const store = asyncLocalStorage.getStore();
    return store?.requestId || null;
  } catch {
    return null;
  }
}

/**
 * Retrieves the request-scoped logger instance, or the root application logger if outside request context.
 *
 * @returns {Object} Logger instance.
 */
export function getRequestLogger() {
  try {
    const store = asyncLocalStorage.getStore();
    return store?.logger || logger;
  } catch {
    return logger;
  }
}

/**
 * Binds an arbitrary callback function to the currently active request context.
 *
 * @param {Function} fn - Target function
 * @returns {Function} Context-bound function
 */
export function bindRequestContext(fn) {
  if (typeof fn !== 'function') return fn;
  return AsyncResource.bind(fn);
}

/**
 * Executes a function within a specified or generated request context.
 * Useful for tests, background jobs, and worker task execution.
 *
 * @param {Object|string} [context] - Context object or requestId string
 * @param {Function} fn - Function to execute
 * @returns {*} Return value of fn
 */
export function runWithRequestContext(context, fn) {
  const base =
    typeof context === 'string'
      ? { requestId: context }
      : context && typeof context === 'object'
        ? { ...context }
        : {};

  const requestId = base.requestId || randomUUID();
  let requestLogger = base.logger;
  if (!requestLogger && logger && typeof logger.child === 'function') {
    try {
      requestLogger = logger.child({ requestId });
    } catch {
      requestLogger = logger;
    }
  }

  const store = {
    ...base,
    requestId,
    ...(requestLogger ? { logger: requestLogger } : {})
  };

  return asyncLocalStorage.run(store, fn);
}

/**
 * Express middleware for request correlation.
 *
 * - Generates a secure, server-side UUID v4 for each incoming HTTP request.
 * - Sets req.id and req.requestId to the server-generated UUID.
 * - Sets the outgoing X-Request-ID response header.
 * - Overwrites any client-supplied X-Request-ID headers (does not trust client-supplied IDs).
 * - Stores untrusted clientRequestId in context if supplied for diagnostic tracing.
 * - Encloses downstream execution within AsyncLocalStorage so downstream async operations
 *   and loggers have access to the active request context.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function requestCorrelation(req, res, next) {
  const requestId = randomUUID();

  // Safely extract untrusted client-supplied header if present for diagnostic auditing
  let clientRequestId = undefined;
  if (req) {
    const rawClientHeader =
      typeof req.get === 'function'
        ? req.get('x-request-id')
        : typeof req.header === 'function'
          ? req.header('x-request-id')
          : req.headers?.['x-request-id'] || req.headers?.['X-Request-ID'];

    if (typeof rawClientHeader === 'string' && rawClientHeader.trim().length > 0) {
      clientRequestId = rawClientHeader.trim();
    } else if (
      Array.isArray(rawClientHeader) &&
      rawClientHeader.length > 0 &&
      typeof rawClientHeader[0] === 'string' &&
      rawClientHeader[0].trim().length > 0
    ) {
      clientRequestId = rawClientHeader[0].trim();
    }

    // Overwrite client headers with authoritative server-generated UUID
    if (req.headers && typeof req.headers === 'object') {
      req.headers['x-request-id'] = requestId;
      for (const key of Object.keys(req.headers)) {
        if (key.toLowerCase() === 'x-request-id' && key !== 'x-request-id') {
          delete req.headers[key];
        }
      }
    }

    // Set request properties
    req.id = requestId;
    req.requestId = requestId;
  }

  // Set response header
  if (res && typeof res.setHeader === 'function' && !res.headersSent) {
    try {
      res.setHeader('X-Request-ID', requestId);
    } catch {
      // Ignore if headers cannot be written
    }
  }

  // Create child logger bound with requestId
  let requestLogger = null;
  if (logger && typeof logger.child === 'function') {
    try {
      requestLogger = logger.child({ requestId });
    } catch {
      requestLogger = logger;
    }
  }

  if (req && requestLogger) {
    req.log = requestLogger;
    req.logger = requestLogger;
  }

  const context = {
    requestId,
    ...(clientRequestId ? { clientRequestId } : {}),
    ...(requestLogger ? { logger: requestLogger } : {})
  };

  return asyncLocalStorage.run(context, () => {
    bindEventEmitter(req);
    bindEventEmitter(res);
    if (typeof next === 'function') {
      return next();
    }
  });
}

// Named alias
export const requestCorrelationMiddleware = requestCorrelation;

// Default export
export default requestCorrelation;
