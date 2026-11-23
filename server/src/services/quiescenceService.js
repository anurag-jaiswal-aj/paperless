import fs from 'node:fs';
import os from 'node:os';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import { logger } from '../utils/logger.js';
import { getInFlightTransactionCount } from '../utils/dbTransaction.js';

export { BACKUP_LEASE_SINGLETON_ID, BACKUP_LEASE_STATUS };

export const DEFAULT_INITIAL_LEASE_MS = 60 * 1000; // 60 seconds
export const DEFAULT_MAX_WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_HEARTBEAT_EXTEND_MS = 30 * 1000; // 30 seconds

/**
 * In-process monotonic watchdog tracker.
 * Tracks elapsed time in memory via process monotonic clock (performance.now())
 * to ensure backward wall-clock adjustments cannot unsafely extend lease durations.
 */
let activeMonotonicWatchdog = {
  leaseId: null,
  monotonicStartMs: null,
  maxAllowedDurationMs: null,
  monotonicDeadlineMs: null,
  uptimeStartSec: null,
  uptimeDeadlineSec: null
};

let customUptimeForTesting = null;

export const setSystemUptimeForTesting = (uptimeSec) => {
  customUptimeForTesting = uptimeSec;
};

export const resetSystemUptimeForTesting = () => {
  customUptimeForTesting = null;
};

/**
 * Checks whether MongoDB TTLMonitor should remain disabled per operator configuration (F4 / Invariant INV-7).
 * Evaluates PAPERLESS_DISABLE_TTL_MONITOR === '1' || 'true'.
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
export const isTtlMonitorDisabledByConfig = (env = process.env) => {
  return Boolean(
    env.PAPERLESS_DISABLE_TTL_MONITOR === '1' ||
    env.PAPERLESS_DISABLE_TTL_MONITOR === 'true'
  );
};

/**
 * Safely applies or suppresses the MongoDB TTLMonitor parameter.
 *
 * @param {boolean} desiredEnabled
 * @param {object} [options={}]
 * @param {object} [options.env=process.env]
 * @param {boolean} [options.strict=false]
 * @returns {Promise<object>}
 */
export const applyTtlMonitorState = async (desiredEnabled, options = {}) => {
  const env = options.env || process.env;
  const isSuppressed = isTtlMonitorDisabledByConfig(env);

  if (desiredEnabled && isSuppressed) {
    logger.info('quiescence.ttl_monitor_enable_suppressed', {
      event: 'quiescence.ttl_monitor_suppressed',
      reason: 'PAPERLESS_DISABLE_TTL_MONITOR is active'
    });
    return { applied: false, suppressed: true, enabled: false };
  }

  if (!mongoose.connection?.db) {
    return { applied: false, reason: 'NO_DB_CONNECTION' };
  }

  try {
    await mongoose.connection.db.admin().command({
      setParameter: 1,
      ttlMonitorEnabled: Boolean(desiredEnabled)
    });
    logger.info('quiescence.ttl_monitor_state_applied', {
      event: 'quiescence.ttl_monitor_state_changed',
      ttlMonitorEnabled: Boolean(desiredEnabled)
    });
    return { applied: true, enabled: Boolean(desiredEnabled) };
  } catch (err) {
    if (options.strict || (isSuppressed && !desiredEnabled)) {
      logger.error('quiescence.ttl_monitor_command_error', {
        event: 'quiescence.ttl_monitor_command_failed',
        desiredEnabled: Boolean(desiredEnabled),
        error: err.message
      });
      throw err;
    }
    logger.warn('quiescence.ttl_monitor_command_warn', {
      event: 'quiescence.ttl_monitor_command_warning',
      desiredEnabled: Boolean(desiredEnabled),
      error: err.message
    });
    return { applied: false, error: err.message };
  }
};

export const getSystemUptime = () => {
  if (customUptimeForTesting !== null) {
    if (typeof customUptimeForTesting === 'function') {
      return customUptimeForTesting();
    }
    return customUptimeForTesting;
  }
  try {
    return os.uptime();
  } catch {
    return 0;
  }
};

export const setMonotonicWatchdog = (leaseId, maxDurationMs) => {
  if (!leaseId || typeof maxDurationMs !== 'number' || maxDurationMs <= 0) {
    clearMonotonicWatchdog();
    return;
  }
  const start = performance.now();
  const uptimeSec = getSystemUptime();
  activeMonotonicWatchdog = {
    leaseId,
    monotonicStartMs: start,
    maxAllowedDurationMs: maxDurationMs,
    monotonicDeadlineMs: start + maxDurationMs,
    uptimeStartSec: uptimeSec,
    uptimeDeadlineSec: typeof uptimeSec === 'number' && uptimeSec > 0
      ? uptimeSec + (maxDurationMs / 1000)
      : null
  };
};

export const clearMonotonicWatchdog = () => {
  activeMonotonicWatchdog = {
    leaseId: null,
    monotonicStartMs: null,
    maxAllowedDurationMs: null,
    monotonicDeadlineMs: null,
    uptimeStartSec: null,
    uptimeDeadlineSec: null
  };
};

/**
 * Synchronize in-memory admission barriers across HTTP mutations and worker tasks.
 * Fast, synchronous barriers close immediate access without awaiting database round-trips.
 *
 * @param {string} status - BACKUP_LEASE_STATUS ('NORMAL' | 'DRAINING' | 'QUIESCED')
 */
export const syncAdmissionState = async (status) => {
  try {
    if (
      status === BACKUP_LEASE_STATUS.DRAINING ||
      status === BACKUP_LEASE_STATUS.QUIESCED ||
      status === BACKUP_LEASE_STATUS.RECOVERY_REQUIRED
    ) {
      const gateMod = await import('../middleware/quiescenceGate.js');
      if (typeof gateMod.closeMutationAdmission === 'function') {
        gateMod.closeMutationAdmission(
          status === BACKUP_LEASE_STATUS.RECOVERY_REQUIRED ? 'RECOVERY_REQUIRED' : 'QUIESCENCE'
        );
      }
      const workerMod = await import('./workerCoordinationService.js');
      if (typeof workerMod.closeWorkerAdmission === 'function') {
        workerMod.closeWorkerAdmission();
      }
      // Distributed worker coordination signaling (AW-03)
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        const workerColl = mongoose.connection.db.collection('app_workers');
        await workerColl.updateMany(
          { status: 'ACTIVE' },
          { $set: { status: 'DRAINING', updatedAt: new Date() } }
        ).catch(() => {});
      }
    } else if (status === BACKUP_LEASE_STATUS.NORMAL) {
      // Safety guard: Never open mutation admission if the persistent singleton is currently RECOVERY_REQUIRED!
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        const leaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean().catch(() => null);
        if (leaseDoc && leaseDoc.status === BACKUP_LEASE_STATUS.RECOVERY_REQUIRED) {
          logger.warn('quiescence.sync_admission_refused_recovery_required', {
            event: 'quiescence.sync_admission_refused',
            reason: 'Durable lease is in RECOVERY_REQUIRED'
          });
          return;
        }
      }

      const gateMod = await import('../middleware/quiescenceGate.js');
      if (typeof gateMod.openMutationAdmission === 'function') {
        gateMod.openMutationAdmission();
      }
      const workerMod = await import('./workerCoordinationService.js');
      if (typeof workerMod.openWorkerAdmission === 'function') {
        workerMod.openWorkerAdmission();
      }
    }
  } catch {
    // Non-fatal if dynamic import fails during teardown or unit testing
  }
};

export const getMonotonicWatchdogState = () => ({ ...activeMonotonicWatchdog });

export const isMonotonicWatchdogExpired = (leaseId) => {
  if (!activeMonotonicWatchdog.leaseId) {
    return false;
  }
  if (leaseId && activeMonotonicWatchdog.leaseId !== leaseId) {
    return false;
  }
  if (performance.now() >= activeMonotonicWatchdog.monotonicDeadlineMs) {
    return true;
  }
  // Suspend-aware check: os.uptime() uses CLOCK_BOOTTIME on Linux / sysctl KERN_BOOTTIME on Darwin,
  // continuing to advance during system suspend/sleep even if CLOCK_MONOTONIC was paused.
  if (
    typeof activeMonotonicWatchdog.uptimeDeadlineSec === 'number' &&
    activeMonotonicWatchdog.uptimeDeadlineSec > 0
  ) {
    try {
      const currentUptime = getSystemUptime();
      if (typeof currentUptime === 'number' && currentUptime >= activeMonotonicWatchdog.uptimeDeadlineSec) {
        return true;
      }
    } catch {
      // Fall back safely to performance.now()
    }
  }
  return false;
};

export const getMonotonicRemainingMs = (leaseId) => {
  if (!activeMonotonicWatchdog.leaseId) {
    return Infinity;
  }
  if (leaseId && activeMonotonicWatchdog.leaseId !== leaseId) {
    return Infinity;
  }
  const perfRemaining = Math.max(0, activeMonotonicWatchdog.monotonicDeadlineMs - performance.now());
  if (
    typeof activeMonotonicWatchdog.uptimeDeadlineSec === 'number' &&
    activeMonotonicWatchdog.uptimeDeadlineSec > 0
  ) {
    try {
      const currentUptime = getSystemUptime();
      if (typeof currentUptime === 'number') {
        const uptimeRemaining = Math.max(0, (activeMonotonicWatchdog.uptimeDeadlineSec - currentUptime) * 1000);
        return Math.min(perfRemaining, uptimeRemaining);
      }
    } catch {
      // Fall back safely
    }
  }
  return perfRemaining;
};

