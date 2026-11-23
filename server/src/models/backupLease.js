import mongoose from 'mongoose';

export const BACKUP_LEASE_SINGLETON_ID = 'singleton';

export const BACKUP_LEASE_STATUS = Object.freeze({
  NORMAL: 'NORMAL',
  ACQUIRING: 'ACQUIRING',
  DRAINING: 'DRAINING',
  DRAINED: 'DRAINED',
  QUIESCED: 'QUIESCED',
  CAPTURING: 'CAPTURING',
  STORAGE_STOPPING: 'STORAGE_STOPPING',
  STORAGE_OFFLINE: 'STORAGE_OFFLINE',
  CAPTURE_COMPLETE: 'CAPTURE_COMPLETE',
  RELEASING: 'RELEASING',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED'
});

const backupLeaseSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: BACKUP_LEASE_SINGLETON_ID
    },
    status: {
      type: String,
      enum: Object.values(BACKUP_LEASE_STATUS),
      default: BACKUP_LEASE_STATUS.NORMAL,
      required: true
    },
    leaseId: {
      type: String,
      default: null
    },
    owner: {
      type: String,
      default: null
    },
    grantedAt: {
      type: Date,
      default: null
    },
    expiresAt: {
      type: Date,
      default: null
    },
    lastHeartbeatAt: {
      type: Date,
      default: null
    },
    hardDeadline: {
      type: Date,
      default: null
    },
    // Backward-compatibility alias for hardDeadline
    monotonicWatchdogDeadline: {
      type: Date,
      default: null
    },
    bootId: {
      type: String,
      default: null
    },
    monotonicGrantedAtMs: {
      type: Number,
      default: null
    },
    monotonicHardDeadlineMs: {
      type: Number,
      default: null
    },
    drainStartedAt: {
      type: Date,
      default: null
    },
    quiescedAt: {
      type: Date,
      default: null
    },
    backupSessionId: {
      type: String,
      default: null
    },
    generation: {
      type: Number,
      default: 0
    },
    ttlMonitorDisabled: {
      type: Boolean,
      default: false
    },
    ttlDisabledAt: {
      type: Date,
      default: null
    },
    ttlDisabledByLeaseId: {
      type: String,
      default: null
    },
    ttlMonitorError: {
      type: String,
      default: null
    },
    storageLocked: {
      type: Boolean,
      default: false
    },
    storageLockType: {
      type: String,
      default: null
    },
    storageLockedAt: {
      type: Date,
      default: null
    },
    tStartTime: {
      type: Date,
      default: null
    },
    tEndTime: {
      type: Date,
      default: null
    },
    lastKnownHealthyState: {
      type: String,
      default: null
    },
    recoveryActionRequired: {
      type: String,
      default: null
    },
    drainFailureReason: {
      type: String,
      default: null
    },
    drainFailureAt: {
      type: Date,
      default: null
    },
    drainDiagnostics: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    drainAttempts: {
      type: Number,
      default: 0
    },
    activeInstanceId: {
      type: String,
      default: null
    },
    lastInstanceAdmissionAt: {
      type: Date,
      default: null
    },
    admissionEpoch: {
      type: Number,
      default: 0
    },
    version: {
      type: Number,
      default: 0
    }
  },
  {
    collection: 'backup_leases',
    timestamps: true
  }
);

// Index on expiresAt and hardDeadline for fast lookup and lease expiration queries
backupLeaseSchema.index({ expiresAt: 1 });
backupLeaseSchema.index({ hardDeadline: 1 });

const BackupLease = mongoose.models.BackupLease || mongoose.model('BackupLease', backupLeaseSchema);

export default BackupLease;
