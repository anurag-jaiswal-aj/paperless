/**
 * HTTP Access Logging Middleware for Paperless.
 *
 * Implements centralized, privacy-safe structured access logging:
 * - Emits exactly one event per request: http.request.completed or http.request.aborted
 * - Captures canonical request metadata: requestId, method, route, statusCode, durationMs
 * - Route template preservation (e.g. /api/forms/:id instead of raw IDs)
 * - Zero leakage of request/response bodies, query parameters, cookies, or auth headers
 * - Health check noise suppression policy (debug for <400, warn/error for >=400)
 * - Safe handling of connection aborts and premature socket termination
 * - Zero external dependencies; integrates seamlessly with Paperless structured logger
 */

import { logger as defaultLogger } from '../utils/logger.js';
import { sanitizeRequestUrl } from '../utils/redactionPolicy.js';

/**
 * Standard health check endpoints recognized across Paperless services.
 */
export const DEFAULT_HEALTH_PATHS = Object.freeze([
  '/health',
  '/api/health',
  '/health/ready',
  '/ready',
  '/api/health/ready',
  '/api/ready'
]);

/**
 * Normalizes URL path by stripping query strings, hash fragments, and trailing slashes.
 *
 * @param {string} rawUrl - Input URL or path
 * @returns {string} Clean path
 */