// --- Host-Boot Monotonic and Kernel Boot ID Helpers ---
let customBootIdForTesting = null;
let customHostMonotonicMsForTesting = null;

export const setSystemBootIdForTesting = (bootId) => {
  customBootIdForTesting = bootId;
};

export const resetSystemBootIdForTesting = () => {
  customBootIdForTesting = null;
};

export const setHostMonotonicForTesting = (fnOrMs) => {
  customHostMonotonicMsForTesting = fnOrMs;
};

export const resetHostMonotonicForTesting = () => {
  customHostMonotonicMsForTesting = null;
};

let cachedBootId = null;

export const getSystemBootId = () => {
  if (customBootIdForTesting !== null) {
    return customBootIdForTesting;
  }
  if (cachedBootId) {
    return cachedBootId;
  }

  // 1. Linux containers and native Linux (/proc/sys/kernel/random/boot_id)
  try {
    if (fs.existsSync('/proc/sys/kernel/random/boot_id')) {
      cachedBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return cachedBootId;
    }
  } catch {
    // Ignore and proceed to fallback
  }

  // 2. Fallback: Stable host boot fingerprint derived from os.uptime()
  try {
    const uptimeSec = os.uptime();
    if (typeof uptimeSec === 'number' && uptimeSec > 0) {
      cachedBootId = `boot-${Math.round((Date.now() - uptimeSec * 1000) / 10000) * 10000}`;
      return cachedBootId;
    }
  } catch {
    // Ignore and proceed to fallback
  }

  cachedBootId = 'boot-static-default';
  return cachedBootId;
};

export const getHostMonotonicMs = () => {
  if (customHostMonotonicMsForTesting !== null) {
    if (typeof customHostMonotonicMsForTesting === 'function') {
      return customHostMonotonicMsForTesting();
    }
    return customHostMonotonicMsForTesting;
  }
  return Math.floor(Number(process.hrtime.bigint()) / 1_000_000);
};

/**
 * Resolves the effective hard deadline ceiling from a document, supporting both
 * hardDeadline and monotonicWatchdogDeadline for backward compatibility.
 * Takes the earliest/strictest ceiling when both are present.
 *
 * @param {object} [doc]
 * @returns {Date|null}
 */
export const resolveHardDeadline = (doc) => {
  if (!doc) return null;
  if (doc.hardDeadline && doc.monotonicWatchdogDeadline) {
    return new Date(
      Math.min(
        new Date(doc.hardDeadline).getTime(),
        new Date(doc.monotonicWatchdogDeadline).getTime()
      )
    );
  }
  return doc.hardDeadline || doc.monotonicWatchdogDeadline || null;
};

/**
 * Ensures the singleton document exists in the backup_leases collection.
 */
export const ensureSingletonExists = async () => {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return;
  }
  await BackupLease.updateOne(
    { _id: BACKUP_LEASE_SINGLETON_ID },
    {
      $setOnInsert: {
        _id: BACKUP_LEASE_SINGLETON_ID,
        status: BACKUP_LEASE_STATUS.NORMAL,
        leaseId: null,
        owner: null,
        grantedAt: null,
        expiresAt: null,
        lastHeartbeatAt: null,
        hardDeadline: null,
        monotonicWatchdogDeadline: null,
        bootId: null,
        monotonicGrantedAtMs: null,
        monotonicHardDeadlineMs: null,
        drainStartedAt: null,
        backupSessionId: null,
        generation: 0,
        ttlMonitorDisabled: false,
        ttlDisabledAt: null,
        ttlDisabledByLeaseId: null,
        storageLocked: false,
        storageLockType: null,
        storageLockedAt: null,
        tStartTime: null,
        tEndTime: null,
        lastKnownHealthyState: null,
        recoveryActionRequired: null,
        version: 0
      }
    },
    { upsert: true }
  );
};

/**
 * Concurrency-safe atomic lease acquisition using OCC / atomic MongoDB findOneAndUpdate.
 *
 * Can only acquire if status === 'NORMAL' OR (expiresAt && expiresAt < new Date()) (stale lease auto-recovery).
 *
 * @param {object} [options={}]
 * @param {string} [options.owner]
 * @param {number} [options.leaseDurationMs]
 * @param {number} [options.initialLeaseMs]
 * @param {number} [options.maxWatchdogMs]
 * @param {string} [options.initialStatus]
 * @returns {Promise<object>}
 */
export const acquire = async (options = {}) => {
  const opts = typeof options === 'string' ? { backupSessionId: options } : (options || {});
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return {
      success: false,
      reason: 'DB_DISCONNECTED',
      message: 'Database connection is not ready'
    };
  }

  const now = new Date(Date.now());
  const maxWatchdogCeiling =
    parseInt(process.env.MAX_WATCHDOG_LEASE_MS, 10) ||
    parseInt(process.env.BACKUP_MAX_WATCHDOG_MS, 10) ||
    DEFAULT_MAX_WATCHDOG_MS;

  const rawLeaseDuration =
    Number(opts.leaseDurationMs || opts.initialLeaseMs || opts.initialLeaseDurationMs) ||
    parseInt(process.env.BACKUP_LEASE_DURATION_MS, 10) ||
    parseInt(process.env.INITIAL_LEASE_MS, 10) ||
    DEFAULT_INITIAL_LEASE_MS;

  const leaseDuration = Math.min(rawLeaseDuration, maxWatchdogCeiling);

  const rawMaxWatchdog =
    Number(opts.maxWatchdogMs || opts.maxAllowedWatchdogDurationMs) ||
    parseInt(process.env.BACKUP_MAX_WATCHDOG_MS, 10) ||
    parseInt(process.env.MAX_WATCHDOG_LEASE_MS, 10) ||
    DEFAULT_MAX_WATCHDOG_MS;

  const maxWatchdog = Math.min(Math.max(leaseDuration, rawMaxWatchdog), maxWatchdogCeiling);

  const targetStatus =
    opts.initialStatus === BACKUP_LEASE_STATUS.QUIESCED
      ? BACKUP_LEASE_STATUS.QUIESCED
      : BACKUP_LEASE_STATUS.DRAINING;

  const expiresAt = new Date(now.getTime() + leaseDuration);
  const hardDeadline = new Date(now.getTime() + maxWatchdog);
  const leaseId = uuidv4();
  const currentBootId = getSystemBootId();
  const currentHostMonoMs = getHostMonotonicMs();
  const monotonicHardDeadlineMs = currentHostMonoMs + maxWatchdog;

  // Ensure singleton document exists first
  await ensureSingletonExists();

  // Multi-Instance Safety Check (F5 & Invariant INV-8 / INV-9)
  const InstanceLease =
    mongoose.models.InstanceLease ||
    (mongoose.modelNames().includes('InstanceLease') ? mongoose.model('InstanceLease') : null);

  if (InstanceLease) {
    try {
      const activeInstances = await InstanceLease.countDocuments({
        status: 'ACTIVE',
        expiresAt: { $gt: now }
      });
      if (activeInstances > 1) {
        logger.warn('Quiescence acquire rejected: multiple active instances detected', {
          event: 'quiescence.multiple_instances_detected',
          activeInstances
        });
        return {
          success: false,
          reason: 'MULTIPLE_INSTANCES_ACTIVE',
          message: `Quiescence requires a single active application instance, found ${activeInstances} active instances`
        };
      }
    } catch (instErr) {
      // Invariant INV-9: Database uncertainty during safety verification fails closed
      logger.error('Quiescence acquire failed: error during single-instance verification', {
        event: 'quiescence.instance_check_error',
        error: instErr.message
      });
      return {
        success: false,
        reason: 'INSTANCE_CHECK_FAILED',
        message: `Database error during single-instance verification: ${instErr.message}`
      };
    }
  }

  // RECOVERY_REQUIRED Guard: Reject acquire if previous drain failed or watchdog expired
  const currentLeaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
  if (currentLeaseDoc && currentLeaseDoc.status === BACKUP_LEASE_STATUS.RECOVERY_REQUIRED) {
    return {
      success: false,
      reason: 'RECOVERY_REQUIRED',
      message: 'System is in RECOVERY_REQUIRED status; explicit recovery must be completed before acquiring a new lease',
      drainFailureReason: currentLeaseDoc.drainFailureReason,
      drainFailureAt: currentLeaseDoc.drainFailureAt
    };
  }

  const query = {
    _id: BACKUP_LEASE_SINGLETON_ID,
    status: { $ne: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED },
    $or: [
      { status: BACKUP_LEASE_STATUS.NORMAL },
      { expiresAt: { $ne: null, $lt: now } },
      { hardDeadline: { $ne: null, $lte: now } },
      { monotonicWatchdogDeadline: { $ne: null, $lte: now } }
    ]
  };

  const update = {
    $set: {
      status: targetStatus,
      leaseId,
      owner: options.owner || null,
      grantedAt: now,
      expiresAt,
      lastHeartbeatAt: now,
      hardDeadline,
      monotonicWatchdogDeadline: hardDeadline,
      bootId: currentBootId,
      monotonicGrantedAtMs: currentHostMonoMs,
      monotonicHardDeadlineMs,
      drainStartedAt: now
    },
    $inc: { version: 1 }
  };

  const acquired = await BackupLease.findOneAndUpdate(query, update, { new: true });

  if (!acquired) {
    const currentLease = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    logger.warn('Failed to acquire backup lease: concurrent lease active', {
      event: 'quiescence.acquire_rejected',
      activeLeaseId: currentLease?.leaseId,
      activeStatus: currentLease?.status,
      expiresAt: currentLease?.expiresAt
    });

    const activeHardDeadline = resolveHardDeadline(currentLease);

    return {
      success: false,
      reason: 'CONCURRENT_LEASE_ACTIVE',
      message: 'A concurrent backup lease is currently active',
      currentLease: currentLease
        ? {
            leaseId: currentLease.leaseId,
            owner: currentLease.owner,
            status: currentLease.status,
            expiresAt: currentLease.expiresAt,
            hardDeadline: activeHardDeadline,
            monotonicWatchdogDeadline: activeHardDeadline,
            bootId: currentLease.bootId,
            monotonicGrantedAtMs: currentLease.monotonicGrantedAtMs,
            monotonicHardDeadlineMs: currentLease.monotonicHardDeadlineMs,
            grantedAt: currentLease.grantedAt
          }
        : null
    };
  }

  // Set in-process monotonic watchdog
  setMonotonicWatchdog(acquired.leaseId, maxWatchdog);
  await syncAdmissionState(acquired.status);

  logger.info('Acquired backup lease successfully', {
    event: 'quiescence.acquired',
    leaseId: acquired.leaseId,
    status: acquired.status,
    owner: acquired.owner,
    expiresAt: acquired.expiresAt,
    hardDeadline: acquired.hardDeadline,
    bootId: acquired.bootId,
    monotonicHardDeadlineMs: acquired.monotonicHardDeadlineMs
  });

  const returnedHardDeadline = resolveHardDeadline(acquired);

  return {
    success: true,
    leaseId: acquired.leaseId,
    status: acquired.status,
    owner: acquired.owner,
    grantedAt: acquired.grantedAt,
    expiresAt: acquired.expiresAt,
    lastHeartbeatAt: acquired.lastHeartbeatAt,
    hardDeadline: returnedHardDeadline,
    monotonicWatchdogDeadline: returnedHardDeadline,
    bootId: acquired.bootId,
    monotonicGrantedAtMs: acquired.monotonicGrantedAtMs,
    monotonicHardDeadlineMs: acquired.monotonicHardDeadlineMs,
    drainStartedAt: acquired.drainStartedAt,
    version: acquired.version
  };
};

