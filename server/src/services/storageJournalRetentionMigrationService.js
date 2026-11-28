import crypto from 'node:crypto';
import mongoose from 'mongoose';
import StorageJournal, { STORAGE_JOURNAL_STATUS } from '../models/storageJournal.js';
import {
  StorageJournalMigrationLedger,
  MIGRATION_LEDGER_STATUS
} from '../models/storageJournalMigrationLedger.js';
import { StorageJournalMigrationLease } from '../models/storageJournalMigrationLease.js';

export const DEFAULT_BATCH_SIZE = 500;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 1000;
export const TARGET_COLLECTION = 'storage_operations';
export const EXPECTED_TTL_INDEX_NAME = 'idx_storage_journal_ttl_vacuum';
export const MIGRATION_LEASE_ID = 'storage_journal_retention_migration';
export const DEFAULT_LEASE_TTL_MS = 60000;

export class MigrationSafeguardError extends Error {
  constructor(message, code = 'MIGRATION_SAFEGUARD_ERROR') {
    super(message);
    this.name = 'MigrationSafeguardError';
    this.code = code;
  }
}

export class MigrationLeaseError extends Error {
  constructor(message, code = 'MIGRATION_LEASE_ERROR') {
    super(message);
    this.name = 'MigrationLeaseError';
    this.code = code;
  }
}

function validateBatchSize(batchSize) {
  if (batchSize === undefined || batchSize === null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < MIN_BATCH_SIZE || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError(
      `batchSize must be an integer between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE} (received ${batchSize}).`
    );
  }
  return batchSize;
}

async function verifyTargetCollectionAndIndex(db) {
  const actualDbName = db.databaseName;
  const collections = await db.listCollections({ name: TARGET_COLLECTION }).toArray();
  if (collections.length === 0) {
    throw new MigrationSafeguardError(
      `Target collection "${TARGET_COLLECTION}" does not exist in database "${actualDbName}".`,
      'COLLECTION_MISSING'
    );
  }

  const indexes = await db.collection(TARGET_COLLECTION).indexes();
  const ttlIndex = indexes.find((idx) => idx.name === EXPECTED_TTL_INDEX_NAME);
  if (!ttlIndex || ttlIndex.expireAfterSeconds !== 0 || ttlIndex.key?.vacuumAt !== 1) {
    throw new MigrationSafeguardError(
      `Expected TTL index "${EXPECTED_TTL_INDEX_NAME}" ({ vacuumAt: 1 }, expireAfterSeconds: 0) not found on "${TARGET_COLLECTION}".`,
      'TTL_INDEX_MISSING'
    );
  }

  return { actualDbName, ttlIndex };
}

async function acquireMigrationLease({ ownerId, migrationId, leaseTtlMs }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseTtlMs);
  const existing = await StorageJournalMigrationLease.findById(MIGRATION_LEASE_ID).lean();

  if (existing && existing.expiresAt > now && existing.ownerId !== ownerId) {
    throw new MigrationLeaseError(
      `Migration lease is currently held by owner "${existing.ownerId}" until ${existing.expiresAt.toISOString()}.`,
      'LEASE_HELD_BY_OTHER'
    );
  }

  const nextEpoch = (existing?.fenceEpoch || 0) + 1;
  const filter = existing
    ? {
        _id: MIGRATION_LEASE_ID,
        fenceEpoch: existing.fenceEpoch,
        $or: [{ expiresAt: { $lte: now } }, { ownerId }]
      }
    : { _id: MIGRATION_LEASE_ID };

  const lease = await StorageJournalMigrationLease.findOneAndUpdate(
    filter,
    {
      $set: {
        ownerId,
        fenceEpoch: nextEpoch,
        migrationId,
        acquiredAt: now,
        renewedAt: now,
        expiresAt
      }
    },
    { upsert: !existing, new: true }
  );

  if (!lease || lease.ownerId !== ownerId || lease.fenceEpoch !== nextEpoch) {
    throw new MigrationLeaseError('Failed to acquire migration lease due to concurrent contention.', 'LEASE_CONTENTION');
  }

  return lease;
}

async function renewMigrationLease({ ownerId, fenceEpoch, leaseTtlMs, lastProcessedId, batchesDelta, verifiedDelta }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseTtlMs);
  const updated = await StorageJournalMigrationLease.findOneAndUpdate(
    {
      _id: MIGRATION_LEASE_ID,
      ownerId,
      fenceEpoch,
      expiresAt: { $gt: now }
    },
    {
      $set: {
        renewedAt: now,
        expiresAt,
        ...(lastProcessedId ? { lastProcessedId } : {})
      },
      $inc: {
        batchesCompleted: batchesDelta || 0,
        recordsVerified: verifiedDelta || 0
      }
    },
    { new: true }
  );

  if (!updated) {
    throw new MigrationLeaseError(
      `Migration lease lost or expired for owner "${ownerId}" (fenceEpoch=${fenceEpoch}).`,
      'LEASE_LOST'
    );
  }
  return updated;
}

