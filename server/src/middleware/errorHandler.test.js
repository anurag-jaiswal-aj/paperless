import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { errorHandler, notFound } from './errorHandler.js';

describe('Error Handler and Not Found Middleware', () => {
  const originalEnv = process.env.NODE_ENV;
  let app;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    app = express();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    vi.restoreAllMocks();
  });

  describe('404 Not Found Middleware', () => {
    it('returns 404 status and error message in development', async () => {
      process.env.NODE_ENV = 'development';
      app.use(notFound);
      app.use(errorHandler);

      const res = await request(app).get('/api/unmapped-endpoint');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Not Found - /api/unmapped-endpoint');
      expect(res.body.stack).toBeDefined();
    });

    it('returns 404 status and error message in production without stack trace', async () => {
      process.env.NODE_ENV = 'production';
      app.use(notFound);
      app.use(errorHandler);

      const res = await request(app).get('/api/unmapped-endpoint');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Not Found - /api/unmapped-endpoint');
      expect(res.body.stack).toBeUndefined();
    });

    it('preserves res.statusCode if res.status(404) was set before next(err)', async () => {
      process.env.NODE_ENV = 'production';
      app.get('/custom-404', (req, res, next) => {
        res.status(404);
        next(new Error('Resource was not found'));
      });
      app.use(errorHandler);

      const res = await request(app).get('/custom-404');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Resource was not found');
    });
  });

  describe('Global Error Handler', () => {
    it('handles Mongoose ValidationError correctly', async () => {
      app.get('/validation-error', (req, res, next) => {
        const error = new Error('Validation failed');
        error.name = 'ValidationError';
        error.errors = {
          email: { message: 'Invalid email address' },
          name: { message: 'Name is required' }
        };
        next(error);
      });
      app.use(errorHandler);

      const res = await request(app).get('/validation-error');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Validation Error');
      expect(res.body.errors).toEqual(['Invalid email address', 'Name is required']);
    });

    it('handles Mongoose duplicate key error (11000)', async () => {
      app.get('/duplicate-error', (req, res, next) => {
        const error = new Error('Duplicate key');
        error.code = 11000;
        error.keyPattern = { email: 1 };
        next(error);
      });
      app.use(errorHandler);

      const res = await request(app).get('/duplicate-error');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('email already exists');
    });

    it('handles Mongoose CastError correctly', async () => {
      app.get('/cast-error', (req, res, next) => {
        const error = new Error('Cast failed');
        error.name = 'CastError';
        next(error);
      });
      app.use(errorHandler);

      const res = await request(app).get('/cast-error');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid resource ID');
    });

    it('handles JsonWebTokenError correctly', async () => {
      app.get('/jwt-error', (req, res, next) => {
        const error = new Error('jwt malformed');
        error.name = 'JsonWebTokenError';
        next(error);
      });
      app.use(errorHandler);

      const res = await request(app).get('/jwt-error');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid token');
    });

    it('handles TokenExpiredError correctly', async () => {
      app.get('/jwt-expired', (req, res, next) => {
        const error = new Error('jwt expired');
        error.name = 'TokenExpiredError';
        next(error);
      });
      app.use(errorHandler);

      const res = await request(app).get('/jwt-expired');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Token expired');
    });

    it('handles AI provider errors appropriately', async () => {
      app.get('/ai-rate-limit', (req, res, next) => next(new Error('AI_RATE_LIMIT_EXCEEDED')));
      app.get('/ai-unavailable', (req, res, next) => next(new Error('AI_PROVIDER_UNAVAILABLE')));
      app.get('/ai-bad-input', (req, res, next) => next(new Error('AI_INPUT_TOO_LARGE')));
      app.get('/ai-auth-fail', (req, res, next) => next(new Error('AI_AUTH_FAILED')));
      app.use(errorHandler);

      const res1 = await request(app).get('/ai-rate-limit');
      expect(res1.status).toBe(429);
      expect(res1.body.message).toBe('AI rate limit exceeded');

      const res2 = await request(app).get('/ai-unavailable');
      expect(res2.status).toBe(503);
      expect(res2.body.message).toBe('AI service temporarily unavailable');

      const res3 = await request(app).get('/ai-bad-input');
      expect(res3.status).toBe(400);
      expect(res3.body.message).toBe('Invalid AI request or response');

      const res4 = await request(app).get('/ai-auth-fail');
      expect(res4.status).toBe(502);
      expect(res4.body.message).toBe('AI provider authentication failed');
    });

    it('sanitizes unexpected 500 errors in production', async () => {
      process.env.NODE_ENV = 'production';
      app.get('/crash', () => {
        throw new Error('Database password failed: supersecret123');
      });
      app.use(errorHandler);

      const res = await request(app).get('/crash');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Internal Server Error');
      expect(res.body.stack).toBeUndefined();
    });

    it('reveals error details in development', async () => {
      process.env.NODE_ENV = 'development';
      app.get('/crash-dev', () => {
        throw new Error('Specific dev error message');
      });
      app.use(errorHandler);

      const res = await request(app).get('/crash-dev');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Specific dev error message');
      expect(res.body.stack).toBeDefined();
    });
  });
});
