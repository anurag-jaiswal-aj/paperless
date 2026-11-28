import mongoose from 'mongoose';

const storageJournalMigrationLeaseSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true
    },
    ownerId: {
      type: String,
      required: true
    },
    fenceEpoch: {
      type: Number,
      required: true,
      default: 1
    },
    migrationId: {
      type: String,
      required: true
    },
    acquiredAt: {
      type: Date,
      required: true,
      default: () => new Date()
    },
    renewedAt: {
      type: Date,
      required: true,
      default: () => new Date()
    },
    expiresAt: {
      type: Date,
      required: true
    },
    lastProcessedId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    batchesCompleted: {
      type: Number,
      default: 0
    },
    recordsVerified: {
      type: Number,
      default: 0
    },
    txFenceSeq: {
      type: Number,
      required: true,
      default: 0
    }
  },
  {
    collection: 'storage_journal_migration_leases',
    timestamps: true
  }
);

export const StorageJournalMigrationLease =
  mongoose.models.StorageJournalMigrationLease ||
  mongoose.model('StorageJournalMigrationLease', storageJournalMigrationLeaseSchema);
