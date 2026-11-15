import mongoose from 'mongoose';

/**
 * DeletionCleanupJob Model
 *
 * Tracks durable, post-cascade S3 orphan cleanup tasks that survive Form
 * and SubmissionReservation deletion. Provides distributed CAS lease fencing,
 * an enforced grace period (eligibleUntil), and TTL-based audit retention.
 */
const deletionCleanupJobSchema = new mongoose.Schema(
  {
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    stagingPrefix: {
      type: String,
      required: true,
      trim: true
    },
    finalPrefix: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      enum: ['pending', 'cleaning', 'reconciled', 'completed', 'failed'],
      default: 'pending',
      index: true
    },
    leaseId: {
      type: String,
      default: null
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true
    },
    reconciliationPasses: {
      type: Number,
      default: 0
    },
    lastReconciledAt: {
      type: Date,
      default: null
    },
    nextSweepAt: {
      type: Date,
      default: Date.now,
      index: true
    },
    epoch: {
      type: Number,
      default: 0
    },
    attempts: {
      type: Number,
      default: 0
    },
    maxAttempts: {
      type: Number,
      default: 10
    },
    lastError: {
      type: String,
      default: null
    },
    eligibleUntil: {
      type: Date,
      required: true,
      index: true
    },
    vacuumAt: {
      type: Date,
      default: null
    },
    stats: {
      objectsDeleted: { type: Number, default: 0 },
      lastSweepAt: { type: Date, default: null }
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

// 1. Compound index for worker polling (prioritize due sweeps and expired cleaning leases)
deletionCleanupJobSchema.index({ status: 1, nextSweepAt: 1, leaseExpiresAt: 1 });
deletionCleanupJobSchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });

// 2. Unique index on formId to ensure single canonical cleanup job per form
deletionCleanupJobSchema.index({ formId: 1 }, { unique: true });

// 3. TTL index on vacuumAt for automated MongoDB cleanup after audit retention
deletionCleanupJobSchema.index({ vacuumAt: 1 }, { expireAfterSeconds: 0 });

const DeletionCleanupJob =
  mongoose.models.DeletionCleanupJob ||
  mongoose.model('DeletionCleanupJob', deletionCleanupJobSchema);

export default DeletionCleanupJob;