function normalizePath(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const clean = rawUrl.split('?')[0].split('#')[0];
  return clean.length > 1 && clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

/**
 * Checks whether a given path corresponds to a known health check endpoint.
 *
 * @param {string} path - URL path to inspect
 * @param {Iterable<string>} [healthPaths=DEFAULT_HEALTH_PATHS] - Collection of health check paths
 * @returns {boolean} True if the path is a health check endpoint
 */
export function isHealthCheckPath(path, healthPaths = DEFAULT_HEALTH_PATHS) {
  if (typeof path !== 'string' || !path) return false;
  const normalized = normalizePath(path);
  const healthSet = healthPaths instanceof Set ? healthPaths : new Set(healthPaths);
  return healthSet.has(normalized) || healthSet.has(path.split('?')[0].split('#')[0]);
}

/**
 * Determines if an incoming HTTP request targets a health check endpoint.
 * Inspects req.originalUrl, req.path, req.url, and Express req.route definitions.
 *
 * @param {Object} req - Express request object
 * @param {Set<string>} healthPaths - Set of recognized health check paths
 * @returns {boolean} True if the request is a health check probe
 */
function isHealthRequest(req, healthPaths) {
  if (!req) return false;

  const originalUrl = req.originalUrl;
  if (originalUrl && isHealthCheckPath(originalUrl, healthPaths)) {
    return true;
  }

  const path = req.path;
  if (path && isHealthCheckPath(path, healthPaths)) {
    return true;
  }

  const url = req.url;
  if (url && isHealthCheckPath(url, healthPaths)) {
    return true;
  }

  if (req.route && req.route.path !== undefined) {
    const basePath = req.baseUrl || '';
    const routePaths = Array.isArray(req.route.path) ? req.route.path : [req.route.path];
    for (const rPath of routePaths) {
      if (typeof rPath === 'string') {
        const full = `${basePath}${rPath}`.replace(/\/+/g, '/');
        if (isHealthCheckPath(full, healthPaths)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Resolves the request ID from available request properties or headers.
 * Supported sources (in order):
 * 1. options.getRequestId(req)
 * 2. req.id
 * 3. req.getRequestId()
 * 4. req.requestId
 * 5. req.headers['x-request-id'] or req.get('x-request-id')
 *
 * @param {Object} req - Express request object
 * @param {Object} [options] - Middleware configuration options
 * @returns {string|undefined} Resolved request ID or undefined
 */
export function resolveRequestId(req, options = {}) {
  if (!req) return undefined;

  if (typeof options.getRequestId === 'function') {
    const customId = options.getRequestId(req);
    if (customId !== undefined && customId !== null && customId !== '') {
      return String(customId);
    }
  }

  if (typeof req.id === 'string' && req.id) {
    return req.id;
  }
  if (typeof req.id === 'number') {
    return String(req.id);
  }

  if (typeof req.getRequestId === 'function') {
    const getterId = req.getRequestId();
    if (getterId !== undefined && getterId !== null && getterId !== '') {
      return String(getterId);
    }
  }

  if (typeof req.requestId === 'string' && req.requestId) {
    return req.requestId;
  }

  const headerVal =
    req.headers?.['x-request-id'] ||
    (typeof req.get === 'function' ? req.get('x-request-id') : undefined);

  if (headerVal !== undefined && headerVal !== null && headerVal !== '') {
    return Array.isArray(headerVal) ? String(headerVal[0]) : String(headerVal);
  }

  return undefined;
}

/**
 * Resolves the route identifier for an HTTP request.
 * Prioritizes Express route templates (e.g. /api/forms/:id) to prevent high-cardinality metrics.
 * If unmatched, falls back to a query-string-stripped, sanitized path or generic marker.
 *
 * @param {Object} req - Express request object
 * @param {Object} [options] - Middleware configuration options
 * @returns {string} Safe route identifier
 */
export function resolveRoute(req, options = {}) {
  if (!req) return '[unmatched_route]';

  // Express route template matching
  if (req.route && req.route.path !== undefined) {
    const basePath = req.baseUrl || '';
    let routePath = req.route.path;

    if (routePath instanceof RegExp) {
      routePath = routePath.toString();
    } else if (Array.isArray(routePath)) {
      const cleanCurrent = normalizePath(req.originalUrl || req.url || '');
      const matched = routePath.find((p) => {
        if (typeof p === 'string') {
          const full = normalizePath(`${basePath}${p}`.replace(/\/+/g, '/'));
          return full === cleanCurrent;
        }
        return false;
      });
      routePath = matched !== undefined ? matched : routePath[0] || '';
    } else {
      routePath = String(routePath);
    }

    if (basePath && routePath === '/') {
      return basePath;
    }

    const combined = `${basePath}${routePath}`.replace(/\/+/g, '/');
    return combined || '/';
  }

  // Explicit unmatched identifier option
  if (options.unmatchedRouteIdentifier) {
    return options.unmatchedRouteIdentifier;
  }

  // Fallback: sanitized path with query strings completely removed
  const rawUrl = req.originalUrl || req.path || req.url || '';
  if (!rawUrl) {
    return '[unmatched_route]';
  }

  const pathOnly = rawUrl.split('?')[0].split('#')[0];
  const sanitized = sanitizeRequestUrl(pathOnly);
  return sanitized || '[unmatched_route]';
}

/**
 * Calculates high-resolution duration in milliseconds.
 *
 * @param {bigint|number} startTime - Request start timestamp
 * @returns {number} Duration in milliseconds rounded to 2 decimal places
 */
export function calculateDurationMs(startTime) {
  if (typeof startTime === 'bigint') {
    const elapsedNs = process.hrtime.bigint() - startTime;
    return Number((Number(elapsedNs) / 1e6).toFixed(2));
  }
  const elapsedMs = Date.now() - Number(startTime);
  return Number(Math.max(0, elapsedMs).toFixed(2));
}

/**
 * Resolves the appropriate log level based on response status and probe nature.
 *
 * @param {Object} params
 * @param {number} params.statusCode - HTTP response status code
 * @param {boolean} params.isAborted - Whether connection closed prematurely
 * @param {boolean} params.isHealthCheck - Whether target is a health check endpoint
 * @param {Object} [params.options] - Configuration options
 * @returns {string} Log level name
 */
export function resolveLogLevel({ statusCode, isAborted, isHealthCheck, options = {} }) {
  if (typeof options.resolveLogLevel === 'function') {
    const custom = options.resolveLogLevel({ statusCode, isAborted, isHealthCheck });
    if (typeof custom === 'string' && custom) return custom;
  }

  if (isHealthCheck) {
    if (statusCode < 400) {
      return options.healthSuccessLevel || 'debug';
    }
    if (statusCode >= 500) {
      return options.healthServerErrorLevel || 'error';
    }
    return options.healthClientErrorLevel || 'warn';
  }

  if (isAborted) {
    return options.abortedLevel || 'warn';
  }

  if (statusCode >= 500) {
    return options.serverErrorLevel || 'error';
  }

  if (statusCode >= 400) {
    return options.clientErrorLevel || 'warn';
  }

  return options.successLevel || 'info';
}

/**
 * Creates the HTTP access logger middleware function with specified configuration.
 *
 * @param {Object} [options] - Middleware configuration options
 * @param {Object} [options.logger] - Custom logger instance (defaults to application singleton)
 * @param {string[]} [options.healthCheckPaths] - Custom health check paths to recognize
 * @param {boolean} [options.suppressHealthSuccess=false] - Whether to suppress successful health check logs
 * @param {number} [options.abortedStatusCode=499] - Status code assigned to aborted requests
 * @param {string} [options.unmatchedRouteIdentifier] - Custom route marker for unmatched endpoints
 * @param {Function} [options.getRequestId] - Custom request ID extractor
 * @param {Function} [options.resolveLogLevel] - Custom log level resolver
 * @returns {Function} Express middleware (req, res, next)
 */
export function createHttpAccessLogger(options = {}) {
  const activeLogger = options.logger || defaultLogger;
  const configuredHealthPaths = options.healthCheckPaths || DEFAULT_HEALTH_PATHS;
  const healthPathSet = new Set(
    configuredHealthPaths.map((p) =>
      typeof p === 'string' && p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
    )
  );

  const suppressHealthSuccess = Boolean(
    options.suppressHealthSuccess || options.suppressSuccessfulHealthChecks
  );
  const abortedStatusFallback =
    typeof options.abortedStatusCode === 'number' ? options.abortedStatusCode : 499;

  return function httpAccessLoggerMiddleware(req, res, next) {
    const startTime =
      typeof process.hrtime?.bigint === 'function' ? process.hrtime.bigint() : Date.now();
    let logged = false;

    const cleanup = () => {
      if (typeof res?.removeListener === 'function') {
        res.removeListener('finish', onFinish);
        res.removeListener('close', onClose);
      }
    };

    const recordEvent = (eventName, isAborted) => {
      if (logged) return;
      logged = true;
      cleanup();

      try {
        let statusCode = typeof res.statusCode === 'number' ? res.statusCode : 200;
        if (isAborted) {
          if (!res.headersSent || !res.statusCode || res.statusCode === 200) {
            statusCode = abortedStatusFallback;
          }
        }

        const isHealth = isHealthRequest(req, healthPathSet);

        if (isHealth && statusCode < 400 && suppressHealthSuccess) {
          return;
        }

        const level = resolveLogLevel({
          statusCode,
          isAborted,
          isHealthCheck: isHealth,
          options
        });

        const durationMs = calculateDurationMs(startTime);
        const requestId = resolveRequestId(req, options) ?? null;
        const route = resolveRoute(req, options);

        const payload = {
          requestId,
          method: req.method || 'GET',
          route,
          statusCode,
          durationMs
        };

        const logFn =
          typeof activeLogger[level] === 'function'
            ? activeLogger[level].bind(activeLogger)
            : typeof activeLogger.info === 'function'
              ? activeLogger.info.bind(activeLogger)
              : typeof activeLogger === 'function'
                ? activeLogger
                : console.log;

        logFn(eventName, payload);
      } catch {
        // Logging safeguards: never crash or destabilize the request lifecycle
      }
    };

    const onFinish = () => {
      recordEvent('http.request.completed', false);
    };

    const onClose = () => {
      const isAborted = !res.writableEnded && !res.finished;
      const eventName = isAborted ? 'http.request.aborted' : 'http.request.completed';
      recordEvent(eventName, isAborted);
    };

    if (typeof res?.once === 'function') {
      res.once('finish', onFinish);
      res.once('close', onClose);
    }

    if (typeof next === 'function') {
      next();
    }
  };
}

// Pre-instantiated middleware instance for zero-configuration app.use(httpAccessLogger)
const defaultHttpAccessLoggerMiddleware = createHttpAccessLogger({});

/**
 * Universal export supporting both factory and direct middleware usage:
 * - Direct: app.use(httpAccessLogger)
 * - Factory: app.use(httpAccessLogger({ logger: customLogger }))
 *
 * @param {*} first - Configuration options or Express req
 * @param {*} [second] - Express res
 * @param {*} [third] - Express next
 * @returns {Function|void}
 */
export function httpAccessLogger(first, second, third) {
  if (first && second && typeof third === 'function') {
    return defaultHttpAccessLoggerMiddleware(first, second, third);
  }

  const options = first && typeof first === 'object' ? first : {};
  return createHttpAccessLogger(options);
}

export default httpAccessLogger;
