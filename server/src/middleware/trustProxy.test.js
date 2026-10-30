import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { resolveTrustProxy } from '../server.js';

describe('Trust Proxy and Rate Limiting Security', () => {
  describe('resolveTrustProxy Configuration', () => {
    it('defaults to [loopback, linklocal, uniquelocal] in production when TRUST_PROXY is unset', () => {
      expect(resolveTrustProxy(undefined, 'production')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
      expect(resolveTrustProxy('', 'production')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
      expect(resolveTrustProxy(null, 'production')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    });

    it('defaults to [loopback, linklocal, uniquelocal] in staging when TRUST_PROXY is unset', () => {
      expect(resolveTrustProxy(undefined, 'staging')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    });

    it('defaults to false in development and test when TRUST_PROXY is unset', () => {
      expect(resolveTrustProxy(undefined, 'development')).toBe(false);
      expect(resolveTrustProxy(undefined, 'test')).toBe(false);
      expect(resolveTrustProxy(undefined, undefined)).toBe(false);
    });

    it('explicitly parses boolean false and safely maps true to default trusted proxies', () => {
      expect(resolveTrustProxy('false', 'production')).toBe(false);
      expect(resolveTrustProxy('FALSE', 'production')).toBe(false);
      expect(resolveTrustProxy('true', 'development')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
      expect(resolveTrustProxy('TRUE', 'development')).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    });

    it('explicitly parses numeric hop counts', () => {
      expect(resolveTrustProxy('1', 'production')).toBe(1);
      expect(resolveTrustProxy('2', 'production')).toBe(2);
      expect(resolveTrustProxy('0', 'production')).toBe(0);
    });

    it('explicitly parses single subnet or predefined keyword', () => {
      expect(resolveTrustProxy('172.18.0.0/16', 'production')).toBe('172.18.0.0/16');
      expect(resolveTrustProxy('loopback', 'production')).toBe('loopback');
    });

    it('explicitly parses comma-separated lists of subnets and keywords', () => {
      expect(resolveTrustProxy('loopback, 10.0.0.0/8, 172.16.0.0/12', 'production')).toEqual([
        'loopback',
        '10.0.0.0/8',
        '172.16.0.0/12'
      ]);
    });
  });

  describe('Client IP Resolution and Anti-Spoofing Integration', () => {
    function createTestApp(trustSetting) {
      const app = express();
      app.set('trust proxy', trustSetting);

      const testLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 2,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, message: 'Too many requests from this client IP' }
      });

      app.get('/test-ip', (req, res) => {
        res.json({ ip: req.ip, ips: req.ips });
      });

      app.get('/test-rate-limit', testLimiter, (req, res) => {
        res.json({ success: true, ip: req.ip });
      });

      return app;
    }

    it('correctly resolves client IP through trusted private proxy hops', async () => {
      const app = createTestApp(['loopback', 'linklocal', 'uniquelocal']);

      // Simulated proxied request: Real public IP 203.0.113.50 passed through gateway 172.18.0.1
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '203.0.113.50, 172.18.0.1');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.50');
    });

    it('prevents attacker from spoofing client IP by prepending fake IPs to X-Forwarded-For', async () => {
      const app = createTestApp(['loopback', 'linklocal', 'uniquelocal']);

      // Attacker at 203.0.113.50 prepends spoofed 1.1.1.1 before entering Cloudflare / Nginx
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '1.1.1.1, 203.0.113.50, 172.18.0.1');

      expect(res.status).toBe(200);
      // Express stops at the first untrusted IP (203.0.113.50) from the right and ignores 1.1.1.1
      expect(res.body.ip).toBe('203.0.113.50');
    });

    it('prevents attacker from spoofing private IP to bypass proxy boundary', async () => {
      const app = createTestApp(['loopback', 'linklocal', 'uniquelocal']);

      // Attacker at 203.0.113.50 prepends private IP 10.0.0.99
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '10.0.0.99, 203.0.113.50, 172.18.0.1');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.50');
    });

    it('enforces rate limits against the verified client IP regardless of spoofed headers', async () => {
      const app = createTestApp(['loopback', 'linklocal', 'uniquelocal']);

      // Request 1: legitimate client at 203.0.113.77
      const res1 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '203.0.113.77, 172.18.0.1');
      expect(res1.status).toBe(200);

      // Request 2: same client at 203.0.113.77 attempts spoofing with 1.2.3.4
      const res2 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '1.2.3.4, 203.0.113.77, 172.18.0.1');
      expect(res2.status).toBe(200);

      // Request 3: same client at 203.0.113.77 attempts spoofing with 5.6.7.8 -> must be rate limited!
      const res3 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '5.6.7.8, 203.0.113.77, 172.18.0.1');
      expect(res3.status).toBe(429);
      expect(res3.body.message).toContain('Too many requests');

      // Request 4: independent client at 203.0.113.88 is NOT blocked
      const res4 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '203.0.113.88, 172.18.0.1');
      expect(res4.status).toBe(200);
    });

    it('ignores X-Forwarded-For entirely when trust proxy is false', async () => {
      const app = createTestApp(false);

      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '203.0.113.99');

      expect(res.status).toBe(200);
      // When trust proxy is false, req.ip equals socket.remoteAddress (typically 127.0.0.1 in Supertest)
      expect(res.body.ip).not.toBe('203.0.113.99');
    });

    it('safely handles TRUST_PROXY=true by preventing rate-limiting bypass', async () => {
      const trustSetting = resolveTrustProxy('true', 'production');
      expect(trustSetting).not.toBe(true);

      const app = createTestApp(trustSetting);

      // Request 1: legitimate client at 203.0.113.50
      const res1 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '203.0.113.50, 172.18.0.1');
      expect(res1.status).toBe(200);

      // Request 2: same client attempts spoofing with a forged IP prefix
      const res2 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '9.9.9.9, 203.0.113.50, 172.18.0.1');
      expect(res2.status).toBe(200);

      // Request 3: same client must be blocked by rate limiter regardless of spoofed header
      const res3 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '8.8.8.8, 203.0.113.50, 172.18.0.1');
      expect(res3.status).toBe(429);
      expect(res3.body.message).toContain('Too many requests');
    });

    it('supports narrowing trusted proxies to specific Docker subnets (172.16.0.0/12)', async () => {
      const trustSetting = resolveTrustProxy('loopback, 172.16.0.0/12', 'production');
      const app = createTestApp(trustSetting);

      // Public client routed through Docker network gateway
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '203.0.113.50, 172.26.0.1');
      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.50');

      // Private client on 10.0.0.1 attempting to spoof: 10.0.0.1 is not trusted as a proxy
      const resPrivate = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '1.1.1.1, 10.0.0.1, 172.26.0.1');
      // Express stops at 10.0.0.1 because 10.0.0.1 is not in 172.16.0.0/12
      expect(resPrivate.body.ip).toBe('10.0.0.1');
    });

    it('handles Cloudflare Quick Tunnel multi-hop headers safely', async () => {
      const trustSetting = resolveTrustProxy(undefined, 'staging');
      const app = createTestApp(trustSetting);

      // Cloudflare sets public IPv6 or IPv4 client, Nginx appends Docker gateway (172.26.0.1)
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '2406:7400:113:a2a2:845f:9b5d:f9dd:5603, 172.26.0.1');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('2406:7400:113:a2a2:845f:9b5d:f9dd:5603');
    });
  });
});
