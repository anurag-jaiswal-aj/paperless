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
export const verifyReplicaSetTopology = async (conn = mongoose.connection) => {
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

  return {
    topologyType,
    setName: hello?.setName || null,
    isWritablePrimary
  };
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
    ...txOptions
  };

  try {
    let result;
    await session.withTransaction(async () => {
      result = await operation(session);
    }, resolvedOptions);
    return result;
  } finally {
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
