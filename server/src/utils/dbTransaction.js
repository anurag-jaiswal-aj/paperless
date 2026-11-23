import crypto from 'crypto';
import mongoose from 'mongoose';
import { logger } from './logger.js';

export class ReplicaSetRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplicaSetRequiredError';
    this.code = 'REPLICA_SET_REQUIRED';
    this.statusCode = 503;
  }
}

/**
 * Returns the current MongoDB driver SDAM topology description type.
 *
 * @param {import('mongoose').Connection} [conn=mongoose.connection]
 * @returns {string|null}
 */
export const getTopologyType = (conn = mongoose.connection) => {
  return conn?.client?.topology?.description?.type || null;
};

/**
 * Checks if the current MongoDB connection topology supports multi-document transactions.
 * Transactions require a replica set with a primary ('ReplicaSetWithPrimary') or a sharded cluster ('Sharded').
 * Standalone MongoDB ('Single') and primaryless replica sets ('ReplicaSetNoPrimary') return false.
 *
 * @param {import('mongoose').Connection} [conn=mongoose.connection]
 * @returns {boolean} True if transactions are supported, false otherwise.
 */
export const supportsTransactions = (conn = mongoose.connection) => {
  const topologyType = getTopologyType(conn);
  return topologyType === 'ReplicaSetWithPrimary' || topologyType === 'Sharded';
};

/**
 * Fails closed unless the current MongoDB driver topology supports multi-document ACID transactions.
 *
 * @param {import('mongoose').Connection} [conn=mongoose.connection]
 * @returns {string} Validated topology type ('ReplicaSetWithPrimary' or 'Sharded')
 */
export const assertTransactionsSupported = (conn = mongoose.connection) => {
  const topologyType = getTopologyType(conn);
  if (topologyType !== 'ReplicaSetWithPrimary' && topologyType !== 'Sharded') {
    throw new ReplicaSetRequiredError(
      `MongoDB replica-set or sharded topology with a writable primary is required for multi-document ACID transactions (observed topology: "${topologyType || 'unknown'}"). Start mongod with "--replSet rs0", run rs.initiate(), and configure MONGO_URI with "?replicaSet=rs0".`
    );
  }
  return topologyType;
};

/**
 * Verifies both driver SDAM topology and live server `hello` primary/replica-set metadata.
 * Rejects standalone servers, secondary/recovering nodes, and uninitialized replica sets.
 *
 * @param {import('mongoose').Connection} [conn=mongoose.connection]
 * @returns {Promise<{ topologyType: string, setName: string|null, isWritablePrimary: boolean }>}
 */
export const verifyReplicaSetTopology = async (conn = mongoose.connection, options = {}) => {
  const topologyType = assertTransactionsSupported(conn);

  if (!conn?.db || typeof conn.db.admin !== 'function') {
    throw new ReplicaSetRequiredError(
      'MongoDB admin interface is unavailable to verify replica-set primary state.'
    );
  }

  const admin = conn.db.admin();
  if (typeof admin.command !== 'function') {
    throw new ReplicaSetRequiredError(
      'MongoDB admin.command is unavailable to verify replica-set primary state.'
    );
  }

  const hello = await admin.command({ hello: 1 });
  const isWritablePrimary = Boolean(hello?.isWritablePrimary || hello?.ismaster);
  const hasReplicaOrRouterIdentity = Boolean(hello?.setName) || hello?.msg === 'isdbgrid';

  if (hello?.ok !== 1 && hello?.ok !== undefined) {
    throw new ReplicaSetRequiredError('MongoDB hello command failed during topology verification.');
  }
  if (!hasReplicaOrRouterIdentity) {
    throw new ReplicaSetRequiredError(
      'Connected MongoDB server is running in standalone mode without a replica set. Enable "--replSet rs0" and initialize the replica set before starting Paperless.'
    );
  }
  if (!isWritablePrimary) {
    throw new ReplicaSetRequiredError(
      `Connected MongoDB replica set "${hello?.setName || 'unknown'}" has no writable primary. Wait for election completion before serving requests.`
    );
  }

  // BLK-04/Option B Verification: Ensure MongoDB transaction lifetime is bounded (<= 15 seconds) during startup
  if (options.verifyParameters) {
    try {
      const paramRes = await admin.command({ getParameter: 1, transactionLifetimeLimitSeconds: 1 });
      if (paramRes?.ok === 1 && typeof paramRes.transactionLifetimeLimitSeconds === 'number') {
        if (paramRes.transactionLifetimeLimitSeconds > 15) {
          try {
            await admin.command({ setParameter: 1, transactionLifetimeLimitSeconds: 15 });
            logger.info('db.transaction_lifetime_limit_configured', {
              previous: paramRes.transactionLifetimeLimitSeconds,
              configured: 15
            });
          } catch {
            logger.warn('db.transaction_lifetime_limit_exceeds_threshold', {
              current: paramRes.transactionLifetimeLimitSeconds,
              recommended: 15
            });
          }
        }
      }
    } catch {
      // Non-fatal if command is unsupported by mock or user lacks clusterAdmin privilege
    }
  }

  return {
    topologyType,
    setName: hello?.setName || null,
    isWritablePrimary
  };
};

/**
 * Deterministically computes the designated 16-slot OCC lease slot ID for a logical key.
 *
 * @param {string|number} key
 * @returns {string} e.g. 'slot_0' through 'slot_15'
 */
