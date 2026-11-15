import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import LoginAccount, {
  calculateAdvisoryDelay,
  recordAccountFailureAtomic,
  ACCOUNT_WINDOW_MS,
  MAX_RECENT_IPS,
  ACCOUNT_TTL_SECONDS,
  ADVISORY_DELAY_MAX_MS
} from './LoginAccount.js';

describe('LoginAccount Model & Cross-IP Advisory Tracking Suite', () => {
  let mongod;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await LoginAccount.createIndexes();
  });

  afterEach(async () => {
    await mongoose.disconnect();
    if (mongod) {
      await mongod.stop();
    }
  });

  // =========================================================================
  // 1. Schema Definition & Validation Tests
  // =========================================================================
  describe('Schema Definition and Field Validation', () => {
    it('enforces explicit collection name as login_accounts and verifies window constant', () => {
      expect(LoginAccount.collection.name).toBe('login_accounts');
      expect(ACCOUNT_WINDOW_MS).toBe(15 * 60 * 1000);
    });

    it('creates document with valid fields and default values', async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ACCOUNT_TTL_SECONDS * 1000);
      const doc = new LoginAccount({
        key: 'valid-account-key-1',
        expiresAt
      });
      await doc.save();

      const found = await LoginAccount.findOne({ key: 'valid-account-key-1' });
      expect(found).not.toBeNull();
      expect(found.key).toBe('valid-account-key-1');
      expect(found.failedAttempts).toBe(0);
      expect(Array.isArray(found.recentFailures)).toBe(true);
      expect(found.recentFailures).toHaveLength(0);
      expect(found.lastAttemptAt).toBeInstanceOf(Date);
      expect(found.expiresAt.getTime()).toBe(expiresAt.getTime());
    });

    it('rejects document without required key', async () => {
      const doc = new LoginAccount({
        expiresAt: new Date()
      });
      await expect(doc.save()).rejects.toThrow(/Account key is required/);
    });

    it('rejects document without required expiresAt', async () => {
      const doc = new LoginAccount({
        key: 'valid-account-key-2'
      });
      await expect(doc.save()).rejects.toThrow(/expiresAt is required/);
    });

    it('enforces unique index constraint on key field', async () => {
      const expiresAt = new Date(Date.now() + ACCOUNT_TTL_SECONDS * 1000);
      const doc1 = new LoginAccount({
        key: 'duplicate-key-check',
        expiresAt
      });
      await doc1.save();

      const doc2 = new LoginAccount({
        key: 'duplicate-key-check',
        expiresAt
      });
      await expect(doc2.save()).rejects.toThrow(/duplicate key error|E11000/);
    });

    it('validates recentFailures subdocument fields and excludes _id', async () => {
      const expiresAt = new Date(Date.now() + ACCOUNT_TTL_SECONDS * 1000);
      const doc = new LoginAccount({
        key: 'subdoc-test-key',
        expiresAt,
        recentFailures: [
          {
            ipHash: 'ip-hash-abc',
            lastSeenAt: new Date()
          }
        ]
      });
      await doc.save();

      const raw = await LoginAccount.collection.findOne({ key: 'subdoc-test-key' });
      expect(raw.recentFailures).toHaveLength(1);
      expect(raw.recentFailures[0].ipHash).toBe('ip-hash-abc');
      expect(raw.recentFailures[0]._id).toBeUndefined();
    });

    it('rejects recentFailures item missing ipHash', async () => {
      const doc = new LoginAccount({
        key: 'missing-iphash-key',
        expiresAt: new Date(),
        recentFailures: [
          {
            lastSeenAt: new Date()
          }
        ]
      });
      await expect(doc.save()).rejects.toThrow(/ipHash is required/);
    });

    it('rejects recentFailures item missing lastSeenAt', async () => {
      const doc = new LoginAccount({
        key: 'missing-lastseen-key',
        expiresAt: new Date(),
        recentFailures: [
          {
            ipHash: 'ip-hash-only'
          }
        ]
      });
      await expect(doc.save()).rejects.toThrow(/lastSeenAt is required/);
    });

    it('confirms schema has zero lockout fields (strictly non-authoritative)', async () => {
      const doc = new LoginAccount({
        key: 'non-authoritative-check',
        expiresAt: new Date()
      });
      expect(doc.lockedUntil).toBeUndefined();
      expect(LoginAccount.schema.paths.lockedUntil).toBeUndefined();
      expect(LoginAccount.schema.paths.lockoutUntil).toBeUndefined();
      expect(LoginAccount.schema.paths.isActiveLockout).toBeUndefined();
    });
  });

  // =========================================================================
  // 2. TTL Index Specification Tests
  // =========================================================================
  describe('Index Configurations', () => {
    it('creates unique index on key and TTL index on expiresAt with expireAfterSeconds 0', async () => {
      const indexes = await LoginAccount.collection.indexes();

      const keyIndex = indexes.find((idx) => idx.key && idx.key.key === 1);
      expect(keyIndex).toBeDefined();
      expect(keyIndex.unique).toBe(true);

      const ttlIndex = indexes.find((idx) => idx.key && idx.key.expiresAt === 1);
      expect(ttlIndex).toBeDefined();
      expect(ttlIndex.expireAfterSeconds).toBe(0);
    });
  });

  // =========================================================================
  // 3. Advisory Delay Formula Tests
  // =========================================================================
  describe('calculateAdvisoryDelay Calculation', () => {
    it('returns 0 ms for 0, 1, or 2 distinct IPs', () => {
      expect(calculateAdvisoryDelay(0)).toBe(0);
      expect(calculateAdvisoryDelay(1)).toBe(0);
      expect(calculateAdvisoryDelay(2)).toBe(0);
    });

    it('returns progressive delay for 3 through 6 distinct IPs', () => {
      expect(calculateAdvisoryDelay(3)).toBe(100);
      expect(calculateAdvisoryDelay(4)).toBe(200);
      expect(calculateAdvisoryDelay(5)).toBe(300);
      expect(calculateAdvisoryDelay(6)).toBe(400);
    });

    it('saturates at 500 ms for 7 distinct IPs', () => {
      expect(calculateAdvisoryDelay(7)).toBe(500);
    });

    it('strictly clamps to 500 ms for counts exceeding 7', () => {
      expect(calculateAdvisoryDelay(8)).toBe(500);
      expect(calculateAdvisoryDelay(10)).toBe(500);
      expect(calculateAdvisoryDelay(20)).toBe(500);
      expect(calculateAdvisoryDelay(50)).toBe(500);
      expect(calculateAdvisoryDelay(1000)).toBe(500);
    });

    it('safely handles non-numeric, negative, or invalid inputs by returning 0', () => {
      expect(calculateAdvisoryDelay(-1)).toBe(0);
      expect(calculateAdvisoryDelay(-50)).toBe(0);
      expect(calculateAdvisoryDelay(NaN)).toBe(0);
      expect(calculateAdvisoryDelay(null)).toBe(0);
      expect(calculateAdvisoryDelay(undefined)).toBe(0);
      expect(calculateAdvisoryDelay('five')).toBe(0);
      expect(calculateAdvisoryDelay({})).toBe(0);
    });

    it('is also callable via LoginAccount.calculateAdvisoryDelay static method', () => {
      expect(LoginAccount.calculateAdvisoryDelay(4)).toBe(200);
    });
  });

  // =========================================================================
  // 4. Atomic Pipeline Update & Cross-IP Spray Tracking
  // =========================================================================
  describe('Atomic Failure Recording (recordAccountFailureAtomic)', () => {
    const testAccountKey = 'acc-key-atomic-test';
    const baseTime = new Date('2026-11-07T12:00:00.000Z');

    it('initializes document on first failure via atomic upsert', async () => {
      const result = await recordAccountFailureAtomic(
        LoginAccount,
        testAccountKey,
        'ip-hash-1',
        baseTime
      );

      expect(result.doc).not.toBeNull();
      expect(result.doc.key).toBe(testAccountKey);
      expect(result.doc.failedAttempts).toBe(1);
      expect(result.doc.recentFailures).toHaveLength(1);
      expect(result.doc.recentFailures[0].ipHash).toBe('ip-hash-1');
      expect(result.doc.recentFailures[0].lastSeenAt).toEqual(baseTime);
      expect(result.distinctIps).toBe(1);
      expect(result.delayMs).toBe(0);
    });

    it('deduplicates repeat failures from the same IP hash without increasing distinct count', async () => {
      const t1 = new Date('2026-11-07T12:00:00.000Z');
      const t2 = new Date('2026-11-07T12:02:00.000Z');
      const t3 = new Date('2026-11-07T12:05:00.000Z');

      await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-hash-repeat', t1);
      await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-hash-repeat', t2);
      const res3 = await recordAccountFailureAtomic(
        LoginAccount,
        testAccountKey,
        'ip-hash-repeat',
        t3
      );

      expect(res3.doc.failedAttempts).toBe(3);
      expect(res3.doc.recentFailures).toHaveLength(1);
      expect(res3.doc.recentFailures[0].ipHash).toBe('ip-hash-repeat');
      expect(res3.doc.recentFailures[0].lastSeenAt).toEqual(t3);
      expect(res3.distinctIps).toBe(1);
      expect(res3.delayMs).toBe(0);
    });

    it('progressively tracks distinct IPs and computes corresponding advisory delays', async () => {
      const t = new Date('2026-11-07T12:00:00.000Z');

      // IP 1: distinct = 1, delay = 0
      const r1 = await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-1', t);
      expect(r1.distinctIps).toBe(1);
      expect(r1.delayMs).toBe(0);

      // IP 2: distinct = 2, delay = 0
      const r2 = await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-2', t);
      expect(r2.distinctIps).toBe(2);
      expect(r2.delayMs).toBe(0);

      // IP 3: distinct = 3, delay = 100 ms
      const r3 = await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-3', t);
      expect(r3.distinctIps).toBe(3);
      expect(r3.delayMs).toBe(100);

      // IP 4: distinct = 4, delay = 200 ms
      const r4 = await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-4', t);
      expect(r4.distinctIps).toBe(4);
      expect(r4.delayMs).toBe(200);

      // IP 5, 6: delay = 300, 400 ms
      await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-5', t);
      const r6 = await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-6', t);
      expect(r6.distinctIps).toBe(6);
      expect(r6.delayMs).toBe(400);

      // IP 7: distinct = 7, delay = 500 ms (saturated)
      const r7 = await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-7', t);
      expect(r7.distinctIps).toBe(7);
      expect(r7.delayMs).toBe(500);
    });

    it('enforces bounded array cap of maximum 20 entries ($slice: -20)', async () => {
      const t = new Date('2026-11-07T12:00:00.000Z');

      // Record failures from 30 distinct IP addresses
      for (let i = 1; i <= 30; i++) {
        await recordAccountFailureAtomic(LoginAccount, testAccountKey, `distinct-ip-${i}`, t);
      }

      const finalDoc = await LoginAccount.findOne({ key: testAccountKey }).lean();
      expect(finalDoc.failedAttempts).toBe(30);
      expect(finalDoc.recentFailures).toHaveLength(MAX_RECENT_IPS);
      expect(finalDoc.recentFailures).toHaveLength(20);

      // Check that the oldest entries (ip-1 to ip-10) were discarded, keeping ip-11 to ip-30
      const preservedHashes = finalDoc.recentFailures.map((item) => item.ipHash);
      expect(preservedHashes).not.toContain('distinct-ip-1');
      expect(preservedHashes).not.toContain('distinct-ip-10');
      expect(preservedHashes).toContain('distinct-ip-11');
      expect(preservedHashes).toContain('distinct-ip-30');

      // Advisory delay remains saturated at 500 ms
      const delay = calculateAdvisoryDelay(finalDoc.recentFailures.length);
      expect(delay).toBe(500);
    });

    it('purges observations older than 15 minutes rolling cutoff', async () => {
      const t0 = new Date('2026-11-07T12:00:00.000Z');

      // Failures from 5 distinct IPs at t0
      for (let i = 1; i <= 5; i++) {
        await recordAccountFailureAtomic(LoginAccount, testAccountKey, `stale-ip-${i}`, t0);
      }
      const docInitial = await LoginAccount.findOne({ key: testAccountKey }).lean();
      expect(docInitial.recentFailures).toHaveLength(5);
      expect(docInitial.failedAttempts).toBe(5);

      // Next failure arrives at t0 + 16 minutes (beyond 15m window)
      const tFuture = new Date(t0.getTime() + 16 * 60 * 1000);
      const resFuture = await recordAccountFailureAtomic(
        LoginAccount,
        testAccountKey,
        'new-fresh-ip',
        tFuture
      );

      // All 5 stale IPs must be purged; only new-fresh-ip remains
      expect(resFuture.doc.recentFailures).toHaveLength(1);
      expect(resFuture.doc.recentFailures[0].ipHash).toBe('new-fresh-ip');
      expect(resFuture.distinctIps).toBe(1);
      expect(resFuture.delayMs).toBe(0);
      // Telemetry counter continues counting total failures
      expect(resFuture.doc.failedAttempts).toBe(6);
    });

    it('preserves recent observations within 15 minutes while purging older ones', async () => {
      const t0 = new Date('2026-11-07T12:00:00.000Z');
      const tOld = new Date(t0.getTime() - 20 * 60 * 1000); // 20m ago (stale)
      const tRecent = new Date(t0.getTime() - 5 * 60 * 1000); // 5m ago (active)

      // Seed stale and recent entries
      await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'old-ip-1', tOld);
      await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'old-ip-2', tOld);
      await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'recent-ip-1', tRecent);

      // Arrive at t0 with new failure
      const res = await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'now-ip', t0);

      // old-ip-1 and old-ip-2 purged; recent-ip-1 and now-ip preserved
      expect(res.distinctIps).toBe(2);
      expect(res.doc.recentFailures.map((i) => i.ipHash)).toEqual(['recent-ip-1', 'now-ip']);
      expect(res.delayMs).toBe(0);
    });

    it('refreshes expiresAt to now + 24 hours on every failure', async () => {
      const t = new Date('2026-11-07T14:30:00.000Z');
      const res = await recordAccountFailureAtomic(LoginAccount, testAccountKey, 'ip-ttl', t);

      const expectedExpiresAt = new Date(t.getTime() + ACCOUNT_TTL_SECONDS * 1000);
      expect(res.doc.expiresAt.getTime()).toBe(expectedExpiresAt.getTime());
    });

    it('is also callable via LoginAccount.recordFailure model static method', async () => {
      const t = new Date('2026-11-07T15:00:00.000Z');
      const res = await LoginAccount.recordFailure(testAccountKey, 'ip-static-method', t);

      expect(res.doc).toBeDefined();
      expect(res.distinctIps).toBe(1);
    });

    it('validates input parameters and throws on invalid accountKey or ipHash', async () => {
      await expect(
        recordAccountFailureAtomic(LoginAccount, '', 'ip-hash', new Date())
      ).rejects.toThrow(TypeError);
      await expect(
        recordAccountFailureAtomic(LoginAccount, null, 'ip-hash', new Date())
      ).rejects.toThrow(TypeError);
      await expect(
        recordAccountFailureAtomic(LoginAccount, 'valid-key', '', new Date())
      ).rejects.toThrow(TypeError);
      await expect(
        recordAccountFailureAtomic(LoginAccount, 'valid-key', null, new Date())
      ).rejects.toThrow(TypeError);
    });
  });

  // =========================================================================
  // 5. Invariant: Advisory Nature & Zero Denial-of-Service Guarantee
  // =========================================================================
  describe('Advisory Nature and Zero Account Lockout Guarantee', () => {
    it('never creates an account-wide lockout regardless of failure volume', async () => {
      const testAccountKey = 'dos-resilience-account';
      const t = new Date('2026-11-07T12:00:00.000Z');

      // Simulate aggressive horizontal credential spray: 50 distinct IPs
      for (let i = 1; i <= 50; i++) {
        await recordAccountFailureAtomic(LoginAccount, testAccountKey, `attacker-ip-${i}`, t);
      }

      const doc = await LoginAccount.findOne({ key: testAccountKey }).lean();
      expect(doc.failedAttempts).toBe(50);
      expect(doc.recentFailures).toHaveLength(MAX_RECENT_IPS);

      // Verify no lockout property exists
      expect(doc.lockedUntil).toBeUndefined();
      expect(doc.isLocked).toBeUndefined();

      // Verify delay is capped at 500 ms
      const delay = calculateAdvisoryDelay(doc.recentFailures.length);
      expect(delay).toBe(500);
      expect(delay).toBeLessThanOrEqual(ADVISORY_DELAY_MAX_MS);
    });
  });
});