/**
 * Concurrency-safe atomic heartbeat renewal.
 *
 * Extends expiresAt = min(now + heartbeatExtendMs, hardDeadline).
 * Clamped by both durable hardDeadline and in-process monotonic elapsed time.
 * Atomic predicate: { _id: 'singleton', leaseId, status: { $in: ['QUIESCED', 'DRAINING'] }, expiresAt: { $gte: now } }.
 * Rejects if leaseId does not match, lease has expired, or watchdog deadline exceeded.
 *
 * @param {object} options
 * @param {string} options.leaseId
 * @param {number} [options.heartbeatExtendMs]
 * @returns {Promise<object>}
 */
export const heartbeat = async ({ leaseId, heartbeatExtendMs } = {}) => {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return {
      success: false,
      reason: 'DB_DISCONNECTED',
      message: 'Database connection is not ready'
    };
  }

  if (!leaseId || typeof leaseId !== 'string' || !leaseId.trim()) {
    return {
      success: false,
      reason: 'INVALID_LEASE_ID',
      message: 'leaseId is required and must be a non-empty string for heartbeat renewal'
    };
  }

  const now = new Date(Date.now());
  const extendMs =
    Number(heartbeatExtendMs) ||
    parseInt(process.env.BACKUP_HEARTBEAT_EXTEND_MS, 10) ||
    DEFAULT_HEARTBEAT_EXTEND_MS;

  // 1. Inspect current state for accurate diagnostic rejection
  const current = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
  if (!current || current.leaseId !== leaseId) {
    return {
      success: false,
      reason: 'LEASE_NOT_FOUND_OR_MISMATCH',
      message: 'Lease ID does not match active lease or lease does not exist'
    };
  }

  if (
    current.status !== BACKUP_LEASE_STATUS.DRAINING &&
    current.status !== BACKUP_LEASE_STATUS.QUIESCED
  ) {
    return {
      success: false,
      reason: 'INVALID_STATUS',
      message: `Cannot renew heartbeat for lease in status: ${current.status}`
    };
  }

  const hardDeadline = resolveHardDeadline(current);
  const currentBootId = getSystemBootId();
  const currentHostMonoMs = getHostMonotonicMs();

  // Host reboot check
  if (current.bootId && current.bootId !== currentBootId) {
    return {
      success: false,
      reason: 'HOST_REBOOT_DETECTED',
      message: 'Host rebooted during active lease; heartbeat rejected'
    };
  }

  // Host monotonic hard ceiling check
  if (
    current.bootId &&
    current.bootId === currentBootId &&
    typeof current.monotonicHardDeadlineMs === 'number'
  ) {
    if (currentHostMonoMs >= current.monotonicHardDeadlineMs) {
      return {
        success: false,
        reason: 'WATCHDOG_DEADLINE_EXCEEDED',
        message: 'Host monotonic watchdog ceiling exceeded; lease cannot be renewed'
      };
    }
  }

  // Wall clock rollback check
  if (current.grantedAt && now.getTime() < new Date(current.grantedAt).getTime()) {
    return {
      success: false,
      reason: 'CLOCK_ROLLBACK_DETECTED',
      message: 'Wall clock shifted backwards before lease grant time; renewal rejected'
    };
  }

  // Check wall-clock hard deadline ceiling
  if (hardDeadline && now >= hardDeadline) {
    return {
      success: false,
      reason: 'WATCHDOG_DEADLINE_EXCEEDED',
      message: 'Monotonic watchdog deadline exceeded; lease cannot be renewed'
    };
  }

  // Check in-process monotonic watchdog deadline
  if (isMonotonicWatchdogExpired(leaseId)) {
    return {
      success: false,
      reason: 'WATCHDOG_DEADLINE_EXCEEDED',
      message: 'Monotonic watchdog deadline exceeded; lease cannot be renewed'
    };
  }

  if (!current.expiresAt || current.expiresAt < now) {
    return {
      success: false,
      reason: 'LEASE_EXPIRED',
      message: 'Lease has already expired'
    };
  }

  // Calculate new expiresAt clamped by hardDeadline AND in-process monotonic remaining time
  const candidateExpiry = new Date(now.getTime() + extendMs);
  let ceilingTimeMs = hardDeadline ? hardDeadline.getTime() : candidateExpiry.getTime();

  // Guard against backward clock adjustments: also clamp by remaining monotonic duration from now
  const monotonicRemaining = getMonotonicRemainingMs(leaseId);
  if (Number.isFinite(monotonicRemaining)) {
    const monotonicCeilingMs = now.getTime() + monotonicRemaining;
    if (monotonicCeilingMs < ceilingTimeMs - 10) {
      ceilingTimeMs = monotonicCeilingMs;
    }
  }

  // Also clamp by host monotonic remaining time if same boot
  if (
    current.bootId &&
    current.bootId === currentBootId &&
    typeof current.monotonicHardDeadlineMs === 'number'
  ) {
    const hostMonoRemaining = Math.max(0, current.monotonicHardDeadlineMs - currentHostMonoMs);
    const hostMonoCeilingMs = now.getTime() + hostMonoRemaining;
    if (hostMonoCeilingMs < ceilingTimeMs - 10) {
      ceilingTimeMs = hostMonoCeilingMs;
    }
  }

  const newExpiresAtMs = Math.min(candidateExpiry.getTime(), ceilingTimeMs);
  const newExpiresAt = new Date(newExpiresAtMs);

  if (newExpiresAt <= now) {
    return {
      success: false,
      reason: 'WATCHDOG_DEADLINE_EXCEEDED',
      message: 'Monotonic watchdog deadline exceeded; renewal would not extend into the future'
    };
  }

  // 2. Perform atomic update with full predicate
  const query = {
    _id: BACKUP_LEASE_SINGLETON_ID,
    leaseId,
    status: { $in: [BACKUP_LEASE_STATUS.DRAINING, BACKUP_LEASE_STATUS.QUIESCED] },
    expiresAt: { $gte: now }
  };

  const update = {
    $set: {
      expiresAt: newExpiresAt,
      lastHeartbeatAt: now
    },
    $inc: { version: 1 }
  };

  const updated = await BackupLease.findOneAndUpdate(query, update, { new: true });
  if (!updated) {
    return {
      success: false,
      reason: 'LEASE_EXPIRED_OR_INVALID',
      message:
        'Lease expired, modified concurrently, or watchdog deadline exceeded during heartbeat update'
    };
  }

  const returnedHardDeadline = resolveHardDeadline(updated);

  return {
    success: true,
    leaseId: updated.leaseId,
    status: updated.status,
    expiresAt: updated.expiresAt,
    lastHeartbeatAt: updated.lastHeartbeatAt,
    hardDeadline: returnedHardDeadline,
    monotonicWatchdogDeadline: returnedHardDeadline,
    bootId: updated.bootId,
    monotonicHardDeadlineMs: updated.monotonicHardDeadlineMs,
    version: updated.version
  };
};

/**
 * Concurrency-safe atomic lease release.
 *
 * Atomic predicate: { _id: 'singleton', leaseId }.
 * Resets status to 'NORMAL', clears leaseId, expiresAt, owner, hardDeadline, etc.
 * Verifies whether the lease was already expired prior to release and alerts the caller.
 *
 * @param {object} options
 * @param {string} options.leaseId
 * @returns {Promise<object>}
 */
