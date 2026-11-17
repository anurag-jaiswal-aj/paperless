import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

// Load environment variables
dotenv.config();

// Require minimum environment variables in production and staging
if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
  const requiredEnvs = [
    'MONGO_URI',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'FRONTEND_URL',
    'S3_REGION',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY'
  ];
  for (const env of requiredEnvs) {
    if (!process.env[env]) {
      console.error(
        `FATAL ERROR: Missing required production/staging environment variable: ${env}`
      );
      process.exit(1);
    }
  }
}

// Import routes
import authRoutes from './routes/authRoutes.js';
import formRoutes from './routes/formRoutes.js';
import responseRoutes from './routes/responseRoutes.js';
import aiRoutes from './routes/aiRoutes.js';

// Import middleware
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { csrfProtection, isTrustedOrigin } from './middleware/csrfProtection.js';
import { requestCorrelation } from './middleware/requestCorrelation.js';
import { httpAccessLogger } from './middleware/httpAccessLogger.js';
import { createIngressGate } from './middleware/ingressGate.js';
import { logger } from './utils/logger.js';

// Import services
import storageService from './services/StorageService.js';

// Import login protection utilities and lifecycle singletons
import { parseHmacSecret } from './utils/loginProtectionCrypto.js';
import { verifyReplicaSetTopology, supportsTransactions } from './utils/dbTransaction.js';
import {
  ensureLoginWorkerPoolReady,
  resetLoginProtectionComponents,
  setLoginProtectionComponents,
  getLoginCoordinator,
  getLoginWorkerPool
} from './controllers/authController.js';

// Initialize Express app
const app = express();

export const DEFAULT_TRUSTED_PROXIES = ['loopback'];

/**
 * Resolves the trusted proxy boundary for Express.
 * Prevents client-spoofed X-Forwarded-For headers from bypassing rate limits
 * by trusting only verified loopback addresses by default.
 * Blanket RFC 1918 / RFC 4193 subnets (uniquelocal) are deliberately excluded
 * to ensure that internal or container network entities cannot spoof req.ip.
 *
 * @param {string|undefined} trustProxyEnv - The TRUST_PROXY environment variable value
 * @param {string|undefined} nodeEnv - The NODE_ENV environment variable value
 * @returns {boolean|number|string|string[]} The trusted proxy setting for Express
 */
export const resolveTrustProxy = (trustProxyEnv, nodeEnv) => {
  if (
    trustProxyEnv !== undefined &&
    trustProxyEnv !== null &&
    String(trustProxyEnv).trim() !== ''
  ) {
    const trimmed = String(trustProxyEnv).trim();
    if (trimmed.toLowerCase() === 'false') return false;
    if (trimmed.toLowerCase() === 'true') {
      // Setting Express 'trust proxy' to boolean true trusts every proxy hop unconditionally
      // and accepts the leftmost client-provided IP, completely defeating IP-based rate limiting
      // and triggering ERR_ERL_PERMISSIVE_TRUST_PROXY in express-rate-limit.
      // Safely map 'true' to 1 hop (the immediate reverse proxy).
      return 1;
    }

    const num = Number(trimmed);
    if (!Number.isNaN(num) && Number.isInteger(num) && num >= 0) {
      return num;
    }

    const parts = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length === 1 ? parts[0] : parts;
  }

  // In production and staging without an explicit TRUST_PROXY, default strictly to loopback.
  // Direct untrusted internet IPs and private subnets are never implicitly trusted.
  if (nodeEnv === 'production' || nodeEnv === 'staging') {
    return DEFAULT_TRUSTED_PROXIES;
  }

  // In development and test environments without an explicit TRUST_PROXY setting,
  // default to false (untrusted) so direct requests strictly use req.socket.remoteAddress.
  return false;
};

app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV));

