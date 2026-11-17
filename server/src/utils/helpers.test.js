import { describe, it, expect } from 'vitest';
import { isValidEmail, sanitizeInput, escapeHtml, sanitizeRequestUrl } from './helpers.js';

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

  describe('escapeHtml', () => {
    it('escapes standard HTML special characters (&, <, >, ", \')', () => {
      expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(escapeHtml('Client Intake <Q1> & "Review"')).toBe(
        'Client Intake &lt;Q1&gt; &amp; &quot;Review&quot;'
      );
      expect(escapeHtml("Form 'Alpha' & 'Beta'")).toBe('Form &#39;Alpha&#39; &amp; &#39;Beta&#39;');
    });

    it('leaves ordinary strings without special characters unchanged', () => {
      expect(escapeHtml('Survey')).toBe('Survey');
      expect(escapeHtml('Normal Form Title 123')).toBe('Normal Form Title 123');
    });

    it('handles null, undefined, and non-string inputs safely', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(12345)).toBe('12345');
      expect(escapeHtml(0)).toBe('0');
      expect(escapeHtml(false)).toBe('false');
    });

    it('does not double escape when called once on text containing ampersands', () => {
      expect(escapeHtml('Q&A')).toBe('Q&amp;A');
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
