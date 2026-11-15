import net from 'node:net';

import LoginPair, {
  INACTIVITY_WINDOW_MS,
  TIER_15M_MS,
  TIER_60M_MS,
  TIER_24H_MS,
  TTL_EXPIRY_MS as PAIR_TTL_MS,
  LOCKOUT_THRESHOLDS
} from '../models/LoginPair.js';

import LoginAccount, {
  ACCOUNT_WINDOW_MS,
  MAX_RECENT_IPS,
  ADVISORY_DELAY_MAX_MS,
  calculateAdvisoryDelay,
  recordAccountFailureAtomic as recordAccountFailureAtomicHelper
} from '../models/LoginAccount.js';

import {
  parseHmacSecret,
  derivePairKey as cryptoDerivePairKey,
  deriveAccountKey as cryptoDeriveAccountKey,
  deriveIpHash as cryptoDeriveIpHash,
  InvalidSecretError
} from '../utils/loginProtectionCrypto.js';

export {
  INACTIVITY_WINDOW_MS,
  TIER_15M_MS,
  TIER_60M_MS,
  TIER_24H_MS,
  PAIR_TTL_MS,
  ACCOUNT_WINDOW_MS,
  MAX_RECENT_IPS,
  ADVISORY_DELAY_MAX_MS,
  LOCKOUT_THRESHOLDS,
  calculateAdvisoryDelay
};

/**
 * LoginProtectionService
 *
 * Core service coordinating progressive pair lockouts, atomic state transitions,
 * optimistic concurrency control (OCC) resets, and cross-IP spray telemetry.
 */
