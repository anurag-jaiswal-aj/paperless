import crypto from 'crypto';

/**
 * Constant-time comparison of two strings to prevent timing attacks.
 *
 * @param {string} [provided]
 * @param {string} [expected]
 * @returns {boolean}
 */
export const verifyIngressSecret = (provided, expected) => {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const trimmedExpected = expected.trim();
  if (!trimmedExpected) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(trimmedExpected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
};

const HEALTH_CHECK_PREFIXES = ['/health', '/ready', '/api/health', '/api/ready'];

export const isHealthCheckPath = (path = '') => {
  return HEALTH_CHECK_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(prefix + '/')
  );
};

export const isDirectInternalAdminPath = (path = '') => {
  return path === '/api/admin/quiescence' || path.startsWith('/api/admin/quiescence/');
};

/**
 * Creates ingress gate middleware that validates that incoming requests
 * originated from the authorized reverse proxy (Nginx).
 *
 * When PAPERLESS_INGRESS_SECRET is configured:
 * 1. Health check paths (/api/health, /health, /api/health/ready, /health/ready, /ready)
 *    are always permitted without the secret (to support local Docker / orchestrator health probes).
 * 2. If the request presents a valid X-Paperless-Ingress-Secret header matching the secret:
 *    - The request is authenticated as originating from the trusted ingress proxy.
 *    - Express extracts the sanitized client IP from X-Forwarded-For (populated by Nginx).
 * 3. If the secret is missing or invalid:
 *    - X-Forwarded-For is stripped/ignored, ensuring direct callers cannot spoof req.ip.
 *    - req.ip is locked to req.socket.remoteAddress.
 *    - In production/staging (or if enforce is enabled), the request is rejected with 403 Forbidden.
 *
 * @param {object} [options]
 * @param {string} [options.ingressSecret] - Expected ingress secret (process.env.PAPERLESS_INGRESS_SECRET)
 * @param {string} [options.nodeEnv] - Environment (process.env.NODE_ENV)
 * @param {boolean} [options.enforce] - Whether to enforce 403 rejection on invalid/missing secret
 * @returns {import('express').RequestHandler}
 */
export const createIngressGate = (options = {}) => {
  return (req, res, next) => {
    const ingressSecret = options.ingressSecret !== undefined
      ? options.ingressSecret
      : process.env.PAPERLESS_INGRESS_SECRET;
    const nodeEnv = options.nodeEnv !== undefined
      ? options.nodeEnv
      : process.env.NODE_ENV;

    const trimmedSecret = ingressSecret ? String(ingressSecret).trim() : '';

    // If no ingress secret is configured, bypass the gate
    if (!trimmedSecret) {
      return next();
    }

    // Health check routes always bypass the ingress secret requirement
    // to allow container runtime / orchestrator probes directly to port 5000.
    if (isHealthCheckPath(req.path)) {
      return next();
    }

    // Direct internal admin quiescence routes bypass the Nginx ingress secret requirement
    // because they are reached directly by the backup container on the isolated backend network
    // and are strictly authenticated by their own Bearer BACKUP_INTERNAL_TOKEN.
    if (isDirectInternalAdminPath(req.path)) {
      // Strip forwarded headers so internal admin endpoints use true socket IP for rate limiting
      delete req.headers['x-forwarded-for'];
      delete req.headers['x-forwarded-proto'];
      delete req.headers['x-forwarded-host'];

      const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
      Object.defineProperty(req, 'ip', {
        configurable: true,
        enumerable: true,
        get: () => socketIp
      });
      return next();
    }

    const isEnforced = options.enforce !== undefined
      ? Boolean(options.enforce)
      : (nodeEnv === 'production' || nodeEnv === 'staging');

    const providedSecret = req.headers['x-paperless-ingress-secret'];
    const isValid = verifyIngressSecret(providedSecret, trimmedSecret);

    if (isValid) {
      // Authenticated ingress from trusted reverse proxy.
      // Nginx sets X-Forwarded-For to $remote_addr (the sanitized client IP).
      const forwardedFor = req.headers['x-forwarded-for'];
      if (forwardedFor) {
        // The authoritative client IP forwarded by Nginx is the leftmost address
        const clientIp = String(forwardedFor).split(',')[0].trim();
        if (clientIp) {
          Object.defineProperty(req, 'ip', {
            configurable: true,
            enumerable: true,
            get: () => clientIp
          });
        }
      }
      return next();
    }

    // Direct access without valid ingress secret.
    // Strip forwarded headers so downstream handlers and rate limiters cannot be fooled.
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-forwarded-proto'];
    delete req.headers['x-forwarded-host'];

    const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    Object.defineProperty(req, 'ip', {
      configurable: true,
      enumerable: true,
      get: () => socketIp
    });

    if (isEnforced) {
      return res.status(403).json({
        success: false,
        message: 'Direct access forbidden. Requests must transit through the authorized ingress proxy.'
      });
    }

    return next();
  };
};
