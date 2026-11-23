import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

describe('Phase 4.4 Workstream 2D.1C: Quiescence Initialization & Recovery Race Test Suite', () => {
  let replSet;
  let savedEnv;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.BACKUP_INTERNAL_TOKEN = 'test-race-token';
    process.env.BACKUP_LEASE_DURATION_MS = '60000';
    process.env.BACKUP_MAX_WATCHDOG_MS = '180000';

    replSet = await startReplSet([BackupLease]);
  });

  afterAll(async () => {
    process.env = savedEnv;
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    quiescenceService.clearMonotonicWatchdog();
    await BackupLease.deleteMany({});
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    quiescenceService.clearMonotonicWatchdog();
    vi.restoreAllMocks();
  });

  it('TS-RACE-01: 10 parallel initialize() calls recovering an expired lease resolve safely without OCC collisions', async () => {
    // Seed an expired lease in DRAINING state
    const past = new Date(Date.now() - 10000);
    await BackupLease.updateOne(
      { _id: BACKUP_LEASE_SINGLETON_ID },
      {
        $set: {
          status: BACKUP_LEASE_STATUS.DRAINING,
          leaseId: 'expired-lease-to-recover',
          owner: 'old-runner',
          grantedAt: new Date(Date.now() - 70000),
          expiresAt: past,
          hardDeadline: past,
          version: 1
        }
      }
    );

    // Launch 10 parallel initialize() calls
    const results = await Promise.all(
      Array.from({ length: 10 }, () => quiescenceService.initialize())
    );

    // All 10 must resolve cleanly with success: true
    expect(results).toHaveLength(10);
    for (const res of results) {
      expect(res.success).toBe(true);
    }

    // At least one caller reported recovered: true
    const recoveryCount = results.filter((r) => r.recovered === true).length;
    expect(recoveryCount).toBeGreaterThanOrEqual(1);

    // The singleton document must be in NORMAL state with exactly 1 document in collection
    const finalDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(finalDoc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
    expect(finalDoc.leaseId).toBeNull();
    const count = await BackupLease.countDocuments();
    expect(count).toBe(1);
  });

  it('TS-RACE-02: Race between initialize() recovery and concurrent acquire() resolves cleanly', async () => {
    // Seed an expired lease
    const past = new Date(Date.now() - 5000);
    await BackupLease.updateOne(
      { _id: BACKUP_LEASE_SINGLETON_ID },
      {
        $set: {
          status: BACKUP_LEASE_STATUS.QUIESCED,
          leaseId: 'stale-quiesced-lease',
          owner: 'stale-owner',
          grantedAt: new Date(Date.now() - 65000),
          expiresAt: past,
          hardDeadline: past,
          version: 2
        }
      }
    );

    // Concurrently launch initialize() and acquire()
    const [initRes, acquireRes] = await Promise.all([
      quiescenceService.initialize(),
      quiescenceService.acquire({ owner: 'new-active-runner' })
    ]);

    expect(initRes.success).toBe(true);

    // Acquire either succeeds or reports concurrent lease active cleanly
    expect(typeof acquireRes.success).toBe('boolean');

    // Final DB state must be consistent: either NORMAL (if init won last) or DRAINING (if acquire won)
    const currentDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect([BACKUP_LEASE_STATUS.NORMAL, BACKUP_LEASE_STATUS.DRAINING]).toContain(currentDoc.status);
    const docCount = await BackupLease.countDocuments();
    expect(docCount).toBe(1);
  });

  it('TS-RACE-03: Repeated initialize() calls on an active unexpired lease preserve the lease', async () => {
    // Acquire active lease
    const acquireRes = await quiescenceService.acquire({
      owner: 'active-owner',
      leaseDurationMs: 60000,
      maxWatchdogMs: 180000,
      initialStatus: BACKUP_LEASE_STATUS.QUIESCED
    });
    expect(acquireRes.success).toBe(true);
    expect(acquireRes.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

    // Call initialize() 3 times sequentially
    const r1 = await quiescenceService.initialize();
    const r2 = await quiescenceService.initialize();
    const r3 = await quiescenceService.initialize();

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);

    // The lease must remain QUIESCED and un-cleared
    const leaseDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(leaseDoc.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
    expect(leaseDoc.leaseId).toBe(acquireRes.leaseId);
  });
});
