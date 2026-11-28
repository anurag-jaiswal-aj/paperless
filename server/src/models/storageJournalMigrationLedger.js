import mongoose from 'mongoose';

export const MIGRATION_LEDGER_STATUS = Object.freeze({
  LEDGER_RECORDED: 'LEDGER_RECORDED',
  JOURNAL_UPDATED: 'JOURNAL_UPDATED',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  REQUIRES_RECONCILIATION: 'REQUIRES_RECONCILIATION'
});

const storageJournalMigrationLedgerSchema = new mongoose.Schema(
  {
    migrationId: {
      type: String,
      required: true,
      index: true
    },
    migrationVersion: {
      type: String,
      required: true,
      default: '1.0.0'
    },
    journalId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true
    },
    operationId: {
      type: String,
      required: true,
      index: true
    },
    originalStatus: {
      type: String,
      required: true
    },
    previousVacuumAt: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    status: {
      type: String,
      enum: Object.values(MIGRATION_LEDGER_STATUS),
      required: true,
      default: MIGRATION_LEDGER_STATUS.LEDGER_RECORDED,
      index: true
    },
    migratedAt: {
      type: Date,
      required: true,
      default: () => new Date()
    },
    verifiedAt: {
      type: Date,
      default: null
    },
    lastError: {
      type: String,
      default: null
    }
  },
  {
    collection: 'storage_journal_migration_ledger',
    timestamps: true
  }
);

// Prevent duplicate ledger entries per migration + journal document.
// Intentionally NO TTL index: ledger evidence must be retained permanently.
storageJournalMigrationLedgerSchema.index(
  { migrationId: 1, journalId: 1 },
  { name: 'idx_migration_ledger_unique_doc', unique: true }
);

export const StorageJournalMigrationLedger =
  mongoose.models.StorageJournalMigrationLedger ||
  mongoose.model('StorageJournalMigrationLedger', storageJournalMigrationLedgerSchema);
