/**
 * Centralized Structured Logger for Paperless.
 *
 * Implements a minimal, zero-dependency logging foundation providing:
 * - Leveled logging: debug, info, warn, error, fatal, silent
 * - Environment-aware output formatting (development: readable text, staging/production: single-line NDJSON)
 * - Safe serialization of messages, context, and Error instances using redactionPolicy
 * - Resilient output handling with non-crashing stream write safeguards
 * - Child logger support for contextual metadata propagation
 */

import { redactString, redactObject, serializeError } from './redactionPolicy.js';

// Supported log levels and their numeric priorities
export const LOG_LEVELS = Object.freeze({
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100
});

// Default log level by runtime environment
export const DEFAULT_LEVEL_BY_ENV = Object.freeze({
  development: 'debug',
  test: 'silent',
  staging: 'info',
  production: 'info'
});

// Active ambient context provider (e.g. from AsyncLocalStorage)
let activeContextProvider = null;

/**
 * Registers an ambient context provider function (e.g. AsyncLocalStorage accessor).
 * When provided, dynamic context such as requestId is automatically included in log records.
 *
 * @param {Function|null} providerFn - Function returning context object or null
 */
export function setLogContextProvider(providerFn) {
  activeContextProvider = typeof providerFn === 'function' ? providerFn : null;
}

/**
 * Retrieves the currently registered ambient context provider function.
 *
 * @returns {Function|null}
 */
export function getLogContextProvider() {
  return activeContextProvider;
}

/**
 * Validates whether a given level name is a recognized log level.
 *
 * @param {string} level - Level name to validate
 * @returns {boolean} True if level is valid
 */
export function isValidLogLevel(level) {
  if (typeof level !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, level.trim().toLowerCase());
}

/**
 * Resolves the effective log level given an optional override and environment.
 * Falls back safely to environment default if override is missing or invalid.
 *
 * @param {string} [levelOverride] - Requested level name
 * @param {string} [env] - Runtime environment name
 * @returns {string} Normalized level name
 */
export function resolveLogLevel(levelOverride, env = process.env.NODE_ENV) {
  const normalizedEnv =
    typeof env === 'string' && env.trim() ? env.trim().toLowerCase() : 'development';

  if (typeof levelOverride === 'string' && levelOverride.trim()) {
    const candidate = levelOverride.trim().toLowerCase();
    if (isValidLogLevel(candidate)) {
      return candidate;
    }
  }

  return DEFAULT_LEVEL_BY_ENV[normalizedEnv] || 'info';
}

/**
 * Normalizes varied function arguments into a consistent structure: { message, error, context }.
 *
 * Supported signatures:
 * - (message)
 * - (message, context)
 * - (message, error)
 * - (message, error, context)
 * - (error)
 * - (error, context)
 * - (context, message)
 *
 * @param {*} first
 * @param {*} second
 * @param {*} third
 * @returns {{ message: string, error: Error|null, context: Object|null }}
 */
function normalizeLogArgs(first, second, third) {
  let message = '';
  let error = null;
  let context = null;

  if (first instanceof Error) {
    error = first;
    message = first.message || 'Error';
    if (second && typeof second === 'object' && !(second instanceof Error)) {
      context = second;
    }
  } else if (typeof first === 'string') {
    message = first;
    if (second instanceof Error) {
      error = second;
      if (third && typeof third === 'object' && !(third instanceof Error)) {
        context = third;
      }
    } else if (second && typeof second === 'object') {
      context = second;
    }
  } else if (first && typeof first === 'object') {
    context = first;
    message = typeof second === 'string' ? second : 'Log entry';
    if (third instanceof Error) {
      error = third;
    }
  } else {
    message = String(first ?? '');
  }

  return { message, error, context };
}

/**
 * Filters out raw HTTP request/response internals if accidentally passed in context.
 *
 * @param {Object} ctx - Context object
 * @returns {Object} Safe context object
 */
function sanitizeContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;

  // Protect against accidental passing of Express req / res objects
  if (
    typeof ctx.headers === 'object' &&
    (typeof ctx.method === 'string' || typeof ctx.url === 'string')
  ) {
    return {
      method: ctx.method,
      url: redactString(ctx.originalUrl || ctx.url || ''),
      ip: ctx.ip || undefined
    };
  }

  return redactObject(ctx);
}

/**
 * Formats a log record for readable development terminal output.
 *
 * @param {Object} record - Canonical log record
 * @returns {string} Formatted string
 */
function formatDevelopmentText(record) {
  const { timestamp, level, service, message, context, error } = record;
  const levelPadded = level.toUpperCase().padEnd(5);
  let out = `[${timestamp}] [${levelPadded}] (${service}) ${message}`;

  if (context && typeof context === 'object' && Object.keys(context).length > 0) {
    try {
      out += ` ${JSON.stringify(context)}`;
    } catch {
      out += ' [Context serialization error]';
    }
  }

  if (error) {
    if (error.stack) {
      out += `\n${error.stack}`;
    } else {
      out += `\n${error.name || 'Error'}: ${error.message || ''}`;
    }
  }

  return out;
}

/**
 * Formats a log record as a valid single-line NDJSON string.
 *
 * @param {Object} record - Canonical log record
 * @returns {string} Single-line JSON string
 */
function formatNdjson(record) {
  return JSON.stringify(record);
}

