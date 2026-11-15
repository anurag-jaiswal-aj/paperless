/**
 * Security Audit Service for Paperless.
 *
 * Implements a small, structured, privacy-conscious security audit event system:
 * - Stable security event taxonomy
 * - Privacy-preserving metadata handling (PII masking and raw IP exclusion)
 * - Strict exclusion of raw user and session identifiers
 * - Server-authoritative request correlation validation
 * - Bounded, low-cardinality in-process diagnostic counters
 * - Non-crashing resilience guarantees
 */

import { logger as defaultLogger } from '../utils/logger.js';
import { redactString } from '../utils/redactionPolicy.js';
import { getRequestId } from '../middleware/requestCorrelation.js';

/**
 * Stable security audit event taxonomy names.
 */
export const SECURITY_AUDIT_EVENTS = Object.freeze({
  AUTH_LOGIN_SUCCESS: 'security.auth.login.success',
  AUTH_LOGIN_FAILURE: 'security.auth.login.failure',
  AUTH_LOCKOUT: 'security.auth.lockout',
  AUTH_DELAY_APPLIED: 'security.auth.delay.applied',
  AUTH_TOKEN_REFRESH: 'security.auth.token.refresh',
  AUTH_TOKEN_REPLAY: 'security.auth.token.replay',
  AUTH_TOKEN_RACE_REJECTED: 'security.auth.token.race_rejected',
  AUTH_LOGOUT: 'security.auth.logout',
  AUTH_PASSWORD_RESET_REQUESTED: 'security.auth.password_reset.requested',
  AUTH_PASSWORD_RESET_COMPLETED: 'security.auth.password_reset.completed',
  CSRF_REJECTED: 'security.csrf.rejected'
});

/**
 * Predefined, low-cardinality diagnostic counter names.
 * Fixed in memory with zero dynamic labels.
 */
export const DIAGNOSTIC_COUNTER_NAMES = Object.freeze([
  'auth_login_success_total',
  'auth_login_failure_total',
  'auth_lockout_active_total',
  'auth_delay_applied_total',
  'security_csrf_rejection_total',
  'security_token_replay_total',
  'auth_password_reset_request_total',
  'auth_password_reset_success_total',
  'auth_session_revoked_total',
  'worker_spawn_total',
  'worker_ready_total',
  'worker_task_success_total',
  'worker_task_failure_total',
  'worker_unexpected_exit_total',
  'worker_replacement_attempt_total',
  'worker_replacement_failure_total',
  'worker_shutdown_failure_total',
  'coordinator_task_queued_total',
  'coordinator_task_timeout_total',
  'coordinator_task_saturated_total'
]);

/**
 * Internal scalar storage for diagnostic counters.
 */
const diagnosticCounters = new Map();
for (const name of DIAGNOSTIC_COUNTER_NAMES) {
  diagnosticCounters.set(name, 0);
}

/**
 * Increments a predefined diagnostic counter safely.
 * Rejects non-numbers, non-finite values, and non-positive numbers (safe no-op).
 * Saturates at Number.MAX_SAFE_INTEGER to prevent overflow to Infinity.
 *
 * @param {string} name - Name from DIAGNOSTIC_COUNTER_NAMES
 * @param {number} [amount=1] - Increment amount (positive finite integer)
 * @returns {number} Updated counter value or 0 on invalid name
 */
export function incrementDiagnosticCounter(name, amount = 1) {
  try {
    if (!diagnosticCounters.has(name)) {
      return 0;
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return diagnosticCounters.get(name) || 0;
    }
    const current = diagnosticCounters.get(name) || 0;
    const spaceLeft = Number.MAX_SAFE_INTEGER - current;
    const safeIncrement = Math.min(Math.floor(amount), spaceLeft > 0 ? spaceLeft : 0);
    const updated = current + safeIncrement;
    diagnosticCounters.set(name, updated);
    return updated;
  } catch {
    return 0;
  }
}

/**
 * Retrieves a frozen snapshot of all current diagnostic counters.
 *
 * @returns {Readonly<Record<string, number>>}
 */
export function getDiagnosticCounters() {
  try {
    const snapshot = {};
    for (const name of DIAGNOSTIC_COUNTER_NAMES) {
      snapshot[name] = diagnosticCounters.get(name) || 0;
    }
    return Object.freeze(snapshot);
  } catch {
    return Object.freeze({});
  }
}

/**
 * Resets all diagnostic counters to zero.
 * Intended primarily for test isolation.
 */
export function resetDiagnosticCounters() {
  try {
    for (const name of DIAGNOSTIC_COUNTER_NAMES) {
      diagnosticCounters.set(name, 0);
    }
  } catch {
    // Fail-safe
  }
}