// Database connection
const connectDB = async (mongoUri = process.env.MONGO_URI, exitOnError = true, options = {}) => {
  const defaultOptions = {
    // Retain standard driver pool defaults unless explicitly overridden by environment
    maxPoolSize: parseInt(process.env.MONGODB_MAX_POOL_SIZE, 10) || 100,
    minPoolSize: parseInt(process.env.MONGODB_MIN_POOL_SIZE, 10) || 0,
    // Bounded timeouts justified to prevent request hangs during database outages
    serverSelectionTimeoutMS: parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10) || 5000,
    connectTimeoutMS: parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS, 10) || 10000
  };

  // Only attach socketTimeoutMS if explicitly provided via env (driver default 0 = no timeout)
  // to avoid prematurely aborting legitimate long-running CSV exports or aggregations
  if (process.env.MONGODB_SOCKET_TIMEOUT_MS) {
    defaultOptions.socketTimeoutMS = parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS, 10);
  }

  const connectionOptions = { ...defaultOptions, ...options };

  try {
    const conn = await mongoose.connect(mongoUri, connectionOptions);
    let topologyInfo;
    try {
      topologyInfo = await verifyReplicaSetTopology(conn.connection);
    } catch (topologyError) {
      if (conn?.connection && typeof conn.connection.close === 'function') {
        await conn.connection.close(false).catch(() => {});
      }
      throw topologyError;
    }
    logger.info(
      `✅ MongoDB Connected: ${conn.connection.host} (topology=${topologyInfo.topologyType}${topologyInfo.setName ? `, replicaSet=${topologyInfo.setName}` : ''})`,
      {
        event: 'db.connected',
        host: conn.connection.host,
        topologyType: topologyInfo.topologyType,
        replicaSet: topologyInfo.setName
      }
    );
    return conn;
  } catch (error) {
    logger.error(`❌ MongoDB Connection Error: ${error.message}`, error, {
      event:
        error?.code === 'REPLICA_SET_REQUIRED' ? 'db.replica_set_required' : 'db.connection_failed'
    });
    if (exitOnError) {
      process.exit(1);
    }
    throw error;
  }
};

import { sanitizeRequestUrl } from './utils/helpers.js';
export { sanitizeRequestUrl };

// Middleware
app.use(requestCorrelation); // Server-side request correlation and AsyncLocalStorage context
app.use(createIngressGate()); // Ingress verification gate for trusted reverse proxy
app.use(httpAccessLogger); // Structured HTTP access logging
app.use(helmet()); // Security headers
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || isTrustedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: [
      'Retry-After',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'X-Request-ID'
    ]
  })
);
app.use(express.json({ limit: '100kb' })); // Explicit JSON limit
app.use(express.urlencoded({ extended: true, limit: '100kb' })); // Explicit URL-encoded limit
app.use(cookieParser()); // Parse cookies
app.use(csrfProtection); // Validate origin on mutating requests

