import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { logger } from '../utils/logger.js';

class OpenAIProvider {
  constructor() {
    this.client = null;
    this.model = 'gpt-4o-mini';
    this.timeout = 30000;
    this.maxInputSize = 10000;
  }

  initialize() {
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.timeout = parseInt(process.env.AI_TIMEOUT, 10) || 30000;
    this.maxInputSize = parseInt(process.env.AI_MAX_INPUT_SIZE, 10) || 10000;

    if (!process.env.OPENAI_API_KEY) {
      logger.warn('ai.provider_disabled', {
        message: 'OpenAI API key not found - AI features will be disabled'
      });
      return;
    }

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: this.timeout
    });
    logger.info('ai.provider_initialized', { model: this.model });
  }

  async generateStructured({ systemPrompt, userPrompt, schema, schemaName }) {
    if (!this.client) {
      this.initialize();
      if (!this.client) {
        throw new Error('AI_PROVIDER_NOT_CONFIGURED');
      }
    }

    if (userPrompt.length > this.maxInputSize || systemPrompt.length > this.maxInputSize) {
      throw new Error('AI_INPUT_TOO_LARGE');
    }

    try {
      const startTime = Date.now();
      const completion = await this.client.beta.chat.completions.parse({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: zodResponseFormat(schema, schemaName),
        temperature: 0.7
      });

      const duration = Date.now() - startTime;
      logger.info('ai.generation_completed', { model: this.model, durationMs: duration });

      if (completion.choices[0].message.refusal) {
        throw new Error('AI_PROVIDER_REFUSAL');
      }

      return completion.choices[0].message.parsed;
    } catch (error) {
      this.handleError(error);
    }
  }

  handleError(error) {
    // Log safe error details
    logger.error('ai.generation_failed', error, { model: this.model });

    if (error.message === 'AI_PROVIDER_REFUSAL' || error.message === 'AI_INPUT_TOO_LARGE') {
      throw error;
    }

    if (error instanceof OpenAI.APIError) {
      if (error.status === 429) {
        throw new Error('AI_RATE_LIMIT_EXCEEDED');
      }
      if (error.status === 401 || error.status === 403) {
        throw new Error('AI_AUTH_FAILED');
      }
      if (error.status >= 500) {
        throw new Error('AI_PROVIDER_UNAVAILABLE');
      }
    }

    if (error.type === 'timeout' || error.code === 'ETIMEDOUT') {
      throw new Error('AI_TIMEOUT');
    }

    if (error.name === 'LengthException') {
      throw new Error('AI_INCOMPLETE_RESPONSE');
    }

    if (error.name === 'ZodError') {
      throw new Error('AI_SCHEMA_VALIDATION_FAILED');
    }

    throw new Error('AI_UNEXPECTED_ERROR');
  }
}

const provider = new OpenAIProvider();
// Export the initialized instance
export default provider;
