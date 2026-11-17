import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import http from 'node:http';
import request from 'supertest';
import {
  app,
  validateStartupConfig,
  createGracefulShutdown,
  startServer,
  readinessHandler,
  setIsServerShuttingDown
} from './server.js';
import { UnifiedComputePipelineCoordinator } from './utils/UnifiedComputePipelineCoordinator.js';
import { BcryptWorkerPool } from './utils/BcryptWorkerPool.js';
import * as authController from './controllers/authController.js';
import * as loginCrypto from './utils/loginProtectionCrypto.js';
import storageService from './services/StorageService.js';
import { logger } from './utils/logger.js';

describe('Stage 3.4: Server Startup & Graceful Teardown Lifecycle Integration', () => {
  const validSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const createMockReplicaSetConnection = (host = 'mock-db', extra = {}) => ({
    connection: {
      host,
      client: {
        topology: {
          description: { type: 'ReplicaSetWithPrimary' }
        }
      },
      db: {
        admin: () => ({
          command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true, setName: 'rs0' })
        })
      },
      ...extra
    }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    setIsServerShuttingDown(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setIsServerShuttingDown(false);
    await authController.resetLoginProtectionComponents();
  });

  // 1. Startup: Configuration Validation and Pre-Warming
  describe('Server Startup and Configuration Validation', () => {
    it('allows legacy startup without requiring HMAC secret when protection is disabled', () => {
      const env = {
        PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'false',
        NODE_ENV: 'production',
        MONGO_URI: 'mongodb://localhost:27017/test',
        JWT_SECRET: 'test-secret-at-least-32-chars-length',
        JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-chars',
        FRONTEND_URL: 'http://localhost:5173',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'test-bucket',
        S3_ACCESS_KEY_ID: 'test-key',
        S3_SECRET_ACCESS_KEY: 'test-secret'
      };

      const config = validateStartupConfig(env);
      expect(config.isEnabled).toBe(false);
      expect(config.secretBuffer).toBeNull();
    });

    it('validates secret and confirms protection is enabled with valid 64-char hex secret', () => {
      const env = {
        PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
        LOGIN_PROTECTION_HMAC_SECRET: validSecret,
        NODE_ENV: 'production',
        MONGO_URI: 'mongodb://localhost:27017/test',
        JWT_SECRET: 'test-secret-at-least-32-chars-length',
        JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-chars',
        FRONTEND_URL: 'http://localhost:5173',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'test-bucket',
        S3_ACCESS_KEY_ID: 'test-key',
        S3_SECRET_ACCESS_KEY: 'test-secret'
      };

      const config = validateStartupConfig(env);
      expect(config.isEnabled).toBe(true);
      expect(config.secretBuffer).toBeInstanceOf(Buffer);
      expect(config.secretBuffer.length).toBe(32);
    });

    it('fails startup validation when protection is enabled but HMAC secret is missing in production', () => {
      const env = {
        PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
        NODE_ENV: 'production',
        MONGO_URI: 'mongodb://localhost:27017/test',
        JWT_SECRET: 'test-secret-at-least-32-chars-length',
        JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-chars',
        FRONTEND_URL: 'http://localhost:5173',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'test-bucket',
        S3_ACCESS_KEY_ID: 'test-key',
        S3_SECRET_ACCESS_KEY: 'test-secret'
      };

      expect(() => validateStartupConfig(env)).toThrow(
        /Invalid progressive login protection configuration: LOGIN_PROTECTION_HMAC_SECRET is required/
      );
    });

    it('fails startup validation when JWT_SECRET is shorter than 32 characters in production/staging', () => {
      const env = {
        NODE_ENV: 'production',
        MONGO_URI: 'mongodb://localhost:27017/test',
        JWT_SECRET: 'short-secret-under-32-chars',
        JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-chars',
        FRONTEND_URL: 'http://localhost:5173',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'test-bucket',
        S3_ACCESS_KEY_ID: 'test-key',
        S3_SECRET_ACCESS_KEY: 'test-secret'
      };

      expect(() => validateStartupConfig(env)).toThrow(
        /JWT_SECRET must be at least 32 characters long in production\/staging/
      );
    });

    it('fails startup validation when JWT_REFRESH_SECRET is shorter than 32 characters in production/staging', () => {
      const env = {
        NODE_ENV: 'staging',
        MONGO_URI: 'mongodb://localhost:27017/test',
        JWT_SECRET: 'test-secret-at-least-32-chars-length',
        JWT_REFRESH_SECRET: 'short-refresh-secret',
        FRONTEND_URL: 'http://localhost:5173',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'test-bucket',
        S3_ACCESS_KEY_ID: 'test-key',
        S3_SECRET_ACCESS_KEY: 'test-secret'
      };

      expect(() => validateStartupConfig(env)).toThrow(
        /JWT_REFRESH_SECRET must be at least 32 characters long in production\/staging/
      );
    });

    it('fails startup validation when JWT_SECRET and JWT_REFRESH_SECRET are identical in production/staging', () => {
      const identicalSecret = 'identical-secret-value-that-exceeds-32-characters-length';
      const env = {
        NODE_ENV: 'production',
        MONGO_URI: 'mongodb://localhost:27017/test',
        JWT_SECRET: identicalSecret,
        JWT_REFRESH_SECRET: identicalSecret,
        FRONTEND_URL: 'http://localhost:5173',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'test-bucket',
        S3_ACCESS_KEY_ID: 'test-key',
        S3_SECRET_ACCESS_KEY: 'test-secret'
      };

      expect(() => validateStartupConfig(env)).toThrow(
        /JWT_SECRET and JWT_REFRESH_SECRET must be distinct secrets in production\/staging/
      );
    });

    it('allows shorter JWT secrets in development and test environments', () => {
      const envDev = {
        NODE_ENV: 'development',
        JWT_SECRET: 'short-dev-secret',
        JWT_REFRESH_SECRET: 'short-dev-refresh'
      };
      const configDev = validateStartupConfig(envDev);
      expect(configDev.isEnabled).toBe(false);

      const envTest = {
        NODE_ENV: 'test',
        JWT_SECRET: 'testsecret',
        JWT_REFRESH_SECRET: 'testsecret'
      };
      const configTest = validateStartupConfig(envTest);
      expect(configTest.isEnabled).toBe(false);
    });

    it('fails startup validation when protection is enabled but HMAC secret is shorter than 32 bytes', () => {
      const env = {
        PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
        LOGIN_PROTECTION_HMAC_SECRET: 'short-secret-under-32-bytes',
        NODE_ENV: 'development'
      };

      expect(() => validateStartupConfig(env)).toThrow(
        /Invalid progressive login protection configuration: HMAC secret key must be at least 32 bytes/
      );
    });

    it('treats unexpected feature flag values as disabled and logs a warning', () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const unexpectedValues = ['TRUE', '1', 'yes', 'enabled', ' true '];

      for (const val of unexpectedValues) {
        warnSpy.mockClear();
        const config = validateStartupConfig({ PROGRESSIVE_LOGIN_PROTECTION_ENABLED: val });
        expect(config.isEnabled).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('strict contract requires exact string "true"'),
          expect.any(Object)
        );
      }
    });

    it('fails startup validation when protection is enabled and HMAC secret is empty string', () => {
      const env = {
        PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
        LOGIN_PROTECTION_HMAC_SECRET: '',
        NODE_ENV: 'test'
      };
      expect(() => validateStartupConfig(env)).toThrow(
        /Invalid progressive login protection configuration: HMAC secret cannot be empty/
      );
    });

    it('injects pre-validated secretBuffer into authController and avoids re-parsing on startup', async () => {
      const parseSpy = vi.spyOn(loginCrypto, 'parseHmacSecret');
      const setComponentsSpy = vi.spyOn(authController, 'setLoginProtectionComponents');
      vi.spyOn(mongoose, 'connect').mockResolvedValueOnce(
        createMockReplicaSetConnection('mock-db')
      );
      vi.spyOn(authController, 'ensureLoginWorkerPoolReady').mockResolvedValueOnce({});

      const result = await startServer({
        env: {
          PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
          LOGIN_PROTECTION_HMAC_SECRET: validSecret,
          NODE_ENV: 'test'
        },
        port: 0,
        skipSignalRegistration: true
      });

      expect(result).not.toBeNull();
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(setComponentsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ secretBuffer: expect.any(Buffer) })
      );

      const svc = authController.getLoginProtectionService();
      expect(svc).toBeDefined();
      expect(parseSpy).toHaveBeenCalledTimes(1);

      if (result.server && result.server.close) {
        await new Promise((res) => result.server.close(res));
      }
    });

    it('does not initialize login protection service when protection is disabled', async () => {
      const setComponentsSpy = vi.spyOn(authController, 'setLoginProtectionComponents');
      vi.spyOn(mongoose, 'connect').mockResolvedValueOnce(
        createMockReplicaSetConnection('mock-db')
      );

      const result = await startServer({
        env: {
          PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'false',
          NODE_ENV: 'test'
        },
        port: 0,
        skipSignalRegistration: true
      });

      expect(result).not.toBeNull();
      expect(setComponentsSpy).not.toHaveBeenCalled();

      if (result.server && result.server.close) {
        await new Promise((res) => result.server.close(res));
      }
    });

    it('aborts startServer before binding HTTP port if configuration validation fails', async () => {
      const mockExit = vi.fn();
      const errorSpy = vi.spyOn(logger, 'fatal');

      const result = await startServer({
        env: {
          PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
          LOGIN_PROTECTION_HMAC_SECRET: 'too-short',
          NODE_ENV: 'development'
        },
        exitFn: mockExit,
        throwOnError: false
      });

      expect(result).toBeNull();
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('FATAL ERROR: Configuration validation failed'),
        expect.any(Error),
        expect.any(Object)
      );
    });

    it('aborts startServer before binding HTTP port if worker pool pre-warming fails', async () => {
      const mockExit = vi.fn();
      const errorSpy = vi.spyOn(logger, 'fatal');

      // Mock connectDB to succeed with valid replica set
      vi.spyOn(mongoose, 'connect').mockResolvedValueOnce(
        createMockReplicaSetConnection('mock-db')
      );

      // Mock worker pre-warming to fail
      vi.spyOn(authController, 'ensureLoginWorkerPoolReady').mockRejectedValueOnce(
        new Error('Worker thread out of memory')
      );
      const resetSpy = vi.spyOn(authController, 'resetLoginProtectionComponents');

      const result = await startServer({
        env: {
          PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
          LOGIN_PROTECTION_HMAC_SECRET: validSecret,
          NODE_ENV: 'test'
        },
        exitFn: mockExit,
        throwOnError: false
      });

      expect(result).toBeNull();
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('FATAL ERROR: Failed to pre-warm bcrypt worker pool'),
        expect.any(Error),
        expect.any(Object)
      );
      expect(resetSpy).toHaveBeenCalled();
    });

    it('enforces exact startup lifecycle order: config -> db -> worker pre-warming -> HTTP listen (MED-04)', async () => {
      const checkpoints = [];
      const timestamps = {};

      const origParseHmacSecret = loginCrypto.parseHmacSecret;
      vi.spyOn(loginCrypto, 'parseHmacSecret').mockImplementation((...args) => {
        checkpoints.push('1_config_validation');
        timestamps.configValidation = performance.now();
        return origParseHmacSecret(...args);
      });

      vi.spyOn(mongoose, 'connect').mockImplementation(async () => {
        checkpoints.push('2_db_connect');
        timestamps.dbConnect = performance.now();
        return createMockReplicaSetConnection('mock-cluster');
      });

      vi.spyOn(authController, 'ensureLoginWorkerPoolReady').mockImplementation(async () => {
        checkpoints.push('3_worker_prewarm_start');
        timestamps.workerPrewarmStart = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 30));
        checkpoints.push('3_worker_prewarm_complete');
        timestamps.workerPrewarmComplete = performance.now();
        return {};
      });

      let listeningServer = null;
      const origListen = app.listen.bind(app);
      vi.spyOn(app, 'listen').mockImplementation(function (...args) {
        checkpoints.push('4_http_listen');
        timestamps.httpListen = performance.now();
        listeningServer = origListen(...args);
        return listeningServer;
      });

      try {
        const result = await startServer({
          env: {
            PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
            LOGIN_PROTECTION_HMAC_SECRET: validSecret,
            NODE_ENV: 'test'
          },
          port: 0,
          skipSignalRegistration: true
        });

        expect(result).not.toBeNull();
        expect(checkpoints).toEqual([
          '1_config_validation',
          '2_db_connect',
          '3_worker_prewarm_start',
          '3_worker_prewarm_complete',
          '4_http_listen'
        ]);

        expect(timestamps.configValidation).toBeLessThanOrEqual(timestamps.dbConnect);
        expect(timestamps.dbConnect).toBeLessThanOrEqual(timestamps.workerPrewarmStart);
        expect(timestamps.workerPrewarmStart).toBeLessThan(timestamps.workerPrewarmComplete);
        expect(timestamps.workerPrewarmComplete).toBeLessThanOrEqual(timestamps.httpListen);
      } finally {
        if (listeningServer) {
          await new Promise((resolve) => listeningServer.close(resolve));
        }
      }
    });

    it('does not pre-warm worker pool when progressive login protection is disabled', async () => {
      vi.spyOn(mongoose, 'connect').mockResolvedValueOnce(
        createMockReplicaSetConnection('mock-db')
      );
      const preWarmSpy = vi.spyOn(authController, 'ensureLoginWorkerPoolReady');

      let listeningServer = null;
      try {
        const result = await startServer({
          env: {
            PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'false',
            NODE_ENV: 'test'
          },
          port: 0,
          skipSignalRegistration: true
        });

        expect(result).not.toBeNull();
        listeningServer = result.server;
        expect(preWarmSpy).not.toHaveBeenCalled();
        expect(listeningServer.listening).toBe(true);
      } finally {
        if (listeningServer) {
          await new Promise((resolve) => listeningServer.close(resolve));
        }
      }
    });
  });

  // 2. Graceful Shutdown Lifecycle Integration (7 Steps)
  describe('Graceful Shutdown Lifecycle Integration', () => {
    it('executes all 7 steps in exact order on clean shutdown: HTTP server -> coordinator quiescence -> worker pool -> MongoDB -> exit(0)', async () => {
      const order = [];
      const mockExit = vi.fn();

      const mockServer = {
        close: (cb) => {
          order.push('Step 1: server.close');
          cb(null);
        }
      };

      const mockCoordinator = {
        draining: false,
        waitForFleetQuiescence: async () => {
          order.push('Step 2 & 3: coordinator.waitForFleetQuiescence');
        },
        isQuiescent: () => {
          order.push('Step 4: coordinator.isQuiescent');
          return true;
        }
      };

      const mockWorkerPool = {
        shutdown: async () => {
          order.push('Step 5: workerPool.shutdown');
        }
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {
            order.push('Step 6: mongoose.connection.close');
          }
        }
      };

      const shutdown = createGracefulShutdown({
        serverInstance: mockServer,
        mongooseInstance: mockMongoose,
        coordinator: mockCoordinator,
        workerPool: mockWorkerPool,
        exitFn: (code) => {
          order.push('Step 7: exitFn');
          mockExit(code);
        },
        timeoutMs: 5000
      });

      await shutdown('SIGTERM');

      expect(order).toEqual([
        'Step 1: server.close',
        'Step 2 & 3: coordinator.waitForFleetQuiescence',
        'Step 4: coordinator.isQuiescent',
        'Step 5: workerPool.shutdown',
        'Step 6: mongoose.connection.close',
        'Step 7: exitFn'
      ]);
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('rejects new login admissions once coordinator draining begins during shutdown', async () => {
      const coordinator = new UnifiedComputePipelineCoordinator({
        maxActive: 2,
        maxQueue: 10,
        maxPerIp: 1
      });

      // Normal admission succeeds before shutdown
      const token1 = coordinator.tryAcquireAdmission('192.168.1.50');
      expect(token1).not.toBeNull();

      // Start quiescence (which marks coordinator.draining = true)
      const quiescePromise = coordinator.waitForFleetQuiescence(2000);
      expect(coordinator.draining).toBe(true);

      // Attempt admission while draining
      const admissionWhileDraining = coordinator.tryAcquireAdmission('192.168.1.51');
      expect(admissionWhileDraining).toBeNull();

      // Settle token1 from ADMITTED_LOOKUP to allow quiescence to resolve
      token1.settleLookupFailure('TEST_COMPLETE');
      await quiescePromise;
      expect(coordinator.isQuiescent()).toBe(true);
    });

    it('ensures in-flight tasks and pending DB writes complete before MongoDB disconnect', async () => {
      const eventLog = [];
      const coordinator = new UnifiedComputePipelineCoordinator();

      // Acquire admission and transition to DB_WRITE
      const token = coordinator.tryAcquireAdmission('192.168.1.60');
      token.handoffPendingToQueued();
      token.handoffQueuedToActive();
      token.handoffComputeToDbWrite();

      expect(coordinator.inFlightRequests).toBe(1);

      const mockServer = { close: (cb) => cb(null) };
      const mockWorkerPool = { shutdown: async () => {} };
      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {
            eventLog.push({ event: 'db_closed', inFlight: coordinator.inFlightRequests });
          }
        }
      };
      const mockExit = vi.fn();

      const shutdown = createGracefulShutdown({
        serverInstance: mockServer,
        mongooseInstance: mockMongoose,
        coordinator,
        workerPool: mockWorkerPool,
        exitFn: mockExit,
        timeoutMs: 3000
      });

      // Settle DB write asynchronously after 50ms
      setTimeout(() => {
        eventLog.push({ event: 'settling_db_write', inFlight: coordinator.inFlightRequests });
        token.settleSuccess('SUCCESS');
      }, 50);

      await shutdown('SIGTERM');

      expect(eventLog).toHaveLength(2);
      expect(eventLog[0].event).toBe('settling_db_write');
      expect(eventLog[0].inFlight).toBe(1);
      expect(eventLog[1].event).toBe('db_closed');
      expect(eventLog[1].inFlight).toBe(0);
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('awaits real worker pool shutdown and physical thread termination', async () => {
      const coordinator = new UnifiedComputePipelineCoordinator();
      const pool = new BcryptWorkerPool({ coordinator, maxWorkers: 2 });
      await pool.initialize();
      expect(pool.aliveWorkerCount).toBe(2);

      const mockServer = { close: (cb) => cb(null) };
      const mockMongoose = { connection: { readyState: 1, close: async () => {} } };
      const mockExit = vi.fn();

      const shutdown = createGracefulShutdown({
        serverInstance: mockServer,
        mongooseInstance: mockMongoose,
        workerPool: pool,
        exitFn: mockExit,
        timeoutMs: 5000
      });

      await shutdown('SIGTERM');

      expect(pool.shuttingDown).toBe(true);
      expect(pool.aliveWorkerCount).toBe(0);
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('guarantees repeated shutdown calls share one teardown operation (idempotency)', async () => {
      let closeCount = 0;
      let dbCount = 0;
      const mockExit = vi.fn();

      const mockServer = {
        close: (cb) => {
          closeCount += 1;
          setTimeout(() => cb(null), 10);
        }
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {
            dbCount += 1;
          }
        }
      };

      const shutdown = createGracefulShutdown({
        serverInstance: mockServer,
        mongooseInstance: mockMongoose,
        exitFn: mockExit,
        timeoutMs: 5000
      });

      await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);

      expect(closeCount).toBe(1);
      expect(dbCount).toBe(1);
      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('continues safe teardown and exits with code 1 when one shutdown step fails', async () => {
      const mockExit = vi.fn();
      let dbClosed = false;
      let poolShutDown = false;

      const mockServer = {
        close: (cb) => {
          cb(new Error('Simulated HTTP socket close failure'));
        }
      };

      const mockCoordinator = {
        waitForFleetQuiescence: async () => true,
        isQuiescent: () => true
      };

      const mockWorkerPool = {
        shutdown: async () => {
          poolShutDown = true;
        }
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {
            dbClosed = true;
          }
        }
      };

      const shutdown = createGracefulShutdown({
        serverInstance: mockServer,
        mongooseInstance: mockMongoose,
        coordinator: mockCoordinator,
        workerPool: mockWorkerPool,
        exitFn: mockExit,
        timeoutMs: 5000
      });

      await shutdown('SIGINT');

      // Subsequent steps were NOT skipped
      expect(poolShutDown).toBe(true);
      expect(dbClosed).toBe(true);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('forces exit with code 1 when shutdown timeout deadline is exceeded', async () => {
      const mockExit = vi.fn();

      const hangingServer = {
        close: () => {
          // Never calls cb to simulate hung socket
        }
      };

      const shutdown = createGracefulShutdown({
        serverInstance: hangingServer,
        mongooseInstance: { connection: { readyState: 1, close: async () => {} } },
        exitFn: mockExit,
        timeoutMs: 40 // short timeout
      });

      shutdown('SIGTERM');

      // Await past timeout
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('does not invoke worker pool shutdown when login protection was disabled, and invokes when enabled (MED-01)', async () => {
      const poolShutdownSpy = vi.fn().mockResolvedValue();
      const mockExit = vi.fn();

      // Disabled simulation: workerPool explicitly passed as null (as constructed by startServer when disabled)
      const shutdownDisabled = createGracefulShutdown({
        serverInstance: { close: (cb) => cb(null) },
        mongooseInstance: { connection: { readyState: 1, close: async () => {} } },
        workerPool: null,
        exitFn: mockExit,
        timeoutMs: 2000
      });

      await shutdownDisabled('SIGTERM');
      expect(poolShutdownSpy).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(0);

      // Enabled simulation: workerPool provided with spy
      mockExit.mockClear();
      const shutdownEnabled = createGracefulShutdown({
        serverInstance: { close: (cb) => cb(null) },
        mongooseInstance: { connection: { readyState: 1, close: async () => {} } },
        workerPool: { shutdown: poolShutdownSpy },
        exitFn: mockExit,
        timeoutMs: 2000
      });

      await shutdownEnabled('SIGTERM');
      expect(poolShutdownSpy).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it('does NOT disconnect MongoDB when quiescence times out, runs worker cleanup, and exits with code 1 (HIGH-01)', async () => {
      let dbClosed = false;
      let poolClosed = false;
      const mockExit = vi.fn();
      const errorSpy = vi.spyOn(logger, 'fatal');

      const mockCoordinator = {
        waitForFleetQuiescence: vi
          .fn()
          .mockRejectedValue(new Error('Fleet quiescence timeout: 2 in-flight requests remain')),
        isQuiescent: vi.fn().mockReturnValue(false),
        inFlightRequests: 2
      };

      const mockWorkerPool = {
        shutdown: vi.fn().mockImplementation(async () => {
          poolClosed = true;
        })
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: vi.fn().mockImplementation(async () => {
            dbClosed = true;
          })
        }
      };

      const shutdown = createGracefulShutdown({
        serverInstance: { close: (cb) => cb(null) },
        mongooseInstance: mockMongoose,
        coordinator: mockCoordinator,
        workerPool: mockWorkerPool,
        exitFn: mockExit,
        timeoutMs: 3000
      });

      await shutdown('SIGTERM');

      // Worker pool cleanup MUST still be attempted where safe
      expect(poolClosed).toBe(true);
      // MongoDB connection MUST NOT be severed while in-flight writes are unresolved
      expect(dbClosed).toBe(false);
      expect(mockMongoose.connection.close).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('EMERGENCY: MongoDB connection left open'),
        expect.any(Object)
      );
    });

    it('does NOT disconnect MongoDB when isQuiescent() returns false, and exits with code 1 (HIGH-01)', async () => {
      let dbClosed = false;
      const mockExit = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const mockCoordinator = {
        waitForFleetQuiescence: vi.fn().mockResolvedValue(true),
        isQuiescent: vi.fn().mockReturnValue(false),
        inFlightRequests: 1
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: vi.fn().mockImplementation(async () => {
            dbClosed = true;
          })
        }
      };

      const shutdown = createGracefulShutdown({
        serverInstance: { close: (cb) => cb(null) },
        mongooseInstance: mockMongoose,
        coordinator: mockCoordinator,
        workerPool: { shutdown: vi.fn().mockResolvedValue() },
        exitFn: mockExit,
        timeoutMs: 3000
      });

      await shutdown('SIGTERM');

      expect(dbClosed).toBe(false);
      expect(mockMongoose.connection.close).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('escalates exit code to 1 when uncaughtException occurs during an active SIGTERM shutdown (HIGH-02)', async () => {
      let serverCloseInvocations = 0;
      let dbCloseInvocations = 0;
      const mockExit = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      let triggerServerCloseDone;
      const mockServer = {
        close: (cb) => {
          serverCloseInvocations++;
          triggerServerCloseDone = () => cb(null);
        }
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {
            dbCloseInvocations++;
          }
        }
      };

      const shutdown = createGracefulShutdown({
        serverInstance: mockServer,
        mongooseInstance: mockMongoose,
        exitFn: mockExit,
        timeoutMs: 5000
      });

      const sigtermPromise = shutdown('SIGTERM');
      const uncaughtPromise = shutdown('uncaughtException', 1);

      triggerServerCloseDone();

      await Promise.all([sigtermPromise, uncaughtPromise]);

      expect(serverCloseInvocations).toBe(1);
      expect(dbCloseInvocations).toBe(1);
      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('escalates exit code to 1 when unhandledRejection occurs during an active SIGINT shutdown (HIGH-02)', async () => {
      let serverCloseInvocations = 0;
      let dbCloseInvocations = 0;
      const mockExit = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      let triggerCloseDone;
      const mockServer = {
        close: (cb) => {
          serverCloseInvocations++;
          triggerCloseDone = () => cb(null);
        }
      };

      const mockMongoose = {
        connection: {
          readyState: 1,
          close: async () => {
            dbCloseInvocations++;
          }
        }
      };

      const shutdown = createGracefulShutdown({
        serverInstance: mockServer,
        mongooseInstance: mockMongoose,
        exitFn: mockExit,
        timeoutMs: 5000
      });

      const sigintPromise = shutdown('SIGINT');
      const rejectionPromise = shutdown('unhandledRejection', 1);

      triggerCloseDone();

      await Promise.all([sigintPromise, rejectionPromise]);

      expect(serverCloseInvocations).toBe(1);
      expect(dbCloseInvocations).toBe(1);
      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('rejects POST /api/auth/login over existing keep-alive socket with 503 and Retry-After: 5 during shutdown (CRIT-01 & MED-05)', async () => {
      const origEnv = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED;
      const origSecret = process.env.LOGIN_PROTECTION_HMAC_SECRET;
      process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = 'true';
      process.env.LOGIN_PROTECTION_HMAC_SECRET = validSecret;

      const coordinator = authController.getLoginCoordinator({ forceNew: true });
      coordinator.draining = false;

      const serverInstance = http.createServer(app);
      await new Promise((resolve) => serverInstance.listen(0, resolve));
      const port = serverInstance.address().port;

      const keepAliveAgent = new http.Agent({
        keepAlive: true,
        maxSockets: 1,
        maxTotalSockets: 1
      });

      const sendRequest = (method, path, body = null) => {
        return new Promise((resolve, reject) => {
          const payload = body ? JSON.stringify(body) : '';
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port,
              path,
              method,
              agent: keepAliveAgent,
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                Origin: 'http://localhost:5173',
                Connection: 'keep-alive'
              }
            },
            (res) => {
              let data = '';
              res.on('data', (chunk) => (data += chunk));
              res.on('end', () => {
                let parsed;
                try {
                  parsed = JSON.parse(data);
                } catch {
                  parsed = data;
                }
                resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
              });
            }
          );
          req.on('error', reject);
          if (payload) req.write(payload);
          req.end();
        });
      };

      try {
        const initialRes = await sendRequest('GET', '/health');
        expect(initialRes.statusCode).toBe(200);

        setIsServerShuttingDown(true);
        coordinator.startDraining();
        expect(coordinator.draining).toBe(true);

        const loginRes = await sendRequest('POST', '/api/auth/login', {
          email: 'user@example.com',
          password: 'Password123!'
        });

        expect(loginRes.statusCode).toBe(503);
        expect(loginRes.headers['retry-after']).toBe('5');
        expect(loginRes.body).toMatchObject({
          success: false,
          message: expect.stringContaining('temporarily unavailable')
        });

        expect(coordinator.inFlightRequests).toBe(0);
        expect(coordinator.computePipelineCount).toBe(0);
      } finally {
        keepAliveAgent.destroy();
        await new Promise((resolve) => serverInstance.close(resolve));
        process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = origEnv;
        process.env.LOGIN_PROTECTION_HMAC_SECRET = origSecret;
      }
    });

    it('gracefully terminates BcryptWorkerPool allowing busy workers to terminate cleanly (MED-07)', async () => {
      const coordinator = new UnifiedComputePipelineCoordinator();
      const pool = new BcryptWorkerPool({ coordinator, maxWorkers: 1 });
      await pool.initialize();
      expect(pool.aliveWorkerCount).toBe(1);

      const token = coordinator.tryAcquireAdmission('192.168.1.99');
      token.handoffPendingToQueued();

      const comparePromise = pool.executeCompare(
        token,
        'password',
        '$2a$10$abcdefghijklmnopqrstuu'
      );
      const shutdownPromise = pool.shutdown({ timeoutMs: 3000, graceful: true });

      await Promise.allSettled([comparePromise, shutdownPromise]);

      expect(pool.shuttingDown).toBe(true);
      expect(pool.aliveWorkerCount).toBe(0);
    });

    it('terminates surviving workers, closes MongoDB, blocks HTTP listen, and exits 1 on partial pool initialization failure (Section 6)', async () => {
      const mockExit = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const dbCloseSpy = vi.fn().mockResolvedValue();
      vi.spyOn(mongoose, 'connect').mockResolvedValueOnce(
        createMockReplicaSetConnection('mock-cluster', { readyState: 1, close: dbCloseSpy })
      );
      mongoose.connection.readyState = 1;
      mongoose.connection.close = dbCloseSpy;

      let worker0Terminated = false;
      const mockWorker0 = {
        id: 'worker-0',
        terminate: vi.fn().mockImplementation(() => {
          worker0Terminated = true;
        })
      };

      const mockPool = {
        workers: new Map([['worker-0', { state: 'IDLE', worker: mockWorker0 }]]),
        aliveWorkerCount: 1,
        shutdown: vi.fn().mockImplementation(async () => {
          worker0Terminated = true;
          mockPool.aliveWorkerCount = 0;
        })
      };

      vi.spyOn(authController, 'ensureLoginWorkerPoolReady').mockImplementationOnce(async () => {
        authController.setLoginProtectionComponents({ workerPool: mockPool });
        throw new Error('Worker slot 1 failed to spawn: Resource temporarily unavailable');
      });

      const resetSpy = vi.spyOn(authController, 'resetLoginProtectionComponents');
      const listenSpy = vi.spyOn(app, 'listen');

      const result = await startServer({
        env: {
          PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'true',
          LOGIN_PROTECTION_HMAC_SECRET: validSecret,
          NODE_ENV: 'test'
        },
        exitFn: mockExit,
        throwOnError: false
      });

      expect(result).toBeNull();
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(resetSpy).toHaveBeenCalled();
      expect(worker0Terminated).toBe(true);
      expect(mockPool.aliveWorkerCount).toBe(0);
      expect(dbCloseSpy).toHaveBeenCalledWith(false);
      expect(listenSpy).not.toHaveBeenCalled();
    });

    it('signals shutting_down status on /health/ready probe as soon as graceful shutdown begins', async () => {
      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      setIsServerShuttingDown(true);

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'shutting_down',
          message: 'Server is shutting down'
        })
      );
    });
  });

  describe('Stage 4.1: Edge Security, Ingress & Readiness Hardening', () => {
    describe('Readiness Probe (/health/ready)', () => {
      const origClient = mongoose.connection.client;
      const origDb = mongoose.connection.db;

      beforeEach(() => {
        vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
        mongoose.connection.client = {
          topology: { description: { type: 'ReplicaSetWithPrimary' } }
        };
        mongoose.connection.db = {
          admin: vi.fn().mockReturnValue({
            command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true, setName: 'rs0' })
          })
        };
        vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValue({
          ok: true,
          status: 'connected'
        });
      });

      afterEach(() => {
        mongoose.connection.client = origClient;
        mongoose.connection.db = origDb;
      });

      it('returns 200 ready when progressive login protection is disabled and dependencies are healthy', async () => {
        const originalEnv = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED;
        process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = 'false';
        try {
          const res = await request(app).get('/health/ready');
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({
            success: true,
            status: 'ready',
            database: 'connected',
            storage: 'connected'
          });
          expect(res.body.workerPool).toBeUndefined();
          expect(res.body.coordinator).toBeUndefined();
        } finally {
          process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = originalEnv;
        }
      });

      it('returns 200 ready when protection is enabled, coordinator is active, and worker pool is fully healthy', async () => {
        const originalEnv = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED;
        process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = 'true';
        try {
          const mockPool = { aliveWorkerCount: 2, maxWorkers: 2, shuttingDown: false };
          const mockCoordinator = { draining: false };
          authController.setLoginProtectionComponents({
            workerPool: mockPool,
            coordinator: mockCoordinator
          });

          const res = await request(app).get('/health/ready');
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({
            success: true,
            status: 'ready',
            database: 'connected',
            storage: 'connected',
            workerPool: 'ready',
            coordinator: 'ready'
          });
        } finally {
          process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = originalEnv;
        }
      });

      it('returns 200 ready with degraded workerPool status when 1 of 2 workers is alive', async () => {
        const originalEnv = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED;
        process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = 'true';
        try {
          const mockPool = { aliveWorkerCount: 1, maxWorkers: 2, shuttingDown: false };
          const mockCoordinator = { draining: false };
          authController.setLoginProtectionComponents({
            workerPool: mockPool,
            coordinator: mockCoordinator
          });

          const res = await request(app).get('/health/ready');
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({
            success: true,
            status: 'ready',
            database: 'connected',
            storage: 'connected',
            workerPool: 'degraded',
            coordinator: 'ready'
          });
        } finally {
          process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = originalEnv;
        }
      });

      it('returns 503 not_ready when worker pool has zero alive workers', async () => {
        const originalEnv = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED;
        process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = 'true';
        try {
          const mockPool = { aliveWorkerCount: 0, maxWorkers: 2, shuttingDown: false };
          const mockCoordinator = { draining: false };
          authController.setLoginProtectionComponents({
            workerPool: mockPool,
            coordinator: mockCoordinator
          });

          const res = await request(app).get('/health/ready');
          expect(res.status).toBe(503);
          expect(res.body).toMatchObject({
            success: false,
            status: 'not_ready',
            database: 'connected',
            storage: 'connected',
            workerPool: 'failed',
            coordinator: 'ready'
          });
        } finally {
          process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = originalEnv;
        }
      });

      it('returns 503 not_ready when coordinator is draining', async () => {
        const originalEnv = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED;
        process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = 'true';
        try {
          const mockPool = { aliveWorkerCount: 2, maxWorkers: 2, shuttingDown: false };
          const mockCoordinator = { draining: true };
          authController.setLoginProtectionComponents({
            workerPool: mockPool,
            coordinator: mockCoordinator
          });

          const res = await request(app).get('/health/ready');
          expect(res.status).toBe(503);
          expect(res.body).toMatchObject({
            success: false,
            status: 'not_ready',
            database: 'connected',
            storage: 'connected',
            workerPool: 'ready',
            coordinator: 'draining'
          });
        } finally {
          process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = originalEnv;
        }
      });

      it('returns 503 not_ready when database is disconnected', async () => {
        vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);

        const res = await request(app).get('/health/ready');
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({
          success: false,
          status: 'not_ready',
          database: 'disconnected'
        });
      });

      it('returns 503 not_ready when storage check fails', async () => {
        vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValue({
          ok: false,
          status: 'error'
        });

        const res = await request(app).get('/health/ready');
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({
          success: false,
          status: 'not_ready',
          storage: 'error'
        });
      });

      it('does not leak internal sensitive secrets, worker thread details, or queue internals in payload', async () => {
        const originalEnv = process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED;
        process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = 'true';
        try {
          const mockPool = {
            aliveWorkerCount: 2,
            maxWorkers: 2,
            shuttingDown: false,
            secretKey: 'leaked'
          };
          const mockCoordinator = { draining: false, internalQueue: [1, 2, 3] };
          authController.setLoginProtectionComponents({
            workerPool: mockPool,
            coordinator: mockCoordinator
          });

          const res = await request(app).get('/health/ready');
          expect(res.status).toBe(200);
          const keys = Object.keys(res.body);
          expect(keys.sort()).toEqual([
            'coordinator',
            'database',
            'status',
            'storage',
            'success',
            'timestamp',
            'workerPool'
          ]);
        } finally {
          process.env.PROGRESSIVE_LOGIN_PROTECTION_ENABLED = originalEnv;
        }
      });
    });

    describe('CORS Response-Header Exposure', () => {
      it('exposes rate limiting and retry headers in Access-Control-Expose-Headers', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        const exposed = res.headers['access-control-expose-headers'];
        expect(exposed).toBeDefined();
        const headers = exposed.split(',').map((h) => h.trim());
        expect(headers).toContain('Retry-After');
        expect(headers).toContain('RateLimit-Limit');
        expect(headers).toContain('RateLimit-Remaining');
        expect(headers).toContain('RateLimit-Reset');
        expect(headers).toContain('X-Request-ID');
      });

      it('allows X-Request-ID in CORS preflight OPTIONS requests', async () => {
        const res = await request(app)
          .options('/api/auth/login')
          .set('Origin', 'http://localhost:5173')
          .set('Access-Control-Request-Method', 'POST')
          .set('Access-Control-Request-Headers', 'Content-Type, X-Request-ID');

        expect(res.status).toBe(204);
        const allowed = res.headers['access-control-allow-headers'];
        expect(allowed).toBeDefined();
        const headers = allowed.split(',').map((h) => h.trim());
        expect(headers).toContain('X-Request-ID');
      });
    });

    describe('Stage 4.2.2: Request Correlation & Observability Integration', () => {
      it('attaches unique server-generated X-Request-ID header to every response', async () => {
        const res1 = await request(app).get('/health');
        const res2 = await request(app).get('/health');

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        const id1 = res1.headers['x-request-id'];
        const id2 = res2.headers['x-request-id'];

        expect(id1).toBeDefined();
        expect(id2).toBeDefined();
        expect(id1).not.toBe(id2);
        // Valid UUID format
        expect(id1).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
      });

      it('overwrites untrusted client-provided X-Request-ID with server-generated UUID', async () => {
        const spoofedId = 'malicious-client-id-12345';
        const res = await request(app).get('/health').set('X-Request-ID', spoofedId);

        expect(res.status).toBe(200);
        const headerId = res.headers['x-request-id'];
        expect(headerId).toBeDefined();
        expect(headerId).not.toBe(spoofedId);
        expect(headerId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
      });

      it('includes matching requestId in 404 error responses', async () => {
        const res = await request(app).get('/api/non-existent-endpoint');

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.requestId).toBeDefined();
        expect(res.headers['x-request-id']).toBe(res.body.requestId);
      });
    });

    describe('Graceful Shutdown Idle Keep-Alive Connections', () => {
      it('invokes closeIdleConnections() during Step 1 of shutdown when available', async () => {
        const mockCloseIdle = vi.fn();
        const mockServer = {
          close: vi.fn((cb) => cb()),
          closeIdleConnections: mockCloseIdle
        };

        const shutdown = createGracefulShutdown({
          serverInstance: mockServer,
          mongooseInstance: { connection: { close: vi.fn().mockResolvedValue() } },
          exitFn: vi.fn(),
          timeoutMs: 1000
        });

        await shutdown();

        expect(mockServer.close).toHaveBeenCalled();
        expect(mockCloseIdle).toHaveBeenCalled();
      });

      it('proceeds gracefully without error when closeIdleConnections is not present', async () => {
        const mockServer = {
          close: vi.fn((cb) => cb())
        };

        const shutdown = createGracefulShutdown({
          serverInstance: mockServer,
          mongooseInstance: { connection: { close: vi.fn().mockResolvedValue() } },
          exitFn: vi.fn(),
          timeoutMs: 1000
        });

        await shutdown();

        expect(mockServer.close).toHaveBeenCalled();
      });
    });

    describe('Stage 4.3.5 Batch A: CORS and CSRF Trusted Origin Alignment', () => {
      it('allows request and reflects Access-Control-Allow-Origin for primary trusted origin', async () => {
        const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');

        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      });

      it('allows request and reflects Access-Control-Allow-Origin for secondary trusted origin', async () => {
        const res = await request(app).get('/health').set('Origin', 'http://localhost:5000');

        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5000');
        expect(res.headers['access-control-allow-credentials']).toBe('true');
      });

      it('rejects CORS preflight from untrusted origin', async () => {
        const res = await request(app)
          .options('/api/auth/me')
          .set('Origin', 'https://malicious-site.com')
          .set('Access-Control-Request-Method', 'GET');

        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });

      it('allows requests with no Origin header (e.g. curl or server-to-server)', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('live');
      });
    });

    describe('Stage 4.3.5 Batch C: Storage Teardown in Graceful Shutdown', () => {
      it('invokes storageService.destroy() during Step 6 of graceful shutdown', async () => {
        const mockServer = { close: vi.fn((cb) => cb()) };
        const mockMongoose = { connection: { readyState: 1, close: vi.fn().mockResolvedValue() } };
        const mockStorage = { destroy: vi.fn().mockResolvedValue() };
        const mockExit = vi.fn();

        const shutdown = createGracefulShutdown({
          serverInstance: mockServer,
          mongooseInstance: mockMongoose,
          storageService: mockStorage,
          exitFn: mockExit,
          timeoutMs: 2000
        });

        await shutdown('SIGTERM');

        expect(mockStorage.destroy).toHaveBeenCalledTimes(1);
        expect(mockMongoose.connection.close).toHaveBeenCalledTimes(1);
        expect(mockExit).toHaveBeenCalledWith(0);
      });

      it('clears periodicRecoveryTimer, aborts recovery, and awaits lifecycle drain before closing MongoDB and storage', async () => {
        const events = [];
        const mockServer = {
          close: vi.fn((cb) => {
            events.push('server_closed');
            cb();
          })
        };
        const mockMongoose = {
          connection: {
            readyState: 1,
            close: vi.fn().mockImplementation(async () => {
              events.push('mongo_closed');
            })
          }
        };
        const mockStorage = {
          destroy: vi.fn().mockImplementation(async () => {
            events.push('storage_destroyed');
          })
        };
        const mockTimer = setInterval(() => {}, 60000);
        const clearSpy = vi.spyOn(global, 'clearInterval');
        const abortSpy = vi.fn(() => events.push('recovery_aborted'));
        const drainSpy = vi.fn().mockImplementation(async () => {
          events.push('lifecycle_drained');
        });
        const mockExit = vi.fn(() => events.push('exited'));

        const shutdown = createGracefulShutdown({
          serverInstance: mockServer,
          mongooseInstance: mockMongoose,
          storageService: mockStorage,
          periodicRecoveryTimer: () => mockTimer,
          abortRecovery: abortSpy,
          waitForLifecycleTasks: drainSpy,
          exitFn: mockExit,
          timeoutMs: 2000
        });

        await shutdown('SIGTERM');

        expect(clearSpy).toHaveBeenCalledWith(mockTimer);
        expect(abortSpy).toHaveBeenCalledTimes(1);
        expect(drainSpy).toHaveBeenCalledTimes(1);
        expect(events).toEqual([
          'recovery_aborted',
          'server_closed',
          'lifecycle_drained',
          'mongo_closed',
          'storage_destroyed',
          'exited'
        ]);
      });

      it('aborts startServer before HTTP listen and calls exitFn(1) when connected MongoDB is standalone', async () => {
        const mockExit = vi.fn();
        const closeSpy = vi.fn().mockResolvedValue();
        vi.spyOn(mongoose, 'connect').mockResolvedValueOnce({
          connection: {
            host: 'standalone-node:27017',
            client: { topology: { description: { type: 'Single' } } },
            close: closeSpy
          }
        });
        const listenSpy = vi.spyOn(app, 'listen');

        const result = await startServer({
          env: {
            PROGRESSIVE_LOGIN_PROTECTION_ENABLED: 'false',
            NODE_ENV: 'test',
            MONGO_URI: 'mongodb://standalone-node:27017/paperless'
          },
          exitFn: mockExit,
          throwOnError: false
        });

        expect(result).toBeNull();
        expect(closeSpy).toHaveBeenCalledWith(false);
        expect(mockExit).toHaveBeenCalledWith(1);
        expect(listenSpy).not.toHaveBeenCalled();
      });
    });
  });
});
