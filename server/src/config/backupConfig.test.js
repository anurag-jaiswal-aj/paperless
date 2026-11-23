import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  BACKUP_DEFAULTS,
  MIN_TOKEN_LENGTH,
  BackupConfigError,
  calculateShannonEntropy,
  validateBackupToken,
  parsePositiveInteger,
  validateBackupConfig,
  timingSafeCompareToken
} from './backupConfig.js';

describe('backupConfig', () => {
  const validHexToken64 = crypto.randomBytes(32).toString('hex'); // 64 hex chars
  const validHexToken32 = crypto.randomBytes(16).toString('hex'); // 32 hex chars

  describe('BACKUP_DEFAULTS & Immutability', () => {
    it('provides standard documented default lease timings', () => {
      expect(BACKUP_DEFAULTS.INITIAL_LEASE_MS).toBe(60000);
      expect(BACKUP_DEFAULTS.HEARTBEAT_INTERVAL_MS).toBe(10000);
      expect(BACKUP_DEFAULTS.HEARTBEAT_EXTEND_MS).toBe(30000);
      expect(BACKUP_DEFAULTS.DRAIN_TIMEOUT_MS).toBe(5000);
      expect(BACKUP_DEFAULTS.MAX_WATCHDOG_LEASE_MS).toBe(180000);
      expect(MIN_TOKEN_LENGTH).toBe(32);
    });

    it('enforces immutability on BACKUP_DEFAULTS', () => {
      expect(Object.isFrozen(BACKUP_DEFAULTS)).toBe(true);
      expect(() => {
        BACKUP_DEFAULTS.INITIAL_LEASE_MS = 12345;
      }).toThrow();
    });
  });

  describe('calculateShannonEntropy', () => {
    it('returns 0 for empty or non-string inputs', () => {
      expect(calculateShannonEntropy('')).toBe(0);
      expect(calculateShannonEntropy(null)).toBe(0);
      expect(calculateShannonEntropy(undefined)).toBe(0);
      expect(calculateShannonEntropy(12345)).toBe(0);
    });

    it('returns 0 for single-character repetitions', () => {
      expect(calculateShannonEntropy('a'.repeat(32))).toBe(0);
      expect(calculateShannonEntropy('9'.repeat(64))).toBe(0);
    });

    it('returns high entropy for cryptographically generated tokens', () => {
      const entropy = calculateShannonEntropy(validHexToken64);
      expect(entropy).toBeGreaterThan(3.2);
    });
  });

  describe('validateBackupToken', () => {
    it('returns null when token is omitted and not required', () => {
      expect(validateBackupToken(undefined)).toBeNull();
      expect(validateBackupToken(null)).toBeNull();
      expect(validateBackupToken('')).toBeNull();
      expect(validateBackupToken(undefined, { required: false })).toBeNull();
    });

    it('throws BackupConfigError when token is missing but required', () => {
      expect(() => validateBackupToken(undefined, { required: true })).toThrow(BackupConfigError);
      expect(() => validateBackupToken(undefined, { required: true })).toThrow(
        /BACKUP_INTERNAL_TOKEN is required/
      );
      expect(() => validateBackupToken('', { required: true })).toThrow(BackupConfigError);
      expect(() => validateBackupToken(null, { required: true })).toThrow(BackupConfigError);
    });

    it('rejects non-string token inputs', () => {
      expect(() => validateBackupToken(1234567890)).toThrow(/must be a string/);
      expect(() => validateBackupToken({})).toThrow(/must be a string/);
      expect(() => validateBackupToken(true)).toThrow(/must be a string/);
    });

    it('rejects whitespace-only tokens', () => {
      expect(() => validateBackupToken('   ')).toThrow(/cannot be empty or whitespace/);
    });

    it('rejects tokens shorter than 32 characters', () => {
      expect(() => validateBackupToken('a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5')).toThrow(
        /must be at least 32 characters long/
      );
      expect(() => validateBackupToken('short_secret')).toThrow(
        /must be at least 32 characters long/
      );
    });

    it('rejects tokens longer than 128 characters', () => {
      const oversizedToken = crypto.randomBytes(65).toString('hex'); // 130 chars
      expect(() => validateBackupToken(oversizedToken)).toThrow(
        /exceeds maximum permitted length of 128 characters/
      );
    });

    it('rejects tokens containing insecure placeholder patterns', () => {
      expect(() =>
        validateBackupToken('replace_with_secure_random_64_char_hex_backup_token_here')
      ).toThrow(/cannot contain placeholder or insecure patterns/);
      expect(() =>
        validateBackupToken('example_token_with_more_than_32_characters_long_now')
      ).toThrow(/cannot contain placeholder or insecure patterns/);
      expect(() =>
        validateBackupToken('my_default_secret_token_that_is_long_enough_12345')
      ).toThrow(/cannot contain placeholder or insecure patterns/);
      expect(() => validateBackupToken('super_secret_token_1234567890abcdef1234567890')).toThrow(
        /cannot contain placeholder or insecure patterns/
      );
    });

    it('rejects tokens with fewer than 8 unique characters', () => {
      // 2 unique characters repeated
      const repeating2 = 'abababababababababababababababab';
      expect(() => validateBackupToken(repeating2)).toThrow(/insufficient entropy/);

      // 4 unique characters repeated
      const repeating4 = 'abcdabcdabcdabcdabcdabcdabcdabcd';
      expect(() => validateBackupToken(repeating4)).toThrow(/insufficient entropy/);
    });

    it('rejects tokens where a single character dominates > 35%', () => {
      // 'a' repeated 25 times plus 7 different characters (length 32) -> 'a' is 78%
      const skewed = 'aaaaaaaaaaaaaaaaaaaaaaaaabcdefg1';
      expect(() => validateBackupToken(skewed)).toThrow(/accounts for more than 35%/);
    });

    it('accepts valid, high-entropy 32-character tokens', () => {
      const validated = validateBackupToken(validHexToken32);
      expect(validated).toBe(validHexToken32);
    });

    it('accepts valid, high-entropy 64-character tokens and trims whitespace', () => {
      const padded = `  ${validHexToken64}  \n`;
      const validated = validateBackupToken(padded);
      expect(validated).toBe(validHexToken64);
    });
  });

  describe('parsePositiveInteger', () => {
    it('returns default value when input is undefined, null, or empty string', () => {
      expect(parsePositiveInteger(undefined, 'TEST_VAR', 5000)).toBe(5000);
      expect(parsePositiveInteger(null, 'TEST_VAR', 5000)).toBe(5000);
      expect(parsePositiveInteger('', 'TEST_VAR', 5000)).toBe(5000);
    });

    it('parses valid numeric and string positive integers', () => {
      expect(parsePositiveInteger(10000, 'TEST_VAR', 5000)).toBe(10000);
      expect(parsePositiveInteger('30000', 'TEST_VAR', 5000)).toBe(30000);
      expect(parsePositiveInteger('  60000  ', 'TEST_VAR', 5000)).toBe(60000);
    });

    it('fails closed on non-positive integers', () => {
      expect(() => parsePositiveInteger(0, 'TEST_VAR', 5000)).toThrow(/must be a positive integer/);
      expect(() => parsePositiveInteger('0', 'TEST_VAR', 5000)).toThrow(
        /must be a positive integer/
      );
      expect(() => parsePositiveInteger(-500, 'TEST_VAR', 5000)).toThrow(
        /must be a positive integer/
      );
      expect(() => parsePositiveInteger('-10', 'TEST_VAR', 5000)).toThrow(
        /must be a positive integer/
      );
    });

    it('fails closed on non-numeric or malformed strings', () => {
      expect(() => parsePositiveInteger('abc', 'TEST_VAR', 5000)).toThrow(
        /must be a positive integer/
      );
      expect(() => parsePositiveInteger('12.34', 'TEST_VAR', 5000)).toThrow(
        /must be a positive integer/
      );
      expect(() => parsePositiveInteger('1000ms', 'TEST_VAR', 5000)).toThrow(
        /must be a positive integer/
      );
      expect(() => parsePositiveInteger('NaN', 'TEST_VAR', 5000)).toThrow(
        /must be a positive integer/
      );
      expect(() => parsePositiveInteger('Infinity', 'TEST_VAR', 5000)).toThrow(
        /must be a positive integer/
      );
    });

    it('fails closed on non-number, non-string types', () => {
      expect(() => parsePositiveInteger(true, 'TEST_VAR', 5000)).toThrow(
        /must be a string or positive integer/
      );
      expect(() => parsePositiveInteger({}, 'TEST_VAR', 5000)).toThrow(
        /must be a string or positive integer/
      );
      expect(() => parsePositiveInteger([], 'TEST_VAR', 5000)).toThrow(
        /must be a string or positive integer/
      );
    });
  });

  describe('validateBackupConfig', () => {
    it('returns default lease timing values when environment is unconfigured', () => {
      const config = validateBackupConfig({});
      expect(config.initialLeaseMs).toBe(60000);
      expect(config.INITIAL_LEASE_MS).toBe(60000);
      expect(config.heartbeatIntervalMs).toBe(10000);
      expect(config.HEARTBEAT_INTERVAL_MS).toBe(10000);
      expect(config.heartbeatExtendMs).toBe(30000);
      expect(config.HEARTBEAT_EXTEND_MS).toBe(30000);
      expect(config.drainTimeoutMs).toBe(5000);
      expect(config.DRAIN_TIMEOUT_MS).toBe(5000);
      expect(config.maxWatchdogLeaseMs).toBe(180000);
      expect(config.MAX_WATCHDOG_LEASE_MS).toBe(180000);
      expect(config.token).toBeNull();
      expect(config.isBackupEnabled).toBe(false);
      expect(Object.isFrozen(config)).toBe(true);
    });

    it('requires BACKUP_INTERNAL_TOKEN when BACKUP_ENABLED=true', () => {
      expect(() => validateBackupConfig({ BACKUP_ENABLED: 'true' })).toThrow(
        /BACKUP_INTERNAL_TOKEN is required/
      );
    });

    it('requires BACKUP_INTERNAL_TOKEN when options.requireToken is true', () => {
      expect(() => validateBackupConfig({}, { requireToken: true })).toThrow(
        /BACKUP_INTERNAL_TOKEN is required/
      );
    });

    it('validates BACKUP_INTERNAL_TOKEN when supplied even if backup is not enabled', () => {
      expect(() => validateBackupConfig({ BACKUP_INTERNAL_TOKEN: 'too_short' })).toThrow(
        /must be at least 32 characters long/
      );

      const config = validateBackupConfig({ BACKUP_INTERNAL_TOKEN: validHexToken64 });
      expect(config.token).toBe(validHexToken64);
      expect(config.BACKUP_INTERNAL_TOKEN).toBe(validHexToken64);
    });

    it('parses valid custom lease timings within bounds', () => {
      const config = validateBackupConfig({
        BACKUP_INTERNAL_TOKEN: validHexToken64,
        INITIAL_LEASE_MS: '45000',
        HEARTBEAT_INTERVAL_MS: '8000',
        HEARTBEAT_EXTEND_MS: '20000',
        DRAIN_TIMEOUT_MS: '3000',
        MAX_WATCHDOG_LEASE_MS: '120000'
      });

      expect(config.initialLeaseMs).toBe(45000);
      expect(config.heartbeatIntervalMs).toBe(8000);
      expect(config.heartbeatExtendMs).toBe(20000);
      expect(config.drainTimeoutMs).toBe(3000);
      expect(config.maxWatchdogLeaseMs).toBe(120000);
    });

    describe('Fail-Closed Timing Invariants', () => {
      it('fails closed if INITIAL_LEASE_MS exceeds MAX_WATCHDOG_LEASE_MS', () => {
        expect(() =>
          validateBackupConfig({
            INITIAL_LEASE_MS: '200000',
            MAX_WATCHDOG_LEASE_MS: '180000'
          })
        ).toThrow(/INITIAL_LEASE_MS \(200000ms\) cannot exceed MAX_WATCHDOG_LEASE_MS \(180000ms\)/);
      });

      it('fails closed if HEARTBEAT_EXTEND_MS exceeds MAX_WATCHDOG_LEASE_MS', () => {
        expect(() =>
          validateBackupConfig({
            HEARTBEAT_EXTEND_MS: '200000',
            MAX_WATCHDOG_LEASE_MS: '180000'
          })
        ).toThrow(
          /HEARTBEAT_EXTEND_MS \(200000ms\) cannot exceed MAX_WATCHDOG_LEASE_MS \(180000ms\)/
        );
      });

      it('fails closed if HEARTBEAT_INTERVAL_MS is greater than or equal to HEARTBEAT_EXTEND_MS', () => {
        expect(() =>
          validateBackupConfig({
            HEARTBEAT_INTERVAL_MS: '30000',
            HEARTBEAT_EXTEND_MS: '30000'
          })
        ).toThrow(
          /HEARTBEAT_INTERVAL_MS \(30000ms\) must be strictly less than HEARTBEAT_EXTEND_MS \(30000ms\)/
        );

        expect(() =>
          validateBackupConfig({
            HEARTBEAT_INTERVAL_MS: '35000',
            HEARTBEAT_EXTEND_MS: '30000'
          })
        ).toThrow(
          /HEARTBEAT_INTERVAL_MS \(35000ms\) must be strictly less than HEARTBEAT_EXTEND_MS \(30000ms\)/
        );
      });

      it('fails closed if HEARTBEAT_INTERVAL_MS is greater than or equal to INITIAL_LEASE_MS', () => {
        expect(() =>
          validateBackupConfig({
            INITIAL_LEASE_MS: '20000',
            HEARTBEAT_INTERVAL_MS: '20000',
            HEARTBEAT_EXTEND_MS: '30000'
          })
        ).toThrow(
          /HEARTBEAT_INTERVAL_MS \(20000ms\) must be strictly less than INITIAL_LEASE_MS \(20000ms\)/
        );
      });

      it('fails closed if DRAIN_TIMEOUT_MS is greater than or equal to INITIAL_LEASE_MS', () => {
        expect(() =>
          validateBackupConfig({
            INITIAL_LEASE_MS: '20000',
            DRAIN_TIMEOUT_MS: '20000'
          })
        ).toThrow(
          /DRAIN_TIMEOUT_MS \(20000ms\) must be strictly less than INITIAL_LEASE_MS \(20000ms\)/
        );

        expect(() =>
          validateBackupConfig({
            INITIAL_LEASE_MS: '20000',
            DRAIN_TIMEOUT_MS: '25000'
          })
        ).toThrow(
          /DRAIN_TIMEOUT_MS \(25000ms\) must be strictly less than INITIAL_LEASE_MS \(20000ms\)/
        );
      });

      it('fails closed if timing parameters violate minimum safety thresholds', () => {
        expect(() => validateBackupConfig({ DRAIN_TIMEOUT_MS: '50' })).toThrow(
          /DRAIN_TIMEOUT_MS \(50ms\) is too short: must be at least 100ms/
        );
        expect(() => validateBackupConfig({ HEARTBEAT_INTERVAL_MS: '200' })).toThrow(
          /HEARTBEAT_INTERVAL_MS \(200ms\) is too short: must be at least 500ms/
        );
        expect(() => validateBackupConfig({ INITIAL_LEASE_MS: '500' })).toThrow(
          /INITIAL_LEASE_MS \(500ms\) is too short: must be at least 1000ms/
        );
        expect(() => validateBackupConfig({ HEARTBEAT_EXTEND_MS: '800' })).toThrow(
          /HEARTBEAT_EXTEND_MS \(800ms\) is too short: must be at least 1000ms/
        );
        expect(() => validateBackupConfig({ MAX_WATCHDOG_LEASE_MS: '3000' })).toThrow(
          /MAX_WATCHDOG_LEASE_MS \(3000ms\) is too short: must be at least 5000ms/
        );
      });
    });
  });

  describe('timingSafeCompareToken', () => {
    it('returns true when tokens match exactly', () => {
      expect(timingSafeCompareToken(validHexToken64, validHexToken64)).toBe(true);
      expect(timingSafeCompareToken(validHexToken32, validHexToken32)).toBe(true);
    });

    it('returns false when tokens differ in content but share length', () => {
      const altered = (validHexToken64[0] === 'a' ? 'b' : 'a') + validHexToken64.slice(1);
      expect(timingSafeCompareToken(validHexToken64, altered)).toBe(false);
    });

    it('returns false when tokens differ in length', () => {
      expect(timingSafeCompareToken(validHexToken64, validHexToken32)).toBe(false);
    });

    it('returns false when inputs are non-strings or nil', () => {
      expect(timingSafeCompareToken(null, validHexToken64)).toBe(false);
      expect(timingSafeCompareToken(validHexToken64, undefined)).toBe(false);
      expect(timingSafeCompareToken(12345, validHexToken64)).toBe(false);
    });
  });
});
