/**
 * Redaction and Error Serialization Policy for Paperless.
 * Provides deep redaction of sensitive credentials, URL query parameters,
 * authentication tokens, secrets, and error serialization with cycle protection.
 */

// List of sensitive object key names (matched case-insensitively).
export const DEFAULT_SENSITIVE_KEYS = Object.freeze([
  'password',
  'newPassword',
  'confirmPassword',
  'currentPassword',
  'oldPassword',
  'token',
  'refreshToken',
  'accessToken',
  'resetToken',
  'resetPasswordToken',
  'secret',
  'jwtSecret',
  'jwtRefreshSecret',
  'hmacSecret',
  'loginProtectionHmacSecret',
  'apiKey',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'accessKeyId',
  'secretAccessKey',
  'answers'
]);

// Build a Set of lowercase normalized key representations for fast case-insensitive lookup.
const SENSITIVE_KEY_SET = new Set(
  DEFAULT_SENSITIVE_KEYS.flatMap((key) => {
    const lower = key.toLowerCase();
    const stripped = lower.replace(/[-_]/g, '');
    return [lower, stripped];
  })
);

// Regular expressions for string pattern redaction.
export const PATTERNS = Object.freeze({
  BEARER: /(Bearer\s+)[a-zA-Z0-9_\-.~+/]+=*/gi,
  JWT: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
  OPENAI_KEY: /\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}\b/g,
  RESEND_KEY: /\bre_[a-zA-Z0-9_]{16,}\b/g,
  AWS_KEY: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  MONGO_URI: /(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@)/gi,
  PASSWORD_RESET_URL: /(\/reset-?password\/)[a-zA-Z0-9_%~.-]+/gi,
  SENSITIVE_QUERY_PARAM:
    /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|reset[-_]?token|resettoken|auth[-_]?token|token|client[-_]?secret|secret|password|passwd|pwd|authorization|auth|code|sig|signature|key)=)[^&#\s]+/gi,
  EMAIL: /([a-zA-Z0-9._%+-]{1,2})[a-zA-Z0-9._%+-]*(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g
});

/**
 * Checks whether a given property key is sensitive according to the redaction policy.
 * Matching is case-insensitive and normalizes hyphens/underscores.
 *
 * @param {string} key - Property key name
 * @param {Object} [options] - Optional settings
 * @param {Iterable<string>} [options.customKeys] - Additional sensitive keys
 * @returns {boolean} True if the key is sensitive
 */
