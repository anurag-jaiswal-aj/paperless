import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import InstanceLease, {
  INSTANCE_LEASE_SINGLETON_ID,
  INSTANCE_LEASE_STATUS,
  InstanceLeaseSlot,
  INSTANCE_LEASE_SLOT_COUNT,
  ALL_16_SLOT_IDS
} from '../models/instanceLease.js';
import { logger } from '../utils/logger.js';

export { INSTANCE_LEASE_SINGLETON_ID, INSTANCE_LEASE_STATUS, ALL_16_SLOT_IDS };

export class InstanceFencedError extends Error {
  constructor(
    message = 'Instance is fenced or deployment lease has expired',
    code = 'INSTANCE_FENCED'
  ) {
    super(message);
    this.name = 'InstanceFencedError';
    this.code = code;
    this.status = 503;
    this.statusCode = 503;
  }

  hasErrorLabel(label) {
    if (label === 'TransientTransactionError' || label === 'UnknownTransactionCommitResult') {
      return false;
    }
    return false;
  }
}

export const DEFAULT_INSTANCE_LEASE_TTL_MS = 30000; // 30 seconds
export const DEFAULT_INSTANCE_HEARTBEAT_INTERVAL_MS = 10000; // 10 seconds
export const DEFAULT_QUARANTINE_COOLDOWN_MS = 30000; // 30 seconds: guarantees WiredTiger transaction abort (15s lifetime + 10s commit timeout + 5s margin)
export const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 2;

let activeInstanceId = null;
let heartbeatTimer = null;
let localMonotonicDeadlineMs = 0;
let localUptimeDeadlineSec = 0;
let consecutiveHeartbeatFailures = 0;
let isFencedExplicitly = false;

// System uptime getter hook for testing suspend/sleep jumps
let systemUptimeGetter = () => os.uptime();

export const setSystemUptimeForTesting = (fnOrSec) => {
  if (typeof fnOrSec === 'function') {
    systemUptimeGetter = fnOrSec;
  } else {
    systemUptimeGetter = () => fnOrSec;
  }
};

export const resetSystemUptimeForTesting = () => {
  systemUptimeGetter = () => os.uptime();
};

export const getInstanceId = () => activeInstanceId;
export const getActiveInstanceId = () => activeInstanceId;

/**
 * Checks whether this process currently holds a valid, unexpired single-instance deployment lease.
 * Evaluates in-memory monotonic and suspend-aware deadlines synchronously with zero I/O latency.
 *
 * @param {number} [minRemainingMs=0] - Optional buffer; lease must remain valid for at least this duration
 * @returns {boolean}
 */
export const isInstanceLeaseValid = (minRemainingMs = 0) => {
  if (isFencedExplicitly) return false;
  if (!activeInstanceId) {
    // If local test deadlines were explicitly injected without an instanceId, evaluate them
    if (localMonotonicDeadlineMs > 0 || localUptimeDeadlineSec > 0) {
      const bufferMs = Math.max(0, minRemainingMs);
      if (
        localMonotonicDeadlineMs > 0 &&
        performance.now() + bufferMs >= localMonotonicDeadlineMs
      ) {
        return false;
      }
      if (
        localUptimeDeadlineSec > 0 &&
        systemUptimeGetter() + bufferMs / 1000 >= localUptimeDeadlineSec
      ) {
        return false;
      }
      return true;
    }

    // In production/staging deployments, the server always acquires an instance lease on boot.
    // In test runners (e.g. unit/integration tests running under Vitest/Jest that mock or bypass server boot),
    // permit execution if no lease has been initialized.
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
      if (!process.env.VITEST && !process.env.JEST_WORKER_ID) {
        return false;
      }
    }
    return true;
  }
  const bufferMs = Math.max(0, minRemainingMs);
  if (localMonotonicDeadlineMs > 0 && performance.now() + bufferMs >= localMonotonicDeadlineMs) {
    return false;
  }
  if (
    localUptimeDeadlineSec > 0 &&
    systemUptimeGetter() + bufferMs / 1000 >= localUptimeDeadlineSec
  ) {
    return false;
  }
  return true;
};

