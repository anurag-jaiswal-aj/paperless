import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import aiRoutes, { aiLimiter } from '../routes/aiRoutes.js';
import AIService from '../services/AIService.js';
import Response from '../models/response.js';
import { buildSafeResponseDataset } from './aiController.js';
import { errorHandler } from '../middleware/errorHandler.js';

const FORM_1_ID = '507f1f77bcf86cd799439011';
const FORM_2_ID = '507f1f77bcf86cd799439012';
const DELETING_FORM_ID = '507f1f77bcf86cd799439013';
const MISSING_FORM_ID = '507f1f77bcf86cd799439099';

// Mock auth middleware to easily simulate logged in user
vi.mock('../middleware/authMiddleware.js', () => ({
  protect: (req, res, next) => {
    req.user = { _id: 'user1', id: 'user1' };
    next();
  }
}));

vi.mock('../services/AIService.js', () => {
  return {
    default: {
      generateQuestions: vi.fn(),
      improveWriting: vi.fn(),
      consultForm: vi.fn(),
      summarizeResponses: vi.fn(),
      extractThemes: vi.fn(),
      categorizeResponses: vi.fn()
    }
  };
});

vi.mock('../models/form.js', () => ({
  default: {
    findById: vi.fn().mockImplementation((id) => {
      if (id === '507f1f77bcf86cd799439011')
        return {
          _id: '507f1f77bcf86cd799439011',
          ownerId: { toString: () => 'user1' },
          title: 'Test Form'
        };
      if (id === '507f1f77bcf86cd799439012')
        return {
          _id: '507f1f77bcf86cd799439012',
          ownerId: { toString: () => 'otherUser' },
          title: 'Other Form'
        };
      if (id === '507f1f77bcf86cd799439013')
        return {
          _id: '507f1f77bcf86cd799439013',
          ownerId: { toString: () => 'user1' },
          title: 'Deleting Form',
          status: 'deleting'
        };
      return null;
    })
  }
}));

vi.mock('../models/question.js', () => ({
  default: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        {
          _id: 'q1',
          formId: '507f1f77bcf86cd799439011',
          type: 'short_text',
          label: 'Name',
          required: true
        }
      ]),
      lean: vi.fn().mockResolvedValue([
        {
          _id: 'q1',
          formId: '507f1f77bcf86cd799439011',
          type: 'short_text',
          label: 'Name',
          required: true
        }
      ])
    })
  }
}));

vi.mock('../models/response.js', () => ({
  default: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              _id: 'res1',
              formId: '507f1f77bcf86cd799439011',
              answers: [{ questionId: 'q1', value: 'John' }],
              createdAt: new Date()
            }
          ])
        })
      })
    })
  }
}));

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-request-id']) {
    req.id = req.headers['x-request-id'];
  }
  next();
});
// Apply the route which includes rate limiting and protect middlewares
app.use('/api/ai', aiRoutes);
app.use(errorHandler);

