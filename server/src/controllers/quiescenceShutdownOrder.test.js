import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import InstanceLease, {
  INSTANCE_LEASE_SINGLETON_ID,
  INSTANCE_LEASE_STATUS
} from '../models/instanceLease.js';
import * as instanceLeaseService from '../services/instanceLeaseService.js';
import {
  quiescenceGate,
  closeMutationAdmission,
  openMutationAdmission,
  drainInFlight,
  trackMutationOperation,
  resetInFlightMutations
} from '../middleware/quiescenceGate.js';
import {
  registerWorkerTask,
  closeWorkerAdmission,
  openWorkerAdmission,
  resetWorkerTasks
} from '../services/workerCoordinationService.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

describe('Phase 4.4 Workstream 2D.1D: Shutdown Ordering & Teardown Safety Test Suite', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await startReplSet([InstanceLease]);
  }, 30000);

  afterAll(async () => {
    instanceLeaseService.stopHeartbeat();
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    instanceLeaseService.stopHeartbeat();
    openMutationAdmission();
    openWorkerAdmission();
    resetInFlightMutations();
    resetWorkerTasks();
    await InstanceLease.deleteMany({});
    await instanceLeaseService.ensureInstanceSingletonExists();
  });

  afterEach(async () => {
    instanceLeaseService.stopHeartbeat();
    openMutationAdmission();
    openWorkerAdmission();
    resetInFlightMutations();
    resetWorkerTasks();
    vi.restoreAllMocks();
  });

  it('TS-SO-01: Keep-alive mutation rejection during shutdown (503 SERVER_SHUTTING_DOWN)', async () => {
    // 1. Instance has active lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-1',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    // 2. Signal initiates shutdown: closeMutationAdmission() is invoked synchronously
    closeMutationAdmission('SHUTDOWN');

    // 3. Mutating request arrives on existing keep-alive connection
    let statusCode = null;
    let responseBody = null;
    let nextCalled = false;

    const req = {
      method: 'POST',
      originalUrl: '/api/forms',
      path: '/api/forms'
    };
    const res = {
      setHeader: vi.fn(),
      status: (code) => {
        statusCode = code;
        return {
          json: (body) => {
            responseBody = body;
          }
        };
      }
    };
    const next = () => {
      nextCalled = true;
    };

    await quiescenceGate(req, res, next);

    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(503);
    expect(responseBody).toEqual(
      expect.objectContaining({
        code: 'SERVER_SHUTTING_DOWN'
      })
    );
  });

  it('TS-SO-02: In-flight drain before lease release (lease is not released until mutations & workers finish)', async () => {
    // 1. Instance acquires lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-1',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    let mutationCompleted = false;
    let workerCompleted = false;

    // 2. Start an in-flight operation mutation
    const opPromise = new Promise((resolve) => {
      setTimeout(() => {
        mutationCompleted = true;
        resolve();
      }, 100);
    });
    trackMutationOperation(opPromise);

    // 3. Start an active background worker
    const workerPromise = registerWorkerTask('backgroundCleanup', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      workerCompleted = true;
      return { cleaned: true };
    });

    // 4. Simulate shutdown Step 5b: drain in-flight before Step 5c
    const drainResult = await drainInFlight(1000);
    expect(drainResult).toBe(true);
    expect(mutationCompleted).toBe(true);
    expect(workerCompleted).toBe(true);
    await workerPromise;

    // 5. Only after drain completes does Step 5c release the lease
    const releaseResult = await instanceLeaseService.releaseInstanceLease('server-instance-1');
    expect(releaseResult.success).toBe(true);
    expect(releaseResult.released).toBe(true);

    const doc = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(doc.status).toBe(INSTANCE_LEASE_STATUS.RELEASED);
  });

  it('TS-SO-03: Replacement instance blocked while previous instance is still draining', async () => {
    // 1. Instance A acquires lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    // 2. Instance A starts draining (lease remains ACTIVE in MongoDB)
    closeMutationAdmission();
    closeWorkerAdmission();

    // 3. Instance B attempts to acquire lease while Instance A is still alive and draining
    const instanceBResult = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    // Instance B must be strictly blocked from taking over
    expect(instanceBResult.success).toBe(false);
    expect(instanceBResult.reason).toBe('CONCURRENT_INSTANCE_ACTIVE');
  });

  it('TS-SO-04: Dirty shutdown skips lease release to expire naturally by TTL', async () => {
    // 1. Instance A acquires lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 500, // 500ms TTL
      skipHeartbeat: true
    });

    // 2. Simulate dirty shutdown conditions:
    // When errors occurred or timeout happened, server.js skips releaseInstanceLease()
    const errors = [new Error('Drain timed out')];
    const isTimedOut = true;

    // Replicate server.js Step 5c logic:
    if (errors.length === 0 && !isTimedOut) {
      await instanceLeaseService.releaseInstanceLease('server-instance-A');
    }

    // Verify lease was NOT prematurely set to RELEASED
    const docImmediately = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(docImmediately.status).toBe(INSTANCE_LEASE_STATUS.ACTIVE);
    expect(docImmediately.instanceId).toBe('server-instance-A');

    // Instance B cannot acquire immediately
    const immediateB = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 10000,
      skipHeartbeat: true
    });
    expect(immediateB.success).toBe(false);

    // After TTL passes, Instance B can safely take over
    await new Promise((resolve) => setTimeout(resolve, 550));
    const takeoverB = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 10000,
      skipHeartbeat: true
    });
    expect(takeoverB.success).toBe(true);
    expect(takeoverB.instanceId).toBe('server-instance-B');
  });
});