export const release = async (options = {}) => {
  const leaseId = typeof options === 'string' ? options : options?.leaseId;
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return {
      success: false,
      reason: 'DB_DISCONNECTED',
      message: 'Database connection is not ready'
    };
  }

  if (!leaseId || typeof leaseId !== 'string' || !leaseId.trim()) {
    return {
      success: false,
      reason: 'INVALID_LEASE_ID',
      message: 'leaseId is required and must be a non-empty string for lease release'
    };
  }

  const current = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
  if (!current || current.leaseId !== leaseId) {
    return {
      success: false,
      reason: 'LEASE_NOT_FOUND_OR_MISMATCH',
      message: 'No active lease matching provided leaseId found to release'
    };
  }

  // Fail-closed recovery guard: RECOVERY_REQUIRED status cannot be released without explicit verified recovery
  if (current.status === BACKUP_LEASE_STATUS.RECOVERY_REQUIRED) {
    if (!options.forceRecovery) {
      return {
        success: false,
        reason: 'RECOVERY_REQUIRED',
        message: 'Cannot release lease in RECOVERY_REQUIRED status without verified recovery'
      };
    }
    // Invariant INV-3: forceRecovery flag cannot bypass safety verification; routes to strict recovery
    return await recoverFromDrainFailure({ operator: options.operator || current.owner });
  }

  const now = new Date(Date.now());
  const hardDeadline = resolveHardDeadline(current);
  const currentBootId = getSystemBootId();
  const currentHostMonoMs = getHostMonotonicMs();

  const isExpired = Boolean(
    (current.expiresAt && current.expiresAt < now) ||
    (hardDeadline && hardDeadline <= now) ||
    (current.bootId && current.bootId !== currentBootId) ||
    (current.bootId === currentBootId && typeof current.monotonicHardDeadlineMs === 'number' && currentHostMonoMs >= current.monotonicHardDeadlineMs) ||
    (current.grantedAt && now.getTime() < new Date(current.grantedAt).getTime()) ||
    isMonotonicWatchdogExpired(leaseId)
  );

  const query = {
    _id: BACKUP_LEASE_SINGLETON_ID,
    leaseId
  };

  const update = {
    $set: {
      status: BACKUP_LEASE_STATUS.NORMAL,
      leaseId: null,
      owner: null,
      grantedAt: null,
      expiresAt: null,
      lastHeartbeatAt: null,
      hardDeadline: null,
      monotonicWatchdogDeadline: null,
      bootId: null,
      monotonicGrantedAtMs: null,
      monotonicHardDeadlineMs: null,
      drainStartedAt: null,
      ttlMonitorDisabled: false,
      ttlDisabledAt: null,
      ttlDisabledByLeaseId: null,
      storageLocked: false,
      lastKnownHealthyState: null,
      recoveryActionRequired: null,
      drainFailureReason: null,
      drainFailureAt: null,
      drainDiagnostics: null
    },
    $inc: { version: 1 }
  };

  const updated = await BackupLease.findOneAndUpdate(query, update, { new: true });
  if (!updated) {
    return {
      success: false,
      reason: 'LEASE_NOT_FOUND_OR_MISMATCH',
      message: 'No active lease matching provided leaseId found to release'
    };
  }

  // Safely restore MongoDB TTLMonitor on return to NORMAL status (honoring PAPERLESS_DISABLE_TTL_MONITOR)
  await applyTtlMonitorState(true);

  clearMonotonicWatchdog();
  await syncAdmissionState(BACKUP_LEASE_STATUS.NORMAL);

  // Restart reconciliation scheduler on return to NORMAL status (WP-B)
  try {
    const { getReconciliationScheduler } = await import('./reconciliationScheduler.js');
    const scheduler = getReconciliationScheduler();
    if (scheduler && typeof scheduler.start === 'function') {
      await scheduler.start();
    }
  } catch (schedErr) {
    logger.warn('quiescence.scheduler_restart_failed_on_release', { error: schedErr.message });
  }

  if (isExpired) {
    logger.warn('Released expired backup lease; quiescence was breached prior to release', {
      event: 'quiescence.released_expired',
      leaseId
    });
    return {
      success: false,
      wasExpired: true,
      reason: 'LEASE_EXPIRED',
      status: BACKUP_LEASE_STATUS.NORMAL,
      message: 'Backup lease expired before release was invoked; snapshot may not be quiescent',
      version: updated.version
    };
  }

  logger.info('Released backup lease successfully', {
    event: 'quiescence.released',
    leaseId
  });

  return {
    success: true,
    status: BACKUP_LEASE_STATUS.NORMAL,
    message: 'Backup lease released successfully',
    version: updated.version
  };
};

/**
 * Explicit, validated recovery from RECOVERY_REQUIRED status.
 * Re-verifies that:
 * 1. Process-local in-flight mutations === 0.
 * 2. Active tracked operations === 0.
 * 3. Durable datastore drain is verified across all 9 business mutation domains.
 * If verified (or options.force === true), resets the BackupLease singleton to NORMAL,
 * restores TTLMonitor, calls syncAdmissionState(NORMAL), and restarts reconciliationScheduler.
 *
 * @param {object} [options={}]
 * @param {boolean} [options.force=false]
 * @param {string} [options.operator='system']
 * @returns {Promise<object>}
 */
export const recoverFromDrainFailure = async (options = {}) => {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return {
      success: false,
      reason: 'DB_DISCONNECTED',
      message: 'Database connection is not ready'
    };
  }

  const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);
  if (!doc) {
    return {
      success: false,
      reason: 'LEASE_NOT_FOUND',
      message: 'Backup lease singleton not found'
    };
  }

  if (doc.status !== BACKUP_LEASE_STATUS.RECOVERY_REQUIRED && doc.status !== BACKUP_LEASE_STATUS.DRAINING) {
    return {
      success: false,
      reason: 'NOT_IN_RECOVERY',
      message: `Cannot recover: current status is ${doc.status}`
    };
  }

  // Invariant INV-3: force flags cannot bypass safety verification (F1 remediation)
  if (options.force) {
    logger.warn('quiescence.recover_force_flag_ignored', {
      event: 'quiescence.force_bypass_denied',
      reason: 'Safety verification cannot be bypassed'
    });
  }

  // 1. Check in-flight mutations
  const gateMod = await import('../middleware/quiescenceGate.js');
  const inFlight = typeof gateMod.getInFlightMutationCount === 'function' ? gateMod.getInFlightMutationCount() : 0;
  const activeOps = typeof gateMod.getActiveOperationCount === 'function' ? gateMod.getActiveOperationCount() : 0;
  if (inFlight > 0 || activeOps > 0) {
    return {
      success: false,
      reason: 'OPERATIONS_STILL_ACTIVE',
      message: `Cannot recover: in-flight mutations (${inFlight}) or active operations (${activeOps}) still active`
    };
  }

  // 2. Check durable datastore drain
  const durableRes = await checkDurableDatastoreDrain({ strict: true });
  if (!durableRes.isDrained) {
    return {
      success: false,
      reason: durableRes.reason || 'DATASTORE_NOT_DRAINED',
      message: 'Cannot recover: durable datastore mutations are still active',
      diagnostics: durableRes.diagnostics
    };
  }

  // 3. Check scheduler lifecycle: ensure scheduler is stopped and no batch is running
  try {
    const { getReconciliationScheduler } = await import('./reconciliationScheduler.js');
    const scheduler = getReconciliationScheduler();
    if (scheduler && (scheduler.state !== 'STOPPED' || scheduler.isRunningBatch)) {
      return {
        success: false,
        reason: 'SCHEDULER_STILL_ACTIVE',
        message: `Cannot recover: reconciliation scheduler is still active (state: ${scheduler.state}, isRunningBatch: ${scheduler.isRunningBatch})`
      };
    }
  } catch (schedErr) {
    // Dynamic import error in unit mocks
  }

  // Atomically reset to NORMAL
  const updated = await BackupLease.findOneAndUpdate(
    {
      _id: BACKUP_LEASE_SINGLETON_ID,
      version: doc.version
    },
    {
      $set: {
        status: BACKUP_LEASE_STATUS.NORMAL,
        leaseId: null,
        owner: null,
        grantedAt: null,
        expiresAt: null,
        lastHeartbeatAt: null,
        hardDeadline: null,
        monotonicWatchdogDeadline: null,
        bootId: null,
        monotonicGrantedAtMs: null,
        monotonicHardDeadlineMs: null,
        drainStartedAt: null,
        ttlMonitorDisabled: false,
        ttlDisabledAt: null,
        ttlDisabledByLeaseId: null,
        storageLocked: false,
        lastKnownHealthyState: null,
        recoveryActionRequired: null,
        drainFailureReason: null,
        drainFailureAt: null,
        drainDiagnostics: null
      },
      $inc: { version: 1 }
    },
    { new: true }
  );

  if (!updated) {
    return {
      success: false,
      reason: 'VERSION_CONFLICT',
      message: 'Concurrent modification during recovery attempt'
    };
  }

  // Restore TTL monitor (honoring PAPERLESS_DISABLE_TTL_MONITOR)
  await applyTtlMonitorState(true);

  clearMonotonicWatchdog();
  await syncAdmissionState(BACKUP_LEASE_STATUS.NORMAL);

  // Restart reconciliation scheduler
  try {
    const { getReconciliationScheduler } = await import('./reconciliationScheduler.js');
    const scheduler = getReconciliationScheduler();
    if (scheduler && typeof scheduler.start === 'function') {
      await scheduler.start();
    }
  } catch (schedErr) {
    logger.warn('quiescence.scheduler_restart_failed_on_recovery', { error: schedErr.message });
  }

  logger.info('Explicit recovery from drain failure completed successfully', {
    event: 'quiescence.recovered',
    version: updated.version,
    operator: options.operator || 'system'
  });

  return {
    success: true,
    status: BACKUP_LEASE_STATUS.NORMAL,
    version: updated.version,
    message: 'Explicit recovery completed; admission reopened to NORMAL'
  };
};

