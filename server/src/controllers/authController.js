import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/user.js';
import EmailService from '../services/EmailService.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import { TaskState } from '../utils/CoordinatorTask.js';
import { UnifiedComputePipelineCoordinator } from '../utils/UnifiedComputePipelineCoordinator.js';
import { BcryptWorkerPool } from '../utils/BcryptWorkerPool.js';
import {
  extractClientIp,
  normalizeEmail,
  parseHmacSecret
} from '../utils/loginProtectionCrypto.js';
import LoginPair from '../models/LoginPair.js';
import LoginAccount from '../models/LoginAccount.js';
import LoginProtectionService from '../services/LoginProtectionService.js';
import securityAuditService from '../services/SecurityAuditService.js';
import { logger } from '../utils/logger.js';
import { withRequiredTransaction } from '../utils/dbTransaction.js';

const emailService = new EmailService();

let loginCoordinator = null;
let loginWorkerPool = null;
let loginProtectionService = null;
let poolInitPromise = null;

/**
 * Returns or initializes the UnifiedComputePipelineCoordinator singleton for login protection.
 * @param {object} [options={}]
 * @returns {UnifiedComputePipelineCoordinator}
 */
export const getLoginCoordinator = (options = {}) => {
  if (!loginCoordinator || options.forceNew) {
    loginCoordinator = new UnifiedComputePipelineCoordinator({
      maxActive: options.maxActive ?? 2,
      maxQueue: options.maxQueue ?? 10,
      maxPerIp: options.maxPerIp ?? 1
    });
  }
  return loginCoordinator;
};

/**
 * Returns or initializes the BcryptWorkerPool singleton for login protection.
 * @param {object} [options={}]
 * @returns {BcryptWorkerPool}
 */
export const getLoginWorkerPool = (options = {}) => {
  if (!loginWorkerPool || options.forceNew) {
    const coordinator = options.coordinator || getLoginCoordinator();
    loginWorkerPool = new BcryptWorkerPool({
      coordinator,
      maxWorkers: options.maxWorkers ?? 2,
      taskTimeoutMs: options.taskTimeoutMs ?? 10000,
      queueTimeoutMs: options.queueTimeoutMs ?? 5000
    });
  }
  return loginWorkerPool;
};

/**
 * Returns or initializes the LoginProtectionService singleton.
 * @param {object} [options={}]
 * @returns {LoginProtectionService}
 */
export const getLoginProtectionService = (options = {}) => {
  if (!loginProtectionService || options.forceNew) {
    const isProtectionEnabled = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED === 'true';
    const rawSecret =
      options.hmacSecret ||
      process.env.LOGIN_PROTECTION_HMAC_SECRET ||
      (process.env.NODE_ENV === 'test'
        ? 'paperless-test-hmac-secret-at-least-32-bytes-long'
        : undefined);

    const secretBuffer =
      options.secretBuffer ||
      parseHmacSecret(rawSecret, {
        isProtectionEnabled,
        env: process.env.NODE_ENV
      });

    loginProtectionService = new LoginProtectionService({
      pairModel: options.pairModel || LoginPair,
      accountModel: options.accountModel || LoginAccount,
      secretBuffer
    });
  }
  return loginProtectionService;
};

/**
 * Allows injecting custom instances for testing or external coordination.
 * @param {object} components
 */
export const setLoginProtectionComponents = ({
  coordinator,
  workerPool,
  protectionService,
  secretBuffer
} = {}) => {
  if (coordinator !== undefined) loginCoordinator = coordinator;
  if (workerPool !== undefined) loginWorkerPool = workerPool;
  if (protectionService !== undefined) {
    loginProtectionService = protectionService;
  } else if (secretBuffer !== undefined) {
    loginProtectionService = getLoginProtectionService({ secretBuffer, forceNew: true });
  }
};

/**
 * Ensures the physical BcryptWorkerPool threads are initialized.
 * @param {BcryptWorkerPool} pool
 * @returns {Promise<BcryptWorkerPool>}
 */
export const ensureLoginWorkerPoolReady = async (pool = getLoginWorkerPool()) => {
  if (!pool || typeof pool.initialize !== 'function') {
    return pool;
  }
  if (pool.workers && pool.workers.size > 0) {
    return pool;
  }
  if (!poolInitPromise) {
    poolInitPromise = pool.initialize().catch((err) => {
      poolInitPromise = null;
      throw err;
    });
  }
  await poolInitPromise;
  return pool;
};

