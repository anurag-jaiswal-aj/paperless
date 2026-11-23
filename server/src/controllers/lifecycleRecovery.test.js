import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';

describe('Phase 4.4 Workstream 2D.1J: Lifecycle Recovery & TTL Monitor Verification Suite', () => {
  let mongod;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await BackupLease.init();
    await BackupLease.createIndexes();
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    vi.restoreAllMocks();
  });

  it('TS-LR-01: Validates backup lease schema enum integrity', async () => {
    const validStates = [
      'NORMAL',
      'ACQUIRING',
      'DRAINING',
      'DRAINED',
      'QUIESCED',
      'CAPTURING',
      'STORAGE_STOPPING',
      'STORAGE_OFFLINE',
      'CAPTURE_COMPLETE',
      'RELEASING',
      'RECOVERY_REQUIRED'
    ];

    expect(Object.values(BACKUP_LEASE_STATUS)).toEqual(validStates);

    for (const state of validStates) {
      const doc = new BackupLease({
        _id: `test-${state}`,
        status: state,
        version: 1
      });
      await expect(doc.validate()).resolves.toBeUndefined();
    }

    const invalidDoc = new BackupLease({
      _id: 'test-invalid',
      status: 'NON_EXISTENT_STATE'
    });
    await expect(invalidDoc.validate()).rejects.toThrow();
  });

  it('TS-LR-02: markQuiesced dynamically disables TTLMonitor and sets generation', async () => {
    // 1. Acquire lease into DRAINING
    const acquireRes = await quiescenceService.acquire({
      leaseDurationMs: 60000,
      initialStatus: BACKUP_LEASE_STATUS.DRAINING
    });
    expect(acquireRes.success).toBe(true);

    let doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(doc.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
    expect(doc.ttlMonitorDisabled).toBe(false);

    // 2. Mark Quiesced
    const quiesceRes = await quiescenceService.markQuiesced({
      leaseId: acquireRes.leaseId,
      enforceDrain: false
    });
    expect(quiesceRes.success).toBe(true);

    // 3. Verify TTLMonitor is disabled and generation/quiescedAt are recorded
    doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(doc.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
    expect(doc.ttlMonitorDisabled).toBe(true);
    expect(doc.quiescedAt).toBeDefined();
    expect(typeof doc.generation).toBe('number');
    expect(doc.generation).toBeGreaterThanOrEqual(1);
  });

  it('TS-LR-03: release re-enables TTLMonitor fail-safe and resets lease state to NORMAL', async () => {
    const acquireRes = await quiescenceService.acquire({
      leaseDurationMs: 60000,
      initialStatus: BACKUP_LEASE_STATUS.DRAINING
    });
    await quiescenceService.markQuiesced({
      leaseId: acquireRes.leaseId,
      enforceDrain: false
    });

    let doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(doc.ttlMonitorDisabled).toBe(true);

    // Release lease
    const releaseRes = await quiescenceService.release({
      leaseId: acquireRes.leaseId
    });
    expect(releaseRes.success).toBe(true);

    // Verify TTLMonitor re-enabled and state normalized
    doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
    expect(doc.ttlMonitorDisabled).toBe(false);
    expect(doc.leaseId).toBeNull();
  });

  it('TS-LR-04: initialize preserves ttlMonitorDisabled for unexpired QUIESCED/CAPTURING backup sessions', async () => {
    // Simulate crash during CAPTURING while lease is still unexpired
    await BackupLease.updateOne(
      { _id: BACKUP_LEASE_SINGLETON_ID },
      {
        $set: {
          status: BACKUP_LEASE_STATUS.QUIESCED,
          leaseId: 'crash-session-123',
          expiresAt: new Date(Date.now() + 120000),
          ttlMonitorDisabled: true,
          generation: 4
        }
      }
    );

    await quiescenceService.initialize();

    const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(doc.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
    expect(doc.ttlMonitorDisabled).toBe(true);
    expect(doc.leaseId).toBe('crash-session-123');
  });

  it('TS-LR-05: initialize auto-recovers expired lease and re-enables TTLMonitor', async () => {
    // Simulate crash where lease has expired
    await BackupLease.updateOne(
      { _id: BACKUP_LEASE_SINGLETON_ID },
      {
        $set: {
          status: BACKUP_LEASE_STATUS.QUIESCED,
          leaseId: 'dead-session-456',
          expiresAt: new Date(Date.now() - 30000), // expired 30s ago
          ttlMonitorDisabled: true
        }
      }
    );

    await quiescenceService.initialize();

    const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(doc.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
    expect(doc.ttlMonitorDisabled).toBe(false);
    expect(doc.leaseId).toBeNull();
  });

  it('TS-LR-06: Line 355 resolution - active unexpired lease cannot be acquired by another bootId/runner', async () => {
    // Instance A acquires lease with bootId "boot-AAA"
    const now = new Date();
    await BackupLease.updateOne(
      { _id: BACKUP_LEASE_SINGLETON_ID },
      {
        $set: {
          status: BACKUP_LEASE_STATUS.DRAINING,
          leaseId: 'lease-runner-A',
          bootId: 'boot-AAA',
          expiresAt: new Date(now.getTime() + 60000) // active for 60s
        }
      }
    );

    // Another runner with a different bootId attempts to acquire lease
    // Previously, line 355 had { bootId: { $nin: [null, currentBootId] } } which erroneously allowed theft
    const acquireRes = await quiescenceService.acquire({
      leaseDurationMs: 30000
    });

    expect(acquireRes.success).toBe(false);
    expect(acquireRes.reason).toBe('CONCURRENT_LEASE_ACTIVE');

    // Confirm lease was NOT stolen
    const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
    expect(doc.leaseId).toBe('lease-runner-A');
    expect(doc.bootId).toBe('boot-AAA');
  });
});
