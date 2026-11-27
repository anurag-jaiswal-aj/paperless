import crypto from 'crypto';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';
import AppWorker, { APP_WORKER_STATUS } from '../models/appWorker.js';
import { InstanceLeaseSlot } from '../models/instanceLease.js';
import { computeDesignatedSlotId } from '../utils/dbTransaction.js';

export class AmbiguousBarrierError extends Error {
  constructor(message = 'Causal write barrier timed out or outcome is unconfirmed') {
    super(message);
    this.name = 'AmbiguousBarrierError';
    this.code = 'AMBIGUOUS_BARRIER';
    this.statusCode = 503;
  }
}

export class WorkerDeposedError extends Error {
  constructor(message = 'Worker role lease was deposed or expired before barrier write') {
    super(message);
    this.name = 'WorkerDeposedError';
    this.code = 'WORKER_DEPOSED';
    this.statusCode = 409;
  }
}

/**
 * Bridges logical clocks from a completed CausalBarrierContext to a ClientSession.
 * Prevents the silent ordering loss trap in fresh sessions.
 *
 * @param {import('mongodb').ClientSession} session
 * @param {object} barrierContext
 */
export const bridgeSessionToBarrier = (session, barrierContext) => {
  if (!session || typeof session.advanceOperationTime !== 'function') {
    throw new TypeError('bridgeSessionToBarrier: valid ClientSession required');
  }
  if (session.supports && session.supports.causalConsistency === false) {
    throw new TypeError('bridgeSessionToBarrier: session must support causal consistency');
  }
  if (!barrierContext || !barrierContext.operationTime) {
    throw new TypeError('bridgeSessionToBarrier: barrierContext with operationTime required');
  }

  session.advanceOperationTime(barrierContext.operationTime);
  if (barrierContext.clusterTime) {
    session.advanceClusterTime(barrierContext.clusterTime);
  }
};