/**
 * Authoritative 9-domain datastore drain verification.
 * Inspects database collections and engine status directly, surviving process restarts.
 *
 * @param {object} [options={}]
 * @param {boolean} [options.strict] Whether to enforce strict transaction drain verification
 * @param {number} [options.commandTimeoutMs=5000] Timeout for MongoDB admin commands
 * @returns {Promise<{ isDrained: boolean, diagnostics: object, reason?: string, error?: string }>}
 */
export const checkDurableDatastoreDrain = async (options = {}) => {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return {
      isDrained: false,
      reason: 'DB_DISCONNECTED',
      diagnostics: { error: 'Database connection is not ready' }
    };
  }

  const isStrict =
    options?.strict === true ||
    process.env.STRICT_QUIESCENCE_MODE === 'true' ||
    process.env.STRICT_TRANSACTION_CHECK_REQUIRED === 'true' ||
    process.env.NODE_ENV === 'production';

  const now = new Date();
  const db = mongoose.connection.db;
  const diagnostics = {
    activeReservations: 0,
    quarantinedReservations: 0,
    pendingCleanupReservations: 0,
    deletingForms: 0,
    reorderingForms: 0,
    activeCleanupJobs: 0,
    activeTransactions: 0,
    inProcessActiveTransactions: 0,
    transactionCheckStatus: 'SKIPPED',
    transactionCheckError: null,
    transactionDrainVerified: false,
    physicalBackupAuthorized: false,
    activeWorkers: 0,
    activeStorageOperations: 0,
    storageDetails: {
      dispatched: 0,
      confirmed: 0,
      quarantined: 0,
      reconciling: 0,
      pendingReconcile: 0
    }
  };

  try {
    // 1. Submission Reservations: active, committing, quarantined, or pending staging cleanup
    const reservationColl = db.collection('submissionreservations');
    const [activeRes, quarantinedRes, pendingCleanupRes, uncleanedStagingRes] = await Promise.all([
      reservationColl.countDocuments({ status: { $in: ['active', 'committing'] } }),
      reservationColl.countDocuments({ quarantinedUntil: { $gt: now } }),
      reservationColl.countDocuments({ stagingCleanupStatus: { $in: ['pending', 'cleaning'] } }),
      reservationColl.countDocuments({
        stagedKeys: { $exists: true, $not: { $size: 0 } },
        stagingCleanupStatus: { $ne: 'completed' }
      })
    ]);
    diagnostics.activeReservations = activeRes;
    diagnostics.quarantinedReservations = quarantinedRes;
    diagnostics.pendingCleanupReservations = Math.max(pendingCleanupRes, uncleanedStagingRes);

    // 2. Cascading Form Deletions & Question Reordering
    const formColl = db.collection('forms');
    const [deletingForms, reorderingForms] = await Promise.all([
      formColl.countDocuments({ status: { $in: ['deleting', 'delete_failed'] } }),
      formColl.countDocuments({ 'reorderState.inProgress': true })
    ]);
    diagnostics.deletingForms = deletingForms;
    diagnostics.reorderingForms = reorderingForms;

    // 3. Post-Cascade Cleanup Jobs: cleaning or pending
    const cleanupColl = db.collection('deletioncleanupjobs');
    const cleanupJobs = await cleanupColl.countDocuments({ status: { $in: ['cleaning', 'pending'] } });
    diagnostics.activeCleanupJobs = cleanupJobs;

    // 4. Background Workers: Durable app_workers collection check + in-memory tasks
    const workerColl = db.collection('app_workers');
    const activeWorkers = await workerColl.countDocuments({
      $or: [
        {
          status: { $in: ['STARTING', 'ACTIVE', 'DRAINING', 'RECOVERY_REQUIRED'] },
          heartbeatExpiresAt: { $gt: now }
        },
        {
          activeClaimCount: { $gt: 0 },
          heartbeatExpiresAt: { $gt: now }
        }
      ]
    });
    let inMemoryWorkers = 0;
    try {
      const workerMod = await import('./workerCoordinationService.js');
      if (typeof workerMod.getActiveWorkerTaskCount === 'function') {
        inMemoryWorkers = workerMod.getActiveWorkerTaskCount();
      }
    } catch {
      // Dynamic import fallback
    }
    diagnostics.activeWorkers = activeWorkers + inMemoryWorkers;

    // 5. Storage Operations Journal: All non-terminal states
    const storageColl = db.collection('storage_operations');
    const [
      activeStorage,
      dispatchedOps,
      confirmedOps,
      quarantinedOps,
      reconcilingOps,
      pendingReconcileOps
    ] = await Promise.all([
      storageColl.countDocuments({
        status: { $in: ['PENDING', 'CREATED', 'DISPATCHED', 'CONFIRMED', 'RECONCILING', 'AMBIGUOUS'] }
      }),
      storageColl.countDocuments({ status: { $in: ['PENDING', 'CREATED', 'DISPATCHED'] } }),
      storageColl.countDocuments({ status: 'CONFIRMED' }),
      storageColl.countDocuments({ status: 'AMBIGUOUS', quarantinedUntil: { $gt: now } }),
      storageColl.countDocuments({ status: 'RECONCILING', lockedUntil: { $gt: now } }),
      storageColl.countDocuments({
        status: 'AMBIGUOUS',
        $or: [{ quarantinedUntil: null }, { quarantinedUntil: { $lte: now } }]
      })
    ]);
    diagnostics.activeStorageOperations = activeStorage;
    diagnostics.unresolvedStorageOperations = activeStorage;
    diagnostics.storageDetails.dispatched = dispatchedOps;
    diagnostics.storageDetails.confirmed = confirmedOps;
    diagnostics.storageDetails.quarantined = quarantinedOps;
    diagnostics.storageDetails.reconciling = reconcilingOps;
    diagnostics.storageDetails.pendingReconcile = pendingReconcileOps;

    // 6. Active WiredTiger multi-document transactions via currentOp and in-process tracker
    const inProcessTx = typeof getInFlightTransactionCount === 'function' ? getInFlightTransactionCount() : 0;
    diagnostics.inProcessActiveTransactions = inProcessTx;

    const commandTimeoutMs = options?.commandTimeoutMs || 5000;
    try {
      const adminDb = db.admin();
      const currentOp = await adminDb.command(
        { currentOp: 1, activeTransaction: true },
        { maxTimeMS: commandTimeoutMs }
      );
      if (Array.isArray(currentOp?.inprog)) {
        const userTx = currentOp.inprog.filter((op) => {
          const ns = op.ns || '';
          return (
            !ns.startsWith('local.') &&
            !ns.startsWith('admin.') &&
            !ns.startsWith('config.')
          );
        });
        diagnostics.activeTransactions = userTx.length;
        diagnostics.transactionCheckStatus = 'VERIFIED';
        diagnostics.transactionCheckError = null;
        if (userTx.length === 0 && inProcessTx === 0) {
          diagnostics.transactionDrainVerified = true;
          diagnostics.physicalBackupAuthorized = true;
        } else {
          diagnostics.transactionDrainVerified = false;
          diagnostics.physicalBackupAuthorized = false;
        }
      } else {
        diagnostics.transactionCheckStatus = 'INCONCLUSIVE';
        diagnostics.transactionDrainVerified = false;
        diagnostics.physicalBackupAuthorized = false;
      }
    } catch (txErr) {
      let errType = 'ERROR';
      const msg = txErr?.message || '';
      const code = txErr?.code;
      if (code === 13 || txErr?.codeName === 'Unauthorized' || /not authorized|requires.*privilege|unauthorized/i.test(msg)) {
        errType = 'UNAUTHORIZED';
      } else if (code === 50 || txErr?.codeName === 'MaxTimeMSExpired' || /timed? ?out|exceeded.*limit/i.test(msg)) {
        errType = 'TIMEOUT';
      } else if (txErr?.name === 'MongoNetworkError' || /topology was destroyed|connection closed|socket/i.test(msg)) {
        errType = 'CONNECTIVITY_ERROR';
      } else if (code === 59 || txErr?.codeName === 'CommandNotFound' || /no such (cmd|command)|not supported/i.test(msg)) {
        errType = 'MOCK_UNSUPPORTED';
      }

      diagnostics.transactionCheckStatus = errType;
      diagnostics.transactionCheckError = {
        name: txErr?.name,
        message: txErr?.message,
        code: txErr?.code,
        codeName: txErr?.codeName,
        type: errType
      };
      diagnostics.transactionDrainVerified = false;
      diagnostics.physicalBackupAuthorized = false;

      logger.warn('quiescence.transaction_drain_check_failed', {
        event: 'quiescence.transaction_drain_check_failed',
        errorType: errType,
        message: txErr?.message,
        isStrict
      });

      // Fail closed across ALL modes for network or timeout issues during currentOp
      if (errType === 'CONNECTIVITY_ERROR' || errType === 'TIMEOUT') {
        return {
          isDrained: false,
          reason: 'DATASTORE_QUERY_FAILED',
          error: txErr.message,
          diagnostics
        };
      }

      // In strict mode (production or explicit strict), UNAUTHORIZED, MOCK_UNSUPPORTED or generic ERROR fail closed
      if (isStrict) {
        return {
          isDrained: false,
          reason: 'TRANSACTION_DRAIN_UNVERIFIED',
          error: `Multi-document transaction drain verification failed (${errType}): ${txErr.message}`,
          diagnostics
        };
      }
    }
  } catch (err) {
    logger.error('quiescence.datastore_drain_check_failed', {
      event: 'quiescence.drain_check_error',
      error: err.message,
      stack: err.stack
    });
    // Fail-closed: Never report drained if database inspection encounters an error!
    return {
      isDrained: false,
      reason: 'DATASTORE_QUERY_FAILED',
      error: err.message,
      diagnostics: {
        ...diagnostics,
        error: err.message
      }
    };
  }

  const businessDomainsClear =
    diagnostics.activeReservations === 0 &&
    diagnostics.quarantinedReservations === 0 &&
    diagnostics.pendingCleanupReservations === 0 &&
    diagnostics.deletingForms === 0 &&
    diagnostics.reorderingForms === 0 &&
    diagnostics.activeCleanupJobs === 0 &&
    diagnostics.activeWorkers === 0 &&
    diagnostics.activeStorageOperations === 0;

  const txClear = diagnostics.activeTransactions === 0 && diagnostics.inProcessActiveTransactions === 0;

  let isDrained = false;
  let reason;

  if (isStrict) {
    isDrained = businessDomainsClear && txClear && diagnostics.transactionDrainVerified === true;
    if (!isDrained) {
      if (diagnostics.transactionCheckStatus !== 'VERIFIED') {
        reason = 'TRANSACTION_DRAIN_UNVERIFIED';
      } else {
        reason = 'DRAIN_PENDING';
      }
    }
  } else {
    isDrained = businessDomainsClear && txClear;
    if (!isDrained) {
      reason = 'DRAIN_PENDING';
    }
  }

  return {
    isDrained,
    reason,
    diagnostics
  };
};

