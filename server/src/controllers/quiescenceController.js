import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import * as quiescenceService from '../services/quiescenceService.js';
import { logger } from '../utils/logger.js';

/**
 * Maximum permitted length for Authorization header and Bearer candidate tokens.
 * Enforcing bounded candidate length prevents CPU-exhaustion denial of service
 * via megabyte-length hash inputs while bounding hashing time to < 1 µs.
 */
export const MAX_CANDIDATE_TOKEN_LENGTH = 128;
export const MAX_AUTH_HEADER_LENGTH = 256;

/**
 * Evaluates whether an incoming request presents a valid BACKUP_INTERNAL_TOKEN.
 * Bounded to <= 128 bytes candidate length and verified in constant time.
 * Used by quiescenceRateLimiter to prevent starvation of legitimate heartbeats/releases.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export const isLegitimateBackupRequest = (req) => {
  const configuredToken = process.env.BACKUP_INTERNAL_TOKEN;
  if (
    !configuredToken ||
    typeof configuredToken !== 'string' ||
    configuredToken.trim() === ''
  ) {
    return false;
  }

  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    return false;
  }

  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) {
    return false;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1] || match[1].trim() === '') {
    return false;
  }

  const clientToken = match[1].trim();
  if (clientToken.length > MAX_CANDIDATE_TOKEN_LENGTH) {
    return false;
  }

  const clientHash = crypto.createHash('sha256').update(clientToken).digest();
  const expectedHash = crypto.createHash('sha256').update(configuredToken.trim()).digest();

  return crypto.timingSafeEqual(clientHash, expectedHash);
};

/**
 * Factory for creating quiescence rate limiters.
 * Protects administrative quiescence endpoints against unauthenticated brute-force
 * guessing attacks and resource exhaustion.
 *
 * CRITICAL REQUIREMENT:
 * The `skip` function exempts legitimate requests carrying a valid BACKUP_INTERNAL_TOKEN,
 * guaranteeing that legitimate heartbeats (every 10s + retries) and releases from the
 * active backup runner are NEVER starved or blocked under rate limiting.
 *
 * @param {object} [customOptions={}]
 * @returns {import('express').RequestHandler}
 */
export const createQuiescenceRateLimiter = (customOptions = {}) => {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max:
      process.env.NODE_ENV === 'test'
        ? (process.env.QUIESCENCE_RATE_LIMIT ? parseInt(process.env.QUIESCENCE_RATE_LIMIT, 10) : 10000)
        : (parseInt(process.env.QUIESCENCE_RATE_LIMIT, 10) || 30),
    keyGenerator: (req) => (req?.ip ? ipKeyGenerator(req.ip) : 'unknown'),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => isLegitimateBackupRequest(req),
    handler: (req, res, _next, options) => {
      const retryAfterHeader = res.getHeader('Retry-After');
      const retryAfter = retryAfterHeader
        ? parseInt(retryAfterHeader, 10)
        : Math.ceil(options.windowMs / 1000);
      const requestId = req?.id || req?.requestId;
      res.status(429).json({
        success: false,
        message: 'Too many administrative requests, please try again later.',
        retryAfter,
        ...(requestId ? { requestId } : {})
      });
    },
    ...customOptions
  });
};

export const quiescenceRateLimiter = createQuiescenceRateLimiter();

/**
 * Authentication middleware for Quiescence administrative API.
 * Validates `Bearer <BACKUP_INTERNAL_TOKEN>` using constant-time comparison (crypto.timingSafeEqual).
 *
 * Fail-closed policy:
 * - If BACKUP_INTERNAL_TOKEN is unset or empty -> HTTP 503 Service Unavailable ("Backup administrative interface disabled").
 * - If token is missing, malformed, oversized (> 128 chars), or invalid -> HTTP 401 Unauthorized.
 * - Enforces bounded candidate length before hashing: SHA-256 is O(N) bounded by 128 bytes (< 1 µs),
 *   neutralizing CPU burn DoS and macro-timing discrepancy, followed by 32-byte constant-time comparison.
 * - Never leaks token or sensitive internal secrets in response or error logs.
 */
