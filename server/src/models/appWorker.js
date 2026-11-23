/**
 * AppWorker Model
 *
 * Implements a durable, database-backed distributed worker lease protocol in MongoDB.
 * Enforces single-active-worker mutual exclusion per role, monotonic epoch fencing,
 * incarnation tracking, and autonomous dirty-lease crash recovery.
 *
 * Collection: app_workers
 * Phase: 2D.1K.7 (Phase K-D)
 */

import os from 'os';
import mongoose from 'mongoose';

export const APP_WORKER_STATUS = Object.freeze({
  STARTING: 'STARTING',
  ACTIVE: 'ACTIVE',
  DRAINING: 'DRAINING',
  STOPPED: 'STOPPED',
  EXPIRED: 'EXPIRED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED'
});

export const APP_WORKER_ROLE = Object.freeze({
  STORAGE_RECONCILIATION: 'storage_reconciliation',
  DELETION_CLEANUP: 'deletion_cleanup',
  SUBMISSION_INDEXING: 'submission_indexing',
  PREFIX_SWEEP: 'prefix_sweep'
});

export const DEFAULT_WORKER_LEASE_TTL_MS = 30000; // 30 seconds
export const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds

/**
 * Custom Error for Worker Fencing and Lease Violations
 */
export class WorkerFencedError extends Error {
  constructor(message = 'Worker is fenced or lease has expired', code = 'WORKER_FENCED') {
    super(message);
    this.name = 'WorkerFencedError';
    this.code = code;
    this.status = 409;
    this.statusCode = 409;
  }
}

const appWorkerSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true
    },
    role: {
      type: String,
      required: true,
      immutable: true
    },
    workerId: {
      type: String,
      default: null
    },
    incarnationId: {
      type: String,
      default: null
    },
    hostname: {
      type: String,
      default: null
    },
    pid: {
      type: Number,
      default: null
    },
    status: {
      type: String,
      enum: Object.values(APP_WORKER_STATUS),
      default: APP_WORKER_STATUS.STOPPED,
      required: true
    },
    epoch: {
      type: Number,
      default: 0,
      min: 0,
      required: true
    },
    heartbeatExpiresAt: {
      type: Date,
      default: () => new Date(0),
      required: true
    },
    leaseTtlMs: {
      type: Number,
      default: DEFAULT_WORKER_LEASE_TTL_MS,
      required: true
    },
    heartbeatIntervalMs: {
      type: Number,
      default: DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
      required: true
    },
    lastHeartbeatAt: {
      type: Date,
      default: () => new Date(0),
      required: true
    },
    activeClaimCount: {
      type: Number,
      default: 0,
      min: 0,
      required: true
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    }
  },
  {
    collection: 'app_workers',
    timestamps: true,
    versionKey: false
  }
);

// ESR Compound Indexes
appWorkerSchema.index(
  { status: 1, heartbeatExpiresAt: 1 },
  { name: 'idx_worker_status_heartbeat_expires' }
);

appWorkerSchema.index(
  { workerId: 1, incarnationId: 1, status: 1 },
  { name: 'idx_worker_id_incarnation_status' }
);

appWorkerSchema.index(
  { role: 1, status: 1 },
  { name: 'idx_worker_role_status' }
);

// =========================================================================
// Static Methods & Atomic Compare-And-Swap (CAS) Lease Operations
// =========================================================================

/**
 * Ensures the singleton document for a given role exists in app_workers.
 * Idempotent and concurrency-safe against E11000 duplicate key boot races.
 *
 * @param {string} role - Unique worker role name
 * @param {object} [options={}]
 * @returns {Promise<void>}
 */
appWorkerSchema.statics.ensureRoleDocument = async function (role, options = {}) {
  const writeConcern = options.writeConcern || { w: 'majority' };
  try {
    await this.updateOne(
      { _id: role },
      {
        $setOnInsert: {
          _id: role,
          role,
          workerId: null,
          incarnationId: null,
          hostname: null,
          pid: null,
          status: APP_WORKER_STATUS.STOPPED,
          epoch: 0,
          heartbeatExpiresAt: new Date(0),
          leaseTtlMs: DEFAULT_WORKER_LEASE_TTL_MS,
          heartbeatIntervalMs: DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
          lastHeartbeatAt: new Date(0),
          activeClaimCount: 0,
          metadata: {}
        }
      },
      { upsert: true, writeConcern }
    );
  } catch (err) {
    const isDuplicateKey = err.code === 11000 || err.writeErrors?.some((e) => e.code === 11000);
    if (!isDuplicateKey) {
      throw err;
    }
  }

  // Idempotently repair missing epoch or role fields on legacy records
  await this.updateOne(
    { _id: role, epoch: { $exists: false } },
    { $set: { epoch: 0 } },
    { writeConcern }
  );
};