async function releaseMigrationLease({ ownerId, fenceEpoch }) {
  await StorageJournalMigrationLease.deleteOne({
    _id: MIGRATION_LEASE_ID,
    ownerId,
    fenceEpoch
  }).catch(() => {});
}

async function runLeaseFencedTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' }
      }
    );
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Runs the historical StorageJournal retention migration in DRY_RUN (default) or APPLY mode.
 */
export async function runStorageJournalRetentionMigration(options = {}) {
  const isApply = options.apply === true && options.mode === 'APPLY';
  const batchSize = validateBatchSize(options.batchSize);
  const db = mongoose.connection?.db;
  if (!db) {
    throw new MigrationSafeguardError('Mongoose connection is not established.', 'DB_NOT_CONNECTED');
  }

  const { actualDbName } = await verifyTargetCollectionAndIndex(db);

  if (!isApply) {
    const now = new Date();
    const col = db.collection(TARGET_COLLECTION);
    const statusAgg = await col
      .aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray();
    const statusCounts = Object.fromEntries(statusAgg.map((r) => [r._id, r.count]));

    const eligibleCount = await col.countDocuments({
      status: STORAGE_JOURNAL_STATUS.COMMITTED,
      vacuumAt: { $type: 'date' }
    });
    const expiredEligibleCount = await col.countDocuments({
      status: STORAGE_JOURNAL_STATUS.COMMITTED,
      vacuumAt: { $type: 'date', $lte: now }
    });
    const futureEligibleCount = eligibleCount - expiredEligibleCount;
    const malformedCount = await col.countDocuments({
      status: STORAGE_JOURNAL_STATUS.COMMITTED,
      vacuumAt: { $ne: null, $not: { $type: 'date' } }
    });

    const ledgerExists = (await db.listCollections({ name: 'storage_journal_migration_ledger' }).toArray()).length > 0;
    const existingLedgerCount = ledgerExists
      ? await db.collection('storage_journal_migration_ledger').countDocuments({})
      : 0;

    return {
      mode: 'DRY_RUN',
      databaseName: actualDbName,
      targetCollection: TARGET_COLLECTION,
      ttlIndex: EXPECTED_TTL_INDEX_NAME,
      batchSize,
      statusCounts,
      eligibleCount,
      expiredEligibleCount,
      futureEligibleCount,
      malformedCount,
      existingLedgerCount,
      estimatedBatches: Math.ceil(eligibleCount / batchSize)
    };
  }

  if (!options.databaseName || options.databaseName !== actualDbName) {
    throw new MigrationSafeguardError(
      `databaseName confirmation mismatch: expected "${actualDbName}", got "${options.databaseName}".`,
      'DATABASE_MISMATCH'
    );
  }
  if (!options.migrationId || typeof options.migrationId !== 'string' || options.migrationId.trim() === '') {
    throw new MigrationSafeguardError('migrationId is required in APPLY mode.', 'MIGRATION_ID_REQUIRED');
  }
  if (options.targetCollection !== TARGET_COLLECTION) {
    throw new MigrationSafeguardError(
      `targetCollection must be "${TARGET_COLLECTION}" (received "${options.targetCollection}").`,
      'COLLECTION_MISMATCH'
    );
  }
  if (
    (process.env.NODE_ENV === 'production' || /prod/i.test(actualDbName)) &&
    options.allowProduction !== true
  ) {
    throw new MigrationSafeguardError(
      `Refusing to run APPLY mode against production target "${actualDbName}" without allowProduction: true.`,
      'PRODUCTION_REJECTED'
    );
  }

  const ownerId = options.ownerId || `migration-${crypto.randomUUID()}`;
  const leaseTtlMs = options.leaseTtlMs || DEFAULT_LEASE_TTL_MS;
  const lease = await acquireMigrationLease({ ownerId, migrationId: options.migrationId, leaseTtlMs });

  const skippedIds = [];
  let lastProcessedId = options.lastProcessedId || null;
  let batchesCompleted = 0;
  let recordsMigrated = 0;
  let recordsVerified = 0;
  let missingOrSkippedCount = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const query = {
        status: STORAGE_JOURNAL_STATUS.COMMITTED,
        vacuumAt: { $type: 'date' },
        ...(skippedIds.length > 0 ? { _id: { $nin: skippedIds } } : {})
      };

      // Prioritize expired / imminent vacuumAt records first
      const batch = await StorageJournal.find(query).sort({ vacuumAt: 1, _id: 1 }).limit(batchSize).lean();
      if (batch.length === 0) break;

      if (typeof options.onBeforeBatch === 'function') {
        await options.onBeforeBatch({ batchIndex: batchesCompleted, batch, ownerId, fenceEpoch: lease.fenceEpoch });
      }

      const { migratedIds, batchSkippedIds } = await runLeaseFencedTransaction(async (session) => {
        const now = new Date();
        // Conditional write on the shared lease document establishes a real WiredTiger
        // write-conflict serialization boundary against concurrent lease takeover.
        const leaseFenceRes = await StorageJournalMigrationLease.updateOne(
          {
            _id: MIGRATION_LEASE_ID,
            ownerId,
            fenceEpoch: lease.fenceEpoch,
            expiresAt: { $gt: now }
          },
          {
            $set: { renewedAt: now },
            $inc: { txFenceSeq: 1 }
          },
          { session }
        );

        if (leaseFenceRes.matchedCount !== 1) {
          throw new MigrationLeaseError('Migration lease lost before transaction commit.', 'LEASE_LOST');
        }

        const txMigratedIds = [];
        const txSkippedIds = [];

        for (const doc of batch) {
          // Re-read inside snapshot transaction to detect TTLMonitor deletion or concurrent state change
          const current = await StorageJournal.findOne({
            _id: doc._id,
            status: STORAGE_JOURNAL_STATUS.COMMITTED,
            vacuumAt: { $type: 'date' }
          }).session(session);

          if (!current) {
            await StorageJournalMigrationLedger.updateOne(
              { migrationId: options.migrationId, journalId: doc._id },
              {
                $set: {
                  status: MIGRATION_LEDGER_STATUS.REQUIRES_RECONCILIATION,
                  lastError: 'JOURNAL_MISSING_OR_CHANGED_BEFORE_TX'
                },
                $setOnInsert: {
                  migrationId: options.migrationId,
                  migrationVersion: '1.0.0',
                  journalId: doc._id,
                  operationId: doc.operationId,
                  originalStatus: doc.status,
                  previousVacuumAt: doc.vacuumAt,
                  migratedAt: now
                }
              },
              { upsert: true, session }
            );
            txSkippedIds.push(doc._id);
            continue;
          }

          const updateRes = await StorageJournal.updateOne(
            {
              _id: current._id,
              status: STORAGE_JOURNAL_STATUS.COMMITTED,
              vacuumAt: { $type: 'date' }
            },
            { $set: { vacuumAt: null } },
            { session }
          );

          if (updateRes.matchedCount !== 1) {
            throw new MigrationSafeguardError(
              `Unexpected matchedCount=${updateRes.matchedCount} for journal ${current._id}.`,
              'UNEXPECTED_MATCHED_COUNT'
            );
          }

          await StorageJournalMigrationLedger.updateOne(
            { migrationId: options.migrationId, journalId: current._id },
            {
              $set: {
                status: MIGRATION_LEDGER_STATUS.VERIFIED,
                verifiedAt: now,
                lastError: null
              },
              $setOnInsert: {
                migrationId: options.migrationId,
                migrationVersion: '1.0.0',
                journalId: current._id,
                operationId: current.operationId,
                originalStatus: current.status,
                previousVacuumAt: current.vacuumAt,
                migratedAt: now
              }
            },
            { upsert: true, session }
          );

          txMigratedIds.push(current._id);
        }

        return { migratedIds: txMigratedIds, batchSkippedIds: txSkippedIds };
      });

      if (migratedIds.length > 0) {
        const verifiedCount = await StorageJournal.countDocuments({
          _id: { $in: migratedIds },
          status: STORAGE_JOURNAL_STATUS.COMMITTED,
          vacuumAt: null
        });
        if (verifiedCount !== migratedIds.length) {
          throw new MigrationSafeguardError(
            `Post-batch verification failed: expected ${migratedIds.length} verified documents, found ${verifiedCount}.`,
            'POSTCONDITION_FAILED'
          );
        }
      }

      skippedIds.push(...batchSkippedIds);
      lastProcessedId = batch[batch.length - 1]._id;
      batchesCompleted += 1;
      recordsMigrated += migratedIds.length;
      recordsVerified += migratedIds.length;
      missingOrSkippedCount += batchSkippedIds.length;

      await renewMigrationLease({
        ownerId,
        fenceEpoch: lease.fenceEpoch,
        leaseTtlMs,
        lastProcessedId,
        batchesDelta: 1,
        verifiedDelta: migratedIds.length
      });

      if (batch.length < batchSize) break;
    }

    const remainingEligibleCount = await StorageJournal.countDocuments({
      status: STORAGE_JOURNAL_STATUS.COMMITTED,
      vacuumAt: { $type: 'date' }
    });

    return {
      mode: 'APPLY',
      databaseName: actualDbName,
      targetCollection: TARGET_COLLECTION,
      migrationId: options.migrationId,
      ownerId,
      fenceEpoch: lease.fenceEpoch,
      batchesCompleted,
      recordsMigrated,
      recordsVerified,
      missingOrSkippedCount,
      remainingEligibleCount,
      lastProcessedId
    };
  } finally {
    await releaseMigrationLease({ ownerId, fenceEpoch: lease.fenceEpoch });
  }
}
