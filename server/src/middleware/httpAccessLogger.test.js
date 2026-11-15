/**
 * Tests for HTTP Access Logging Middleware (httpAccessLogger.js).
 *
 * Verifies:
 * - Completed and aborted request event emissions with canonical payload
 * - Route template preservation (e.g. /api/forms/:id)
 * - Status code resolution and custom aborted status (499)
 * - Duplicate event prevention when both finish and close fire
 * - Privacy safeguards: zero leakage of bodies, query params, cookies, or auth headers
 * - Health check noise suppression policy (debug on 200, error/warn on 503, optional suppression)
 * - Real Express and Supertest integration
 * - Real socket abort handling via HTTP server
 * - Direct and factory export invocations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'http';
import { EventEmitter } from 'events';

import {
  httpAccessLogger,
  createHttpAccessLogger,
  resolveRequestId,
  resolveRoute,
  resolveLogLevel,
  isHealthCheckPath,
  calculateDurationMs,
  DEFAULT_HEALTH_PATHS
} from './httpAccessLogger.js';
import { createLogger } from '../utils/logger.js';

describe('HTTP Access Logging Middleware (httpAccessLogger.js)', () => {
  describe('Helper Functions & Unit Logic', () => {
    describe('resolveRequestId', () => {
      it('resolves request ID from req.id', () => {
        const req = { id: 'req-alpha-123' };
        expect(resolveRequestId(req)).toBe('req-alpha-123');
      });

      it('resolves request ID when req.id is numeric', () => {
        const req = { id: 4242 };
        expect(resolveRequestId(req)).toBe('4242');
      });

      it('resolves request ID from req.getRequestId() method', () => {
        const req = { getRequestId: () => 'req-from-method-999' };
        expect(resolveRequestId(req)).toBe('req-from-method-999');
      });

      it('resolves request ID from req.requestId property', () => {
        const req = { requestId: 'req-prop-777' };
        expect(resolveRequestId(req)).toBe('req-prop-777');
      });

      it('resolves request ID from x-request-id header object', () => {
        const req = { headers: { 'x-request-id': 'req-header-555' } };
        expect(resolveRequestId(req)).toBe('req-header-555');
      });

      it('resolves request ID from req.get() function', () => {
        const req = {
          get: (name) => (name.toLowerCase() === 'x-request-id' ? 'req-getter-333' : undefined)
        };
        expect(resolveRequestId(req)).toBe('req-getter-333');
      });

      it('resolves request ID using options.getRequestId callback', () => {
        const req = { customTrackingId: 'trace-custom-888' };
        const id = resolveRequestId(req, {
          getRequestId: (r) => r.customTrackingId
        });
        expect(id).toBe('trace-custom-888');
      });

      it('returns undefined when no request ID is available', () => {
        const req = { headers: {} };
        expect(resolveRequestId(req)).toBeUndefined();
      });

      it('returns undefined when req is null or undefined', () => {
        expect(resolveRequestId(null)).toBeUndefined();
        expect(resolveRequestId(undefined)).toBeUndefined();
      });
    });

    describe('resolveRoute', () => {
      it('resolves simple route template from req.route.path', () => {
        const req = {
          route: { path: '/api/forms' }
        };
        expect(resolveRoute(req)).toBe('/api/forms');
      });

      it('preserves route template with parameters and baseUrl', () => {
        const req = {
          baseUrl: '/api/forms',
          route: { path: '/:id' }
        };
        expect(resolveRoute(req)).toBe('/api/forms/:id');
      });

      it('normalizes root route mounted on baseUrl', () => {
        const req = {
          baseUrl: '/api/forms',
          route: { path: '/' }
        };
        expect(resolveRoute(req)).toBe('/api/forms');
      });

      it('normalizes single root route on root app', () => {
        const req = {
          baseUrl: '',
          route: { path: '/' }
        };
        expect(resolveRoute(req)).toBe('/');
      });

      it('resolves matching route path from route path array', () => {
        const req = {
          baseUrl: '',
          originalUrl: '/api/health',
          route: { path: ['/health', '/api/health'] }
        };
        expect(resolveRoute(req)).toBe('/api/health');
      });

      it('converts RegExp route path to string', () => {
        const req = {
          baseUrl: '/api',
          route: { path: /^\/users\/[0-9]+$/ }
        };
        expect(resolveRoute(req)).toBe('/api/^\\/users\\/[0-9]+$/');
      });

      it('strips query strings completely for unmatched routes', () => {
        const req = {
          originalUrl: '/unknown/endpoint?token=secret123&foo=bar#section'
        };
        expect(resolveRoute(req)).toBe('/unknown/endpoint');
      });

      it('redacts sensitive tokens in unmatched route path', () => {
        const req = {
          originalUrl: '/reset-password/abc123xyz?token=secret'
        };
        expect(resolveRoute(req)).toBe('/reset-password/[REDACTED]');
      });

      it('honors options.unmatchedRouteIdentifier when req.route is missing', () => {
        const req = {
          originalUrl: '/unmatched/route/here'
        };
        const route = resolveRoute(req, {
          unmatchedRouteIdentifier: '[unmatched_route]'
        });
        expect(route).toBe('[unmatched_route]');
      });

      it('returns [unmatched_route] when no URL or path exists', () => {
        expect(resolveRoute(null)).toBe('[unmatched_route]');
        expect(resolveRoute({})).toBe('[unmatched_route]');
      });
    });

    describe('isHealthCheckPath', () => {
      it('correctly matches all standard health check endpoints', () => {
        for (const path of DEFAULT_HEALTH_PATHS) {
          expect(isHealthCheckPath(path)).toBe(true);
        }
      });

      it('matches health paths with trailing slashes and query strings', () => {
        expect(isHealthCheckPath('/health/')).toBe(true);
        expect(isHealthCheckPath('/api/health?probe=1')).toBe(true);
        expect(isHealthCheckPath('/ready#top')).toBe(true);
        expect(isHealthCheckPath('/api/health/ready/')).toBe(true);
      });

      it('returns false for non-health endpoints', () => {
        expect(isHealthCheckPath('/api/forms')).toBe(false);
        expect(isHealthCheckPath('/api/auth/login')).toBe(false);
        expect(isHealthCheckPath('/api/health/other')).toBe(false);
        expect(isHealthCheckPath('')).toBe(false);
        expect(isHealthCheckPath(null)).toBe(false);
      });
    });

    describe('resolveLogLevel', () => {
      it('resolves info for standard successful requests (< 400)', () => {
        expect(resolveLogLevel({ statusCode: 200, isAborted: false, isHealthCheck: false })).toBe(
          'info'
        );
        expect(resolveLogLevel({ statusCode: 201, isAborted: false, isHealthCheck: false })).toBe(
          'info'
        );
        expect(resolveLogLevel({ statusCode: 304, isAborted: false, isHealthCheck: false })).toBe(
          'info'
        );
      });

      it('resolves warn for standard client error requests (4xx)', () => {
        expect(resolveLogLevel({ statusCode: 400, isAborted: false, isHealthCheck: false })).toBe(
          'warn'
        );
        expect(resolveLogLevel({ statusCode: 404, isAborted: false, isHealthCheck: false })).toBe(
          'warn'
        );
        expect(resolveLogLevel({ statusCode: 429, isAborted: false, isHealthCheck: false })).toBe(
          'warn'
        );
      });

      it('resolves error for standard server error requests (5xx)', () => {
        expect(resolveLogLevel({ statusCode: 500, isAborted: false, isHealthCheck: false })).toBe(
          'error'
        );
        expect(resolveLogLevel({ statusCode: 502, isAborted: false, isHealthCheck: false })).toBe(
          'error'
        );
      });

      it('resolves warn for aborted requests', () => {
        expect(resolveLogLevel({ statusCode: 499, isAborted: true, isHealthCheck: false })).toBe(
          'warn'
        );
      });

      it('resolves debug for successful health check probes (< 400)', () => {
        expect(resolveLogLevel({ statusCode: 200, isAborted: false, isHealthCheck: true })).toBe(
          'debug'
        );
      });

      it('resolves error for degraded/failed health check probes (5xx, e.g. 503)', () => {
        expect(resolveLogLevel({ statusCode: 503, isAborted: false, isHealthCheck: true })).toBe(
          'error'
        );
      });

      it('resolves warn for client error health check probes (4xx)', () => {
        expect(resolveLogLevel({ statusCode: 404, isAborted: false, isHealthCheck: true })).toBe(
          'warn'
        );
      });

      it('honors custom resolveLogLevel callback override', () => {
        const level = resolveLogLevel({
          statusCode: 200,
          isAborted: false,
          isHealthCheck: false,
          options: {
            resolveLogLevel: () => 'debug'
          }
        });
        expect(level).toBe('debug');
      });
    });

    describe('calculateDurationMs', () => {
      it('calculates numeric duration from process.hrtime.bigint start time', () => {
        const start = process.hrtime.bigint() - 5000000n; // 5ms ago
        const duration = calculateDurationMs(start);
        expect(typeof duration).toBe('number');
        expect(duration).toBeGreaterThanOrEqual(5);
      });

      it('calculates numeric duration from Date.now() timestamp', () => {
        const start = Date.now() - 25;
        const duration = calculateDurationMs(start);
        expect(typeof duration).toBe('number');
        expect(duration).toBeGreaterThanOrEqual(25);
      });
    });
  });

  describe('Middleware Execution & Lifecycle (Unit / Mock)', () => {
    let mockLogger;
    let loggedEvents;

    beforeEach(() => {
      loggedEvents = [];
      mockLogger = {
        debug: vi.fn((event, payload) => loggedEvents.push({ level: 'debug', event, payload })),
        info: vi.fn((event, payload) => loggedEvents.push({ level: 'info', event, payload })),
        warn: vi.fn((event, payload) => loggedEvents.push({ level: 'warn', event, payload })),
        error: vi.fn((event, payload) => loggedEvents.push({ level: 'error', event, payload }))
      };
    });

    it('logs http.request.completed with canonical fields on finish', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        id: 'test-req-101',
        method: 'GET',
        baseUrl: '/api',
        route: { path: '/items' },
        originalUrl: '/api/items'
      };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableEnded = true;

      let nextCalled = false;
      middleware(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);

      res.emit('finish');

      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      const call = loggedEvents[0];
      expect(call.level).toBe('info');
      expect(call.event).toBe('http.request.completed');
      expect(call.payload).toMatchObject({
        requestId: 'test-req-101',
        method: 'GET',
        route: '/api/items',
        statusCode: 200
      });
      expect(typeof call.payload.durationMs).toBe('number');
      expect(call.payload.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('logs 404 client errors with matching status code at warn level', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        id: 'test-404',
        method: 'GET',
        originalUrl: '/api/unknown'
      };
      const res = new EventEmitter();
      res.statusCode = 404;
      res.writableEnded = true;

      middleware(req, res, () => {});
      res.emit('finish');

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      const call = loggedEvents[0];
      expect(call.level).toBe('warn');
      expect(call.event).toBe('http.request.completed');
      expect(call.payload.statusCode).toBe(404);
      expect(call.payload.route).toBe('/api/unknown');
    });

    it('logs 500 internal errors with matching status code at error level', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        id: 'test-500',
        method: 'POST',
        baseUrl: '/api/forms',
        route: { path: '/:id' },
        originalUrl: '/api/forms/123'
      };
      const res = new EventEmitter();
      res.statusCode = 500;
      res.writableEnded = true;

      middleware(req, res, () => {});
      res.emit('finish');

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      const call = loggedEvents[0];
      expect(call.level).toBe('error');
      expect(call.event).toBe('http.request.completed');
      expect(call.payload.statusCode).toBe(500);
      expect(call.payload.route).toBe('/api/forms/:id');
    });

    it('logs http.request.aborted with statusCode 499 when connection closes prematurely', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        id: 'abort-req-1',
        method: 'GET',
        originalUrl: '/api/slow-operation'
      };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headersSent = false;
      res.writableEnded = false;
      res.finished = false;

      middleware(req, res, () => {});
      res.emit('close');

      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      const call = loggedEvents[0];
      expect(call.level).toBe('warn');
      expect(call.event).toBe('http.request.aborted');
      expect(call.payload).toMatchObject({
        requestId: 'abort-req-1',
        method: 'GET',
        statusCode: 499
      });
    });

    it('honors custom abortedStatusCode configuration', () => {
      const middleware = createHttpAccessLogger({
        logger: mockLogger,
        abortedStatusCode: 408
      });
      const req = {
        id: 'abort-req-custom',
        method: 'GET',
        originalUrl: '/api/test'
      };
      const res = new EventEmitter();
      res.writableEnded = false;
      res.finished = false;

      middleware(req, res, () => {});
      res.emit('close');

      expect(loggedEvents[0].payload.statusCode).toBe(408);
    });

    it('strictly prevents duplicate logging when both finish and close fire', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        id: 'dedup-req',
        method: 'GET',
        route: { path: '/api/test' },
        originalUrl: '/api/test'
      };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableEnded = true;

      middleware(req, res, () => {});

      // Normal order: finish then close
      res.emit('finish');
      res.emit('close');

      expect(loggedEvents).toHaveLength(1);
      expect(loggedEvents[0].event).toBe('http.request.completed');
    });

    it('strictly prevents duplicate logging when aborted close fires followed by finish', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        id: 'dedup-abort-req',
        method: 'GET',
        originalUrl: '/api/test'
      };
      const res = new EventEmitter();
      res.writableEnded = false;
      res.finished = false;

      middleware(req, res, () => {});

      // Aborted close fires first
      res.emit('close');
      // Subsequent finish attempt
      res.emit('finish');

      expect(loggedEvents).toHaveLength(1);
      expect(loggedEvents[0].event).toBe('http.request.aborted');
    });

    it('treats close event as completed if res.writableEnded is true', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        id: 'close-completed-req',
        method: 'GET',
        route: { path: '/api/test' },
        originalUrl: '/api/test'
      };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableEnded = true;

      middleware(req, res, () => {});

      // Only close fires, but writableEnded is true
      res.emit('close');

      expect(loggedEvents).toHaveLength(1);
      expect(loggedEvents[0].event).toBe('http.request.completed');
    });
  });

  describe('Health Check Logging Policy', () => {
    let mockLogger;
    let loggedEvents;

    beforeEach(() => {
      loggedEvents = [];
      mockLogger = {
        debug: vi.fn((event, payload) => loggedEvents.push({ level: 'debug', event, payload })),
        info: vi.fn((event, payload) => loggedEvents.push({ level: 'info', event, payload })),
        warn: vi.fn((event, payload) => loggedEvents.push({ level: 'warn', event, payload })),
        error: vi.fn((event, payload) => loggedEvents.push({ level: 'error', event, payload }))
      };
    });

    it('logs successful health check (200 on /health) at debug level', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        method: 'GET',
        originalUrl: '/health',
        route: { path: '/health' }
      };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableEnded = true;

      middleware(req, res, () => {});
      res.emit('finish');

      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).not.toHaveBeenCalled();
      expect(loggedEvents[0].level).toBe('debug');
      expect(loggedEvents[0].event).toBe('http.request.completed');
    });

    it('logs successful readiness probe (200 on /api/health/ready) at debug level', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        method: 'GET',
        originalUrl: '/api/health/ready',
        route: { path: '/api/health/ready' }
      };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableEnded = true;

      middleware(req, res, () => {});
      res.emit('finish');

      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
      expect(loggedEvents[0].level).toBe('debug');
    });

    it('logs degraded readiness probe (503 on /health/ready) at error level', () => {
      const middleware = createHttpAccessLogger({ logger: mockLogger });
      const req = {
        method: 'GET',
        originalUrl: '/health/ready',
        route: { path: '/health/ready' }
      };
      const res = new EventEmitter();
      res.statusCode = 503;
      res.writableEnded = true;

      middleware(req, res, () => {});
      res.emit('finish');

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(loggedEvents[0].level).toBe('error');
      expect(loggedEvents[0].payload.statusCode).toBe(503);
    });

    it('completely suppresses successful health check logs when suppressHealthSuccess is enabled', () => {
      const middleware = createHttpAccessLogger({
        logger: mockLogger,
        suppressHealthSuccess: true
      });
      const req = {
        method: 'GET',
        originalUrl: '/ready',
        route: { path: '/ready' }
      };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableEnded = true;

      middleware(req, res, () => {});
      res.emit('finish');

      expect(loggedEvents).toHaveLength(0);
    });

    it('does NOT suppress degraded health check (503) even when suppressHealthSuccess is enabled', () => {
      const middleware = createHttpAccessLogger({
        logger: mockLogger,
        suppressHealthSuccess: true
      });
      const req = {
        method: 'GET',
        originalUrl: '/ready',
        route: { path: '/ready' }
      };
      const res = new EventEmitter();
      res.statusCode = 503;
      res.writableEnded = true;

      middleware(req, res, () => {});
      res.emit('finish');

      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(loggedEvents[0].level).toBe('error');
      expect(loggedEvents[0].payload.statusCode).toBe(503);
    });
  });

  describe('Privacy & Safety Verification', () => {
    it('ensures request body, query parameters, auth headers, and cookies are never logged', async () => {
      const loggedLines = [];
      const testLogger = createLogger({
        destination: (line) => loggedLines.push(line),
        env: 'production',
        level: 'debug'
      });

      const app = express();
      app.use(express.json());
      app.use(httpAccessLogger({ logger: testLogger }));

      app.post('/api/auth/login', (req, res) => {
        res.status(200).json({ success: true, message: 'Logged in' });
      });

      const sensitivePassword = 'SuperSecretPassword99!';
      const sensitiveToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummyPayload.signaturePart';
      const sensitiveApiKey = 'sk-proj-1234567890abcdef1234567890';
      const sensitiveCookie = 'sessionToken=abcSecretSessionToken123';

      await request(app)
        .post('/api/auth/login?token=leakQueryParam&password=queryPassword')
        .set('x-request-id', 'req-privacy-check-777')
        .set('Authorization', `Bearer ${sensitiveToken}`)
        .set('Cookie', sensitiveCookie)
        .set('x-api-key', sensitiveApiKey)
        .set('User-Agent', 'TestBrowser/1.0 (PrivacyCheck)')
        .set('x-forwarded-for', '203.0.113.195')
        .send({
          email: 'testuser@example.com',
          password: sensitivePassword,
          token: sensitiveToken
        });

      expect(loggedLines).toHaveLength(1);
      const rawLog = loggedLines[0];
      const parsed = JSON.parse(rawLog);

      // Verify canonical event schema
      expect(parsed.message).toBe('http.request.completed');
      expect(parsed.context).toBeDefined();

      const contextKeys = Object.keys(parsed.context);
      expect(contextKeys).toContain('requestId');
      expect(contextKeys).toContain('method');
      expect(contextKeys).toContain('route');
      expect(contextKeys).toContain('statusCode');
      expect(contextKeys).toContain('durationMs');

      // Verify privacy invariants: strictly no sensitive fields present
      expect(parsed.context.body).toBeUndefined();
      expect(parsed.context.headers).toBeUndefined();
      expect(parsed.context.query).toBeUndefined();
      expect(parsed.context.cookies).toBeUndefined();
      expect(parsed.context.ip).toBeUndefined();
      expect(parsed.context.userAgent).toBeUndefined();
      expect(parsed.context.password).toBeUndefined();
      expect(parsed.context.email).toBeUndefined();

      // Route must not contain query parameters
      expect(parsed.context.route).toBe('/api/auth/login');
      expect(parsed.context.route).not.toContain('leakQueryParam');
      expect(parsed.context.route).not.toContain('queryPassword');

      // Raw serialized JSON must not contain leaked secrets
      expect(rawLog).not.toContain(sensitivePassword);
      expect(rawLog).not.toContain(sensitiveToken);
      expect(rawLog).not.toContain(sensitiveApiKey);
      expect(rawLog).not.toContain(sensitiveCookie);
      expect(rawLog).not.toContain('leakQueryParam');
      expect(rawLog).not.toContain('queryPassword');
      expect(rawLog).not.toContain('203.0.113.195');
      expect(rawLog).not.toContain('TestBrowser/1.0');
    });
  });

  describe('Express & Supertest Full Integration', () => {
    let app;
    let loggedEvents;
    let mockLogger;

    beforeEach(() => {
      loggedEvents = [];
      mockLogger = {
        debug: vi.fn((event, payload) => loggedEvents.push({ level: 'debug', event, payload })),
        info: vi.fn((event, payload) => loggedEvents.push({ level: 'info', event, payload })),
        warn: vi.fn((event, payload) => loggedEvents.push({ level: 'warn', event, payload })),
        error: vi.fn((event, payload) => loggedEvents.push({ level: 'error', event, payload }))
      };

      app = express();
      app.use((req, res, next) => {
        req.id = req.headers['x-request-id'] || 'auto-gen-req-1';
        next();
      });
      app.use(httpAccessLogger({ logger: mockLogger }));

      // Parameterized route router
      const formRouter = express.Router();
      formRouter.get('/:id', (req, res) => {
        res.json({ id: req.params.id, name: 'Sample Form' });
      });
      app.use('/api/forms', formRouter);

      // Health endpoints
      app.get(['/health', '/api/health'], (req, res) => {
        res.status(200).json({ status: 'live' });
      });

      app.get(['/health/ready', '/ready'], (req, res) => {
        if (req.query.degraded === 'true') {
          return res.status(503).json({ status: 'not_ready' });
        }
        res.status(200).json({ status: 'ready' });
      });

      // Error route
      app.get('/api/trigger-error', (req, res, next) => {
        const err = new Error('Database crash simulation');
        next(err);
      });

      // Error handler
      // eslint-disable-next-line no-unused-vars
      app.use((err, req, res, next) => {
        res.status(500).json({ error: 'Internal Error' });
      });
    });

    it('preserves route template /api/forms/:id for parameterized requests', async () => {
      const formId = '60f7e1234567890123456789';
      const response = await request(app)
        .get(`/api/forms/${formId}`)
        .set('x-request-id', 'req-forms-preserve');

      expect(response.status).toBe(200);
      expect(loggedEvents).toHaveLength(1);

      const event = loggedEvents[0];
      expect(event.level).toBe('info');
      expect(event.event).toBe('http.request.completed');
      expect(event.payload.route).toBe('/api/forms/:id');
      expect(event.payload.route).not.toContain(formId);
      expect(event.payload.requestId).toBe('req-forms-preserve');
      expect(event.payload.statusCode).toBe(200);
    });

    it('logs unmatched routes (404) with stripped query string', async () => {
      const response = await request(app).get('/api/does-not-exist?param=123');

      expect(response.status).toBe(404);
      expect(loggedEvents).toHaveLength(1);

      const event = loggedEvents[0];
      expect(event.level).toBe('warn');
      expect(event.event).toBe('http.request.completed');
      expect(event.payload.route).toBe('/api/does-not-exist');
      expect(event.payload.route).not.toContain('param=123');
      expect(event.payload.statusCode).toBe(404);
    });

    it('logs unhandled 500 errors with status 500 at error level', async () => {
      const response = await request(app).get('/api/trigger-error');

      expect(response.status).toBe(500);
      expect(loggedEvents).toHaveLength(1);

      const event = loggedEvents[0];
      expect(event.level).toBe('error');
      expect(event.event).toBe('http.request.completed');
      expect(event.payload.statusCode).toBe(500);
      expect(event.payload.route).toBe('/api/trigger-error');
    });

    it('logs /health at debug level', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(loggedEvents).toHaveLength(1);
      expect(loggedEvents[0].level).toBe('debug');
      expect(loggedEvents[0].payload.statusCode).toBe(200);
    });

    it('logs degraded /ready with status 503 at error level', async () => {
      const response = await request(app).get('/ready?degraded=true');

      expect(response.status).toBe(503);
      expect(loggedEvents).toHaveLength(1);
      expect(loggedEvents[0].level).toBe('error');
      expect(loggedEvents[0].payload.statusCode).toBe(503);
    });
  });

  describe('Real Socket Premature Abort Integration', () => {
    let server;
    let port;
    let loggedEvents;
    let mockLogger;

    beforeEach(async () => {
      loggedEvents = [];
      mockLogger = {
        debug: vi.fn((event, payload) => loggedEvents.push({ level: 'debug', event, payload })),
        info: vi.fn((event, payload) => loggedEvents.push({ level: 'info', event, payload })),
        warn: vi.fn((event, payload) => loggedEvents.push({ level: 'warn', event, payload })),
        error: vi.fn((event, payload) => loggedEvents.push({ level: 'error', event, payload }))
      };

      const app = express();
      app.use(httpAccessLogger({ logger: mockLogger }));

      // Deliberately delayed handler that waits for abort
      // eslint-disable-next-line no-unused-vars
      app.get('/api/long-polling', (req, res) => {
        // Hold open indefinitely without calling res.send
      });

      server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, resolve));
      port = server.address().port;
    });

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('emits http.request.aborted with statusCode 499 when client aborts socket connection', async () => {
      await new Promise((resolve) => {
        const clientReq = http.get(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/long-polling',
            headers: { 'x-request-id': 'real-abort-123' }
          },
          () => {}
        );

        clientReq.on('error', () => {
          // Expected client socket destruction error
        });

        // Give the server a small moment to receive the request and enter the handler,
        // then immediately destroy the socket mid-flight
        setTimeout(() => {
          clientReq.destroy();
          // Give server a moment to fire 'close' on res
          setTimeout(resolve, 80);
        }, 30);
      });

      expect(loggedEvents.length).toBeGreaterThanOrEqual(1);
      const abortEvent = loggedEvents.find((e) => e.event === 'http.request.aborted');
      expect(abortEvent).toBeDefined();
      expect(abortEvent.level).toBe('warn');
      expect(abortEvent.payload.statusCode).toBe(499);
      expect(abortEvent.payload.requestId).toBe('real-abort-123');
      expect(abortEvent.payload.method).toBe('GET');

      // Ensure no completed event was fired for the aborted request
      const completedEvents = loggedEvents.filter((e) => e.event === 'http.request.completed');
      expect(completedEvents).toHaveLength(0);
    });
  });

  describe('Export & Middleware Usage Patterns', () => {
    it('supports direct middleware registration: app.use(httpAccessLogger)', async () => {
      const app = express();
      app.use(httpAccessLogger);
      app.get('/ping', (req, res) => res.send('pong'));

      const response = await request(app).get('/ping');
      expect(response.status).toBe(200);
      expect(response.text).toBe('pong');
    });

    it('supports factory registration with options: app.use(httpAccessLogger(options))', async () => {
      const mockLogger = {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      };

      const app = express();
      app.use(httpAccessLogger({ logger: mockLogger }));
      app.get('/ping', (req, res) => res.send('pong'));

      const response = await request(app).get('/ping');
      expect(response.status).toBe(200);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info.mock.calls[0][0]).toBe('http.request.completed');
    });
  });
});
