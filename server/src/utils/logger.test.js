import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  logger,
  LOG_LEVELS,
  isValidLogLevel,
  resolveLogLevel,
  DEFAULT_LEVEL_BY_ENV,
  setLogContextProvider,
  getLogContextProvider
} from './logger.js';

describe('Structured Logger (logger.js)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Level Resolution and Hierarchy', () => {
    it('defines the expected numeric priority order for all levels', () => {
      expect(LOG_LEVELS.debug).toBeLessThan(LOG_LEVELS.info);
      expect(LOG_LEVELS.info).toBeLessThan(LOG_LEVELS.warn);
      expect(LOG_LEVELS.warn).toBeLessThan(LOG_LEVELS.error);
      expect(LOG_LEVELS.error).toBeLessThan(LOG_LEVELS.fatal);
      expect(LOG_LEVELS.fatal).toBeLessThan(LOG_LEVELS.silent);
    });

    it('identifies valid log level names case-insensitively', () => {
      expect(isValidLogLevel('debug')).toBe(true);
      expect(isValidLogLevel('INFO')).toBe(true);
      expect(isValidLogLevel('Warn')).toBe(true);
      expect(isValidLogLevel('error')).toBe(true);
      expect(isValidLogLevel('fatal')).toBe(true);
      expect(isValidLogLevel('silent')).toBe(true);
      expect(isValidLogLevel('invalid')).toBe(false);
      expect(isValidLogLevel('')).toBe(false);
      expect(isValidLogLevel(null)).toBe(false);
      expect(isValidLogLevel(undefined)).toBe(false);
    });

    it('resolves default level by environment when no override is provided', () => {
      expect(DEFAULT_LEVEL_BY_ENV.development).toBe('debug');
      expect(DEFAULT_LEVEL_BY_ENV.test).toBe('silent');
      expect(DEFAULT_LEVEL_BY_ENV.staging).toBe('info');
      expect(DEFAULT_LEVEL_BY_ENV.production).toBe('info');
      expect(resolveLogLevel(undefined, 'development')).toBe('debug');
      expect(resolveLogLevel(undefined, 'test')).toBe('silent');
      expect(resolveLogLevel(undefined, 'staging')).toBe('info');
      expect(resolveLogLevel(undefined, 'production')).toBe('info');
      expect(resolveLogLevel(undefined, 'unknown_env')).toBe('info');
    });

    it('honors valid explicit level overrides across environments', () => {
      expect(resolveLogLevel('debug', 'production')).toBe('debug');
      expect(resolveLogLevel('WARN', 'development')).toBe('warn');
      expect(resolveLogLevel('info', 'test')).toBe('info');
    });

    it('falls back safely to environment default when given an invalid level override', () => {
      expect(resolveLogLevel('unrecognized_level', 'production')).toBe('info');
      expect(resolveLogLevel('super_verbose', 'test')).toBe('silent');
      expect(resolveLogLevel('bogus', 'development')).toBe('debug');
    });
  });

  describe('Environment-Aware Output Formatting', () => {
    it('emits valid single-line NDJSON in production/staging environments', () => {
      const capturedLines = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'info',
        destination: (line) => capturedLines.push(line)
      });

      testLogger.info('Service started', { port: 5000 });

      expect(capturedLines).toHaveLength(1);
      const rawLine = capturedLines[0];
      expect(rawLine).not.toContain('\n'); // strictly single-line

      const parsed = JSON.parse(rawLine);
      expect(parsed).toMatchObject({
        level: 'info',
        service: 'paperless-api',
        env: 'production',
        pid: process.pid,
        message: 'Service started',
        context: { port: 5000 }
      });
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it('emits human-readable text format in development environment', () => {
      const capturedLines = [];
      const testLogger = createLogger({
        env: 'development',
        level: 'debug',
        destination: (line) => capturedLines.push(line)
      });

      testLogger.debug('Connection pool initialized', { poolSize: 5 });

      expect(capturedLines).toHaveLength(1);
      const line = capturedLines[0];
      expect(line).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[DEBUG\] \(paperless-api\) Connection pool initialized/
      );
      expect(line).toContain('{"poolSize":5}');
    });

    it('is quiet by default in test environment unless explicitly configured', () => {
      const capturedLines = [];
      const testLogger = createLogger({
        env: 'test',
        destination: (line) => capturedLines.push(line)
      });

      testLogger.debug('Debug in test');
      testLogger.info('Info in test');
      testLogger.warn('Warn in test');
      testLogger.error('Error in test');

      expect(capturedLines).toHaveLength(0);
      expect(testLogger.level).toBe('silent');
    });

    it('allows deliberate log inspection in tests when level is overridden', () => {
      const capturedLines = [];
      const testLogger = createLogger({
        env: 'test',
        level: 'info',
        destination: (line) => capturedLines.push(line)
      });

      testLogger.debug('Should be filtered');
      testLogger.info('Deliberate test message', { check: true });

      expect(capturedLines).toHaveLength(1);
      const parsed = JSON.parse(capturedLines[0]);
      expect(parsed.message).toBe('Deliberate test message');
      expect(parsed.context).toEqual({ check: true });
    });
  });

  describe('Level Filtering', () => {
    it('filters out messages below the active threshold', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'warn',
        destination: (line, { record }) => captured.push(record)
      });

      testLogger.debug('Debug message');
      testLogger.info('Info message');
      testLogger.warn('Warning message');
      testLogger.error('Error message');
      testLogger.fatal('Fatal message');

      expect(captured.map((c) => c.level)).toEqual(['warn', 'error', 'fatal']);
    });

    it('correctly reports isLevelEnabled', () => {
      const testLogger = createLogger({ env: 'production', level: 'warn' });

      expect(testLogger.isLevelEnabled('debug')).toBe(false);
      expect(testLogger.isLevelEnabled('info')).toBe(false);
      expect(testLogger.isLevelEnabled('warn')).toBe(true);
      expect(testLogger.isLevelEnabled('error')).toBe(true);
      expect(testLogger.isLevelEnabled('fatal')).toBe(true);
      expect(testLogger.isLevelEnabled('invalid')).toBe(false);
    });

    it('allows changing level dynamically at runtime', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'error',
        destination: (line, { record }) => captured.push(record)
      });

      testLogger.info('Info message before change');
      expect(captured).toHaveLength(0);

      testLogger.level = 'info';
      expect(testLogger.level).toBe('info');

      testLogger.info('Info message after change');
      expect(captured).toHaveLength(1);
      expect(captured[0].message).toBe('Info message after change');
    });
  });

  describe('Redaction & Error Serialization Integration', () => {
    it('automatically redacts sensitive keys and patterns in message and context', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'info',
        destination: (line, { record }) => captured.push(record)
      });

      testLogger.info(
        'User login failed for Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeak',
        {
          password: 'PlainTextPassword123!',
          userEmail: 'alice@example.com',
          apiKey: 'sk-proj-1234567890abcdef1234567890',
          metadata: {
            token: 'sensitive-token-value',
            regularKey: 'safe-value'
          }
        }
      );

      expect(captured).toHaveLength(1);
      const record = captured[0];

      // Message redacted
      expect(record.message).toContain('Bearer [REDACTED]');
      expect(record.message).not.toContain('eyJhbGciOi');

      // Context keys redacted
      expect(record.context.password).toBe('[REDACTED]');
      expect(record.context.apiKey).toBe('[REDACTED]');
      expect(record.context.metadata.token).toBe('[REDACTED]');
      expect(record.context.metadata.regularKey).toBe('safe-value');

      // Email masked in context
      expect(record.context.userEmail).toBe('al***@example.com');
    });

    it('safely serializes standard Error objects and scrubs error stacks', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'error',
        destination: (line, { record }) => captured.push(record)
      });

      const err = new Error(
        'Database connection failed to mongodb://admin:secretPass@localhost:27017/db'
      );
      err.code = 'ECONNREFUSED';
      err.statusCode = 503;

      testLogger.error('Failed to connect to primary DB', err, { attempt: 3 });

      expect(captured).toHaveLength(1);
      const record = captured[0];
      expect(record.message).toBe('Failed to connect to primary DB');
      expect(record.error).toBeDefined();
      expect(record.error.name).toBe('Error');
      expect(record.error.message).toContain('mongodb://admin:[REDACTED]@localhost:27017/db');
      expect(record.error.message).not.toContain('secretPass');
      expect(record.error.code).toBe('ECONNREFUSED');
      expect(record.error.statusCode).toBe(503);
      expect(record.context).toEqual({ attempt: 3 });
    });

    it('handles circular references in context objects safely without throwing', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'info',
        destination: (line, { record }) => captured.push(record)
      });

      const circularObj = { name: 'circular-test' };
      circularObj.self = circularObj;

      expect(() => {
        testLogger.info('Testing circular context', circularObj);
      }).not.toThrow();

      expect(captured).toHaveLength(1);
      expect(captured[0].context.name).toBe('circular-test');
      expect(captured[0].context.self).toBe('[Circular]');
    });

    it('protects against accidental passing of Express req / res objects in context', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'info',
        destination: (line, { record }) => captured.push(record)
      });

      const mockReq = {
        method: 'POST',
        url: '/api/auth/resetpassword/abcdef0123456789?token=secret123',
        headers: {
          authorization: 'Bearer secret-token',
          cookie: 'token=jwt.token.value'
        },
        socket: { remoteAddress: '127.0.0.1' },
        body: { password: 'secret' }
      };

      testLogger.info('Request started', mockReq);

      expect(captured).toHaveLength(1);
      const context = captured[0].context;
      expect(context.method).toBe('POST');
      expect(context.url).toBe('/api/auth/resetpassword/[REDACTED]?token=[REDACTED]');
      expect(context.headers).toBeUndefined(); // internal raw headers stripped
      expect(context.body).toBeUndefined(); // raw body stripped
    });
  });

  describe('Child Logger Context Propagation', () => {
    it('creates child logger that inherits configuration and binds context', () => {
      const captured = [];
      const parent = createLogger({
        env: 'production',
        level: 'info',
        destination: (line, { record }) => captured.push(record),
        defaultContext: { appVersion: '1.0.0' }
      });

      const child = parent.child({ requestId: 'req-uuid-1234', service: 'auth' });

      child.info('Child operation started', { step: 1 });

      expect(captured).toHaveLength(1);
      const record = captured[0];
      expect(record.message).toBe('Child operation started');
      expect(record.context).toEqual({
        appVersion: '1.0.0',
        requestId: 'req-uuid-1234',
        service: 'auth',
        step: 1
      });
    });

    it('child logger preserves parent level and destination', () => {
      const captured = [];
      const parent = createLogger({
        env: 'production',
        level: 'warn',
        destination: (line, { record }) => captured.push(record)
      });

      const child = parent.child({ component: 'worker' });

      child.info('Should be filtered by child at warn level');
      expect(captured).toHaveLength(0);

      child.warn('Warning from child');
      expect(captured).toHaveLength(1);
      expect(captured[0].message).toBe('Warning from child');
      expect(captured[0].context).toEqual({ component: 'worker' });
    });
  });

  describe('Stream Failure Resilience & Error Handling', () => {
    it('does not crash the application when the output stream throws an error', () => {
      const failingDestination = () => {
        const streamErr = new Error('EPIPE: Broken pipe');
        streamErr.code = 'EPIPE';
        throw streamErr;
      };

      const testLogger = createLogger({
        env: 'production',
        level: 'info',
        destination: failingDestination
      });

      // Must not throw or destabilize caller
      expect(() => {
        testLogger.info('This write will fail in the stream');
      }).not.toThrow();

      expect(testLogger.lastStreamError).toBeDefined();
      expect(testLogger.lastStreamError.message).toBe('EPIPE: Broken pipe');
    });

    it('default logger singleton exports expected methods and levels', () => {
      expect(logger).toBeDefined();
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.fatal).toBe('function');
      expect(typeof logger.child).toBe('function');
      expect(typeof logger.isLevelEnabled).toBe('function');
    });
  });

  describe('Ambient Context Provider Integration', () => {
    let savedProvider;

    beforeEach(() => {
      savedProvider = getLogContextProvider();
    });

    afterEach(() => {
      setLogContextProvider(savedProvider);
    });

    it('allows registering and retrieving an ambient context provider', () => {
      const mockProvider = () => ({ requestId: 'test-req-123' });
      setLogContextProvider(mockProvider);
      expect(getLogContextProvider()).toBe(mockProvider);

      setLogContextProvider(null);
      expect(getLogContextProvider()).toBeNull();
    });

    it('automatically merges ambient context into log emissions', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'info',
        destination: (line, { record }) => captured.push(record)
      });

      setLogContextProvider(() => ({ requestId: 'ambient-uuid-456' }));

      testLogger.info('Service request received');

      expect(captured).toHaveLength(1);
      expect(captured[0].context).toEqual({ requestId: 'ambient-uuid-456' });
    });

    it('allows call-site and child logger context to take precedence over ambient context', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'info',
        destination: (line, { record }) => captured.push(record),
        defaultContext: { appVersion: '2.0.0' }
      });

      setLogContextProvider(() => ({
        requestId: 'ambient-uuid-789',
        tag: 'ambient-tag'
      }));

      testLogger.info('Overriding tag', { tag: 'callsite-tag', step: 2 });

      expect(captured).toHaveLength(1);
      expect(captured[0].context).toEqual({
        requestId: 'ambient-uuid-789',
        appVersion: '2.0.0',
        tag: 'callsite-tag',
        step: 2
      });
    });

    it('safely tolerates an ambient provider that throws without crashing logger', () => {
      const captured = [];
      const testLogger = createLogger({
        env: 'production',
        level: 'info',
        destination: (line, { record }) => captured.push(record)
      });

      setLogContextProvider(() => {
        throw new Error('Async context failure');
      });

      expect(() => {
        testLogger.info('Message during provider error');
      }).not.toThrow();

      expect(captured).toHaveLength(1);
      expect(captured[0].message).toBe('Message during provider error');
      expect(captured[0].context).toBeUndefined();
    });
  });
});
