import { describe, it, expect } from 'vitest';
import {
  validatePassword,
  isCommonPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  COMMON_PASSWORDS
} from './passwordPolicy.js';

describe('Password Policy Utility', () => {
  describe('Constants', () => {
    it('exports expected policy boundaries', () => {
      expect(MIN_PASSWORD_LENGTH).toBe(10);
      expect(MAX_PASSWORD_BYTES).toBe(72);
      expect(COMMON_PASSWORDS.length).toBeGreaterThan(15);
    });
  });

  describe('validatePassword - Invalid inputs and type checks', () => {
    it('rejects null input', () => {
      const result = validatePassword(null);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password is required');
    });

    it('rejects undefined input', () => {
      const result = validatePassword(undefined);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password is required');
    });

    it('rejects empty string input', () => {
      const result = validatePassword('');
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password is required');
    });

    it('rejects non-string input (number)', () => {
      const result = validatePassword(1234567890);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password must be a string');
    });

    it('rejects non-string input (object)', () => {
      const result = validatePassword({ pass: 'validpassword10' });
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password must be a string');
    });

    it('rejects non-string input (array)', () => {
      const result = validatePassword(['password123']);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password must be a string');
    });
  });

  describe('validatePassword - Length constraints', () => {
    it('rejects passwords shorter than 10 characters (9 characters)', () => {
      const result = validatePassword('123456789');
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password must be at least 10 characters');
    });

    it('rejects nine ASCII characters', () => {
      const result = validatePassword('abcdefghi');
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password must be at least 10 characters');
    });

    it('accepts passwords with exactly 10 characters', () => {
      const result = validatePassword('validPass!');
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });

    it('accepts ten ASCII characters', () => {
      const result = validatePassword('abcdefghij');
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });

    it('accepts passwords with exactly 72 UTF-8 bytes (ASCII)', () => {
      const exactly72Bytes = 'a'.repeat(72);
      expect(Buffer.byteLength(exactly72Bytes, 'utf8')).toBe(72);
      const result = validatePassword(exactly72Bytes);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });

    it('rejects passwords exceeding 72 UTF-8 bytes (73 ASCII characters)', () => {
      const exactly73Bytes = 'a'.repeat(73);
      expect(Buffer.byteLength(exactly73Bytes, 'utf8')).toBe(73);
      const result = validatePassword(exactly73Bytes);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password exceeds maximum length of 72 bytes');
    });
  });

  describe('validatePassword - Unicode and Multibyte handling', () => {
    it('rejects five emoji because they represent five Unicode code points', () => {
      // '🔒' is 1 Unicode code point, 2 UTF-16 code units, and 4 UTF-8 bytes.
      // Five emoji have [...password].length === 5 (< 10 code points), but password.length === 10.
      const fiveEmoji = '🔒'.repeat(5);
      expect([...fiveEmoji].length).toBe(5);
      expect(fiveEmoji.length).toBe(10);

      const result = validatePassword(fiveEmoji);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password must be at least 10 characters');
    });

    it('accepts ten emoji because they represent ten Unicode code points and remain below 72 UTF-8 bytes', () => {
      // Ten emoji have [...password].length === 10 and Buffer.byteLength === 40 (<= 72 bytes)
      const tenEmoji = '🔒'.repeat(10);
      expect([...tenEmoji].length).toBe(10);
      expect(Buffer.byteLength(tenEmoji, 'utf8')).toBe(40);

      const result = validatePassword(tenEmoji);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });

    it('accepts ten CJK characters', () => {
      // Ten Chinese characters represent 10 Unicode code points and 30 UTF-8 bytes
      const tenCjk = '你好世界测试安全密码';
      expect([...tenCjk].length).toBe(10);
      expect(Buffer.byteLength(tenCjk, 'utf8')).toBe(30);

      const result = validatePassword(tenCjk);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });

    it('rejects a password with ten or more Unicode code points but more than 72 UTF-8 bytes', () => {
      // 19 emojis = 19 Unicode code points (>= 10), but 19 * 4 = 76 UTF-8 bytes (> 72 bytes)
      const longEmoji = '🔒'.repeat(19);
      expect([...longEmoji].length).toBe(19);
      expect(Buffer.byteLength(longEmoji, 'utf8')).toBe(76);

      const result = validatePassword(longEmoji);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password exceeds maximum length of 72 bytes');
    });

    it('rejects a password with ten compound emoji that exceed 72 UTF-8 bytes', () => {
      // Compound emoji like '👨‍👩‍👧‍👦' contain multiple code points and exceed 72 bytes for 10 units
      const tenCompoundEmoji = '👨‍👩‍👧‍👦'.repeat(10);
      expect([...tenCompoundEmoji].length).toBeGreaterThanOrEqual(10);
      expect(Buffer.byteLength(tenCompoundEmoji, 'utf8')).toBeGreaterThan(72);

      const result = validatePassword(tenCompoundEmoji);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password exceeds maximum length of 72 bytes');
    });

    it('evaluates byte length rather than UTF-16 code units for multibyte characters', () => {
      // 🔒 is 4 UTF-8 bytes, length 2 in JS string
      // 19 emojis = 19 * 4 = 76 UTF-8 bytes, but string.length is 38
      const emojiPassword = '🔒'.repeat(19);
      expect(emojiPassword.length).toBe(38);
      expect(Buffer.byteLength(emojiPassword, 'utf8')).toBe(76);

      const result = validatePassword(emojiPassword);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password exceeds maximum length of 72 bytes');
    });

    it('accepts multibyte passwords within the 72 UTF-8 byte boundary', () => {
      // 10 emojis = 10 * 4 = 40 UTF-8 bytes, string.length 20
      const emojiPassword = '🔒'.repeat(10);
      expect(Buffer.byteLength(emojiPassword, 'utf8')).toBe(40);

      const result = validatePassword(emojiPassword);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });

    it('accepts 3-byte CJK character passwords within byte boundary and >= 10 characters', () => {
      // 10 Chinese characters: 10 * 3 = 30 UTF-8 bytes, length 10
      const cjkPassword = '你好世界测试安全密码';
      expect(cjkPassword.length).toBe(10);
      expect(Buffer.byteLength(cjkPassword, 'utf8')).toBe(30);

      const result = validatePassword(cjkPassword);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });

    it('preserves leading, trailing, and internal spaces without trimming or mutating', () => {
      const spacedPassword = '  valid pass  ';
      expect([...spacedPassword].length).toBe(14);
      expect(spacedPassword.startsWith('  ')).toBe(true);
      expect(spacedPassword.endsWith('  ')).toBe(true);

      const result = validatePassword(spacedPassword);
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');

      // Verify an untrimmed 9-character string with spaces is rejected based on raw length
      const shortSpaced = '  short  ';
      expect([...shortSpaced].length).toBe(9);
      const shortResult = validatePassword(shortSpaced);
      expect(shortResult.valid).toBe(false);
      expect(shortResult.message).toBe('Password must be at least 10 characters');
    });
  });

  describe('validatePassword and isCommonPassword - Blocklist checks', () => {
    it('rejects sequential digits on blocklist', () => {
      const result = validatePassword('1234567890');
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password is too common or easily guessed');
    });

    it('rejects keyboard walks on blocklist', () => {
      const result = validatePassword('qwertyuiop');
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password is too common or easily guessed');
    });

    it('rejects common dictionary phrases on blocklist', () => {
      const result = validatePassword('administrator');
      expect(result.valid).toBe(false);
      expect(result.message).toBe('Password is too common or easily guessed');
    });

    it('rejects common default credentials with mixed case (case-insensitive check)', () => {
      expect(validatePassword('Administrator').valid).toBe(false);
      expect(validatePassword('QWERTYUIOP').valid).toBe(false);
      expect(validatePassword('ChangeMe123').valid).toBe(false);
      expect(validatePassword('Welcome2026').valid).toBe(false);
    });

    it('isCommonPassword correctly detects blocklist items and rejects non-strings safely', () => {
      expect(isCommonPassword('1234567890')).toBe(true);
      expect(isCommonPassword('ADMINISTRATOR')).toBe(true);
      expect(isCommonPassword('randomSecurePassword123!')).toBe(false);
      expect(isCommonPassword(null)).toBe(false);
      expect(isCommonPassword(undefined)).toBe(false);
      expect(isCommonPassword(1234567890)).toBe(false);
    });
  });

  describe('validatePassword - Valid non-common passwords', () => {
    it('accepts valid complex passwords', () => {
      const result = validatePassword('C0mpl3x_P@ssw0rd!');
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });

    it('accepts standard testing password password123 for backward compatibility', () => {
      const result = validatePassword('password123');
      expect(result.valid).toBe(true);
      expect(result.message).toBe('Password meets policy requirements');
    });
  });
});