export const validateBackupToken = (req, res, next) => {
  const configuredToken = process.env.BACKUP_INTERNAL_TOKEN;

  // Fail closed if BACKUP_INTERNAL_TOKEN is not configured or empty
  if (
    !configuredToken ||
    typeof configuredToken !== 'string' ||
    configuredToken.trim() === ''
  ) {
    logger.warn('Quiescence request rejected: BACKUP_INTERNAL_TOKEN is not configured', {
      event: 'quiescence.auth_disabled',
      path: req.originalUrl || req.path
    });
    return res.status(503).json({
      success: false,
      message: 'Backup administrative interface disabled'
    });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing or invalid authorization token'
    });
  }

  // Reject oversized Authorization headers immediately before regex evaluation
  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) {
    logger.warn('Quiescence request rejected: Authorization header exceeds maximum allowed length', {
      event: 'quiescence.auth_header_oversized',
      path: req.originalUrl || req.path,
      length: authHeader.length
    });
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing or invalid authorization token'
    });
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1] || match[1].trim() === '') {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing or invalid authorization token'
    });
  }

  const clientToken = match[1].trim();

  // Reject oversized candidate tokens immediately before hashing
  if (clientToken.length > MAX_CANDIDATE_TOKEN_LENGTH) {
    logger.warn('Quiescence request rejected: candidate token exceeds maximum allowed length', {
      event: 'quiescence.auth_token_oversized',
      path: req.originalUrl || req.path,
      length: clientToken.length
    });
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing or invalid authorization token'
    });
  }

  // Constant-time comparison using SHA-256 fixed-length digests to avoid timing side-channels
  // Hashing is O(N) bounded by 128 bytes (< 1 µs), followed by 32-byte constant-time comparison
  const clientHash = crypto.createHash('sha256').update(clientToken).digest();
  const expectedHash = crypto.createHash('sha256').update(configuredToken.trim()).digest();

  if (!crypto.timingSafeEqual(clientHash, expectedHash)) {
    logger.warn('Quiescence request rejected: token mismatch', {
      event: 'quiescence.auth_failed',
      path: req.originalUrl || req.path
    });
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing or invalid authorization token'
    });
  }

  next();
};

/**
 * POST /api/admin/quiescence/acquire
 * Acquires a distributed backup lease atomically.
 */
export const acquireLeaseHandler = async (req, res, next) => {
  try {
    const { owner, leaseDurationMs, initialLeaseMs, maxWatchdogMs, initialStatus } =
      req.body || {};

    const maxWatchdogCeiling =
      parseInt(process.env.MAX_WATCHDOG_LEASE_MS, 10) ||
      parseInt(process.env.BACKUP_MAX_WATCHDOG_MS, 10) ||
      180000;

    const requestedDuration = Number(leaseDurationMs || initialLeaseMs);
    if (requestedDuration && (requestedDuration <= 0 || requestedDuration > maxWatchdogCeiling)) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: `Requested lease duration must be between 1 and ${maxWatchdogCeiling}ms`
      });
    }

    const requestedWatchdog = Number(maxWatchdogMs);
    if (requestedWatchdog && (requestedWatchdog <= 0 || requestedWatchdog > maxWatchdogCeiling)) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: `Requested max watchdog must be between 1 and ${maxWatchdogCeiling}ms`
      });
    }

    const result = await quiescenceService.acquire({
      owner,
      leaseDurationMs: leaseDurationMs || initialLeaseMs,
      maxWatchdogMs,
      initialStatus
    });

    if (!result.success) {
      return res.status(409).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    logger.error('Quiescence acquire endpoint error', err, {
      event: 'quiescence.acquire_error'
    });
    next(err);
  }
};

/**
 * POST /api/admin/quiescence/heartbeat
 * Extends the expiry of an active backup lease.
 */
