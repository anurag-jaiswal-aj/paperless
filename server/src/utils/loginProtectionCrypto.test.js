import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  normalizeEmail,
  parseIPv6Words,
  canonicalizeIPv6Words,
  canonicalizeIp,
  extractClientIp,
  encodeTuple,
  parseHmacSecret,
  derivePairKey,
  deriveAccountKey,
  deriveIpHash,
  InvalidSecretError,
  InvalidIpError,
  InvalidEmailError,
  DEV_FALLBACK_SECRET
} from './loginProtectionCrypto.js';

describe('Login Protection Crypto & Normalization Suite (Stage 3.1)', () => {
  const TEST_SECRET_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const TEST_SECRET_BUFFER = Buffer.from(TEST_SECRET_HEX, 'hex');

  // =========================================================================
  // 1. Email Normalization Tests
  // =========================================================================
  describe('Email Normalization (Paperless Pipeline Semantics)', () => {
    it('trims leading and trailing whitespace and converts uppercase to lowercase', () => {
      expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
      expect(normalizeEmail('\tUser.Name+Tag@Domain.Org\n')).toBe('user.name+tag@domain.org');
    });

    it('does not apply NFKC normalization to preserve existing login identity semantics', () => {
      // Compatibility decomposition character: Kelvin sign \u212A -> 'K' in NFKC
      // Under simple toLowerCase(), \u212A remains \u212A or becomes \u006B depending on engine,
      // but ligature \uFB01 ('fi') does NOT decompose into 'f' and 'i'.
      const ligatureEmail = '\uFB01le@example.com';
      expect(normalizeEmail(ligatureEmail)).toBe('\uFB01le@example.com');
      expect(normalizeEmail(ligatureEmail)).not.toBe('file@example.com');
    });

    it('returns empty string for non-string, null, and undefined inputs', () => {
      expect(normalizeEmail(null)).toBe('');
      expect(normalizeEmail(undefined)).toBe('');
      expect(normalizeEmail(12345)).toBe('');
      expect(normalizeEmail({})).toBe('');
      expect(normalizeEmail([])).toBe('');
      expect(normalizeEmail('')).toBe('');
      expect(normalizeEmail('   ')).toBe('');
    });
  });

  // =========================================================================
  // 2. IPv6 Parsing and Canonicalization Tests (RFC 5952 & RFC 4291)
  // =========================================================================
  describe('IPv6 Parsing and Canonicalization', () => {
    describe('parseIPv6Words', () => {
      it('parses valid IPv6 strings into exactly eight 16-bit words', () => {
        const words = parseIPv6Words('2001:db8::1428:57ab');
        expect(words).toHaveLength(8);
        expect(words).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0x1428, 0x57ab]);
      });

      it('parses embedded IPv4 addresses while preserving zero compression marker', () => {
        // 2001:db8::192.0.2.1 -> 192.0.2.1 is [0xc000, 0x0201]
        const w1 = parseIPv6Words('2001:db8::192.0.2.1');
        expect(w1).toHaveLength(8);
        expect(w1).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0xc000, 0x0201]);

        // ::192.0.2.1
        const w2 = parseIPv6Words('::192.0.2.1');
        expect(w2).toHaveLength(8);
        expect(w2).toEqual([0, 0, 0, 0, 0, 0, 0xc000, 0x0201]);

        // ::ffff:192.0.2.1
        const w3 = parseIPv6Words('::ffff:192.0.2.1');
        expect(w3).toHaveLength(8);
        expect(w3).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201]);

        // 0:0:0:0:0:ffff:192.0.2.1
        const w4 = parseIPv6Words('0:0:0:0:0:ffff:192.0.2.1');
        expect(w4).toHaveLength(8);
        expect(w4).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201]);
      });

      it('rejects invalid IPv6 strings, invalid octets, and invalid word counts', () => {
        expect(parseIPv6Words('not-an-ip')).toBeNull();
        expect(parseIPv6Words('2001:db8::256.0.0.1')).toBeNull();
        expect(parseIPv6Words('2001:db8::192.0.2')).toBeNull(); // 3 octets
        expect(parseIPv6Words('2001:db8::192.0.2.1.1')).toBeNull(); // 5 octets
        expect(parseIPv6Words('2001:db8::192.0.2.01')).toBeNull(); // leading zero
        expect(parseIPv6Words('2001:db8:0:0:0:1:0:0:1')).toBeNull(); // 9 words
        expect(parseIPv6Words('2001::1::2')).toBeNull(); // double ::
        expect(parseIPv6Words('')).toBeNull();
        expect(parseIPv6Words(null)).toBeNull();
      });
    });

    describe('canonicalizeIPv6Words & canonicalizeIp', () => {
      it('formats raw word arrays directly via canonicalizeIPv6Words', () => {
        const words = [0x2001, 0x0db8, 0, 0, 0, 0, 0x1428, 0x57ab];
        expect(canonicalizeIPv6Words(words)).toBe('2001:db8::1428:57ab');
        expect(canonicalizeIPv6Words(null)).toBeNull();
        expect(canonicalizeIPv6Words([1, 2, 3])).toBeNull();
      });

      it('formats expanded and compressed representations identically', () => {
        const expanded = '2001:0db8:0000:0000:0000:0000:1428:57ab';
        const compressed = '2001:db8::1428:57ab';
        expect(canonicalizeIp(expanded)).toBe('2001:db8::1428:57ab');
        expect(canonicalizeIp(compressed)).toBe('2001:db8::1428:57ab');
        expect(canonicalizeIp(expanded)).toBe(canonicalizeIp(compressed));
      });

      it('converts uppercase hexadecimal to lowercase (RFC 5952 Rule 4.3)', () => {
        const upper = '2001:DB8:0:0:0:0:1428:57AB';
        expect(canonicalizeIp(upper)).toBe('2001:db8::1428:57ab');
      });

      it('compresses the longest run of zeros (RFC 5952 Rule 4.2.1)', () => {
        // Two zero runs: index 2..3 (length 2), index 5..7 (length 3). Longest run wins.
        const ip = '2001:db8:0:0:1:0:0:0';
        expect(canonicalizeIp(ip)).toBe('2001:db8:0:0:1::');
      });

      it('tie-breaks equal-length zero runs by compressing the first run (RFC 5952 Rule 4.2.3)', () => {
        // Two zero runs: index 2..3 (length 2) and index 5..6 (length 2). First run wins.
        const ip = '2001:db8:0:0:1:0:0:1';
        expect(canonicalizeIp(ip)).toBe('2001:db8::1:0:0:1');
      });

      it('does not compress a single 16-bit zero field (RFC 5952 Rule 4.2.2)', () => {
        const ip = '2001:db8:0:1:0:2:0:3';
        expect(canonicalizeIp(ip)).toBe('2001:db8:0:1:0:2:0:3');
      });

      it('correctly handles loopback and unspecified addresses', () => {
        expect(canonicalizeIp('0:0:0:0:0:0:0:1')).toBe('::1');
        expect(canonicalizeIp('::1')).toBe('::1');
        expect(canonicalizeIp('0:0:0:0:0:0:0:0')).toBe('::');
        expect(canonicalizeIp('::')).toBe('::');
      });

      it('unwraps IPv4-mapped IPv6 addresses to canonical IPv4 dotted-quad', () => {
        expect(canonicalizeIp('::ffff:192.168.1.1')).toBe('192.168.1.1');
        expect(canonicalizeIp('::ffff:c0a8:0101')).toBe('192.168.1.1');
        expect(canonicalizeIp('0:0:0:0:0:ffff:192.168.1.1')).toBe('192.168.1.1');
        expect(canonicalizeIp('::FFFF:192.168.1.1')).toBe('192.168.1.1');
      });

      it('formats embedded IPv4 addresses correctly in canonical RFC 5952 form', () => {
        expect(canonicalizeIp('2001:db8::192.0.2.1')).toBe('2001:db8::c000:201');
        expect(canonicalizeIp('::192.0.2.1')).toBe('::c000:201');
      });
    });

    describe('IPv4 Canonicalization', () => {
      it('canonicalizes standard IPv4 addresses', () => {
        expect(canonicalizeIp('192.168.1.1')).toBe('192.168.1.1');
        expect(canonicalizeIp('10.0.0.1')).toBe('10.0.0.1');
        expect(canonicalizeIp('  127.0.0.1  ')).toBe('127.0.0.1');
      });

      it('rejects invalid IPv4 addresses and leading-zero octets', () => {
        expect(canonicalizeIp('10.0.0.01')).toBeNull(); // leading zero rejected
        expect(canonicalizeIp('256.0.0.1')).toBeNull(); // octet > 255
        expect(canonicalizeIp('192.168.1')).toBeNull(); // 3 octets
        expect(canonicalizeIp('192.168.1.1.1')).toBeNull(); // 5 octets
      });
    });
  });

  // =========================================================================
  // 3. Client IP Extraction Tests (Express Integration)
  // =========================================================================
  describe('extractClientIp', () => {
    it('extracts and canonicalizes IP from req.ip when present', () => {
      const req = { ip: '::ffff:192.168.1.50' };
      expect(extractClientIp(req)).toBe('192.168.1.50');
    });

    it('falls back to req.socket.remoteAddress when req.ip is absent', () => {
      const req = { socket: { remoteAddress: '2001:0db8:0000:0000:0000:0000:1428:57ab' } };
      expect(extractClientIp(req)).toBe('2001:db8::1428:57ab');
    });

    it('falls back to req.connection.remoteAddress when socket is absent', () => {
      const req = { connection: { remoteAddress: '10.0.0.1' } };
      expect(extractClientIp(req)).toBe('10.0.0.1');
    });

    it('does not trust spoofed unparsed headers directly, relying strictly on resolved req.ip', () => {
      // An attacker passes spoofed X-Forwarded-For, but Express resolved req.ip to the trusted gateway 10.0.0.1
      const req = {
        headers: { 'x-forwarded-for': '203.0.113.195, 198.51.100.1' },
        ip: '10.0.0.1'
      };
      expect(extractClientIp(req)).toBe('10.0.0.1');
    });

    it('returns null for missing, malformed, or invalid request objects', () => {
      expect(extractClientIp(null)).toBeNull();
      expect(extractClientIp({})).toBeNull();
      expect(extractClientIp({ ip: 'invalid-ip-string' })).toBeNull();
      expect(extractClientIp({ socket: { remoteAddress: '' } })).toBeNull();
    });
  });

  // =========================================================================
  // 4. Netstring Tuple Encoding Tests
  // =========================================================================
  describe('encodeTuple Framing', () => {
    it('uses UTF-8 byte lengths rather than JavaScript string length', () => {
      // 'é' is 1 UTF-16 code unit, but 2 UTF-8 bytes
      const singleCharMultibyte = 'é';
      expect(singleCharMultibyte.length).toBe(1);
      expect(Buffer.byteLength(singleCharMultibyte, 'utf8')).toBe(2);
      expect(encodeTuple('domain', singleCharMultibyte)).toBe('6:domain|2:é');

      // '🔥' is 2 UTF-16 code units (surrogate pair), but 4 UTF-8 bytes
      const emoji = '🔥';
      expect(emoji.length).toBe(2);
      expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);
      expect(encodeTuple('fire', emoji)).toBe('4:fire|4:🔥');
    });

    it('encodes multibyte Unicode emails with exact byte length framing', () => {
      const email = 'josé@example.com';
      expect(email.length).toBe(16);
      expect(Buffer.byteLength(email, 'utf8')).toBe(17);
      expect(encodeTuple('account', email)).toBe('7:account|17:josé@example.com');
    });

    it('prevents collisions when inputs contain delimiters (colons, pipes, digits)', () => {
      const t1 = encodeTuple('pair', '1.2.3.4', 'foo:bar@example.com');
      const t2 = encodeTuple('pair', '1.2.3.4:foo', 'bar@example.com');

      expect(t1).toBe('4:pair|7:1.2.3.4|19:foo:bar@example.com');
      expect(t2).toBe('4:pair|11:1.2.3.4:foo|15:bar@example.com');
      expect(t1).not.toBe(t2);

      const p1 = encodeTuple('pair', '10.0.0.1', 'user|test:1@example.com');
      const p2 = encodeTuple('pair', '10.0.0.1|user', 'test:1@example.com');
      expect(p1).toBe('4:pair|8:10.0.0.1|23:user|test:1@example.com');
      expect(p2).toBe('4:pair|13:10.0.0.1|user|18:test:1@example.com');
      expect(p1).not.toBe(p2);
    });

    it('handles empty string fields safely', () => {
      expect(encodeTuple('pair', '', 'user@example.com')).toBe('4:pair|0:|16:user@example.com');
    });
  });

  // =========================================================================
  // 5. Secret Parsing and Validation Tests
  // =========================================================================
  describe('parseHmacSecret', () => {
    it('parses valid 64-character hexadecimal strings into exactly 32 bytes', () => {
      const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const buf = parseHmacSecret(hex);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBe(32);
      expect(buf.toString('hex')).toBe(hex);
    });

    it('strips optional 0x and 0X prefixes before hex parsing', () => {
      const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const b1 = parseHmacSecret('0x' + hex);
      const b2 = parseHmacSecret('0X' + hex);
      expect(b1.length).toBe(32);
      expect(b2.length).toBe(32);
      expect(b1.toString('hex')).toBe(hex);
      expect(b2.toString('hex')).toBe(hex);
    });

    it('trims leading and trailing whitespace', () => {
      const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const buf = parseHmacSecret(`  ${hex}  \n`);
      expect(buf.length).toBe(32);
      expect(buf.toString('hex')).toBe(hex);
    });

    it('accepts UTF-8 secrets with at least 32 bytes', () => {
      const ascii32 = 'a'.repeat(32);
      const buf = parseHmacSecret(ascii32);
      expect(buf.length).toBe(32);
      expect(buf.toString('utf8')).toBe(ascii32);

      // Multibyte UTF-8 secret: 16 characters of 2 bytes each = 32 bytes
      const multi16 = 'é'.repeat(16);
      const bufMulti = parseHmacSecret(multi16);
      expect(bufMulti.length).toBe(32);
    });

    it('rejects secrets with fewer than 32 bytes', () => {
      expect(() => parseHmacSecret('a'.repeat(31))).toThrow(InvalidSecretError);
      expect(() => parseHmacSecret('a'.repeat(31))).toThrow(/at least 32 bytes/);
    });

    it('rejects empty and whitespace-only secrets', () => {
      expect(() => parseHmacSecret('')).toThrow(InvalidSecretError);
      expect(() => parseHmacSecret('   ')).toThrow(InvalidSecretError);
    });

    it('rejects malformed hexadecimal inputs', () => {
      // 0x prefix but invalid characters
      expect(() => parseHmacSecret('0x' + 'a'.repeat(63) + 'g')).toThrow(InvalidSecretError);
      expect(() => parseHmacSecret('0x' + 'a'.repeat(63) + 'g')).toThrow(/Malformed hexadecimal/);

      // 0x prefix but wrong length (63 characters)
      expect(() => parseHmacSecret('0x' + 'a'.repeat(63))).toThrow(InvalidSecretError);
      // 0x prefix but wrong length (65 characters)
      expect(() => parseHmacSecret('0x' + 'a'.repeat(65))).toThrow(InvalidSecretError);
    });

    it('throws InvalidSecretError if secret is missing and protection is enabled', () => {
      expect(() => parseHmacSecret(undefined, { isProtectionEnabled: true, env: 'test' })).toThrow(
        InvalidSecretError
      );
      expect(() =>
        parseHmacSecret(null, { isProtectionEnabled: true, env: 'development' })
      ).toThrow(InvalidSecretError);
    });

    it('allows development fallback secret strictly when protection is disabled and env is test/dev', () => {
      const bufTest = parseHmacSecret(undefined, { isProtectionEnabled: false, env: 'test' });
      expect(bufTest.toString('utf8')).toBe(DEV_FALLBACK_SECRET);

      const bufDev = parseHmacSecret(undefined, {
        isProtectionEnabled: false,
        env: 'development'
      });
      expect(bufDev.toString('utf8')).toBe(DEV_FALLBACK_SECRET);
    });

    it('rejects missing secret in production or staging even if protection is disabled', () => {
      expect(() =>
        parseHmacSecret(undefined, { isProtectionEnabled: false, env: 'production' })
      ).toThrow(InvalidSecretError);
      expect(() =>
        parseHmacSecret(undefined, { isProtectionEnabled: false, env: 'staging' })
      ).toThrow(InvalidSecretError);
    });
  });

  // =========================================================================
  // 6. Domain-Separated Key Derivation Tests
  // =========================================================================
  describe('Domain-Separated Key Derivations', () => {
    it('derives consistent 64-char hex pair keys with domain "pair"', () => {
      const key1 = derivePairKey('192.168.1.1', 'alice@example.com', TEST_SECRET_BUFFER);
      expect(key1).toMatch(/^[0-9a-f]{64}$/);

      // Equivalent IP produces identical key
      const key2 = derivePairKey('::ffff:192.168.1.1', 'Alice@Example.COM', TEST_SECRET_BUFFER);
      expect(key1).toBe(key2);
    });

    it('derives consistent 64-char hex account keys with domain "account"', () => {
      const key1 = deriveAccountKey('alice@example.com', TEST_SECRET_BUFFER);
      expect(key1).toMatch(/^[0-9a-f]{64}$/);

      const key2 = deriveAccountKey('  Alice@Example.COM  ', TEST_SECRET_BUFFER);
      expect(key1).toBe(key2);
    });

    it('derives consistent 64-char hex IP hashes with domain "ip"', () => {
      const hash1 = deriveIpHash('2001:0db8:0000:0000:0000:0000:1428:57ab', TEST_SECRET_BUFFER);
      const hash2 = deriveIpHash('2001:db8::1428:57ab', TEST_SECRET_BUFFER);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      expect(hash1).toBe(hash2);
    });

    it('enforces strict domain separation preventing cross-domain collision', () => {
      // Even if raw inputs were identical or empty, domain prefixes prevent collisions
      const pairKey = derivePairKey('127.0.0.1', 'root@example.com', TEST_SECRET_BUFFER);
      const accountKey = deriveAccountKey('root@example.com', TEST_SECRET_BUFFER);
      const ipHash = deriveIpHash('127.0.0.1', TEST_SECRET_BUFFER);

      expect(pairKey).not.toBe(accountKey);
      expect(pairKey).not.toBe(ipHash);
      expect(accountKey).not.toBe(ipHash);
    });

    it('throws InvalidIpError or InvalidEmailError when inputs cannot be normalized', () => {
      expect(() => derivePairKey('invalid-ip', 'user@example.com', TEST_SECRET_BUFFER)).toThrow(
        InvalidIpError
      );
      expect(() => derivePairKey('127.0.0.1', '', TEST_SECRET_BUFFER)).toThrow(InvalidEmailError);
      expect(() => deriveAccountKey('', TEST_SECRET_BUFFER)).toThrow(InvalidEmailError);
      expect(() => deriveIpHash('not-an-ip', TEST_SECRET_BUFFER)).toThrow(InvalidIpError);
    });

    it('throws InvalidSecretError if secretBuffer is invalid or shorter than 32 bytes', () => {
      expect(() => derivePairKey('127.0.0.1', 'user@example.com', 'string-not-buf')).toThrow(
        InvalidSecretError
      );
      expect(() =>
        derivePairKey('127.0.0.1', 'user@example.com', Buffer.from('short-key'))
      ).toThrow(InvalidSecretError);
    });
  });

  // =========================================================================
  // 7. Security and Integrity Tests
  // =========================================================================
  describe('Security and Determinism', () => {
    it('produces deterministic output for repeated calls with identical inputs', () => {
      const k1 = derivePairKey('192.168.1.1', 'user@example.com', TEST_SECRET_BUFFER);
      const k2 = derivePairKey('192.168.1.1', 'user@example.com', TEST_SECRET_BUFFER);
      expect(k1).toBe(k2);
    });

    it('produces completely different keys for different secrets', () => {
      const otherSecret = crypto.randomBytes(32);
      const k1 = derivePairKey('192.168.1.1', 'user@example.com', TEST_SECRET_BUFFER);
      const k2 = derivePairKey('192.168.1.1', 'user@example.com', otherSecret);
      expect(k1).not.toBe(k2);
    });

    it('never leaks raw credentials in derived hashes or payloads', () => {
      const email = 'sensitive-user@private-domain.com';
      const ip = '198.51.100.42';
      const hash = derivePairKey(ip, email, TEST_SECRET_BUFFER);

      expect(hash).not.toContain(email);
      expect(hash).not.toContain(ip);
      expect(hash).toHaveLength(64);
    });
  });
});