/**
 * Creates a new structured Logger instance with the specified configuration.
 *
 * @param {Object} [options] - Configuration options
 * @param {string} [options.level] - Explicit log level override
 * @param {string} [options.env] - Runtime environment name
 * @param {string} [options.serviceName='paperless-api'] - Service name identifier
 * @param {Function} [options.destination] - Custom output sink: (line, { level, record }) => void
 * @param {string} [options.format] - Explicit format override ('text' or 'json')
 * @param {Object} [options.defaultContext] - Base context to include in all emissions
 * @returns {Object} Logger instance
 */
export function createLogger(options = {}) {
  const env =
    typeof options.env === 'string' && options.env.trim()
      ? options.env.trim()
      : process.env.NODE_ENV || 'development';
  const serviceName = options.serviceName || 'paperless-api';
  const defaultContext = options.defaultContext ? redactObject(options.defaultContext) : null;

  // Determine current active level
  let currentLevelName = resolveLogLevel(
    options.level !== undefined ? options.level : process.env.LOG_LEVEL,
    env
  );

  // Determine formatting strategy
  const isDevelopment = env === 'development';
  const formatType = options.format || (isDevelopment ? 'text' : 'json');

  // Last output write failure tracking (for diagnostics and non-crashing tests)
  let lastStreamError = null;

  // Standard output destination
  const defaultDestination = (line, { level }) => {
    const isErrorLevel = level === 'error' || level === 'fatal';
    const targetStream = isErrorLevel ? process.stderr : process.stdout;
    targetStream.write(line + '\n');
  };

  const outputSink =
    typeof options.destination === 'function' ? options.destination : defaultDestination;

  /**
   * Internal write dispatcher with stream failure resilience.
   * Ensures output stream errors (e.g. EPIPE, closed pipe) never crash the process.
   */
  const writeRecord = (level, first, second, third) => {
    const levelNumeric = LOG_LEVELS[level] || LOG_LEVELS.info;
    const currentNumeric = LOG_LEVELS[currentLevelName] || LOG_LEVELS.info;

    // Filter out entries below configured threshold
    if (levelNumeric < currentNumeric || currentLevelName === 'silent') {
      return null;
    }

    const { message, error, context: rawContext } = normalizeLogArgs(first, second, third);

    // Retrieve ambient dynamic context if provider registered
    let ambientContext = null;
    if (typeof activeContextProvider === 'function') {
      try {
        const rawAmbient = activeContextProvider();
        if (rawAmbient && typeof rawAmbient === 'object') {
          ambientContext = sanitizeContext(rawAmbient);
        }
      } catch {
        ambientContext = null;
      }
    }

    // Merge ambientContext, defaultContext, and call-site context
    let mergedContext = null;
    const hasAmbient = ambientContext && Object.keys(ambientContext).length > 0;
    if (hasAmbient || defaultContext || rawContext) {
      const sanitizedCallContext = rawContext ? sanitizeContext(rawContext) : null;
      mergedContext = {
        ...(ambientContext || {}),
        ...(defaultContext || {}),
        ...(sanitizedCallContext || {})
      };
    }

    const record = {
      timestamp: new Date().toISOString(),
      level,
      service: serviceName,
      env,
      pid: process.pid,
      message: redactString(message)
    };

    if (mergedContext && Object.keys(mergedContext).length > 0) {
      record.context = mergedContext;
    }

    if (error) {
      record.error = serializeError(error);
    }

    let line = '';
    try {
      line = formatType === 'text' ? formatDevelopmentText(record) : formatNdjson(record);
    } catch {
      line = JSON.stringify({
        timestamp: record.timestamp,
        level: record.level,
        service: record.service,
        env: record.env,
        pid: record.pid,
        message: '[Logger formatting failure]'
      });
    }

    try {
      outputSink(line, { level, record });
    } catch (streamErr) {
      lastStreamError = streamErr;
      // Intended failure behavior: do not crash or destabilize the application
    }

    return record;
  };

  const loggerInstance = {
    get level() {
      return currentLevelName;
    },
    set level(newLevel) {
      currentLevelName = resolveLogLevel(newLevel, env);
    },
    get env() {
      return env;
    },
    get serviceName() {
      return serviceName;
    },
    get lastStreamError() {
      return lastStreamError;
    },

    isLevelEnabled(checkLevel) {
      if (!isValidLogLevel(checkLevel)) return false;
      if (currentLevelName === 'silent') return false;
      return (LOG_LEVELS[checkLevel.toLowerCase()] || 0) >= (LOG_LEVELS[currentLevelName] || 0);
    },

    debug(first, second, third) {
      return writeRecord('debug', first, second, third);
    },

    info(first, second, third) {
      return writeRecord('info', first, second, third);
    },

    warn(first, second, third) {
      return writeRecord('warn', first, second, third);
    },

    error(first, second, third) {
      return writeRecord('error', first, second, third);
    },

    fatal(first, second, third) {
      return writeRecord('fatal', first, second, third);
    },

    /**
     * Creates a child logger with bound contextual metadata.
     *
     * @param {Object} bindings - Context to bind to every child emission
     * @returns {Object} Child logger instance
     */
    child(bindings = {}) {
      const mergedDefaultContext = {
        ...(defaultContext || {}),
        ...sanitizeContext(bindings)
      };

      return createLogger({
        level: currentLevelName,
        env,
        serviceName,
        destination: outputSink,
        format: formatType,
        defaultContext: mergedDefaultContext
      });
    }
  };

  return loggerInstance;
}

// Default application singleton logger instance
export const logger = createLogger();