describe('AI Controller (Phase 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (aiLimiter && typeof aiLimiter.resetKey === 'function') {
      aiLimiter.resetKey('user1');
      aiLimiter.resetKey('127.0.0.1');
      aiLimiter.resetKey('::ffff:127.0.0.1');
      aiLimiter.resetKey('::1');
    }
  });

  describe('generateQuestionsHandler', () => {
    it('validates topic presence', async () => {
      const res = await request(app).post('/api/ai/questions/generate').send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Topic is required');
    });

    it('delegates to AIService and returns validated questions', async () => {
      AIService.generateQuestions.mockResolvedValue([
        { type: 'short_text', label: 'Test Q', required: false }
      ]);

      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Testing', count: 5 });

      expect(res.status).toBe(200);
      expect(res.body.data[0].label).toBe('Test Q');
      expect(AIService.generateQuestions).toHaveBeenCalledWith({
        topic: 'Testing',
        count: 5,
        audience: undefined,
        formContext: null
      });
    });

    it('filters out invalid choice questions lacking options', async () => {
      AIService.generateQuestions.mockResolvedValue([
        { type: 'single_choice', label: 'Choice Q', required: false, options: ['only one'] },
        { type: 'short_text', label: 'Text Q', required: false }
      ]);

      const res = await request(app).post('/api/ai/questions/generate').send({ topic: 'Testing' });

      expect(res.status).toBe(200);
      // The single_choice should be removed because it has < 2 options
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].type).toBe('short_text');
    });

    it('validates formId in body and rejects malformed, missing, or unauthorized forms', async () => {
      // Malformed formId
      const resBad = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Testing', formId: 'invalid-form-id' });
      expect(resBad.status).toBe(400);
      expect(resBad.body.message).toBe('Invalid resource ID');

      // Missing formId
      const resMissing = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Testing', formId: MISSING_FORM_ID });
      expect(resMissing.status).toBe(404);
      expect(resMissing.body.message).toBe('Form not found');

      // Unauthorized formId
      const resUnauth = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Testing', formId: FORM_2_ID });
      expect(resUnauth.status).toBe(403);
      expect(resUnauth.body.message).toBe('Not authorized to access this form');
    });
  });

  describe('improveWritingHandler', () => {
    it('validates text presence and type', async () => {
      let res = await request(app).post('/api/ai/writing/improve').send({});
      expect(res.status).toBe(400);

      res = await request(app)
        .post('/api/ai/writing/improve')
        .send({ text: 'Hello', contentType: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('delegates to AIService and returns improvements', async () => {
      AIService.improveWriting.mockResolvedValue({ improvedText: 'Better Q' });

      const res = await request(app)
        .post('/api/ai/writing/improve')
        .send({ text: 'Bad Q', contentType: 'question' });

      expect(res.status).toBe(200);
      expect(res.body.data.improvedText).toBe('Better Q');
    });
  });

  describe('consultantHandler', () => {
    it('rejects malformed formId route parameter with 400', async () => {
      const res = await request(app).post('/api/ai/consultant/invalid-form-id');
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid resource ID');
    });

    it('returns 404 for missing form', async () => {
      const res = await request(app).post(`/api/ai/consultant/${MISSING_FORM_ID}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 for unauthorized form', async () => {
      const res = await request(app).post(`/api/ai/consultant/${FORM_2_ID}`);
      expect(res.status).toBe(403);
    });

    it('delegates to AIService and returns recommendations', async () => {
      AIService.consultForm.mockResolvedValue({
        overallAssessment: 'Good',
        recommendations: [
          { category: 'clarity', severity: 'info', issue: 'issue', suggestion: 'fix' }
        ]
      });

      const res = await request(app).post(`/api/ai/consultant/${FORM_1_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.data.overallAssessment).toBe('Good');
      expect(res.body.data.recommendations.length).toBe(1);
    });
  });

  describe('Phase 7: Response Intelligence', () => {
    describe('buildSafeResponseDataset', () => {
      it('safely ignores invalid date filters and clamps minimum maxResponses', async () => {
        const form = { _id: FORM_1_ID, title: 'Survey' };
        const result = await buildSafeResponseDataset(form, {
          startDate: 'not-a-date',
          endDate: 'also-invalid',
          maxResponses: -5
        });

        expect(result.total).toBe(1);
        expect(Response.find).toHaveBeenCalledWith({ formId: FORM_1_ID });

        const mockSort =
          Response.find.mock.results[Response.find.mock.results.length - 1].value.sort;
        const mockLimit = mockSort.mock.results[mockSort.mock.results.length - 1].value.limit;
        expect(mockLimit).toHaveBeenCalledWith(1);
      });

      it('correctly applies valid date filters and clamps upper bound maxResponses', async () => {
        const form = { _id: FORM_1_ID, title: 'Survey' };
        const result = await buildSafeResponseDataset(form, {
          startDate: '2026-01-01',
          endDate: '2026-01-31',
          maxResponses: 2000
        });

        expect(result.total).toBe(1);
        const lastCall = Response.find.mock.calls[Response.find.mock.calls.length - 1][0];
        expect(lastCall.formId).toBe(FORM_1_ID);
        expect(lastCall.createdAt.$gte).toEqual(new Date('2026-01-01'));
        expect(lastCall.createdAt.$lte).toEqual(new Date('2026-01-31'));

        const mockSort =
          Response.find.mock.results[Response.find.mock.results.length - 1].value.sort;
        const mockLimit = mockSort.mock.results[mockSort.mock.results.length - 1].value.limit;
        expect(mockLimit).toHaveBeenCalledWith(500);
      });
    });

    describe('responseSummaryHandler', () => {
      it('returns 403 for unauthorized form', async () => {
        const res = await request(app).post(`/api/ai/responses/summary/${FORM_2_ID}`);
        expect(res.status).toBe(403);
      });

      it('delegates to AIService and returns summary', async () => {
        AIService.summarizeResponses.mockResolvedValue({ overview: 'Test Overview' });

        const res = await request(app).post(`/api/ai/responses/summary/${FORM_1_ID}`);
        expect(res.status).toBe(200);
        expect(res.body.data.overview).toBe('Test Overview');
      });
    });

    describe('responseThemesHandler', () => {
      it('returns 403 for unauthorized form', async () => {
        const res = await request(app).post(`/api/ai/responses/themes/${FORM_2_ID}`);
        expect(res.status).toBe(403);
      });

      it('delegates to AIService and returns themes', async () => {
        AIService.extractThemes.mockResolvedValue({ themes: [{ name: 'Test Theme' }] });

        const res = await request(app).post(`/api/ai/responses/themes/${FORM_1_ID}`);
        expect(res.status).toBe(200);
        expect(res.body.data.themes[0].name).toBe('Test Theme');
      });
    });

    describe('responseCategorizeHandler', () => {
      it('returns 403 for unauthorized form', async () => {
        const res = await request(app).post(`/api/ai/responses/categorize/${FORM_2_ID}`);
        expect(res.status).toBe(403);
      });

      it('delegates to AIService and returns categories', async () => {
        AIService.categorizeResponses.mockResolvedValue({
          categories: [{ name: 'Cat 1', responseIndexes: [0] }],
          uncategorizedResponseIndexes: []
        });

        const res = await request(app).post(`/api/ai/responses/categorize/${FORM_1_ID}`);
        expect(res.status).toBe(200);
        expect(res.body.data.categories[0].name).toBe('Cat 1');
      });
    });
  });

  describe('Error Handling and Rate Limiting', () => {
    it('handles AI_RATE_LIMIT_EXCEEDED gracefully', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_RATE_LIMIT_EXCEEDED'));
      const res = await request(app).post('/api/ai/questions/generate').send({ topic: 'Testing' });
      expect(res.status).toBe(429);
    });

    it('handles AI_PROVIDER_UNAVAILABLE gracefully', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_PROVIDER_UNAVAILABLE'));
      const res = await request(app).post('/api/ai/questions/generate').send({ topic: 'Testing' });
      expect(res.status).toBe(503);
    });

    it('handles AI_TIMEOUT gracefully', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_TIMEOUT'));
      const res = await request(app).post('/api/ai/questions/generate').send({ topic: 'Testing' });
      expect(res.status).toBe(503);
    });

    it('handles AI_INPUT_TOO_LARGE gracefully', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_INPUT_TOO_LARGE'));
      const res = await request(app).post('/api/ai/questions/generate').send({ topic: 'Testing' });
      expect(res.status).toBe(400);
    });

    it('handles AI_PROVIDER_REFUSAL gracefully', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_PROVIDER_REFUSAL'));
      const res = await request(app).post('/api/ai/questions/generate').send({ topic: 'Testing' });
      expect(res.status).toBe(400);
    });

    it('enforces express-rate-limit on AI routes', async () => {
      try {
        // Loop 21 times to trigger 429
        AIService.improveWriting.mockResolvedValue({ improvedText: 'test' });
        let finalStatus = 200;
        for (let i = 0; i < 21; i++) {
          const res = await request(app)
            .post('/api/ai/writing/improve')
            .send({ text: 'test', contentType: 'question' });
          finalStatus = res.status;
        }
        expect(finalStatus).toBe(429);
      } finally {
        if (aiLimiter && typeof aiLimiter.resetKey === 'function') {
          aiLimiter.resetKey('127.0.0.1');
          aiLimiter.resetKey('::ffff:127.0.0.1');
          aiLimiter.resetKey('::1');
        }
      }
    });
  });

  describe('Stage 4.3.3: Form Deleting State Guards', () => {
    it('returns 409 when generating questions targeting a deleting form', async () => {
      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Employee Feedback', formId: DELETING_FORM_ID });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Form is currently being deleted');
    });

    it('returns 409 for consultant endpoint when form is deleting', async () => {
      const res = await request(app).post(`/api/ai/consultant/${DELETING_FORM_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Form is currently being deleted');
    });

    it('returns 409 for legacy summary endpoint when form is deleting', async () => {
      const res = await request(app).post(`/api/ai/summary/${DELETING_FORM_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Form is currently being deleted');
    });

    it('returns 409 for response summary endpoint when form is deleting', async () => {
      const res = await request(app).post(`/api/ai/responses/summary/${DELETING_FORM_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Form is currently being deleted');
    });

    it('returns 409 for response themes endpoint when form is deleting', async () => {
      const res = await request(app).post(`/api/ai/responses/themes/${DELETING_FORM_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Form is currently being deleted');
    });

    it('returns 409 for response categorize endpoint when form is deleting', async () => {
      const res = await request(app).post(`/api/ai/responses/categorize/${DELETING_FORM_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Form is currently being deleted');
    });
  });

  describe('Stage 4.3.6.2: AI Provider Error Mapping & Failure Resilience Suite (6 Tests)', () => {
    it('maps AI_AUTH_FAILED to HTTP 502 with standard message', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_AUTH_FAILED'));

      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Employee Wellness' });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        success: false,
        message: 'AI provider authentication failed'
      });
    });

    it('maps AI_SCHEMA_VALIDATION_FAILED to HTTP 400 with standard message', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_SCHEMA_VALIDATION_FAILED'));

      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Employee Wellness' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        message: 'Invalid AI request or response'
      });
    });

    it('maps AI_PROVIDER_NOT_CONFIGURED to HTTP 503 with standard message', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_PROVIDER_NOT_CONFIGURED'));

      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Employee Wellness' });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        success: false,
        message: 'AI service temporarily unavailable'
      });
    });

    it('redacts sensitive credentials and raw error internals from public responses', async () => {
      const sensitiveErr = new Error('AI_AUTH_FAILED');
      sensitiveErr.apiKey = 'sk-proj-secret-key-12345';
      sensitiveErr.bearerToken = 'bearer-token-secret-xyz';
      sensitiveErr.providerConfig = { endpoint: 'https://api.openai.com/v1', key: 'secret' };
      AIService.generateQuestions.mockRejectedValue(sensitiveErr);

      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Employee Wellness' });

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe('AI provider authentication failed');
      const responseString = JSON.stringify(res.body);
      expect(responseString).not.toContain('sk-proj-secret-key-12345');
      expect(responseString).not.toContain('bearer-token-secret-xyz');
      expect(responseString).not.toContain('providerConfig');
      expect(res.body.apiKey).toBeUndefined();
      expect(res.body.bearerToken).toBeUndefined();
      expect(res.body.providerConfig).toBeUndefined();
    });

    it('preserves and propagates request correlation ID in error responses', async () => {
      AIService.generateQuestions.mockRejectedValue(new Error('AI_PROVIDER_NOT_CONFIGURED'));

      const testRequestId = 'req-ai-test-correlation-uuid-4362';
      const res = await request(app)
        .post('/api/ai/questions/generate')
        .set('X-Request-ID', testRequestId)
        .send({ topic: 'Employee Wellness' });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        success: false,
        message: 'AI service temporarily unavailable',
        requestId: testRequestId
      });
    });

    it('falls through to generic 500 error handling for unmapped unexpected provider errors without crashing', async () => {
      AIService.generateQuestions.mockRejectedValue(
        new Error('Unexpected lower-level socket hangup')
      );

      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Employee Wellness' });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBeDefined();
    });
  });
});