/**
 * UUID v4 regular expression for server-authoritative request ID validation.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates whether candidate string is a valid server-generated request ID.
 *
 * @param {*} candidate
 * @returns {boolean}
 */
function isValidRequestId(candidate) {
  return (
    typeof candidate === 'string' && candidate.length <= 64 && UUID_V4_REGEX.test(candidate.trim())
  );
}

/**
 * Resolves the request correlation ID from trusted server-side sources only:
 * 1. AsyncLocalStorage active context (getRequestId())
 * 2. Trusted server-assigned req.id if valid UUID v4
 *
 * Never adopts raw client-supplied request headers.
 * If no valid server request ID exists, returns undefined.
 *
 * @param {Object} [req] - Express request object
 * @returns {string|undefined} Validated server-generated request ID or undefined
 */
function resolveRequestId(req) {
  try {
    const contextId = getRequestId();
    if (isValidRequestId(contextId)) {
      return contextId.trim();
    }
  } catch {
    // Ignore context lookup errors
  }

  if (req && isValidRequestId(req.id)) {
    return req.id.trim();
  }

  return undefined;
}

/**
 * Resolves safe IP hash without ever logging raw IP in cleartext.
 *
 * @param {Object} options
 * @param {string} [options.ipHash] - Pre-derived IP hash
 * @param {string} [options.clientIp] - Raw client IP to hash via service
 * @param {string} [options.ip] - Raw IP alias
 * @param {Object} [protectionService] - Optional LoginProtectionService instance
 * @returns {string|undefined} Derived IP hash or undefined
 */