export const isInstanceLeader = (minRemainingMs = 0) => isInstanceLeaseValid(minRemainingMs);

/**
 * Asserts that the current process is the valid instance leader with at least minRemainingMs
 * before local monotonic or suspend-aware lease expiration.
 * Throws InstanceFencedError (HTTP 503 INSTANCE_FENCED) if invalid.
 *
 * @param {object} [options={}]
 * @param {number} [options.minRemainingMs=0]
 * @param {string} [options.message]
 * @throws {InstanceFencedError}
 */
export const assertInstanceLeader = (options = {}) => {
  const minRemainingMs = options?.minRemainingMs || 0;
  if (!isInstanceLeaseValid(minRemainingMs)) {
    const msg = options?.message || 'Instance is fenced or deployment lease has expired';
    logger.warn('Instance leadership assertion failed', {
      event: 'instance_lease.assertion_failed',
      minRemainingMs,
      instanceId: activeInstanceId,
      isFencedExplicitly
    });
    throw new InstanceFencedError(msg);
  }
  return true;
};

/**
 * Datastore-enforced fencing guard executed within a MongoDB ClientSession.
 * Performs an atomic conditional update on the instance lease document.
 * If leadership has been transferred, deposed, or expired, matchedCount !== 1,
 * throwing InstanceFencedError and forcing WiredTiger to abort the transaction.
 *
 * @param {import('mongoose').ClientSession} session
 * @throws {InstanceFencedError}
 */
export const verifyTransactionalFence = async (session, options = {}) => {
  if (isFencedExplicitly) {
    throw new InstanceFencedError('Instance is marked fenced explicitly');
  }
  if (!activeInstanceId) {
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
      if (!process.env.VITEST && !process.env.JEST_WORKER_ID) {
        throw new InstanceFencedError('No active deployment lease held during transaction');
      }
    }
    return true;
  }
  const now = new Date();

  // If partitioned slot fencing is requested (accept options.slotId directly or options.useSlots)
  if (options.slotId || options.useSlots) {
    let slotId = typeof options.slotId === 'number' ? `slot_${options.slotId}` : options.slotId;
    if (!slotId) {
      const reqId = options.requestId || '';
      let hash = 0;
      for (let i = 0; i < reqId.length; i++) {
        hash = (hash << 5) - hash + reqId.charCodeAt(i);
        hash |= 0;
      }
      const slotIndex = Math.abs(hash) % INSTANCE_LEASE_SLOT_COUNT;
      slotId = `slot_${slotIndex}`;
    }
    const slotRes = await InstanceLeaseSlot.updateOne(
      {
        _id: slotId,
        instanceId: activeInstanceId,
        status: INSTANCE_LEASE_STATUS.ACTIVE,
        expiresAt: { $gt: now }
      },
      {
        $set: { lastTouchAt: now },
        $inc: { fenceEpoch: 1 }
      },
      { session }
    );
    if (slotRes.matchedCount !== 1) {
      throw new InstanceFencedError(
        `Datastore transactional fence failed: deployment lease slot ${slotId} no longer held by instance ${activeInstanceId}`
      );
    }
    return true;
  }

  // Standard datastore boundary transactional fence
  const res = await InstanceLease.updateOne(
    {
      _id: INSTANCE_LEASE_SINGLETON_ID,
      instanceId: activeInstanceId,
      status: INSTANCE_LEASE_STATUS.ACTIVE,
      expiresAt: { $gt: now }
    },
    {
      $set: { lastActivityAt: now },
      $inc: { txEpoch: 1 }
    },
    { session }
  );
  if (res.matchedCount !== 1) {
    throw new InstanceFencedError(
      `Datastore transactional fence failed: deployment lease no longer held by instance ${activeInstanceId}`
    );
  }
  return true;
};

export const markFencedForTesting = () => {
  isFencedExplicitly = true;
};

export const resetFencedForTesting = () => {
  isFencedExplicitly = false;
};

export const setActiveInstanceIdForTesting = (id) => {
  activeInstanceId = id;
};

