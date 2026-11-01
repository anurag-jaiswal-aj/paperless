/**
 * Password Policy Enforcement Utility
 *
 * Implements NIST SP 800-63B aligned password requirements:
 * 1. Minimum length of 10 Unicode code points (case-sensitive, un-normalized).
 * 2. Maximum length of 72 UTF-8 bytes (enforcing bcrypt's 72-byte truncation boundary).
 * 3. Offline common password blocklist: rejects easily-guessed and sequential patterns.
 *
 * Source & Maintenance:
 * The common passwords blocklist contains frequently guessed sequential digits, keyboard
 * patterns, and common corporate/default credentials >= 10 characters curated from
 * public-domain security datasets (SecLists common credentials). Maintained locally
 * with zero external network or API dependencies.
 */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_BYTES = 72;

/**
 * Curated offline blocklist of easily guessed passwords (10+ characters).
 * Checked case-insensitively.
 */
export const COMMON_PASSWORDS = [
  // Sequential and repeated digits
  '1234567890',
  '0123456789',
  '123456789012',
  '0987654321',
  '1111111111',
  '0000000000',
  '1234512345',
  '123456123456',

  // Keyboard walks and rows
  'qwertyuiop',
  'asdfghjkl;',
  'zxcvbnm,./',
  'qwerty12345',
  'qazwsxedcr',
  '1q2w3e4r5t',

  // Common dictionary, administrative, and default phrases
  'administrator',
  'changeme123',
  'changeme1234',
  'welcome1234',
  'welcome12345',
  'welcome2024',
  'welcome2025',
  'welcome2026',
  'iloveyou123',
  'trustnoone1',
  'letmein1234',
  'supersecret',
  'password1234',
  'password12345',
  'adminadmin1',
  'paperless123',
  'paperless2026',
  'passphrase1',
  'correcthorsebatterystaple'
];

export const COMMON_PASSWORDS_SET = new Set(
  COMMON_PASSWORDS.map((p) => p.toLowerCase())
);

/**
 * Checks if a candidate password matches the common password blocklist.
 * Evaluates case-insensitively without mutating the underlying input.
 *
 * @param {string} password
 * @returns {boolean}
 */
export const isCommonPassword = (password) => {
  if (!password || typeof password !== 'string') return false;
  return COMMON_PASSWORDS_SET.has(password.toLowerCase());
};

/**
 * Validates candidate password against security policy requirements.
 *
 * @param {unknown} password - The raw candidate password
 * @returns {{ valid: boolean, message: string }}
 */
export const validatePassword = (password) => {
  if (password === null || password === undefined || password === '') {
    return {
      valid: false,
      message: 'Password is required'
    };
  }

  if (typeof password !== 'string') {
    return {
      valid: false,
      message: 'Password must be a string'
    };
  }

  const codePointLength = [...password].length;
  if (codePointLength < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    };
  }

  const byteLength = Buffer.byteLength(password, 'utf8');
  if (byteLength > MAX_PASSWORD_BYTES) {
    return {
      valid: false,
      message: `Password exceeds maximum length of ${MAX_PASSWORD_BYTES} bytes`
    };
  }

  if (isCommonPassword(password)) {
    return {
      valid: false,
      message: 'Password is too common or easily guessed'
    };
  }

  return {
    valid: true,
    message: 'Password meets policy requirements'
  };
};
