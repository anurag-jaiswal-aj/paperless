import mongoose from 'mongoose';

/**
 * Constants for Progressive Lockout Escalation and Inactivity Decay
 * Strictly aligns with stage_2_2_phase3_implementation_plan.md Section 3
 */
export const INACTIVITY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const TIER_15M_MS = 15 * 60 * 1000; // 15 minutes (failures 5-9)
export const TIER_60M_MS = 60 * 60 * 1000; // 60 minutes (failures 10-14)
export const TIER_24H_MS = 24 * 60 * 60 * 1000; // 24 hours (failures 15+)
export const TTL_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours TTL purge
export const COLLECTION_NAME = 'login_pairs';

export const LOCKOUT_THRESHOLDS = Object.freeze({
  TIER_1_MAX_FAILURES: 4,
  TIER_2_MIN_FAILURES: 5,
  TIER_2_MAX_FAILURES: 9,
  TIER_3_MIN_FAILURES: 10,
  TIER_3_MAX_FAILURES: 14,
  TIER_4_MIN_FAILURES: 15
});

/**
 * Pure helper: Calculate lockout duration in milliseconds based on consecutive failed attempts.
 * Returns 0 if failedAttempts < 5.
 *
 * @param {number} failedAttempts
 * @returns {number} duration in milliseconds
 */
export function calculateLockoutDurationMs(failedAttempts) {
  const attempts =
    typeof failedAttempts === 'number' && Number.isFinite(failedAttempts)
      ? Math.max(0, Math.floor(failedAttempts))
      : 0;

  if (attempts < LOCKOUT_THRESHOLDS.TIER_2_MIN_FAILURES) {
    return 0;
  }
  if (attempts <= LOCKOUT_THRESHOLDS.TIER_2_MAX_FAILURES) {
    return TIER_15M_MS;
  }
  if (attempts <= LOCKOUT_THRESHOLDS.TIER_3_MAX_FAILURES) {
    return TIER_60M_MS;
  }
  return TIER_24H_MS;
}

/**
 * Pure helper: Calculate lockout expiration date based on consecutive failed attempts and base date.
 * Returns null if failedAttempts < 5.
 *
 * @param {number} failedAttempts
 * @param {Date} [baseDate=new Date()]
 * @returns {Date|null}
 */
export function calculateLockoutUntil(failedAttempts, baseDate = new Date()) {
  const durationMs = calculateLockoutDurationMs(failedAttempts);
  if (durationMs === 0) {
    return null;
  }
  const baseTime = baseDate instanceof Date ? baseDate.getTime() : new Date(baseDate).getTime();
  return new Date(baseTime + durationMs);
}

/**
 * Pure helper: Check if a lockout is actively in effect at the given point in time.
 *
 * @param {Date|null|undefined} lockedUntil
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
export function isLockoutActive(lockedUntil, now = new Date()) {
  if (!lockedUntil) {
    return false;
  }
  const targetTime =
    lockedUntil instanceof Date ? lockedUntil.getTime() : new Date(lockedUntil).getTime();
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return targetTime > currentTime;
}

/**
 * Pure helper: Check whether inactivity decay has elapsed according to Section 3.2 rules.
 * Unified inactivity reference:
 * - When lockedUntil !== null: measured from lockedUntil (lockout expiry)
 * - When lockedUntil === null: measured from lastAttemptAt
 *
 * @param {Object} state
 * @param {Date|null} [state.lockedUntil]
 * @param {Date|null} [state.lastAttemptAt]
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
export function isDecayed(state, now = new Date()) {
  if (!state || typeof state !== 'object') {
    return false;
  }
  const { lockedUntil = null, lastAttemptAt = null } = state;
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (lockedUntil !== null && lockedUntil !== undefined) {
    const lockExpiryTime =
      lockedUntil instanceof Date ? lockedUntil.getTime() : new Date(lockedUntil).getTime();
    return currentTime - lockExpiryTime > INACTIVITY_WINDOW_MS;
  }

  if (lastAttemptAt !== null && lastAttemptAt !== undefined) {
    const attemptTime =
      lastAttemptAt instanceof Date ? lastAttemptAt.getTime() : new Date(lastAttemptAt).getTime();
    return currentTime - attemptTime > INACTIVITY_WINDOW_MS;
  }

  return false;
}

/**
 * Mongoose Schema definition for LoginPair
 * Tracks progressive authentication failures and lockouts per (IP, Account) pair.
 */
const loginPairSchema = new mongoose.Schema(
  {
    // HMAC-SHA256(secret, encodeTuple('pair', canonicalIp, normalizedEmail))
    key: {
      type: String,
      required: [true, 'Pair key is required'],
      unique: true,
      trim: true
    },
    // Consecutive failed authentication attempts
    failedAttempts: {
      type: Number,
      required: [true, 'Failed attempts count is required'],
      default: 0,
      min: [0, 'Failed attempts cannot be negative']
    },
    // Timestamp until which the pair is locked out; null if not currently locked
    lockedUntil: {
      type: Date,
      default: null
    },
    // Timestamp of the most recent authentication attempt
    lastAttemptAt: {
      type: Date,
      default: null
    },
    // Optimistic Concurrency Control (OCC) revision counter for safe deletes/updates
    revision: {
      type: Number,
      required: [true, 'Revision is required'],
      default: 0,
      min: [0, 'Revision cannot be negative']
    },
    // TTL index timestamp: automatically removes stale pair documents 48h after activity
    expiresAt: {
      type: Date,
      required: [true, 'Expiry date is required'],
      index: { expires: 0 }
    }
  },
  {
    collection: COLLECTION_NAME,
    timestamps: false,
    versionKey: false
  }
);

// Instance method: check if document currently has an active lockout
loginPairSchema.methods.isLocked = function (now = new Date()) {
  return isLockoutActive(this.lockedUntil, now);
};

// Instance method: get remaining lockout seconds (clamped to 0)
loginPairSchema.methods.getRemainingLockoutSeconds = function (now = new Date()) {
  if (!this.lockedUntil) {
    return 0;
  }
  const targetTime = this.lockedUntil.getTime();
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const diffMs = targetTime - currentTime;
  return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0;
};

// Instance method: check if document has decayed due to inactivity
loginPairSchema.methods.isDecayed = function (now = new Date()) {
  return isDecayed({ lockedUntil: this.lockedUntil, lastAttemptAt: this.lastAttemptAt }, now);
};

// Static methods attaching calculation helpers to the model
loginPairSchema.statics.calculateLockoutDurationMs = calculateLockoutDurationMs;
loginPairSchema.statics.calculateLockoutUntil = calculateLockoutUntil;
loginPairSchema.statics.isLockoutActive = isLockoutActive;
loginPairSchema.statics.isDecayed = isDecayed;

const LoginPair =
  mongoose.models.LoginPair || mongoose.model('LoginPair', loginPairSchema, COLLECTION_NAME);

export { loginPairSchema };
export default LoginPair;
