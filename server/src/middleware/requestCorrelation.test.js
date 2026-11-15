import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import EventEmitter from 'node:events';
import {
  requestCorrelation,
  requestCorrelationMiddleware,
  getRequestContext,
  getRequestId,
  getRequestLogger,
  runWithRequestContext,
  bindRequestContext,
  asyncLocalStorage
} from './requestCorrelation.js';

// RFC 4122 v4 UUID regex validator
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Request Correlation Middleware and Context Manager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Core Middleware Behavior', () => {
    it('should generate a valid RFC 4122 v4 UUID on req.id and req.requestId', () => {
      const req = { headers: {} };
      const res = { setHeader: vi.fn(), headersSent: false };
      const next = vi.fn();

      requestCorrelation(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(typeof req.id).toBe('string');
      expect(req.id).toMatch(UUID_V4_REGEX);
      expect(req.requestId).toBe(req.id);
    });

    it('should export requestCorrelationMiddleware as an alias', () => {
      expect(requestCorrelationMiddleware).toBe(requestCorrelation);
    });

    it('should export the underlying AsyncLocalStorage instance', () => {
      expect(asyncLocalStorage).toBeDefined();
      expect(typeof asyncLocalStorage.run).toBe('function');
      expect(typeof asyncLocalStorage.getStore).toBe('function');
    });

    it('should set X-Request-ID response header matching req.id', () => {
      const req = { headers: {} };
      const res = { setHeader: vi.fn(), headersSent: false };
      const next = vi.fn();

      requestCorrelation(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.id);
    });

    it('should NOT trust client-supplied X-Request-ID and should overwrite it with server UUID', () => {
      const clientUntrustedId = 'client-spoofed-uuid-9999';
      const req = {
        headers: {
          'x-request-id': clientUntrustedId
        }
      };
      const res = { setHeader: vi.fn(), headersSent: false };

      let capturedStore = null;
      requestCorrelation(req, res, () => {
        capturedStore = getRequestContext();
      });

      // req.id must be a fresh server UUID, never the client value
      expect(req.id).not.toBe(clientUntrustedId);
      expect(req.id).toMatch(UUID_V4_REGEX);
      expect(req.requestId).toBe(req.id);

      // Response header must receive the authoritative server UUID
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.id);

      // req.headers['x-request-id'] must be overwritten
      expect(req.headers['x-request-id']).toBe(req.id);

      // Context stores the untrusted client ID safely for diagnostic tracing
      expect(capturedStore).toBeDefined();
      expect(capturedStore.requestId).toBe(req.id);
      expect(capturedStore.clientRequestId).toBe(clientUntrustedId);
    });

    it('should overwrite uppercase and mixed-case client header variants', () => {
      const clientUntrustedId = 'client-injected-header-variant';
      const req = {
        headers: {
          'X-Request-ID': clientUntrustedId
        }
      };
      const res = { setHeader: vi.fn(), headersSent: false };

      let capturedStore = null;
      requestCorrelation(req, res, () => {
        capturedStore = getRequestContext();
      });

      expect(req.id).not.toBe(clientUntrustedId);
      expect(req.id).toMatch(UUID_V4_REGEX);
      expect(req.headers['x-request-id']).toBe(req.id);
      expect(req.headers['X-Request-ID']).toBeUndefined();
      expect(capturedStore.clientRequestId).toBe(clientUntrustedId);
    });

    it('should handle array header formats safely', () => {
      const req = {
        headers: {
          'x-request-id': ['untrusted-first', 'untrusted-second']
        }
      };
      const res = { setHeader: vi.fn(), headersSent: false };

      let capturedStore = null;
      requestCorrelation(req, res, () => {
        capturedStore = getRequestContext();
      });

      expect(req.id).toMatch(UUID_V4_REGEX);
      expect(capturedStore.clientRequestId).toBe('untrusted-first');
    });

    it('should generate distinct UUIDs for consecutive requests', () => {
      const generatedIds = new Set();
      const count = 100;

      for (let i = 0; i < count; i++) {
        const req = { headers: {} };
        const res = { setHeader: vi.fn() };
        requestCorrelation(req, res, () => {});
        generatedIds.add(req.id);
      }

      expect(generatedIds.size).toBe(count);
    });

    it('should attach request logger to req.log and req.logger', () => {
      const req = { headers: {} };
      const res = { setHeader: vi.fn() };

      requestCorrelation(req, res, () => {});

      expect(req.log).toBeDefined();
      expect(req.logger).toBeDefined();
      expect(typeof req.logger.info).toBe('function');
      expect(typeof req.logger.error).toBe('function');
      expect(req.log).toBe(req.logger);
    });
  });

  describe('Accessor Functions (getRequestId, getRequestContext, getRequestLogger)', () => {
    it('should return null outside request context without throwing', () => {
      expect(() => getRequestId()).not.toThrow();
      expect(() => getRequestContext()).not.toThrow();
      expect(getRequestId()).toBeNull();
      expect(getRequestContext()).toBeNull();
    });

    it('should return root logger outside request context without throwing', () => {
      expect(() => getRequestLogger()).not.toThrow();
      const rootLogger = getRequestLogger();
      expect(rootLogger).toBeDefined();
      expect(typeof rootLogger.info).toBe('function');
    });

    it('should return active requestId and context inside request execution', () => {
      const req = { headers: {} };
      const res = { setHeader: vi.fn() };

      let insideId = null;
      let insideContext = null;
      let insideLogger = null;

      requestCorrelation(req, res, () => {
        insideId = getRequestId();
        insideContext = getRequestContext();
        insideLogger = getRequestLogger();
      });

      expect(insideId).toBe(req.id);
      expect(insideContext).toBeDefined();
      expect(insideContext.requestId).toBe(req.id);
      expect(insideLogger).toBe(req.logger);

      // Context must be cleanly restored to null outside
      expect(getRequestId()).toBeNull();
      expect(getRequestContext()).toBeNull();
    });
  });

  describe('runWithRequestContext Helper', () => {
    it('should execute a function within a specified context object', () => {
      const customContext = {
        requestId: 'custom-job-1234',
        jobType: 'cleanup'
      };

      const result = runWithRequestContext(customContext, () => {
        expect(getRequestId()).toBe('custom-job-1234');
        const ctx = getRequestContext();
        expect(ctx.jobType).toBe('cleanup');
        return 'executed-result';
      });

      expect(result).toBe('executed-result');
      expect(getRequestId()).toBeNull();
    });

    it('should execute a function when context is passed as a string requestId', () => {
      const result = runWithRequestContext('string-job-id-5678', () => {
        expect(getRequestId()).toBe('string-job-id-5678');
        return 42;
      });

      expect(result).toBe(42);
      expect(getRequestId()).toBeNull();
    });

    it('should generate a fresh UUID when runWithRequestContext is called with empty or null context', () => {
      let generatedId = null;

      runWithRequestContext(null, () => {
        generatedId = getRequestId();
        expect(generatedId).toMatch(UUID_V4_REGEX);
      });

      expect(generatedId).not.toBeNull();
      expect(getRequestId()).toBeNull();
    });

    it('should support asynchronous functions and return promises', async () => {
      const asyncResult = await runWithRequestContext('async-job-id', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getRequestId()).toBe('async-job-id');
        return 'async-done';
      });

      expect(asyncResult).toBe('async-done');
      expect(getRequestId()).toBeNull();
    });
  });

  describe('Concurrency & Context Isolation', () => {
    it('should maintain completely isolated contexts across concurrent asynchronous requests without crosstalk', async () => {
      const concurrencyLevel = 50;
      const tasks = [];

      for (let i = 0; i < concurrencyLevel; i++) {
        tasks.push(
          new Promise((resolve) => {
            const req = { headers: {} };
            const res = { setHeader: vi.fn() };

            requestCorrelation(req, res, async () => {
              const startId = getRequestId();
              expect(startId).toBe(req.id);

              // Simulate unpredictable asynchronous processing delay
              const delayMs = Math.floor(Math.random() * 25) + 5;
              await new Promise((r) => setTimeout(r, delayMs));

              const endId = getRequestId();
              const endContext = getRequestContext();

              resolve({
                initialReqId: req.id,
                startId,
                endId,
                storeRequestId: endContext?.requestId
              });
            });
          })
        );
      }

      const results = await Promise.all(tasks);
      const uniqueIds = new Set();

      for (const res of results) {
        expect(res.startId).toBe(res.initialReqId);
        expect(res.endId).toBe(res.initialReqId);
        expect(res.storeRequestId).toBe(res.initialReqId);
        uniqueIds.add(res.initialReqId);
      }

      expect(uniqueIds.size).toBe(concurrencyLevel);
    });
  });

  describe('Nested Asynchronous Operations and Event Listeners', () => {
    it('should retain context across Promise microtasks, setTimeout, setImmediate, and nextTick', async () => {
      const req = { headers: {} };
      const res = { setHeader: vi.fn() };

      await new Promise((resolve) => {
        requestCorrelation(req, res, async () => {
          const expectedId = req.id;

          // 1. Promise microtask
          await Promise.resolve().then(() => {
            expect(getRequestId()).toBe(expectedId);
          });

          // 2. process.nextTick
          await new Promise((tickResolve) => {
            process.nextTick(() => {
              expect(getRequestId()).toBe(expectedId);
              tickResolve();
            });
          });

          // 3. setImmediate
          await new Promise((immediateResolve) => {
            setImmediate(() => {
              expect(getRequestId()).toBe(expectedId);
              immediateResolve();
            });
          });

          // 4. setTimeout macrotask
          await new Promise((timerResolve) => {
            setTimeout(() => {
              expect(getRequestId()).toBe(expectedId);
              timerResolve();
            }, 10);
          });

          // 5. Deeply nested async chains
          const nestedResult = await (async () => {
            await new Promise((r) => setTimeout(r, 5));
            return await (async () => {
              await Promise.resolve();
              return getRequestId();
            })();
          })();

          expect(nestedResult).toBe(expectedId);
          resolve();
        });
      });
    });

    it('should preserve context in EventEmitter listeners registered on req and res', async () => {
      const req = new EventEmitter();
      req.headers = {};
      const res = new EventEmitter();
      res.setHeader = vi.fn();

      let finishContextId = null;
      let closeContextId = null;

      await new Promise((resolve) => {
        requestCorrelation(req, res, () => {
          res.on('finish', () => {
            finishContextId = getRequestId();
          });

          res.once('close', () => {
            closeContextId = getRequestId();
          });

          resolve();
        });
      });

      // Emit outside of the original synchronous middleware stack
      res.emit('finish');
      res.emit('close');

      expect(finishContextId).toBe(req.id);
      expect(closeContextId).toBe(req.id);
    });

    it('should support listener removal on wrapped emitters', () => {
      const res = new EventEmitter();
      res.setHeader = vi.fn();
      const req = { headers: {} };

      const myListener = vi.fn();

      requestCorrelation(req, res, () => {
        res.on('data', myListener);
        expect(res.listenerCount('data')).toBe(1);

        res.removeListener('data', myListener);
        expect(res.listenerCount('data')).toBe(0);
      });
    });

    it('should allow binding arbitrary callbacks via bindRequestContext', async () => {
      let customBoundCallback = null;
      let expectedId = null;

      const req = { headers: {} };
      const res = { setHeader: vi.fn() };

      requestCorrelation(req, res, () => {
        expectedId = req.id;
        customBoundCallback = bindRequestContext(() => {
          return getRequestId();
        });
      });

      // Execute customBoundCallback outside of the request stack
      expect(getRequestId()).toBeNull();
      const capturedId = customBoundCallback();
      expect(capturedId).toBe(expectedId);
    });
  });

  describe('Error Propagation and Context Cleanup', () => {
    it('should clean up context and propagate synchronous errors thrown in next()', () => {
      const req = { headers: {} };
      const res = { setHeader: vi.fn() };
      const testError = new Error('Synchronous route failure');

      expect(() => {
        requestCorrelation(req, res, () => {
          expect(getRequestId()).toBe(req.id);
          throw testError;
        });
      }).toThrow('Synchronous route failure');

      // Context must be clean outside the thrown exception
      expect(getRequestId()).toBeNull();
      expect(getRequestContext()).toBeNull();
    });

    it('should clean up context when an async function rejects inside runWithRequestContext', async () => {
      const testError = new Error('Async failure');

      await expect(
        runWithRequestContext('error-context-id', async () => {
          expect(getRequestId()).toBe('error-context-id');
          await new Promise((r) => setTimeout(r, 5));
          throw testError;
        })
      ).rejects.toThrow('Async failure');

      expect(getRequestId()).toBeNull();
      expect(getRequestContext()).toBeNull();
    });
  });

  describe('Defensive Edge Cases', () => {
    it('should handle missing or minimal req/res objects without throwing', () => {
      const next = vi.fn();

      expect(() => {
        requestCorrelation(null, null, next);
      }).not.toThrow();
      expect(next).toHaveBeenCalled();

      const next2 = vi.fn();
      expect(() => {
        requestCorrelation({}, {}, next2);
      }).not.toThrow();
      expect(next2).toHaveBeenCalled();
    });

    it('should not throw if res.setHeader fails or headers are already sent', () => {
      const req = { headers: {} };
      const res = {
        headersSent: true,
        setHeader: vi.fn(() => {
          throw new Error('Cannot set headers after they are sent');
        })
      };

      expect(() => {
        requestCorrelation(req, res, () => {});
      }).not.toThrow();
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('should safely return original function if bindRequestContext is called with non-function', () => {
      expect(bindRequestContext(null)).toBeNull();
      expect(bindRequestContext('not-a-fn')).toBe('not-a-fn');
    });
  });

  describe('Full Express HTTP Integration with Supertest', () => {
    it('should process concurrent HTTP requests with distinct UUIDs and correct headers', async () => {
      const app = express();
      app.use(requestCorrelation);

      app.get('/api/test/:num', async (req, res) => {
        const idAtStart = getRequestId();
        const clientHeader = req.headers['x-request-id'];

        // Simulate random DB/service latency
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20) + 5));

        const idAtEnd = getRequestId();

        res.json({
          num: req.params.num,
          idAtStart,
          idAtEnd,
          reqIdProp: req.id,
          headerInReq: clientHeader,
          matches: idAtStart === idAtEnd && idAtStart === req.id
        });
      });

      // Send 25 concurrent requests, some with spoofed client headers
      const totalRequests = 25;
      const server = app.listen(0);
      const agent = supertest(server);

      try {
        const requestPromises = Array.from({ length: totalRequests }, (_, i) => {
          const reqBuilder = agent.get(`/api/test/${i}`);
          if (i % 2 === 0) {
            reqBuilder.set('X-Request-ID', `spoofed-client-id-${i}`);
          }
          return reqBuilder;
        });

        const responses = await Promise.all(requestPromises);

        const seenIds = new Set();

        for (let i = 0; i < totalRequests; i++) {
          const response = responses[i];
          expect(response.status).toBe(200);

          const headerVal = response.headers['x-request-id'];
          expect(headerVal).toBeDefined();
          expect(headerVal).toMatch(UUID_V4_REGEX);

          // Never allow spoofed header through
          if (i % 2 === 0) {
            expect(headerVal).not.toBe(`spoofed-client-id-${i}`);
          }

          expect(response.body.matches).toBe(true);
          expect(response.body.idAtStart).toBe(headerVal);
          expect(response.body.reqIdProp).toBe(headerVal);
          expect(response.body.headerInReq).toBe(headerVal);

          seenIds.add(headerVal);
        }

        // All 25 requests must have distinct UUIDs
        expect(seenIds.size).toBe(totalRequests);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('should propagate request ID through Express error handling pipeline', async () => {
      const app = express();
      app.use(requestCorrelation);

      app.get('/api/error-trigger', (req, res, next) => {
        const err = new Error('Intentional route failure');
        err.statusCode = 400;
        next(err);
      });

      // Express error handler
      // eslint-disable-next-line no-unused-vars
      app.use((err, req, res, next) => {
        const activeId = getRequestId();
        res.status(err.statusCode || 500).json({
          success: false,
          error: err.message,
          requestId: activeId,
          reqId: req.id
        });
      });

      const response = await supertest(app).get('/api/error-trigger');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Intentional route failure');
      expect(response.body.requestId).toMatch(UUID_V4_REGEX);
      expect(response.body.requestId).toBe(response.body.reqId);
      expect(response.headers['x-request-id']).toBe(response.body.requestId);
    });
  });
});