/**
 * Transitions an active lease in DRAINING status to QUIESCED status.
 *
 * BLK-02 GUARANTEE:
 * When enforceDrain is true (default), this method verifies that all in-flight HTTP mutations,
 * active business operations, and background worker tasks have drained before writing
 * QUIESCED to the datastore. If operations are still active and do not drain within
 * drainTimeoutMs, the transition is refused with DRAIN_PENDING.
 *
 * @param {object} options
 * @param {string} options.leaseId
 * @param {boolean} [options.enforceDrain=true]
 * @param {number} [options.drainTimeoutMs=15000]
 * @returns {Promise<object>}
 */
export const markQuiesced = async (options = {}) => {
  const leaseId = typeof options === 'string' ? options : options?.leaseId;
  const enforceDrain =
    typeof options === 'object' && options !== null && 'enforceDrain' in options
      ? options.enforceDrain
      : true;
  const drainTimeoutMs =
    typeof options === 'object' && options?.drainTimeoutMs ? options.drainTimeoutMs : 15000;
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return {
      success: false,
      reason: 'DB_DISCONNECTED',
      message: 'Database connection is not ready'
    };
  }

  if (!leaseId) {
    return {
      success: false,
      reason: 'INVALID_LEASE_ID',
      message: 'leaseId is required to transition to QUIESCED'
    };
  }

  if (isMonotonicWatchdogExpired(leaseId)) {
    return {
      success: false,
      reason: 'LEASE_NOT_FOUND_OR_EXPIRED',
      message: 'Monotonic watchdog deadline exceeded; cannot mark QUIESCED'
    };
  }

  // BLK-02: Enforce drain completion before transitioning to QUIESCED in datastore
  if (enforceDrain) {
    let isDrained = true;
    try {
      const gateMod = await import('../middleware/quiescenceGate.js');
      const workerMod = await import('./workerCoordinationService.js');
      const inFlightMutations = typeof gateMod.getInFlightMutationCount === 'function' ? gateMod.getInFlightMutationCount() : 0;
      const activeOps = typeof gateMod.getActiveOperationCount === 'function' ? gateMod.getActiveOperationCount() : 0;
      const activeWorkers = typeof workerMod.getActiveWorkerTaskCount === 'function' ? workerMod.getActiveWorkerTaskCount() : 0;
      if (inFlightMutations > 0 || activeOps > 0 || activeWorkers > 0) {
        isDrained = false;
      }
    } catch {
      // Dynamic import failure in unit mocks
    }

    if (!isDrained) {
      const { drainInFlight: gateDrainInFlight } = await import('../middleware/quiescenceGate.js');
      const drained = await gateDrainInFlight(drainTimeoutMs);
      if (!drained) {
        return {
          success: false,
          reason: 'DRAIN_PENDING',
          message: 'Cannot transition to QUIESCED: in-flight operations or worker tasks are still active'
        };
      }
    }

    // Verify durable datastore drain across all 9 business mutation domains
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const durableDrain = await checkDurableDatastoreDrain({
        strict: typeof options === 'object' ? options?.strict : false,
        commandTimeoutMs: drainTimeoutMs
      });
      if (!durableDrain.isDrained) {
        return {
          success: false,
          reason: durableDrain.reason || 'DRAIN_PENDING',
          message: durableDrain.reason === 'TRANSACTION_DRAIN_UNVERIFIED'
            ? 'Cannot transition to QUIESCED: multi-document transaction drain could not be verified'
            : 'Cannot transition to QUIESCED: durable datastore mutations are still active',
          diagnostics: durableDrain.diagnostics
        };
      }
    }
  }

  const now = new Date(Date.now());
  const updated = await BackupLease.findOneAndUpdate(
    {
      _id: BACKUP_LEASE_SINGLETON_ID,
      leaseId,
      status: BACKUP_LEASE_STATUS.DRAINING,
      expiresAt: { $gte: now }
    },
    {
      $set: {
        status: BACKUP_LEASE_STATUS.QUIESCED,
        quiescedAt: now,
        ttlMonitorDisabled: true,
        ttlDisabledAt: now,
        ttlDisabledByLeaseId: leaseId
      },
      $inc: { version: 1, generation: 1 }
    },
    { new: true }
  );

  if (!updated) {
    return {
      success: false,
      reason: 'LEASE_NOT_FOUND_OR_EXPIRED',
      message: 'Lease not found, expired, or not in DRAINING status'
    };
  }

  // Dynamic suppression of MongoDB TTL thread during active quiescence to preserve oplog consistency
  let ttlSuppressed = false;
  let ttlError = null;
  try {
    if (mongoose.connection?.db) {
      await mongoose.connection.db.admin().command({ setParameter: 1, ttlMonitorEnabled: false });
      ttlSuppressed = true;
      logger.info('quiescence.ttl_monitor_suppressed', { leaseId });
    }
  } catch (err) {
    ttlError = err.message;
    logger.warn('quiescence.ttl_monitor_suppress_failed', { error: err.message, leaseId });
  }

  if (!ttlSuppressed && process.env.STRICT_TTL_SUPPRESSION_REQUIRED === 'true') {
    // Revert lease to DRAINING if strict suppression is required and failed
    await BackupLease.updateOne(
      { _id: BACKUP_LEASE_SINGLETON_ID, leaseId },
      { $set: { status: BACKUP_LEASE_STATUS.DRAINING, ttlMonitorDisabled: false } }
    );
    return {
      success: false,
      reason: 'TTL_SUPPRESSION_FAILED',
      message: `Strict TTL suppression required but command failed: ${ttlError}`
    };
  }

  // Update lease document with verified TTL suppression status
  if (!ttlSuppressed) {
    await BackupLease.updateOne(
      { _id: BACKUP_LEASE_SINGLETON_ID, leaseId },
      { $set: { ttlMonitorDisabled: false, ttlMonitorError: ttlError } }
    );
  }

  logger.info('Marked backup lease as QUIESCED', {
    event: 'quiescence.quiesced',
    leaseId: updated.leaseId
  });

  await syncAdmissionState(BACKUP_LEASE_STATUS.QUIESCED);

  return {
    success: true,
    status: BACKUP_LEASE_STATUS.QUIESCED,
    leaseId: updated.leaseId,
    version: updated.version
  };
};

/**
 * Returns current durable status, active leaseId, expiry, remaining duration, hardDeadline, watchdog deadline.
 *
 * @returns {Promise<object>}
 */