export const setLocalLeaseDeadlineForTesting = (arg) => {
  if (!activeInstanceId) {
    activeInstanceId = 'test-instance';
  }
  if (typeof arg === 'number') {
    localMonotonicDeadlineMs = arg;
  } else if (arg && typeof arg === 'object') {
    if (arg.monotonicDeadlineMs !== undefined) localMonotonicDeadlineMs = arg.monotonicDeadlineMs;
    if (arg.uptimeDeadlineSec !== undefined) localUptimeDeadlineSec = arg.uptimeDeadlineSec;
  }
};

export const resetLocalLeaseDeadlineForTesting = () => {
  localMonotonicDeadlineMs = 0;
  localUptimeDeadlineSec = 0;
  consecutiveHeartbeatFailures = 0;
  isFencedExplicitly = false;
  activeInstanceId = null;
};

export const getConsecutiveHeartbeatFailures = () => consecutiveHeartbeatFailures;

/**
 * Ensures all partitioned fencing slots exist in app_instance_lease_slots.
 * Fails closed without error swallowing if slots cannot be created, migrated, or verified.
 */
export const ensureSlotsExist = async () => {
  const ops = [];
  for (let i = 0; i < INSTANCE_LEASE_SLOT_COUNT; i++) {
    ops.push({
      updateOne: {
        filter: { _id: `slot_${i}` },
        update: {
          $setOnInsert: {
            _id: `slot_${i}`,
            slotIndex: i,
            instanceId: null,
            version: 0,
            status: INSTANCE_LEASE_STATUS.RELEASED,
            expiresAt: new Date(0),
            lastTouchAt: null,
            fenceEpoch: 0
          }
        },
        upsert: true
      }
    });
  }

  try {
    await InstanceLeaseSlot.bulkWrite(ops, { ordered: false });
  } catch (bulkErr) {
    // Condition E-4: Handle E11000 duplicate key error as an idempotent concurrent boot race
    const isDuplicateKey =
      bulkErr.code === 11000 || bulkErr.writeErrors?.some((e) => e.code === 11000);
    if (!isDuplicateKey) {
      throw bulkErr;
    }
  }

  // Idempotently migrate legacy slots missing fenceEpoch without resetting existing epochs
  await InstanceLeaseSlot.updateMany(
    { fenceEpoch: { $exists: false } },
    { $set: { fenceEpoch: 0 } }
  );

  // Assert all 16 slots exist; fail closed if count !== 16
  const count = await InstanceLeaseSlot.countDocuments({
    _id: { $in: ALL_16_SLOT_IDS }
  });
  if (count !== INSTANCE_LEASE_SLOT_COUNT) {
    throw new Error(
      `Deployment lease slot verification failed: expected ${INSTANCE_LEASE_SLOT_COUNT} slots, found ${count}`
    );
  }
  return count;
};

/**
 * Ensures the singleton document exists in app_instance_leases.
 */
export const ensureInstanceSingletonExists = async () => {
  await InstanceLease.updateOne(
    { _id: INSTANCE_LEASE_SINGLETON_ID },
    {
      $setOnInsert: {
        _id: INSTANCE_LEASE_SINGLETON_ID,
        instanceId: 'unassigned',
        status: INSTANCE_LEASE_STATUS.RELEASED,
        startedAt: new Date(0),
        expiresAt: new Date(0),
        lastHeartbeatAt: new Date(0),
        version: 0
      }
    },
    { upsert: true }
  );
  await ensureSlotsExist();

  // Ensure BackupLease singleton exists so conditional coordination write in acquireInstanceLease succeeds
  const BackupLease =
    mongoose.models.BackupLease ||
    (mongoose.modelNames().includes('BackupLease') ? mongoose.model('BackupLease') : null);
  if (BackupLease) {
    await BackupLease.updateOne(
      { _id: 'singleton' },
      {
        $setOnInsert: {
          _id: 'singleton',
          status: 'NORMAL',
          version: 0,
          admissionEpoch: 0,
          activeInstanceId: null,
          lastInstanceAdmissionAt: null
        }
      },
      { upsert: true }
    );
  }
};

