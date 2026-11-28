import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import StorageJournal, { STORAGE_JOURNAL_STATUS, STORAGE_OPERATION_TYPE } from '../models/storageJournal.js';
import {
  StorageJournalMigrationLedger,
  MIGRATION_LEDGER_STATUS
} from '../models/storageJournalMigrationLedger.js';
import { StorageJournalMigrationLease } from '../models/storageJournalMigrationLease.js';
import {
  runStorageJournalRetentionMigration,
  MigrationSafeguardError,
  MigrationLeaseError,
  TARGET_COLLECTION,
  MIGRATION_LEASE_ID
} from './storageJournalRetentionMigrationService.js';
import { verifyRecoverySet } from '../utils/recoveryVerifier.js';

describe('storageJournalRetentionMigrationService (Disposable Replica Set)', () => {
  let replSet;
  let dbName;

  beforeAll(async () => {
    replSet = await startReplSet([
      StorageJournal,
      StorageJournalMigrationLedger,
      StorageJournalMigrationLease
    ]);
    dbName = mongoose.connection.db.databaseName;
  }, 60000);

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    await StorageJournal.deleteMany({});
    await StorageJournalMigrationLedger.deleteMany({});
    await StorageJournalMigrationLease.deleteMany({});
  });

  async function seedMixedJournalRecords() {
    const now = new Date();
    const expired = new Date(now.getTime() - 24 * 3600 * 1000);
    const future = new Date(now.getTime() + 7 * 24 * 3600 * 1000);

    const docs = [
      { operationId: crypto.randomUUID(), type: STORAGE_OPERATION_TYPE.PUT_OBJECT, status: STORAGE_JOURNAL_STATUS.COMMITTED, destinationKey: 'forms/f1/r1/a.pdf', vacuumAt: expired },
      { operationId: crypto.randomUUID(), type: STORAGE_OPERATION_TYPE.PUT_OBJECT, status: STORAGE_JOURNAL_STATUS.COMMITTED, destinationKey: 'forms/f1/r2/b.pdf', vacuumAt: future },
      { operationId: crypto.randomUUID(), type: STORAGE_OPERATION_TYPE.COPY_OBJECT, status: STORAGE_JOURNAL_STATUS.COMMITTED, destinationKey: 'forms/f1/r3/c.pdf', vacuumAt: future },
      { operationId: crypto.randomUUID(), type: STORAGE_OPERATION_TYPE.PUT_OBJECT, status: STORAGE_JOURNAL_STATUS.COMMITTED, destinationKey: 'forms/f1/r4/d.pdf', vacuumAt: null },
      { operationId: crypto.randomUUID(), type: STORAGE_OPERATION_TYPE.PUT_OBJECT, status: STORAGE_JOURNAL_STATUS.COMPENSATED, destinationKey: 'staging/s1.pdf', vacuumAt: expired },
      { operationId: crypto.randomUUID(), type: STORAGE_OPERATION_TYPE.PUT_OBJECT, status: STORAGE_JOURNAL_STATUS.ABANDONED, destinationKey: 'staging/s2.pdf', vacuumAt: expired },
      { operationId: crypto.randomUUID(), type: STORAGE_OPERATION_TYPE.DELETE_OBJECT, status: STORAGE_JOURNAL_STATUS.CONFIRMED, destinationKey: 'forms/f1/old.pdf', vacuumAt: future },
      { operationId: crypto.randomUUID(), type: STORAGE_OPERATION_TYPE.PUT_OBJECT, status: STORAGE_JOURNAL_STATUS.PENDING, destinationKey: 'staging/p1.pdf', vacuumAt: null }
    ];

    await StorageJournal.insertMany(docs);

    // Insert raw malformed non-Date COMMITTED record directly to test $type: 'date' exclusion
    await mongoose.connection.db.collection(TARGET_COLLECTION).insertOne({
      operationId: crypto.randomUUID(),
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      status: STORAGE_JOURNAL_STATUS.COMMITTED,
      destinationKey: 'forms/f1/r5/malformed.pdf',
      vacuumAt: 'not-a-date'
    });

    return { expired, future };
  }

  it('runs in DRY_RUN mode by default with zero database writes', async () => {
    await seedMixedJournalRecords();

    const result = await runStorageJournalRetentionMigration();

    expect(result.mode).toBe('DRY_RUN');
    expect(result.databaseName).toBe(dbName);
    expect(result.eligibleCount).toBe(3);
    expect(result.expiredEligibleCount).toBe(1);
    expect(result.futureEligibleCount).toBe(2);
    expect(result.malformedCount).toBe(1);
    expect(await StorageJournalMigrationLedger.countDocuments({})).toBe(0);
    expect(await StorageJournalMigrationLease.countDocuments({})).toBe(0);
  });

  it('rejects APPLY mode when safeguards or confirmations are missing', async () => {
    await expect(
      runStorageJournalRetentionMigration({ apply: true, mode: 'APPLY', databaseName: 'wrong_db', migrationId: 'm1', targetCollection: TARGET_COLLECTION })
    ).rejects.toThrow(MigrationSafeguardError);

    await expect(
      runStorageJournalRetentionMigration({ apply: true, mode: 'APPLY', databaseName: dbName, migrationId: '', targetCollection: TARGET_COLLECTION })
    ).rejects.toThrow(MigrationSafeguardError);

    await expect(
      runStorageJournalRetentionMigration({ apply: true, mode: 'APPLY', databaseName: dbName, migrationId: 'm1', targetCollection: 'other_col' })
    ).rejects.toThrow(MigrationSafeguardError);
  });

  it('migrates only COMMITTED Date-valued records in bounded batches, preserves ledger, and is idempotent', async () => {
    await seedMixedJournalRecords();

    const applyRes = await runStorageJournalRetentionMigration({
      apply: true,
      mode: 'APPLY',
      databaseName: dbName,
      migrationId: 'mig-test-1',
      targetCollection: TARGET_COLLECTION,
      batchSize: 2
    });

    expect(applyRes.mode).toBe('APPLY');
    expect(applyRes.batchesCompleted).toBe(2);
    expect(applyRes.recordsMigrated).toBe(3);
    expect(applyRes.recordsVerified).toBe(3);
    expect(applyRes.remainingEligibleCount).toBe(0);

    // Ledger entries created and verified
    const ledgerEntries = await StorageJournalMigrationLedger.find({ migrationId: 'mig-test-1' }).lean();
    expect(ledgerEntries).toHaveLength(3);
    for (const entry of ledgerEntries) {
      expect(entry.status).toBe(MIGRATION_LEDGER_STATUS.VERIFIED);
      expect(entry.previousVacuumAt).toBeInstanceOf(Date);
      expect(entry.originalStatus).toBe(STORAGE_JOURNAL_STATUS.COMMITTED);
    }

    // Non-COMMITTED and malformed records untouched
    expect(await StorageJournal.countDocuments({ status: STORAGE_JOURNAL_STATUS.COMPENSATED, vacuumAt: { $ne: null } })).toBe(1);
    expect(await StorageJournal.countDocuments({ status: STORAGE_JOURNAL_STATUS.ABANDONED, vacuumAt: { $ne: null } })).toBe(1);
    expect(await StorageJournal.countDocuments({ status: STORAGE_JOURNAL_STATUS.CONFIRMED, vacuumAt: { $ne: null } })).toBe(1);

    // Idempotent second run
    const secondRes = await runStorageJournalRetentionMigration({
      apply: true,
      mode: 'APPLY',
      databaseName: dbName,
      migrationId: 'mig-test-1',
      targetCollection: TARGET_COLLECTION,
      batchSize: 2
    });
    expect(secondRes.recordsMigrated).toBe(0);
    expect(secondRes.batchesCompleted).toBe(0);
  });

  it('resumes cleanly after mid-flight crash without duplicating ledger entries', async () => {
    await seedMixedJournalRecords();

    let calls = 0;
    await expect(
      runStorageJournalRetentionMigration({
        apply: true,
        mode: 'APPLY',
        databaseName: dbName,
        migrationId: 'mig-crash-1',
        targetCollection: TARGET_COLLECTION,
        batchSize: 2,
        onBeforeBatch: async () => {
          calls += 1;
          if (calls === 2) {
            throw new Error('Simulated crash before batch 2');
          }
        }
      })
    ).rejects.toThrow('Simulated crash before batch 2');

    expect(await StorageJournalMigrationLedger.countDocuments({ migrationId: 'mig-crash-1' })).toBe(2);

    const resumeRes = await runStorageJournalRetentionMigration({
      apply: true,
      mode: 'APPLY',
      databaseName: dbName,
      migrationId: 'mig-crash-1',
      targetCollection: TARGET_COLLECTION,
      batchSize: 2
    });

    expect(resumeRes.recordsMigrated).toBe(1);
    expect(resumeRes.remainingEligibleCount).toBe(0);
    expect(await StorageJournalMigrationLedger.countDocuments({ migrationId: 'mig-crash-1' })).toBe(3);
  });

  it('rejects concurrent execution when migration lease is held by another owner', async () => {
    await seedMixedJournalRecords();
    await StorageJournalMigrationLease.create({
      _id: MIGRATION_LEASE_ID,
      ownerId: 'other-worker',
      fenceEpoch: 5,
      migrationId: 'mig-other',
      expiresAt: new Date(Date.now() + 60000)
    });

    await expect(
      runStorageJournalRetentionMigration({
        apply: true,
        mode: 'APPLY',
        databaseName: dbName,
        migrationId: 'mig-compete',
        targetCollection: TARGET_COLLECTION
      })
    ).rejects.toThrow(MigrationLeaseError);
  });

  it('preserves recoveryVerifier.js Stage D provenance after migration', async () => {
    const now = new Date();
    const expired = new Date(now.getTime() - 3600 * 1000);
    const key = 'forms/f1/r1/evidence.pdf';
    const payload = Buffer.from('test-evidence-bytes');
    const hash = crypto.createHash('sha256').update(payload).digest('hex');

    await StorageJournal.create({
      operationId: crypto.randomUUID(),
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      status: STORAGE_JOURNAL_STATUS.COMMITTED,
      destinationKey: key,
      payloadSize: payload.length,
      payloadHash: hash,
      vacuumAt: expired
    });

    await runStorageJournalRetentionMigration({
      apply: true,
      mode: 'APPLY',
      databaseName: dbName,
      migrationId: 'mig-verifier-1',
      targetCollection: TARGET_COLLECTION
    });

    const migratedJournals = await StorageJournal.find({ status: STORAGE_JOURNAL_STATUS.COMMITTED }).lean();
    expect(migratedJournals).toHaveLength(1);
    expect(migratedJournals[0].vacuumAt).toBeNull();

    // Verify offline recoveryVerifier accepts the migrated COMMITTED record
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'k14-1-9-verifier-'));
    try {
      const mongoPath = path.join(tempRoot, 'mongo.json');
      const invPath = path.join(tempRoot, 'inventory.json');
      const manifestPath = path.join(tempRoot, 'manifest.json');

      const mongoData = {
        backupLease: { status: 'CAPTURING', ttlMonitorDisabled: true, generation: 1 },
        storageJournals: migratedJournals,
        responses: [{ _id: new mongoose.Types.ObjectId().toString(), attachments: [{ key }] }]
      };
      const invData = {
        objects: [{ key, size: payload.length, etag: hash }]
      };
      fs.writeFileSync(mongoPath, JSON.stringify(mongoData));
      fs.writeFileSync(invPath, JSON.stringify(invData));
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          schemaVersion: '1.0',
          backupId: 'b-1',
          generation: 1,
          artifacts: { mongo: { path: 'mongo.json', format: 'json' }, inventory: { path: 'inventory.json' } }
        })
      );

      const decision = await verifyRecoverySet(tempRoot, { enforceTwoWayReconciliation: true });
      const journalErrors = (decision.diagnostics || []).filter(
        (d) =>
          d.code === 'UNJOURNALED_OBJECT_DETECTED' ||
          d.code === 'JOURNAL_REFERENCE_MISSING_FROM_INVENTORY'
      );
      expect(journalErrors).toHaveLength(0);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('handles TTLMonitor deletion between discovery and transaction without marking VERIFIED (F-01)', async () => {
    await seedMixedJournalRecords();

    let deletedId = null;
    const res = await runStorageJournalRetentionMigration({
      apply: true,
      mode: 'APPLY',
      databaseName: dbName,
      migrationId: 'mig-ttl-race-1',
      targetCollection: TARGET_COLLECTION,
      batchSize: 5,
      onBeforeBatch: async ({ batch }) => {
        // Simulate TTLMonitor deleting the first expired record before transaction starts
        deletedId = batch[0]._id;
        await StorageJournal.deleteOne({ _id: deletedId });
      }
    });

    expect(res.recordsMigrated).toBe(2);
    expect(res.recordsVerified).toBe(2);
    expect(res.missingOrSkippedCount).toBe(1);

    const reconEntry = await StorageJournalMigrationLedger.findOne({
      migrationId: 'mig-ttl-race-1',
      journalId: deletedId
    }).lean();
    expect(reconEntry.status).toBe(MIGRATION_LEDGER_STATUS.REQUIRES_RECONCILIATION);
    expect(reconEntry.lastError).toBe('JOURNAL_MISSING_OR_CHANGED_BEFORE_TX');
  });

  it('allows expired lease takeover with incremented fenceEpoch and fences stale owner inside transaction (F-04)', async () => {
    await seedMixedJournalRecords();

    await StorageJournalMigrationLease.create({
      _id: MIGRATION_LEASE_ID,
      ownerId: 'crashed-worker',
      fenceEpoch: 10,
      migrationId: 'mig-old',
      expiresAt: new Date(Date.now() - 1000)
    });

    const res = await runStorageJournalRetentionMigration({
      apply: true,
      mode: 'APPLY',
      databaseName: dbName,
      migrationId: 'mig-takeover-1',
      targetCollection: TARGET_COLLECTION,
      onBeforeBatch: async () => {
        // Verify fenceEpoch incremented to 11
        const lease = await StorageJournalMigrationLease.findById(MIGRATION_LEASE_ID).lean();
        expect(lease.fenceEpoch).toBe(11);
      }
    });

    expect(res.fenceEpoch).toBe(11);
    expect(res.recordsMigrated).toBe(3);

    // Now test stale owner fenced inside transaction when lease is stolen before tx
    await StorageJournal.deleteMany({});
    await StorageJournalMigrationLedger.deleteMany({});
    await seedMixedJournalRecords();

    await expect(
      runStorageJournalRetentionMigration({
        apply: true,
        mode: 'APPLY',
        databaseName: dbName,
        migrationId: 'mig-stale-1',
        targetCollection: TARGET_COLLECTION,
        onBeforeBatch: async () => {
          // Worker B steals lease
          await StorageJournalMigrationLease.updateOne(
            { _id: MIGRATION_LEASE_ID },
            { $set: { ownerId: 'worker-b', fenceEpoch: 99, expiresAt: new Date(Date.now() + 60000) } }
          );
        }
      })
    ).rejects.toThrow(MigrationLeaseError);

    expect(await StorageJournalMigrationLedger.countDocuments({ migrationId: 'mig-stale-1' })).toBe(0);
  });

  it('enforces single winner under Promise.all concurrent lease acquisition (F-04)', async () => {
    await seedMixedJournalRecords();

    const [r1, r2] = await Promise.allSettled([
      runStorageJournalRetentionMigration({
        apply: true,
        mode: 'APPLY',
        databaseName: dbName,
        migrationId: 'mig-concurrent-1',
        targetCollection: TARGET_COLLECTION,
        ownerId: 'worker-1'
      }),
      runStorageJournalRetentionMigration({
        apply: true,
        mode: 'APPLY',
        databaseName: dbName,
        migrationId: 'mig-concurrent-2',
        targetCollection: TARGET_COLLECTION,
        ownerId: 'worker-2'
      })
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(MigrationLeaseError);
  });
});
