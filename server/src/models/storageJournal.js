import mongoose from 'mongoose';

/**
 * Storage Journal Lifecycle Status Enumeration
 * Represents the deterministic states of a storage mutation.
 */
export const STORAGE_JOURNAL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  CREATED: 'CREATED', // Alias for backwards compatibility with PENDING
  DISPATCHED: 'DISPATCHED',
  CONFIRMED: 'CONFIRMED',
  AMBIGUOUS: 'AMBIGUOUS',
  RECONCILING: 'RECONCILING',
  COMMITTED: 'COMMITTED',
  COMPENSATED: 'COMPENSATED',
  ABANDONED: 'ABANDONED'
});

export const LEGACY_STATUS_MAP = Object.freeze({
  CREATED: STORAGE_JOURNAL_STATUS.PENDING
});

/**
 * Storage Mutation Operation Types
 */
export const STORAGE_OPERATION_TYPE = Object.freeze({
  PUT_OBJECT: 'PutObject',
  COPY_OBJECT: 'CopyObject',
  DELETE_OBJECT: 'DeleteObject',
  DELETE_OBJECTS: 'DeleteObjects',
  MULTIPART_UPLOAD: 'MultipartUpload'
});

const storageJournalSchema = new mongoose.Schema(
  {
    operationId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true
    },
    type: {
      type: String,
      enum: Object.values(STORAGE_OPERATION_TYPE),
      required: true,
      immutable: true
    },
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Form',
      default: null,
      index: true
    },
    responseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Response',
      default: null,
      index: true
    },
    reservationLeaseId: {
      type: String,
      default: null,
      index: true
    },
    bucket: {
      type: String,
      required: true,
      default: () => process.env.S3_BUCKET_NAME || process.env.S3_BUCKET || 'paperless'
    },
    sourceKey: {
      type: String,
      default: null
    },
    destinationKey: {
      type: String,
      required: true,
      index: true
    },
    targetKeys: {
      type: [String],
      default: []
    },
    payloadSize: {
      type: Number,
      default: null,
      min: 0
    },
    payloadHash: {
      type: String,
      default: null
    },
    mimeType: {
      type: String,
      default: null
    },
    etag: {
      type: String,
      default: null
    },
    status: {
      type: String,
      enum: Object.values(STORAGE_JOURNAL_STATUS),
      default: STORAGE_JOURNAL_STATUS.PENDING,
      required: true,
      index: true
    },
    epoch: {
      type: Number,
      default: 0,
      min: 0
    },
    quarantinedUntil: {
      type: Date,
      default: null,
      index: true
    },
    lockedUntil: {
      type: Date,
      default: null,
      index: true
    },
    lockedBy: {
      type: String,
      default: null
    },
    reconciliationPasses: {
      type: Number,
      default: 0,
      min: 0
    },
    lastReconciledAt: {
      type: Date,
      default: null
    },
    vacuumAt: {
      type: Date,
      default: null
    },
    errorDetails: {
      type: String,
      default: null
    }
  },
  {
    collection: 'storage_operations',
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual aliases for compatibility
storageJournalSchema
  .virtual('claimLockExpiresAt')
  .get(function () {
    return this.lockedUntil;
  })
  .set(function (v) {
    this.lockedUntil = v;
  });

storageJournalSchema
  .virtual('claimedBy')
  .get(function () {
    return this.lockedBy;
  })
  .set(function (v) {
    this.lockedBy = v;
  });

// Compound Indexes (ESR-compliant)
storageJournalSchema.index(
  { status: 1, quarantinedUntil: 1, lockedUntil: 1 },
  { name: 'idx_reconciler_quarantine_poll' }
);

storageJournalSchema.index(
  { destinationKey: 1, status: 1 },
  { name: 'idx_destination_key_status' }
);

storageJournalSchema.index({ formId: 1, status: 1 }, { name: 'idx_form_status_barrier' });

storageJournalSchema.index({ responseId: 1, status: 1 }, { name: 'idx_response_status_lookup' });

storageJournalSchema.index(
  { reservationLeaseId: 1, status: 1 },
  { name: 'idx_reservation_status_lookup' }
);

storageJournalSchema.index({ status: 1, updatedAt: 1 }, { name: 'idx_startup_recovery_scan' });

storageJournalSchema.index(
  { vacuumAt: 1 },
  { name: 'idx_storage_journal_ttl_vacuum', expireAfterSeconds: 0 }
);

// ==========================================
// Static CAS Helpers for Deterministic State Transitions
// ==========================================

storageJournalSchema.statics.recordIntent = async function (doc, options = {}) {
  const [created] = await this.create(
    [
      {
        ...doc,
        status: doc.status || STORAGE_JOURNAL_STATUS.PENDING,
        epoch: 0,
        quarantinedUntil: null,
        lockedUntil: null,
        lockedBy: null,
        vacuumAt: null
      }
    ],
    { session: options.session || null }
  );
  return created;
};

storageJournalSchema.statics.markDispatched = async function (operationId, expectedEpoch = 0) {
  const filter = {
    operationId,
    status: { $in: [STORAGE_JOURNAL_STATUS.PENDING, STORAGE_JOURNAL_STATUS.CREATED] }
  };
  if (typeof expectedEpoch === 'number') {
    filter.epoch = expectedEpoch;
  }

  const updated = await this.findOneAndUpdate(
    filter,
    {
      $set: {
        status: STORAGE_JOURNAL_STATUS.DISPATCHED,
        updatedAt: new Date()
      },
      $inc: { epoch: 1 }
    },
    { new: true }
  );
  return updated;
};

storageJournalSchema.statics.confirmOperation = async function (
  operationId,
  expectedEpoch,
  { etag = null, lockedBy = null, payloadSize = null, payloadHash = null } = {}
) {
  const filter = {
    operationId,
    status: {
      $in: [
        STORAGE_JOURNAL_STATUS.DISPATCHED,
        STORAGE_JOURNAL_STATUS.RECONCILING,
        STORAGE_JOURNAL_STATUS.AMBIGUOUS
      ]
    }
  };
  if (typeof expectedEpoch === 'number') {
    filter.epoch = expectedEpoch;
  }
  if (lockedBy) {
    filter.lockedBy = lockedBy;
  }

  const setFields = {
    status: STORAGE_JOURNAL_STATUS.CONFIRMED,
    etag: etag || null,
    quarantinedUntil: null,
    lockedUntil: null,
    lockedBy: null,
    errorDetails: null,
    updatedAt: new Date()
  };
  if (typeof payloadSize === 'number') {
    setFields.payloadSize = payloadSize;
  }
  if (typeof payloadHash === 'string') {
    setFields.payloadHash = payloadHash;
  }

  const updated = await this.findOneAndUpdate(
    filter,
    {
      $set: setFields,
      $inc: { epoch: 1 }
    },
    { new: true }
  );
  return updated;
};

storageJournalSchema.statics.markAmbiguous = async function (
  operationId,
  expectedEpoch,
  { errorDetails = null, quarantineMs = 40000 } = {}
) {
  const now = new Date();
  const quarantinedUntil = new Date(now.getTime() + quarantineMs);
  const filter = { operationId };
  if (typeof expectedEpoch === 'number') {
    filter.epoch = expectedEpoch;
  }

  const updated = await this.findOneAndUpdate(
    filter,
    {
      $set: {
        status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
        quarantinedUntil,
        lockedUntil: null,
        lockedBy: null,
        errorDetails: errorDetails || 'Storage operation ambiguous',
        updatedAt: now
      },
      $inc: { epoch: 1 }
    },
    { new: true }
  );
  return updated;
};

storageJournalSchema.statics.commitInTransaction = async function (
  destinationKeys,
  { responseId, formId, session, vacuumAt = null } = {}
) {
  const now = new Date();
  const filter = {
    destinationKey: { $in: Array.isArray(destinationKeys) ? destinationKeys : [destinationKeys] },
    status: STORAGE_JOURNAL_STATUS.CONFIRMED
  };
  if (formId) {
    filter.formId = formId;
  }

  return this.updateMany(
    filter,
    {
      $set: {
        status: STORAGE_JOURNAL_STATUS.COMMITTED,
        responseId: responseId || null,
        vacuumAt, // Permanent TTL-immune retention for live committed response attachments
        updatedAt: now
      },
      $inc: { epoch: 1 }
    },
    { session }
  );
};

storageJournalSchema.statics.claimForReconciliation = async function (
  operationId,
  workerId,
  { leaseDurationMs = 15000 } = {}
) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + leaseDurationMs);

  const claimed = await this.findOneAndUpdate(
    {
      operationId,
      status: {
        $in: [
          STORAGE_JOURNAL_STATUS.AMBIGUOUS,
          STORAGE_JOURNAL_STATUS.CREATED,
          STORAGE_JOURNAL_STATUS.PENDING,
          STORAGE_JOURNAL_STATUS.DISPATCHED,
          STORAGE_JOURNAL_STATUS.RECONCILING
        ]
      },
      $and: [
        {
          $or: [{ quarantinedUntil: null }, { quarantinedUntil: { $lte: now } }]
        },
        {
          $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }]
        }
      ]
    },
    {
      $set: {
        status: STORAGE_JOURNAL_STATUS.RECONCILING,
        lockedUntil,
        lockedBy: workerId,
        lastReconciledAt: now,
        updatedAt: now
      },
      $inc: {
        epoch: 1,
        reconciliationPasses: 1
      }
    },
    { new: true }
  );

  return claimed;
};