export const getStatus = async () => {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return {
      success: true,
      status: BACKUP_LEASE_STATUS.NORMAL,
      isExpired: false,
      leaseId: null,
      owner: null,
      grantedAt: null,
      expiresAt: null,
      remainingDurationMs: 0,
      hardDeadline: null,
      monotonicWatchdogDeadline: null,
      bootId: null,
      monotonicHardDeadlineMs: null,
      drainStartedAt: null,
      isQuiesced: false,
      version: 0
    };
  }

  const now = new Date(Date.now());
  const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();

  if (!doc) {
    return {
      success: true,
      status: BACKUP_LEASE_STATUS.NORMAL,
      isExpired: false,
      leaseId: null,
      owner: null,
      grantedAt: null,
      expiresAt: null,
      remainingDurationMs: 0,
      hardDeadline: null,
      monotonicWatchdogDeadline: null,
      bootId: null,
      monotonicHardDeadlineMs: null,
      drainStartedAt: null,
      isQuiesced: false,
      version: 0
    };
  }

  // Fail-closed check: if the persistent lease is currently RECOVERY_REQUIRED, keep it strictly in RECOVERY_REQUIRED
  if (doc.status === BACKUP_LEASE_STATUS.RECOVERY_REQUIRED) {
    let processLocal = {
      inFlightMutations: 0,
      activeHttpMutations: 0,
      standaloneOperations: 0,
      activeDatabaseOperations: 0,
      activeStorageOperations: 0,
      activeOperations: 0,
      unresolvedOperations: 0,
      activeWorkerTasks: 0,
      isDrained: true
    };
    try {
      const gateMod = await import('../middleware/quiescenceGate.js');
      if (typeof gateMod.getOperationalAccountingSnapshot === 'function') {
        processLocal = { ...processLocal, ...gateMod.getOperationalAccountingSnapshot() };
      }
    } catch {
      // Ignore in mock/test environment
    }

    return {
      success: true,
      status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
      rawStatus: doc.status,
      isExpired: false,
      leaseId: doc.leaseId,
      owner: doc.owner,
      grantedAt: doc.grantedAt,
      expiresAt: doc.expiresAt,
      drainFailureReason: doc.drainFailureReason,
      drainFailureAt: doc.drainFailureAt,
      drainDiagnostics: doc.drainDiagnostics,
      drainAttempts: doc.drainAttempts,
      isQuiesced: false,
      isDrained: false,
      version: doc.version,
      durable: {
        status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
        rawStatus: doc.status,
        leaseId: doc.leaseId,
        owner: doc.owner,
        drainFailureReason: doc.drainFailureReason,
        drainFailureAt: doc.drainFailureAt
      },
      processLocal,
      unresolvedOperations: processLocal.unresolvedOperations
    };
  }

  const hardDeadline = resolveHardDeadline(doc);
  const isMonotonicExpired = isMonotonicWatchdogExpired(doc.leaseId);
  const currentBootId = getSystemBootId();
  const currentHostMonoMs = getHostMonotonicMs();

  const isWatchdogExpired = Boolean(
    (hardDeadline && hardDeadline <= now) ||
    (doc.monotonicWatchdogDeadline && doc.monotonicWatchdogDeadline <= now) ||
    (doc.bootId && doc.bootId !== currentBootId) ||
    (doc.bootId === currentBootId && typeof doc.monotonicHardDeadlineMs === 'number' && currentHostMonoMs >= doc.monotonicHardDeadlineMs) ||
    (doc.grantedAt && now.getTime() < new Date(doc.grantedAt).getTime()) ||
    isMonotonicExpired
  );

  const isSoftExpired = Boolean(doc.expiresAt && doc.expiresAt < now);
  const isExpired = Boolean(isWatchdogExpired || isSoftExpired);

  let effectiveStatus = doc.status;
  const isQuiescenceActive =
    doc.status === BACKUP_LEASE_STATUS.DRAINING ||
    doc.status === BACKUP_LEASE_STATUS.QUIESCED;

  if (isQuiescenceActive && isExpired) {
    // Fail-Closed Remediation (Finding F2 & Invariant INV-4):
    // ANY expiration (soft heartbeat expiration or hard watchdog deadline) during DRAINING or QUIESCED
    // MUST transition to RECOVERY_REQUIRED, NEVER NORMAL!
    effectiveStatus = BACKUP_LEASE_STATUS.RECOVERY_REQUIRED;
    const failureReason = isWatchdogExpired
      ? 'WATCHDOG_EXPIRED'
      : 'HEARTBEAT_EXPIRED_BEFORE_HARD_DEADLINE';
    await BackupLease.findOneAndUpdate(
      {
        _id: BACKUP_LEASE_SINGLETON_ID,
        version: doc.version,
        status: { $in: [BACKUP_LEASE_STATUS.DRAINING, BACKUP_LEASE_STATUS.QUIESCED] }
      },
      {
        $set: {
          status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
          lastKnownHealthyState: doc.status,
          recoveryActionRequired: failureReason,
          drainFailureReason: failureReason,
          drainFailureAt: now
        },
        $inc: { version: 1 }
      }
    ).catch(() => {});
    await syncAdmissionState(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED).catch(() => {});
  } else if (doc.status === BACKUP_LEASE_STATUS.NORMAL) {
    effectiveStatus = BACKUP_LEASE_STATUS.NORMAL;
  }

  let remainingDurationMs = 0;
  if (!isExpired && doc.expiresAt && doc.expiresAt > now) {
    const wallRemaining = Math.max(0, doc.expiresAt.getTime() - now.getTime());
    const monotonicRemaining = getMonotonicRemainingMs(doc.leaseId);
    let hostMonoRemaining = Infinity;
    if (doc.bootId === currentBootId && typeof doc.monotonicHardDeadlineMs === 'number') {
      hostMonoRemaining = Math.max(0, doc.monotonicHardDeadlineMs - currentHostMonoMs);
    }
    remainingDurationMs = Math.min(wallRemaining, monotonicRemaining, hostMonoRemaining);
  }

  // BLK-03: Gather real-time process-local operational accounting
  let processLocal = {
    inFlightMutations: 0,
    activeHttpMutations: 0,
    standaloneOperations: 0,
    activeDatabaseOperations: 0,
    activeStorageOperations: 0,
    activeOperations: 0,
    unresolvedOperations: 0,
    activeWorkerTasks: 0,
    isDrained: true
  };

  try {
    const gateMod = await import('../middleware/quiescenceGate.js');
    if (typeof gateMod.getOperationalAccountingSnapshot === 'function') {
      processLocal = { ...processLocal, ...gateMod.getOperationalAccountingSnapshot() };
    }
    const workerMod = await import('./workerCoordinationService.js');
    if (typeof workerMod.getActiveWorkerTaskCount === 'function') {
      processLocal.activeWorkerTasks = workerMod.getActiveWorkerTaskCount();
      if (processLocal.activeWorkerTasks > 0) {
        processLocal.isDrained = false;
      }
    }
  } catch {
    // Dynamic import failure in unit mocks
  }

  const isDrained = processLocal.isDrained;
  const isQuiescedFully = effectiveStatus === BACKUP_LEASE_STATUS.QUIESCED && isDrained;

  const durable = {
    status: effectiveStatus,
    rawStatus: doc.status,
    isExpired,
    leaseId: isExpired ? null : doc.leaseId,
    owner: isExpired ? null : doc.owner,
    grantedAt: doc.grantedAt,
    expiresAt: doc.expiresAt,
    lastHeartbeatAt: doc.lastHeartbeatAt,
    remainingDurationMs,
    hardDeadline,
    monotonicWatchdogDeadline: hardDeadline,
    bootId: doc.bootId,
    monotonicHardDeadlineMs: doc.monotonicHardDeadlineMs,
    drainStartedAt: doc.drainStartedAt,
    version: doc.version
  };

  return {
    success: true,
    status: effectiveStatus,
    rawStatus: doc.status,
    isExpired,
    leaseId: isExpired ? null : doc.leaseId,
    owner: isExpired ? null : doc.owner,
    grantedAt: doc.grantedAt,
    expiresAt: doc.expiresAt,
    lastHeartbeatAt: doc.lastHeartbeatAt,
    remainingDurationMs,
    hardDeadline,
    monotonicWatchdogDeadline: hardDeadline,
    bootId: doc.bootId,
    monotonicHardDeadlineMs: doc.monotonicHardDeadlineMs,
    drainStartedAt: doc.drainStartedAt,
    isQuiesced: isQuiescedFully,
    version: doc.version,
    // BLK-03 Enriched Operational & Durable Diagnostics:
    durable,
    processLocal,
    isDrained,
    unresolvedOperations: processLocal.unresolvedOperations
  };
};

/**
 * Automatic stale recovery & restart initialization.
 * Checks MongoDB on boot.
 * If expired lease, exceeded hardDeadline, or interrupted lifecycle state (ACQUIRING/RELEASING) is present, auto-recovers to 'NORMAL'.
 * If unexpired lease is present (DRAINING/QUIESCED), restores local monotonic tracking clamped to remaining time (hardDeadline - now).
 *
 * @returns {Promise<object>}
 */
