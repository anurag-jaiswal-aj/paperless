import { describe, it, expect } from 'vitest';
import { isValidEmail, sanitizeInput } from './helpers.js';

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
});
