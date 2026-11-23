import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import InstanceLease, {
  INSTANCE_LEASE_SINGLETON_ID,
  INSTANCE_LEASE_STATUS
} from '../models/instanceLease.js';
import * as instanceLeaseService from '../services/instanceLeaseService.js';
import { quiescenceGate } from '../middleware/quiescenceGate.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

describe('Phase 4.4 Workstream 2D.1D: Instance Fencing & Partition Tolerance Test Suite', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await startReplSet([InstanceLease]);
  });

  afterAll(async () => {
    instanceLeaseService.stopHeartbeat();
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    instanceLeaseService.stopHeartbeat();
    instanceLeaseService.resetFencedForTesting();
    instanceLeaseService.resetSystemUptimeForTesting();
    instanceLeaseService.resetLocalLeaseDeadlineForTesting();
    await InstanceLease.deleteMany({});
    await instanceLeaseService.ensureInstanceSingletonExists();
  });

  afterEach(async () => {
    instanceLeaseService.stopHeartbeat();
    instanceLeaseService.resetFencedForTesting();
    instanceLeaseService.resetSystemUptimeForTesting();
    instanceLeaseService.resetLocalLeaseDeadlineForTesting();
    vi.restoreAllMocks();
  });

  it('TS-IO-01: Takeover during partition/stall (Instance B claims lease after TTL expires)', async () => {
    // 1. Instance A acquires lease with short TTL (200ms)
    const instanceAResult = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 200,
      skipHeartbeat: true
    });
    expect(instanceAResult.success).toBe(true);
    expect(instanceAResult.instanceId).toBe('server-instance-A');

    // Instance B cannot acquire immediately
    const immediateB = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 200,
      skipHeartbeat: true
    });
    expect(immediateB.success).toBe(false);
    expect(immediateB.reason).toBe('CONCURRENT_INSTANCE_ACTIVE');

    // 2. Simulate stall/partition: wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 250));

    // 3. Instance B now successfully reclaims the expired lease
    const reclaimedB = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 5000,
      skipHeartbeat: true
    });
    expect(reclaimedB.success).toBe(true);
    expect(reclaimedB.instanceId).toBe('server-instance-B');

    const leaseDoc = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(leaseDoc.instanceId).toBe('server-instance-B');
    expect(leaseDoc.status).toBe(INSTANCE_LEASE_STATUS.ACTIVE);
  });

  it('TS-IO-02: Zombie unfreeze rejection (Instance A waking up receives 503 INSTANCE_FENCED via quiescenceGate)', async () => {
    // 1. Instance A acquires lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 500,
      skipHeartbeat: true
    });

    expect(instanceLeaseService.isInstanceLeaseValid()).toBe(true);

    // 2. Simulate local deadline expiration (as happens during sleep/freeze)
    instanceLeaseService.setLocalLeaseDeadlineForTesting(performance.now() - 1000);

    // Lease is now locally expired/invalid
    expect(instanceLeaseService.isInstanceLeaseValid()).toBe(false);

    // 3. Test quiescenceGate rejects mutating requests with HTTP 503 INSTANCE_FENCED
    let statusCode = null;
    let responseBody = null;
    let nextCalled = false;

    const req = {
      method: 'POST',
      originalUrl: '/api/forms/submit',
      path: '/api/forms/submit'
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
        code: 'INSTANCE_FENCED'
      })
    );
  });

  it('TS-IO-03: Direct service layer rejection when fenced', async () => {
    // Acquire lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 5000,
      skipHeartbeat: true
    });
    expect(instanceLeaseService.isInstanceLeaseValid()).toBe(true);

    // Explicitly mark fenced for testing
    instanceLeaseService.markFencedForTesting();
    expect(instanceLeaseService.isInstanceLeaseValid()).toBe(false);
  });

  it('TS-IO-04: Running async abort / self-fencing threshold after consecutive heartbeat failures', async () => {
    // 1. Acquire lease with short heartbeat interval
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 10000,
      heartbeatIntervalMs: 50,
      skipHeartbeat: false
    });

    expect(instanceLeaseService.isInstanceLeaseValid()).toBe(true);

    // 2. Simulate takeover in database by another instance (changing instanceId)
    await InstanceLease.updateOne(
      { _id: INSTANCE_LEASE_SINGLETON_ID },
      {
        $set: {
          instanceId: 'server-instance-B',
          lastHeartbeatAt: new Date()
        }
      }
    );

    // 3. Wait for heartbeat cycle to detect ownership loss and fail
    await new Promise((resolve) => setTimeout(resolve, 150));

    // After heartbeat failures against the stolen lease, Instance A must self-fence
    expect(instanceLeaseService.isInstanceLeaseValid()).toBe(false);
    expect(instanceLeaseService.getActiveInstanceId()).toBe(null);
  });

  it('TS-IO-05: Reconnect partition protection (Old owner heartbeat cannot revive expired lease or overwrite newer owner)', async () => {
    // 1. Instance A acquires lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 300,
      skipHeartbeat: true
    });

    // 2. Wait for lease to expire in DB
    await new Promise((resolve) => setTimeout(resolve, 350));

    // 3. Another instance takes over
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 10000,
      skipHeartbeat: true
    });

    // 4. Instance A attempts a heartbeat renewal
    // In startHeartbeat, the query requires instanceId: 'server-instance-A' AND expiresAt: { $gt: now }
    const docBefore = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(docBefore.instanceId).toBe('server-instance-B');

    // Trying to renew as Instance A directly via findOneAndUpdate with CAS predicate:
    const now = new Date();
    const staleRenewal = await InstanceLease.findOneAndUpdate(
      {
        _id: INSTANCE_LEASE_SINGLETON_ID,
        instanceId: 'server-instance-A',
        status: INSTANCE_LEASE_STATUS.ACTIVE,
        expiresAt: { $gt: now }
      },
      {
        $set: {
          lastHeartbeatAt: now,
          expiresAt: new Date(now.getTime() + 10000)
        }
      },
      { new: true }
    );

    // Stale renewal MUST fail to update
    expect(staleRenewal).toBe(null);

    const docAfter = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(docAfter.instanceId).toBe('server-instance-B');
  });

  it('TS-IO-06: Old owner shutdown non-corruption (Fenced/stale instance does not delete replacement lease on shutdown)', async () => {
    // 1. Instance A acquires lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 300,
      skipHeartbeat: true
    });

    // 2. Instance B reclaims lease after expiry
    await new Promise((resolve) => setTimeout(resolve, 350));
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 10000,
      skipHeartbeat: true
    });

    // 3. Instance A wakes up and executes shutdown releaseInstanceLease('server-instance-A')
    const releaseResult = await instanceLeaseService.releaseInstanceLease('server-instance-A');
    expect(releaseResult.released).toBe(false);

    // Instance B's lease MUST remain intact and ACTIVE
    const doc = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(doc.instanceId).toBe('server-instance-B');
    expect(doc.status).toBe(INSTANCE_LEASE_STATUS.ACTIVE);
  });

  it('TS-IO-07: Suspend-aware watchdog / uptime deadline trigger', async () => {
    // 1. Establish known base uptime
    let uptime = 1000;
    instanceLeaseService.setSystemUptimeForTesting(() => uptime);

    // Instance A acquires lease with 1 second TTL (deadline = 1001)
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 1000,
      skipHeartbeat: true
    });

    expect(instanceLeaseService.isInstanceLeaseValid()).toBe(true);

    // 2. Simulate system suspend where os.uptime() advanced 5 seconds (uptime = 1005 > 1001)
    uptime += 5;

    // Suspend-aware check triggers lease invalidation
    expect(instanceLeaseService.isInstanceLeaseValid()).toBe(false);
  });
});
