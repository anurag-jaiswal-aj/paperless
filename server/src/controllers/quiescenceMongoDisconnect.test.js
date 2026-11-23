import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import BackupLease from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import * as instanceLeaseService from '../services/instanceLeaseService.js';
import {
  isQuiescenceActive,
  registerWorkerTask,
  resetWorkerTasks,
  shouldPauseWorker
} from '../services/workerCoordinationService.js';
import {
  quiescenceGate,
  resetInFlightMutations,
  setQuiescenceService
} from '../middleware/quiescenceGate.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

describe('Phase 4.4 Workstream 2D.1C: MongoDB Disconnect & Fail-Closed Guard Test Suite', () => {
  let replSet;
  let savedEnv;
  let mongoUri;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.NODE_ENV = 'production'; // Enforce production fail-closed semantics
    process.env.BACKUP_INTERNAL_TOKEN = 'test-disconnect-token';

    replSet = await startReplSet([BackupLease]);
    mongoUri = replSet.getUri();
  });

  afterAll(async () => {
    process.env = savedEnv;
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }
    resetInFlightMutations();
    resetWorkerTasks();
    setQuiescenceService(null);
    quiescenceService.clearMonotonicWatchdog();
    await BackupLease.deleteMany({});
    await quiescenceService.ensureSingletonExists();
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'test-disconnect-instance',
      leaseTtlMs: 60000,
      skipHeartbeat: true
    });
  });

  afterEach(async () => {
    instanceLeaseService.stopHeartbeat();
    instanceLeaseService.resetFencedForTesting();
    resetInFlightMutations();
    resetWorkerTasks();
    setQuiescenceService(null);
    quiescenceService.clearMonotonicWatchdog();
    vi.restoreAllMocks();
  });

  it('TS-MDB-01: Mutating requests fail-closed with HTTP 503 DATABASE_UNAVAILABLE when MongoDB disconnects', async () => {
    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);
    app.post('/api/forms', (req, res) => res.status(201).json({ success: true }));

    // Verify mutating request succeeds when DB is connected
    const okRes = await request(app).post('/api/forms').send({ title: 'Online Test' });
    expect(okRes.status).toBe(201);

    // Disconnect MongoDB explicitly
    await mongoose.disconnect();
    expect(mongoose.connection.readyState).toBe(0);

    // Attempt mutating request: MUST fail closed with 503 and Retry-After: 5
    const failRes = await request(app).post('/api/forms').send({ title: 'Offline Test' });
    expect(failRes.status).toBe(503);
    expect(failRes.headers['retry-after']).toBe('5');
    expect(failRes.body.code).toBe('DATABASE_UNAVAILABLE');

    // Reconnect for cleanup
    await mongoose.connect(mongoUri);
    expect(mongoose.connection.readyState).toBe(1);

    // After reconnect, mutating requests must succeed again
    const restoredRes = await request(app).post('/api/forms').send({ title: 'Restored Test' });
    expect(restoredRes.status).toBe(201);
  });

  it('TS-MDB-02: Administrative quiescence endpoints return clean DB_DISCONNECTED error when DB is offline', async () => {
    await mongoose.disconnect();
    expect(mongoose.connection.readyState).toBe(0);

    const acquireRes = await quiescenceService.acquire({ owner: 'offline-runner' });
    expect(acquireRes.success).toBe(false);
    expect(acquireRes.reason).toBe('DB_DISCONNECTED');

    const heartbeatRes = await quiescenceService.heartbeat({ leaseId: 'any-id' });
    expect(heartbeatRes.success).toBe(false);
    expect(heartbeatRes.reason).toBe('DB_DISCONNECTED');

    const markRes = await quiescenceService.markQuiesced({ leaseId: 'any-id' });
    expect(markRes.success).toBe(false);
    expect(markRes.reason).toBe('DB_DISCONNECTED');

    const releaseRes = await quiescenceService.release({ leaseId: 'any-id' });
    expect(releaseRes.success).toBe(false);
    expect(releaseRes.reason).toBe('DB_DISCONNECTED');

    // Reconnect for subsequent tests
    await mongoose.connect(mongoUri);
  });

  it('TS-MDB-03: workerCoordinationService.isQuiescenceActive() fails closed in production when DB is offline', async () => {
    // When DB is connected, status is NORMAL -> false
    const activeWhenOnline = await isQuiescenceActive();
    expect(activeWhenOnline).toBe(false);

    // Disconnect DB
    await mongoose.disconnect();

    // When DB is disconnected in production, isQuiescenceActive must fail closed and return TRUE
    const activeWhenOffline = await isQuiescenceActive();
    expect(activeWhenOffline).toBe(true);

    // Registering a worker task while DB is offline must skip execution fail-closed
    const workerResult = await registerWorkerTask('testOfflineWorker', async () => {
      return { mutated: true };
    });
    expect(workerResult.skipped).toBe(true);
    expect(workerResult.reason).toBe('BACKUP_QUIESCENCE_ACTIVE');

    // Reconnect
    await mongoose.connect(mongoUri);
  });

  it('TS-WA-05: Multi-step background worker using shouldPauseWorker() detects MongoDB disconnect mid-execution and safely halts', async () => {
    let completedSteps = 0;
    let haltedCleanly = false;

    const workerPromise = registerWorkerTask('multiStepWorker', async (context) => {
      // Step 1: Online
      completedSteps++;

      // Mid-execution: MongoDB disconnects unexpectedly
      await mongoose.disconnect();
      expect(mongoose.connection.readyState).toBe(0);

      // Step 2 check: shouldPauseWorker() must fail closed to true in production
      if (await context.shouldPause() && await shouldPauseWorker()) {
        haltedCleanly = true;
        return { halted: true, stepsDone: completedSteps };
      }

      // Step 2 must never be executed while offline
      completedSteps++;
      return { completed: true, stepsDone: completedSteps };
    });

    const res = await workerPromise;
    expect(res.halted).toBe(true);
    expect(haltedCleanly).toBe(true);
    expect(completedSteps).toBe(1);

    // Reconnect for cleanup
    await mongoose.connect(mongoUri);
    expect(mongoose.connection.readyState).toBe(1);
  });
});