/**
 * Concurrency-safe atomic lease acquisition for single API instance mutual exclusion.
 * Acquires lease only if status === 'RELEASED' OR expiresAt < now (stale takeover).
 *
 * @param {object} [options={}]
 * @returns {Promise<{ success: boolean, instanceId?: string, existingLease?: object, message?: string }>}
 */
export const acquireInstanceLease = async (options = {}) => {
  const leaseTtlMs =
    Number(options.leaseTtlMs) ||
    parseInt(process.env.INSTANCE_LEASE_TTL_MS, 10) ||
    DEFAULT_INSTANCE_LEASE_TTL_MS;

  const heartbeatIntervalMs =
    Number(options.heartbeatIntervalMs) ||
    parseInt(process.env.INSTANCE_HEARTBEAT_INTERVAL_MS, 10) ||
    DEFAULT_INSTANCE_HEARTBEAT_INTERVAL_MS;

  const defaultQuarantine = process.env.INSTANCE_QUARANTINE_COOLDOWN_MS
    ? parseInt(process.env.INSTANCE_QUARANTINE_COOLDOWN_MS, 10)
    : process.env.NODE_ENV === 'test'
      ? 0
      : DEFAULT_QUARANTINE_COOLDOWN_MS;

  const quarantineCooldownMs =
    options.quarantineCooldownMs !== undefined
      ? Number(options.quarantineCooldownMs)
      : defaultQuarantine;

  const instanceId = options.instanceId || uuidv4();
  const hostname = os.hostname();
  const pid = process.pid;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseTtlMs);

  await ensureInstanceSingletonExists();

  // Conservative Failover Guarantee:
  // 1. Clean release (status === 'RELEASED'): Immediate acquisition permitted.
  // 2. Dirty crash/expiry (status === 'ACTIVE'): Must wait for quarantine cooldown past expiresAt
  //    to ensure all server-side transactions from the old leader have been aborted by WiredTiger.
  const quarantineThreshold = new Date(now.getTime() - quarantineCooldownMs);

  const query = {
    _id: INSTANCE_LEASE_SINGLETON_ID,
    $or: [
      { status: INSTANCE_LEASE_STATUS.RELEASED },
      {
        status: INSTANCE_LEASE_STATUS.ACTIVE,
        expiresAt: { $lt: quarantineThreshold }
      }
    ]
  };

  const update = {
    $set: {
      instanceId,
      hostname,
      pid,
      status: INSTANCE_LEASE_STATUS.ACTIVE,
      startedAt: now,
      expiresAt,
      lastHeartbeatAt: now,
      leaseTtlMs,
      heartbeatIntervalMs
    },
    $inc: { version: 1 }
  };

  let acquired = null;
  let predicateFailed = false;
  const takeoverSession = await mongoose.startSession();

  try {
    await takeoverSession.withTransaction(
      async () => {
        // Invariant INV-8: Quiescence mutual exclusion guard (F5 remediation)
        // Shared Coordination Barrier (Finding F5 Atomicity Closure):
        // Materialize write conflict on BackupLease by atomically updating the singleton document.
        // Requires status to be strictly NORMAL. If DRAINING, QUIESCED, or RECOVERY_REQUIRED, fails closed.
        const BackupLease =
          mongoose.models.BackupLease ||
          (mongoose.modelNames().includes('BackupLease') ? mongoose.model('BackupLease') : null);

        if (BackupLease) {
          const backupLeaseRes = await BackupLease.findOneAndUpdate(
            {
              _id: 'singleton',
              status: 'NORMAL'
            },
            {
              $inc: { version: 1, admissionEpoch: 1 },
              $set: {
                lastInstanceAdmissionAt: now,
                activeInstanceId: instanceId
              }
            },
            { session: takeoverSession, new: true }
          );

          if (!backupLeaseRes) {
            const currentBackup = await BackupLease.findById('singleton')
              .session(takeoverSession)
              .lean();
            if (currentBackup?.status === 'RECOVERY_REQUIRED') {
              throw new Error('SYSTEM_RECOVERY_REQUIRED');
            }
            throw new Error('SYSTEM_QUIESCENCE_ACTIVE');
          }
        }

        acquired = await InstanceLease.findOneAndUpdate(query, update, {
          new: true,
          session: takeoverSession
        });

        if (!acquired) {
          predicateFailed = true;
          throw new Error('LEASE_ACQUISITION_PREDICATE_FAILED');
        }

        const slotRes = await InstanceLeaseSlot.updateMany(
          { _id: { $in: ALL_16_SLOT_IDS } },
          {
            $set: {
              instanceId,
              version: acquired.version,
              status: INSTANCE_LEASE_STATUS.ACTIVE,
              expiresAt,
              lastTouchAt: now
            },
            $inc: { fenceEpoch: 1 }
          },
          { session: takeoverSession }
        );

        if (
          slotRes.matchedCount !== INSTANCE_LEASE_SLOT_COUNT ||
          slotRes.modifiedCount !== INSTANCE_LEASE_SLOT_COUNT
        ) {
          throw new Error(
            `Slot atomic takeover incomplete: matchedCount=${slotRes.matchedCount}, modifiedCount=${slotRes.modifiedCount}, expected ${INSTANCE_LEASE_SLOT_COUNT}`
          );
        }
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 10000
      }
    );
  } catch (txErr) {
    if (predicateFailed || txErr.message === 'LEASE_ACQUISITION_PREDICATE_FAILED') {
      acquired = null;
    } else if (txErr.message === 'SYSTEM_QUIESCENCE_ACTIVE') {
      logger.warn('Instance registration rejected: system is actively in quiescence or draining', {
        event: 'instance_lease.rejected_during_quiescence',
        instanceId
      });
      return {
        success: false,
        reason: 'SYSTEM_QUIESCENCE_ACTIVE',
        message:
          'Cannot register application instance while system is actively in quiescence or draining'
      };
    } else if (txErr.message === 'SYSTEM_RECOVERY_REQUIRED') {
      logger.warn('Instance registration rejected: system is in RECOVERY_REQUIRED status', {
        event: 'instance_lease.rejected_recovery_required',
        instanceId
      });
      return {
        success: false,
        reason: 'SYSTEM_RECOVERY_REQUIRED',
        message: 'Cannot register application instance while system is in RECOVERY_REQUIRED status'
      };
    } else {
      // Condition E-2: Log error and return failure object instead of throwing unhandled error to caller
      logger.error('instance_lease.takeover_transaction_error', txErr, {
        event: 'instance_lease.takeover_error',
        instanceId
      });
      return {
        success: false,
        reason: 'TAKEOVER_TRANSACTION_FAILED',
        error: txErr.message
      };
    }
  } finally {
    await takeoverSession.endSession().catch(() => {});
  }

  if (!acquired) {
    const existing = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();

    // Check if rejection was due to quarantine cooldown
    if (
      existing?.status === INSTANCE_LEASE_STATUS.ACTIVE &&
      existing.expiresAt &&
      existing.expiresAt < now
    ) {
      const remainingQuarantineMs = Math.max(
        0,
        new Date(existing.expiresAt).getTime() + quarantineCooldownMs - now.getTime()
      );
      logger.warn('Standby instance takeover held in quarantine cooldown', {
        event: 'instance_lease.quarantine_cooldown',
        activeInstanceId: existing.instanceId,
        expiresAt: existing.expiresAt,
        quarantineCooldownMs,
        remainingQuarantineMs
      });
      return {
        success: false,
        reason: 'QUARANTINE_COOLDOWN_ACTIVE',
        existingLease: existing,
        remainingQuarantineMs,
        message: `Previous instance lease expired at ${existing.expiresAt}; quarantine cooldown of ${quarantineCooldownMs}ms is active to guarantee WiredTiger transaction termination (remaining: ${remainingQuarantineMs}ms)`
      };
    }

    logger.fatal(
      'FATAL: Multiple API instances detected! Paperless enforces a strict single-instance deployment topology.',
      {
        event: 'instance_lease.rejected',
        activeInstanceId: existing?.instanceId,
        activeHostname: existing?.hostname,
        activePid: existing?.pid,
        expiresAt: existing?.expiresAt
      }
    );
    return {
      success: false,
      reason: 'CONCURRENT_INSTANCE_ACTIVE',
      existingLease: existing,
      message: `Active instance already holds deployment lease (instanceId: ${existing?.instanceId}, expiresAt: ${existing?.expiresAt})`
    };
  }

  activeInstanceId = instanceId;
  isFencedExplicitly = false;
  consecutiveHeartbeatFailures = 0;
  localMonotonicDeadlineMs = performance.now() + leaseTtlMs;
  localUptimeDeadlineSec = systemUptimeGetter() + leaseTtlMs / 1000;

  // Start background heartbeat unless explicitly skipped (e.g. in one-shot tests)
  if (!options.skipHeartbeat) {
    startHeartbeat(instanceId, leaseTtlMs, heartbeatIntervalMs);
  }

  logger.info('Acquired single-instance deployment lease successfully', {
    event: 'instance_lease.acquired',
    instanceId,
    hostname,
    pid,
    expiresAt
  });

  return {
    success: true,
    instanceId,
    expiresAt,
    version: acquired.version
  };
};

