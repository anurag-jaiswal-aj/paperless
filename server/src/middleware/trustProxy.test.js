import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { resolveTrustProxy, DEFAULT_TRUSTED_PROXIES } from '../server.js';
import { createIngressGate, verifyIngressSecret, isHealthCheckPath } from './ingressGate.js';
import { getAiRateLimitKey } from '../routes/aiRoutes.js';

describe('Trust Proxy and Rate Limiting Security', () => {
  describe('resolveTrustProxy Configuration', () => {
    it('defaults to [loopback] in production when TRUST_PROXY is unset', () => {
      expect(resolveTrustProxy(undefined, 'production')).toEqual(['loopback']);
      expect(resolveTrustProxy('', 'production')).toEqual(['loopback']);
      expect(resolveTrustProxy(null, 'production')).toEqual(['loopback']);
      expect(DEFAULT_TRUSTED_PROXIES).toEqual(['loopback']);
    });

    it('defaults to [loopback] in staging when TRUST_PROXY is unset', () => {
      expect(resolveTrustProxy(undefined, 'staging')).toEqual(['loopback']);
    });

    it('defaults to false in development and test when TRUST_PROXY is unset', () => {
      expect(resolveTrustProxy(undefined, 'development')).toBe(false);
      expect(resolveTrustProxy(undefined, 'test')).toBe(false);
      expect(resolveTrustProxy(undefined, undefined)).toBe(false);
    });

    it('explicitly parses boolean false and safely maps true to 1 hop', () => {
      expect(resolveTrustProxy('false', 'production')).toBe(false);
      expect(resolveTrustProxy('FALSE', 'production')).toBe(false);
      // Safely maps boolean true to 1 hop (immediate reverse proxy) avoiding express-rate-limit ERR_ERL_PERMISSIVE_TRUST_PROXY
      expect(resolveTrustProxy('true', 'development')).toBe(1);
      expect(resolveTrustProxy('TRUE', 'development')).toBe(1);
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

  describe('Ingress Gate & Secret Verification (ingressGate.js)', () => {
    it('verifies ingress secrets using constant-time comparison', () => {
      expect(verifyIngressSecret('my-secret-key-12345', 'my-secret-key-12345')).toBe(true);
      expect(verifyIngressSecret('wrong-secret-key-123', 'my-secret-key-12345')).toBe(false);
      expect(verifyIngressSecret('short', 'my-secret-key-12345')).toBe(false);
      expect(verifyIngressSecret('', 'my-secret-key-12345')).toBe(false);
      expect(verifyIngressSecret(undefined, 'my-secret-key-12345')).toBe(false);
      expect(verifyIngressSecret('secret', '')).toBe(false);
    });

    it('identifies health check probe paths correctly', () => {
      expect(isHealthCheckPath('/health')).toBe(true);
      expect(isHealthCheckPath('/health/ready')).toBe(true);
      expect(isHealthCheckPath('/ready')).toBe(true);
      expect(isHealthCheckPath('/api/health')).toBe(true);
      expect(isHealthCheckPath('/api/health/ready')).toBe(true);
      expect(isHealthCheckPath('/api/ready')).toBe(true);
      expect(isHealthCheckPath('/api/auth/login')).toBe(false);
      expect(isHealthCheckPath('/api/forms')).toBe(false);
      expect(isHealthCheckPath('/')).toBe(false);
    });

    function createIngressTestApp(options = {}) {
      const app = express();
      app.set('trust proxy', 1);
      app.use(createIngressGate(options));

      const testLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 2,
        standardHeaders: true,
        legacyHeaders: false,
        validate: { xForwardedForHeader: false },
        message: { success: false, message: 'Too many requests from this client IP' }
      });

      app.get('/api/health/ready', (req, res) => {
        res.json({ status: 'ready', ip: req.ip });
      });

      app.get('/api/test-ip', (req, res) => {
        res.json({ ip: req.ip });
      });

      app.get('/api/test-rate-limit', testLimiter, (req, res) => {
        res.json({ success: true, ip: req.ip });
      });

      return app;
    }

    it('1. Direct Express request without ingress secret cannot spoof req.ip (rejected in production/staging)', async () => {
      const app = createIngressTestApp({
        ingressSecret: 'test-shared-ingress-secret',
        nodeEnv: 'production'
      });

      // Direct call without secret attempting to spoof X-Forwarded-For
      const res = await request(app)
        .get('/api/test-ip')
        .set('X-Forwarded-For', '1.2.3.4');

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Direct access forbidden');
    });

    it('1b. Direct Express request without ingress secret has spoofed headers ignored when rejection is disabled', async () => {
      const app = createIngressTestApp({
        ingressSecret: 'test-shared-ingress-secret',
        nodeEnv: 'development',
        enforce: false
      });

      const res = await request(app)
        .get('/api/test-ip')
        .set('X-Forwarded-For', '1.2.3.4');

      expect(res.status).toBe(200);
      // In Supertest, socket remote address is 127.0.0.1 or ::ffff:127.0.0.1, never 1.2.3.4
      expect(res.body.ip).not.toBe('1.2.3.4');
    });

    it('1c. Container health checks directly to Express bypass ingress secret verification', async () => {
      const app = createIngressTestApp({
        ingressSecret: 'test-shared-ingress-secret',
        nodeEnv: 'production'
      });

      // Local container health check probe (e.g. wget http://127.0.0.1:5000/api/health/ready)
      const res = await request(app).get('/api/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
    });

    it('2. Request through Nginx with valid ingress secret has req.ip correctly extracted from Nginx sanitized header', async () => {
      const app = createIngressTestApp({
        ingressSecret: 'test-shared-ingress-secret',
        nodeEnv: 'production'
      });

      const res = await request(app)
        .get('/api/test-ip')
        .set('X-Paperless-Ingress-Secret', 'test-shared-ingress-secret')
        .set('X-Forwarded-For', '203.0.113.195');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.195');
    });

    it('3. Untrusted private-network address is not implicitly trusted when ingress secret is not used', async () => {
      const app = express();
      // Default production configuration without TRUST_PROXY defaults strictly to ['loopback']
      app.set('trust proxy', resolveTrustProxy(undefined, 'production'));

      app.get('/test-ip', (req, res) => {
        res.json({ ip: req.ip });
      });

      // Internal container or VPC client at 172.18.0.5 attempts spoofing 1.1.1.1
      // Because default trusted proxies only includes loopback, 172.18.0.5 is UNTRUSTED
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '1.1.1.1, 172.18.0.5');

      expect(res.status).toBe(200);
      // Stops at untrusted 172.18.0.5, does not adopt 1.1.1.1
      expect(res.body.ip).toBe('172.18.0.5');
    });

    it('4. Configured legitimate proxy is trusted when operator specifies TRUST_PROXY', async () => {
      const app = express();
      // Operator specifies their AWS ALB VPC subnet
      app.set('trust proxy', resolveTrustProxy('10.0.0.0/16, loopback', 'production'));

      app.get('/test-ip', (req, res) => {
        res.json({ ip: req.ip });
      });

      // Legitimate client 203.0.113.44 routed via ALB at 10.0.1.50
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '203.0.113.44, 10.0.1.50');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.44');
    });

    it('5. Multi-hop and Cloudflare headers remain correct when routed through Nginx with ingress secret', async () => {
      const app = createIngressTestApp({
        ingressSecret: 'test-shared-ingress-secret',
        nodeEnv: 'production'
      });

      // Nginx unwound Cloudflare / ALB hops into sanitized $remote_addr (2406:7400:113::1) and passed via ingress
      const res = await request(app)
        .get('/api/test-ip')
        .set('X-Paperless-Ingress-Secret', 'test-shared-ingress-secret')
        .set('X-Forwarded-For', '2406:7400:113::1');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('2406:7400:113::1');
    });

    it('6. Rate limiting uses sanitized client IP and cannot be bypassed without ingress secret', async () => {
      const app = createIngressTestApp({
        ingressSecret: 'test-shared-ingress-secret',
        nodeEnv: 'production'
      });

      // Request 1: legitimate client 203.0.113.77 through Nginx
      const res1 = await request(app)
        .get('/api/test-rate-limit')
        .set('X-Paperless-Ingress-Secret', 'test-shared-ingress-secret')
        .set('X-Forwarded-For', '203.0.113.77');
      expect(res1.status).toBe(200);

      // Request 2: same client through Nginx
      const res2 = await request(app)
        .get('/api/test-rate-limit')
        .set('X-Paperless-Ingress-Secret', 'test-shared-ingress-secret')
        .set('X-Forwarded-For', '203.0.113.77');
      expect(res2.status).toBe(200);

      // Request 3: same client through Nginx exceeds rate limit
      const res3 = await request(app)
        .get('/api/test-rate-limit')
        .set('X-Paperless-Ingress-Secret', 'test-shared-ingress-secret')
        .set('X-Forwarded-For', '203.0.113.77');
      expect(res3.status).toBe(429);
      expect(res3.body.message).toContain('Too many requests');

      // Request 4: independent client 203.0.113.88 is NOT blocked
      const res4 = await request(app)
        .get('/api/test-rate-limit')
        .set('X-Paperless-Ingress-Secret', 'test-shared-ingress-secret')
        .set('X-Forwarded-For', '203.0.113.88');
      expect(res4.status).toBe(200);

      // Request 5: Attacker attempting direct bypass to port 5000 is rejected with 403
      const resDirect = await request(app)
        .get('/api/test-rate-limit')
        .set('X-Forwarded-For', '9.9.9.9');
      expect(resDirect.status).toBe(403);
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
      const app = createTestApp(['loopback', '172.18.0.0/16']);

      // Simulated proxied request: Real public IP 203.0.113.50 passed through gateway 172.18.0.1
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '203.0.113.50, 172.18.0.1');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.50');
    });

    it('prevents attacker from spoofing client IP by prepending fake IPs to X-Forwarded-For', async () => {
      const app = createTestApp(['loopback', '172.18.0.0/16']);

      // Attacker at 203.0.113.50 prepends spoofed 1.1.1.1 before entering Cloudflare / Nginx
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '1.1.1.1, 203.0.113.50, 172.18.0.1');

      expect(res.status).toBe(200);
      // Express stops at the first untrusted IP (203.0.113.50) from the right and ignores 1.1.1.1
      expect(res.body.ip).toBe('203.0.113.50');
    });

    it('prevents attacker from spoofing private IP to bypass proxy boundary', async () => {
      const app = createTestApp(['loopback', '172.18.0.0/16']);

      // Attacker at 203.0.113.50 prepends private IP 10.0.0.99
      const res = await request(app)
        .get('/test-ip')
        .set('X-Forwarded-For', '10.0.0.99, 203.0.113.50, 172.18.0.1');

      expect(res.status).toBe(200);
      expect(res.body.ip).toBe('203.0.113.50');
    });

    it('enforces rate limits against the verified client IP regardless of spoofed headers', async () => {
      const app = createTestApp(['loopback', '172.18.0.0/16']);

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
      expect(trustSetting).toBe(1);

      const app = createTestApp(trustSetting);

      // Request 1: legitimate client at 203.0.113.50
      const res1 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '203.0.113.50');
      expect(res1.status).toBe(200);

      // Request 2: same client attempts spoofing with a forged IP prefix
      const res2 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '203.0.113.50');
      expect(res2.status).toBe(200);

      // Request 3: same client must be blocked by rate limiter
      const res3 = await request(app)
        .get('/test-rate-limit')
        .set('X-Forwarded-For', '203.0.113.50');
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

    describe('P44-INF-02: Multi-Hop Ingress & Reverse Proxy Parity', () => {
      it('correctly isolates distinct client IPs behind a trusted cloud load balancer (ALB/Caddy in 10.0.0.0/8)', async () => {
        const app = createTestApp(['loopback', '10.0.0.0/8', '172.18.0.0/16']);

        // Client A behind ALB (10.0.1.20) and Docker Nginx (172.18.0.1)
        const resA = await request(app)
          .get('/test-rate-limit')
          .set('X-Forwarded-For', '203.0.113.50, 10.0.1.20, 172.18.0.1');
        expect(resA.status).toBe(200);
        expect(resA.body.ip).toBe('203.0.113.50');

        // Client B behind same ALB
        const resB = await request(app)
          .get('/test-rate-limit')
          .set('X-Forwarded-For', '203.0.113.60, 10.0.1.20, 172.18.0.1');
        expect(resB.status).toBe(200);
        expect(resB.body.ip).toBe('203.0.113.60');

        // Exhaust Client A limit
        const resA2 = await request(app)
          .get('/test-rate-limit')
          .set('X-Forwarded-For', '203.0.113.50, 10.0.1.20, 172.18.0.1');
        expect(resA2.status).toBe(200);

        const resABlocked = await request(app)
          .get('/test-rate-limit')
          .set('X-Forwarded-For', '203.0.113.50, 10.0.1.20, 172.18.0.1');
        expect(resABlocked.status).toBe(429);

        // Client B is NOT blocked
        const resB2 = await request(app)
          .get('/test-rate-limit')
          .set('X-Forwarded-For', '203.0.113.60, 10.0.1.20, 172.18.0.1');
        expect(resB2.status).toBe(200);
      });

      it('prevents attacker behind trusted ALB from spoofing IPs across multiple hops', async () => {
        const app = createTestApp(['loopback', '10.0.0.0/8', '172.18.0.0/16']);

        // Attacker at 203.0.113.77 injects 8.8.8.8, 1.1.1.1 before entering ALB (10.0.1.20)
        const res = await request(app)
          .get('/test-ip')
          .set('X-Forwarded-For', '8.8.8.8, 1.1.1.1, 203.0.113.77, 10.0.1.20, 172.18.0.1');

        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('203.0.113.77');
      });

      it('correctly resolves public IPv6 clients behind trusted cloud load balancers', async () => {
        const app = createTestApp(['loopback', '10.0.0.0/8', '172.18.0.0/16']);

        const res = await request(app)
          .get('/test-ip')
          .set('X-Forwarded-For', '2001:db8:85a3::8a2e:370:7334, 10.0.1.20, 172.18.0.1');

        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('2001:db8:85a3::8a2e:370:7334');
      });

      it('accurately resolves single sanitized client IP forwarded by Nginx ($remote_addr overwriting)', async () => {
        const app = createTestApp(1);

        // Nginx strips untrusted client headers and passes single $remote_addr (e.g. 192.168.1.100) via Docker gateway
        const res = await request(app)
          .get('/test-ip')
          .set('X-Forwarded-For', '192.168.1.100');

        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('192.168.1.100');
      });

      it('enforces rate limiting against sanitized private client IP forwarded by Nginx', async () => {
        const app = createTestApp(1);

        // Request 1: private LAN client 192.168.1.100 forwarded by Nginx
        const res1 = await request(app)
          .get('/test-rate-limit')
          .set('X-Forwarded-For', '192.168.1.100');
        expect(res1.status).toBe(200);

        // Request 2: same client
        const res2 = await request(app)
          .get('/test-rate-limit')
          .set('X-Forwarded-For', '192.168.1.100');
        expect(res2.status).toBe(200);

        // Request 3: must be rate limited even if client attempted spoofing at the edge (Nginx stripped it)
        const res3 = await request(app)
          .get('/test-rate-limit')
          .set('X-Forwarded-For', '192.168.1.100');
        expect(res3.status).toBe(429);
        expect(res3.body.message).toContain('Too many requests');
      });
    });
  });

  describe('AI Route Limiter Key Generator (SEC-03)', () => {
    it('keys rate limiting by user._id when user is authenticated', () => {
      const reqWithUser = {
        user: { _id: '507f191e810c19729de860ea' },
        ip: '203.0.113.1'
      };
      const key = getAiRateLimitKey(reqWithUser);
      expect(key).toBe('507f191e810c19729de860ea');
    });

    it('falls back to client IP when user is unauthenticated', () => {
      const reqWithoutUser = {
        user: null,
        ip: '203.0.113.1'
      };
      const key = getAiRateLimitKey(reqWithoutUser);
      expect(key).toBe('203.0.113.1');
    });
  });
});