// Health check routes
// Liveness probe
app.get(['/health', '/api/health'], (req, res) => {
  res.status(200).json({
    success: true,
    status: 'live',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

let isServerShuttingDown = false;
let activeDbPingPromise = null;

const setIsServerShuttingDown = (val) => {
  isServerShuttingDown = Boolean(val);
};

const resetActiveDbPingPromise = () => {
  activeDbPingPromise = null;
};

// Dependency readiness probe (Database, Storage, and Progressive Login Protection)
const readinessHandler = async (req, res) => {
  if (isServerShuttingDown) {
    return res.status(503).json({
      success: false,
      status: 'shutting_down',
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      storage: 'disconnected',
      message: 'Server is shutting down',
      timestamp: new Date().toISOString()
    });
  }

  let isDbReady = false;
  if (mongoose.connection.readyState === 1) {
    if (!supportsTransactions(mongoose.connection)) {
      isDbReady = false;
      logger.warn('Database readiness rejected: MongoDB replica-set primary topology is required', {
        event: 'db.readiness_topology_invalid',
        topologyType: mongoose.connection.client?.topology?.description?.type || 'unknown'
      });
    } else if (mongoose.connection.db && typeof mongoose.connection.db.admin === 'function') {
      if (activeDbPingPromise) {
        // An earlier probe is still in flight (database is slow, hung, or experiencing latency).
        // Fail fast without launching an unbounded queue of parallel driver probes.
        isDbReady = false;
        logger.warn('Database readiness probe skipped: previous ping still in flight', {
          event: 'db.readiness_ping_in_flight'
        });
      } else {
        const pingPromise = verifyReplicaSetTopology(mongoose.connection);
        activeDbPingPromise = pingPromise;

        // Ensure the guard is cleared once the underlying driver operation settles
        pingPromise
          .catch(() => {}) // Prevent unhandled rejection on background tracking chain
          .finally(() => {
            if (activeDbPingPromise === pingPromise) {
              activeDbPingPromise = null;
            }
          });

        try {
          await Promise.race([
            pingPromise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Database ping timeout')), 2000)
            )
          ]);
          isDbReady = true;
        } catch (err) {
          logger.warn('Database readiness ping failed', {
            event:
              err?.code === 'REPLICA_SET_REQUIRED'
                ? 'db.readiness_topology_invalid'
                : 'db.readiness_ping_failed',
            error: err.message
          });
          isDbReady = false;
        }
      }
    } else {
      isDbReady = false;
      logger.warn('Database readiness rejected: MongoDB admin interface unavailable', {
        event: 'db.readiness_admin_unavailable'
      });
    }
  }
  let storageResult;

  try {
    storageResult = await storageService.checkBucketAccess();
  } catch (err) {
    storageResult = { ok: false, status: 'error' };
  }

  const isStorageReady = Boolean(storageResult && storageResult.ok);

  const isProtectionEnabled = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED === 'true';
  let isWorkerPoolReady = true;
  let isCoordinatorReady = true;
  let workerPoolStatus = 'disabled';
  let coordinatorStatus = 'disabled';

  if (isProtectionEnabled) {
    const workerPool = getLoginWorkerPool();
    const coordinator = getLoginCoordinator();

    if (!workerPool || workerPool.aliveWorkerCount === 0 || workerPool.shuttingDown) {
      isWorkerPoolReady = false;
      workerPoolStatus = 'failed';
    } else if (workerPool.aliveWorkerCount < workerPool.maxWorkers) {
      isWorkerPoolReady = true; // Degraded worker count >= 1 still guarantees compare dispatch
      workerPoolStatus = 'degraded';
    } else {
      isWorkerPoolReady = true;
      workerPoolStatus = 'ready';
    }

    if (!coordinator || coordinator.draining) {
      isCoordinatorReady = false;
      coordinatorStatus = coordinator?.draining ? 'draining' : 'failed';
    } else {
      isCoordinatorReady = true;
      coordinatorStatus = 'ready';
    }
  }

  const isReady = isDbReady && isStorageReady && isWorkerPoolReady && isCoordinatorReady;
  const statusCode = isReady ? 200 : 503;

  const responsePayload = {
    success: isReady,
    status: isReady ? 'ready' : 'not_ready',
    database: isDbReady ? 'connected' : 'disconnected',
    storage: storageResult?.status || 'disconnected',
    timestamp: new Date().toISOString()
  };

  if (isProtectionEnabled) {
    responsePayload.workerPool = workerPoolStatus;
    responsePayload.coordinator = coordinatorStatus;
  }

  res.status(statusCode).json(responsePayload);
};

app.get(['/health/ready', '/ready', '/api/health/ready', '/api/ready'], readinessHandler);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/responses', responseRoutes);
app.use('/api/ai', aiRoutes);

// Root route
app.get(['/', '/api'], (req, res) => {
  res.json({
    success: true,
    message: 'Welcome to Paperless API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      forms: '/api/forms',
      responses: '/api/responses',
      ai: '/api/ai'
    }
  });
});

// 404 handler
app.use(notFound);

// Error handler (must be last)
app.use(errorHandler);

/**
 * Validates startup configuration and environment variables.
 *
 * Checks required production/staging environment variables and, when progressive login
 * protection is enabled, verifies the HMAC secret using parseHmacSecret.
 *
 * @param {object} [env=process.env]
 * @returns {{ isEnabled: boolean, secretBuffer: Buffer|null }}
 */
const validateStartupConfig = (env = process.env) => {
  const rawFlag = env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED;
  const isEnabled = rawFlag === 'true';

  // Check for unexpected non-empty values that do not match the exact contract
  if (rawFlag !== undefined && rawFlag !== '' && rawFlag !== 'false' && rawFlag !== 'true') {
    logger.warn(
      `⚠️ WARNING: PROGRESSIVE_LOGIN_PROTECTION_ENABLED is set to "${rawFlag}", but strict contract requires exact string "true". Progressive login protection remains DISABLED.`,
      { event: 'config.login_protection_invalid', rawFlag }
    );
  }

  // Validate production/staging required environment variables
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
    const requiredEnvs = [
      'MONGO_URI',
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
      'FRONTEND_URL',
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY'
    ];
    for (const key of requiredEnvs) {
      if (!env[key]) {
        throw new Error(`Missing required production/staging environment variable: ${key}`);
      }
    }

    if (typeof env.JWT_SECRET !== 'string' || env.JWT_SECRET.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long in production/staging');
    }
    if (typeof env.JWT_REFRESH_SECRET !== 'string' || env.JWT_REFRESH_SECRET.length < 32) {
      throw new Error(
        'JWT_REFRESH_SECRET must be at least 32 characters long in production/staging'
      );
    }
    if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
      throw new Error(
        'JWT_SECRET and JWT_REFRESH_SECRET must be distinct secrets in production/staging'
      );
    }
  }

  let secretBuffer = null;
  if (isEnabled) {
    // Eagerly validate HMAC secret using the existing parseHmacSecret utility
    try {
      secretBuffer = parseHmacSecret(env.LOGIN_PROTECTION_HMAC_SECRET, {
        isProtectionEnabled: true,
        env: env.NODE_ENV
      });
    } catch (err) {
      throw new Error(`Invalid progressive login protection configuration: ${err.message}`);
    }
  }

  return { isEnabled, secretBuffer };
};

