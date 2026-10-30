import { URL } from 'url';

/**
 * Parses and returns the canonical set of trusted origins from environment configuration.
 * Always normalizes origins to their protocol + hostname + port (canonical origin).
 */
export const getTrustedOrigins = () => {
  const origins = new Set();
  const raw = [process.env.TRUSTED_ORIGINS, process.env.FRONTEND_URL]
    .filter(Boolean)
    .join(',');

  if (raw) {
    raw.split(',').forEach((item) => {
      const trimmed = item.trim();
      if (!trimmed) return;
      try {
        const parsed = new URL(trimmed);
        origins.add(parsed.origin);
      } catch {
        // Discard invalid URLs
      }
    });
  }

  // Provide safe local defaults for development or test environments if none configured
  if (origins.size === 0 && process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('http://localhost:5000');
    origins.add('http://localhost:5001');
  }

  return origins;
};

/**
 * Validates whether a given origin string exactly matches a configured trusted origin.
 * Rejects 'null', non-string values, and malformed origins.
 */
export const isTrustedOrigin = (origin) => {
  if (!origin || typeof origin !== 'string') return false;
  if (origin === 'null') return false;

  const trusted = getTrustedOrigins();
  try {
    const parsed = new URL(origin);
    return trusted.has(parsed.origin);
  } catch {
    return false;
  }
};

/**
 * Determines whether the request is a public form submission.
 * Public responses (POST /api/responses/:formId) are unauthenticated end-user
 * form submissions that do not require auth cookies or origin verification.
 */
export const isPublicFormSubmission = (req) => {
  if (req.method !== 'POST') return false;
  const path = (req.originalUrl || req.path || '').split('?')[0];
  // Match /api/responses/:formId or /responses/:formId (with optional trailing slash, excluding sub-paths like /export, /analytics, /file)
  return /^\/(?:api\/)?responses\/[a-zA-Z0-9_-]+\/?$/.test(path);
};

/**
 * Centralized CSRF and request-origin protection middleware.
 * Enforces strict Origin header validation on state-changing requests
 * that carry ambient browser credentials (cookies) or mutate session state.
 */
export const csrfProtection = (req, res, next) => {
  // 1. Safe HTTP methods do not mutate state: allow immediately
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // 2. Public form submission access model: allow unauthenticated respondents
  if (isPublicFormSubmission(req)) {
    return next();
  }

  const originHeader = req.headers.origin;
  const hasAuthCookies = Boolean(
    req.cookies && (req.cookies.token || req.cookies.refreshToken)
  );
  const hasBearerAuth = Boolean(
    req.headers.authorization &&
      typeof req.headers.authorization === 'string' &&
      req.headers.authorization.startsWith('Bearer ')
  );

  // 3. If an Origin header is explicitly supplied, validate it strictly
  if (originHeader !== undefined) {
    if (isTrustedOrigin(originHeader)) {
      return next();
    }
    // Origin is untrusted, 'null', or malformed: reject request
    return res.status(403).json({
      success: false,
      message: 'Forbidden: invalid or untrusted request origin'
    });
  }

  // 4. Origin header is missing (req.headers.origin === undefined):
  // 4a. If ambient auth cookies are present, reject.
  // Authenticated browser sessions MUST supply a valid Origin header on mutations.
  if (hasAuthCookies) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: invalid or untrusted request origin'
    });
  }

  // 4b. Session mutation endpoints (refresh and logout)
  const path = (req.originalUrl || req.path || '').split('?')[0];
  const isSessionMutationEndpoint = /\/auth\/(?:refresh|logout)$/.test(path);
  if (isSessionMutationEndpoint) {
    // Logout with Bearer token and NO cookies is a legitimate non-browser client exception
    if (hasBearerAuth && !hasAuthCookies) {
      return next();
    }
    // Otherwise, refresh or cookie-based logout without an Origin header is rejected
    return res.status(403).json({
      success: false,
      message: 'Forbidden: invalid or untrusted request origin'
    });
  }

  // 4c. Deliberate non-browser API client exception:
  // Clients presenting explicit Bearer tokens without ambient cookies are immune to browser CSRF.
  if (hasBearerAuth && !hasAuthCookies) {
    return next();
  }

  // 4d. Unauthenticated public auth endpoints (login, register, forgot/reset password)
  // Non-browser tools (e.g. curl/Postman) without cookies can register or log in.
  const isPublicAuthRoute = /\/auth\/(?:login|register|forgotpassword|resetpassword(?:\/[^/]+)?)$/.test(path);
  if (isPublicAuthRoute && !hasAuthCookies) {
    return next();
  }

  // 4e. Any other protected state-changing endpoint without Origin and without credentials
  // Will be rejected by auth middleware or rejected here for safety.
  return next();
};

