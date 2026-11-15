import mongoose from 'mongoose';

/**
 * Constants for Cross-IP Spray Detection and Account Telemetry
 * Aligns with stage_2_2_phase3_implementation_plan.md Section 7
 */
export const ACCOUNT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes rolling window
export const MAX_RECENT_IPS = 20; // Bounded array capacity
export const ACCOUNT_TTL_SECONDS = 24 * 60 * 60; // 24 hours TTL
export const ADVISORY_DELAY_MAX_MS = 500;
export const ADVISORY_DELAY_STEP_MS = 100;
export const ADVISORY_DELAY_THRESHOLD_IPS = 2;
export const COLLECTION_NAME = 'login_accounts';

/**
 * Computes the advisory delay in milliseconds based on distinct IP failures.
 * Formula: min(max(0, (distinctIps - 2) * 100), 500) ms
 *
 * Distinct IPs:
 *   0 to 2 IPs  ->   0 ms (legitimate multi-device / network transition allowance)
 *   3 IPs       -> 100 ms
 *   4 IPs       -> 200 ms
 *   5 IPs       -> 300 ms
 *   6 IPs       -> 400 ms
 *   7+ IPs      -> 500 ms (capped at 500 ms)
 *
 * @param {number} distinctIps - Number of distinct IP observations within rolling window
 * @returns {number} Delay in milliseconds clamped to [0, 500]
 */
export function calculateAdvisoryDelay(distinctIps) {
  if (
    typeof distinctIps !== 'number' ||
    Number.isNaN(distinctIps) ||
    distinctIps <= ADVISORY_DELAY_THRESHOLD_IPS
  ) {
    return 0;
  }
  const computedDelay = Math.floor(
    (distinctIps - ADVISORY_DELAY_THRESHOLD_IPS) * ADVISORY_DELAY_STEP_MS
  );
  return Math.min(Math.max(0, computedDelay), ADVISORY_DELAY_MAX_MS);
}

/**
 * Schema for individual IP observations in the rolling window.
 * Excludes _id to prevent document bloat.
 */
const recentFailureSchema = new mongoose.Schema(
  {
    ipHash: {
      type: String,
      required: [true, 'ipHash is required'],
      trim: true
    },
    lastSeenAt: {
      type: Date,
      required: [true, 'lastSeenAt is required']
    }
  },
  { _id: false }
);

/**
 * LoginAccount Schema
 *
 * Stores account-level failure telemetry across multiple IP addresses.
 *
 * CRITICAL ARCHITECTURAL GUARANTEE:
 * This model is STRICTLY ADVISORY for telemetry and cross-IP spray friction.
 * It NEVER causes an account-wide lockout, NEVER returns HTTP 429, and NEVER
 * denies login to legitimate users. Hard lockouts are strictly scoped to
 * individual (IP, Account) pairs in LoginPair.
 */
const loginAccountSchema = new mongoose.Schema(
  {
    // HMAC-SHA256(secret, encodeTuple('account', normalizedEmail))
    key: {
      type: String,
      required: [true, 'Account key is required'],
      unique: true,
      index: true,
      trim: true
    },
    // Non-authoritative advisory failure telemetry counter across all IPs
    failedAttempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    // Bounded list of distinct IP observations within rolling 15-minute window
    recentFailures: {
      type: [recentFailureSchema],
      default: []
    },
    // Timestamp of latest login attempt across any IP
    lastAttemptAt: {
      type: Date,
      default: Date.now
    },
    // TTL index timestamp: automatically purged by MongoDB background thread
    expiresAt: {
      type: Date,
      required: [true, 'expiresAt is required'],
      index: { expires: 0 }
    }
  },
  {
    collection: COLLECTION_NAME,
    timestamps: false,
    versionKey: false
  }
);

// Attach advisory delay calculation helper to schema statics
loginAccountSchema.statics.calculateAdvisoryDelay = calculateAdvisoryDelay;

/**
 * Atomically records an account-level login failure within MongoDB.
 *
 * Pipeline steps:
 *   Step A: Purge observations older than 15 minutes, increment telemetry counter, refresh TTL.
 *   Step B: Deduplicate current IP hash, append observation with now timestamp, slice to last 20 entries.
 *
 * Handles E11000 duplicate key race on initial upsert with automatic retry.
 *
 * @param {mongoose.Model} LoginAccountModel - The LoginAccount Mongoose model
 * @param {string} accountKey - The HMAC-derived account key
 * @param {string} ipHash - The HMAC-derived IP hash
 * @param {Date} [now=new Date()] - The reference timestamp
 * @returns {Promise<{ doc: object, distinctIps: number, delayMs: number }>}
 */
export async function recordAccountFailureAtomic(
  LoginAccountModel,
  accountKey,
  ipHash,
  now = new Date()
) {
  if (typeof accountKey !== 'string' || !accountKey.trim()) {
    throw new TypeError('accountKey must be a non-empty string');
  }
  if (typeof ipHash !== 'string' || !ipHash.trim()) {
    throw new TypeError('ipHash must be a non-empty string');
  }

  const dateNow = now instanceof Date ? now : new Date(now);
  const cutoff = new Date(dateNow.getTime() - ACCOUNT_WINDOW_MS);
  const filter = { key: accountKey.trim() };

  const updatePipeline = [
    {
      $set: {
        // Step A: Purge observations older than 15 minutes
        recentFailures: {
          $filter: {
            input: { $ifNull: ['$recentFailures', []] },
            as: 'item',
            cond: { $gte: ['$$item.lastSeenAt', cutoff] }
          }
        },
        failedAttempts: { $add: [{ $ifNull: ['$failedAttempts', 0] }, 1] },
        lastAttemptAt: dateNow,
        expiresAt: new Date(dateNow.getTime() + ACCOUNT_TTL_SECONDS * 1000)
      }
    },
    {
      $set: {
        // Step B: Deduplicate existing ipHash, append new observation with current timestamp, slice to -20
        recentFailures: {
          $slice: [
            {
              $concatArrays: [
                {
                  $filter: {
                    input: '$recentFailures',
                    as: 'item',
                    cond: { $ne: ['$$item.ipHash', ipHash.trim()] }
                  }
                },
                [{ ipHash: ipHash.trim(), lastSeenAt: dateNow }]
              ]
            },
            -MAX_RECENT_IPS
          ]
        }
      }
    }
  ];

  let doc;
  try {
    doc = await LoginAccountModel.findOneAndUpdate(filter, updatePipeline, {
      upsert: true,
      new: true
    });
  } catch (err) {
    if (err.code === 11000) {
      // Concurrent initial upsert collision: retry update without upsert
      doc = await LoginAccountModel.findOneAndUpdate(filter, updatePipeline, {
        upsert: false,
        new: true
      });
    } else {
      throw err;
    }
  }

  const distinctIps = Array.isArray(doc?.recentFailures) ? doc.recentFailures.length : 0;
  const delayMs = calculateAdvisoryDelay(distinctIps);

  return {
    doc,
    distinctIps,
    delayMs
  };
}

// Attach atomic recording helper to schema statics
loginAccountSchema.statics.recordFailure = function (accountKey, ipHash, now) {
  return recordAccountFailureAtomic(this, accountKey, ipHash, now);
};

const LoginAccount =
  mongoose.models.LoginAccount ||
  mongoose.model('LoginAccount', loginAccountSchema, COLLECTION_NAME);

export { loginAccountSchema };
export default LoginAccount;