storageJournalSchema.statics.markCompensated = async function (
  operationId,
  expectedEpoch,
  { errorDetails = null, vacuumHours = 24, lockedBy = null } = {}
) {
  const now = new Date();
  const filter = { operationId };
  if (typeof expectedEpoch === 'number') {
    filter.epoch = expectedEpoch;
  }
  if (lockedBy) {
    filter.lockedBy = lockedBy;
  }

  return this.findOneAndUpdate(
    filter,
    {
      $set: {
        status: STORAGE_JOURNAL_STATUS.COMPENSATED,
        vacuumAt:
          typeof vacuumHours === 'number' && vacuumHours > 0
            ? new Date(now.getTime() + vacuumHours * 3600 * 1000)
            : null,
        lockedUntil: null,
        lockedBy: null,
        errorDetails: errorDetails || 'Compensated orphaned storage object',
        updatedAt: now
      },
      $inc: { epoch: 1 }
    },
    { new: true }
  );
};

storageJournalSchema.statics.markAbandoned = async function (
  operationId,
  expectedEpoch,
  { errorDetails = null, vacuumHours = 24, lockedBy = null } = {}
) {
  const now = new Date();
  const filter = { operationId };
  if (typeof expectedEpoch === 'number') {
    filter.epoch = expectedEpoch;
  }
  if (lockedBy) {
    filter.lockedBy = lockedBy;
  }

  return this.findOneAndUpdate(
    filter,
    {
      $set: {
        status: STORAGE_JOURNAL_STATUS.ABANDONED,
        vacuumAt:
          typeof vacuumHours === 'number' && vacuumHours > 0
            ? new Date(now.getTime() + vacuumHours * 3600 * 1000)
            : null,
        lockedUntil: null,
        lockedBy: null,
        errorDetails: errorDetails || 'Operation safely abandoned',
        updatedAt: now
      },
      $inc: { epoch: 1 }
    },
    { new: true }
  );
};

const StorageJournal =
  mongoose.models.StorageJournal || mongoose.model('StorageJournal', storageJournalSchema);

export default StorageJournal;