/**
 * Cleanly acquires an idle or stopped role.
 * Only succeeds if document is in STOPPED status (or fresh insert).
 * Rejects if role is actively held by another live worker.
 *
 * @param {string} role
 * @param {object} params
 * @param {string} params.workerId
 * @param {string} params.incarnationId
 * @param {number} [params.leaseTtlMs=30000]
 * @param {number} [params.heartbeatIntervalMs=10000]
 * @param {string} [params.hostname]
 * @param {number} [params.pid]
 * @param {object} [params.metadata]
 * @param {object} [options={}]
 * @returns {Promise<AppWorker|null>} Returns updated doc on success, null on contention
 */
appWorkerSchema.statics.acquireRole = async function (role, params, options = {}) {
  const {
    workerId,
    incarnationId,
    leaseTtlMs = DEFAULT_WORKER_LEASE_TTL_MS,
    heartbeatIntervalMs = DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
    hostname = os.hostname(),
    pid = process.pid,
    metadata = {}
  } = params;

  if (!role || !workerId || !incarnationId) {
    throw new TypeError('acquireRole requires role, workerId, and incarnationId');
  }

  await this.ensureRoleDocument(role, options);

  const now = new Date();
  const heartbeatExpiresAt = new Date(now.getTime() + leaseTtlMs);

  const filter = {
    _id: role,
    status: APP_WORKER_STATUS.STOPPED
  };

  const update = {
    $set: {
      role,
      workerId,
      incarnationId,
      hostname,
      pid,
      status: APP_WORKER_STATUS.STARTING,
      heartbeatExpiresAt,
      leaseTtlMs,
      heartbeatIntervalMs,
      lastHeartbeatAt: now,
      activeClaimCount: 0,
      metadata: metadata || {}
    },
    $inc: { epoch: 1 }
  };

  return await this.findOneAndUpdate(filter, update, {
    new: true,
    writeConcern: options.writeConcern || { w: 'majority' },
    session: options.session
  });
};

/**
 * Periodic lease renewal heartbeat.
 * ATOMIC PREDICATE: Worker identity, incarnationId, AND expectedEpoch must match.
 * Furthermore, heartbeatExpiresAt must be > now (prevents zombie revival after partition).
 *
 * @param {string} role
 * @param {object} params
 * @param {string} params.workerId
 * @param {string} params.incarnationId
 * @param {number} params.expectedEpoch
 * @param {number} [params.leaseTtlMs]
 * @param {string} [params.status] - Optional state promotion (e.g. 'STARTING' -> 'ACTIVE')
 * @param {number} [params.activeClaimCount]
 * @param {object} [params.metadata]
 * @param {object} [options={}]
 * @returns {Promise<AppWorker|null>}
 */
appWorkerSchema.statics.heartbeat = async function (role, params, options = {}) {
  const {
    workerId,
    incarnationId,
    expectedEpoch,
    leaseTtlMs,
    status,
    activeClaimCount,
    metadata
  } = params;

  if (typeof expectedEpoch !== 'number') {
    throw new TypeError('heartbeat requires numeric expectedEpoch');
  }

  const now = new Date();

  // ATOMIC FILTER: Must own the lease, epoch must match, and lease must NOT have expired
  const filter = {
    _id: role,
    workerId,
    incarnationId,
    epoch: expectedEpoch,
    status: {
      $in: [
        APP_WORKER_STATUS.STARTING,
        APP_WORKER_STATUS.ACTIVE,
        APP_WORKER_STATUS.DRAINING
      ]
    },
    heartbeatExpiresAt: { $gt: now }
  };

  // Compute new lease expiration
  const effectiveTtl = Number(leaseTtlMs) > 0 ? Number(leaseTtlMs) : DEFAULT_WORKER_LEASE_TTL_MS;
  const newExpiresAt = new Date(now.getTime() + effectiveTtl);

  const $set = {
    lastHeartbeatAt: now,
    heartbeatExpiresAt: newExpiresAt
  };

  if (status) {
    // Prohibit reverting DRAINING back to ACTIVE via heartbeat
    if (status === APP_WORKER_STATUS.ACTIVE) {
      filter.status = { $in: [APP_WORKER_STATUS.STARTING, APP_WORKER_STATUS.ACTIVE] };
    }
    $set.status = status;
  } else {
    // Automatically promote STARTING to ACTIVE on first successful heartbeat
    // unless the record is already DRAINING
    $set.status = APP_WORKER_STATUS.ACTIVE;
    filter.status = { $in: [APP_WORKER_STATUS.STARTING, APP_WORKER_STATUS.ACTIVE] };
  }

  if (typeof activeClaimCount === 'number') {
    $set.activeClaimCount = Math.max(0, activeClaimCount);
  }
  if (metadata !== undefined) {
    $set.metadata = metadata;
  }

  return await this.findOneAndUpdate(
    filter,
    { $set },
    {
      new: true,
      writeConcern: options.writeConcern || { w: 'majority' },
      session: options.session
    }
  );
};

