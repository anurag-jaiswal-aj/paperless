import crypto from 'node:crypto';
import net from 'node:net';

/**
 * Custom error thrown when an HMAC secret fails validation or is missing.
 */
export class InvalidSecretError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidSecretError';
  }
}

/**
 * Custom error thrown when an invalid client IP is supplied to key derivation.
 */
export class InvalidIpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidIpError';
  }
}

/**
 * Custom error thrown when an invalid email is supplied to key derivation.
 */
export class InvalidEmailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidEmailError';
  }
}

/**
 * Development fallback secret permitted strictly in development or test environments
 * when progressive login protection is disabled.
 */
export const DEV_FALLBACK_SECRET = 'paperless-dev-hmac-secret-32-bytes-minimum-seed';

/**
 * Normalizes email addresses to match Paperless authentication pipeline semantics exactly:
 * trim and lowercase, without Unicode NFKC or other transformations.
 *
 * @param {unknown} email - Raw email input
 * @returns {string} Normalized email string, or empty string if input is invalid
 */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/**
 * Parses an IPv6 address string into exactly eight 16-bit unsigned integer words.
 * Correctly preserves zero-compression markers when embedded IPv4 suffixes are present.
 *
 * @param {string} ip - IPv6 string
 * @returns {number[]|null} Array of 8 16-bit words, or null if invalid
 */
export function parseIPv6Words(ip) {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed || net.isIPv6(trimmed) !== true) return null;

  let str = trimmed;
  let embeddedIPv4Words = null;

  // Match embedded IPv4 suffix preceded by colon or start of string
  const ipv4Match = str.match(/(^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4Match) {
    const ipv4Str = ipv4Match[2];
    if (!net.isIPv4(ipv4Str)) return null;
    const octets = ipv4Str.split('.').map((o) => parseInt(o, 10));
    embeddedIPv4Words = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];

    // Slice off the IPv4 dotted-quad suffix
    let prefix = str.slice(0, -ipv4Str.length);
    // If prefix ends with '::', keep '::' to preserve the zero compression marker.
    // If prefix ends with a single ':', strip it (e.g. '::ffff:' -> '::ffff').
    if (!prefix.endsWith('::') && prefix.endsWith(':')) {
      prefix = prefix.slice(0, -1);
    }
    str = prefix;
  }

  const expectedWords = embeddedIPv4Words ? 6 : 8;
  let parts;
  if (str.includes('::')) {
    const halves = str.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = expectedWords - (left.length + right.length);
    if (missing < 0) return null;
    parts = [...left, ...new Array(missing).fill('0'), ...right];
  } else {
    parts = str ? str.split(':') : [];
  }

  const words = parts.map((p) => parseInt(p, 16));
  if (embeddedIPv4Words) words.push(...embeddedIPv4Words);
  if (words.length !== 8 || words.some((w) => isNaN(w) || w < 0 || w > 0xffff)) {
    return null;
  }
  return words;
}

/**
 * Formats eight 16-bit IPv6 words into RFC 5952 canonical text representation.
 * Unwraps IPv4-mapped IPv6 addresses (0:0:0:0:0:ffff:xxxx:xxxx) to canonical IPv4 dotted-quad.
 *
 * @param {number[]} words - Eight 16-bit unsigned integers
 * @returns {string|null} RFC 5952 canonical representation, or null if input is invalid
 */
export function canonicalizeIPv6Words(words) {
  if (!Array.isArray(words) || words.length !== 8) {
    return null;
  }

  // IPv4-mapped IPv6 unwrapping: 0:0:0:0:0:ffff:xxxx:xxxx -> a.b.c.d
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const b0 = (words[6] >> 8) & 0xff;
    const b1 = words[6] & 0xff;
    const b2 = (words[7] >> 8) & 0xff;
    const b3 = words[7] & 0xff;
    return `${b0}.${b1}.${b2}.${b3}`;
  }

  // RFC 5952 zero compression:
  // Rule 4.2.1: Find longest run of consecutive 16-bit zeros.
  // Rule 4.2.2: Do not compress a single 16-bit zero.
  // Rule 4.2.3: In tie, compress the first longest run.
  let longestStart = -1;
  let longestLen = 0;
  let curStart = -1;
  let curLen = 0;

  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (curStart === -1) {
        curStart = i;
        curLen = 1;
      } else {
        curLen++;
      }
      if (curLen > longestLen) {
        longestLen = curLen;
        longestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (longestLen >= 2) {
    const leftStr = words
      .slice(0, longestStart)
      .map((w) => w.toString(16))
      .join(':');
    const rightStr = words
      .slice(longestStart + longestLen)
      .map((w) => w.toString(16))
      .join(':');
    if (!leftStr && !rightStr) return '::';
    if (!leftStr) return `::${rightStr}`;
    if (!rightStr) return `${leftStr}::`;
    return `${leftStr}::${rightStr}`;
  }

  return words.map((w) => w.toString(16)).join(':');
}

