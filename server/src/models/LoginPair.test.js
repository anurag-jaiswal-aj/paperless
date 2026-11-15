import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import LoginPair, {
  loginPairSchema,
  calculateLockoutDurationMs,
  calculateLockoutUntil,
  isLockoutActive,
  isDecayed,
  INACTIVITY_WINDOW_MS,
  TIER_15M_MS,
  TIER_60M_MS,
  TIER_24H_MS,
  TTL_EXPIRY_MS,
  COLLECTION_NAME,
  LOCKOUT_THRESHOLDS
} from './LoginPair.js';

describe('LoginPair Model & Lockout Boundary Suite (Stage 3.2)', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await LoginPair.deleteMany({});
  });

  // =========================================================================
  // 1. Schema Definition, Options, and Collection Name
  // =========================================================================
  describe('Schema Definition & Collection Configuration', () => {
    it('sets the collection name explicitly to "login_pairs"', () => {
      expect(LoginPair.collection.name).toBe(COLLECTION_NAME);
      expect(COLLECTION_NAME).toBe('login_pairs');
      expect(loginPairSchema.options.collection).toBe('login_pairs');
      expect(LOCKOUT_THRESHOLDS.TIER_1_MAX_FAILURES).toBe(4);
      expect(LOCKOUT_THRESHOLDS.TIER_2_MIN_FAILURES).toBe(5);
      expect(LOCKOUT_THRESHOLDS.TIER_3_MIN_FAILURES).toBe(10);
      expect(LOCKOUT_THRESHOLDS.TIER_4_MIN_FAILURES).toBe(15);
    });

    it('disables Mongoose internal versionKey (__v)', () => {
      expect(loginPairSchema.options.versionKey).toBe(false);

      const doc = new LoginPair({
        key: 'a'.repeat(64),
        expiresAt: new Date()
      });
      const plain = doc.toObject();
      expect(plain.__v).toBeUndefined();
    });

    it('contains all required fields with exact property types', () => {
      const paths = loginPairSchema.paths;

      expect(paths.key).toBeDefined();
      expect(paths.key.instance).toBe('String');

      expect(paths.failedAttempts).toBeDefined();
      expect(paths.failedAttempts.instance).toBe('Number');

      expect(paths.lockedUntil).toBeDefined();
      expect(paths.lockedUntil.instance).toBe('Date');

      expect(paths.lastAttemptAt).toBeDefined();
      expect(paths.lastAttemptAt.instance).toBe('Date');

      expect(paths.revision).toBeDefined();
      expect(paths.revision.instance).toBe('Number');

      expect(paths.expiresAt).toBeDefined();
      expect(paths.expiresAt.instance).toBe('Date');
    });
  });

  // =========================================================================
  // 2. Default Values & Document Instantiation
  // =========================================================================
  describe('Default Values & Minimal Instantiation', () => {
    it('populates default values correctly when initialized with minimal required fields', () => {
      const expiresAt = new Date(Date.now() + TTL_EXPIRY_MS);
      const testKey = 'b'.repeat(64);

      const doc = new LoginPair({
        key: testKey,
        expiresAt
      });

      expect(doc.key).toBe(testKey);
      expect(doc.failedAttempts).toBe(0);
      expect(doc.lockedUntil).toBeNull();
      expect(doc.lastAttemptAt).toBeNull();
      expect(doc.revision).toBe(0);
      expect(doc.expiresAt).toEqual(expiresAt);
    });

    it('persists default values into MongoDB upon save', async () => {
      const expiresAt = new Date(Date.now() + TTL_EXPIRY_MS);
      const testKey = 'c'.repeat(64);

      const created = await LoginPair.create({
        key: testKey,
        expiresAt
      });

      const retrieved = await LoginPair.findById(created._id);
      expect(retrieved).not.toBeNull();
      expect(retrieved.key).toBe(testKey);
      expect(retrieved.failedAttempts).toBe(0);
      expect(retrieved.lockedUntil).toBeNull();
      expect(retrieved.lastAttemptAt).toBeNull();
      expect(retrieved.revision).toBe(0);
      expect(retrieved.expiresAt.getTime()).toBe(expiresAt.getTime());
    });
  });

  // =========================================================================
  // 3. Schema Validation & Constraints
  // =========================================================================
  describe('Schema Validation & Constraints', () => {
    it('requires the "key" field', () => {
      const doc = new LoginPair({
        expiresAt: new Date()
      });

      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.key).toBeDefined();
      expect(err.errors.key.message).toMatch(/key is required/i);
    });

    it('trims whitespace from "key" field', () => {
      const rawKey = 'd'.repeat(64);
      const doc = new LoginPair({
        key: `   ${rawKey}   `,
        expiresAt: new Date()
      });

      expect(doc.key).toBe(rawKey);
    });

    it('requires the "expiresAt" field', () => {
      const doc = new LoginPair({
        key: 'e'.repeat(64)
      });

      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.expiresAt).toBeDefined();
      expect(err.errors.expiresAt.message).toMatch(/expiry date is required/i);
    });

    it('validates that "failedAttempts" cannot be negative', () => {
      const doc = new LoginPair({
        key: 'f'.repeat(64),
        expiresAt: new Date(),
        failedAttempts: -1
      });

      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.failedAttempts).toBeDefined();
      expect(err.errors.failedAttempts.message).toMatch(/cannot be negative/i);
    });

    it('validates that "revision" cannot be negative', () => {
      const doc = new LoginPair({
        key: '0'.repeat(64),
        expiresAt: new Date(),
        revision: -1
      });

      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.revision).toBeDefined();
      expect(err.errors.revision.message).toMatch(/cannot be negative/i);
    });

    it('rejects non-numeric values for "failedAttempts" and "revision"', () => {
      const doc = new LoginPair({
        key: '1'.repeat(64),
        expiresAt: new Date(),
        failedAttempts: 'invalid-number',
        revision: 'invalid-rev'
      });

      const err = doc.validateSync();
      expect(err).toBeDefined();
      expect(err.errors.failedAttempts).toBeDefined();
      expect(err.errors.revision).toBeDefined();
    });

    it('allows valid dates and null for "lockedUntil" and "lastAttemptAt"', () => {
      const now = new Date();
      const doc = new LoginPair({
        key: '2'.repeat(64),
        expiresAt: new Date(now.getTime() + TTL_EXPIRY_MS),
        lockedUntil: new Date(now.getTime() + TIER_15M_MS),
        lastAttemptAt: now
      });

      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.lockedUntil).toBeInstanceOf(Date);
      expect(doc.lastAttemptAt).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // 4. Index Configuration & Uniqueness
  // =========================================================================
  describe('Index Configuration & Database Constraints', () => {
    it('declares a unique index on key and a TTL index on expiresAt in schema', () => {
      const indexes = loginPairSchema.indexes();

      const keyIndex = indexes.find((idx) => idx[0] && idx[0].key === 1);
      expect(keyIndex).toBeDefined();
      expect(keyIndex[1].unique).toBe(true);

      const ttlIndex = indexes.find((idx) => idx[0] && idx[0].expiresAt === 1);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex[1].expireAfterSeconds).toBe(0);
    });

    it('creates and verifies indexes in active MongoDB instance', async () => {
      await LoginPair.init();
      const collectionIndexes = await LoginPair.collection.indexes();

      const keyIndex = collectionIndexes.find((idx) => idx.key && idx.key.key === 1);
      expect(keyIndex).toBeDefined();
      expect(keyIndex.unique).toBe(true);

      const ttlIndex = collectionIndexes.find((idx) => idx.key && idx.key.expiresAt === 1);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex.expireAfterSeconds).toBe(0);
    });

    it('enforces unique index constraint on key by throwing E11000 duplicate key error', async () => {
      await LoginPair.init();
      const testKey = '3'.repeat(64);
      const expiresAt = new Date(Date.now() + TTL_EXPIRY_MS);

      await LoginPair.create({
        key: testKey,
        expiresAt
      });

      let duplicateError = null;
      try {
        await LoginPair.create({
          key: testKey,
          expiresAt
        });
      } catch (err) {
        duplicateError = err;
      }

      expect(duplicateError).not.toBeNull();
      expect(duplicateError.code).toBe(11000);
    });
  });

  // =========================================================================
  // 5. Lockout Boundary Calculations (calculateLockoutDurationMs & calculateLockoutUntil)
  // =========================================================================
  describe('Lockout Boundary Calculations (Escalation Tiers)', () => {
    describe('calculateLockoutDurationMs', () => {
      it('returns 0 ms for Tier 1 (0 to 4 failed attempts)', () => {
        expect(calculateLockoutDurationMs(0)).toBe(0);
        expect(calculateLockoutDurationMs(1)).toBe(0);
        expect(calculateLockoutDurationMs(2)).toBe(0);
        expect(calculateLockoutDurationMs(3)).toBe(0);
        expect(calculateLockoutDurationMs(4)).toBe(0);
      });

      it('returns 15 minutes (900000 ms) for Tier 2 boundary (5 to 9 failed attempts)', () => {
        expect(calculateLockoutDurationMs(5)).toBe(TIER_15M_MS);
        expect(calculateLockoutDurationMs(6)).toBe(TIER_15M_MS);
        expect(calculateLockoutDurationMs(7)).toBe(TIER_15M_MS);
        expect(calculateLockoutDurationMs(8)).toBe(TIER_15M_MS);
        expect(calculateLockoutDurationMs(9)).toBe(TIER_15M_MS);
      });

      it('returns 60 minutes (3600000 ms) for Tier 3 boundary (10 to 14 failed attempts)', () => {
        expect(calculateLockoutDurationMs(10)).toBe(TIER_60M_MS);
        expect(calculateLockoutDurationMs(11)).toBe(TIER_60M_MS);
        expect(calculateLockoutDurationMs(12)).toBe(TIER_60M_MS);
        expect(calculateLockoutDurationMs(13)).toBe(TIER_60M_MS);
        expect(calculateLockoutDurationMs(14)).toBe(TIER_60M_MS);
      });

      it('returns 24 hours (86400000 ms) for Tier 4 boundary (15+ failed attempts)', () => {
        expect(calculateLockoutDurationMs(15)).toBe(TIER_24H_MS);
        expect(calculateLockoutDurationMs(16)).toBe(TIER_24H_MS);
        expect(calculateLockoutDurationMs(20)).toBe(TIER_24H_MS);
        expect(calculateLockoutDurationMs(100)).toBe(TIER_24H_MS);
      });

      it('handles negative, non-numeric, or null inputs safely by returning 0', () => {
        expect(calculateLockoutDurationMs(-1)).toBe(0);
        expect(calculateLockoutDurationMs(null)).toBe(0);
        expect(calculateLockoutDurationMs(undefined)).toBe(0);
        expect(calculateLockoutDurationMs('five')).toBe(0);
        expect(calculateLockoutDurationMs(NaN)).toBe(0);
      });
    });

    describe('calculateLockoutUntil', () => {
      const fixedNow = new Date('2026-11-07T12:00:00.000Z');

      it('returns null for failedAttempts < 5', () => {
        expect(calculateLockoutUntil(0, fixedNow)).toBeNull();
        expect(calculateLockoutUntil(4, fixedNow)).toBeNull();
      });

      it('returns fixedNow + 15m for failedAttempts between 5 and 9', () => {
        const expected = new Date(fixedNow.getTime() + 15 * 60 * 1000);
        expect(calculateLockoutUntil(5, fixedNow)).toEqual(expected);
        expect(calculateLockoutUntil(9, fixedNow)).toEqual(expected);
      });

      it('returns fixedNow + 60m for failedAttempts between 10 and 14', () => {
        const expected = new Date(fixedNow.getTime() + 60 * 60 * 1000);
        expect(calculateLockoutUntil(10, fixedNow)).toEqual(expected);
        expect(calculateLockoutUntil(14, fixedNow)).toEqual(expected);
      });

      it('returns fixedNow + 24h for failedAttempts >= 15', () => {
        const expected = new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000);
        expect(calculateLockoutUntil(15, fixedNow)).toEqual(expected);
        expect(calculateLockoutUntil(50, fixedNow)).toEqual(expected);
      });
    });
  });

  // =========================================================================
  // 6. Lockout Active State & Instance Methods
  // =========================================================================
  describe('isLockoutActive & Document Instance Methods', () => {
    const fixedNow = new Date('2026-11-07T12:00:00.000Z');

    it('evaluates isLockoutActive correctly around time boundaries', () => {
      // 1. null / undefined lockedUntil
      expect(isLockoutActive(null, fixedNow)).toBe(false);
      expect(isLockoutActive(undefined, fixedNow)).toBe(false);

      // 2. Lockout strictly in future
      const futureLock = new Date(fixedNow.getTime() + 5000);
      expect(isLockoutActive(futureLock, fixedNow)).toBe(true);

      // 3. Exact boundary: lockedUntil === now (lock has expired)
      const exactBoundary = new Date(fixedNow.getTime());
      expect(isLockoutActive(exactBoundary, fixedNow)).toBe(false);

      // 4. Lockout in past
      const pastLock = new Date(fixedNow.getTime() - 1000);
      expect(isLockoutActive(pastLock, fixedNow)).toBe(false);
    });

    it('evaluates doc.isLocked(now) instance method', () => {
      const unlockedDoc = new LoginPair({
        key: '4'.repeat(64),
        expiresAt: new Date(),
        lockedUntil: null
      });
      expect(unlockedDoc.isLocked(fixedNow)).toBe(false);

      const lockedDoc = new LoginPair({
        key: '5'.repeat(64),
        expiresAt: new Date(),
        lockedUntil: new Date(fixedNow.getTime() + 30000)
      });
      expect(lockedDoc.isLocked(fixedNow)).toBe(true);
    });

    it('evaluates doc.getRemainingLockoutSeconds(now) with ceiling rounding and 0 floor', () => {
      const doc = new LoginPair({
        key: '6'.repeat(64),
        expiresAt: new Date(),
        lockedUntil: new Date(fixedNow.getTime() + 15400) // 15.4 seconds left
      });

      // Ceiling should yield 16 seconds
      expect(doc.getRemainingLockoutSeconds(fixedNow)).toBe(16);

      // 10.0 seconds exact
      const docExact = new LoginPair({
        key: '7'.repeat(64),
        expiresAt: new Date(),
        lockedUntil: new Date(fixedNow.getTime() + 10000)
      });
      expect(docExact.getRemainingLockoutSeconds(fixedNow)).toBe(10);

      // Expired lock should return 0
      const expiredDoc = new LoginPair({
        key: '8'.repeat(64),
        expiresAt: new Date(),
        lockedUntil: new Date(fixedNow.getTime() - 5000)
      });
      expect(expiredDoc.getRemainingLockoutSeconds(fixedNow)).toBe(0);

      // Null lock should return 0
      const nullDoc = new LoginPair({
        key: '9'.repeat(64),
        expiresAt: new Date(),
        lockedUntil: null
      });
      expect(nullDoc.getRemainingLockoutSeconds(fixedNow)).toBe(0);
    });
  });

  // =========================================================================
  // 7. Inactivity Decay Rules (Section 3.2 Formal Escalation Invariants)
  // =========================================================================
  describe('Inactivity Decay Rules (Section 3.2)', () => {
    const fixedNow = new Date('2026-11-07T12:00:00.000Z');
    const fifteenMinutesMs = 15 * 60 * 1000;

    describe('When lockedUntil is NOT null (failures 5+): cooldown measured from lockedUntil', () => {
      it('returns false while lockout is active (now < lockedUntil)', () => {
        const lockedUntil = new Date(fixedNow.getTime() + 10 * 60 * 1000); // lock active for 10 more minutes
        expect(
          isDecayed(
            { lockedUntil, lastAttemptAt: new Date(fixedNow.getTime() - 5 * 60 * 1000) },
            fixedNow
          )
        ).toBe(false);
      });

      it('returns false immediately upon lockout expiry (now === lockedUntil)', () => {
        const lockedUntil = new Date(fixedNow.getTime());
        expect(isDecayed({ lockedUntil }, fixedNow)).toBe(false);
      });

      it('returns false when attempt arrives 1 minute after lockout expiry (now <= lockedUntil + 15m)', () => {
        // Attempt at 16m after initial failure (1m after 15m lockout expired)
        const lockedUntil = new Date(fixedNow.getTime() - 1 * 60 * 1000); // expired 1m ago
        expect(isDecayed({ lockedUntil }, fixedNow)).toBe(false);
      });

      it('returns false at exact 15 minute boundary after lockout expiry (now - lockedUntil === 15m)', () => {
        const lockedUntil = new Date(fixedNow.getTime() - fifteenMinutesMs);
        expect(isDecayed({ lockedUntil }, fixedNow)).toBe(false);
      });

      it('returns true when attempt arrives beyond 15 minutes after lockout expiry (now > lockedUntil + 15m)', () => {
        // 15 minutes and 1 millisecond after lockout expired
        const lockedUntil = new Date(fixedNow.getTime() - (fifteenMinutesMs + 1));
        expect(isDecayed({ lockedUntil }, fixedNow)).toBe(true);

        // 16 minutes after lockout expired
        const lockedUntil16m = new Date(fixedNow.getTime() - 16 * 60 * 1000);
        expect(isDecayed({ lockedUntil: lockedUntil16m }, fixedNow)).toBe(true);
      });
    });

    describe('When lockedUntil IS null (failures 1 to 4): cooldown measured from lastAttemptAt', () => {
      it('returns false when attempt arrives within 15 minutes of last failure', () => {
        const lastAttemptAt = new Date(fixedNow.getTime() - 5 * 60 * 1000); // 5m ago
        expect(isDecayed({ lockedUntil: null, lastAttemptAt }, fixedNow)).toBe(false);
      });

      it('returns false at exact 15 minute boundary of last failure', () => {
        const lastAttemptAt = new Date(fixedNow.getTime() - fifteenMinutesMs);
        expect(isDecayed({ lockedUntil: null, lastAttemptAt }, fixedNow)).toBe(false);
      });

      it('returns true when attempt arrives after more than 15 minutes of silence', () => {
        const lastAttemptAt = new Date(fixedNow.getTime() - (fifteenMinutesMs + 1000)); // 15m 1s ago
        expect(isDecayed({ lockedUntil: null, lastAttemptAt }, fixedNow)).toBe(true);
      });
    });

    describe('When state has no valid timestamps', () => {
      it('returns false for null, undefined, or empty state', () => {
        expect(isDecayed(null, fixedNow)).toBe(false);
        expect(isDecayed({}, fixedNow)).toBe(false);
        expect(isDecayed({ lockedUntil: null, lastAttemptAt: null }, fixedNow)).toBe(false);
      });
    });

    describe('Instance method doc.isDecayed(now)', () => {
      it('delegates to isDecayed logic correctly', () => {
        const recentDoc = new LoginPair({
          key: 'a1'.repeat(32),
          expiresAt: new Date(),
          lockedUntil: null,
          lastAttemptAt: new Date(fixedNow.getTime() - 2 * 60 * 1000)
        });
        expect(recentDoc.isDecayed(fixedNow)).toBe(false);

        const decayedDoc = new LoginPair({
          key: 'a2'.repeat(32),
          expiresAt: new Date(),
          lockedUntil: null,
          lastAttemptAt: new Date(fixedNow.getTime() - 20 * 60 * 1000)
        });
        expect(decayedDoc.isDecayed(fixedNow)).toBe(true);
      });
    });
  });

  // =========================================================================
  // 8. Atomic Update Pipeline Parity Verification (Section 3.4)
  // =========================================================================
  describe('Atomic Pipeline Simulation on LoginPair Model', () => {
    // Helper executing Section 3.4 MongoDB aggregation update pipeline against model
    async function executeAtomicFailure(pairKey, now) {
      const filter = {
        key: pairKey,
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }]
      };

      const updatePipeline = [
        {
          $set: {
            _isDecayed: {
              $cond: {
                if: { $ne: [{ $ifNull: ['$lockedUntil', null] }, null] },
                then: { $gt: [{ $subtract: [now, '$lockedUntil'] }, INACTIVITY_WINDOW_MS] },
                else: {
                  $gt: [
                    { $subtract: [now, { $ifNull: ['$lastAttemptAt', new Date(0)] }] },
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
            lastAttemptAt: now,
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
                    then: new Date(now.getTime() + TIER_15M_MS)
                  },
                  {
                    case: {
                      $and: [{ $gte: ['$failedAttempts', 10] }, { $lt: ['$failedAttempts', 15] }]
                    },
                    then: new Date(now.getTime() + TIER_60M_MS)
                  },
                  {
                    case: { $gte: ['$failedAttempts', 15] },
                    then: new Date(now.getTime() + TIER_24H_MS)
                  }
                ],
                default: null
              }
            },
            expiresAt: new Date(now.getTime() + TTL_EXPIRY_MS)
          }
        },
        { $unset: '_isDecayed' }
      ];

      return await LoginPair.findOneAndUpdate(filter, updatePipeline, {
        upsert: true,
        new: true
      });
    }

    it('records first failure by upserting document with failedAttempts=1 and lockedUntil=null', async () => {
      const pairKey = 'b1'.repeat(32);
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      const doc = await executeAtomicFailure(pairKey, t0);
      expect(doc).not.toBeNull();
      expect(doc.failedAttempts).toBe(1);
      expect(doc.lockedUntil).toBeNull();
      expect(doc.revision).toBe(1);
      expect(doc.lastAttemptAt).toEqual(t0);
    });

    it('increments failedAttempts consecutively through Tier 1 (failures 1 to 4)', async () => {
      const pairKey = 'b2'.repeat(32);
      let currentTime = new Date('2026-11-07T10:00:00.000Z');

      for (let i = 1; i <= 4; i++) {
        currentTime = new Date(currentTime.getTime() + 10000); // 10s intervals
        const doc = await executeAtomicFailure(pairKey, currentTime);
        expect(doc.failedAttempts).toBe(i);
        expect(doc.lockedUntil).toBeNull();
        expect(doc.revision).toBe(i);
      }
    });

    it('triggers Tier 2 lockout (15 minutes) on failure 5', async () => {
      const pairKey = 'b3'.repeat(32);
      let currentTime = new Date('2026-11-07T10:00:00.000Z');

      for (let i = 1; i <= 4; i++) {
        currentTime = new Date(currentTime.getTime() + 10000);
        await executeAtomicFailure(pairKey, currentTime);
      }

      currentTime = new Date(currentTime.getTime() + 10000);
      const doc5 = await executeAtomicFailure(pairKey, currentTime);

      expect(doc5.failedAttempts).toBe(5);
      expect(doc5.lockedUntil).toEqual(new Date(currentTime.getTime() + TIER_15M_MS));
      expect(doc5.revision).toBe(5);
    });

    it('rejects atomic failure update during active lockout (pre-check bypass prevention)', async () => {
      const pairKey = 'b4'.repeat(32);
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      // Create document already in active lockout (failure 5)
      await LoginPair.create({
        key: pairKey,
        failedAttempts: 5,
        lockedUntil: new Date(t0.getTime() + TIER_15M_MS),
        lastAttemptAt: t0,
        revision: 5,
        expiresAt: new Date(t0.getTime() + TTL_EXPIRY_MS)
      });

      // A concurrent stale request attempts to record failure at t0 + 5 minutes
      const tConcurrent = new Date(t0.getTime() + 5 * 60 * 1000);
      const filter = {
        key: pairKey,
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: tConcurrent } }]
      };

      // In the real service, upsert: false is used when handling existing documents
      const result = await LoginPair.findOneAndUpdate(
        filter,
        { $set: { failedAttempts: 6 } },
        { new: true }
      );
      expect(result).toBeNull(); // Matched 0 documents, write rejected!

      // Verify the original document is untouched
      const untouched = await LoginPair.findOne({ key: pairKey });
      expect(untouched.failedAttempts).toBe(5);
      expect(untouched.revision).toBe(5);
      expect(untouched.lockedUntil).toEqual(new Date(t0.getTime() + TIER_15M_MS));
    });

    it('allows progression to failure 6 when attempt arrives 1 minute after lockout expiry', async () => {
      const pairKey = 'b5'.repeat(32);
      const t0 = new Date('2026-11-07T10:00:00.000Z');
      const lockoutExpiry = new Date(t0.getTime() + TIER_15M_MS);

      await LoginPair.create({
        key: pairKey,
        failedAttempts: 5,
        lockedUntil: lockoutExpiry,
        lastAttemptAt: t0,
        revision: 5,
        expiresAt: new Date(t0.getTime() + TTL_EXPIRY_MS)
      });

      // Attempt arrives 1 minute after lockout expired (16 minutes after t0)
      const t6 = new Date(lockoutExpiry.getTime() + 1 * 60 * 1000);
      const doc6 = await executeAtomicFailure(pairKey, t6);

      expect(doc6).not.toBeNull();
      // Crucial: failedAttempts must be 6 (not reset to 1), and lockedUntil set to t6 + 15m
      expect(doc6.failedAttempts).toBe(6);
      expect(doc6.lockedUntil).toEqual(new Date(t6.getTime() + TIER_15M_MS));
      expect(doc6.revision).toBe(6);
    });

    it('advances to Tier 3 (10 failures -> 60 minutes lockout) and Tier 4 (15 failures -> 24 hours lockout)', async () => {
      const pairKey = 'b6'.repeat(32);
      let currentTime = new Date('2026-11-07T10:00:00.000Z');

      // Seed with 9 failures, lockedUntil expired 1 minute ago
      const lock9Expiry = new Date(currentTime.getTime() + TIER_15M_MS);
      await LoginPair.create({
        key: pairKey,
        failedAttempts: 9,
        lockedUntil: lock9Expiry,
        lastAttemptAt: currentTime,
        revision: 9,
        expiresAt: new Date(currentTime.getTime() + TTL_EXPIRY_MS)
      });

      // Attempt 10 arrives 1 minute after expiry -> advances to Tier 3 (60m)
      const t10 = new Date(lock9Expiry.getTime() + 60000);
      const doc10 = await executeAtomicFailure(pairKey, t10);
      expect(doc10.failedAttempts).toBe(10);
      expect(doc10.lockedUntil).toEqual(new Date(t10.getTime() + TIER_60M_MS));

      // Advance to 14 failures
      await LoginPair.updateOne(
        { key: pairKey },
        {
          $set: {
            failedAttempts: 14,
            lockedUntil: new Date(t10.getTime() + 60000) // expired
          }
        }
      );

      // Attempt 15 arrives 1 minute after expiry -> advances to Tier 4 (24h)
      const t15 = new Date(t10.getTime() + 120000);
      const doc15 = await executeAtomicFailure(pairKey, t15);
      expect(doc15.failedAttempts).toBe(15);
      expect(doc15.lockedUntil).toEqual(new Date(t15.getTime() + TIER_24H_MS));
    });

    it('resets failedAttempts to 1 when attempt arrives beyond the 15-minute inactivity window after expiry', async () => {
      const pairKey = 'b7'.repeat(32);
      const t0 = new Date('2026-11-07T10:00:00.000Z');
      const lockoutExpiry = new Date(t0.getTime() + TIER_15M_MS);

      await LoginPair.create({
        key: pairKey,
        failedAttempts: 10,
        lockedUntil: lockoutExpiry,
        lastAttemptAt: t0,
        revision: 10,
        expiresAt: new Date(t0.getTime() + TTL_EXPIRY_MS)
      });

      // Attempt arrives 16 minutes after lockout expiry (total 31 minutes after t0)
      const tDecayed = new Date(lockoutExpiry.getTime() + 16 * 60 * 1000);
      const docDecayed = await executeAtomicFailure(pairKey, tDecayed);

      expect(docDecayed).not.toBeNull();
      // Must be reset to 1 because inactivity elapsed!
      expect(docDecayed.failedAttempts).toBe(1);
      expect(docDecayed.lockedUntil).toBeNull();
      expect(docDecayed.revision).toBe(11);
      expect(docDecayed.lastAttemptAt).toEqual(tDecayed);
    });
  });
});
