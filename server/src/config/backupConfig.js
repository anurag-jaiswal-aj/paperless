import crypto from 'node:crypto';

/**
 * Standard default lease and watchdog timing values in milliseconds.
 * - INITIAL_LEASE_MS: Default lease granted upon initial quiescence acquisition (60s)
 * - HEARTBEAT_INTERVAL_MS: Expected cadence of caller heartbeats to maintain quiescence (10s)
 * - HEARTBEAT_EXTEND_MS: Amount of time added to current lease expiration per heartbeat (30s)
 * - DRAIN_TIMEOUT_MS: Maximum time allotted for in-flight requests to complete before freeze (5s)
 * - MAX_WATCHDOG_LEASE_MS: Hard ceiling beyond which watchdog forces recovery/unquiescence (180s)
 */
export const BACKUP_DEFAULTS = Object.freeze({
  INITIAL_LEASE_MS: 60000,
  HEARTBEAT_INTERVAL_MS: 10000,
  HEARTBEAT_EXTEND_MS: 30000,
  DRAIN_TIMEOUT_MS: 5000,
  MAX_WATCHDOG_LEASE_MS: 180000,
  HARD_DEADLINE_CEILING_MS: 180000
});

export const MIN_TOKEN_LENGTH = 32;
export const MAX_TOKEN_LENGTH = 128;

/**
 * Custom error class for backup configuration failures.
 */
export class BackupConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupConfigError';
  }
}

/**
 * Computes the Shannon entropy (in bits per character) of a string.
 *
 * @param {string} str
 * @returns {number}
 */
