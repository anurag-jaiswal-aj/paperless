import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from './quiescenceService.js';

describe('QuiescenceService MongoDB Durability & Concurrency Suite', () => {
  let mongod;

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await BackupLease.init();
    await BackupLease.createIndexes();
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Model & Durability Guarantees
  // =========================================================================
  describe('BackupLease Model & Durability Guarantees', () => {
    it('persists backup lease state directly in MongoDB backup_leases collection', async () => {
      await quiescenceService.ensureSingletonExists();
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();

      expect(doc).toBeDefined();
      expect(doc._id).toBe('singleton');
      expect(doc.status).toBe('NORMAL');
      expect(doc.leaseId).toBeNull();
      expect(doc.version).toBe(0);
    });

    it('has index on expiresAt for fast lookup and lease expiration queries', async () => {
      const indexes = await BackupLease.collection.indexes();
      const expiresAtIndex = indexes.find((idx) => idx.key && idx.key.expiresAt === 1);

      expect(expiresAtIndex).toBeDefined();
    });

    it('enforces status enum strictly at schema level', async () => {
      const invalidDoc = new BackupLease({
        _id: 'singleton',
        status: 'INVALID_STATUS'
      });

      await expect(invalidDoc.validate()).rejects.toThrow();
    });
  });

  // =========================================================================
  // 2. Atomic Lease Acquisition (acquire)
  // =========================================================================
  describe('Atomic Lease Acquisition (acquire)', () => {
    it('acquires lease successfully when in NORMAL status', async () => {
      const t0 = Date.now();
      const res = await quiescenceService.acquire({
        owner: 'backup-agent-1',
        leaseDurationMs: 60000,
        maxWatchdogMs: 300000
      });

      expect(res.success).toBe(true);
      expect(res.leaseId).toBeDefined();
      expect(typeof res.leaseId).toBe('string');
      expect(res.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(res.owner).toBe('backup-agent-1');
      expect(res.grantedAt).toBeInstanceOf(Date);
      expect(res.expiresAt).toBeInstanceOf(Date);
      expect(res.monotonicWatchdogDeadline).toBeInstanceOf(Date);
      expect(res.expiresAt.getTime()).toBeGreaterThanOrEqual(t0 + 59000);
      expect(res.monotonicWatchdogDeadline.getTime()).toBeGreaterThanOrEqual(t0 + 299000);

      // Verify persisted in MongoDB
      const persisted = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(persisted.leaseId).toBe(res.leaseId);
      expect(persisted.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(persisted.version).toBe(1);
    });

    it('supports direct QUIESCED initialStatus if requested', async () => {
      const res = await quiescenceService.acquire({
        initialStatus: BACKUP_LEASE_STATUS.QUIESCED
      });

      expect(res.success).toBe(true);
      expect(res.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
    });

    it('rejects concurrent lease acquisition when active lease is held', async () => {
      const first = await quiescenceService.acquire({
        owner: 'agent-alpha',
        leaseDurationMs: 60000
      });
      expect(first.success).toBe(true);

      const second = await quiescenceService.acquire({
        owner: 'agent-beta',
        leaseDurationMs: 60000
      });

      expect(second.success).toBe(false);
      expect(second.reason).toBe('CONCURRENT_LEASE_ACTIVE');
      expect(second.currentLease).toBeDefined();
      expect(second.currentLease.leaseId).toBe(first.leaseId);
      expect(second.currentLease.owner).toBe('agent-alpha');
      expect(second.currentLease.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
    });

    it('handles high-concurrency race: 10 parallel acquire attempts allow exactly 1 winner', async () => {
      await quiescenceService.ensureSingletonExists();

      const callers = Array.from({ length: 10 }, (_, i) =>
        quiescenceService.acquire({
          owner: `concurrent-worker-${i}`,
          leaseDurationMs: 30000
        })
      );

      const results = await Promise.all(callers);
      const successes = results.filter((r) => r.success);
      const rejections = results.filter((r) => !r.success);

      expect(successes).toHaveLength(1);
      expect(rejections).toHaveLength(9);
      rejections.forEach((rej) => {
        expect(rej.reason).toBe('CONCURRENT_LEASE_ACTIVE');
        expect(rej.currentLease.leaseId).toBe(successes[0].leaseId);
      });
    });

    it('auto-recovers stale expired lease on acquire', async () => {
      // Setup a stale expired lease in DB
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: 'stale-uuid-1234',
            owner: 'dead-agent',
            grantedAt: new Date(Date.now() - 100000),
            expiresAt: new Date(Date.now() - 5000), // Expired 5 seconds ago
            monotonicWatchdogDeadline: new Date(Date.now() + 50000),
            version: 3
          }
        },
        { upsert: true }
      );

      const res = await quiescenceService.acquire({
        owner: 'new-agent',
        leaseDurationMs: 60000
      });

      expect(res.success).toBe(true);
      expect(res.leaseId).not.toBe('stale-uuid-1234');
      expect(res.owner).toBe('new-agent');
      expect(res.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

      // Verify MongoDB updated
      const updated = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(updated.leaseId).toBe(res.leaseId);
      expect(updated.version).toBe(4);
    });
  });

  // =========================================================================
  // 3. Heartbeat Renewal (heartbeat)
  // =========================================================================
  describe('Heartbeat Renewal (heartbeat)', () => {
    it('extends expiresAt for active lease and updates lastHeartbeatAt', async () => {
      const acq = await quiescenceService.acquire({
        leaseDurationMs: 30000,
        maxWatchdogMs: 300000
      });

      const originalExpiresAt = acq.expiresAt;

      // Advance time slightly
      const extendMs = 45000;
      const hb = await quiescenceService.heartbeat({
        leaseId: acq.leaseId,
        heartbeatExtendMs: extendMs
      });

      expect(hb.success).toBe(true);
      expect(hb.leaseId).toBe(acq.leaseId);
      expect(hb.expiresAt.getTime()).toBeGreaterThan(originalExpiresAt.getTime());
      expect(hb.lastHeartbeatAt).toBeInstanceOf(Date);

      // Check DB
      const dbDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(dbDoc.expiresAt.getTime()).toBe(hb.expiresAt.getTime());
      expect(dbDoc.version).toBe(acq.version + 1);
    });

    it('rejects heartbeat if leaseId is missing', async () => {
      const hb = await quiescenceService.heartbeat({});
      expect(hb.success).toBe(false);
      expect(hb.reason).toBe('INVALID_LEASE_ID');
    });

    it('rejects heartbeat if leaseId does not match active lease', async () => {
      const acq = await quiescenceService.acquire({ leaseDurationMs: 30000 });
      expect(acq.success).toBe(true);
      const hb = await quiescenceService.heartbeat({ leaseId: 'wrong-uuid-9999' });

      expect(hb.success).toBe(false);
      expect(hb.reason).toBe('LEASE_NOT_FOUND_OR_MISMATCH');
    });

    it('rejects heartbeat if lease has already expired', async () => {
      const acq = await quiescenceService.acquire({ leaseDurationMs: 30000 });

      // Mutate expiresAt to the past
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );

      const hb = await quiescenceService.heartbeat({
        leaseId: acq.leaseId,
        heartbeatExtendMs: 30000
      });

      expect(hb.success).toBe(false);
      expect(hb.reason).toBe('LEASE_EXPIRED');
    });

    it('caps renewal at monotonicWatchdogDeadline', async () => {
      const now = Date.now();
      const watchdogDeadline = new Date(now + 20000); // 20s from now

      const acq = await quiescenceService.acquire({
        leaseDurationMs: 10000,
        maxWatchdogMs: 20000
      });

      // Attempt to extend by 60s (exceeds 20s watchdog)
      const hb = await quiescenceService.heartbeat({
        leaseId: acq.leaseId,
        heartbeatExtendMs: 60000
      });

      expect(hb.success).toBe(true);
      // Expiry must be capped at watchdogDeadline
      expect(hb.expiresAt.getTime()).toBeLessThanOrEqual(watchdogDeadline.getTime() + 100);
      expect(hb.expiresAt.getTime()).toBe(acq.monotonicWatchdogDeadline.getTime());
    });

    it('rejects heartbeat when monotonicWatchdogDeadline has passed', async () => {
      const acq = await quiescenceService.acquire({ leaseDurationMs: 30000 });

      // Mutate monotonicWatchdogDeadline to past
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { monotonicWatchdogDeadline: new Date(Date.now() - 100) } }
      );

      const hb = await quiescenceService.heartbeat({
        leaseId: acq.leaseId,
        heartbeatExtendMs: 30000
      });

      expect(hb.success).toBe(false);
      expect(hb.reason).toBe('WATCHDOG_DEADLINE_EXCEEDED');
    });

    it('rejects heartbeat if lease is not in DRAINING or QUIESCED status', async () => {
      const acq = await quiescenceService.acquire({ leaseDurationMs: 30000 });

      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { status: BACKUP_LEASE_STATUS.NORMAL } }
      );

      const hb = await quiescenceService.heartbeat({
        leaseId: acq.leaseId,
        heartbeatExtendMs: 30000
      });

      expect(hb.success).toBe(false);
      expect(hb.reason).toBe('INVALID_STATUS');
    });
  });

  // =========================================================================
  // 4. Atomic Lease Release (release)
  // =========================================================================
  describe('Atomic Lease Release (release)', () => {
    it('releases active lease and resets status to NORMAL', async () => {
      const acq = await quiescenceService.acquire({ leaseDurationMs: 30000 });
      expect(acq.success).toBe(true);

      const rel = await quiescenceService.release({ leaseId: acq.leaseId });
      expect(rel.success).toBe(true);
      expect(rel.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

      // Verify DB state
      const dbDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(dbDoc.status).toBe('NORMAL');
      expect(dbDoc.leaseId).toBeNull();
      expect(dbDoc.expiresAt).toBeNull();
      expect(dbDoc.owner).toBeNull();
      expect(dbDoc.monotonicWatchdogDeadline).toBeNull();
    });

    it('rejects release if leaseId is missing', async () => {
      const rel = await quiescenceService.release({});
      expect(rel.success).toBe(false);
      expect(rel.reason).toBe('INVALID_LEASE_ID');
    });

    it('rejects release if leaseId does not match active lease', async () => {
      const acq = await quiescenceService.acquire({ leaseDurationMs: 30000 });
      const rel = await quiescenceService.release({ leaseId: 'unmatched-uuid' });

      expect(rel.success).toBe(false);
      expect(rel.reason).toBe('LEASE_NOT_FOUND_OR_MISMATCH');

      // Verify lease is still active
      const dbDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(dbDoc.leaseId).toBe(acq.leaseId);
      expect(dbDoc.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
    });

    it('permits immediate re-acquisition after release', async () => {
      const first = await quiescenceService.acquire({ owner: 'agent-1' });
      await quiescenceService.release({ leaseId: first.leaseId });

      const second = await quiescenceService.acquire({ owner: 'agent-2' });
      expect(second.success).toBe(true);
      expect(second.owner).toBe('agent-2');
      expect(second.leaseId).not.toBe(first.leaseId);
    });
  });

  // =========================================================================
  // 5. Transition to QUIESCED (markQuiesced)
  // =========================================================================
  describe('Transition to QUIESCED (markQuiesced)', () => {
    it('transitions status from DRAINING to QUIESCED', async () => {
      const acq = await quiescenceService.acquire({ initialStatus: BACKUP_LEASE_STATUS.DRAINING });
      expect(acq.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

      const res = await quiescenceService.markQuiesced({ leaseId: acq.leaseId });
      expect(res.success).toBe(true);
      expect(res.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

      const dbDoc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(dbDoc.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
    });

    it('rejects markQuiesced for expired lease or wrong leaseId', async () => {
      const acq = await quiescenceService.acquire({});
      expect(acq.success).toBe(true);
      const wrong = await quiescenceService.markQuiesced({ leaseId: 'non-existent-uuid' });
      expect(wrong.success).toBe(false);
      expect(wrong.reason).toBe('LEASE_NOT_FOUND_OR_EXPIRED');
    });
  });

  // =========================================================================
  // 6. Status Queries (getStatus, isQuiesced, isDrainingOrQuiesced)
  // =========================================================================
  describe('Status Queries', () => {
    it('returns NORMAL status when no lease has ever been acquired', async () => {
      const status = await quiescenceService.getStatus();
      expect(status.success).toBe(true);
      expect(status.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(status.leaseId).toBeNull();
      expect(status.isQuiesced).toBe(false);
      expect(status.isExpired).toBe(false);
      expect(status.remainingDurationMs).toBe(0);
    });

    it('returns active lease details and remaining duration', async () => {
      const acq = await quiescenceService.acquire({
        owner: 'monitor-agent',
        leaseDurationMs: 60000
      });

      const status = await quiescenceService.getStatus();
      expect(status.success).toBe(true);
      expect(status.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(status.leaseId).toBe(acq.leaseId);
      expect(status.owner).toBe('monitor-agent');
      expect(status.remainingDurationMs).toBeGreaterThan(0);
      expect(status.isQuiesced).toBe(false);
    });

    it('reports effective status as NORMAL if lease has expired in DB', async () => {
      await quiescenceService.acquire({ leaseDurationMs: 30000 });

      // Expire it in DB
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        { $set: { expiresAt: new Date(Date.now() - 5000) } }
      );

      const status = await quiescenceService.getStatus();
      expect(status.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(status.isExpired).toBe(true);
      expect(status.leaseId).toBeNull();
      expect(status.remainingDurationMs).toBe(0);
    });

    it('correctly reports boolean predicates isQuiesced and isDrainingOrQuiesced', async () => {
      expect(await quiescenceService.isQuiesced()).toBe(false);
      expect(await quiescenceService.isDrainingOrQuiesced()).toBe(false);

      const acq = await quiescenceService.acquire({ initialStatus: BACKUP_LEASE_STATUS.DRAINING });
      expect(await quiescenceService.isQuiesced()).toBe(false);
      expect(await quiescenceService.isDrainingOrQuiesced()).toBe(true);

      await quiescenceService.markQuiesced({ leaseId: acq.leaseId });
      expect(await quiescenceService.isQuiesced()).toBe(true);
      expect(await quiescenceService.isDrainingOrQuiesced()).toBe(true);

      await quiescenceService.release({ leaseId: acq.leaseId });
      expect(await quiescenceService.isQuiesced()).toBe(false);
      expect(await quiescenceService.isDrainingOrQuiesced()).toBe(false);
    });
  });

  // =========================================================================
  // 7. Restart Initialization & Stale Recovery (initialize)
  // =========================================================================
  describe('Restart Initialization & Stale Recovery (initialize)', () => {
    it('creates singleton in NORMAL status if DB is empty on boot', async () => {
      const init = await quiescenceService.initialize();
      expect(init.success).toBe(true);
      expect(init.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(init.recovered).toBe(false);

      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc).toBeDefined();
      expect(doc.status).toBe('NORMAL');
    });

    it('auto-recovers stale expired lease to NORMAL on startup sweep', async () => {
      // Create expired lease in DB
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: 'crashed-worker-lease',
            expiresAt: new Date(Date.now() - 10000), // Expired 10s ago
            monotonicWatchdogDeadline: new Date(Date.now() + 60000),
            version: 2
          }
        },
        { upsert: true }
      );

      const init = await quiescenceService.initialize();
      expect(init.success).toBe(true);
      expect(init.recovered).toBe(true);
      expect(init.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
      expect(init.previousLeaseId).toBe('crashed-worker-lease');

      // Verify DB state is reset to NORMAL
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe('NORMAL');
      expect(doc.leaseId).toBeNull();
      expect(doc.expiresAt).toBeNull();
    });

    it('preserves and restores active unexpired lease on startup sweep', async () => {
      // Create valid active lease in DB
      const futureExpiry = new Date(Date.now() + 60000);
      await BackupLease.updateOne(
        { _id: BACKUP_LEASE_SINGLETON_ID },
        {
          $set: {
            status: BACKUP_LEASE_STATUS.QUIESCED,
            leaseId: 'active-surviving-lease',
            owner: 'external-coordinator',
            expiresAt: futureExpiry,
            monotonicWatchdogDeadline: new Date(Date.now() + 300000),
            version: 5
          }
        },
        { upsert: true }
      );

      const init = await quiescenceService.initialize();
      expect(init.success).toBe(true);
      expect(init.recovered).toBe(false);
      expect(init.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
      expect(init.activeLeaseId).toBe('active-surviving-lease');
      expect(init.owner).toBe('external-coordinator');

      // Verify DB was NOT overwritten
      const doc = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(doc.status).toBe('QUIESCED');
      expect(doc.leaseId).toBe('active-surviving-lease');
    });
  });
});
