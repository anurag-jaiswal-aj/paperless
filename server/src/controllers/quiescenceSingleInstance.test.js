import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import InstanceLease, {
  INSTANCE_LEASE_SINGLETON_ID,
  INSTANCE_LEASE_STATUS
} from '../models/instanceLease.js';
import * as instanceLeaseService from '../services/instanceLeaseService.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

describe('Phase 4.4 Workstream 2D.1C: Single-Instance Mutual Exclusion & Fencing Test Suite', () => {
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
    await InstanceLease.deleteMany({});
    await instanceLeaseService.ensureInstanceSingletonExists();
  });

  afterEach(async () => {
    instanceLeaseService.stopHeartbeat();
    vi.restoreAllMocks();
  });

  it('TS-SINST-01: Second instance attempting acquireInstanceLease fails closed when an active instance lease is held', async () => {
    // 1. Instance A boots and acquires single-instance lease
    const instanceAResult = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    expect(instanceAResult.success).toBe(true);
    expect(instanceAResult.instanceId).toBe('server-instance-A');

    // 2. Instance B boots concurrently against same database
    const instanceBResult = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    // Instance B MUST be rejected fail-closed
    expect(instanceBResult.success).toBe(false);
    expect(instanceBResult.reason).toBe('CONCURRENT_INSTANCE_ACTIVE');
    expect(instanceBResult.message).toContain('server-instance-A');
  });

  it('TS-SINST-02: Graceful release on shutdown allows a new instance to boot cleanly', async () => {
    // 1. Instance A acquires lease
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-A',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    // 2. Instance A shuts down gracefully and releases lease
    const releaseResult = await instanceLeaseService.releaseInstanceLease('server-instance-A');
    expect(releaseResult.success).toBe(true);
    expect(releaseResult.released).toBe(true);

    const doc = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(doc.status).toBe(INSTANCE_LEASE_STATUS.RELEASED);

    // 3. Instance B boots and successfully acquires lease
    const instanceBResult = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'server-instance-B',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });
    expect(instanceBResult.success).toBe(true);
    expect(instanceBResult.instanceId).toBe('server-instance-B');
  });

  it('TS-SINST-03: Stale instance lease from crashed container is reclaimed after expiry', async () => {
    // Seed an expired lease from a crashed instance
    const past = new Date(Date.now() - 5000);
    await InstanceLease.updateOne(
      { _id: INSTANCE_LEASE_SINGLETON_ID },
      {
        $set: {
          instanceId: 'crashed-instance-X',
          status: INSTANCE_LEASE_STATUS.ACTIVE,
          startedAt: new Date(Date.now() - 35000),
          expiresAt: past,
          lastHeartbeatAt: past,
          version: 1
        }
      }
    );

    // New instance boots and should reclaim stale lease
    const reclaimResult = await instanceLeaseService.acquireInstanceLease({
      instanceId: 'fresh-instance-Y',
      leaseTtlMs: 30000,
      skipHeartbeat: true
    });

    expect(reclaimResult.success).toBe(true);
    expect(reclaimResult.instanceId).toBe('fresh-instance-Y');

    const updatedDoc = await InstanceLease.findById(INSTANCE_LEASE_SINGLETON_ID).lean();
    expect(updatedDoc.instanceId).toBe('fresh-instance-Y');
    expect(updatedDoc.status).toBe(INSTANCE_LEASE_STATUS.ACTIVE);
  });
});
