import { describe, it, expect } from 'vitest';
import { isValidEmail, sanitizeInput, sanitizeRequestUrl } from './helpers.js';

describe('helpers', () => {
  describe('isValidEmail', () => {
    it('returns true for valid emails', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user.name+tag@domain.co.uk')).toBe(true);
    });

    it('returns false for invalid emails', () => {
      expect(isValidEmail('invalid-email')).toBe(false);
      expect(isValidEmail('test@')).toBe(false);
      expect(isValidEmail('@example.com')).toBe(false);
    });
  });

  describe('sanitizeInput', () => {
    it('trims whitespace from strings', () => {
      expect(sanitizeInput('  hello  ')).toBe('hello');
    });

    it('returns non-strings unchanged', () => {
      expect(sanitizeInput(123)).toBe(123);
      expect(sanitizeInput(null)).toBe(null);
    });
  });

  describe('sanitizeRequestUrl', () => {
    it('delegates to redactionPolicy and redacts sensitive reset paths and query keys', () => {
      expect(sanitizeRequestUrl('/api/auth/resetpassword/token123?apiKey=key1')).toBe(
        '/api/auth/resetpassword/[REDACTED]?apiKey=[REDACTED]'
      );
      expect(sanitizeRequestUrl('/api/forms?page=1&limit=10')).toBe('/api/forms?page=1&limit=10');
    });
  });
});