export const initialize = async (options = {}) => {
  const env = options.env || process.env;

  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    clearMonotonicWatchdog();
    await syncAdmissionState(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
    return { success: false, reason: 'DB_DISCONNECTED', status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED };
  }

  // Evaluate PAPERLESS_DISABLE_TTL_MONITOR configuration (F4 / Invariant INV-7)
  if (isTtlMonitorDisabledByConfig(env)) {
    try {
      await applyTtlMonitorState(false, { env, strict: true });
    } catch (ttlErr) {
      clearMonotonicWatchdog();
      await syncAdmissionState(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      return {
        success: false,
        reason: 'TTL_MONITOR_COMMAND_FAILED',
        error: ttlErr.message,
        status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED
      };
    }
  }

  await ensureSingletonExists();
  const now = new Date(Date.now());
  const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID);

  if (!doc) {
    clearMonotonicWatchdog();
    await syncAdmissionState(BACKUP_LEASE_STATUS.NORMAL);
    return { success: true, status: BACKUP_LEASE_STATUS.NORMAL, recovered: false };
  }

  if (doc.status === BACKUP_LEASE_STATUS.RECOVERY_REQUIRED) {
    clearMonotonicWatchdog();
    await syncAdmissionState(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
    logger.info('Preserved RECOVERY_REQUIRED backup lease status on startup', {
      event: 'quiescence.recovery_required_preserved',
      leaseId: doc.leaseId,
      drainFailureReason: doc.drainFailureReason,
      drainFailureAt: doc.drainFailureAt
    });
    return {
      success: true,
      recovered: false,
      status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
      previousLeaseId: doc.leaseId,
      version: doc.version
    };
  }

  if (doc.status !== BACKUP_LEASE_STATUS.NORMAL) {
    const hardDeadline = resolveHardDeadline(doc);
    const currentBootId = getSystemBootId();
    const currentHostMonoMs = getHostMonotonicMs();

    // 1. Host reboot check: fail closed to RECOVERY_REQUIRED
    const isHostRebooted = Boolean(doc.bootId && doc.bootId !== currentBootId);

    // 2. Monotonic watchdog deadline check: fail closed to RECOVERY_REQUIRED
    const isHostMonoExhausted = Boolean(
      doc.bootId &&
      doc.bootId === currentBootId &&
      typeof doc.monotonicHardDeadlineMs === 'number' &&
      currentHostMonoMs >= doc.monotonicHardDeadlineMs
    );

    // 3. Wall clock rollback check: fail closed to RECOVERY_REQUIRED
    const isClockRollback = Boolean(
      doc.grantedAt &&
      now.getTime() < new Date(doc.grantedAt).getTime()
    );

    // 4. Interrupted lifecycle states (ACQUIRING / RELEASING)
    const isInterruptedLifecycle =
      doc.status === BACKUP_LEASE_STATUS.ACQUIRING ||
      doc.status === BACKUP_LEASE_STATUS.RELEASING;

    const recoveryReason = isHostRebooted
      ? 'INTERRUPTED_BY_REBOOT'
      : isHostMonoExhausted
      ? 'MONOTONIC_WATCHDOG_EXHAUSTED'
      : isClockRollback
      ? 'CLOCK_ROLLBACK_DETECTED'
      : isInterruptedLifecycle
      ? 'INTERRUPTED_LIFECYCLE'
      : 'INTERRUPTED_DRAIN_ON_STARTUP';

    clearMonotonicWatchdog();
    await syncAdmissionState(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

    // Remediation F3 & Invariant INV-5: Interrupted quiescence states (DRAINING, QUIESCED, ACQUIRING, RELEASING)
    // discovered on startup MUST NOT auto-recover to NORMAL; they transition atomically to RECOVERY_REQUIRED.
    const recovered = await BackupLease.findOneAndUpdate(
      {
        _id: BACKUP_LEASE_SINGLETON_ID,
        version: doc.version,
        status: {
          $in: [
            BACKUP_LEASE_STATUS.DRAINING,
            BACKUP_LEASE_STATUS.QUIESCED,
            BACKUP_LEASE_STATUS.ACQUIRING,
            BACKUP_LEASE_STATUS.RELEASING
          ]
        }
      },
      {
        $set: {
          status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
          lastKnownHealthyState: doc.status,
          recoveryActionRequired: recoveryReason,
          drainFailureReason: recoveryReason,
          drainFailureAt: now,
          drainDiagnostics: {
            interruptedStatus: doc.status,
            interruptedLeaseId: doc.leaseId,
            interruptedOwner: doc.owner,
            interruptedBootId: doc.bootId,
            currentBootId,
            hardDeadline,
            interruptedAt: now,
            drainStartedAt: doc.drainStartedAt,
            isHostRebooted,
            isHostMonoExhausted,
            isClockRollback
          }
        },
        $inc: { version: 1, drainAttempts: 1 }
      },
      { new: true }
    );

    const finalDoc = recovered || (await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean());

    logger.warn('Interrupted quiescence state transitioned to RECOVERY_REQUIRED on startup', {
      event: 'quiescence.interrupted_quiescence_held',
      previousLeaseId: doc.leaseId,
      previousStatus: doc.status,
      reason: recoveryReason,
      version: finalDoc?.version || doc.version + 1
    });

    return {
      success: true,
      recovered: false,
      status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
      previousLeaseId: doc.leaseId,
      previousStatus: doc.status,
      reason: recoveryReason,
      version: finalDoc?.version || doc.version + 1
    };
  }

  clearMonotonicWatchdog();
  await syncAdmissionState(BACKUP_LEASE_STATUS.NORMAL);
  return {
    success: true,
    recovered: false,
    status: BACKUP_LEASE_STATUS.NORMAL,
    version: doc.version
  };
};

/**
 * Returns true if the system is currently fully quiesced and lease is active.
 *
 * @returns {Promise<boolean>}
 */
export const isQuiesced = async () => {
  const statusInfo = await getStatus();
  return statusInfo.status === BACKUP_LEASE_STATUS.QUIESCED && !statusInfo.isExpired;
};

/**
 * Returns true if the system is currently draining or quiesced and lease is active.
 *
 * @returns {Promise<boolean>}
 */
export const isDrainingOrQuiesced = async () => {
  const statusInfo = await getStatus();
  return (
    (statusInfo.status === BACKUP_LEASE_STATUS.DRAINING ||
      statusInfo.status === BACKUP_LEASE_STATUS.QUIESCED ||
      statusInfo.status === BACKUP_LEASE_STATUS.RECOVERY_REQUIRED) &&
    !statusInfo.isExpired
  );
};

// Aliases matching prompt and specialist contract
export const isQuiescedOrDraining = isDrainingOrQuiesced;
export const getLeaseStatus = getStatus;
export const acquireLease = acquire;
export const releaseLease = release;
export const transitionToQuiesced = markQuiesced;

/**
 * Coordinated draining during lease acquisition:
 * Stops reconciliation scheduler, awaits in-flight mutations, and verifies durable datastore drain.
 * If drained within drainTimeoutMs, transitions status to QUIESCED via markQuiesced.
 * If timeout expires, FAILS CLOSED: transitions status to RECOVERY_REQUIRED, preserves diagnostics,
 * and leaves admission gates strictly closed.
 *
 * @param {number} [drainTimeoutMs=15000]
 * @param {string} [leaseId]
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
export const drainInFlight = async (drainTimeoutMs = 15000, leaseId = null, options = {}) => {
  let targetLeaseId = leaseId;
  if (!targetLeaseId) {
    const current = await getStatus();
    targetLeaseId = current?.leaseId;
  }

  // Step 1: Explicitly stop background reconciliation scheduler (WP-B)
  let schedulerDrained = true;
  let schedulerError = null;
  try {
    const { getReconciliationScheduler } = await import('./reconciliationScheduler.js');
    const scheduler = getReconciliationScheduler();
    if (scheduler && typeof scheduler.stop === 'function') {
      const stopRes = await scheduler.stop({ timeoutMs: Math.min(drainTimeoutMs, 10000) });
      if (!stopRes?.success) {
        schedulerDrained = false;
        schedulerError = stopRes?.reason || 'SCHEDULER_DRAIN_TIMEOUT';
      }
    }
  } catch (schedErr) {
    logger.warn('quiescence.scheduler_stop_failed_in_drain', { error: schedErr.message });
  }

  // Step 2: Await in-process mutation drain
  const { drainInFlight: gateDrainInFlight } = await import('../middleware/quiescenceGate.js');
  const inMemoryDrained = await gateDrainInFlight(drainTimeoutMs);

  // Step 3: Verify durable datastore drain across 9 business mutation domains
  let datastoreDrained = true;
  let datastoreDiagnostics = null;
  let datastoreReason = null;
  if (inMemoryDrained && mongoose.connection && mongoose.connection.readyState === 1) {
    const durableRes = await checkDurableDatastoreDrain({
      strict: options?.strict,
      commandTimeoutMs: drainTimeoutMs
    });
    datastoreDrained = durableRes.isDrained;
    datastoreDiagnostics = durableRes.diagnostics;
    datastoreReason = durableRes.reason;
  }

  const drained = inMemoryDrained && datastoreDrained && schedulerDrained;

  const autoQuiesce = options.autoQuiesce !== false;

  if (drained) {
    if (targetLeaseId && autoQuiesce) {
      await markQuiesced({ leaseId: targetLeaseId, enforceDrain: false });
    }
    return { success: true, isDrained: true, datastoreDiagnostics };
  } else {
    // FAIL CLOSED: Transition lease to RECOVERY_REQUIRED, preserve diagnostics, keep admission closed!
    const failureReason = !schedulerDrained
      ? (schedulerError || 'SCHEDULER_DRAIN_TIMEOUT')
      : !inMemoryDrained
      ? 'DRAIN_TIMEOUT'
      : (datastoreReason || 'DATASTORE_DRAIN_TIMEOUT');

    const now = new Date();
    if (targetLeaseId) {
      await BackupLease.findOneAndUpdate(
        {
          _id: BACKUP_LEASE_SINGLETON_ID,
          leaseId: targetLeaseId
        },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
            lastKnownHealthyState: BACKUP_LEASE_STATUS.DRAINING,
            recoveryActionRequired: failureReason,
            drainFailureReason: failureReason,
            drainFailureAt: now,
            drainDiagnostics: {
              inMemoryDrained,
              datastoreDrained,
              schedulerDrained,
              datastoreDiagnostics
            }
          },
          $inc: { version: 1, drainAttempts: 1 }
        }
      );
    }

    // Keep admission closed!
    await syncAdmissionState(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);

    return {
      success: false,
      isDrained: false,
      status: BACKUP_LEASE_STATUS.RECOVERY_REQUIRED,
      reason: failureReason,
      message: failureReason === 'TRANSACTION_DRAIN_UNVERIFIED'
        ? 'Timed out waiting for in-flight operations to drain: transaction drain unverified'
        : `Timed out waiting for operations to drain: ${failureReason}`,
      datastoreDiagnostics
    };
  }
};

export default {
  acquire,
  acquireLease,
  heartbeat,
  release,
  releaseLease,
  recoverFromDrainFailure,
  syncAdmissionState,
  markQuiesced,
  getStatus,
  getLeaseStatus,
  initialize,
  isQuiesced,
  isDrainingOrQuiesced,
  isQuiescedOrDraining,
  drainInFlight,
  checkDurableDatastoreDrain,
  ensureSingletonExists,
  resolveHardDeadline,
  setMonotonicWatchdog,
  clearMonotonicWatchdog,
  getMonotonicWatchdogState,
  isMonotonicWatchdogExpired,
  getMonotonicRemainingMs,
  getSystemBootId,
  isTtlMonitorDisabledByConfig,
  applyTtlMonitorState
};