/**
 * Creates a bounded, duplicate-safe graceful shutdown handler implementing the 7-step teardown.
 *
 * Supports positional signatures:
 *   createGracefulShutdown(serverInstance, mongooseInstance, exitFn, timeoutMs, extraOptions)
 * and options-based signatures:
 *   createGracefulShutdown({ serverInstance, mongooseInstance, coordinator, workerPool, exitFn, timeoutMs })
 */
const createGracefulShutdown = (
  serverInstanceOrOptions,
  mongooseInstanceArg,
  exitFnOrOptions = process.exit,
  timeoutMsArg = 10000,
  extraOptions = {}
) => {
  let serverInstance = serverInstanceOrOptions;
  let mongooseInstance = mongooseInstanceArg;
  let exitFn = process.exit;
  let timeoutMs = 10000;
  let coordinator = undefined;
  let workerPool = undefined;
  let storage = storageService;
  let periodicRecoveryTimer = null;
  let abortRecovery = null;
  let waitForLifecycleTasks = null;

  if (
    serverInstanceOrOptions &&
    typeof serverInstanceOrOptions === 'object' &&
    !('close' in serverInstanceOrOptions)
  ) {
    // Options-based signature
    const opts = serverInstanceOrOptions;
    serverInstance = opts.serverInstance !== undefined ? opts.serverInstance : opts.server || null;
    mongooseInstance = opts.mongooseInstance || opts.mongoose || null;
    coordinator = opts.coordinator;
    workerPool = opts.workerPool;
    if (opts.storageService !== undefined) {
      storage = opts.storageService;
    }
    if (opts.periodicRecoveryTimer !== undefined) {
      periodicRecoveryTimer = opts.periodicRecoveryTimer;
    }
    if (typeof opts.abortRecovery === 'function') {
      abortRecovery = opts.abortRecovery;
    }
    if (typeof opts.waitForLifecycleTasks === 'function') {
      waitForLifecycleTasks = opts.waitForLifecycleTasks;
    }
    exitFn = typeof opts.exitFn === 'function' ? opts.exitFn : process.exit;
    timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10000;
  } else {
    // Positional signature: (server, mongoose, exitFn, timeoutMs, extraOptions)
    if (typeof exitFnOrOptions === 'function') {
      exitFn = exitFnOrOptions;
      timeoutMs = typeof timeoutMsArg === 'number' ? timeoutMsArg : 10000;
      coordinator = extraOptions.coordinator;
      workerPool = extraOptions.workerPool;
      if (extraOptions.storageService !== undefined) {
        storage = extraOptions.storageService;
      }
      if (extraOptions.periodicRecoveryTimer !== undefined) {
        periodicRecoveryTimer = extraOptions.periodicRecoveryTimer;
      }
      if (typeof extraOptions.abortRecovery === 'function') {
        abortRecovery = extraOptions.abortRecovery;
      }
      if (typeof extraOptions.waitForLifecycleTasks === 'function') {
        waitForLifecycleTasks = extraOptions.waitForLifecycleTasks;
      }
    } else if (typeof exitFnOrOptions === 'object' && exitFnOrOptions !== null) {
      const opts = exitFnOrOptions;
      exitFn = typeof opts.exitFn === 'function' ? opts.exitFn : process.exit;
      timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10000;
      coordinator = opts.coordinator;
      workerPool = opts.workerPool;
      if (opts.storageService !== undefined) {
        storage = opts.storageService;
      }
      if (opts.periodicRecoveryTimer !== undefined) {
        periodicRecoveryTimer = opts.periodicRecoveryTimer;
      }
      if (typeof opts.abortRecovery === 'function') {
        abortRecovery = opts.abortRecovery;
      }
      if (typeof opts.waitForLifecycleTasks === 'function') {
        waitForLifecycleTasks = opts.waitForLifecycleTasks;
      }
    }
  }

  // If coordinator / workerPool are not explicitly passed, wire them only when protection is enabled
  if (coordinator === undefined) {
    coordinator =
      process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED === 'true' ? getLoginCoordinator() : null;
  }
  if (workerPool === undefined) {
    workerPool =
      process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED === 'true' ? getLoginWorkerPool() : null;
  }

  const getServer = () => {
    if (typeof serverInstance === 'function') return serverInstance();
    return serverInstance;
  };

  let shutdownPromise = null;
  let fatalErrorOccurred = false;
  let persistentExitCode = null;
  const fatalSignals = new Set(['uncaughtException', 'unhandledRejection']);

  return (signal = 'SIGTERM', customExitCode) => {
    const isFatal = fatalSignals.has(signal) || customExitCode === 1;
    if (isFatal) {
      fatalErrorOccurred = true;
      persistentExitCode = 1;
    } else if (typeof customExitCode === 'number' && customExitCode !== 0) {
      persistentExitCode = customExitCode;
    }

    if (shutdownPromise) {
      if (isFatal) {
        logger.error(
          `🚨 Fatal event [${signal}] received during active shutdown. Process exit code updated to 1.`,
          { event: 'shutdown.fatal_signal_received', signal }
        );
      } else {
        logger.warn(`⚠️ Shutdown already in progress. Ignoring duplicate ${signal}.`, {
          event: 'shutdown.duplicate_signal',
          signal
        });
      }
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      setIsServerShuttingDown(true);
      if (periodicRecoveryTimer) {
        const timer =
          typeof periodicRecoveryTimer === 'function'
            ? periodicRecoveryTimer()
            : periodicRecoveryTimer;
        if (timer) clearInterval(timer);
      }
      if (abortRecovery) {
        try {
          abortRecovery();
        } catch {
          // ignore abort errors
        }
      }
      logger.info(`🛑 Received ${signal}. Starting graceful shutdown...`, {
        event: 'shutdown.initiated',
        signal
      });

      // CRIT-01: Stop coordinator admission synchronously BEFORE awaiting server close
      if (coordinator) {
        if (typeof coordinator.startDraining === 'function') {
          coordinator.startDraining();
        } else {
          coordinator.draining = true;
        }
      }

      let isTimedOut = false;
      const errors = [];

      const forceExitTimeout = setTimeout(() => {
        isTimedOut = true;
        logger.fatal(`❌ Graceful shutdown timed out after ${timeoutMs}ms. Forcing exit.`, {
          event: 'shutdown.timeout',
          timeoutMs
        });
        exitFn(1);
      }, timeoutMs);

      if (typeof forceExitTimeout.unref === 'function') {
        forceExitTimeout.unref();
      }

      try {
        // Step 1: Stop accepting incoming HTTP requests on listening port
        const srv = getServer();
        if (srv && typeof srv.close === 'function') {
          try {
            await new Promise((resolve, reject) => {
              srv.close((err) => {
                if (err) return reject(err);
                resolve();
              });
              if (typeof srv.closeIdleConnections === 'function') {
                srv.closeIdleConnections();
              }
            });
            logger.info('✅ Step 1: HTTP server closed. In-flight requests drained.', {
              event: 'shutdown.step1_http_closed'
            });
          } catch (err) {
            logger.error(`❌ Step 1 failed (HTTP server close): ${err.message}`, err, {
              event: 'shutdown.step1_failed'
            });
            errors.push(err);
          }
        }

        let coordinatorQuiesced = true;

        // Step 2 & 3: Coordinator Draining & Fleet Quiescence
        if (coordinator) {
          try {
            if (typeof coordinator.waitForFleetQuiescence === 'function') {
              await coordinator.waitForFleetQuiescence(Math.min(timeoutMs, 15000));
              logger.info('✅ Step 2 & 3: Coordinator fleet quiescence reached.', {
                event: 'shutdown.step2_quiescence_reached'
              });
            }
          } catch (err) {
            coordinatorQuiesced = false;
            logger.error(`❌ Step 2/3 failed (Coordinator quiescence): ${err.message}`, err, {
              event: 'shutdown.step2_failed'
            });
            errors.push(err);
          }

          // Step 4: Verify coordinator is quiescent
          try {
            if (typeof coordinator.isQuiescent === 'function') {
              const quiescent = coordinator.isQuiescent();
              if (!quiescent) {
                coordinatorQuiesced = false;
                const remaining =
                  typeof coordinator.inFlightRequests === 'number'
                    ? coordinator.inFlightRequests
                    : 'unknown';
                const msg = `Coordinator failed to reach quiescence: ${remaining} in-flight requests remain.`;
                logger.error(`❌ Step 4 failed: ${msg}`, {
                  event: 'shutdown.step4_quiescence_verification_failed'
                });
                errors.push(new Error(msg));
              } else {
                logger.info('✅ Step 4: Verified coordinator is quiescent.', {
                  event: 'shutdown.step4_quiescence_verified'
                });
              }
            }
          } catch (err) {
            coordinatorQuiesced = false;
            logger.error(`❌ Step 4 failed (Quiescence verification): ${err.message}`, err, {
              event: 'shutdown.step4_check_failed'
            });
            errors.push(err);
          }
        }

        // Step 5: Worker pool shutdown and native thread exit (safe to proceed even if coordinator did not quiesce)
        if (workerPool && typeof workerPool.shutdown === 'function') {
          try {
            await workerPool.shutdown({ timeoutMs: Math.min(timeoutMs, 5000), graceful: false });
            logger.info('✅ Step 5: Bcrypt worker pool shut down successfully.', {
              event: 'shutdown.step5_worker_pool_closed'
            });
          } catch (err) {
            logger.error(`❌ Step 5 failed (Worker pool shutdown): ${err.message}`, err, {
              event: 'shutdown.step5_worker_pool_failed'
            });
            errors.push(err);
          }
        }

        // Step 5b: Wait for active background recovery / deletion lifecycle tasks before closing DB/storage
        if (waitForLifecycleTasks) {
          try {
            await waitForLifecycleTasks(Math.min(timeoutMs, 5000));
            logger.info('✅ Step 5b: Background deletion & recovery tasks drained cleanly.', {
              event: 'shutdown.step5b_lifecycle_drained'
            });
          } catch (err) {
            logger.error(`❌ Step 5b failed (Lifecycle drain): ${err.message}`, err, {
              event: 'shutdown.step5b_lifecycle_failed'
            });
            errors.push(err);
          }
        }

        // Step 6: Database connection close (HIGH-01: Protected against quiescence failure)
        if (
          mongooseInstance &&
          mongooseInstance.connection &&
          mongooseInstance.connection.readyState !== 0
        ) {
          if (!coordinatorQuiesced) {
            const emergencyMsg =
              'EMERGENCY: MongoDB connection left open during shutdown because coordinator failed to reach quiescence; active database operations may remain.';
            logger.fatal(`❌ ${emergencyMsg}`, {
              event: 'shutdown.emergency_mongo_left_open'
            });
            errors.push(new Error(emergencyMsg));
          } else {
            try {
              await mongooseInstance.connection.close(false);
              logger.info('✅ Step 6: MongoDB connection closed safely.', {
                event: 'shutdown.step6_mongo_closed'
              });
            } catch (err) {
              logger.error(`❌ Step 6 failed (MongoDB connection close): ${err.message}`, err, {
                event: 'shutdown.step6_mongo_failed'
              });
              errors.push(err);
            }
          }
        }

        // Step 6b: Storage service teardown (destroy S3 client connections)
        if (storage && typeof storage.destroy === 'function') {
          try {
            await storage.destroy();
            logger.info('✅ Step 6: S3 storage provider destroyed safely.', {
              event: 'shutdown.step6_storage_destroyed'
            });
          } catch (err) {
            logger.error(`❌ Step 6 failed (Storage client destruction): ${err.message}`, err, {
              event: 'shutdown.step6_storage_failed'
            });
            errors.push(err);
          }
        }

        clearTimeout(forceExitTimeout);
        if (isTimedOut) {
          return;
        }

        // Step 7: Clean process exit
        const isFailureSignal =
          signal === 'unhandledRejection' || signal === 'uncaughtException' || fatalErrorOccurred;
        const hasErrors = errors.length > 0;
        const defaultExitCode = isFailureSignal || hasErrors ? 1 : 0;
        let targetExitCode;
        if (typeof persistentExitCode === 'number') {
          targetExitCode = persistentExitCode;
        } else if (typeof customExitCode === 'number') {
          targetExitCode = customExitCode;
        } else {
          targetExitCode = defaultExitCode;
        }
        if ((isFailureSignal || hasErrors) && targetExitCode === 0) {
          targetExitCode = 1;
        }
        logger.info(
          `👋 Step 7: Graceful shutdown complete with exit code ${targetExitCode}. Exiting process.`,
          { event: 'shutdown.complete', exitCode: targetExitCode }
        );
        exitFn(targetExitCode);
      } catch (fatalErr) {
        clearTimeout(forceExitTimeout);
        if (isTimedOut) {
          return;
        }
        logger.fatal(`❌ Fatal error during graceful shutdown: ${fatalErr.message}`, fatalErr, {
          event: 'shutdown.fatal_error'
        });
        exitFn(1);
      }
    })();

    return shutdownPromise;
  };
};

