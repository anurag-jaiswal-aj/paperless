import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import aiRoutes from '../routes/aiRoutes.js';
import AIService from '../services/AIService.js';
import { errorHandler } from '../middleware/errorHandler.js';

// Mock auth middleware to easily simulate logged in user
vi.mock('../middleware/authMiddleware.js', () => ({
  protect: (req, res, next) => {
    req.user = { id: 'user1' };
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
      if (id === 'form1') return { _id: 'form1', ownerId: { toString: () => 'user1' }, title: 'Test Form' };
      if (id === 'form2') return { _id: 'form2', ownerId: { toString: () => 'otherUser' }, title: 'Other Form' };
      return null;
    })
  }
}));

vi.mock('../models/question.js', () => ({
  default: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockResolvedValue([
        { _id: 'q1', formId: 'form1', type: 'short_text', label: 'Name', required: true }
      ]),
      lean: vi.fn().mockResolvedValue([
        { _id: 'q1', formId: 'form1', type: 'short_text', label: 'Name', required: true }
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
            { _id: 'res1', formId: 'form1', answers: [{ questionId: 'q1', value: 'John' }], createdAt: new Date() }
          ])
        })
      })
    })
  }
}));

const app = express();
app.use(express.json());
// Apply the route which includes rate limiting and protect middlewares
app.use('/api/ai', aiRoutes);
app.use(errorHandler);

describe('AI Controller (Phase 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateQuestionsHandler', () => {
    it('validates topic presence', async () => {
      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({});
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

      const res = await request(app)
        .post('/api/ai/questions/generate')
        .send({ topic: 'Testing' });

      expect(res.status).toBe(200);
      // The single_choice should be removed because it has < 2 options
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].type).toBe('short_text');
    });
  });

  describe('improveWritingHandler', () => {
    it('validates text presence and type', async () => {
      let res = await request(app).post('/api/ai/writing/improve').send({});
      expect(res.status).toBe(400);

      res = await request(app).post('/api/ai/writing/improve').send({ text: 'Hello', contentType: 'invalid' });
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
    it('returns 404 for missing form', async () => {
      const res = await request(app).post('/api/ai/consultant/missing-form');
      expect(res.status).toBe(404);
    });

    it('returns 403 for unauthorized form', async () => {
      const res = await request(app).post('/api/ai/consultant/form2');
      expect(res.status).toBe(403);
    });

    it('delegates to AIService and returns recommendations', async () => {
      AIService.consultForm.mockResolvedValue({
        overallAssessment: 'Good',
        recommendations: [
          { category: 'clarity', severity: 'info', issue: 'issue', suggestion: 'fix' }
        ]
      });

      const res = await request(app).post('/api/ai/consultant/form1');
      expect(res.status).toBe(200);
      expect(res.body.data.overallAssessment).toBe('Good');
      expect(res.body.data.recommendations.length).toBe(1);
    });
  });

  describe('Phase 7: Response Intelligence', () => {
    describe('responseSummaryHandler', () => {
      it('returns 403 for unauthorized form', async () => {
        const res = await request(app).post('/api/ai/responses/summary/form2');
        expect(res.status).toBe(403);
      });

      it('delegates to AIService and returns summary', async () => {
        AIService.summarizeResponses.mockResolvedValue({ overview: 'Test Overview' });

        const res = await request(app).post('/api/ai/responses/summary/form1');
        expect(res.status).toBe(200);
        expect(res.body.data.overview).toBe('Test Overview');
      });
    });

    describe('responseThemesHandler', () => {
      it('returns 403 for unauthorized form', async () => {
        const res = await request(app).post('/api/ai/responses/themes/form2');
        expect(res.status).toBe(403);
      });

      it('delegates to AIService and returns themes', async () => {
        AIService.extractThemes.mockResolvedValue({ themes: [{ name: 'Test Theme' }] });

        const res = await request(app).post('/api/ai/responses/themes/form1');
        expect(res.status).toBe(200);
        expect(res.body.data.themes[0].name).toBe('Test Theme');
      });
    });

    describe('responseCategorizeHandler', () => {
      it('returns 403 for unauthorized form', async () => {
        const res = await request(app).post('/api/ai/responses/categorize/form2');
        expect(res.status).toBe(403);
      });

      it('delegates to AIService and returns categories', async () => {
        AIService.categorizeResponses.mockResolvedValue({
          categories: [{ name: 'Cat 1', responseIndexes: [0] }],
          uncategorizedResponseIndexes: []
        });

        const res = await request(app).post('/api/ai/responses/categorize/form1');
        expect(res.status).toBe(200);
        expect(res.body.data.categories[0].name).toBe('Cat 1');
      });
    });
  });

  it('handles AIService errors gracefully', async () => {
    AIService.generateQuestions.mockRejectedValue(new Error('AI_RATE_LIMIT_EXCEEDED'));
    const res = await request(app)
      .post('/api/ai/questions/generate')
      .send({ topic: 'Testing' });

    expect(res.status).toBe(429);
  });
});