export function isSensitiveKey(key, options = {}) {
  if (typeof key !== 'string') {
    return false;
  }
  const lower = key.toLowerCase();
  const stripped = lower.replace(/[-_]/g, '');

  if (SENSITIVE_KEY_SET.has(lower) || SENSITIVE_KEY_SET.has(stripped)) {
    return true;
  }

  const custom = options.customKeys || options.additionalKeys || options.sensitiveKeys;
  if (custom && typeof custom[Symbol.iterator] === 'function') {
    for (const item of custom) {
      if (typeof item === 'string') {
        const itemLower = item.toLowerCase();
        const itemStripped = itemLower.replace(/[-_]/g, '');
        if (lower === itemLower || stripped === itemStripped) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Scrubs supported sensitive patterns from strings.
 * Non-string inputs are safely returned unchanged.
 *
 * @param {*} str - Input to redact
 * @returns {*} Redacted string or original non-string input
 */
export function redactString(str) {
  if (typeof str !== 'string') {
    return str;
  }

  return str
    .replace(PATTERNS.MONGO_URI, '$1[REDACTED]$3')
    .replace(PATTERNS.PASSWORD_RESET_URL, '$1[REDACTED]')
    .replace(PATTERNS.SENSITIVE_QUERY_PARAM, '$1[REDACTED]')
    .replace(PATTERNS.BEARER, '$1[REDACTED]')
    .replace(PATTERNS.JWT, '[REDACTED_JWT]')
    .replace(PATTERNS.OPENAI_KEY, '[REDACTED_OPENAI_KEY]')
    .replace(PATTERNS.RESEND_KEY, '[REDACTED_RESEND_KEY]')
    .replace(PATTERNS.AWS_KEY, '[REDACTED_AWS_KEY]')
    .replace(PATTERNS.EMAIL, '$1***$2');
}

/**
 * Sanitizes request URL paths and query parameters.
 * Compatible with existing Paperless request URL sanitization.
 *
 * @param {string} url - Request URL to sanitize
 * @returns {string} Sanitized URL or empty string for non-string input
 */
export function sanitizeRequestUrl(url) {
  if (typeof url !== 'string') {
    return '';
  }

  return url
    .replace(PATTERNS.PASSWORD_RESET_URL, '$1[REDACTED]')
    .replace(PATTERNS.SENSITIVE_QUERY_PARAM, '$1[REDACTED]');
}

/**
 * Creates a deep clone of the input object with sensitive keys replaced with "[REDACTED]",
 * string values scrubbed via redactString, circular references detected via WeakSet,
 * and traversal depth bounded to prevent stack overflow.
 * Never mutates input objects.
 *
 * @param {*} obj - The object to redact
 * @param {Object} [options] - Configuration options
 * @param {number} [options.maxDepth=10] - Maximum recursion depth
 * @param {string} [options.replacement='[REDACTED]'] - Replacement for sensitive keys
 * @param {boolean} [options.redactStrings=true] - Whether to scrub string values
 * @param {WeakSet} [options.seen] - Internal WeakSet for circular reference detection
 * @param {number} [options.depth=0] - Internal current recursion depth
 * @returns {*} Cloned and redacted object
 */
export function redactObject(obj, options = {}) {
  const maxDepth = options.maxDepth !== undefined ? options.maxDepth : 10;
  const replacement = options.replacement !== undefined ? options.replacement : '[REDACTED]';
  const depth = options.depth !== undefined ? options.depth : 0;
  const seen = options.seen || options.seenErrors || new WeakSet();

  // Primitives and non-objects
  if (obj === null || typeof obj !== 'object') {
    if (typeof obj === 'string' && options.redactStrings !== false) {
      return redactString(obj);
    }
    return obj;
  }

  // Depth boundary
  if (depth >= maxDepth) {
    return options.depthExceededValue !== undefined
      ? options.depthExceededValue
      : '[MAX_DEPTH_EXCEEDED]';
  }

  // Special object types that do not require circular tracking
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }

  if (obj instanceof RegExp) {
    return new RegExp(obj.source, obj.flags);
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(obj)) {
    return Buffer.from(obj);
  }

  // Error instances delegate directly to serializeError, which manages its own
  // seenErrors cycle detection. Checking before seen.add avoids false positive cycles.
  if (obj instanceof Error) {
    return serializeError(obj, {
      ...options,
      depth,
      maxDepth,
      seen,
      seenErrors: seen
    });
  }

  // Circular reference check
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      const clonedArray = [];
      for (let i = 0; i < obj.length; i++) {
        clonedArray.push(
          redactObject(obj[i], {
            ...options,
            depth: depth + 1,
            maxDepth,
            seen
          })
        );
      }
      return clonedArray;
    }

    // Plain objects and other objects
    const clonedObj = {};
    const keys = Object.keys(obj);

    for (const key of keys) {
      const val = isSensitiveKey(key, options)
        ? replacement
        : redactObject(obj[key], {
            ...options,
            depth: depth + 1,
            maxDepth,
            seen
          });

      Object.defineProperty(clonedObj, key, {
        value: val,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }

    return clonedObj;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Extracts and sanitizes standard error properties: name, message, stack, code,
 * statusCode, and other own properties. Sanitizes message and stack.
 * Handles circular error causes safely and enforces a maximum depth limit.
 * Never mutates the input Error instance.
 *
 * @param {*} err - The error to serialize
 * @param {Object} [options] - Configuration options
 * @param {number} [options.maxDepth=10] - Maximum recursion depth for nested causes
 * @param {number} [options.depth=0] - Current recursion depth
 * @param {boolean} [options.includeStack=true] - Whether to include error stack
 * @param {WeakSet} [options.seenErrors] - Internal WeakSet for circular error cause detection
 * @returns {Object|string} Serialized and sanitized error object, or depth-exceeded marker
 */
export function serializeError(err, options = {}) {
  const maxDepth = options.maxDepth !== undefined ? options.maxDepth : 10;
  const depth = options.depth !== undefined ? options.depth : 0;

  // Depth boundary
  if (depth >= maxDepth) {
    return options.depthExceededValue !== undefined
      ? options.depthExceededValue
      : '[MAX_DEPTH_EXCEEDED]';
  }

  if (!err || typeof err !== 'object') {
    return {
      name: 'Error',
      message: redactString(typeof err === 'string' ? err : String(err ?? ''))
    };
  }

  const seenErrors = options.seenErrors || options.seen || new WeakSet();
  if (seenErrors.has(err)) {
    return '[Circular]';
  }
  seenErrors.add(err);

  try {
    const serialized = {
      name: err.name || 'Error',
      message: redactString(err.message || '')
    };

    if (err.stack !== undefined && options.includeStack !== false) {
      serialized.stack = redactString(err.stack);
    }

    if (err.code !== undefined) {
      serialized.code = err.code;
    }

    if (err.statusCode !== undefined) {
      serialized.statusCode = err.statusCode;
    } else if (err.status !== undefined) {
      serialized.statusCode = err.status;
    }

    // Handle cause if present
    if (err.cause !== undefined) {
      if (err.cause && typeof err.cause === 'object') {
        if (seenErrors.has(err.cause)) {
          serialized.cause = '[Circular]';
        } else if (err.cause instanceof Error) {
          serialized.cause = serializeError(err.cause, {
            ...options,
            depth: depth + 1,
            maxDepth,
            seenErrors,
            seen: seenErrors
          });
        } else {
          serialized.cause = redactObject(err.cause, {
            ...options,
            depth: depth + 1,
            maxDepth,
            seen: seenErrors,
            seenErrors
          });
        }
      } else {
        serialized.cause = redactString(err.cause);
      }
    }

    // Extract other own properties
    const standardKeys = new Set([
      'name',
      'message',
      'stack',
      'code',
      'statusCode',
      'status',
      'cause'
    ]);
    const ownKeys = Object.getOwnPropertyNames(err);

    for (const key of ownKeys) {
      if (!standardKeys.has(key)) {
        const val = isSensitiveKey(key, options)
          ? options.replacement !== undefined
            ? options.replacement
            : '[REDACTED]'
          : redactObject(err[key], {
              ...options,
              depth: depth + 1,
              maxDepth,
              seen: seenErrors,
              seenErrors
            });

        Object.defineProperty(serialized, key, {
          value: val,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
    }

    return serialized;
  } finally {
    seenErrors.delete(err);
  }
}
