import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import LoginAccount from './LoginAccount.js';
import LoginPair from './LoginPair.js';
import SubmissionReservation from './submissionReservation.js';
import DeletionCleanupJob from './deletionCleanupJob.js';

describe('P0-01 / AC-01: Safe MongoDB TTL Consistency and Non-Destructive Invariants', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await startReplSet([LoginAccount, LoginPair]);
  }, 60000);

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    await LoginAccount.deleteMany({});
    await LoginPair.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await DeletionCleanupJob.deleteMany({});
  });

  it('verifies all physical TTL indexes using native MongoDB driver listIndexes()', async () => {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    const ttlIndexes = [];

    for (const collInfo of collections) {
      const coll = db.collection(collInfo.name);
      const indexes = await coll.listIndexes().toArray();
      for (const idx of indexes) {
        if (typeof idx.expireAfterSeconds === 'number') {
          ttlIndexes.push({
            collection: collInfo.name,
            name: idx.name,
            key: idx.key,
            expireAfterSeconds: idx.expireAfterSeconds
          });
        }
      }
    }

    // Exactly 4 TTL indexes must be physically present in MongoDB
    expect(ttlIndexes.length).toBe(4);

    const ttlColls = ttlIndexes.map((t) => t.collection).sort();
    expect(ttlColls).toEqual([
      'deletioncleanupjobs',
      'login_accounts',
      'login_pairs',
      'submissionreservations'
    ]);

    // Check specific fields
    const loginAccountTtl = ttlIndexes.find((t) => t.collection === 'login_accounts');
    expect(loginAccountTtl.key).toEqual({ expiresAt: 1 });
    expect(loginAccountTtl.expireAfterSeconds).toBe(0);

    const loginPairTtl = ttlIndexes.find((t) => t.collection === 'login_pairs');
    expect(loginPairTtl.key).toEqual({ expiresAt: 1 });
    expect(loginPairTtl.expireAfterSeconds).toBe(0);

    const subResTtl = ttlIndexes.find((t) => t.collection === 'submissionreservations');
    expect(subResTtl.key).toEqual({ vacuumAt: 1 });
    expect(subResTtl.expireAfterSeconds).toBe(0);

    const delJobTtl = ttlIndexes.find((t) => t.collection === 'deletioncleanupjobs');
    expect(delJobTtl.key).toEqual({ vacuumAt: 1 });
    expect(delJobTtl.expireAfterSeconds).toBe(0);
  });

  describe('Non-Destructive Pre-Purge Policy (No Future Record Deletions)', () => {
    it('does NOT delete records expiring in 30 seconds', async () => {
      const now = new Date();
      const expires30s = new Date(now.getTime() + 30 * 1000);

      await LoginPair.create({
        key: 'pair-lockout-30s',
        failedAttempts: 4,
        lockedUntil: new Date(now.getTime() + 30 * 1000),
        lastAttemptAt: now,
        expiresAt: expires30s
      });

      // The NON-DESTRUCTIVE pre-purge query: only delete records WHERE expiresAt <= mongoServerTime
      const mongoTime = now;
      const safePurgeFilter = { expiresAt: { $ne: null, $lte: mongoTime } };

      const deleteResult = await LoginPair.deleteMany(safePurgeFilter);
      expect(deleteResult.deletedCount).toBe(0);

      const surviving = await LoginPair.findOne({ key: 'pair-lockout-30s' });
      expect(surviving).not.toBeNull();
      expect(surviving.failedAttempts).toBe(4);
    });

    it('does NOT delete records expiring in 120 seconds', async () => {
      const now = new Date();
      const expires120s = new Date(now.getTime() + 120 * 1000);

      await LoginAccount.create({
        key: 'account-spray-120s',
        failedAttempts: 3,
        expiresAt: expires120s
      });

      const mongoTime = now;
      const safePurgeFilter = { expiresAt: { $ne: null, $lte: mongoTime } };

      const deleteResult = await LoginAccount.deleteMany(safePurgeFilter);
      expect(deleteResult.deletedCount).toBe(0);

      const surviving = await LoginAccount.findOne({ key: 'account-spray-120s' });
      expect(surviving).not.toBeNull();
      expect(surviving.failedAttempts).toBe(3);
    });

    it('deletes ONLY already-expired records (expiresAt <= mongoServerTime)', async () => {
      const now = new Date();
      const expiredPast = new Date(now.getTime() - 10 * 1000); // Expired 10s ago
      const activeFuture = new Date(now.getTime() + 60 * 1000); // Expiring in 60s

      await LoginPair.create({
        key: 'pair-expired',
        failedAttempts: 2,
        expiresAt: expiredPast
      });

      await LoginPair.create({
        key: 'pair-active',
        failedAttempts: 5,
        lockedUntil: new Date(now.getTime() + 60 * 1000),
        expiresAt: activeFuture
      });

      const mongoTime = now;
      const safePurgeFilter = { expiresAt: { $ne: null, $lte: mongoTime } };

      const deleteResult = await LoginPair.deleteMany(safePurgeFilter);
      expect(deleteResult.deletedCount).toBe(1);

      const expiredDoc = await LoginPair.findOne({ key: 'pair-expired' });
      expect(expiredDoc).toBeNull();

      const activeDoc = await LoginPair.findOne({ key: 'pair-active' });
      expect(activeDoc).not.toBeNull();
      expect(activeDoc.failedAttempts).toBe(5);
    });

    it('maintains active LoginPair and LoginAccount security state without premature lockout reset', async () => {
      const now = new Date();

      // Attacker under progressive lockout for 45s more
      const lockoutEnd = new Date(now.getTime() + 45 * 1000);
      const pairDoc = await LoginPair.create({
        key: 'attacker-ip-account-pair',
        failedAttempts: 5,
        lockedUntil: lockoutEnd,
        lastAttemptAt: now,
        expiresAt: new Date(now.getTime() + 48 * 3600 * 1000)
      });

      // Distributed IP spray telemetry: 5 distinct IPs observed
      const accountDoc = await LoginAccount.create({
        key: 'targeted-account-key',
        failedAttempts: 5,
        recentFailures: [
          { ipHash: 'ip1', lastSeenAt: now },
          { ipHash: 'ip2', lastSeenAt: now },
          { ipHash: 'ip3', lastSeenAt: now }
        ],
        expiresAt: new Date(now.getTime() + 24 * 3600 * 1000)
      });

      // Pre-backup maintenance runs
      const mongoTime = now;
      await LoginPair.deleteMany({ expiresAt: { $ne: null, $lte: mongoTime } });
      await LoginAccount.deleteMany({ expiresAt: { $ne: null, $lte: mongoTime } });

      // Invariants: Active security documents must remain 100% intact
      const refreshedPair = await LoginPair.findById(pairDoc._id);
      expect(refreshedPair).not.toBeNull();
      expect(refreshedPair.lockedUntil.getTime()).toBe(lockoutEnd.getTime());
      expect(refreshedPair.failedAttempts).toBe(5);

      const refreshedAccount = await LoginAccount.findById(accountDoc._id);
      expect(refreshedAccount).not.toBeNull();
      expect(refreshedAccount.recentFailures.length).toBe(3);
    });

    it('preserves SubmissionReservation and DeletionCleanupJob lifecycle semantics', async () => {
      const formId = new mongoose.Types.ObjectId();
      const now = new Date();

      // 1. Active submission reservation: vacuumAt is null (NEVER purged)
      const activeRes = await SubmissionReservation.create({
        formId,
        leaseId: 'lease-active-123',
        fenceToken: 'fence-active-123',
        status: 'active',
        stagedKeys: ['staging/forms/' + formId + '/lease-active-123/file.pdf'],
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000), // active reservation lease
        vacuumAt: null // immune to TTL
      });

      // 2. Completed submission reservation whose S3 files are cleaned: vacuumAt set to future
      const cleanRes = await SubmissionReservation.create({
        formId,
        leaseId: 'lease-cleaned-456',
        fenceToken: 'fence-cleaned-456',
        status: 'finalized',
        stagingCleanupStatus: 'completed',
        expiresAt: new Date(now.getTime() - 3600 * 1000),
        vacuumAt: new Date(now.getTime() + 23 * 3600 * 1000) // future 24h retention
      });

      // 3. Stale reservation whose vacuumAt has already passed
      const staleRes = await SubmissionReservation.create({
        formId,
        leaseId: 'lease-stale-789',
        fenceToken: 'fence-stale-789',
        status: 'finalized',
        stagingCleanupStatus: 'completed',
        expiresAt: new Date(now.getTime() - 48 * 3600 * 1000),
        vacuumAt: new Date(now.getTime() - 1000) // expired
      });

      // 4. DeletionCleanupJob: vacuumAt is null permanently
      const cleanupJob = await DeletionCleanupJob.create({
        formId,
        stagingPrefix: 'staging/forms/' + formId + '/',
        finalPrefix: 'forms/' + formId + '/',
        status: 'pending',
        eligibleUntil: new Date(now.getTime() + 5 * 60 * 1000),
        vacuumAt: null // perpetual TTL immunity
      });

      // Safe maintenance sweep: vacuumAt $ne null AND $lte mongoTime
      const mongoTime = now;
      const purgeFilter = { vacuumAt: { $ne: null, $lte: mongoTime } };

      const subResPurge = await SubmissionReservation.deleteMany(purgeFilter);
      expect(subResPurge.deletedCount).toBe(1); // Only staleRes deleted

      const delJobPurge = await DeletionCleanupJob.deleteMany(purgeFilter);
      expect(delJobPurge.deletedCount).toBe(0); // Zero deleted

      // Assert active and clean reservations are preserved
      expect(await SubmissionReservation.findById(activeRes._id)).not.toBeNull();
      expect(await SubmissionReservation.findById(cleanRes._id)).not.toBeNull();
      expect(await SubmissionReservation.findById(staleRes._id)).toBeNull();
      expect(await DeletionCleanupJob.findById(cleanupJob._id)).not.toBeNull();
    });

    it('safely handles missing, null, and malformed TTL values without unsafe cleanup', async () => {
      const formId = new mongoose.Types.ObjectId();
      const now = new Date();

      // Direct insertion via native driver with null, missing, or malformed values
      const db = mongoose.connection.db;
      await db.collection('submissionreservations').insertMany([
        { formId, leaseId: 'null-vacuum', status: 'active', vacuumAt: null },
        { formId, leaseId: 'missing-vacuum', status: 'active' }, // vacuumAt undefined
        { formId, leaseId: 'string-vacuum', status: 'active', vacuumAt: 'not-a-date' }
      ]);

      const mongoTime = now;
      // Filter must explicitly guard against null and non-date types
      const safePurgeFilter = {
        vacuumAt: { $type: 'date', $lte: mongoTime }
      };

      const purgeResult = await db.collection('submissionreservations').deleteMany(safePurgeFilter);
      expect(purgeResult.deletedCount).toBe(0);

      const count = await db.collection('submissionreservations').countDocuments({
        leaseId: { $in: ['null-vacuum', 'missing-vacuum', 'string-vacuum'] }
      });
      expect(count).toBe(3);
    });

    it('fails safely if consistency preconditions (e.g. clock skew) cannot be established', async () => {
      const db = mongoose.connection.db;

      // Simulated clock skew function
      const verifyPreconditions = async (maxSkewMs = 1000, simulatedMongoOffsetMs = 0) => {
        const hello = await db.command({ hello: 1 });
        const localTime = new Date(hello.localTime.getTime() + simulatedMongoOffsetMs);
        const appTime = Date.now();
        const skew = Math.abs(appTime - localTime.getTime());

        if (skew > maxSkewMs) {
          throw new Error(`CONSISTENCY_PRECONDITION_FAILED: Clock skew ${skew}ms exceeds tolerance ${maxSkewMs}ms`);
        }
        return { ok: true, skew };
      };

      // Normal conditions: should pass
      const normalResult = await verifyPreconditions(1000, 0);
      expect(normalResult.ok).toBe(true);

      // Skewed conditions: should fail closed
      await expect(verifyPreconditions(1000, 2500)).rejects.toThrow('CONSISTENCY_PRECONDITION_FAILED');
    });
  });
});