export const heartbeatLeaseHandler = async (req, res, next) => {
  try {
    const { leaseId, heartbeatExtendMs } = req.body || {};

    if (!leaseId || typeof leaseId !== 'string' || !leaseId.trim()) {
      return res.status(400).json({
        success: false,
        message: 'leaseId is required and must be a non-empty string for heartbeat'
      });
    }

    const result = await quiescenceService.heartbeat({
      leaseId,
      heartbeatExtendMs
    });

    if (!result.success) {
      return res.status(409).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    logger.error('Quiescence heartbeat endpoint error', err, {
      event: 'quiescence.heartbeat_error'
    });
    next(err);
  }
};

/**
 * POST /api/admin/quiescence/release
 * Releases an active backup lease and returns system to NORMAL status.
 */
export const releaseLeaseHandler = async (req, res, next) => {
  try {
    const { leaseId } = req.body || {};

    if (!leaseId || typeof leaseId !== 'string' || !leaseId.trim()) {
      return res.status(400).json({
        success: false,
        message: 'leaseId is required and must be a non-empty string for release'
      });
    }

    const result = await quiescenceService.release({ leaseId });

    if (!result.success) {
      return res.status(409).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    logger.error('Quiescence release endpoint error', err, {
      event: 'quiescence.release_error'
    });
    next(err);
  }
};

/**
 * GET /api/admin/quiescence/status
 * Queries current durable quiescence and backup lease status.
 */
export const getStatusHandler = async (req, res, next) => {
  try {
    const status = await quiescenceService.getStatus();
    return res.status(200).json(status);
  } catch (err) {
    logger.error('Quiescence getStatus endpoint error', err, {
      event: 'quiescence.status_error'
    });
    next(err);
  }
};

/**
 * POST /api/admin/quiescence/drain
 * Explicitly initiates or awaits draining of all in-flight mutating requests,
 * active business operations, and background worker tasks.
 *
 * BLK-01 REMEDIATION:
 * Supports blocking wait (timeoutMs > 0) and non-blocking polling (timeoutMs: 0).
 * Does NOT abort the lease on timeout by default (allowing retries).
 */
export const drainInFlightHandler = async (req, res, next) => {
  try {
    const { leaseId, timeoutMs = 15000, autoQuiesce = true } = req.body || {};

    if (!leaseId || typeof leaseId !== 'string' || !leaseId.trim()) {
      return res.status(400).json({
        success: false,
        message: 'leaseId is required and must be a non-empty string for draining'
      });
    }

    // Verify current lease status
    const currentStatus = await quiescenceService.getStatus();
    if (!currentStatus || currentStatus.leaseId !== leaseId) {
      return res.status(409).json({
        success: false,
        reason: 'LEASE_NOT_FOUND_OR_MISMATCH',
        message: 'No active lease matching provided leaseId found to drain'
      });
    }

    if (currentStatus.status !== 'DRAINING') {
      if (currentStatus.status === 'QUIESCED') {
        return res.status(200).json({
          success: true,
          status: 'QUIESCED',
          isDrained: true,
          message: 'System is already QUIESCED and drained'
        });
      }
      return res.status(409).json({
        success: false,
        reason: 'INVALID_STATUS',
        message: `Cannot drain when system status is ${currentStatus.status}`
      });
    }

    const waitTimeout = typeof timeoutMs === 'number' ? Math.max(0, timeoutMs) : 15000;

    // Non-blocking poll mode
    if (waitTimeout === 0) {
      const isDrained = Boolean(currentStatus.isDrained);
      if (isDrained) {
        if (autoQuiesce) {
          await quiescenceService.markQuiesced({ leaseId, enforceDrain: false });
        }
        return res.status(200).json({
          success: true,
          isDrained: true,
          status: autoQuiesce ? 'QUIESCED' : 'DRAINING',
          message: 'System is fully drained',
          accounting: currentStatus.processLocal
        });
      } else {
        res.setHeader('Retry-After', '2');
        return res.status(202).json({
          success: true,
          isDrained: false,
          status: 'DRAINING',
          message: 'Drain in progress',
          accounting: currentStatus.processLocal
        });
      }
    }

    // Blocking wait mode
    const drainResult = await quiescenceService.drainInFlight(waitTimeout, leaseId, {
      autoQuiesce: Boolean(autoQuiesce),
      autoReleaseOnTimeout: false
    });

    if (drainResult.success) {
      return res.status(200).json({
        success: true,
        isDrained: true,
        status: autoQuiesce ? 'QUIESCED' : 'DRAINING',
        message: 'In-flight operations drained successfully'
      });
    } else {
      res.setHeader('Retry-After', '2');
      return res.status(504).json({
        success: false,
        isDrained: false,
        status: 'DRAINING',
        reason: 'DRAIN_TIMEOUT',
        message: 'Timed out waiting for in-flight operations to drain; lease remains in DRAINING status'
      });
    }
  } catch (err) {
    logger.error('Quiescence drain endpoint error', err, {
      event: 'quiescence.drain_error'
    });
    next(err);
  }
};

/**
 * POST /api/admin/quiescence/quiesce (or /quiesced)
 * Transitions lease from DRAINING to QUIESCED status.
 *
 * BLK-02 REMEDIATION:
 * Enforces drain completion before transitioning to QUIESCED.
 * If operations are still draining, awaits up to timeoutMs before failing closed.
 */
export const markQuiescedHandler = async (req, res, next) => {
  try {
    const { leaseId, timeoutMs = 15000 } = req.body || {};

    if (!leaseId || typeof leaseId !== 'string' || !leaseId.trim()) {
      return res.status(400).json({
        success: false,
        message: 'leaseId is required and must be a non-empty string to transition to QUIESCED'
      });
    }

    const drainTimeout = typeof timeoutMs === 'number' ? Math.max(0, timeoutMs) : 15000;
    const result = await quiescenceService.markQuiesced({
      leaseId,
      enforceDrain: true,
      drainTimeoutMs: drainTimeout
    });

    if (!result.success) {
      if (result.reason === 'DRAIN_PENDING') {
        res.setHeader('Retry-After', '2');
        return res.status(504).json(result);
      }
      return res.status(409).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    logger.error('Quiescence markQuiesced endpoint error', err, {
      event: 'quiescence.quiesce_error'
    });
    next(err);
  }
};
