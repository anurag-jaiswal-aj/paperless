import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  quiescenceGate,
  getInFlightMutationCount,
  waitForInFlightMutations,
  resetInFlightMutations,
  drainInFlight,
  isQuiescenceActive,
  setQuiescenceService
} from './quiescenceGate.js';
import * as quiescenceService from '../services/quiescenceService.js';
import BackupLease, { BACKUP_LEASE_STATUS } from '../models/backupLease.js';
import { recoverAbandonedFormDeletions } from '../controllers/formController.js';

describe('QuiescenceGate Middleware & Coordination Suite', () => {
  beforeEach(() => {
    resetInFlightMutations();
    setQuiescenceService(null);
  });

  afterEach(() => {
    resetInFlightMutations();
    setQuiescenceService(null);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. In-Flight Mutation Tracking
  // =========================================================================
  describe('In-Flight Mutation Tracking', () => {
    it('initial in-flight mutation count is 0', () => {
      expect(getInFlightMutationCount()).toBe(0);
    });

    it('increments in-flight count on mutating request and decrements on finish', async () => {
      const app = express();
      app.use(express.json());
      app.use(quiescenceGate);

      let inFlightDuringHandler = 0;
      app.post('/api/forms', (req, res) => {
        inFlightDuringHandler = getInFlightMutationCount();
        res.status(201).json({ created: true });
      });

      const response = await request(app).post('/api/forms').send({ name: 'Test Form' });

      expect(response.status).toBe(201);
      expect(inFlightDuringHandler).toBe(1);
      expect(getInFlightMutationCount()).toBe(0);
    });

    it('tracks all mutating methods: POST, PUT, PATCH, DELETE', async () => {
      const app = express();
      app.use(quiescenceGate);

      const capturedCounts = {};

      app.post('/api/items', (req, res) => {
        capturedCounts.post = getInFlightMutationCount();
        res.status(201).send();
      });
      app.put('/api/items/1', (req, res) => {
        capturedCounts.put = getInFlightMutationCount();
        res.status(200).send();
      });
      app.patch('/api/items/1', (req, res) => {
        capturedCounts.patch = getInFlightMutationCount();
        res.status(200).send();
      });
      app.delete('/api/items/1', (req, res) => {
        capturedCounts.delete = getInFlightMutationCount();
        res.status(204).send();
      });

      await request(app).post('/api/items');
      await request(app).put('/api/items/1');
      await request(app).patch('/api/items/1');
      await request(app).delete('/api/items/1');

      expect(capturedCounts.post).toBe(1);
      expect(capturedCounts.put).toBe(1);
      expect(capturedCounts.patch).toBe(1);
      expect(capturedCounts.delete).toBe(1);
      expect(getInFlightMutationCount()).toBe(0);
    });

    it('does not increment in-flight count for read requests (GET, HEAD, OPTIONS)', async () => {
      const app = express();
      app.use(quiescenceGate);

      let getCount = -1;
      app.get('/api/forms', (req, res) => {
        getCount = getInFlightMutationCount();
        res.status(200).json([]);
      });

      await request(app).get('/api/forms');
      expect(getCount).toBe(0);
      expect(getInFlightMutationCount()).toBe(0);

      await request(app).head('/api/forms');
      expect(getInFlightMutationCount()).toBe(0);

      await request(app).options('/api/forms');
      expect(getInFlightMutationCount()).toBe(0);
    });

    it('decrements count on response close if client aborts connection', async () => {
      const req = { method: 'POST', originalUrl: '/api/forms' };
      const listeners = {};
      const res = {
        on: (event, handler) => {
          listeners[event] = handler;
        },
        removeListener: vi.fn(),
        setHeader: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      };
      const next = vi.fn();

      await quiescenceGate(req, res, next);
      expect(getInFlightMutationCount()).toBe(1);
      expect(next).toHaveBeenCalledTimes(1);

      // Simulate connection close without finish
      listeners['close']();
      expect(getInFlightMutationCount()).toBe(0);

      // Ensure duplicate close or finish does not cause double-decrement
      if (listeners['finish']) listeners['finish']();
      expect(getInFlightMutationCount()).toBe(0);
    });
  });

  // =========================================================================
  // 2. Quiescence Write-Rejection (503 & Retry-After: 5)
  // =========================================================================
  describe('Quiescence Write-Rejection', () => {
    it('rejects mutating requests with 503 and Retry-After: 5 when status is QUIESCED', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => true,
        getLeaseStatus: () => ({ status: 'QUIESCED', isExpired: false })
      });

      const app = express();
      app.use(quiescenceGate);
      const businessHandler = vi.fn((req, res) => res.status(201).json({ success: true }));
      app.post('/api/forms', businessHandler);

      const res = await request(app).post('/api/forms').send({ title: 'Test' });

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toEqual({
        error: 'System is undergoing scheduled maintenance/backup',
        code: 'BACKUP_QUIESCENCE_ACTIVE'
      });
      expect(businessHandler).not.toHaveBeenCalled();
      expect(getInFlightMutationCount()).toBe(0);
    });

    it('rejects mutating requests with 503 and Retry-After: 5 when status is DRAINING', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => true,
        getLeaseStatus: () => ({ status: 'DRAINING', isExpired: false })
      });

      const app = express();
      app.use(quiescenceGate);
      app.delete('/api/responses/123', (req, res) => res.status(204).send());

      const res = await request(app).delete('/api/responses/123');

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toEqual({
        error: 'System is undergoing scheduled maintenance/backup',
        code: 'BACKUP_QUIESCENCE_ACTIVE'
      });
      expect(getInFlightMutationCount()).toBe(0);
    });

    it('allows GET requests through cleanly during QUIESCED state', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => true,
        getLeaseStatus: () => ({ status: 'QUIESCED', isExpired: false })
      });

      const app = express();
      app.use(quiescenceGate);
      app.get('/api/forms/123', (req, res) => res.status(200).json({ id: '123' }));

      const res = await request(app).get('/api/forms/123');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: '123' });
    });

    it('allows HEAD and OPTIONS requests through cleanly during DRAINING state', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => true,
        getLeaseStatus: () => ({ status: 'DRAINING', isExpired: false })
      });

      const app = express();
      app.use(quiescenceGate);
      app.get('/api/forms', (req, res) => res.status(200).send());

      const headRes = await request(app).head('/api/forms');
      expect(headRes.status).toBe(200);

      const optionsRes = await request(app).options('/api/forms');
      expect(optionsRes.status).toBe(200);
    });

    it('allows mutating requests when status is NORMAL', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => false,
        getLeaseStatus: () => ({ status: 'NORMAL', isExpired: false })
      });

      const app = express();
      app.use(quiescenceGate);
      app.post('/api/forms', (req, res) => res.status(201).json({ created: true }));

      const res = await request(app).post('/api/forms');
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ created: true });
    });
  });

  // =========================================================================
  // 3. Allowlist & Admin Route Bypass
  // =========================================================================
  describe('Allowlist & Admin Route Bypass', () => {
    it('/api/admin/quiescence/* routes ALWAYS bypass the gate, even during QUIESCED state', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => true,
        getLeaseStatus: () => ({ status: 'QUIESCED', isExpired: false })
      });

      const app = express();
      app.use(quiescenceGate);

      app.post('/api/admin/quiescence/acquire', (req, res) => res.status(200).json({ ok: true }));
      app.post('/api/admin/quiescence/heartbeat', (req, res) => res.status(200).json({ ok: true }));
      app.post('/api/admin/quiescence/release', (req, res) => res.status(200).json({ ok: true }));
      app.get('/api/admin/quiescence/status', (req, res) => res.status(200).json({ ok: true }));

      const r1 = await request(app).post('/api/admin/quiescence/acquire');
      const r2 = await request(app).post('/api/admin/quiescence/heartbeat');
      const r3 = await request(app).post('/api/admin/quiescence/release');
      const r4 = await request(app).get('/api/admin/quiescence/status');

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(r4.status).toBe(200);
      expect(getInFlightMutationCount()).toBe(0);
    });

    it('health and readiness probes bypass the gate even during QUIESCED state', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => true,
        getLeaseStatus: () => ({ status: 'QUIESCED', isExpired: false })
      });

      const app = express();
      app.use(quiescenceGate);

      app.get('/health', (req, res) => res.status(200).json({ live: true }));
      app.get('/ready', (req, res) => res.status(200).json({ ready: true }));
      app.get('/api/health', (req, res) => res.status(200).json({ live: true }));
      app.get('/api/ready', (req, res) => res.status(200).json({ ready: true }));
      app.get('/health/ready', (req, res) => res.status(200).json({ ready: true }));

      const h1 = await request(app).get('/health');
      const h2 = await request(app).get('/ready');
      const h3 = await request(app).get('/api/health');
      const h4 = await request(app).get('/api/ready');
      const h5 = await request(app).get('/health/ready');

      expect(h1.status).toBe(200);
      expect(h2.status).toBe(200);
      expect(h3.status).toBe(200);
      expect(h4.status).toBe(200);
      expect(h5.status).toBe(200);
    });
  });

  // =========================================================================
  // 4. Draining Coordination & Timeout Handling
  // =========================================================================
  describe('Draining Coordination & Timeout Handling', () => {
    let mongod;

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      await mongoose.connect(mongod.getUri());
      await BackupLease.init();
    });

    afterAll(async () => {
      await mongoose.disconnect();
      await mongod.stop();
    });

    beforeEach(async () => {
      await BackupLease.deleteMany({});
    });

    it('waitForInFlightMutations resolves immediately with true when count is 0', async () => {
      const result = await waitForInFlightMutations(500);
      expect(result).toBe(true);
    });

    it('drainInFlight helper resolves true when in-flight mutation count is 0', async () => {
      const result = await drainInFlight(500);
      expect(result).toBe(true);
    });

    it('waitForInFlightMutations waits for in-flight requests to complete', async () => {
      const app = express();
      app.use(quiescenceGate);

      let completeRequest;
      const requestHoldPromise = new Promise((resolve) => {
        completeRequest = resolve;
      });

      app.post('/api/slow', async (req, res) => {
        await requestHoldPromise;
        res.status(200).send();
      });

      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;

      // Send HTTP POST request
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/slow',
        method: 'POST'
      });
      req.end();

      // Wait a moment for handler to receive request
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getInFlightMutationCount()).toBe(1);

      // Start waiting for drain concurrently
      let drained = false;
      const drainPromise = waitForInFlightMutations(2000).then((res) => {
        drained = res;
      });

      expect(drained).toBe(false);

      // Complete request
      completeRequest();
      await drainPromise;

      expect(drained).toBe(true);
      expect(getInFlightMutationCount()).toBe(0);

      await new Promise((resolve) => server.close(resolve));
    });

    it('waitForInFlightMutations returns false when timeout expires before draining', async () => {
      const app = express();
      app.use(quiescenceGate);

      let releaseHold;
      const hold = new Promise((r) => {
        releaseHold = r;
      });

      app.post('/api/hanging', async (req, res) => {
        await hold;
        res.status(200).send();
      });

      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/hanging',
        method: 'POST'
      });
      req.end();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getInFlightMutationCount()).toBe(1);

      // Drain with short timeout (100ms)
      const drainResult = await waitForInFlightMutations(100);
      expect(drainResult).toBe(false);
      expect(getInFlightMutationCount()).toBe(1);

      // Clean up hold
      releaseHold();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getInFlightMutationCount()).toBe(0);

      await new Promise((resolve) => server.close(resolve));
    });

    it('drainInFlight fails closed to RECOVERY_REQUIRED if timeout expires', async () => {
      // 1. Simulate an in-flight mutation that starts while status is NORMAL
      const app = express();
      app.use(quiescenceGate);

      let finishHungReq;
      const hungHold = new Promise((r) => {
        finishHungReq = r;
      });

      app.post('/api/blocked', async (req, res) => {
        await hungHold;
        res.status(200).send();
      });

      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/blocked',
        method: 'POST'
      });
      req.end();

      await new Promise((r) => setTimeout(r, 50));
      expect(getInFlightMutationCount()).toBe(1);

      // 2. Now acquire lease into DRAINING status while request is in-flight
      const acquireResult = await quiescenceService.acquire({
        owner: 'test-runner',
        leaseDurationMs: 60000
      });
      expect(acquireResult.success).toBe(true);
      expect(acquireResult.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

      // 3. Call quiescenceService.drainInFlight with 150ms timeout
      const drainResult = await quiescenceService.drainInFlight(150, acquireResult.leaseId);

      expect(drainResult.success).toBe(false);
      expect(drainResult.reason).toBe('DRAIN_TIMEOUT');

      // 4. Verify lease was transitioned fail-closed to RECOVERY_REQUIRED
      const leaseAfterAbort = await BackupLease.findById('singleton').lean();
      expect(leaseAfterAbort.status).toBe(BACKUP_LEASE_STATUS.RECOVERY_REQUIRED);
      expect(leaseAfterAbort.leaseId).toBe(acquireResult.leaseId);
      expect(leaseAfterAbort.drainFailureReason).toBe('DRAIN_TIMEOUT');

      // 5. Cleanup
      finishHungReq();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => server.close(resolve));
      await quiescenceService.recoverFromDrainFailure({ force: true });
    });

    it('drainInFlight transitions lease to QUIESCED when in-flight completes within timeout', async () => {
      const acquireResult = await quiescenceService.acquire({
        owner: 'test-runner',
        leaseDurationMs: 60000
      });
      expect(acquireResult.success).toBe(true);
      expect(acquireResult.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

      // Draining with 0 active mutations should succeed immediately
      const drainResult = await quiescenceService.drainInFlight(1000, acquireResult.leaseId);
      expect(drainResult.success).toBe(true);

      const leaseAfterDrain = await BackupLease.findById('singleton').lean();
      expect(leaseAfterDrain.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);
      expect(leaseAfterDrain.leaseId).toBe(acquireResult.leaseId);
    });
  });

  // =========================================================================
  // 5. Background Worker Coordination
  // =========================================================================
  describe('Background Worker Coordination', () => {
    it('recoverAbandonedFormDeletions skips execution cleanly when quiescence is active', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => true,
        getLeaseStatus: () => ({ status: 'QUIESCED', isExpired: false })
      });

      const summary = await recoverAbandonedFormDeletions();

      expect(summary).toEqual({
        recoveredCount: 0,
        failedCount: 0,
        sweptOrphanResponses: 0,
        sweptOrphanReservations: 0,
        sweptOrphanQuestions: 0,
        completedCleanupJobs: 0,
        purgedStorageFiles: 0
      });
    });

    it('isQuiescenceActive returns true when service is DRAINING or QUIESCED', async () => {
      setQuiescenceService({
        isQuiescedOrDraining: () => true
      });
      expect(await isQuiescenceActive()).toBe(true);

      setQuiescenceService({
        isQuiescedOrDraining: () => false
      });
      expect(await isQuiescenceActive()).toBe(false);
    });
  });
});
