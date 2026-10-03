import { describe, it, expect, vi, beforeEach } from 'vitest';
import AIService from './AIService.js';
import aiProvider from './OpenAIProvider.js';
import OpenAI from 'openai';

// Mock OpenAIProvider explicitly for some tests, but let's mock OpenAI client inside aiProvider
vi.mock('openai');
vi.mock('openai/helpers/zod', () => ({
  zodResponseFormat: vi.fn().mockImplementation((schema) => ({ type: 'json_schema', schema }))
}));

describe('AI Platform Foundation', () => {
  let mockCreate;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';

    mockCreate = vi.fn();

    // Setup OpenAI mock constructor to return mock client
    OpenAI.mockImplementation(function() {
      this.beta = {
        chat: {
          completions: {
            parse: mockCreate
          }
        }
      };
    });

    // Make sure APIError is available for instanceof checks
    OpenAI.APIError = class APIError extends Error {
      constructor(status, data, message, headers) {
        super(message);
        this.status = status;
        this.data = data;
        this.headers = headers;
        this.name = 'APIError';
      }
    };

    aiProvider.client = null; // reset initialized client
    aiProvider.initialize(); // force re-init with mocked OpenAI
  });

  describe('Configuration & Initialization', () => {
    it('initializes safely when API key is present', () => {
      aiProvider.client = null;
      process.env.OPENAI_API_KEY = 'valid-key';
      process.env.OPENAI_MODEL = 'custom-model';
      process.env.AI_TIMEOUT = '15000';
      aiProvider.initialize();

      expect(aiProvider.client).toBeDefined();
      expect(aiProvider.model).toBe('custom-model');
      expect(aiProvider.timeout).toBe(15000);
    });

    it('does not initialize if API key is missing', () => {
      aiProvider.client = null;
      delete process.env.OPENAI_API_KEY;
      aiProvider.initialize();
      expect(aiProvider.client).toBeNull();
    });
  });

  describe('OpenAI Provider', () => {
    it('successfully returns parsed structured generation', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          { message: { parsed: { test: 'value' }, refusal: null } }
        ]
      });

      const result = await aiProvider.generateStructured({
        systemPrompt: 'sys',
        userPrompt: 'user',
        schema: {}, // mocked
        schemaName: 'test'
      });

      expect(result).toEqual({ test: 'value' });
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
        model: expect.any(String),
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'user' }
        ]
      }));
    });

    it('throws error if input is too large', async () => {
      aiProvider.maxInputSize = 10;
      await expect(
        aiProvider.generateStructured({
          systemPrompt: 'sys',
          userPrompt: 'this is way too large',
          schema: {},
          schemaName: 'test'
        })
      ).rejects.toThrow('AI_INPUT_TOO_LARGE');
    });

    it('throws AI_PROVIDER_REFUSAL if model refuses to answer', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          { message: { parsed: null, refusal: 'I cannot answer that.' } }
        ]
      });

      await expect(
        aiProvider.generateStructured({
          systemPrompt: 'sys',
          userPrompt: 'user',
          schema: {},
          schemaName: 'test'
        })
      ).rejects.toThrow('AI_PROVIDER_REFUSAL');
    });

    it('normalizes 429 rate limit errors safely', async () => {
      const error = new OpenAI.APIError(429, {}, 'Rate limit exceeded', {});
      error.status = 429;
      mockCreate.mockRejectedValue(error);

      await expect(
        aiProvider.generateStructured({
          systemPrompt: 'sys',
          userPrompt: 'user',
          schema: {},
          schemaName: 'test'
        })
      ).rejects.toThrow('AI_RATE_LIMIT_EXCEEDED');
    });

    it('normalizes LengthException as incomplete response', async () => {
      const error = new Error('Length exception');
      error.name = 'LengthException';
      mockCreate.mockRejectedValue(error);

      await expect(
        aiProvider.generateStructured({
          systemPrompt: 'sys',
          userPrompt: 'user',
          schema: {},
          schemaName: 'test'
        })
      ).rejects.toThrow('AI_INCOMPLETE_RESPONSE');
    });

    it('normalizes timeout errors', async () => {
      const error = new Error('Timeout');
      error.type = 'timeout';
      mockCreate.mockRejectedValue(error);

      await expect(
        aiProvider.generateStructured({
          systemPrompt: 'sys',
          userPrompt: 'user',
          schema: {},
          schemaName: 'test'
        })
      ).rejects.toThrow('AI_TIMEOUT');
    });
  });

  describe('AIService Abstraction', () => {
    it('suggests questions via structured schema', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              parsed: {
                questions: [{ type: 'short_text', label: 'What?' }]
              },
              refusal: null
            }
          }
        ]
      });

      const questions = await AIService.generateQuestions({ topic: 'Cars' });
      expect(questions.length).toBe(1);
      expect(questions[0].label).toBe('What?');
    });

    it('handles validation failure via zod safely in provider', async () => {
      const error = new Error('ZodError');
      error.name = 'ZodError';
      mockCreate.mockRejectedValue(error);

      await expect(AIService.generateQuestions({ topic: 'Cars' })).rejects.toThrow('AI_SCHEMA_VALIDATION_FAILED');
    });
  });

  describe('Phase 7: Response Intelligence Methods', () => {
    it('summarizeResponses', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { parsed: { overview: 'Test', keyInsights: [], caveats: [] }, refusal: null } }]
      });
      const res = await AIService.summarizeResponses([]);
      expect(res.overview).toBe('Test');
    });

    it('extractThemes', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { parsed: { themes: [{ name: 'Theme', description: '', supportingResponses: [], sentiment: 'neutral' }] }, refusal: null } }]
      });
      const res = await AIService.extractThemes([]);
      expect(res.themes[0].name).toBe('Theme');
    });

    it('categorizeResponses', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { parsed: { categories: [{ name: 'Cat', description: '', responseIndexes: [0] }], uncategorizedResponseIndexes: [] }, refusal: null } }]
      });
      const res = await AIService.categorizeResponses({ dataset: [] });
      expect(res.categories[0].name).toBe('Cat');
    });
  });
});