export class LoginProtectionService {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.hmacSecret] - Raw HMAC secret string
   * @param {Buffer} [options.secretBuffer] - Pre-validated 32+ byte Buffer
   * @param {mongoose.Model} [options.pairModel=LoginPair] - Mongoose model for LoginPair
   * @param {mongoose.Model} [options.accountModel=LoginAccount] - Mongoose model for LoginAccount
   * @param {string} [options.nodeEnv=process.env.NODE_ENV] - Node environment
   * @param {boolean} [options.isProtectionEnabled=false] - Whether protection is enabled
   */
  constructor(options = {}) {
    const {
      hmacSecret,
      secretBuffer,
      pairModel = LoginPair,
      accountModel = LoginAccount,
      nodeEnv = process.env.NODE_ENV,
      isProtectionEnabled = false
    } = options;

    if (secretBuffer) {
      if (!Buffer.isBuffer(secretBuffer) || secretBuffer.length < 32) {
        throw new InvalidSecretError('secretBuffer must be a Buffer of at least 32 bytes');
      }
      this.secretBuffer = secretBuffer;
    } else {
      this.secretBuffer = parseHmacSecret(hmacSecret, { nodeEnv, isProtectionEnabled });
    }

    this.pairModel = pairModel;
    this.accountModel = accountModel;
  }

  /**
   * Derives a deterministic pair key from email and client IP (accepts either order).
   *
   * @param {string} arg1 - Email or Client IP
   * @param {string} arg2 - Client IP or Email
   * @returns {string} 64-char lowercase hex key
   */
  derivePairKey(arg1, arg2) {
    let ip;
    let email;
    if (typeof arg1 === 'string' && arg1.includes('@')) {
      email = arg1;
      ip = arg2;
    } else {
      ip = arg1;
      email = arg2;
    }
    return cryptoDerivePairKey(ip, email, this.secretBuffer);
  }

  /**
   * Derives a deterministic account key from email.
   *
   * @param {string} email
   * @returns {string} 64-char lowercase hex key
   */
  deriveAccountKey(email) {
    return cryptoDeriveAccountKey(email, this.secretBuffer);
  }

  /**
   * Derives a deterministic IP hash from client IP.
   *
   * @param {string} ip
   * @returns {string} 64-char lowercase hex key
   */
  deriveIpHash(ip) {
    return cryptoDeriveIpHash(ip, this.secretBuffer);
  }

  /**
   * Computes the advisory delay in milliseconds based on distinct IP failures.
   *
   * @param {number} distinctIps
   * @returns {number}
   */
  calculateAdvisoryDelay(distinctIps) {
    return calculateAdvisoryDelay(distinctIps);
  }

  /**
   * Internal helper: Resolves a pairKey from string or { pairKey } or { email, ip }.
   *
   * @private
   * @param {string|Object} identifier
   * @returns {string}
   */
  _resolvePairKey(identifier) {
    if (typeof identifier === 'string' && identifier.trim()) {
      return identifier.trim();
    }
    if (identifier && typeof identifier === 'object') {
      if (typeof identifier.pairKey === 'string' && identifier.pairKey.trim()) {
        return identifier.pairKey.trim();
      }
      if (identifier.email !== undefined && identifier.ip !== undefined) {
        return this.derivePairKey(identifier.email, identifier.ip);
      }
    }
    throw new TypeError('pairKey or { email, ip } is required');
  }

  /**
   * Internal helper: Resolves accountKey and ipHash from parameters or object.
   *
   * @private
   * @param {string|Object} accountIdentifier
   * @param {string} [ipIdentifier]
   * @returns {{ accountKey: string, ipHash: string }}
   */
  _resolveAccountAndIpHash(accountIdentifier, ipIdentifier) {
    let accountKey;
    let rawIpOrHash = ipIdentifier;

    if (typeof accountIdentifier === 'string' && accountIdentifier.trim()) {
      accountKey = accountIdentifier.trim();
    } else if (accountIdentifier && typeof accountIdentifier === 'object') {
      if (typeof accountIdentifier.accountKey === 'string' && accountIdentifier.accountKey.trim()) {
        accountKey = accountIdentifier.accountKey.trim();
      } else if (accountIdentifier.email !== undefined) {
        accountKey = this.deriveAccountKey(accountIdentifier.email);
      }
      rawIpOrHash = rawIpOrHash || accountIdentifier.ipHash || accountIdentifier.ip;
    }

    if (!accountKey) {
      throw new TypeError('accountKey or { email } is required');
    }

    let ipHash;
    if (typeof rawIpOrHash === 'string' && rawIpOrHash.trim()) {
      const clean = rawIpOrHash.trim();
      if (net.isIP(clean)) {
        ipHash = this.deriveIpHash(clean);
      } else {
        ipHash = clean;
      }
    } else {
      throw new TypeError('ipHash or ip is required');
    }

    return { accountKey, ipHash };
  }

  /**
   * Pre-check pair lockout status before undertaking expensive operations.
   *
   * @param {string|Object} identifier - pairKey string or { pairKey } or { email, ip }
   * @param {Date} [now=new Date()] - Reference timestamp
   * @returns {Promise<{
   *   isLocked: boolean,
   *   lockedUntil: Date|null,
   *   retryAfterSeconds: number,
   *   failedAttempts: number,
   *   revision: number|null,
   *   doc: Object|null
   * }>}
   */
  async checkPairLockout(identifier, now = new Date()) {
    const pairKey = this._resolvePairKey(identifier);
    const dateNow = now instanceof Date ? now : new Date(now);

    const doc = await this.pairModel.findOne({ key: pairKey });
    if (!doc) {
      return {
        isLocked: false,
        lockedUntil: null,
        retryAfterSeconds: 0,
        failedAttempts: 0,
        revision: null,
        doc: null
      };
    }

    const isLocked = Boolean(doc.lockedUntil && doc.lockedUntil > dateNow);
    const retryAfterSeconds = isLocked
      ? Math.max(1, Math.ceil((doc.lockedUntil.getTime() - dateNow.getTime()) / 1000))
      : 0;

    return {
      isLocked,
      lockedUntil: doc.lockedUntil,
      retryAfterSeconds,
      failedAttempts: doc.failedAttempts,
      revision: doc.revision,
      doc
    };
  }

  /**
   * Atomically records a pair login failure with progressive lockout calculation.
   *
   * Enforces:
   * - Conditional filter guarding against stale pre-check lockout overwrite.
   * - Unified inactivity decay measured from lockedUntil (when locked) or lastAttemptAt (when unlocked).
   * - Progressive lockout tiers: 5-9 -> 15m, 10-14 -> 60m, 15+ -> 24h.
   * - OCC revision counter increment.
   * - E11000 duplicate key race interception with upsert: false retry.
   * - 3-way resolution on null document match: ACTIVE_LOCKOUT, deleted retry, or RETRY_REQUIRED.
   *
   * @param {string|Object} identifier - pairKey string or { pairKey } or { email, ip }
   * @param {Date} [now=new Date()] - Reference timestamp
   * @returns {Promise<{
   *   status: 'RECORDED'|'LOCKOUT_INITIATED'|'ACTIVE_LOCKOUT'|'RETRY_REQUIRED',
   *   doc: Object|null,
   *   lockedUntil: Date|null,
   *   failedAttempts: number|null,
   *   revision: number|null,
   *   retryAfterSeconds: number
   * }>}
   */
  async recordPairFailureAtomic(identifier, now = new Date()) {
    const pairKey = this._resolvePairKey(identifier);
    const dateNow = now instanceof Date ? now : new Date(now);

    const filter = {
      key: pairKey,
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: dateNow } }]
    };

    const updatePipeline = [
      {
        $set: {
          _isDecayed: {
            $cond: {
              if: { $ne: [{ $ifNull: ['$lockedUntil', null] }, null] },
              then: { $gt: [{ $subtract: [dateNow, '$lockedUntil'] }, INACTIVITY_WINDOW_MS] },
              else: {
                $gt: [
                  { $subtract: [dateNow, { $ifNull: ['$lastAttemptAt', new Date(0)] }] },
                  INACTIVITY_WINDOW_MS
                ]
              }
            }
          }
        }
      },
      {
        $set: {
          failedAttempts: {
            $cond: {
              if: '$_isDecayed',
              then: 1,
              else: { $add: [{ $ifNull: ['$failedAttempts', 0] }, 1] }
            }
          },
          lastAttemptAt: dateNow,
          revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] }
        }
      },
      {
        $set: {
          lockedUntil: {
            $switch: {
              branches: [
                { case: { $lt: ['$failedAttempts', 5] }, then: null },
                {
                  case: {
                    $and: [{ $gte: ['$failedAttempts', 5] }, { $lt: ['$failedAttempts', 10] }]
                  },
                  then: new Date(dateNow.getTime() + TIER_15M_MS)
                },
                {
                  case: {
                    $and: [{ $gte: ['$failedAttempts', 10] }, { $lt: ['$failedAttempts', 15] }]
                  },
                  then: new Date(dateNow.getTime() + TIER_60M_MS)
                },
                {
                  case: { $gte: ['$failedAttempts', 15] },
                  then: new Date(dateNow.getTime() + TIER_24H_MS)
                }
              ],
              default: null
            }
          },
          expiresAt: new Date(dateNow.getTime() + PAIR_TTL_MS)
        }
      },
      { $unset: '_isDecayed' }
    ];

    const attemptUpdate = async (upsert) => {
      try {
        const doc = await this.pairModel.findOneAndUpdate(filter, updatePipeline, {
          upsert,
          new: true
        });
        return { ok: true, doc };
      } catch (err) {
        if (err.code === 11000) {
          return { ok: false, duplicateKey: true };
        }
        throw err;
      }
    };

    let res = await attemptUpdate(true);
    if (!res.ok && res.duplicateKey) {
      res = await attemptUpdate(false);
    }

    if (res.ok && res.doc) {
      const isLocked = Boolean(res.doc.lockedUntil && res.doc.lockedUntil > dateNow);
      const retryAfterSeconds = isLocked
        ? Math.max(1, Math.ceil((res.doc.lockedUntil.getTime() - dateNow.getTime()) / 1000))
        : 0;
      return {
        status: isLocked ? 'LOCKOUT_INITIATED' : 'RECORDED',
        doc: res.doc,
        lockedUntil: res.doc.lockedUntil,
        failedAttempts: res.doc.failedAttempts,
        revision: res.doc.revision,
        retryAfterSeconds
      };
    }

    const currentDoc = await this.pairModel.findOne({ key: pairKey });

    if (currentDoc && currentDoc.lockedUntil && currentDoc.lockedUntil > dateNow) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((currentDoc.lockedUntil.getTime() - dateNow.getTime()) / 1000)
      );
      return {
        status: 'ACTIVE_LOCKOUT',
        doc: currentDoc,
        lockedUntil: currentDoc.lockedUntil,
        failedAttempts: currentDoc.failedAttempts,
        revision: currentDoc.revision,
        retryAfterSeconds
      };
    }

    if (!currentDoc) {
      const retryRes = await attemptUpdate(true);
      if (retryRes.ok && retryRes.doc) {
        const isLocked = Boolean(retryRes.doc.lockedUntil && retryRes.doc.lockedUntil > dateNow);
        const retryAfterSeconds = isLocked
          ? Math.max(1, Math.ceil((retryRes.doc.lockedUntil.getTime() - dateNow.getTime()) / 1000))
          : 0;
        return {
          status: isLocked ? 'LOCKOUT_INITIATED' : 'RECORDED',
          doc: retryRes.doc,
          lockedUntil: retryRes.doc.lockedUntil,
          failedAttempts: retryRes.doc.failedAttempts,
          revision: retryRes.doc.revision,
          retryAfterSeconds
        };
      }
    }

    return {
      status: 'RETRY_REQUIRED',
      doc: null,
      lockedUntil: null,
      failedAttempts: null,
      revision: null,
      retryAfterSeconds: 0
    };
  }

  /**
   * Concurrency-safe reset on successful authentication using Optimistic Concurrency Control (OCC).
   *
   * Only deletes the document if the database revision matches the admitted revision.
   * If a concurrent failure raced and incremented the revision, the delete fails and the newer
   * failure/lockout state is strictly preserved.
   *
   * @param {string|Object} identifier - pairKey string or { pairKey } or { email, ip }
   * @param {number|null|undefined} revision - Revision observed during admission
   * @returns {Promise<{
   *   status: 'RESET_SUCCESS'|'RESET_ABSENT'|'REVISION_MISMATCH',
   *   deletedCount: number,
   *   currentRevision?: number,
   *   expectedRevision?: number|null
   * }>}
   */
  async resetPairOnSuccess(identifier, revision) {
    const pairKey = this._resolvePairKey(identifier);

    if (revision === null || revision === undefined) {
      const currentDoc = await this.pairModel.findOne({ key: pairKey });
      if (!currentDoc) {
        return { status: 'RESET_ABSENT', deletedCount: 0 };
      }
      return {
        status: 'REVISION_MISMATCH',
        deletedCount: 0,
        currentRevision: currentDoc.revision,
        expectedRevision: revision
      };
    }

    if (typeof revision !== 'number' || Number.isNaN(revision)) {
      throw new TypeError('revision must be a finite number, null, or undefined');
    }

    const result = await this.pairModel.deleteOne({ key: pairKey, revision });
    if (result.deletedCount === 1) {
      return { status: 'RESET_SUCCESS', deletedCount: 1 };
    }

    const currentDoc = await this.pairModel.findOne({ key: pairKey });
    if (!currentDoc) {
      return { status: 'RESET_ABSENT', deletedCount: 0 };
    }

    return {
      status: 'REVISION_MISMATCH',
      deletedCount: 0,
      currentRevision: currentDoc.revision,
      expectedRevision: revision
    };
  }

  /**
   * Records an account-level failure observation across IP addresses.
   * Strictly advisory: never causes an account lockout or 429 response.
   *
   * @param {string|Object} accountIdentifier - accountKey or { email, accountKey }
   * @param {string} [ipIdentifier] - ipHash or clientIp
   * @param {Date} [now=new Date()] - Reference timestamp
   * @returns {Promise<{ doc: Object, distinctIps: number, delayMs: number }>}
   */
  async recordAccountFailureAtomic(accountIdentifier, ipIdentifier, now = new Date()) {
    const { accountKey, ipHash } = this._resolveAccountAndIpHash(accountIdentifier, ipIdentifier);
    return recordAccountFailureAtomicHelper(this.accountModel, accountKey, ipHash, now);
  }
}

export default LoginProtectionService;