/**
 * Periodically renews the active instance lease.
 * If renewal fails (lease stolen or expired during network partition), self-fences the process.
 */
export const startHeartbeat = (instanceId, leaseTtlMs, heartbeatIntervalMs) => {
  stopHeartbeat();

  localMonotonicDeadlineMs = performance.now() + leaseTtlMs;
  localUptimeDeadlineSec = systemUptimeGetter() + leaseTtlMs / 1000;
  consecutiveHeartbeatFailures = 0;
  isFencedExplicitly = false;

  heartbeatTimer = setInterval(async () => {
    const now = new Date();

    // 1. Pre-heartbeat check: if local deadline already expired, self-fence immediately
    if (
      performance.now() >= localMonotonicDeadlineMs ||
      systemUptimeGetter() >= localUptimeDeadlineSec
    ) {
      logger.fatal(
        'FATAL: Instance lease expired locally before heartbeat renewal! Self-fencing process immediately.',
        { event: 'instance_lease.fenced_locally', instanceId }
      );
      stopHeartbeat();
      activeInstanceId = null;
      isFencedExplicitly = true;
      if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
      }
      return;
    }

    try {
      const expiresAt = new Date(now.getTime() + leaseTtlMs);

      // ATOMIC PREDICATE: Lease MUST not be expired in MongoDB!
      // Prevents zombie revival after long partitions/stalls.
      const updated = await InstanceLease.findOneAndUpdate(
        {
          _id: INSTANCE_LEASE_SINGLETON_ID,
          instanceId,
          status: INSTANCE_LEASE_STATUS.ACTIVE,
          expiresAt: { $gt: now }
        },
        {
          $set: {
            expiresAt,
            lastHeartbeatAt: now
          },
          $inc: { version: 1 }
        },
        { new: true }
      );

      if (!updated) {
        logger.fatal(
          'FATAL: Lost single-instance deployment lease! Self-fencing process to avoid split-brain execution.',
          { event: 'instance_lease.fenced', instanceId }
        );
        stopHeartbeat();
        activeInstanceId = null;
        isFencedExplicitly = true;
        if (process.env.NODE_ENV !== 'test') {
          process.exit(1);
        }
        return;
      }

      // Renewal successful: extend deadlines and reset error counter
      try {
        const slotHeartbeatRes = await InstanceLeaseSlot.updateMany(
          { instanceId },
          { $set: { expiresAt } }
        );
        if (slotHeartbeatRes.matchedCount < INSTANCE_LEASE_SLOT_COUNT) {
          logger.warn('instance_lease.heartbeat_slots_mismatch', {
            expected: INSTANCE_LEASE_SLOT_COUNT,
            matched: slotHeartbeatRes.matchedCount,
            instanceId
          });
        }
      } catch (slotHeartbeatErr) {
        logger.warn('instance_lease.heartbeat_slots_error', {
          error: slotHeartbeatErr.message,
          instanceId
        });
      }

      consecutiveHeartbeatFailures = 0;
      localMonotonicDeadlineMs = performance.now() + leaseTtlMs;
      localUptimeDeadlineSec = systemUptimeGetter() + leaseTtlMs / 1000;
    } catch (err) {
      consecutiveHeartbeatFailures++;
      logger.error(
        `Error renewing instance lease heartbeat (failure ${consecutiveHeartbeatFailures}/${MAX_CONSECUTIVE_HEARTBEAT_FAILURES}): ${err.message}`,
        err,
        {
          event: 'instance_lease.heartbeat_error',
          instanceId,
          consecutiveFailures: consecutiveHeartbeatFailures
        }
      );

      if (
        consecutiveHeartbeatFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES ||
        performance.now() >= localMonotonicDeadlineMs ||
        systemUptimeGetter() >= localUptimeDeadlineSec
      ) {
        logger.fatal(
          'FATAL: Heartbeat failure threshold exceeded! Self-fencing process to avoid split-brain.',
          {
            event: 'instance_lease.fenced_heartbeat_threshold',
            instanceId,
            consecutiveFailures: consecutiveHeartbeatFailures
          }
        );
        stopHeartbeat();
        activeInstanceId = null;
        isFencedExplicitly = true;
        if (process.env.NODE_ENV !== 'test') {
          process.exit(1);
        }
      }
    }
  }, heartbeatIntervalMs);

  if (heartbeatTimer && heartbeatTimer.unref) {
    heartbeatTimer.unref();
  }
};

