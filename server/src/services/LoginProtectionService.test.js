import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import LoginProtectionService from './LoginProtectionService.js';
import LoginPair from '../models/LoginPair.js';
import LoginAccount from '../models/LoginAccount.js';
import {
  derivePairKey,
  deriveAccountKey,
  deriveIpHash,
  parseHmacSecret
} from '../utils/loginProtectionCrypto.js';

describe('LoginProtectionService Atomicity and Adversarial Concurrency Suite', () => {
  let mongod;
  let service;
  const TEST_SECRET = 'paperless-test-hmac-secret-at-least-32-bytes-long';
  const secretBuffer = parseHmacSecret(TEST_SECRET);

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Promise.all([LoginPair.init(), LoginAccount.init()]);
    service = new LoginProtectionService({
      pairModel: LoginPair,
      accountModel: LoginAccount,
      secretBuffer
    });
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Progressive Lockout Escalation and Inactivity Decay Tests
  // =========================================================================
  describe('Progressive Lockout Escalation and Inactivity Decay', () => {
    it('increments failedAttempts from 1 to 4 with lockedUntil remaining null (Tier 1)', async () => {
      const pairKey = 'test-pair-tier1';
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      for (let attempt = 1; attempt <= 4; attempt++) {
        const attemptTime = new Date(t0.getTime() + attempt * 1000);
        const result = await service.recordPairFailureAtomic(pairKey, attemptTime);

        expect(result.status).toBe('RECORDED');
        expect(result.failedAttempts).toBe(attempt);
        expect(result.revision).toBe(attempt);
        expect(result.lockedUntil).toBeNull();
      }

      const preCheck = await service.checkPairLockout(pairKey, new Date(t0.getTime() + 5000));
      expect(preCheck.isLocked).toBe(false);
      expect(preCheck.retryAfterSeconds).toBe(0);
      expect(preCheck.revision).toBe(4);
    });

    it('triggers a 15-minute lockout on attempt 5 (Tier 2 entry)', async () => {
      const pairKey = 'test-pair-tier2-entry';
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      for (let i = 1; i <= 4; i++) {
        await service.recordPairFailureAtomic(pairKey, new Date(t0.getTime() + i * 1000));
      }

      const t5 = new Date(t0.getTime() + 5000);
      const res5 = await service.recordPairFailureAtomic(pairKey, t5);

      expect(res5.status).toBe('LOCKOUT_INITIATED');
      expect(res5.failedAttempts).toBe(5);
      expect(res5.revision).toBe(5);
      expect(res5.lockedUntil).toBeInstanceOf(Date);
      expect(res5.lockedUntil.getTime()).toBe(t5.getTime() + 15 * 60 * 1000);

      const preCheck = await service.checkPairLockout(pairKey, new Date(t5.getTime() + 60000));
      expect(preCheck.isLocked).toBe(true);
      expect(preCheck.retryAfterSeconds).toBe(14 * 60);
      expect(preCheck.revision).toBe(5);
    });

    it('escalates to failure 6 when attempt arrives within 15 minutes after lockout expires', async () => {
      const pairKey = 'test-pair-attempt-6';
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      for (let i = 1; i <= 5; i++) {
        await service.recordPairFailureAtomic(pairKey, new Date(t0.getTime() + i * 1000));
      }

      const doc5 = await LoginPair.findOne({ key: pairKey });
      const lockoutExpiry = doc5.lockedUntil;

      // Attempt arrives 1 minute after lockout expiry (16 minutes after failure 5)
      // Because cooldown is measured from lockedUntil, now - lockedUntil = 1m <= 15m: NOT decayed!
      const t6 = new Date(lockoutExpiry.getTime() + 60 * 1000);
      const res6 = await service.recordPairFailureAtomic(pairKey, t6);

      expect(res6.status).toBe('LOCKOUT_INITIATED');
      expect(res6.failedAttempts).toBe(6);
      expect(res6.revision).toBe(6);
      expect(res6.lockedUntil.getTime()).toBe(t6.getTime() + 15 * 60 * 1000);
    });

    it('escalates through Tier 3 (10 failures = 60m lockout) and Tier 4 (15 failures = 24h lockout)', async () => {
      const pairKey = 'test-pair-tier3-and-tier4';
      let curTime = new Date('2026-11-07T10:00:00.000Z');

      // Failures 1 to 5
      for (let i = 1; i <= 5; i++) {
        curTime = new Date(curTime.getTime() + 1000);
        await service.recordPairFailureAtomic(pairKey, curTime);
      }

      // Failures 6 to 9 (15-minute lockouts)
      for (let i = 6; i <= 9; i++) {
        const doc = await LoginPair.findOne({ key: pairKey });
        curTime = new Date(doc.lockedUntil.getTime() + 5000);
        const res = await service.recordPairFailureAtomic(pairKey, curTime);
        expect(res.failedAttempts).toBe(i);
        expect(res.lockedUntil.getTime()).toBe(curTime.getTime() + 15 * 60 * 1000);
      }

      // Failure 10: Tier 3 entry (60-minute lockout)
      const doc9 = await LoginPair.findOne({ key: pairKey });
      curTime = new Date(doc9.lockedUntil.getTime() + 5000);
      const res10 = await service.recordPairFailureAtomic(pairKey, curTime);
      expect(res10.failedAttempts).toBe(10);
      expect(res10.lockedUntil.getTime()).toBe(curTime.getTime() + 60 * 60 * 1000);

      // Failures 11 to 14 (60-minute lockouts)
      for (let i = 11; i <= 14; i++) {
        const doc = await LoginPair.findOne({ key: pairKey });
        curTime = new Date(doc.lockedUntil.getTime() + 5000);
        const res = await service.recordPairFailureAtomic(pairKey, curTime);
        expect(res.failedAttempts).toBe(i);
        expect(res.lockedUntil.getTime()).toBe(curTime.getTime() + 60 * 60 * 1000);
      }

      // Failure 15: Tier 4 entry (24-hour lockout)
      const doc14 = await LoginPair.findOne({ key: pairKey });
      curTime = new Date(doc14.lockedUntil.getTime() + 5000);
      const res15 = await service.recordPairFailureAtomic(pairKey, curTime);
      expect(res15.failedAttempts).toBe(15);
      expect(res15.lockedUntil.getTime()).toBe(curTime.getTime() + 24 * 60 * 60 * 1000);
    });

    it('resets counter to 1 when attempt arrives strictly more than 15 minutes after lockout expiry', async () => {
      const pairKey = 'test-pair-inactivity-after-lockout';
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      for (let i = 1; i <= 5; i++) {
        await service.recordPairFailureAtomic(pairKey, new Date(t0.getTime() + i * 1000));
      }

      const doc5 = await LoginPair.findOne({ key: pairKey });
      const lockoutExpiry = doc5.lockedUntil;

      // Arrives 16 minutes after lockout expiry (> 15m cooldown): decay triggers!
      const tDecay = new Date(lockoutExpiry.getTime() + 16 * 60 * 1000);
      const resDecay = await service.recordPairFailureAtomic(pairKey, tDecay);

      expect(resDecay.status).toBe('RECORDED');
      expect(resDecay.failedAttempts).toBe(1);
      expect(resDecay.lockedUntil).toBeNull();
      expect(resDecay.revision).toBe(6); // Monotonically incrementing revision
    });

    it('resets counter to 1 when attempt arrives strictly more than 15 minutes after lastAttemptAt when no lockout existed', async () => {
      const pairKey = 'test-pair-inactivity-unlocked';
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      await service.recordPairFailureAtomic(pairKey, t0);
      await service.recordPairFailureAtomic(pairKey, new Date(t0.getTime() + 1000));
      await service.recordPairFailureAtomic(pairKey, new Date(t0.getTime() + 2000));

      const doc3 = await LoginPair.findOne({ key: pairKey });
      expect(doc3.failedAttempts).toBe(3);

      // Arrives 16 minutes after attempt 3
      const tDecay = new Date(t0.getTime() + 2000 + 16 * 60 * 1000);
      const resDecay = await service.recordPairFailureAtomic(pairKey, tDecay);

      expect(resDecay.status).toBe('RECORDED');
      expect(resDecay.failedAttempts).toBe(1);
      expect(resDecay.lockedUntil).toBeNull();
      expect(resDecay.revision).toBe(4);
    });

    it('does not reset at exact 15-minute boundary ($gt condition)', async () => {
      const pairKey = 'test-pair-exact-boundary';
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      await service.recordPairFailureAtomic(pairKey, t0);

      // Exactly 15 minutes (15 * 60 * 1000 ms)
      const tExact = new Date(t0.getTime() + 15 * 60 * 1000);
      const res = await service.recordPairFailureAtomic(pairKey, tExact);

      // Because condition is $gt INACTIVITY_WINDOW_MS, at exactly 15m it is NOT decayed
      expect(res.failedAttempts).toBe(2);
    });
  });

  // =========================================================================
  // 2. Stale Pre-Check Absorption Tests
  // =========================================================================
  describe('Stale Pre-Check Absorption', () => {
    it('absorbs stale failure during active lockout without counter increment or lockout extension', async () => {
      const pairKey = 'test-pair-stale-absorption';
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      // Setup 4 failures
      for (let i = 1; i <= 4; i++) {
        await service.recordPairFailureAtomic(pairKey, new Date(t0.getTime() + i * 1000));
      }

      // Request B establishes lockout at tB
      const tB = new Date(t0.getTime() + 5000);
      const resB = await service.recordPairFailureAtomic(pairKey, tB);
      expect(resB.status).toBe('LOCKOUT_INITIATED');
      expect(resB.failedAttempts).toBe(5);
      const initialLockedUntil = resB.lockedUntil;

      // Request A (stale pre-check) attempts to record failure at tA (10 seconds later)
      const tA = new Date(t0.getTime() + 15000);
      const resA = await service.recordPairFailureAtomic(pairKey, tA);

      expect(resA.status).toBe('ACTIVE_LOCKOUT');
      expect(resA.failedAttempts).toBe(5);
      expect(resA.revision).toBe(5);
      expect(resA.lockedUntil.getTime()).toBe(initialLockedUntil.getTime());

      // Inspect persisted database record directly
      const doc = await LoginPair.findOne({ key: pairKey });
      expect(doc.failedAttempts).toBe(5);
      expect(doc.revision).toBe(5);
      expect(doc.lockedUntil.getTime()).toBe(initialLockedUntil.getTime());
    });
  });

  // =========================================================================
  // 3. E11000 Duplicate Key Race and Initial Upsert Tests
  // =========================================================================
  describe('E11000 Duplicate Key Race Handling', () => {
    it('catches E11000 on concurrent initial upserts and retries with upsert: false', async () => {
      const pairKey = 'test-pair-e11000-race';
      const now = new Date('2026-11-07T10:00:00.000Z');

      const [res1, res2] = await Promise.all([
        service.recordPairFailureAtomic(pairKey, now),
        service.recordPairFailureAtomic(pairKey, new Date(now.getTime() + 10))
      ]);

      expect(res1.status).toBe('RECORDED');
      expect(res2.status).toBe('RECORDED');

      const doc = await LoginPair.findOne({ key: pairKey });
      expect(doc.failedAttempts).toBe(2);
      expect(doc.revision).toBe(2);
    });
  });

  // =========================================================================
  // 4. Null Update Doc Handling and Reread Branch Tests
  // =========================================================================
  describe('Null Update Document Handling and Reread Logic', () => {
    it('returns ACTIVE_LOCKOUT when reread detects concurrent active lockout', async () => {
      const pairKey = 'test-pair-null-lockout';
      const now = new Date('2026-11-07T10:00:00.000Z');

      await LoginPair.create({
        key: pairKey,
        failedAttempts: 5,
        lockedUntil: new Date(now.getTime() + 15 * 60 * 1000),
        lastAttemptAt: now,
        revision: 5,
        expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000)
      });

      const res = await service.recordPairFailureAtomic(pairKey, now);
      expect(res.status).toBe('ACTIVE_LOCKOUT');
      expect(res.failedAttempts).toBe(5);
      expect(res.revision).toBe(5);
    });

    it('retries with upsert: true when reread sees document was concurrently deleted', async () => {
      const pairKey = 'test-pair-null-deleted-retry';
      const now = new Date('2026-11-07T10:00:00.000Z');

      const res = await service.recordPairFailureAtomic(pairKey, now);
      expect(res.status).toBe('RECORDED');
      expect(res.failedAttempts).toBe(1);
      expect(res.revision).toBe(1);
    });
  });

  // =========================================================================
  // 5. Successful Login OCC Reset Tests
  // =========================================================================
  describe('Successful-Login Optimistic Concurrency Control (OCC) Reset', () => {
    it('deletes document and returns RESET_SUCCESS when revision matches', async () => {
      const pairKey = 'test-pair-occ-match';
      const now = new Date('2026-11-07T10:00:00.000Z');

      await service.recordPairFailureAtomic(pairKey, now);
      await service.recordPairFailureAtomic(pairKey, new Date(now.getTime() + 1000));
      const doc = await LoginPair.findOne({ key: pairKey });
      expect(doc.revision).toBe(2);

      const resetRes = await service.resetPairOnSuccess(pairKey, 2);
      expect(resetRes.status).toBe('RESET_SUCCESS');
      expect(resetRes.deletedCount).toBe(1);

      const docAfter = await LoginPair.findOne({ key: pairKey });
      expect(docAfter).toBeNull();
    });

    it('returns RESET_ABSENT when document does not exist in collection', async () => {
      const pairKey = 'test-pair-occ-absent';
      const resetRes = await service.resetPairOnSuccess(pairKey, 1);
      expect(resetRes.status).toBe('RESET_ABSENT');
      expect(resetRes.deletedCount).toBe(0);
    });

    it('returns REVISION_MISMATCH and preserves document when newer concurrent failure occurred', async () => {
      const pairKey = 'test-pair-occ-mismatch';
      const now = new Date('2026-11-07T10:00:00.000Z');

      // Login admitted when revision was 2
      await service.recordPairFailureAtomic(pairKey, now);
      await service.recordPairFailureAtomic(pairKey, new Date(now.getTime() + 1000));

      // Concurrent request records failure before password check completes, advancing revision to 3
      await service.recordPairFailureAtomic(pairKey, new Date(now.getTime() + 2000));

      // Login succeeds and attempts reset with stale revision 2
      const resetRes = await service.resetPairOnSuccess(pairKey, 2);
      expect(resetRes.status).toBe('REVISION_MISMATCH');
      expect(resetRes.deletedCount).toBe(0);
      expect(resetRes.currentRevision).toBe(3);
      expect(resetRes.expectedRevision).toBe(2);

      // Verify newer failure is strictly preserved in database
      const docAfter = await LoginPair.findOne({ key: pairKey });
      expect(docAfter).not.toBeNull();
      expect(docAfter.failedAttempts).toBe(3);
      expect(docAfter.revision).toBe(3);
    });

    it('returns REVISION_MISMATCH when admitted with null revision but concurrent failure occurred', async () => {
      const pairKey = 'test-pair-occ-null-revision';
      const now = new Date('2026-11-07T10:00:00.000Z');

      // Concurrent failure creates document before password check finishes
      await service.recordPairFailureAtomic(pairKey, now);

      const resetRes = await service.resetPairOnSuccess(pairKey, null);
      expect(resetRes.status).toBe('REVISION_MISMATCH');
      expect(resetRes.deletedCount).toBe(0);

      const docAfter = await LoginPair.findOne({ key: pairKey });
      expect(docAfter).not.toBeNull();
      expect(docAfter.failedAttempts).toBe(1);
    });

    it('returns RESET_ABSENT when admitted with null revision and document remains absent', async () => {
      const pairKey = 'test-pair-occ-null-clean';
      const resetRes = await service.resetPairOnSuccess(pairKey, null);
      expect(resetRes.status).toBe('RESET_ABSENT');
      expect(resetRes.deletedCount).toBe(0);
    });
  });

  // =========================================================================
  // 6. Cross-IP Advisory Account Telemetry Tests
  // =========================================================================
  describe('Cross-IP Account Telemetry & Advisory Delays', () => {
    it('deduplicates identical IP hashes and applies progressive advisory delays up to 500ms', async () => {
      const accountKey = 'test-account-telemetry';
      const t0 = new Date('2026-11-07T10:00:00.000Z');

      // IP 1 first failure
      const r1 = await service.recordAccountFailureAtomic(accountKey, 'hash-ip-1', t0);
      expect(r1.distinctIps).toBe(1);
      expect(r1.delayMs).toBe(0);
      expect(r1.doc.failedAttempts).toBe(1);

      // IP 1 second failure (deduplicated)
      const r2 = await service.recordAccountFailureAtomic(
        accountKey,
        'hash-ip-1',
        new Date(t0.getTime() + 1000)
      );
      expect(r2.distinctIps).toBe(1);
      expect(r2.delayMs).toBe(0);
      expect(r2.doc.failedAttempts).toBe(2);

      // Distinct IP 2
      const r3 = await service.recordAccountFailureAtomic(
        accountKey,
        'hash-ip-2',
        new Date(t0.getTime() + 2000)
      );
      expect(r3.distinctIps).toBe(2);
      expect(r3.delayMs).toBe(0);

      // Distinct IP 3: delay = (3-2)*100 = 100ms
      const r4 = await service.recordAccountFailureAtomic(
        accountKey,
        'hash-ip-3',
        new Date(t0.getTime() + 3000)
      );
      expect(r4.distinctIps).toBe(3);
      expect(r4.delayMs).toBe(100);

      // Add up to 7 distinct IPs: delay = (7-2)*100 = 500ms
      for (let i = 4; i <= 7; i++) {
        await service.recordAccountFailureAtomic(
          accountKey,
          `hash-ip-${i}`,
          new Date(t0.getTime() + i * 1000)
        );
      }
      const r7 = await service.recordAccountFailureAtomic(
        accountKey,
        'hash-ip-7-verify',
        new Date(t0.getTime() + 8000)
      );
      expect(r7.delayMs).toBe(500);

      // Add up to 25 distinct IPs: bounded array strictly capped at 20 entries
      for (let i = 8; i <= 25; i++) {
        await service.recordAccountFailureAtomic(
          accountKey,
          `hash-ip-${i}`,
          new Date(t0.getTime() + i * 1000)
        );
      }
      const docAccount = await LoginAccount.findOne({ key: accountKey });
      expect(docAccount.recentFailures.length).toBe(20);
      expect(docAccount.failedAttempts).toBe(27);

      // Purge observations older than 15 minutes
      const tFuture = new Date(t0.getTime() + 30 * 60 * 1000);
      const rFuture = await service.recordAccountFailureAtomic(
        accountKey,
        'hash-ip-future',
        tFuture
      );
      expect(rFuture.distinctIps).toBe(1);
      expect(rFuture.delayMs).toBe(0);
    });

    it('handles concurrent initial upserts on LoginAccount without collision errors', async () => {
      const accountKey = 'test-account-e11000-race';
      const now = new Date('2026-11-07T10:00:00.000Z');

      const [r1, r2] = await Promise.all([
        service.recordAccountFailureAtomic(accountKey, 'hash-ip-a', now),
        service.recordAccountFailureAtomic(accountKey, 'hash-ip-b', new Date(now.getTime() + 10))
      ]);

      expect(r1.doc).toBeDefined();
      expect(r2.doc).toBeDefined();

      const doc = await LoginAccount.findOne({ key: accountKey });
      expect(doc.failedAttempts).toBe(2);
      expect(doc.recentFailures.length).toBe(2);
    });
  });

  // =========================================================================
  // 7. Database Failure Resilience Tests
  // =========================================================================
  describe('Database Failure Resilience (Fail-Closed)', () => {
    it('rethrows MongoDB errors cleanly across all methods without crashing', async () => {
      const mockFaultyModel = {
        findOne: async () => {
          throw new Error('MongoTopologyClosedError');
        },
        findOneAndUpdate: async () => {
          throw new Error('MongoTopologyClosedError');
        },
        deleteOne: async () => {
          throw new Error('MongoTopologyClosedError');
        }
      };

      const faultyService = new LoginProtectionService({
        pairModel: mockFaultyModel,
        accountModel: mockFaultyModel,
        secretBuffer
      });

      await expect(faultyService.checkPairLockout('any-key')).rejects.toThrow(
        'MongoTopologyClosedError'
      );
      await expect(faultyService.recordPairFailureAtomic('any-key')).rejects.toThrow(
        'MongoTopologyClosedError'
      );
      await expect(faultyService.resetPairOnSuccess('any-key', 1)).rejects.toThrow(
        'MongoTopologyClosedError'
      );
      await expect(faultyService.recordAccountFailureAtomic('any-key', 'hash')).rejects.toThrow(
        'MongoTopologyClosedError'
      );
    });
  });

  // =========================================================================
  // 8. Privacy & Data Minimization Assertions
  // =========================================================================
  describe('Privacy and Zero-Knowledge Storage Assertions', () => {
    it('guarantees zero plaintext emails, IP addresses, passwords, or hashes exist in database', async () => {
      const rawIp = '10.20.30.40';
      const rawEmail = 'sensitive_officer@domain.corp';
      const rawPassword = 'HighlySecretPassword2026!';

      const pairKey = derivePairKey(rawIp, rawEmail, secretBuffer);
      const accountKey = deriveAccountKey(rawEmail, secretBuffer);
      const ipHash = deriveIpHash(rawIp, secretBuffer);

      await service.recordPairFailureAtomic(pairKey);
      await service.recordAccountFailureAtomic(accountKey, ipHash);

      const pairDoc = await LoginPair.findOne({ key: pairKey }).lean();
      const accountDoc = await LoginAccount.findOne({ key: accountKey }).lean();

      const pairDump = JSON.stringify(pairDoc);
      const accountDump = JSON.stringify(accountDoc);

      expect(pairDump).not.toContain(rawIp);
      expect(pairDump).not.toContain(rawEmail);
      expect(pairDump).not.toContain(rawPassword);

      expect(accountDump).not.toContain(rawIp);
      expect(accountDump).not.toContain(rawEmail);
      expect(accountDump).not.toContain(rawPassword);
    });
  });

  // =========================================================================
  // 9. High-Concurrency Race Torture Tests
  // =========================================================================
  describe('High-Concurrency Race Torture Test', () => {
    it('maintains strict state serialization under 20 concurrent failure updates', async () => {
      const pairKey = 'test-pair-torture-race';
      const now = new Date('2026-11-07T10:00:00.000Z');

      const updates = Array.from({ length: 20 }, (_, i) =>
        service.recordPairFailureAtomic(pairKey, new Date(now.getTime() + i * 10))
      );

      const results = await Promise.all(updates);
      expect(results).toHaveLength(20);

      const doc = await LoginPair.findOne({ key: pairKey });
      expect(doc.failedAttempts).toBeGreaterThanOrEqual(5);
      expect(doc.lockedUntil).toBeInstanceOf(Date);
      expect(doc.lockedUntil.getTime()).toBeGreaterThan(now.getTime());

      // Guarantee lockout was not pushed arbitrarily far by stale requests
      const maxAllowedLockedUntil = new Date(now.getTime() + 15 * 60 * 1000 + 1000);
      expect(doc.lockedUntil.getTime()).toBeLessThanOrEqual(maxAllowedLockedUntil.getTime());
    });
  });
});
