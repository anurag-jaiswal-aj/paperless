/**
 * Suite 3: Causal Barrier
 * File: server/src/tests/causalFence/causalBarrier.test.js
 *
 * Verifies:
 * - Majority-acknowledged barrier write execution
 * - BSON operationTime and $clusterTime evidence capture
 * - Fresh-session clock bridging protocol
 * - Fail-closed handling for ambiguous barrier writes and deposed workers
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startReplSet, stopReplSet } from '../../testUtils/replSetHelper.js';
import AppWorker, { APP_WORKER_ROLE, APP_WORKER_STATUS } from '../../models/appWorker.js';
import {
  causalBarrierService,
  bridgeSessionToBarrier,
  AmbiguousBarrierError,
  WorkerDeposedError
} from '../../services/causalBarrierService.js';

describe('Suite 3: Causal Barrier (causalBarrier)', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await startReplSet([AppWorker]);
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await AppWorker.deleteMany({});
  });

  it('3.1: Establishes causal barrier with majority ACK and captures operationTime', async () => {
    const role = APP_WORKER_ROLE.STORAGE_RECONCILIATION;
    const workerId = 'worker-causal-1';
    const incarnationId = 'inc-1';
    const epoch = 1;
    const now = new Date();

    // Register active worker
    await AppWorker.create({
      _id: role,
      role,
      workerId,
      incarnationId,
      status: APP_WORKER_STATUS.ACTIVE,
      epoch,
      heartbeatExpiresAt: new Date(now.getTime() + 30000),
      lastHeartbeatAt: now,
      activeClaimCount: 0
    });

    const barrier = await causalBarrierService.establishCausalBarrier({
      role,
      workerId,
      incarnationId,
      epoch
    });

    expect(barrier).toBeDefined();
    expect(barrier.majorityAcked).toBe(true);
    expect(barrier.barrierId).toBeDefined();
    expect(barrier.operationTime).toBeDefined();
    expect(barrier.ackDurationMs).toBeGreaterThanOrEqual(0);

    // Verify worker document was updated with barrier metadata
    const updatedWorker = await AppWorker.findById(role);
    expect(updatedWorker.metadata?.lastBarrierId).toBe(barrier.barrierId);

    if (barrier.session) {
      await barrier.session.endSession();
    }
  });

  it('3.2: bridgeSessionToBarrier advances logical clocks on fresh session', async () => {
    const role = APP_WORKER_ROLE.STORAGE_RECONCILIATION;
    const workerId = 'worker-bridge-1';
    const incarnationId = 'inc-2';
    const epoch = 1;
    const now = new Date();

    await AppWorker.create({
      _id: role,
      role,
      workerId,
      incarnationId,
      status: APP_WORKER_STATUS.ACTIVE,
      epoch,
      heartbeatExpiresAt: new Date(now.getTime() + 30000),
      lastHeartbeatAt: now
    });

    const barrier = await causalBarrierService.establishCausalBarrier({
      role,
      workerId,
      incarnationId,
      epoch
    });

    // Create a fresh session
    const freshSession = await mongoose.startSession({ causalConsistency: true });
    // Initially in fresh session, operationTime is undefined
    expect(freshSession.operationTime).toBeUndefined();

    // Bridge the session
    bridgeSessionToBarrier(freshSession, barrier);

    // After bridging, operationTime matches the barrier's operationTime
    expect(freshSession.operationTime).toBeDefined();
    expect(freshSession.operationTime).toEqual(barrier.operationTime);

    await freshSession.endSession();
    if (barrier.session) {
      await barrier.session.endSession();
    }
  });

  it('3.3: Rejects with WorkerDeposedError if worker was deposed or lease expired', async () => {
    const role = APP_WORKER_ROLE.STORAGE_RECONCILIATION;
    const workerId = 'worker-stale-1';
    const incarnationId = 'inc-stale';
    const epoch = 1;
    const now = new Date();

    // Expired worker lease
    await AppWorker.create({
      _id: role,
      role,
      workerId,
      incarnationId,
      status: APP_WORKER_STATUS.ACTIVE,
      epoch,
      heartbeatExpiresAt: new Date(now.getTime() - 5000), // Expired!
      lastHeartbeatAt: new Date(now.getTime() - 10000)
    });

    await expect(
      causalBarrierService.establishCausalBarrier({
        role,
        workerId,
        incarnationId,
        epoch
      })
    ).rejects.toThrow(WorkerDeposedError);
  });

  it('3.4: Rejects with AmbiguousBarrierError when write concern times out', async () => {
    const role = APP_WORKER_ROLE.STORAGE_RECONCILIATION;
    const workerId = 'worker-timeout-1';
    const incarnationId = 'inc-timeout';
    const epoch = 1;
    const now = new Date();

    await AppWorker.create({
      _id: role,
      role,
      workerId,
      incarnationId,
      status: APP_WORKER_STATUS.ACTIVE,
      epoch,
      heartbeatExpiresAt: new Date(now.getTime() + 30000),
      lastHeartbeatAt: now
    });

    // Mock updateOne to simulate write concern timeout
    const timeoutErr = new Error('waiting for replication timed out');
    timeoutErr.name = 'MongoWriteConcernError';
    timeoutErr.code = 64;
    vi.spyOn(AppWorker, 'updateOne').mockRejectedValueOnce(timeoutErr);

    await expect(
      causalBarrierService.establishCausalBarrier({
        role,
        workerId,
        incarnationId,
        epoch
      })
    ).rejects.toThrow(AmbiguousBarrierError);
  });
});