/**
 * Shuts down the worker pool and resets all login protection singletons.
 * Guaranteed safe to call in afterEach hooks.
 */
export const resetLoginProtectionComponents = async () => {
  poolInitPromise = null;
  if (loginWorkerPool) {
    try {
      await loginWorkerPool.shutdown({ timeoutMs: 3000, graceful: false });
    } catch {
      // ignore teardown errors during test resets
    }
    loginWorkerPool = null;
  }
  loginCoordinator = null;
  loginProtectionService = null;
};

// Pre-computed valid 10-round bcrypt hash used for constant-time dummy verification
// to equalize login response latency when authenticating against non-existent accounts.
const DUMMY_HASH = bcrypt.hashSync('paperless-auth-timing-mitigation-dummy-salt', 10);

/**
 * Generate JWT Token
 */
const generateToken = (id, sessionId) => {
  const payload = sessionId ? { id, sessionId } : { id };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '15m'
  });
};

/**
 * Generate Refresh Token
 */
const generateRefreshToken = (id, sessionId) => {
  const payload = sessionId
    ? { id, sessionId, jti: crypto.randomUUID() }
    : { id, jti: crypto.randomUUID() };
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d'
  });
};

const escapeRegex = (str) => {
  return typeof str === 'string' ? str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
};

const isValidSessionId = (id) => {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
};

const getLegacySessionId = (tokenHash) => {
  return 'legacy-' + tokenHash;
};

const buildSessionEntry = (sessionId, tokenHash) => {
  return sessionId ? `${sessionId}:${tokenHash}` : tokenHash;
};

/**
 * Resolves and validates the SameSite attribute for cookies.
 * Permitted values: 'lax', 'strict', 'none'.
 * Any missing, blank, or invalid value safely defaults to 'lax'.
 */
export const resolveCookieSameSite = (value = process.env.COOKIE_SAMESITE) => {
  if (typeof value !== 'string') return 'lax';
  const normalized = value.trim().toLowerCase();
  if (['lax', 'strict', 'none'].includes(normalized)) {
    return normalized;
  }
  return 'lax';
};

/**
 * Helper to construct consistent cookie options across auth endpoints.
 */
export const getBaseCookieOptions = () => {
  const sameSite = resolveCookieSameSite();
  const isSecure =
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_ENV === 'staging' ||
    sameSite === 'none';
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite,
    path: '/'
  };
};

/**
 * Helper: Get token from model, create cookie and send response
 */
const sendTokenResponse = async (user, statusCode, res, message, existingSessionId) => {
  const sessionId = existingSessionId || crypto.randomUUID();
  const token = generateToken(user._id, sessionId);
  const refreshToken = generateRefreshToken(user._id, sessionId);

  // Store refresh token hash in DB atomically with session prefix
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const sessionEntry = buildSessionEntry(sessionId, tokenHash);

  const updatedUser = await User.findByIdAndUpdate(
    user._id,
    {
      $push: {
        refreshTokens: {
          $each: [sessionEntry],
          $slice: -5
        }
      }
    },
    { new: true, select: '-password' }
  );

  const finalUser = updatedUser || user;

  const options = getBaseCookieOptions();

  const tokenOptions = {
    ...options,
    expires: new Date(Date.now() + 15 * 60 * 1000) // 15 mins
  };

  const refreshOptions = {
    ...options,
    path: '/api/auth',
    expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
  };

  res
    .status(statusCode)
    .cookie('token', token, tokenOptions)
    .cookie('refreshToken', refreshToken, refreshOptions)
    .json({
      success: true,
      message,
      data: {
        user: {
          id: finalUser._id,
          name: finalUser.name,
          email: finalUser.email
        }
      }
    });
};

/**
 * @route   POST /api/auth/register
 * @desc    Register new user
 * @access  Public
 */