export const stopHeartbeat = () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
};

/**
 * Releases the instance lease on graceful shutdown.
 */
export const releaseInstanceLease = async (instanceId = activeInstanceId) => {
  stopHeartbeat();

  localMonotonicDeadlineMs = 0;
  localUptimeDeadlineSec = 0;
  consecutiveHeartbeatFailures = 0;

  if (!instanceId) {
    activeInstanceId = null;
    return { success: true, released: false };
  }

  const now = new Date();
  const BackupLease =
    mongoose.models.BackupLease ||
    (mongoose.modelNames().includes('BackupLease') ? mongoose.model('BackupLease') : null);

  let hasTxSupport = false;
  try {
    const { supportsTransactions } = await import('../utils/dbTransaction.js');
    hasTxSupport = supportsTransactions();
  } catch {
    hasTxSupport = false;
  }

  let wasReleased = false;
  let wasExpired = false;

  if (hasTxSupport) {
    const releaseSession = await mongoose.startSession();
    try {
      await releaseSession.withTransaction(
        async () => {
          // 1. Verify lease is held by this instance
          const currentDoc = await InstanceLease.findOne({
            _id: INSTANCE_LEASE_SINGLETON_ID,
            instanceId
          }).session(releaseSession);

          if (!currentDoc) {
            wasReleased = false;
            return;
          }

          // 2. Quarantine Cooldown Barrier:
          // If lease already expired, retain ACTIVE status so successors wait quarantine cooldown.
          if (currentDoc.status === INSTANCE_LEASE_STATUS.ACTIVE && currentDoc.expiresAt <= now) {
            wasExpired = true;
            wasReleased = false;

            if (BackupLease) {
              await BackupLease.updateOne(
                { _id: 'singleton', activeInstanceId: instanceId },
                { $set: { activeInstanceId: null }, $inc: { version: 1 } },
                { session: releaseSession }
              );
            }
            return;
          }

          if (currentDoc.status === INSTANCE_LEASE_STATUS.RELEASED) {
            wasReleased = false;
            return;
          }

          // 3. Clean release: atomically update InstanceLease, slots, and BackupLease
          const updated = await InstanceLease.findOneAndUpdate(
            {
              _id: INSTANCE_LEASE_SINGLETON_ID,
              instanceId,
              status: INSTANCE_LEASE_STATUS.ACTIVE,
              expiresAt: { $gt: now }
            },
            {
              $set: {
                status: INSTANCE_LEASE_STATUS.RELEASED,
                expiresAt: now
              },
              $inc: { version: 1 }
            },
            { session: releaseSession, new: true }
          );

          if (!updated) {
            wasReleased = false;
            return;
          }

          await InstanceLeaseSlot.updateMany(
            { instanceId, status: INSTANCE_LEASE_STATUS.ACTIVE },
            { $set: { status: INSTANCE_LEASE_STATUS.RELEASED, expiresAt: now } },
            { session: releaseSession }
          );

          if (BackupLease) {
            await BackupLease.updateOne(
              { _id: 'singleton', activeInstanceId: instanceId },
              { $set: { activeInstanceId: null }, $inc: { version: 1 } },
              { session: releaseSession }
            );
          }

          wasReleased = true;
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          maxCommitTimeMS: 10000
        }
      );
    } catch (txErr) {
      logger.error('instance_lease.release_transaction_error', txErr, {
        event: 'instance_lease.release_error',
        instanceId
      });
      return { success: false, error: txErr.message };
    } finally {
      await releaseSession.endSession().catch(() => {});
    }
  } else {
    // Non-transactional fallback for standalone test environments
    try {
      const currentDoc = await InstanceLease.findOne({
        _id: INSTANCE_LEASE_SINGLETON_ID,
        instanceId
      });

      if (!currentDoc || currentDoc.status === INSTANCE_LEASE_STATUS.RELEASED) {
        wasReleased = false;
      } else if (
        currentDoc.status === INSTANCE_LEASE_STATUS.ACTIVE &&
        currentDoc.expiresAt <= now
      ) {
        wasExpired = true;
        wasReleased = false;
        if (BackupLease) {
          await BackupLease.updateOne(
            { _id: 'singleton', activeInstanceId: instanceId },
            { $set: { activeInstanceId: null }, $inc: { version: 1 } }
          );
        }
      } else {
        const updated = await InstanceLease.findOneAndUpdate(
          {
            _id: INSTANCE_LEASE_SINGLETON_ID,
            instanceId,
            status: INSTANCE_LEASE_STATUS.ACTIVE,
            expiresAt: { $gt: now }
          },
          {
            $set: {
              status: INSTANCE_LEASE_STATUS.RELEASED,
              expiresAt: now
            },
            $inc: { version: 1 }
          },
          { new: true }
        );

        if (updated) {
          await InstanceLeaseSlot.updateMany(
            { instanceId, status: INSTANCE_LEASE_STATUS.ACTIVE },
            { $set: { status: INSTANCE_LEASE_STATUS.RELEASED, expiresAt: now } }
          );

          if (BackupLease) {
            await BackupLease.updateOne(
              { _id: 'singleton', activeInstanceId: instanceId },
              { $set: { activeInstanceId: null }, $inc: { version: 1 } }
            );
          }
          wasReleased = true;
        }
      }
    } catch (nonTxErr) {
      logger.error(`Failed to release instance lease cleanly: ${nonTxErr.message}`, nonTxErr, {
        event: 'instance_lease.release_error',
        instanceId
      });
      return { success: false, error: nonTxErr.message };
    }
  }

  activeInstanceId = null;

  logger.info('Released single-instance deployment lease cleanly', {
    event: 'instance_lease.released',
    instanceId,
    wasReleased,
    wasExpired
  });

  return { success: true, released: wasReleased, wasExpired };
};

export default {
  acquireInstanceLease,
  releaseInstanceLease,
  startHeartbeat,
  stopHeartbeat,
  getInstanceId,
  ensureInstanceSingletonExists,
  ensureSlotsExist,
  isInstanceLeaseValid,
  isInstanceLeader,
  assertInstanceLeader,
  InstanceFencedError,
  DEFAULT_QUARANTINE_COOLDOWN_MS,
  setSystemUptimeForTesting,
  resetSystemUptimeForTesting,
  markFencedForTesting,
  resetFencedForTesting,
  setLocalLeaseDeadlineForTesting,
  resetLocalLeaseDeadlineForTesting,
  getConsecutiveHeartbeatFailures
};