/**
 * Marks an active worker as DRAINING in response to quiescence or graceful shutdown.
 * Prevents admission of new jobs while maintaining the lease during in-flight drain.
 *
 * @param {string} role
 * @param {object} params
 * @param {string} params.workerId
 * @param {string} params.incarnationId
 * @param {number} params.expectedEpoch
 * @param {object} [options={}]
 * @returns {Promise<AppWorker|null>}
 */
appWorkerSchema.statics.markDraining = async function (role, params, options = {}) {
  const { workerId, incarnationId, expectedEpoch } = params;

  if (typeof expectedEpoch !== 'number') {
    throw new TypeError('markDraining requires numeric expectedEpoch');
  }

  const now = new Date();
  const filter = {
    _id: role,
    workerId,
    incarnationId,
    epoch: expectedEpoch,
    status: { $in: [APP_WORKER_STATUS.STARTING, APP_WORKER_STATUS.ACTIVE] },
    heartbeatExpiresAt: { $gt: now }
  };

  return await this.findOneAndUpdate(
    filter,
    {
      $set: {
        status: APP_WORKER_STATUS.DRAINING,
        updatedAt: now
      }
    },
    {
      new: true,
      writeConcern: options.writeConcern || { w: 'majority' },
      session: options.session
    }
  );
};

/**
 * Gracefully releases a held worker lease upon completion of draining or shutdown.
 * Increments epoch on release to fence off any late async operations from this worker.
 *
 * @param {string} role
 * @param {object} params
 * @param {string} params.workerId
 * @param {string} params.incarnationId
 * @param {number} params.expectedEpoch
 * @param {object} [options={}]
 * @returns {Promise<AppWorker|null>}
 */
appWorkerSchema.statics.releaseRole = async function (role, params, options = {}) {
  const { workerId, incarnationId, expectedEpoch } = params;

  if (typeof expectedEpoch !== 'number') {
    throw new TypeError('releaseRole requires numeric expectedEpoch');
  }

  const now = new Date();
  const filter = {
    _id: role,
    workerId,
    incarnationId,
    epoch: expectedEpoch,
    status: {
      $in: [
        APP_WORKER_STATUS.STARTING,
        APP_WORKER_STATUS.ACTIVE,
        APP_WORKER_STATUS.DRAINING
      ]
    }
  };

  const update = {
    $set: {
      status: APP_WORKER_STATUS.STOPPED,
      workerId: null,
      incarnationId: null,
      activeClaimCount: 0,
      heartbeatExpiresAt: now,
      updatedAt: now
    },
    $inc: { epoch: 1 } // Epoch bump invalidates straggling work tokens
  };

  return await this.findOneAndUpdate(filter, update, {
    new: true,
    writeConcern: options.writeConcern || { w: 'majority' },
    session: options.session
  });
};

/**
 * Atomically takes over an expired or abandoned role.
 * Target role MUST be in STOPPED, EXPIRED, or RECOVERY_REQUIRED status,
 * OR actively in STARTING/ACTIVE/DRAINING with heartbeatExpiresAt < now.
 * Increments epoch to guarantee monotonic fencing against previous owner.
 *
 * @param {string} role
 * @param {object} params
 * @param {string} params.workerId
 * @param {string} params.incarnationId
 * @param {number} [params.leaseTtlMs=30000]
 * @param {number} [params.heartbeatIntervalMs=10000]
 * @param {string} [params.hostname]
 * @param {number} [params.pid]
 * @param {number} [params.quarantineCooldownMs=0] - Optional cooldown past heartbeat expiration
 * @param {object} [params.metadata]
 * @param {object} [options={}]
 * @returns {Promise<AppWorker|null>} Returns updated doc on success, null on contention
 */