export class CausalBarrierService {
  /**
   * Establishes an explicit Causal Write Barrier before executing negative-read
   * garbage collection or reconciliation scans.
   *
   * Mutates the exact InstanceLeaseSlot document(s) used by publication transactions
   * with w: majority, j: true to establish an unforgeable causal boundary.
   *
   * @param {object} [options={}]
   * @param {string} [options.role='storage_reconciliation']
   * @param {string} [options.workerId]
   * @param {string} [options.incarnationId]
   * @param {number} [options.epoch]
   * @param {number} [options.timeoutMs=5000]
   * @param {string} [options.slotId]
   * @param {string} [options.partitionKey]
   * @param {import('mongodb').ClientSession} [options.session]
   * @returns {Promise<object>} CausalBarrierContext
   */
  async establishCausalBarrier(options = {}) {
    const role = options.role || 'storage_reconciliation';
    const workerId = options.workerId;
    const incarnationId = options.incarnationId;
    const expectedEpoch = options.epoch;
    const timeoutMs = options.timeoutMs || 5000;
    const barrierId = crypto.randomUUID();
    const barrierGeneration = Date.now();

    const ownSession = !options.session;
    let session = options.session;
    if (!session) {
      try {
        session = await mongoose.startSession({ causalConsistency: true });
      } catch (sessErr) {
        logger.error('causal_barrier.start_session_failed', { error: sessErr.message });
        throw new AmbiguousBarrierError(`Failed to start causal session: ${sessErr.message}`);
      }
    }

    const executedAt = new Date();
    const startMark = performance.now();

    try {
      const writeOpts = {
        writeConcern: { w: 'majority', j: true, wtimeout: timeoutMs }
      };
      if (session) {
        writeOpts.session = session;
      }

      // Step 1: Execute fenced majority write on exact InstanceLeaseSlot documents
      let targetSlotId = options.slotId;
      if (!targetSlotId && options.partitionKey) {
        targetSlotId = computeDesignatedSlotId(options.partitionKey);
      }

      if (targetSlotId) {
        await InstanceLeaseSlot.updateOne(
          { _id: targetSlotId },
          {
            $set: { lastTouchAt: executedAt },
            $inc: { fenceEpoch: 1 }
          },
          { ...writeOpts, upsert: true }
        );
      } else {
        const slotRes = await InstanceLeaseSlot.updateMany(
          {},
          {
            $set: { lastTouchAt: executedAt },
            $inc: { fenceEpoch: 1 }
          },
          writeOpts
        );
        if (slotRes.matchedCount === 0) {
          await InstanceLeaseSlot.updateOne(
            { _id: 'slot_0' },
            {
              $set: { lastTouchAt: executedAt },
              $inc: { fenceEpoch: 1 }
            },
            { ...writeOpts, upsert: true }
          );
        }
      }

      // Step 2: Update AppWorker for worker lease tracking if worker context exists
      const barrierFilter = {
        _id: role
      };
      if (workerId) barrierFilter.workerId = workerId;
      if (incarnationId) barrierFilter.incarnationId = incarnationId;
      if (expectedEpoch !== undefined && expectedEpoch !== null) {
        barrierFilter.epoch = expectedEpoch;
      }
      barrierFilter.status = { $in: [APP_WORKER_STATUS.STARTING, APP_WORKER_STATUS.ACTIVE] };
      barrierFilter.heartbeatExpiresAt = { $gt: executedAt };

      const barrierUpdate = {
        $set: {
          lastHeartbeatAt: executedAt,
          'metadata.lastBarrierId': barrierId,
          'metadata.lastBarrierGeneration': barrierGeneration,
          'metadata.lastBarrierAt': executedAt
        }
      };

      const updateRes = await AppWorker.updateOne(barrierFilter, barrierUpdate, writeOpts);

      if (updateRes.matchedCount === 0) {
        if (workerId) {
          throw new WorkerDeposedError(
            `Worker "${workerId}" for role "${role}" has lost ownership or lease expired`
          );
        }
        // In fallback test/standalone environments without registered worker, touch app_workers directly
        await AppWorker.updateOne(
          { _id: role },
          {
            $set: {
              role,
              lastHeartbeatAt: executedAt,
              'metadata.lastBarrierId': barrierId,
              'metadata.lastBarrierAt': executedAt
            }
          },
          { ...writeOpts, upsert: true }
        );
      }

      const acknowledgedAt = new Date();
      const ackDurationMs = performance.now() - startMark;

      // Extract operationTime and clusterTime from session
      const operationTime = session?.operationTime || null;
      const clusterTime = session?.clusterTime || null;

      return {
        barrierId,
        role,
        workerId,
        incarnationId,
        epoch: expectedEpoch,
        barrierGeneration,
        targetSlotId: targetSlotId || 'all_slots',
        executedAt,
        acknowledgedAt,
        ackDurationMs,
        operationTime,
        clusterTime,
        majorityAcked: true,
        session
      };
    } catch (err) {
      if (err instanceof WorkerDeposedError) {
        if (ownSession && session) await session.endSession().catch(() => {});
        throw err;
      }

      // Check if timeout or write concern failed
      const isTimeout =
        err.name === 'MongoWriteConcernError' ||
        err.name === 'MongoNetworkTimeoutError' ||
        err.code === 64 ||
        /wtimeout/i.test(err.message) ||
        /timed out/i.test(err.message);

      if (isTimeout) {
        logger.error('causal_barrier.timeout', err, { role, barrierId });
        if (ownSession && session) await session.endSession().catch(() => {});
        throw new AmbiguousBarrierError(
          `Causal barrier write timed out waiting for majority acknowledgment: ${err.message}`
        );
      }

      if (ownSession && session) await session.endSession().catch(() => {});
      throw err;
    }
  }
}

export const causalBarrierService = new CausalBarrierService();
export default causalBarrierService;
