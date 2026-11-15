import mongoose from 'mongoose';

/**
 * SubmissionReservation Model
 * Tracks durable, per-submission lifecycle leases for active responses.
 * Provides mutual exclusion with form deletion and fences stale workers.
 */
const promotedFileSchema = new mongoose.Schema(
  {
    fileId: { type: String, default: '' },
    stagingKey: { type: String, default: '' },
    finalKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'in_flight', 'promoted', 'failed', 'abandoned'],
      default: 'pending'
    },
    copyInitiatedAt: { type: Date, default: null },
    copyCompletedAt: { type: Date, default: null },
    reconciliationPasses: { type: Number, default: 0 },
    etag: { type: String, default: null },
    error: { type: String, default: null }
  },
  { _id: false }
);

const submissionReservationSchema = new mongoose.Schema(
  {
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Form',
      required: true,
      index: true
    },
    leaseId: {
      type: String,
      required: true
    },
    fenceToken: {
      type: String,
      required: true
    },
    status: {
      type: String,
      enum: ['active', 'committing', 'finalized', 'abandoned', 'released'],
      default: 'active',
      index: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    vacuumAt: {
      type: Date,
      default: null
    },
    stagedKeys: {
      type: [String],
      default: []
    },
    promotedKeys: {
      type: [String],
      default: []
    },
    promotedFiles: {
      type: [promotedFileSchema],
      default: []
    },
    reconciliationState: {
      type: String,
      enum: ['idle', 'in_progress', 'reconciled', 'failed'],
      default: 'idle'
    },
    reconciliationPasses: {
      type: Number,
      default: 0
    },
    lastReconciledAt: {
      type: Date,
      default: null
    },
    promotionStatus: {
      type: String,
      enum: ['none', 'pending', 'in_flight', 'completed', 'failed', 'abandoned', 'tombstone'],
      default: 'none',
      index: true
    },
    quarantinedUntil: {
      type: Date,
      default: null,
      index: true
    },
    promotionLeaseId: {
      type: String,
      default: null
    },
    promotionLeaseExpiresAt: {
      type: Date,
      default: null
    },
    promotionEpoch: {
      type: Number,
      default: 0
    },
    promotionAttempts: {
      type: Number,
      default: 0
    },
    promotionLastError: {
      type: String,
      default: null
    },
    stagingKeysToPurge: {
      type: [String],
      default: []
    },
    stagingCleanupStatus: {
      type: String,
      enum: ['none', 'not_required', 'pending', 'cleaning', 'completed', 'failed'],
      default: 'not_required'
    },
    stagingLeaseId: {
      type: String,
      default: null
    },
    cleanupLeaseId: {
      type: String,
      default: null
    },
    stagingLeaseExpiresAt: {
      type: Date,
      default: null
    },
    cleanupLeaseExpiresAt: {
      type: Date,
      default: null
    },
    stagingEpoch: {
      type: Number,
      default: 0
    },
    cleanupEpoch: {
      type: Number,
      default: 0
    },
    stagingAttempts: {
      type: Number,
      default: 0
    },
    stagingLastError: {
      type: String,
      default: null
    },
    counterReleased: {
      type: Boolean,
      default: false
    },
    submittedBy: {
      type: String,
      default: 'anonymous'
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

// 1. Unique index on leaseId for O(1) point lookups, renewals, and releases
submissionReservationSchema.index({ leaseId: 1 }, { unique: true });

// 2. Covered compound index for form deletion active barrier and draining
// Supports covered countDocuments / find queries without reading document bodies
submissionReservationSchema.index({ formId: 1, status: 1, expiresAt: 1 });

// 3. TTL index on dedicated vacuumAt field for automatic vacuuming of confirmed clean records
// Documents with vacuumAt: null (active, committing, or uncleaned abandoned) are NEVER removed by TTL
submissionReservationSchema.index({ vacuumAt: 1 }, { expireAfterSeconds: 0 });

// 4. Covered partial compound index for finalized staging cleanup recovery polling
submissionReservationSchema.index(
  { stagingCleanupStatus: 1, stagingLeaseExpiresAt: 1, createdAt: 1 },
  {
    name: 'idx_staging_cleanup_worker_poll',
    partialFilterExpression: {
      stagingCleanupStatus: { $in: ['pending', 'cleaning', 'failed'] }
    }
  }
);

// 5. Compound index for abandoned promotion quarantine polling
submissionReservationSchema.index(
  { status: 1, promotionStatus: 1, quarantinedUntil: 1 },
  { name: 'idx_promotion_quarantine_poll' }
);

// 6. Compound index for abandoned reservation reconciliation polling
submissionReservationSchema.index(
  { status: 1, quarantinedUntil: 1 },
  { name: 'idx_abandoned_reconciliation_poll' }
);

const SubmissionReservation =
  mongoose.models.SubmissionReservation ||
  mongoose.model('SubmissionReservation', submissionReservationSchema);

export default SubmissionReservation;