appWorkerSchema.statics.takeOverRole = async function (role, params, options = {}) {
  const {
    workerId,
    incarnationId,
    leaseTtlMs = DEFAULT_WORKER_LEASE_TTL_MS,
    heartbeatIntervalMs = DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
    hostname = os.hostname(),
    pid = process.pid,
    quarantineCooldownMs = 0,
    metadata = {}
  } = params;

  if (!role || !workerId || !incarnationId) {
    throw new TypeError('takeOverRole requires role, workerId, and incarnationId');
  }

  await this.ensureRoleDocument(role, options);

  const now = new Date();
  const quarantineThreshold = new Date(now.getTime() - Math.max(0, quarantineCooldownMs));
  const newExpiresAt = new Date(now.getTime() + leaseTtlMs);

  const filter = {
    _id: role,
    $or: [
      { status: APP_WORKER_STATUS.STOPPED },
      { status: APP_WORKER_STATUS.EXPIRED },
      { status: APP_WORKER_STATUS.RECOVERY_REQUIRED },
      {
        status: {
          $in: [
            APP_WORKER_STATUS.STARTING,
            APP_WORKER_STATUS.ACTIVE,
            APP_WORKER_STATUS.DRAINING
          ]
        },
        heartbeatExpiresAt: { $lt: quarantineThreshold }
      }
    ]
  };

  const update = {
    $set: {
      role,
      workerId,
      incarnationId,
      hostname,
      pid,
      status: APP_WORKER_STATUS.ACTIVE,
      heartbeatExpiresAt: newExpiresAt,
      leaseTtlMs,
      heartbeatIntervalMs,
      lastHeartbeatAt: now,
      activeClaimCount: 0,
      metadata: metadata || {},
      updatedAt: now
    },
    $inc: { epoch: 1 } // Monotonic fencing token increment
  };

  return await this.findOneAndUpdate(filter, update, {
    new: true,
    writeConcern: options.writeConcern || { w: 'majority' },
    session: options.session
  });
};

/**
 * Watchdog recovery sweeper.
 * Scans all roles whose heartbeat deadline has passed.
 * - If activeClaimCount > 0: transitions to RECOVERY_REQUIRED.
 * - If activeClaimCount == 0: transitions to EXPIRED.
 *
 * @param {object} [options={}]
 * @param {Date} [options.now=new Date()]
 * @returns {Promise<{ recoveredCount: number, recoveryRequiredCount: number, expiredCount: number }>}
 */
appWorkerSchema.statics.recoverExpiredRoles = async function (options = {}) {
  const now = options.now || new Date();
  const writeConcern = options.writeConcern || { w: 'majority' };

  // 1. Roles that expired with claims in-flight: mark RECOVERY_REQUIRED
  const recoveryRes = await this.updateMany(
    {
      status: {
        $in: [
          APP_WORKER_STATUS.STARTING,
          APP_WORKER_STATUS.ACTIVE,
          APP_WORKER_STATUS.DRAINING
        ]
      },
      heartbeatExpiresAt: { $lt: now },
      activeClaimCount: { $gt: 0 }
    },
    {
      $set: {
        status: APP_WORKER_STATUS.RECOVERY_REQUIRED,
        updatedAt: now
      }
    },
    { writeConcern }
  );

  // 2. Roles that expired cleanly with zero claims: mark EXPIRED
  const expiredRes = await this.updateMany(
    {
      status: {
        $in: [
          APP_WORKER_STATUS.STARTING,
          APP_WORKER_STATUS.ACTIVE,
          APP_WORKER_STATUS.DRAINING
        ]
      },
      heartbeatExpiresAt: { $lt: now },
      $or: [
        { activeClaimCount: { $lte: 0 } },
        { activeClaimCount: { $exists: false } }
      ]
    },
    {
      $set: {
        status: APP_WORKER_STATUS.EXPIRED,
        updatedAt: now
      }
    },
    { writeConcern }
  );

  return {
    recoveredCount: (recoveryRes.modifiedCount || 0) + (expiredRes.modifiedCount || 0),
    recoveryRequiredCount: recoveryRes.modifiedCount || 0,
    expiredCount: expiredRes.modifiedCount || 0
  };
};

/**
 * Atomically adjusts active claim count for an active worker tenure.
 * Fails closed if epoch has changed or lease has expired.
 *
 * @param {string} role
 * @param {object} params
 * @param {string} params.workerId
 * @param {string} params.incarnationId
 * @param {number} params.expectedEpoch
 * @param {number} params.delta (+1 or -1)
 * @param {object} [options={}]
 * @returns {Promise<AppWorker|null>}
 */
appWorkerSchema.statics.adjustActiveClaims = async function (role, params, options = {}) {
  const { workerId, incarnationId, expectedEpoch, delta } = params;
  const now = new Date();

  const filter = {
    _id: role,
    workerId,
    incarnationId,
    epoch: expectedEpoch,
    status: { $in: [APP_WORKER_STATUS.STARTING, APP_WORKER_STATUS.ACTIVE, APP_WORKER_STATUS.DRAINING] },
    heartbeatExpiresAt: { $gt: now }
  };

  const update = {
    $inc: { activeClaimCount: delta }
  };

  return await this.findOneAndUpdate(filter, update, {
    new: true,
    writeConcern: options.writeConcern || { w: 'majority' },
    session: options.session
  });
};

const AppWorker = mongoose.models.AppWorker || mongoose.model('AppWorker', appWorkerSchema);

export default AppWorker;
