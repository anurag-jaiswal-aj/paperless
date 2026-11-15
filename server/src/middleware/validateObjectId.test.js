import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { isValidObjectId, validateObjectId } from './validateObjectId.js';

describe('validateObjectId middleware', () => {
  describe('isValidObjectId helper', () => {
    it('accepts valid 24-character hexadecimal strings', () => {
      expect(isValidObjectId('507f1f77bcf86cd799439011')).toBe(true);
      expect(isValidObjectId('507F1F77BCF86CD799439011')).toBe(true);
      expect(isValidObjectId('000000000000000000000000')).toBe(true);
      expect(isValidObjectId('ffffffffffffffffffffffff')).toBe(true);
    });

    it('rejects invalid string lengths and non-hex characters', () => {
      expect(isValidObjectId('')).toBe(false);
      expect(isValidObjectId('507f1f77bcf86cd79943901')).toBe(false); // 23 chars
      expect(isValidObjectId('507f1f77bcf86cd7994390111')).toBe(false); // 25 chars
      expect(isValidObjectId('507f1f77bcf86cd79943901z')).toBe(false); // non-hex
      expect(isValidObjectId('not-a-valid-object-id!!')).toBe(false);
    });

    it('rejects non-string values including 12-byte numbers and objects', () => {
      expect(isValidObjectId(null)).toBe(false);
      expect(isValidObjectId(undefined)).toBe(false);
      expect(isValidObjectId(123)).toBe(false);
      expect(isValidObjectId(123456789012)).toBe(false);
      expect(isValidObjectId({})).toBe(false);
      expect(isValidObjectId([])).toBe(false);
      expect(isValidObjectId(true)).toBe(false);
      expect(isValidObjectId(Buffer.from('123456789012'))).toBe(false);
    });
  });

  describe('middleware behavior', () => {
    it('allows valid route parameter to proceed to next handler', async () => {
      const app = express();
      app.get('/test/:id', validateObjectId('id'), (req, res) => {
        res.status(200).json({ success: true, id: req.params.id });
      });

      const res = await request(app).get('/test/507f1f77bcf86cd799439011');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.id).toBe('507f1f77bcf86cd799439011');
    });

    it('rejects malformed route parameter with 400 and standard error envelope', async () => {
      const app = express();
      app.get('/test/:id', validateObjectId('id'), (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).get('/test/invalid-id-format');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid resource ID');
    });

    it('validates multiple route parameters correctly', async () => {
      const app = express();
      app.get(
        '/forms/:formId/questions/:questionId',
        validateObjectId('formId', 'questionId'),
        (req, res) => {
          res.status(200).json({ success: true });
        }
      );

      // Both valid
      const res1 = await request(app).get(
        '/forms/507f1f77bcf86cd799439011/questions/507f1f77bcf86cd799439012'
      );
      expect(res1.status).toBe(200);

      // First invalid
      const res2 = await request(app).get('/forms/bad-form-id/questions/507f1f77bcf86cd799439012');
      expect(res2.status).toBe(400);
      expect(res2.body.message).toBe('Invalid resource ID');

      // Second invalid
      const res3 = await request(app).get(
        '/forms/507f1f77bcf86cd799439011/questions/bad-question-id'
      );
      expect(res3.status).toBe(400);
      expect(res3.body.message).toBe('Invalid resource ID');
    });

    it('includes requestId in 400 response if present on request', async () => {
      const app = express();
      app.use((req, res, next) => {
        req.id = 'req-test-uuid-12345';
        next();
      });
      app.get('/test/:id', validateObjectId('id'), (req, res) => {
        res.status(200).json({ success: true });
      });

      const res = await request(app).get('/test/not-an-id');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('Invalid resource ID');
      expect(res.body.requestId).toBe('req-test-uuid-12345');
    });
  });
});