let inFlightTransactionCount = 0;

/**
 * Returns the number of currently active in-flight MongoDB transactions on this Node process.
 * Used by quiescence drain checks to supplement or corroborate currentOp observations.
 *
 * @returns {number}
 */
export const getInFlightTransactionCount = () => inFlightTransactionCount;

export const computeDesignatedSlotId = (key) => {
  const logicalTxId = String(key || '');
  let hash = 0;
  for (let i = 0; i < logicalTxId.length; i++) {
    hash = (hash << 5) - hash + logicalTxId.charCodeAt(i);
    hash |= 0;
  }
  const designatedSlotIndex = Math.abs(hash) % 16;
  return `slot_${designatedSlotIndex}`;
};

/**
 * Strictly executes an operation inside a MongoDB multi-document ACID transaction.
 * Fails closed when replica-set transactions are unsupported or session creation fails.
 * Never falls back to executing without a ClientSession.
 *
 * @param {Function} operation - Async callback receiving an active ClientSession.
 * @param {object} [txOptions={}] - Optional transaction options.
 * @returns {Promise<any>} Result returned by the operation callback.
 */
export const withRequiredTransaction = async (operation, txOptions = {}) => {
  assertTransactionsSupported();

  // Fencing Point 1: Pre-Execution Leadership Check (requires >= 2000ms remaining lease TTL)
  let assertLeader = null;
  try {
    const leaseService = await import('../services/instanceLeaseService.js');
    assertLeader = leaseService.assertInstanceLeader;
  } catch (err) {
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
      const leaderErr = new Error(`Critical failure loading instance lease service: ${err.message}`);
      leaderErr.name = 'InstanceFencedError';
      leaderErr.code = 'INSTANCE_FENCED';
      leaderErr.statusCode = 503;
      throw leaderErr;
    }
  }

  if (typeof assertLeader === 'function') {
    assertLeader({
      minRemainingMs: 2000,
      message: 'Instance lease near expiration before transaction start'
    });
  } else if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
    const leaderErr = new Error('Critical failure: assertInstanceLeader is unavailable');
    leaderErr.name = 'InstanceFencedError';
    leaderErr.code = 'INSTANCE_FENCED';
    leaderErr.statusCode = 503;
    throw leaderErr;
  }

  // Derive stable partition slot ID once before entering transaction retry callback
  const logicalTxId = String(
    txOptions.partitionKey || txOptions.requestId || crypto.randomUUID()
  );
  const designatedSlotId = computeDesignatedSlotId(logicalTxId);

  let session = null;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    logger.error('db.required_transaction_session_failed', err, {
      event: 'db.session_creation_failed'
    });
    const sessionErr = new Error(
      `Failed to start required MongoDB transaction session: ${err.message}`
    );
    sessionErr.code = err.code || 'TRANSACTION_SESSION_FAILED';
    sessionErr.statusCode = 503;
    throw sessionErr;
  }

  const resolvedOptions = {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    readPreference: 'primary',
    maxCommitTimeMS: 10000,
    timeoutMS: 10000,
    ...txOptions
  };

  inFlightTransactionCount++;
  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);

      // Fencing Point 2: Pre-Commit Leadership Check
      // Guarantees transaction abort if lease expired during callback execution
      if (typeof assertLeader === 'function') {
        assertLeader({
          minRemainingMs: 0,
          message: 'Instance lease expired during transaction execution'
        });
      }

      // Fencing Point 3: Datastore-Enforced Transactional Boundary Fence
      let verifyFence = null;
      try {
        const leaseMod = await import('../services/instanceLeaseService.js');
        verifyFence = leaseMod.verifyTransactionalFence;
      } catch (importErr) {
        if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
          const failErr = new Error(
            `Critical failure loading instance lease service: ${importErr.message}`
          );
          failErr.name = 'InstanceFencedError';
          failErr.code = 'INSTANCE_FENCED';
          failErr.statusCode = 503;
          throw failErr;
        }
      }

      if (typeof verifyFence === 'function') {
        await verifyFence(session, {
          useSlots: true,
          slotId: designatedSlotId
        });
      } else if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') {
        const failErr = new Error('Critical failure: verifyTransactionalFence is unavailable');
        failErr.name = 'InstanceFencedError';
        failErr.code = 'INSTANCE_FENCED';
        failErr.statusCode = 503;
        throw failErr;
      }
    }, resolvedOptions);
    return result;
  } finally {
    inFlightTransactionCount = Math.max(0, inFlightTransactionCount - 1);
    await session.endSession().catch(() => {});
  }
};

/**
 * Legacy helper retained strictly for non-lifecycle unit compatibility.
 * Strict submission, deletion, and question-lifecycle paths must use withRequiredTransaction.
 *
 * @deprecated Use withRequiredTransaction for any B1 lifecycle operation.
 * @param {Function} operation - Async function receiving (session | null).
 * @returns {Promise<any>} Result returned by the operation callback.
 */
export const withOptionalTransaction = async (operation) => {
  if (!supportsTransactions()) {
    // Standalone fallback: execute directly without transaction/session
    return operation(null);
  }

  let session = null;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    logger.warn('db.session_creation_failed_fallback_standalone', { error: err.message });
    return operation(null);
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    });
    return result;
  } finally {
    await session.endSession().catch(() => {});
  }
};