/**
 * Canonicalizes IPv4 and IPv6 address strings into unambiguous canonical forms.
 * Rejects invalid strings, uncompresses/re-compresses IPv6 according to RFC 5952,
 * and unwraps IPv4-mapped IPv6 addresses to canonical IPv4.
 *
 * @param {unknown} rawIp - Raw IP address string
 * @returns {string|null} Canonical IP string, or null if invalid
 */
export function canonicalizeIp(rawIp) {
  if (typeof rawIp !== 'string') return null;
  const trimmed = rawIp.trim();
  if (!trimmed) return null;

  // IPv4 validation and canonicalization (net.isIPv4 rejects leading zeros)
  if (net.isIPv4(trimmed)) {
    return trimmed
      .split('.')
      .map((o) => parseInt(o, 10))
      .join('.');
  }

  // IPv6 validation and RFC 5952 canonicalization
  if (net.isIPv6(trimmed)) {
    const words = parseIPv6Words(trimmed);
    if (!words) return null;
    return canonicalizeIPv6Words(words);
  }

  return null;
}

/**
 * Extracts and canonicalizes client IP address from an Express request object.
 * Reuses established Express trust-proxy resolution and rejects malformed values.
 *
 * @param {object} req - Express request object
 * @returns {string|null} Canonical client IP string, or null if unavailable/invalid
 */
export function extractClientIp(req) {
  if (!req || typeof req !== 'object') return null;
  const candidate = req.ip ?? req.socket?.remoteAddress ?? req.connection?.remoteAddress ?? null;
  if (!candidate) return null;
  return canonicalizeIp(candidate);
}

/**
 * Constructs an unambiguous, length-prefixed netstring-style tuple encoding:
 * byteLength(field1):field1|byteLength(field2):field2|...
 *
 * Uses UTF-8 byte lengths to guarantee that multi-byte Unicode characters,
 * colons, pipes, and internal delimiters cannot cause field-boundary collisions.
 *
 * @param {...unknown} fields - Field values to encode
 * @returns {string} Length-prefixed tuple payload
 */
export function encodeTuple(...fields) {
  return fields
    .map((field) => {
      const str = String(field ?? '');
      const byteLen = Buffer.byteLength(str, 'utf8');
      return `${byteLen}:${str}`;
    })
    .join('|');
}

/**
 * Parses and validates an HMAC secret key buffer.
 *
 * Requirements:
 * - 64-character hexadecimal strings (with optional 0x/0X prefix) are decoded into exactly 32 bytes.
 * - UTF-8 strings are accepted only if their encoded byte length is at least 32 bytes.
 * - Minimum 32 bytes establishes key length validation, not proof of 256 bits of entropy.
 * - In production environments, secrets must be generated from a CSPRNG.
 * - No predictable fallback is allowed when progressive login protection is enabled.
 *
 * @param {string|undefined|null} rawSecret - Secret from environment or configuration
 * @param {object} [options={}]
 * @param {boolean} [options.isProtectionEnabled=false] - Whether protection is enabled
 * @param {string} [options.env=process.env.NODE_ENV] - Current Node environment
 * @returns {Buffer} Validated 32+ byte binary key Buffer
 * @throws {InvalidSecretError} If secret is missing, malformed, or fewer than 32 bytes
 */
