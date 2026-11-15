import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SENSITIVE_KEYS,
  PATTERNS,
  isSensitiveKey,
  redactString,
  sanitizeRequestUrl,
  redactObject,
  serializeError
} from './redactionPolicy.js';

describe('redactionPolicy', () => {
  describe('PATTERNS export', () => {
    it('exports all expected regex patterns as frozen object', () => {
      expect(Object.isFrozen(PATTERNS)).toBe(true);
      expect(PATTERNS.BEARER).toBeInstanceOf(RegExp);
      expect(PATTERNS.JWT).toBeInstanceOf(RegExp);
      expect(PATTERNS.OPENAI_KEY).toBeInstanceOf(RegExp);
      expect(PATTERNS.RESEND_KEY).toBeInstanceOf(RegExp);
      expect(PATTERNS.AWS_KEY).toBeInstanceOf(RegExp);
      expect(PATTERNS.MONGO_URI).toBeInstanceOf(RegExp);
      expect(PATTERNS.PASSWORD_RESET_URL).toBeInstanceOf(RegExp);
      expect(PATTERNS.SENSITIVE_QUERY_PARAM).toBeInstanceOf(RegExp);
      expect(PATTERNS.EMAIL).toBeInstanceOf(RegExp);
    });
  });

  describe('DEFAULT_SENSITIVE_KEYS and isSensitiveKey', () => {
    it('contains all required sensitive keys', () => {
      const expected = [
        'password',
        'newPassword',
        'confirmPassword',
        'currentPassword',
        'oldPassword',
        'token',
        'refreshToken',
        'accessToken',
        'resetToken',
        'resetPasswordToken',
        'secret',
        'jwtSecret',
        'jwtRefreshSecret',
        'hmacSecret',
        'loginProtectionHmacSecret',
        'apiKey',
        'authorization',
        'proxy-authorization',
        'cookie',
        'set-cookie',
        'accessKeyId',
        'secretAccessKey',
        'answers'
      ];

      for (const key of expected) {
        expect(DEFAULT_SENSITIVE_KEYS).toContain(key);
        expect(isSensitiveKey(key)).toBe(true);
      }
    });

    it('matches sensitive keys case-insensitively and with separators', () => {
      expect(isSensitiveKey('PASSWORD')).toBe(true);
      expect(isSensitiveKey('Password')).toBe(true);
      expect(isSensitiveKey('newpassword')).toBe(true);
      expect(isSensitiveKey('NEW_PASSWORD')).toBe(true);
      expect(isSensitiveKey('new-password')).toBe(true);
      expect(isSensitiveKey('AUTHORIZATION')).toBe(true);
      expect(isSensitiveKey('Proxy-Authorization')).toBe(true);
      expect(isSensitiveKey('proxy_authorization')).toBe(true);
      expect(isSensitiveKey('SET-COOKIE')).toBe(true);
      expect(isSensitiveKey('set_cookie')).toBe(true);
      expect(isSensitiveKey('APIKEY')).toBe(true);
      expect(isSensitiveKey('api_key')).toBe(true);
      expect(isSensitiveKey('ACCESSKEYID')).toBe(true);
      expect(isSensitiveKey('access_key_id')).toBe(true);
      expect(isSensitiveKey('SECRETACCESSKEY')).toBe(true);
      expect(isSensitiveKey('secret_access_key')).toBe(true);
      expect(isSensitiveKey('ANSWERS')).toBe(true);
      expect(isSensitiveKey('Answers')).toBe(true);
    });

    it('does not match non-sensitive or ordinary keys (false positives)', () => {
      expect(isSensitiveKey('score')).toBe(false);
      expect(isSensitiveKey('scores')).toBe(false);
      expect(isSensitiveKey('username')).toBe(false);
      expect(isSensitiveKey('email')).toBe(false);
      expect(isSensitiveKey('title')).toBe(false);
      expect(isSensitiveKey('description')).toBe(false);
      expect(isSensitiveKey('createdAt')).toBe(false);
      expect(isSensitiveKey('id')).toBe(false);
      expect(isSensitiveKey('passenger')).toBe(false);
      expect(isSensitiveKey('passport')).toBe(false);
      expect(isSensitiveKey('compass')).toBe(false);
      expect(isSensitiveKey(null)).toBe(false);
      expect(isSensitiveKey(123)).toBe(false);
    });

    it('supports custom additional sensitive keys via options', () => {
      expect(isSensitiveKey('ssn', { customKeys: ['ssn'] })).toBe(true);
      expect(isSensitiveKey('SSN', { customKeys: ['ssn'] })).toBe(true);
      expect(isSensitiveKey('pinCode', { additionalKeys: ['pin-code'] })).toBe(true);
      expect(isSensitiveKey('unrelated', { customKeys: ['ssn'] })).toBe(false);
    });
  });

  describe('redactString - Pattern positive matches', () => {
    it('redacts Bearer tokens', () => {
      expect(redactString('Bearer abc123def456')).toBe('Bearer [REDACTED]');
      expect(redactString('bearer my-token_123.xyz~/+=')).toBe('bearer [REDACTED]');
      expect(redactString('Authorization: Bearer topsecret123')).toBe(
        'Authorization: Bearer [REDACTED]'
      );
    });

    it('redacts JWT-shaped strings', () => {
      const jwt =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      expect(redactString(jwt)).toBe('[REDACTED_JWT]');
      expect(redactString(`Token was ${jwt} in payload`)).toBe(
        'Token was [REDACTED_JWT] in payload'
      );
    });

    it('redacts OpenAI-style API keys', () => {
      expect(redactString('sk-abcdefghijklmnopqrstuvwxyz12345')).toBe('[REDACTED_OPENAI_KEY]');
      expect(redactString('sk-proj-abcdefghijklmnopqrstuvwxyz12345')).toBe('[REDACTED_OPENAI_KEY]');
      expect(redactString('key=sk-123456789012345678901234567890')).toBe(
        'key=[REDACTED_OPENAI_KEY]'
      );
    });

    it('redacts Resend-style API keys', () => {
      expect(redactString('re_1234567890abcdef')).toBe('[REDACTED_RESEND_KEY]');
      expect(redactString('API key is re_1234567890abcdef1234 in header')).toBe(
        'API key is [REDACTED_RESEND_KEY] in header'
      );
    });

    it('redacts AWS access key identifiers', () => {
      expect(redactString('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED_AWS_KEY]');
      expect(redactString('ASIAIOSFODNN7EXAMPLE')).toBe('[REDACTED_AWS_KEY]');
      expect(redactString('Credentials: AKIA1234567890ABCDEF')).toBe(
        'Credentials: [REDACTED_AWS_KEY]'
      );
    });

    it('redacts MongoDB connection URI passwords', () => {
      const uri1 = 'mongodb://appuser:secretPassword123@mongo.internal:27017/paperless';
      expect(redactString(uri1)).toBe(
        'mongodb://appuser:[REDACTED]@mongo.internal:27017/paperless'
      );

      const uri2 = 'mongodb+srv://admin:P%40ssword!@cluster0.abc.mongodb.net/test';
      expect(redactString(uri2)).toBe(
        'mongodb+srv://admin:[REDACTED]@cluster0.abc.mongodb.net/test'
      );
    });

    it('redacts Password reset URLs', () => {
      expect(redactString('/resetpassword/token1234567890')).toBe('/resetpassword/[REDACTED]');
      expect(redactString('/reset-password/token-abc_123.456')).toBe('/reset-password/[REDACTED]');
      expect(redactString('https://paperless.app/reset-password/secure-hash-token-value')).toBe(
        'https://paperless.app/reset-password/[REDACTED]'
      );
    });

    it('redacts sensitive query parameters', () => {
      expect(redactString('https://example.com/api?token=secret123')).toBe(
        'https://example.com/api?token=[REDACTED]'
      );
      expect(redactString('https://example.com/api?resettoken=secret123')).toBe(
        'https://example.com/api?resettoken=[REDACTED]'
      );
      expect(redactString('https://example.com/api?reset-token=secret123')).toBe(
        'https://example.com/api?reset-token=[REDACTED]'
      );
      expect(redactString('https://example.com/api?apikey=key123')).toBe(
        'https://example.com/api?apikey=[REDACTED]'
      );
      expect(redactString('https://example.com/api?key=key123')).toBe(
        'https://example.com/api?key=[REDACTED]'
      );
      expect(redactString('https://example.com/api?secret=shh')).toBe(
        'https://example.com/api?secret=[REDACTED]'
      );
      expect(redactString('https://example.com/api?password=pass123')).toBe(
        'https://example.com/api?password=[REDACTED]'
      );
      expect(redactString('https://example.com/api?auth=authcode')).toBe(
        'https://example.com/api?auth=[REDACTED]'
      );
      expect(redactString('https://example.com/api?code=code123')).toBe(
        'https://example.com/api?code=[REDACTED]'
      );
      expect(redactString('https://example.com/api?sig=sig123')).toBe(
        'https://example.com/api?sig=[REDACTED]'
      );
      expect(redactString('https://example.com/api?signature=sig123')).toBe(
        'https://example.com/api?signature=[REDACTED]'
      );
      expect(redactString('https://example.com/api?api_key=key123')).toBe(
        'https://example.com/api?api_key=[REDACTED]'
      );
      expect(redactString('https://example.com/api?api-key=key123')).toBe(
        'https://example.com/api?api-key=[REDACTED]'
      );
      expect(redactString('https://example.com/api?access_token=tok123')).toBe(
        'https://example.com/api?access_token=[REDACTED]'
      );
      expect(redactString('https://example.com/api?refresh_token=tok123')).toBe(
        'https://example.com/api?refresh_token=[REDACTED]'
      );
      expect(redactString('https://example.com/api?client_secret=sec123')).toBe(
        'https://example.com/api?client_secret=[REDACTED]'
      );
    });

    it('masks email addresses preserving the first 1-2 characters of username', () => {
      expect(redactString('john.doe@example.com')).toBe('jo***@example.com');
      expect(redactString('a@domain.com')).toBe('a***@domain.com');
      expect(redactString('ab@domain.com')).toBe('ab***@domain.com');
      expect(redactString('abc@domain.com')).toBe('ab***@domain.com');
      expect(redactString('user.name+tag@company.co.uk')).toBe('us***@company.co.uk');
    });

    it('redacts multiple patterns present in the same string', () => {
      const complex =
        'Error for user john.doe@example.com connecting to mongodb://admin:pass123@host:27017 with sk-abcdefghijklmnopqrstuvwxyz12345';
      const result = redactString(complex);
      expect(result).toContain('jo***@example.com');
      expect(result).toContain('mongodb://admin:[REDACTED]@host:27017');
      expect(result).toContain('[REDACTED_OPENAI_KEY]');
      expect(result).not.toContain('pass123');
      expect(result).not.toContain('john.doe');
    });

    it('safely handles non-string inputs', () => {
      expect(redactString(null)).toBe(null);
      expect(redactString(undefined)).toBe(undefined);
      expect(redactString(12345)).toBe(12345);
      expect(redactString(true)).toBe(true);
      const obj = { test: 1 };
      expect(redactString(obj)).toBe(obj);
    });
  });

  describe('redactString - False positives', () => {
    it('does not redact ordinary words with sensitive substrings', () => {
      const words = [
        'compass',
        'passenger',
        'passport',
        'surpass',
        'author',
        'authority',
        'authenticate',
        'keyboard',
        'monkey',
        'hockey',
        'keynote',
        'secretary',
        'secretive',
        'tokenship',
        'betoken',
        'decode',
        'encode',
        'zipcode',
        'Bearers',
        'unbearable'
      ];

      for (const word of words) {
        expect(redactString(word)).toBe(word);
      }
    });

    it('does not redact non-sensitive URLs or pagination query parameters', () => {
      const urls = [
        'https://paperless.app/dashboard/settings/profile',
        '/api/v1/forms/123/responses?page=1&limit=25&sort=createdAt&order=desc',
        'https://api.example.com/v1/items?category=books&inStock=true&filter=active',
        '/reset-password/'
      ];

      for (const url of urls) {
        expect(redactString(url)).toBe(url);
      }
    });

    it('does not redact scores or ordinary metrics in strings', () => {
      const text = 'The student achieved a score of 98 with scores: 95, 98, 100 on test';
      expect(redactString(text)).toBe(text);
      expect(redactString('?score=100&scores=90,95')).toBe('?score=100&scores=90,95');
    });

    it('does not match short or malformed tokens', () => {
      expect(redactString('sk-short')).toBe('sk-short');
      expect(redactString('re_short')).toBe('re_short');
      expect(redactString('AKIA123')).toBe('AKIA123');
      expect(redactString('file.name.txt')).toBe('file.name.txt');
      expect(redactString('v1.0.0.release')).toBe('v1.0.0.release');
      expect(redactString('notanemail@')).toBe('notanemail@');
      expect(redactString('@example.com')).toBe('@example.com');
    });
  });

  describe('sanitizeRequestUrl', () => {
    it('redacts reset token from path', () => {
      expect(sanitizeRequestUrl('/api/auth/resetpassword/abcdef1234567890')).toBe(
        '/api/auth/resetpassword/[REDACTED]'
      );
      expect(sanitizeRequestUrl('/api/auth/reset-password/hyphenated-route-token-1234')).toBe(
        '/api/auth/reset-password/[REDACTED]'
      );
      expect(sanitizeRequestUrl('/api/auth/resetpassword/token_with_underscore')).toBe(
        '/api/auth/resetpassword/[REDACTED]'
      );
      expect(sanitizeRequestUrl('/api/auth/resetpassword/url%20encoded%2Etoken')).toBe(
        '/api/auth/resetpassword/[REDACTED]'
      );
    });

    it('redacts sensitive query parameters while preserving non-sensitive parameters', () => {
      expect(sanitizeRequestUrl('/api/auth/resetpassword?token=secret123')).toBe(
        '/api/auth/resetpassword?token=[REDACTED]'
      );
      expect(sanitizeRequestUrl('/api/auth/resetpassword?foo=bar&token=secret123&baz=1')).toBe(
        '/api/auth/resetpassword?foo=bar&token=[REDACTED]&baz=1'
      );
      expect(sanitizeRequestUrl('/api/auth/resetpassword?resetToken=secret123')).toBe(
        '/api/auth/resetpassword?resetToken=[REDACTED]'
      );
      expect(sanitizeRequestUrl('/api/auth/reset-password?reset-token=secret123')).toBe(
        '/api/auth/reset-password?reset-token=[REDACTED]'
      );
      expect(sanitizeRequestUrl('/api/auth?apiKey=mykey&code=12345&state=ok')).toBe(
        '/api/auth?apiKey=[REDACTED]&code=[REDACTED]&state=ok'
      );
      expect(sanitizeRequestUrl('/api/auth?sig=sigval&signature=fullsig')).toBe(
        '/api/auth?sig=[REDACTED]&signature=[REDACTED]'
      );
    });

    it('leaves non-sensitive paths and query parameters intact', () => {
      expect(sanitizeRequestUrl('/api/auth/login')).toBe('/api/auth/login');
      expect(sanitizeRequestUrl('/api/forms?page=2&limit=10&score=95')).toBe(
        '/api/forms?page=2&limit=10&score=95'
      );
    });

    it('returns empty string for non-string input', () => {
      expect(sanitizeRequestUrl(null)).toBe('');
      expect(sanitizeRequestUrl(undefined)).toBe('');
      expect(sanitizeRequestUrl(12345)).toBe('');
      expect(sanitizeRequestUrl({})).toBe('');
    });
  });

  describe('redactObject - Deep clone and key redaction', () => {
    it('redacts sensitive keys in flat objects', () => {
      const input = {
        username: 'alice',
        password: 'superSecretPassword',
        token: 'token123',
        apiKey: 'key456',
        answers: ['confidential answer']
      };

      const result = redactObject(input);
      expect(result.username).toBe('alice');
      expect(result.password).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
      expect(result.apiKey).toBe('[REDACTED]');
      expect(result.answers).toBe('[REDACTED]');
    });

    it('redacts nested objects and arrays', () => {
      const input = {
        user: {
          profile: {
            email: 'alice.smith@example.com',
            refreshToken: 'refresh123',
            loginProtectionHmacSecret: 'secret_hmac'
          }
        },
        items: [
          { id: 1, secret: 'shh' },
          { id: 2, accessKeyId: 'AKIAIOSFODNN7EXAMPLE' }
        ]
      };

      const result = redactObject(input);
      expect(result.user.profile.email).toBe('al***@example.com');
      expect(result.user.profile.refreshToken).toBe('[REDACTED]');
      expect(result.user.profile.loginProtectionHmacSecret).toBe('[REDACTED]');
      expect(result.items[0].id).toBe(1);
      expect(result.items[0].secret).toBe('[REDACTED]');
      expect(result.items[1].id).toBe(2);
      expect(result.items[1].accessKeyId).toBe('[REDACTED]');
    });

    it('scrubs string values matching patterns in non-sensitive keys', () => {
      const input = {
        description: 'Failed with sk-abcdefghijklmnopqrstuvwxyz12345 for test@example.com',
        dbUrl: 'mongodb://user:pass123@mongo.domain.com:27017/db'
      };

      const result = redactObject(input);
      expect(result.description).toContain('[REDACTED_OPENAI_KEY]');
      expect(result.description).toContain('te***@example.com');
      expect(result.dbUrl).toBe('mongodb://user:[REDACTED]@mongo.domain.com:27017/db');
    });

    it('handles Date, RegExp, and Buffer instances appropriately', () => {
      const now = new Date();
      const regex = /test/gi;
      const buf = Buffer.from('hello');

      const input = { date: now, pattern: regex, data: buf };
      const result = redactObject(input);

      expect(result.date).toBeInstanceOf(Date);
      expect(result.date.getTime()).toBe(now.getTime());
      expect(result.date).not.toBe(now);

      expect(result.pattern).toBeInstanceOf(RegExp);
      expect(result.pattern.source).toBe(regex.source);
      expect(result.pattern.flags).toBe(regex.flags);
      expect(result.pattern).not.toBe(regex);

      expect(Buffer.isBuffer(result.data)).toBe(true);
      expect(result.data.toString()).toBe('hello');
      expect(result.data).not.toBe(buf);
    });

    it('handles primitives and falsy values safely', () => {
      expect(redactObject(null)).toBe(null);
      expect(redactObject(undefined)).toBe(undefined);
      expect(redactObject(12345)).toBe(12345);
      expect(redactObject(true)).toBe(true);
      expect(redactObject('')).toBe('');
      expect(redactObject('user@example.com')).toBe('us***@example.com');
    });

    it('respects options: replacement, customKeys, and redactStrings', () => {
      const input = {
        ssn: '123-45-6789',
        email: 'alice@example.com'
      };

      const customRedacted = redactObject(input, {
        customKeys: ['ssn'],
        replacement: '[CONFIDENTIAL]',
        redactStrings: false
      });

      expect(customRedacted.ssn).toBe('[CONFIDENTIAL]');
      expect(customRedacted.email).toBe('alice@example.com');
    });
  });

  describe('redactObject - Input non-mutation', () => {
    it('never mutates input objects or nested structures', () => {
      const original = {
        password: 'raw-password-123',
        sub: {
          apiKey: 'sk-abcdefghijklmnopqrstuvwxyz12345',
          email: 'test.user@example.com',
          details: {
            token: 'secret-token'
          }
        },
        answers: ['raw answer 1', 'raw answer 2'],
        score: 95
      };

      const snapshot = JSON.stringify(original);
      const result = redactObject(original);

      // Verify original is untouched
      expect(JSON.stringify(original)).toBe(snapshot);
      expect(original.password).toBe('raw-password-123');
      expect(original.sub.apiKey).toBe('sk-abcdefghijklmnopqrstuvwxyz12345');
      expect(original.sub.email).toBe('test.user@example.com');
      expect(original.sub.details.token).toBe('secret-token');
      expect(original.answers).toEqual(['raw answer 1', 'raw answer 2']);
      expect(original.score).toBe(95);

      // Verify result has redactions and distinct identities
      expect(result).not.toBe(original);
      expect(result.sub).not.toBe(original.sub);
      expect(result.password).toBe('[REDACTED]');
      expect(result.answers).toBe('[REDACTED]');
      expect(result.sub.apiKey).toBe('[REDACTED]');
      expect(result.sub.email).toBe('te***@example.com');
      expect(result.sub.details.token).toBe('[REDACTED]');
      expect(result.score).toBe(95);
    });
  });

  describe('redactObject - Circular references and depth bounding', () => {
    it('detects and handles self-referencing circular objects', () => {
      const obj = { name: 'cycle-root' };
      obj.self = obj;

      const result = redactObject(obj);
      expect(result.name).toBe('cycle-root');
      expect(result.self).toBe('[Circular]');
    });

    it('detects and handles mutual circular references', () => {
      const a = { name: 'A' };
      const b = { name: 'B', aRef: a };
      a.bRef = b;

      const result = redactObject(a);
      expect(result.name).toBe('A');
      expect(result.bRef.name).toBe('B');
      expect(result.bRef.aRef).toBe('[Circular]');
    });

    it('detects circular references in arrays', () => {
      const arr = ['first'];
      arr.push(arr);

      const result = redactObject(arr);
      expect(result[0]).toBe('first');
      expect(result[1]).toBe('[Circular]');
    });

    it('does not falsely flag shared non-circular references as circular', () => {
      const shared = { sharedKey: 'sharedValue' };
      const root = { first: shared, second: shared };

      const result = redactObject(root);
      expect(result.first).toEqual({ sharedKey: 'sharedValue' });
      expect(result.second).toEqual({ sharedKey: 'sharedValue' });
      expect(result.second).not.toBe('[Circular]');
    });

    it('bounds recursion depth to prevent stack overflow', () => {
      let current = {};
      const root = current;
      for (let i = 0; i < 20; i++) {
        current.nested = {};
        current = current.nested;
      }

      const result = redactObject(root, { maxDepth: 5 });
      let node = result;
      for (let i = 0; i < 5; i++) {
        expect(node).toHaveProperty('nested');
        node = node.nested;
      }
      expect(node).toBe('[MAX_DEPTH_EXCEEDED]');
    });
  });

  describe('serializeError', () => {
    it('extracts and sanitizes standard error properties', () => {
      const err = new Error(
        'Failed connecting to mongodb://user:pass123@mongo.host:27017/db with sk-abcdefghijklmnopqrstuvwxyz12345'
      );
      err.code = 'E_CONNECTION_FAILED';
      err.statusCode = 500;

      const serialized = serializeError(err);
      expect(serialized.name).toBe('Error');
      expect(serialized.message).toContain('mongodb://user:[REDACTED]@mongo.host:27017/db');
      expect(serialized.message).toContain('[REDACTED_OPENAI_KEY]');
      expect(serialized.message).not.toContain('pass123');
      expect(serialized.stack).toContain('mongodb://user:[REDACTED]@mongo.host:27017/db');
      expect(serialized.code).toBe('E_CONNECTION_FAILED');
      expect(serialized.statusCode).toBe(500);
    });

    it('falls back to status when statusCode is absent', () => {
      const err = new Error('Resource not found');
      err.status = 404;

      const serialized = serializeError(err);
      expect(serialized.statusCode).toBe(404);
    });

    it('sanitizes and copies custom own properties on error', () => {
      const err = new Error('Validation error');
      err.apiKey = 're_1234567890abcdef';
      err.meta = {
        userEmail: 'alice@example.com',
        score: 98,
        token: 'secret-token-123'
      };

      const serialized = serializeError(err);
      expect(serialized.apiKey).toBe('[REDACTED]');
      expect(serialized.meta.userEmail).toBe('al***@example.com');
      expect(serialized.meta.score).toBe(98);
      expect(serialized.meta.token).toBe('[REDACTED]');
    });

    it('serializes nested error causes and handles circular causes', () => {
      const rootCause = new Error('Root cause with re_1234567890abcdef');
      const middleErr = new Error('Middle error', { cause: rootCause });
      const topErr = new Error('Top error', { cause: middleErr });

      const serialized = serializeError(topErr);
      expect(serialized.cause.name).toBe('Error');
      expect(serialized.cause.message).toBe('Middle error');
      expect(serialized.cause.cause.name).toBe('Error');
      expect(serialized.cause.cause.message).toContain('[REDACTED_RESEND_KEY]');

      // Circular causes
      const errA = new Error('Error A');
      const errB = new Error('Error B', { cause: errA });
      errA.cause = errB;

      const circularSerialized = serializeError(errA);
      expect(circularSerialized.name).toBe('Error');
      expect(circularSerialized.cause.name).toBe('Error');
      expect(circularSerialized.cause.cause).toBe('[Circular]');

      // Self cause
      const selfErr = new Error('Self referencing error');
      selfErr.cause = selfErr;

      const selfSerialized = serializeError(selfErr);
      expect(selfSerialized.cause).toBe('[Circular]');
    });

    it('does not mutate the original error instance', () => {
      const originalErr = new Error('Raw error with password in message');
      originalErr.code = 'E_AUTH';
      originalErr.password = 'supersecret';
      originalErr.metadata = { token: 'raw-token' };

      const msg = originalErr.message;
      const stack = originalErr.stack;

      const serialized = serializeError(originalErr);
      expect(originalErr.message).toBe(msg);
      expect(originalErr.stack).toBe(stack);
      expect(originalErr.password).toBe('supersecret');
      expect(originalErr.metadata.token).toBe('raw-token');

      expect(serialized.password).toBe('[REDACTED]');
      expect(serialized.metadata.token).toBe('[REDACTED]');
    });

    it('safely handles non-error inputs', () => {
      const stringResult = serializeError('simple error message with re_1234567890abcdef');
      expect(stringResult.name).toBe('Error');
      expect(stringResult.message).toBe('simple error message with [REDACTED_RESEND_KEY]');

      const nullResult = serializeError(null);
      expect(nullResult.name).toBe('Error');
      expect(nullResult.message).toBe('');

      const undefinedResult = serializeError(undefined);
      expect(undefinedResult.name).toBe('Error');
      expect(undefinedResult.message).toBe('');
    });

    it('respects includeStack option', () => {
      const err = new Error('Stack test');
      const withoutStack = serializeError(err, { includeStack: false });
      expect(withoutStack.stack).toBeUndefined();

      const withStack = serializeError(err, { includeStack: true });
      expect(withStack.stack).toBeDefined();
    });
  });

  describe('Regression Tests: Error Cause Recursion and Depth Bounding', () => {
    it('bounds long non-circular Error cause chains at maxDepth without call stack overflow', () => {
      let root = new Error('Root error (level 0)');
      let current = root;
      for (let i = 1; i <= 15; i++) {
        const next = new Error(`Cause level ${i}`);
        current.cause = next;
        current = next;
      }

      const serialized = serializeError(root);
      expect(serialized.name).toBe('Error');
      expect(serialized.message).toBe('Root error (level 0)');

      let node = serialized;
      let depth = 0;
      while (node && typeof node === 'object' && node.cause) {
        depth++;
        node = node.cause;
      }

      expect(depth).toBe(10);
      expect(node).toBe('[MAX_DEPTH_EXCEEDED]');

      const shallow = serializeError(root, { maxDepth: 3 });
      expect(shallow.cause.cause.cause).toBe('[MAX_DEPTH_EXCEEDED]');
    });

    it('propagates depth consistently through mixed Error and object cause chains', () => {
      const level3Object = { detail: 'leaf object', secret: 'sensitive' };
      const level2Error = new Error('Level 2 error', { cause: level3Object });
      const level1Object = { wrapped: 'info', innerCause: level2Error };
      const rootError = new Error('Root error', { cause: level1Object });

      const serialized = serializeError(rootError, { maxDepth: 3 });
      expect(serialized.name).toBe('Error');
      expect(serialized.cause.wrapped).toBe('info');
      expect(serialized.cause.innerCause.name).toBe('Error');
      expect(serialized.cause.innerCause.cause).toBe('[MAX_DEPTH_EXCEEDED]');
    });

    it('detects circular causes including mutual Error-to-Object circular references', () => {
      const err = new Error('Root error');
      const container = { context: 'wrapper' };
      err.cause = container;
      container.nestedError = err;

      const serialized = serializeError(err);
      expect(serialized.name).toBe('Error');
      expect(serialized.cause.context).toBe('wrapper');
      expect(serialized.cause.nestedError).toBe('[Circular]');
    });

    it('preserves ordinary shallow cause output unchanged', () => {
      const shallowCause = new Error('Shallow cause');
      shallowCause.code = 'ERR_SHALLOW';
      const root = new Error('Root error', { cause: shallowCause });

      const serialized = serializeError(root);
      expect(serialized.name).toBe('Error');
      expect(serialized.message).toBe('Root error');
      expect(serialized.cause).toMatchObject({
        name: 'Error',
        message: 'Shallow cause',
        code: 'ERR_SHALLOW'
      });
    });

    it('ensures original Error instances in cause chains remain strictly unmodified', () => {
      const cause = new Error('Original cause with password in msg');
      cause.apiKey = 're_1234567890abcdef';
      const root = new Error('Original root with jwt', { cause });
      root.token = 'secret-token';

      const origRootMsg = root.message;
      const origCauseMsg = cause.message;
      const origApiKey = cause.apiKey;
      const origToken = root.token;

      const serialized = serializeError(root);

      expect(root.message).toBe(origRootMsg);
      expect(cause.message).toBe(origCauseMsg);
      expect(cause.apiKey).toBe(origApiKey);
      expect(root.token).toBe(origToken);
      expect(root.cause).toBe(cause);

      expect(serialized.token).toBe('[REDACTED]');
      expect(serialized.cause.apiKey).toBe('[REDACTED]');
    });
  });

  describe('Regression Tests: Safe Property Copying and __proto__ Protection', () => {
    it('handles own __proto__ property as data without prototype mutation', () => {
      const payload = JSON.parse('{"__proto__": {"polluted": true}, "safeProp": 42}');
      const cloned = redactObject(payload);

      expect(Object.prototype.hasOwnProperty.call(cloned, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
      expect({}.polluted).toBeUndefined();
      expect(cloned.safeProp).toBe(42);
    });

    it('redacts sensitive properties nested within own __proto__ data property', () => {
      const payload = JSON.parse(
        '{"__proto__": {"password": "PlainTextPassword", "apiKey": "sk-1234567890abcdef12345678", "normal": "safe"}}'
      );
      const cloned = redactObject(payload);

      expect(Object.getPrototypeOf(cloned)).toBe(Object.prototype);
      expect(cloned.__proto__.password).toBe('[REDACTED]');
      expect(cloned.__proto__.apiKey).toBe('[REDACTED]');
      expect(cloned.__proto__.normal).toBe('safe');
      expect({}.password).toBeUndefined();
    });

    it('safely handles own __proto__ property on Error instances', () => {
      const err = new Error('Error with own proto');
      Object.defineProperty(err, '__proto__', {
        value: { extraData: 'safe', token: 'secretToken' },
        writable: true,
        enumerable: true,
        configurable: true
      });

      const serialized = serializeError(err);
      expect(Object.getPrototypeOf(serialized)).toBe(Object.prototype);
      expect(serialized.__proto__.token).toBe('[REDACTED]');
      expect(serialized.__proto__.extraData).toBe('safe');
      expect({}.token).toBeUndefined();
    });
  });
});