// Start server when run directly (skip auto-listen during automated testing)
let server;
let currentProcessCleanup = null;

const startServer = async (options = {}) => {
  const env = options.env || process.env;
  const exitFn = typeof options.exitFn === 'function' ? options.exitFn : process.exit;
  const port = options.port !== undefined ? options.port : env.PORT || 5001;

  // MED-03: Detach any previous process listeners registered by startServer in this process
  if (currentProcessCleanup) {
    currentProcessCleanup();
    currentProcessCleanup = null;
  }

  // 1. Validate configuration and secrets
  let config;
  try {
    config = validateStartupConfig(env);
  } catch (err) {
    logger.fatal(`FATAL ERROR: Configuration validation failed: ${err.message}`, err, {
      event: 'startup.config_validation_failed'
    });
    if (options.throwOnError) throw err;
    exitFn(1);
    return null;
  }

  // Pre-initialize login protection singleton with the validated Buffer before handling traffic
  if (config.isEnabled && config.secretBuffer) {
    setLoginProtectionComponents({ secretBuffer: config.secretBuffer });
  }

  // Log effective progressive login protection state
  logger.info(
    config.isEnabled
      ? '🔒 Progressive login protection: ENABLED'
      : '🔓 Progressive login protection: DISABLED',
    { event: 'startup.login_protection_status', enabled: config.isEnabled }
  );

  // 2. Connect to database (pass exitOnError=false so startServer routes failures via exitFn / throwOnError)
  try {
    await connectDB(env.MONGO_URI, false);
  } catch (err) {
    logger.fatal(`FATAL ERROR: Database connection failed: ${err.message}`, err, {
      event: 'startup.database_failed'
    });
    if (options.throwOnError) throw err;
    exitFn(1);
    return null;
  }

  // 2b. Startup recovery for abandoned form deletions
  if (!options.skipRecovery && (env.NODE_ENV !== 'test' || options.runStartupRecovery)) {
    try {
      const { recoverAbandonedFormDeletions } = await import('./controllers/formController.js');
      await recoverAbandonedFormDeletions();
    } catch (recoveryErr) {
      logger.warn('Non-fatal: Startup deletion recovery sweep encountered an error', {
        event: 'startup.deletion_recovery_warning',
        error: recoveryErr.message
      });
    }
  }

  // 3. Worker pool pre-warming (when enabled)
  if (config.isEnabled) {
    try {
      await ensureLoginWorkerPoolReady();
      logger.info(
        '🧵 Login protection worker pool pre-warmed successfully (bounded at 2 workers).',
        { event: 'startup.worker_prewarm_success', maxWorkers: 2 }
      );
    } catch (err) {
      logger.fatal(`FATAL ERROR: Failed to pre-warm bcrypt worker pool: ${err.message}`, err, {
        event: 'startup.worker_prewarm_failed'
      });
      // Clean up partially initialized resources
      await resetLoginProtectionComponents();
      if (mongoose.connection && mongoose.connection.readyState !== 0) {
        try {
          await mongoose.connection.close(false);
        } catch {
          // ignore error closing db on failed startup
        }
      }
      if (options.throwOnError) throw err;
      exitFn(1);
      return null;
    }
  }

  let serverInstance = null;
  let periodicRecoveryTimer = null;
  let activeRecoveryPromise = null;
  const recoveryAbortController = new AbortController();

  // 4. Setup graceful shutdown handlers before binding port (MED-02)
  const shutdownOptions = {
    serverInstance: () => serverInstance,
    mongooseInstance: mongoose,
    coordinator: config.isEnabled ? getLoginCoordinator() : null,
    workerPool: config.isEnabled ? getLoginWorkerPool() : null,
    storageService,
    periodicRecoveryTimer: () => periodicRecoveryTimer,
    abortRecovery: () => recoveryAbortController.abort(),
    waitForLifecycleTasks: async (waitBudgetMs) => {
      const deadline = Date.now() + Math.max(0, waitBudgetMs || 5000);
      if (activeRecoveryPromise) {
        const rem = Math.max(0, deadline - Date.now());
        await Promise.race([
          activeRecoveryPromise.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, rem))
        ]);
      }
      try {
        const { waitForActiveDeletionTasks } = await import('./controllers/formController.js');
        if (typeof waitForActiveDeletionTasks === 'function') {
          const rem = Math.max(0, deadline - Date.now());
          await waitForActiveDeletionTasks(rem);
        }
      } catch {
        // Ignore if controller could not be queried during teardown
      }
    },
    exitFn
  };

  const handleShutdown = createGracefulShutdown(shutdownOptions);

  let removeSignalHandlers = () => {
    if (periodicRecoveryTimer) {
      clearInterval(periodicRecoveryTimer);
      periodicRecoveryTimer = null;
    }
    recoveryAbortController.abort();
  };

  if (!options.skipSignalRegistration) {
    const sigtermHandler = () => handleShutdown('SIGTERM');
    const sigintHandler = () => handleShutdown('SIGINT');
    const unhandledRejectionHandler = (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      logger.fatal(
        `❌ Unhandled Promise Rejection: ${message}`,
        reason instanceof Error ? reason : new Error(message),
        { event: 'process.unhandled_rejection' }
      );
      handleShutdown('unhandledRejection', 1);
    };
    const uncaughtExceptionHandler = (err) => {
      logger.fatal(`❌ Uncaught Exception: ${err.message}`, err, {
        event: 'process.uncaught_exception'
      });
      handleShutdown('uncaughtException', 1);
    };

    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);
    process.on('uncaughtException', uncaughtExceptionHandler);

    removeSignalHandlers = () => {
      if (periodicRecoveryTimer) {
        clearInterval(periodicRecoveryTimer);
        periodicRecoveryTimer = null;
      }
      recoveryAbortController.abort();
      process.removeListener('SIGTERM', sigtermHandler);
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('unhandledRejection', unhandledRejectionHandler);
      process.removeListener('uncaughtException', uncaughtExceptionHandler);
    };

    currentProcessCleanup = removeSignalHandlers;
  }

  // 5. HTTP port binding
  serverInstance = app.listen(port, () => {
    logger.info(`Server running in ${env.NODE_ENV || 'development'} mode on port ${port}`, {
      event: 'server.started',
      port,
      env: env.NODE_ENV || 'development'
    });
    if (env.NODE_ENV === 'development') {
      console.log(`🚀 Server running in ${env.NODE_ENV || 'development'} mode on port ${port}`);
      console.log(`📍 API: http://localhost:${port}`);
      console.log(`🏥 Health: http://localhost:${port}/health`);
      console.log(`🏥 Ready: http://localhost:${port}/health/ready`);
    }
  });

  // 6. Periodic background recovery of abandoned form deletions (every 60s in production)
  if (!options.skipRecovery && (env.NODE_ENV !== 'test' || options.runPeriodicRecovery)) {
    const intervalMs = options.recoveryIntervalMs || 60000;
    periodicRecoveryTimer = setInterval(() => {
      if (isServerShuttingDown || recoveryAbortController.signal.aborted || activeRecoveryPromise) {
        return;
      }
      activeRecoveryPromise = (async () => {
        try {
          const { recoverAbandonedFormDeletions } = await import('./controllers/formController.js');
          await recoverAbandonedFormDeletions({ signal: recoveryAbortController.signal });
        } catch (err) {
          logger.warn('Non-fatal: Periodic deletion recovery encountered error', {
            event: 'periodic.deletion_recovery_warning',
            error: err.message
          });
        } finally {
          activeRecoveryPromise = null;
        }
      })();
    }, intervalMs);
    if (periodicRecoveryTimer.unref) periodicRecoveryTimer.unref();
  }

  server = serverInstance;

  return { app, server: serverInstance, handleShutdown, removeSignalHandlers };
};

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((err) => {
    logger.fatal(`FATAL ERROR: Failed to start server: ${err.message}`, err, {
      event: 'startup.failed'
    });
    process.exit(1);
  });
}

export {
  app,
  connectDB,
  server,
  readinessHandler,
  createGracefulShutdown,
  startServer,
  validateStartupConfig,
  isServerShuttingDown,
  setIsServerShuttingDown,
  resetActiveDbPingPromise
};