function resolveIpHash(options = {}, protectionService = null) {
  if (typeof options.ipHash === 'string' && options.ipHash.trim()) {
    return options.ipHash.trim();
  }

  const rawIp = options.clientIp || options.ip;
  if (!rawIp || typeof rawIp !== 'string') {
    return undefined;
  }

  if (protectionService && typeof protectionService.deriveIpHash === 'function') {
    try {
      return protectionService.deriveIpHash(rawIp);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Masks email address using existing redaction policy.
 *
 * @param {*} email - Raw email candidate
 * @returns {string|undefined} Masked email or undefined
 */
function maskEmail(email) {
  if (typeof email !== 'string' || !email.trim()) {
    return undefined;
  }
  return redactString(email.trim());
}

/**
 * Sanitizes and bounds untrusted CSRF origin metadata.
 * Strips control characters, terminal escape codes, and line separators.
 * Capped at a maximum length of 128 characters.
 *
 * @param {*} origin - Untrusted origin header string
 * @returns {string|undefined} Clean bounded origin or undefined
 */
function sanitizeCsrfOrigin(origin) {
  if (typeof origin !== 'string') {
    return undefined;
  }
  // Strip control characters (0x00-0x1F and 0x7F-0x9F)
  // eslint-disable-next-line no-control-regex
  const stripped = origin.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
  if (!stripped) {
    return undefined;
  }
  return stripped.slice(0, 128);
}

/**
 * SecurityAuditService class.
 */
export class SecurityAuditService {
  /**
   * @param {Object} [options={}]
   * @param {Object} [options.logger] - Structured logger instance
   * @param {Object} [options.protectionService] - LoginProtectionService instance
   */
  constructor(options = {}) {
    this.logger = options.logger || defaultLogger;
    this.protectionService = options.protectionService || null;
  }

  /**
   * Allows updating or injecting a protection service instance.
   *
   * @param {Object} protectionService
   */
  setProtectionService(protectionService) {
    this.protectionService = protectionService || null;
  }

  /**
   * Internal generic audit event dispatcher with resilience safeguards.
   * Defense-in-depth: explicitly strips raw user and session identifiers.
   *
   * @private
   * @param {Object} params
   * @param {string} params.eventName
   * @param {string} params.level - 'info' or 'warn'
   * @param {string} params.category
   * @param {string} params.outcome
   * @param {Object} [params.req]
   * @param {Object} [params.metadata]
   * @returns {boolean} True if event dispatched successfully
   */
  _emit({ eventName, level = 'info', category, outcome, req, metadata = {} }) {
    try {
      const auditPayload = {
        audit: true,
        action: eventName,
        category,
        outcome
      };

      const requestId = resolveRequestId(req);
      if (requestId) {
        auditPayload.requestId = requestId;
      }

      // Merge allowed metadata fields with strict exclusion of prohibited raw identifiers
      for (const [key, value] of Object.entries(metadata)) {
        if (value !== undefined && value !== null && key !== 'userId' && key !== 'sessionId') {
          auditPayload[key] = value;
        }
      }

      const logFn =
        typeof this.logger[level] === 'function' ? this.logger[level] : this.logger.info;
      logFn.call(this.logger, eventName, auditPayload);
      return true;
    } catch {
      // Fail closed against throwing to guarantee calling flow is never broken
      return false;
    }
  }

  /**
   * Records a successful user authentication event.
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.email]
   * @returns {boolean}
   */
  recordLoginSuccess(options) {
    try {
      const { req, email } = options || {};
      incrementDiagnosticCounter('auth_login_success_total');

      const metadata = {};
      const masked = maskEmail(email);
      if (masked) metadata.emailMasked = masked;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_LOGIN_SUCCESS,
        level: 'info',
        category: 'authentication',
        outcome: 'success',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a failed user authentication attempt (invalid credentials).
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.email]
   * @param {string} [options.ipHash]
   * @param {string} [options.clientIp]
   * @param {string} [options.reason='invalid_credentials']
   * @param {boolean} [options.accountExists]
   * @param {number} [options.failedAttempts]
   * @returns {boolean}
   */
  recordLoginFailure(options) {
    try {
      const {
        req,
        email,
        ipHash,
        clientIp,
        reason = 'invalid_credentials',
        accountExists,
        failedAttempts
      } = options || {};

      incrementDiagnosticCounter('auth_login_failure_total');

      const metadata = { reason: String(reason) };
      const masked = maskEmail(email);
      if (masked) metadata.emailMasked = masked;

      const resolvedHash = resolveIpHash({ ipHash, clientIp }, this.protectionService);
      if (resolvedHash) metadata.ipHash = resolvedHash;

      if (typeof accountExists === 'boolean') metadata.accountExists = accountExists;
      if (typeof failedAttempts === 'number') metadata.failedAttempts = failedAttempts;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_LOGIN_FAILURE,
        level: 'warn',
        category: 'authentication',
        outcome: 'failure',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a progressive login lockout event (pre-check or post-failure).
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.email]
   * @param {string} [options.ipHash]
   * @param {string} [options.clientIp]
   * @param {number} [options.retryAfterSeconds]
   * @param {string} [options.tier='pair']
   * @param {string} [options.stage='post_failure']
   * @param {string} [options.status]
   * @param {number} [options.failedAttempts]
   * @returns {boolean}
   */
  recordLockout(options) {
    try {
      const {
        req,
        email,
        ipHash,
        clientIp,
        retryAfterSeconds,
        tier = 'pair',
        stage = 'post_failure',
        status,
        failedAttempts
      } = options || {};

      incrementDiagnosticCounter('auth_lockout_active_total');

      const metadata = {
        tier: String(tier),
        stage: String(stage)
      };

      const masked = maskEmail(email);
      if (masked) metadata.emailMasked = masked;

      const resolvedHash = resolveIpHash({ ipHash, clientIp }, this.protectionService);
      if (resolvedHash) metadata.ipHash = resolvedHash;

      if (typeof retryAfterSeconds === 'number') metadata.retryAfterSeconds = retryAfterSeconds;
      if (status) metadata.status = String(status);
      if (typeof failedAttempts === 'number') metadata.failedAttempts = failedAttempts;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_LOCKOUT,
        level: 'warn',
        category: 'authentication',
        outcome: 'blocked',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records an advisory cross-IP password spray delay applied to an authentication attempt.
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.email]
   * @param {string} [options.ipHash]
   * @param {string} [options.clientIp]
   * @param {number} [options.delayMs]
   * @param {number} [options.distinctIpsCount]
   * @returns {boolean}
   */
  recordSprayDelay(options) {
    try {
      const { req, email, ipHash, clientIp, delayMs, distinctIpsCount } = options || {};

      incrementDiagnosticCounter('auth_delay_applied_total');

      const metadata = {};
      const masked = maskEmail(email);
      if (masked) metadata.emailMasked = masked;

      const resolvedHash = resolveIpHash({ ipHash, clientIp }, this.protectionService);
      if (resolvedHash) metadata.ipHash = resolvedHash;

      if (typeof delayMs === 'number') metadata.delayMs = delayMs;
      if (typeof distinctIpsCount === 'number') metadata.distinctIpsCount = distinctIpsCount;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_DELAY_APPLIED,
        level: 'info',
        category: 'authentication',
        outcome: 'applied',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a successful refresh token rotation.
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.ipHash]
   * @param {string} [options.clientIp]
   * @returns {boolean}
   */
  recordTokenRefresh(options) {
    try {
      const { req, ipHash, clientIp } = options || {};

      const metadata = {};
      const resolvedHash = resolveIpHash({ ipHash, clientIp }, this.protectionService);
      if (resolvedHash) metadata.ipHash = resolvedHash;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_TOKEN_REFRESH,
        level: 'info',
        category: 'session',
        outcome: 'success',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a detected refresh token replay attack (consumed token reuse outside grace window).
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.ipHash]
   * @param {string} [options.clientIp]
   * @param {number} [options.timeSinceRotationMs]
   * @returns {boolean}
   */
  recordTokenReplay(options) {
    try {
      const { req, ipHash, clientIp, timeSinceRotationMs } = options || {};

      incrementDiagnosticCounter('security_token_replay_total');
      incrementDiagnosticCounter('auth_session_revoked_total');

      const metadata = {};
      const resolvedHash = resolveIpHash({ ipHash, clientIp }, this.protectionService);
      if (resolvedHash) metadata.ipHash = resolvedHash;

      if (typeof timeSinceRotationMs === 'number') {
        metadata.timeSinceRotationMs = timeSinceRotationMs;
      }

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_TOKEN_REPLAY,
        level: 'warn',
        category: 'session',
        outcome: 'detected',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a benign concurrent refresh token race rejected within the grace window.
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.ipHash]
   * @param {string} [options.clientIp]
   * @returns {boolean}
   */
  recordTokenRaceRejected(options) {
    try {
      const { req, ipHash, clientIp } = options || {};

      const metadata = {};
      const resolvedHash = resolveIpHash({ ipHash, clientIp }, this.protectionService);
      if (resolvedHash) metadata.ipHash = resolvedHash;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_TOKEN_RACE_REJECTED,
        level: 'info',
        category: 'session',
        outcome: 'rejected',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records an explicit user logout event.
   * Increments auth_session_revoked_total ONLY when sessionRevoked is true.
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {boolean} [options.sessionRevoked=false]
   * @param {string} [options.ipHash]
   * @param {string} [options.clientIp]
   * @returns {boolean}
   */
  recordLogout(options) {
    try {
      const { req, sessionRevoked = false, ipHash, clientIp } = options || {};

      if (sessionRevoked) {
        incrementDiagnosticCounter('auth_session_revoked_total');
      }

      const metadata = {};
      const resolvedHash = resolveIpHash({ ipHash, clientIp }, this.protectionService);
      if (resolvedHash) metadata.ipHash = resolvedHash;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_LOGOUT,
        level: 'info',
        category: 'session',
        outcome: 'success',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a password reset request event.
   * Does NOT record accountExists to prevent internal account enumeration.
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.email]
   * @returns {boolean}
   */
  recordPasswordResetRequested(options) {
    try {
      const { req, email } = options || {};

      incrementDiagnosticCounter('auth_password_reset_request_total');

      const metadata = {};
      const masked = maskEmail(email);
      if (masked) metadata.emailMasked = masked;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_PASSWORD_RESET_REQUESTED,
        level: 'info',
        category: 'password_reset',
        outcome: 'requested',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a successful password reset completion event.
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.ipHash]
   * @param {string} [options.clientIp]
   * @returns {boolean}
   */
  recordPasswordResetCompleted(options) {
    try {
      const { req, ipHash, clientIp } = options || {};

      incrementDiagnosticCounter('auth_password_reset_success_total');
      incrementDiagnosticCounter('auth_session_revoked_total');

      const metadata = {};
      const resolvedHash = resolveIpHash({ ipHash, clientIp }, this.protectionService);
      if (resolvedHash) metadata.ipHash = resolvedHash;

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.AUTH_PASSWORD_RESET_COMPLETED,
        level: 'info',
        category: 'password_reset',
        outcome: 'success',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a CSRF origin or credential validation rejection.
   * Bounds and sanitizes origin: strips control characters, max 128 chars.
   *
   * @param {Object} [options]
   * @param {Object} [options.req]
   * @param {string} [options.origin]
   * @param {string} [options.reason='untrusted_origin']
   * @returns {boolean}
   */
  recordCsrfRejection(options) {
    try {
      const { req, origin, reason = 'untrusted_origin' } = options || {};

      incrementDiagnosticCounter('security_csrf_rejection_total');

      const metadata = { reason: String(reason) };
      const sanitizedOrigin = sanitizeCsrfOrigin(origin);
      if (sanitizedOrigin) {
        metadata.origin = sanitizedOrigin;
      }

      return this._emit({
        eventName: SECURITY_AUDIT_EVENTS.CSRF_REJECTED,
        level: 'warn',
        category: 'csrf',
        outcome: 'rejected',
        req,
        metadata
      });
    } catch {
      return false;
    }
  }
}

/**
 * Singleton instance of SecurityAuditService.
 */
export const securityAuditService = new SecurityAuditService();
export default securityAuditService;