export const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Please provide name, email, and password' });
    }

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email' });
    }

    const policyResult = validatePassword(password);
    if (!policyResult.valid) {
      return res.status(400).json({ success: false, message: policyResult.message });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res
        .status(400)
        .json({ success: false, message: 'User already exists with this email' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await withRequiredTransaction(
      async (session) => {
        const existingInTx = await User.findOne({ email: normalizedEmail }).session(session);
        if (existingInTx) {
          const conflictError = new Error('User already exists with this email');
          conflictError.statusCode = 400;
          throw conflictError;
        }

        const [createdUser] = await User.create(
          [
            {
              name,
              email: normalizedEmail,
              password: hashedPassword
            }
          ],
          { session }
        );
        return createdUser;
      },
      { partitionKey: normalizedEmail }
    );

    await sendTokenResponse(user, 201, res, 'User registered successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/auth/login
 * @desc    Login user
 * @access  Public
 */
export const login = async (req, res, next) => {
  let token = null;
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const isProtectionEnabled = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED === 'true';

    if (!isProtectionEnabled) {
      const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        await bcrypt.compare(typeof password === 'string' ? password : '', DUMMY_HASH);
        securityAuditService.recordLoginFailure({
          req,
          email: normalizedEmail,
          reason: 'invalid_credentials',
          accountExists: false
        });
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        securityAuditService.recordLoginFailure({
          req,
          email: normalizedEmail,
          reason: 'invalid_credentials',
          accountExists: true
        });
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      securityAuditService.recordLoginSuccess({
        req,
        email: normalizedEmail
      });

      return await sendTokenResponse(user, 200, res, 'Login successful');
    }

    // Progressive Login Protection Pipeline (Stage 3.3)
    const clientIp = extractClientIp(req);
    if (!clientIp) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid or missing client IP address' });
    }

    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email' });
    }

    const coordinator = getLoginCoordinator();
    const workerPool = getLoginWorkerPool();
    const protectionService = getLoginProtectionService();

    // 1. Admission Gate
    token = coordinator.tryAcquireAdmission(clientIp);
    if (!token) {
      res.set('Retry-After', '5');
      return res.status(503).json({
        success: false,
        message: 'Authentication service temporarily unavailable, please retry shortly'
      });
    }

    // 2. Client Disconnect Notification
    req.on('close', () => {
      token.markClientDisconnected();
    });

    // 3. Pair Lockout Pre-Check & Database Lookup (Fail closed on DB error)
    let preCheck = null;
    let user = null;
    let admittedRevision = null;

    try {
      preCheck = await protectionService.checkPairLockout({ email: normalizedEmail, ip: clientIp });
      if (preCheck.isLocked) {
        securityAuditService.recordLockout({
          req,
          email: normalizedEmail,
          clientIp,
          ipHash: protectionService.deriveIpHash(clientIp),
          retryAfterSeconds: preCheck.retryAfterSeconds,
          tier: 'pair',
          stage: 'pre_check',
          status: 'ACTIVE_LOCKOUT'
        });
        token.settleLookupFailure('PAIR_LOCKED');
        res.set('Retry-After', String(preCheck.retryAfterSeconds));
        return res.status(429).json({
          success: false,
          message: 'Too many failed login attempts. Please try again later.'
        });
      }
      admittedRevision = preCheck.revision;
      user = await User.findOne({ email: normalizedEmail });
    } catch (dbErr) {
      if (!token.isSettled) {
        token.settleLookupFailure('DB_ERROR');
      }
      res.set('Retry-After', '5');
      return res.status(503).json({
        success: false,
        message: 'Authentication service temporarily unavailable, please retry shortly'
      });
    }

    // 4. Ensure worker pool is initialized
    try {
      await ensureLoginWorkerPoolReady(workerPool);
    } catch (initErr) {
      if (!token.isSettled) {
        token.settleLookupFailure('WORKER_INIT_FAILED');
      }
      res.set('Retry-After', '5');
      return res.status(503).json({
        success: false,
        message: 'Authentication service temporarily unavailable, please retry shortly'
      });
    }

    // 5. Bcrypt Worker Pool Execution
    let compareResult;
    try {
      const targetHash = user ? user.password : DUMMY_HASH;
      const targetPassword = typeof password === 'string' ? password : '';
      compareResult = await workerPool.executeCompare(token, targetPassword, targetHash);
    } catch (computeErr) {
      if (!token.isSettled) {
        token.settleLookupFailure('COMPUTE_FAILED');
      }
      if (token.clientDisconnected) {
        return;
      }
      res.set('Retry-After', '5');
      return res.status(503).json({
        success: false,
        message: 'Authentication service temporarily unavailable, please retry shortly'
      });
    }

    // Early IP slot release hook (defensively invoke if method is exposed)
    if (typeof token.releaseIpSlot === 'function') {
      token.releaseIpSlot();
    }

    const isMatch = Boolean(compareResult && compareResult.isMatch && user);

    if (isMatch) {
      // 6A. Successful Login Branch
      try {
        await protectionService.resetPairOnSuccess(
          { email: normalizedEmail, ip: clientIp },
          admittedRevision
        );
      } catch (resetErr) {
        // Non-blocking OCC reset error
      }

      token.settleSuccess('SUCCESS');

      if (token.clientDisconnected || res.headersSent || res.writableEnded) {
        return;
      }

      securityAuditService.recordLoginSuccess({
        req,
        email: normalizedEmail
      });

      return await sendTokenResponse(user, 200, res, 'Login successful');
    }

    // 6B. Failed Authentication Branch (Invalid credentials)
    let pairResult = null;
    let accountResult = null;

    try {
      pairResult = await protectionService.recordPairFailureAtomic({
        email: normalizedEmail,
        ip: clientIp
      });
      accountResult = await protectionService.recordAccountFailureAtomic(
        { email: normalizedEmail },
        clientIp
      );
    } catch (recordErr) {
      if (!token.isSettled) {
        token.settleFailure('RECORD_FAILURE_ERROR');
      }
      res.set('Retry-After', '5');
      return res.status(503).json({
        success: false,
        message: 'Authentication service temporarily unavailable, please retry shortly'
      });
    }

    // Advisory Cross-IP Spray Delay: execute during normal operation; bypass during shutdown or on client disconnect
    const shouldDelay =
      !coordinator.draining &&
      !token.clientDisconnected &&
      accountResult &&
      typeof accountResult.delayMs === 'number' &&
      accountResult.delayMs > 0;

    if (shouldDelay) {
      securityAuditService.recordSprayDelay({
        req,
        email: normalizedEmail,
        clientIp,
        ipHash: protectionService.deriveIpHash(clientIp),
        delayMs: accountResult.delayMs,
        distinctIpsCount: accountResult.distinctIps
      });
      await new Promise((resolve) => setTimeout(resolve, accountResult.delayMs));
    }

    token.settleFailure('FAILURE');

    if (token.clientDisconnected || res.headersSent || res.writableEnded) {
      return;
    }

    if (
      pairResult &&
      (pairResult.status === 'LOCKOUT_INITIATED' || pairResult.status === 'ACTIVE_LOCKOUT')
    ) {
      securityAuditService.recordLockout({
        req,
        email: normalizedEmail,
        clientIp,
        ipHash: protectionService.deriveIpHash(clientIp),
        retryAfterSeconds: pairResult.retryAfterSeconds,
        tier: 'pair',
        stage: 'post_failure',
        status: pairResult.status,
        failedAttempts: pairResult.failedAttempts
      });
      res.set('Retry-After', String(pairResult.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        message: 'Too many failed login attempts. Please try again later.'
      });
    }

    securityAuditService.recordLoginFailure({
      req,
      email: normalizedEmail,
      clientIp,
      ipHash: protectionService.deriveIpHash(clientIp),
      reason: 'invalid_credentials',
      accountExists: Boolean(user),
      failedAttempts: pairResult?.failedAttempts
    });

    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (error) {
    next(error);
  } finally {
    if (token && !token.isSettled) {
      try {
        if (token.state === TaskState.ADMITTED_LOOKUP) {
          token.settleLookupFailure('FINALLY_CLEANUP');
        } else if (token.state === TaskState.QUEUED) {
          token.settleQueueDisconnect('FINALLY_CLEANUP');
        } else if (token.state === TaskState.ACTIVE_COMPUTE) {
          token.settleWorkerCrash('FINALLY_CLEANUP');
        } else {
          token.settleFailure('FINALLY_CLEANUP');
        }
      } catch {
        // ignore finalizer settlement error
      }
    }
  }
};

/**
 * @route   POST /api/auth/logout
 * @desc    Log user out / clear cookie
 * @access  Private
 */
export const logout = async (req, res) => {
  let decoded = null;
  let sessionRevoked = false;
  try {
    let rawToken = req.cookies.refreshToken;

    if (!rawToken) {
      if (req.cookies.token) {
        rawToken = req.cookies.token;
      } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        rawToken = req.headers.authorization.split(' ')[1];
      }
    }

    if (rawToken && typeof rawToken === 'string') {
      try {
        let tokenType = null; // 'refresh' | 'access'

        // Cryptographically verify signatures ignoring expiration so legitimately expired
        // client tokens can complete logout, while rejecting any forged/tampered tokens.
        try {
          decoded = jwt.verify(rawToken, process.env.JWT_REFRESH_SECRET, {
            ignoreExpiration: true
          });
          tokenType = 'refresh';
        } catch (e1) {
          try {
            decoded = jwt.verify(rawToken, process.env.JWT_SECRET, { ignoreExpiration: true });
            tokenType = 'access';
          } catch (e2) {
            // Neither signature verified: token is forged, corrupted, or signed with wrong secret.
            // Never trust unverified claims: do not decode and do not touch database state.
            decoded = null;
            tokenType = null;
          }
        }

        if (decoded && decoded.id) {
          const now = new Date();

          if (decoded.sessionId && isValidSessionId(decoded.sessionId)) {
            // Both modern access tokens and refresh tokens share the same sessionId.
            // Atomically revoke ANY token belonging to this session in MongoDB.
            const safePattern = '^' + escapeRegex(decoded.sessionId) + ':';
            await User.findByIdAndUpdate(decoded.id, {
              $set: { lastLogoutAt: now },
              $pull: {
                refreshTokens: { $regex: safePattern },
                rotatedTokens: { sessionId: decoded.sessionId }
              }
            });
            sessionRevoked = true;
          } else {
            // Legacy token without sessionId:
            if (tokenType === 'refresh') {
              // Only refresh tokens are stored in user.refreshTokens.
              // Revoke bare tokenHash AND deterministically derived legacy session family.
              const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
              const legacySessionId = getLegacySessionId(tokenHash);
              const safeLegacyPattern =
                '^(' + escapeRegex(tokenHash) + '$|' + escapeRegex(legacySessionId) + ':)';
              await User.findByIdAndUpdate(decoded.id, {
                $set: { lastLogoutAt: now },
                $pull: {
                  refreshTokens: { $regex: safeLegacyPattern },
                  rotatedTokens: { sessionId: legacySessionId }
                }
              });
              sessionRevoked = true;
            } else if (tokenType === 'access') {
              // Legacy access token without sessionId:
              // Cannot be cryptographically tied to a specific refresh token.
              // Revoke via user.lastLogoutAt timestamp without pulling unrelated refresh tokens.
              await User.findByIdAndUpdate(decoded.id, {
                $set: { lastLogoutAt: now }
              });
              sessionRevoked = true;
            }
          }
        }
      } catch (err) {
        // ignore jwt verify error on logout
      }
    }
  } catch (err) {
    // ignore
  }

  const baseOptions = getBaseCookieOptions();
  const tokenOptions = {
    ...baseOptions,
    expires: new Date(Date.now())
  };
  const refreshOptions = {
    ...baseOptions,
    path: '/api/auth',
    expires: new Date(Date.now())
  };

  securityAuditService.recordLogout({
    req,
    sessionRevoked
  });

  res
    .status(200)
    .cookie('token', 'none', tokenOptions)
    .cookie('refreshToken', 'none', refreshOptions)
    .json({
      success: true,
      message: 'Logged out successfully'
    });
};

/**
 * @route   GET /api/auth/me
 * @desc    Get current user
 * @access  Private
 */
export const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('name email createdAt');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(200).json({
      success: true,
      data: {
        _id: user._id,
        id: user._id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
export const refreshToken = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Refresh token not found' });
    }

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const oldTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessionId =
      decoded.sessionId && isValidSessionId(decoded.sessionId) ? decoded.sessionId : null;

    // Retain existing sessionId; for legacy tokens without sessionId, derive a deterministic legacy family ID
    const newSessionId = sessionId || getLegacySessionId(oldTokenHash);
    const newAccessToken = generateToken(decoded.id, newSessionId);
    const newRefreshToken = generateRefreshToken(decoded.id, newSessionId);
    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const newSessionEntry = buildSessionEntry(newSessionId, newTokenHash);

    // Atomically find user matching this token/session entry and replace it
    const queryConditions = sessionId
      ? { _id: decoded.id, refreshTokens: buildSessionEntry(sessionId, oldTokenHash) }
      : { _id: decoded.id, refreshTokens: oldTokenHash };

    const rotatedRecord = {
      sessionId: newSessionId,
      tokenHash: oldTokenHash,
      rotatedAt: new Date()
    };

    const user = await User.findOneAndUpdate(
      queryConditions,
      {
        $set: { 'refreshTokens.$': newSessionEntry },
        $push: {
          rotatedTokens: {
            $each: [rotatedRecord],
            $slice: -20
          }
        }
      },
      {
        new: true,
        select: '-password'
      }
    );

    if (!user) {
      // Token not found in active refreshTokens.
      // Check if this token belongs to an existing user and was already rotated (Replay Attack).
      if (decoded && decoded.id) {
        const existingUser = await User.findById(decoded.id).select('refreshTokens rotatedTokens');
        if (existingUser) {
          const targetSessionId = sessionId || getLegacySessionId(oldTokenHash);
          const safePattern = '^' + escapeRegex(targetSessionId) + ':';

          // Check if this token was rotated very recently (grace window for concurrent requests)
          const recentRotation = existingUser.rotatedTokens?.find(
            (r) => r.tokenHash === oldTokenHash && (r.sessionId === targetSessionId || !r.sessionId)
          );

          const now = Date.now();
          const ROTATION_GRACE_WINDOW_MS = 2000; // 2 seconds concurrency grace window

          if (
            recentRotation &&
            now - new Date(recentRotation.rotatedAt).getTime() <= ROTATION_GRACE_WINDOW_MS
          ) {
            // Concurrent in-flight request within grace window:
            // Reject this request as token is already rotated, but do NOT revoke the session family.
            securityAuditService.recordTokenRaceRejected({
              req
            });
            return res
              .status(401)
              .json({ success: false, message: 'Invalid or revoked refresh token' });
          }

          // Outside grace window or replaying an already-consumed token:
          // Conclusively identify as replay attack: revoke the entire session family!
          securityAuditService.recordTokenReplay({
            req,
            timeSinceRotationMs: recentRotation
              ? now - new Date(recentRotation.rotatedAt).getTime()
              : undefined
          });
          await User.updateOne(
            { _id: decoded.id },
            {
              $set: { lastLogoutAt: new Date() },
              $pull: { refreshTokens: { $regex: safePattern } }
            }
          );
        }
      }

      return res.status(401).json({ success: false, message: 'Invalid or revoked refresh token' });
    }

    const options = getBaseCookieOptions();

    const tokenOptions = {
      ...options,
      expires: new Date(Date.now() + 15 * 60 * 1000) // 15 mins
    };

    const refreshOptions = {
      ...options,
      path: '/api/auth',
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    };

    securityAuditService.recordTokenRefresh({
      req
    });

    return res
      .status(200)
      .cookie('token', newAccessToken, tokenOptions)
      .cookie('refreshToken', newRefreshToken, refreshOptions)
      .json({
        success: true,
        message: 'Token refreshed',
        data: {
          user: {
            id: user._id,
            name: user.name,
            email: user.email
          }
        }
      });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
};

const sanitizeDiagnosticMessage = (message) => {
  if (typeof message !== 'string') return 'Unknown error';
  return message
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(
      /(https?:\/\/[^\s"'<>]+)?\/reset-?password\/[a-zA-Z0-9_%-]+/gi,
      '[REDACTED_RESET_LINK]'
    )
    .replace(/\b[0-9a-fA-F]{40}\b/g, '[REDACTED_TOKEN]')
    .replace(/re_[a-zA-Z0-9_]{16,}/g, '[REDACTED_API_KEY]')
    .replace(/bearer\s+[a-zA-Z0-9._~+/-]+/gi, 'Bearer [REDACTED_TOKEN]');
};

/**
 * @route   POST /api/auth/forgotpassword
 * @desc    Forgot password
 * @access  Public
 */
export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Please provide email' });
    }

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      securityAuditService.recordPasswordResetRequested({
        req,
        email: normalizedEmail
      });
      // Do not leak existence
      return res.status(200).json({
        success: true,
        message: 'If an account exists for this email, a password reset link has been sent.'
      });
    }

    // Get reset token
    const resetToken = user.getResetPasswordToken();
    const generatedTokenHash = user.resetPasswordToken;
    const expireDate = user.resetPasswordExpire;

    const updatedUser = await withRequiredTransaction(
      async (session) => {
        return User.findByIdAndUpdate(
          user._id,
          {
            $set: {
              resetPasswordToken: generatedTokenHash,
              resetPasswordExpire: expireDate
            }
          },
          { new: true, session }
        );
      },
      { partitionKey: user._id.toString() }
    );

    if (!updatedUser) {
      return res.status(200).json({
        success: true,
        message: 'If an account exists for this email, a password reset link has been sent.'
      });
    }

    try {
      const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/resetpassword/${resetToken}`;
      const message = `You requested a password reset. Please click the link to reset your password:\n\n${resetUrl}`;

      await emailService.sendEmail({
        to: user.email,
        subject: 'Paperless - Password Reset',
        text: message,
        html: `<p>You requested a password reset. Please click the link to reset your password:</p><a href="${resetUrl}">${resetUrl}</a>`,
        isSensitive: true
      });

      securityAuditService.recordPasswordResetRequested({
        req,
        email: normalizedEmail
      });

      return res.status(200).json({
        success: true,
        message: 'If an account exists for this email, a password reset link has been sent.'
      });
    } catch (err) {
      logger.error('Email delivery failed during password reset:', {
        event: 'auth.password_reset_email_failed',
        error: sanitizeDiagnosticMessage(err && err.message ? err.message : 'Unknown error')
      });

      // Atomic conditional cleanup: only invalidate if the token in the database
      // matches the exact token generated by this request, preventing a slower failed
      // delivery from clobbering a newer concurrent password-reset token.
      try {
        await User.updateOne(
          { _id: user._id, resetPasswordToken: generatedTokenHash },
          { $unset: { resetPasswordToken: 1, resetPasswordExpire: 1 } }
        );
      } catch (cleanupErr) {
        logger.error('Failed to cleanup reset token after email failure:', {
          event: 'auth.password_reset_cleanup_failed',
          error: sanitizeDiagnosticMessage(
            cleanupErr && cleanupErr.message ? cleanupErr.message : 'Unknown error'
          )
        });
      }

      // Return consistent generic message on email failure to prevent account enumeration
      return res.status(200).json({
        success: true,
        message: 'If an account exists for this email, a password reset link has been sent.'
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/auth/resetpassword
 * @route   PUT /api/auth/resetpassword/:resettoken
 * @route   POST /api/auth/resetpassword
 * @desc    Reset password (accepts token in request body or legacy URL param)
 * @access  Public
 */
export const resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    const rawToken =
      typeof req.body?.token === 'string' && req.body.token.trim()
        ? req.body.token.trim()
        : typeof req.params?.resettoken === 'string'
          ? req.params.resettoken.trim()
          : null;

    if (!rawToken) {
      return res.status(400).json({ success: false, message: 'Invalid or missing reset token' });
    }

    const policyResult = validatePassword(password);
    if (!policyResult.valid) {
      return res.status(400).json({ success: false, message: policyResult.message });
    }

    const resetPasswordToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Atomically invalidate token and update password in one single-operation write to prevent TOCTOU reuse
    const user = await withRequiredTransaction(
      async (session) => {
        return User.findOneAndUpdate(
          {
            resetPasswordToken,
            resetPasswordExpire: { $gt: Date.now() }
          },
          {
            $set: {
              password: hashedPassword,
              refreshTokens: [],
              rotatedTokens: [],
              lastLogoutAt: new Date()
            },
            $unset: {
              resetPasswordToken: 1,
              resetPasswordExpire: 1
            }
          },
          {
            new: true,
            select: '-password',
            session
          }
        );
      },
      { partitionKey: resetPasswordToken }
    );

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    securityAuditService.recordPasswordResetCompleted({
      req
    });

    await sendTokenResponse(user, 200, res, 'Password reset successful');
  } catch (error) {
    next(error);
  }
};
