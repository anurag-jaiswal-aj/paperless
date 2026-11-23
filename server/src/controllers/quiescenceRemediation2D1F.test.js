import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { BACKUP_LEASE_STATUS } from '../models/backupLease.js';
import InstanceLease, { INSTANCE_LEASE_STATUS } from '../models/instanceLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import * as instanceLeaseService from '../services/instanceLeaseService.js';
import * as workerCoordinationService from '../services/workerCoordinationService.js';
import * as quiescenceGateModule from '../middleware/quiescenceGate.js';
import quiescenceRoutes from '../routes/quiescenceRoutes.js';
import { withRequiredTransaction } from '../utils/dbTransaction.js';

describe('Phase 4.4 Workstream 2D.1F: Correctness & Remediation Test Suite', () => {
  let replSet;
  let app;
  const TEST_BACKUP_TOKEN = 'test-remediation-token-0123456789abcdef';

  beforeEach(async () => {
    process.env.BACKUP_INTERNAL_TOKEN = TEST_BACKUP_TOKEN;
    process.env.NODE_ENV = 'test';

    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, name: 'rs0' }
    });
    const uri = replSet.getUri();
    await mongoose.connect(uri);

    quiescenceGateModule.resetInFlightMutations();
    workerCoordinationService.resetWorkerTasks();
    quiescenceService.clearMonotonicWatchdog();
    instanceLeaseService.resetLocalLeaseDeadlineForTesting();
    quiescenceService.resetSystemUptimeForTesting();
    instanceLeaseService.resetSystemUptimeForTesting();

    app = express();
    app.use(express.json());
    app.use('/api/admin/quiescence', quiescenceRoutes);
  }, 60000);

  afterEach(async () => {
    quiescenceGateModule.resetInFlightMutations();
    workerCoordinationService.resetWorkerTasks();
    quiescenceService.clearMonotonicWatchdog();
    instanceLeaseService.stopHeartbeat();
    instanceLeaseService.resetLocalLeaseDeadlineForTesting();
    quiescenceService.resetSystemUptimeForTesting();
    instanceLeaseService.resetSystemUptimeForTesting();

    if (mongoose.connection && mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    if (replSet) {
      await replSet.stop();
    }
  });

  describe('BLK-01 & BLK-02: Drain Endpoint & Guarded Quiesce Transitions', () => {
    it('POST /drain returns 409 Conflict if lease is missing or not in DRAINING status', async () => {
      const res = await request(app)
        .post('/api/admin/quiescence/drain')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: 'non-existent-lease', timeoutMs: 100 });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.reason).toBe('LEASE_NOT_FOUND_OR_MISMATCH');
    });

    it('POST /drain with timeoutMs: 0 returns 202 Accepted when operations are still in flight', async () => {
      const acquireResult = await quiescenceService.acquire({ initialStatus: BACKUP_LEASE_STATUS.DRAINING });
      expect(acquireResult.success).toBe(true);

      // Simulate in-flight operation
      let resolveOp;
      const opPromise = new Promise((resolve) => {
        resolveOp = resolve;
      });
      quiescenceGateModule.trackMutationOperation(opPromise);

      const res = await request(app)
        .post('/api/admin/quiescence/drain')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: acquireResult.leaseId, timeoutMs: 0, autoQuiesce: true });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.isDrained).toBe(false);
      expect(res.body.status).toBe('DRAINING');
      expect(res.body.accounting.inFlightMutations).toBeGreaterThan(0);

      resolveOp();
      await quiescenceGateModule.waitForInFlightMutations(1000);
    });

    it('POST /drain completes drain and auto-transitions to QUIESCED with 200 OK', async () => {
      const acquireResult = await quiescenceService.acquire({ initialStatus: BACKUP_LEASE_STATUS.DRAINING });
      expect(acquireResult.success).toBe(true);

      // System has no in-flight operations: drain succeeds immediately
      const res = await request(app)
        .post('/api/admin/quiescence/drain')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: acquireResult.leaseId, timeoutMs: 5000, autoQuiesce: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.isDrained).toBe(true);
      expect(res.body.status).toBe('QUIESCED');

      // Verify MongoDB document is QUIESCED
      const status = await quiescenceService.getStatus();
      expect(status.status).toBe('QUIESCED');
      expect(status.isQuiesced).toBe(true);
    });

    it('POST /quiesce refuses transition with 504 DRAIN_PENDING if operations cannot drain', async () => {
      const acquireResult = await quiescenceService.acquire({ initialStatus: BACKUP_LEASE_STATUS.DRAINING });
      expect(acquireResult.success).toBe(true);

      // Create an unresolved operation that outlasts the drain timeout
      let resolveOp;
      const hangingOp = new Promise((resolve) => {
        resolveOp = resolve;
      });
      quiescenceGateModule.trackMutationOperation(hangingOp);

      const res = await request(app)
        .post('/api/admin/quiescence/quiesce')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`)
        .send({ leaseId: acquireResult.leaseId, timeoutMs: 200 });

      expect(res.status).toBe(504);
      expect(res.body.success).toBe(false);
      expect(res.body.reason).toBe('DRAIN_PENDING');

      // Verify MongoDB remains in DRAINING status (never marked QUIESCED while dirty)
      const status = await quiescenceService.getStatus();
      expect(status.status).toBe('DRAINING');

      resolveOp();
      await quiescenceGateModule.waitForInFlightMutations(1000);
    });
  });

  describe('BLK-03: Operational Accounting Diagnostics in GET /status', () => {
    it('returns processLocal accounting alongside durable MongoDB state', async () => {
      await quiescenceService.acquire({ initialStatus: BACKUP_LEASE_STATUS.DRAINING });

      let resolveOp;
      const opPromise = new Promise((resolve) => {
        resolveOp = resolve;
      });
      quiescenceGateModule.trackDatabaseOperation(opPromise, { description: 'test_db_query' });

      const res = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.durable).toBeDefined();
      expect(res.body.durable.status).toBe('DRAINING');
      expect(res.body.processLocal).toBeDefined();
      expect(res.body.processLocal.activeDatabaseOperations).toBe(1);
      expect(res.body.processLocal.isDrained).toBe(false);
      expect(res.body.isDrained).toBe(false);

      resolveOp();
      await quiescenceGateModule.waitForInFlightMutations(1000);

      const resDrained = await request(app)
        .get('/api/admin/quiescence/status')
        .set('Authorization', `Bearer ${TEST_BACKUP_TOKEN}`);

      expect(resDrained.body.processLocal.activeDatabaseOperations).toBe(0);
      expect(resDrained.body.processLocal.isDrained).toBe(true);
      expect(resDrained.body.isDrained).toBe(true);
    });
  });

  describe('Released Context Operation Dropping Remediation (quiescenceGate)', () => {
    it('tracks operation as standalone if HTTP requestContext was already released', async () => {
      // Simulate client disconnect that releases context before operation callback starts
      const releasedContext = {
        operations: new Set(),
        isReleased: true,
        isHttpClosed: true,
        isHttpFinished: true,
        tryRelease: vi.fn()
      };

      let resolveOp;
      const op = new Promise((resolve) => {
        resolveOp = resolve;
      });

      // Track with released context: must be treated as standalone
      quiescenceGateModule.trackMutationOperation(op, { requestContext: releasedContext });

      expect(quiescenceGateModule.getInFlightMutationCount()).toBe(1);
      expect(quiescenceGateModule.getActiveOperationCount()).toBe(1);

      resolveOp();
      await quiescenceGateModule.waitForInFlightMutations(1000);

      expect(quiescenceGateModule.getInFlightMutationCount()).toBe(0);
      expect(quiescenceGateModule.getActiveOperationCount()).toBe(0);
    });
  });

  describe('Shutdown State Overwrite Remediation (workerCoordinationService)', () => {
    it('never reverts workerAdmissionState to OPEN when in SHUTDOWN state', async () => {
      workerCoordinationService.closeWorkerAdmission('SHUTDOWN');
      expect(workerCoordinationService.isWorkerAdmissionClosed()).toBe(true);

      // Check quiescence when backup lease is inactive
      const active = await workerCoordinationService.isQuiescenceActive();
      expect(active).toBe(false);

      // Must remain closed/SHUTDOWN!
      expect(workerCoordinationService.isWorkerAdmissionClosed()).toBe(true);
    });
  });

  describe('BLK-04: Datastore-level Fencing & withRequiredTransaction', () => {
    it('aborts transaction if instance leadership expires during execution', async () => {
      // Simulate active instance lease
      instanceLeaseService.setLocalLeaseDeadlineForTesting(performance.now() + 5000);

      await expect(
        withRequiredTransaction(async () => {
          // Simulate sudden lease expiration mid-transaction
          instanceLeaseService.setLocalLeaseDeadlineForTesting(performance.now() - 100);
          return 'done';
        })
      ).rejects.toThrow('Instance lease expired during transaction execution');
    });

    it('rejects transaction start if remaining TTL is below 2000ms safety buffer', async () => {
      // Lease has only 1000ms remaining
      instanceLeaseService.setLocalLeaseDeadlineForTesting(performance.now() + 1000);

      await expect(
        withRequiredTransaction(async () => 'done')
      ).rejects.toThrow('Instance lease near expiration before transaction start');
    });
  });

  describe('Conservative Failover (Option B) & Quarantine Cooldown Buffer', () => {
    it('permits immediate takeover if previous instance released cleanly', async () => {
      const first = await instanceLeaseService.acquireInstanceLease({ instanceId: 'inst-clean-1', skipHeartbeat: true });
      expect(first.success).toBe(true);

      await instanceLeaseService.releaseInstanceLease('inst-clean-1');

      const second = await instanceLeaseService.acquireInstanceLease({ instanceId: 'inst-clean-2', skipHeartbeat: true });
      expect(second.success).toBe(true);
      expect(second.instanceId).toBe('inst-clean-2');
    });

    it('rejects takeover with QUARANTINE_COOLDOWN_ACTIVE if previous dirty lease expired recently', async () => {
      // Create dirty expired lease in MongoDB (status: ACTIVE, expiresAt: 5 seconds ago)
      const now = Date.now();
      await InstanceLease.findOneAndUpdate(
        { _id: instanceLeaseService.INSTANCE_LEASE_SINGLETON_ID },
        {
          $set: {
            instanceId: 'inst-dirty-crashed',
            status: INSTANCE_LEASE_STATUS.ACTIVE,
            startedAt: new Date(now - 35000),
            expiresAt: new Date(now - 5000), // Expired 5s ago (within 15s quarantine cooldown)
            lastHeartbeatAt: new Date(now - 5000),
            version: 1
          }
        },
        { upsert: true }
      );

      const takeoverAttempt = await instanceLeaseService.acquireInstanceLease({
        instanceId: 'inst-standby-takeover',
        quarantineCooldownMs: 15000,
        skipHeartbeat: true
      });

      expect(takeoverAttempt.success).toBe(false);
      expect(takeoverAttempt.reason).toBe('QUARANTINE_COOLDOWN_ACTIVE');
      expect(takeoverAttempt.remainingQuarantineMs).toBeGreaterThan(0);
      expect(takeoverAttempt.remainingQuarantineMs).toBeLessThanOrEqual(10000);
    });

    it('permits takeover after quarantine cooldown window has fully elapsed', async () => {
      const now = Date.now();
      await InstanceLease.findOneAndUpdate(
        { _id: instanceLeaseService.INSTANCE_LEASE_SINGLETON_ID },
        {
          $set: {
            instanceId: 'inst-dirty-old',
            status: INSTANCE_LEASE_STATUS.ACTIVE,
            startedAt: new Date(now - 60000),
            expiresAt: new Date(now - 20000), // Expired 20s ago (> 15s quarantine cooldown)
            lastHeartbeatAt: new Date(now - 20000),
            version: 1
          }
        },
        { upsert: true }
      );

      const takeoverAttempt = await instanceLeaseService.acquireInstanceLease({
        instanceId: 'inst-standby-takeover-success',
        quarantineCooldownMs: 15000,
        skipHeartbeat: true
      });

      expect(takeoverAttempt.success).toBe(true);
      expect(takeoverAttempt.instanceId).toBe('inst-standby-takeover-success');
    });
  });
});