export function calculateShannonEntropy(str) {
  if (!str || typeof str !== 'string') return 0;
  const len = str.length;
  const frequencies = new Map();
  for (let i = 0; i < len; i++) {
    const ch = str[i];
    frequencies.set(ch, (frequencies.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Validates the BACKUP_INTERNAL_TOKEN value for length, formatting, and entropy.
 *
 * @param {unknown} token - Raw token from environment or header
 * @param {object} [options={}]
 * @param {boolean} [options.required=false] - Whether token is strictly required
 * @returns {string|null} Validated token string or null if unprovided and not required
 * @throws {BackupConfigError} If token fails validation or is missing when required
 */
export function validateBackupToken(token, options = {}) {
  const isRequired = options.required ?? false;

  if (token === undefined || token === null || token === '') {
    if (isRequired) {
      throw new BackupConfigError(
        'BACKUP_INTERNAL_TOKEN is required when backup features or quiescence endpoints are active'
      );
    }
    return null;
  }

  if (typeof token !== 'string') {
    throw new BackupConfigError('BACKUP_INTERNAL_TOKEN must be a string');
  }

  const trimmed = token.trim();
  if (!trimmed) {
    throw new BackupConfigError('BACKUP_INTERNAL_TOKEN cannot be empty or whitespace');
  }

  if (trimmed.length < MIN_TOKEN_LENGTH) {
    throw new BackupConfigError(
      `BACKUP_INTERNAL_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters long (received ${trimmed.length})`
    );
  }

  if (trimmed.length > MAX_TOKEN_LENGTH) {
    throw new BackupConfigError(
      `BACKUP_INTERNAL_TOKEN exceeds maximum permitted length of ${MAX_TOKEN_LENGTH} characters (received ${trimmed.length})`
    );
  }

  // Reject known insecure placeholders
  const lower = trimmed.toLowerCase();
  const INSECURE_PATTERNS = [
    'replace_with_',
    'example',
    'secret_token',
    'backup_token',
    'changeme',
    'default_secret',
    'password'
  ];
  for (const pattern of INSECURE_PATTERNS) {
    if (lower.includes(pattern)) {
      throw new BackupConfigError(
        `BACKUP_INTERNAL_TOKEN cannot contain placeholder or insecure patterns ("${pattern}")`
      );
    }
  }

  // Entropy and variety validation
  const uniqueChars = new Set(trimmed).size;
  if (uniqueChars < 8) {
    throw new BackupConfigError(
      `BACKUP_INTERNAL_TOKEN has insufficient entropy: must contain at least 8 distinct characters (got ${uniqueChars})`
    );
  }

  // Frequency check: no single character should dominate the secret
  const charCounts = new Map();
  for (const ch of trimmed) {
    charCounts.set(ch, (charCounts.get(ch) || 0) + 1);
  }
  for (const [ch, count] of charCounts.entries()) {
    if (count / trimmed.length > 0.35) {
      throw new BackupConfigError(
        `BACKUP_INTERNAL_TOKEN has insufficient entropy: character "${ch}" accounts for more than 35% of the token`
      );
    }
  }

  const entropy = calculateShannonEntropy(trimmed);
  if (entropy < 2.8) {
    throw new BackupConfigError(
      `BACKUP_INTERNAL_TOKEN has insufficient entropy (${entropy.toFixed(2)} bits/char): must be a high-entropy secret (e.g. openssl rand -hex 32)`
    );
  }

  return trimmed;
}

/**
 * Parses and validates an integer environment variable with fail-closed semantics.
 *
 * @param {unknown} val - Raw environment value
 * @param {string} varName - Variable name for error context
 * @param {number} defaultValue - Safe default fallback when value is unset/empty
 * @returns {number} Validated positive integer
 * @throws {BackupConfigError} If value is explicitly provided but invalid, malformed, or non-positive
 */
export function parsePositiveInteger(val, varName, defaultValue) {
  if (val === undefined || val === null || val === '') {
    return defaultValue;
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val) || !Number.isInteger(val) || val <= 0) {
      throw new BackupConfigError(`Invalid ${varName}: must be a positive integer, got ${val}`);
    }
    return val;
  }

  if (typeof val !== 'string') {
    throw new BackupConfigError(
      `Invalid ${varName}: must be a string or positive integer, got ${typeof val}`
    );
  }

  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new BackupConfigError(`Invalid ${varName}: must be a positive integer, got "${val}"`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BackupConfigError(`Invalid ${varName}: must be a positive integer, got "${val}"`);
  }

  return parsed;
}

/**
 * Validates backup and disaster recovery configuration against security constraints
 * and fail-closed timing invariants.
 *
 * @param {object} [env=process.env] - Environment dictionary
 * @param {object} [options={}] - Validation options
 * @param {boolean} [options.requireToken] - Whether BACKUP_INTERNAL_TOKEN is strictly required
 * @param {boolean} [options.isBackupEnabled] - Override backup enabled flag
 * @returns {Readonly<{
 *   isBackupEnabled: boolean,
 *   token: string|null,
 *   backupInternalToken: string|null,
 *   initialLeaseMs: number,
 *   heartbeatIntervalMs: number,
 *   heartbeatExtendMs: number,
 *   drainTimeoutMs: number,
 *   maxWatchdogLeaseMs: number,
 *   BACKUP_INTERNAL_TOKEN: string|null,
 *   INITIAL_LEASE_MS: number,
 *   HEARTBEAT_INTERVAL_MS: number,
 *   HEARTBEAT_EXTEND_MS: number,
 *   DRAIN_TIMEOUT_MS: number,
 *   MAX_WATCHDOG_LEASE_MS: number
 * }>}
 * @throws {BackupConfigError} If any configuration value fails validation or violates timing invariants
 */
export function validateBackupConfig(env = process.env, options = {}) {
  // Support flexible argument passing (options as first argument if env is omitted)
  let targetEnv = env;
  let targetOptions = options;
  if (
    env &&
    typeof env === 'object' &&
    !('NODE_ENV' in env) &&
    !('BACKUP_INTERNAL_TOKEN' in env) &&
    ('requireToken' in env || 'isBackupEnabled' in env)
  ) {
    targetOptions = env;
    targetEnv = process.env;
  }

  const isEnabled =
    targetOptions.isBackupEnabled ??
    (targetEnv.BACKUP_ENABLED === 'true' || targetEnv.ENABLE_BACKUP === 'true');
  const requireToken = targetOptions.requireToken ?? isEnabled;

  const token = validateBackupToken(targetEnv.BACKUP_INTERNAL_TOKEN, {
    required: requireToken
  });

  const initialLeaseMs = parsePositiveInteger(
    targetEnv.INITIAL_LEASE_MS ?? targetEnv.BACKUP_LEASE_DURATION_MS,
    'INITIAL_LEASE_MS',
    BACKUP_DEFAULTS.INITIAL_LEASE_MS
  );

  const heartbeatIntervalMs = parsePositiveInteger(
    targetEnv.HEARTBEAT_INTERVAL_MS,
    'HEARTBEAT_INTERVAL_MS',
    BACKUP_DEFAULTS.HEARTBEAT_INTERVAL_MS
  );

  const heartbeatExtendMs = parsePositiveInteger(
    targetEnv.HEARTBEAT_EXTEND_MS ?? targetEnv.BACKUP_HEARTBEAT_EXTEND_MS,
    'HEARTBEAT_EXTEND_MS',
    BACKUP_DEFAULTS.HEARTBEAT_EXTEND_MS
  );

  const drainTimeoutMs = parsePositiveInteger(
    targetEnv.DRAIN_TIMEOUT_MS,
    'DRAIN_TIMEOUT_MS',
    BACKUP_DEFAULTS.DRAIN_TIMEOUT_MS
  );

  const maxWatchdogLeaseMs = parsePositiveInteger(
    targetEnv.MAX_WATCHDOG_LEASE_MS ?? targetEnv.BACKUP_MAX_WATCHDOG_MS,
    'MAX_WATCHDOG_LEASE_MS',
    BACKUP_DEFAULTS.MAX_WATCHDOG_LEASE_MS
  );

  // Invariant 1: Minimum sanity thresholds to prevent resource exhaustion or tight loops
  if (drainTimeoutMs < 100) {
    throw new BackupConfigError(
      `DRAIN_TIMEOUT_MS (${drainTimeoutMs}ms) is too short: must be at least 100ms`
    );
  }

  if (heartbeatIntervalMs < 500) {
    throw new BackupConfigError(
      `HEARTBEAT_INTERVAL_MS (${heartbeatIntervalMs}ms) is too short: must be at least 500ms`
    );
  }

  if (initialLeaseMs < 1000) {
    throw new BackupConfigError(
      `INITIAL_LEASE_MS (${initialLeaseMs}ms) is too short: must be at least 1000ms`
    );
  }

  if (heartbeatExtendMs < 1000) {
    throw new BackupConfigError(
      `HEARTBEAT_EXTEND_MS (${heartbeatExtendMs}ms) is too short: must be at least 1000ms`
    );
  }

  if (maxWatchdogLeaseMs < 5000) {
    throw new BackupConfigError(
      `MAX_WATCHDOG_LEASE_MS (${maxWatchdogLeaseMs}ms) is too short: must be at least 5000ms`
    );
  }

  // Invariant 2: Initial lease cannot exceed max watchdog lease
  if (initialLeaseMs > maxWatchdogLeaseMs) {
    throw new BackupConfigError(
      `INITIAL_LEASE_MS (${initialLeaseMs}ms) cannot exceed MAX_WATCHDOG_LEASE_MS (${maxWatchdogLeaseMs}ms)`
    );
  }

  // Invariant 3: Heartbeat extend cannot exceed max watchdog lease
  if (heartbeatExtendMs > maxWatchdogLeaseMs) {
    throw new BackupConfigError(
      `HEARTBEAT_EXTEND_MS (${heartbeatExtendMs}ms) cannot exceed MAX_WATCHDOG_LEASE_MS (${maxWatchdogLeaseMs}ms)`
    );
  }

  // Invariant 4: Heartbeat interval must be strictly less than extend duration
  if (heartbeatIntervalMs >= heartbeatExtendMs) {
    throw new BackupConfigError(
      `HEARTBEAT_INTERVAL_MS (${heartbeatIntervalMs}ms) must be strictly less than HEARTBEAT_EXTEND_MS (${heartbeatExtendMs}ms)`
    );
  }

  // Invariant 5: Drain timeout must be strictly less than initial lease duration
  if (drainTimeoutMs >= initialLeaseMs) {
    throw new BackupConfigError(
      `DRAIN_TIMEOUT_MS (${drainTimeoutMs}ms) must be strictly less than INITIAL_LEASE_MS (${initialLeaseMs}ms)`
    );
  }

  // Invariant 6: Heartbeat interval must be strictly less than initial lease duration
  if (heartbeatIntervalMs >= initialLeaseMs) {
    throw new BackupConfigError(
      `HEARTBEAT_INTERVAL_MS (${heartbeatIntervalMs}ms) must be strictly less than INITIAL_LEASE_MS (${initialLeaseMs}ms)`
    );
  }

  return Object.freeze({
    isBackupEnabled: isEnabled,
    token,
    backupInternalToken: token,
    BACKUP_INTERNAL_TOKEN: token,
    initialLeaseMs,
    INITIAL_LEASE_MS: initialLeaseMs,
    heartbeatIntervalMs,
    HEARTBEAT_INTERVAL_MS: heartbeatIntervalMs,
    heartbeatExtendMs,
    HEARTBEAT_EXTEND_MS: heartbeatExtendMs,
    drainTimeoutMs,
    DRAIN_TIMEOUT_MS: drainTimeoutMs,
    maxWatchdogLeaseMs,
    MAX_WATCHDOG_LEASE_MS: maxWatchdogLeaseMs,
    hardDeadlineCeilingMs: maxWatchdogLeaseMs,
    HARD_DEADLINE_CEILING_MS: maxWatchdogLeaseMs
  });
}

/**
 * Constant-time comparison of two token strings to prevent timing side-channels.
 *
 * @param {string|null|undefined} providedToken
 * @param {string|null|undefined} expectedToken
 * @returns {boolean}
 */
export function timingSafeCompareToken(providedToken, expectedToken) {
  if (typeof providedToken !== 'string' || typeof expectedToken !== 'string') {
    return false;
  }
  const bufA = Buffer.from(providedToken, 'utf8');
  const bufB = Buffer.from(expectedToken, 'utf8');
  if (bufA.length !== bufB.length) {
    // Perform constant-time dummy check against itself to avoid leaking length differences via early exit timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