export function parseHmacSecret(rawSecret, options = {}) {
  const isProtectionEnabled = options.isProtectionEnabled ?? false;
  const env = options.env ?? process.env.NODE_ENV;

  // Handle unconfigured/undefined secret (environment variable not set)
  if (rawSecret === undefined) {
    if (isProtectionEnabled) {
      throw new InvalidSecretError(
        'LOGIN_PROTECTION_HMAC_SECRET is required when progressive login protection is enabled'
      );
    }
    if (env === 'test' || env === 'development') {
      return Buffer.from(DEV_FALLBACK_SECRET, 'utf8');
    }
    throw new InvalidSecretError(
      'LOGIN_PROTECTION_HMAC_SECRET is required in production and staging environments'
    );
  }

  if (typeof rawSecret !== 'string') {
    throw new InvalidSecretError('HMAC secret must be a string');
  }

  const trimmed = rawSecret.trim();
  if (!trimmed) {
    throw new InvalidSecretError('HMAC secret cannot be empty or whitespace');
  }

  const hasHexPrefix = /^0[xX]/.test(trimmed);
  const cleanHex = trimmed.replace(/^0[xX]/, '');
  let keyBuffer;

  if (hasHexPrefix) {
    if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
      throw new InvalidSecretError(
        'Malformed hexadecimal HMAC secret: must be exactly 64 hexadecimal characters'
      );
    }
    keyBuffer = Buffer.from(cleanHex, 'hex');
  } else if (/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
    keyBuffer = Buffer.from(cleanHex, 'hex');
  } else {
    keyBuffer = Buffer.from(trimmed, 'utf8');
  }

  if (keyBuffer.length < 32) {
    throw new InvalidSecretError(
      `HMAC secret key must be at least 32 bytes in length, got ${keyBuffer.length} bytes`
    );
  }

  return keyBuffer;
}

/**
 * Derives a domain-separated HMAC-SHA256 hex key for an (IP, email) login pair.
 *
 * @param {string} clientIp - Client IP address
 * @param {string} email - User email address
 * @param {Buffer} secretBuffer - Validated 32+ byte secret key buffer
 * @returns {string} 64-character lowercase hex digest
 * @throws {InvalidIpError|InvalidEmailError|InvalidSecretError} If inputs cannot be canonicalized/normalized
 */
export function derivePairKey(clientIp, email, secretBuffer) {
  if (!Buffer.isBuffer(secretBuffer) || secretBuffer.length < 32) {
    throw new InvalidSecretError('Valid 32+ byte Buffer secret is required for key derivation');
  }

  const canonicalIp = canonicalizeIp(clientIp);
  if (!canonicalIp) {
    throw new InvalidIpError(`Cannot derive pair key from invalid client IP: ${clientIp}`);
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new InvalidEmailError(`Cannot derive pair key from invalid email: ${email}`);
  }

  const payload = encodeTuple('pair', canonicalIp, normalizedEmail);
  return crypto.createHmac('sha256', secretBuffer).update(payload, 'utf8').digest('hex');
}

/**
 * Derives a domain-separated HMAC-SHA256 hex key for an account (email).
 *
 * @param {string} email - User email address
 * @param {Buffer} secretBuffer - Validated 32+ byte secret key buffer
 * @returns {string} 64-character lowercase hex digest
 * @throws {InvalidEmailError|InvalidSecretError} If email cannot be normalized
 */
export function deriveAccountKey(email, secretBuffer) {
  if (!Buffer.isBuffer(secretBuffer) || secretBuffer.length < 32) {
    throw new InvalidSecretError('Valid 32+ byte Buffer secret is required for key derivation');
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new InvalidEmailError(`Cannot derive account key from invalid email: ${email}`);
  }

  const payload = encodeTuple('account', normalizedEmail);
  return crypto.createHmac('sha256', secretBuffer).update(payload, 'utf8').digest('hex');
}

/**
 * Derives a domain-separated HMAC-SHA256 hex hash for an IP observation.
 *
 * @param {string} clientIp - Client IP address
 * @param {Buffer} secretBuffer - Validated 32+ byte secret key buffer
 * @returns {string} 64-character lowercase hex digest
 * @throws {InvalidIpError|InvalidSecretError} If client IP cannot be canonicalized
 */
export function deriveIpHash(clientIp, secretBuffer) {
  if (!Buffer.isBuffer(secretBuffer) || secretBuffer.length < 32) {
    throw new InvalidSecretError('Valid 32+ byte Buffer secret is required for key derivation');
  }

  const canonicalIp = canonicalizeIp(clientIp);
  if (!canonicalIp) {
    throw new InvalidIpError(`Cannot derive IP hash from invalid client IP: ${clientIp}`);
  }

  const payload = encodeTuple('ip', canonicalIp);
  return crypto.createHmac('sha256', secretBuffer).update(payload, 'utf8').digest('hex');
}
