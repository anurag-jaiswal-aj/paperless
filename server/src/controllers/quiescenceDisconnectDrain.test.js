import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import mongoose from 'mongoose';
import BackupLease, {
  BACKUP_LEASE_SINGLETON_ID,
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import Form from '../models/form.js';
import Response from '../models/response.js';
import * as quiescenceService from '../services/quiescenceService.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import { withRequiredTransaction } from '../utils/dbTransaction.js';
import storageService from '../services/StorageService.js';
import {
  quiescenceGate,
  getInFlightMutationCount,
  getActiveOperationCount,
  resetInFlightMutations,
  trackMutationOperation,
  withMutationScope,
  waitForInFlightMutations,
  drainInFlight,
  setQuiescenceService
} from '../middleware/quiescenceGate.js';

const TEST_BACKUP_TOKEN = 'test-disconnect-drain-token-123456';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForInFlightMutation = async (timeoutMs = 3000) => {
  const start = Date.now();
  while (getInFlightMutationCount() === 0 && Date.now() - start < timeoutMs) {
    await sleep(10);
  }
};

describe('Phase 4.4 Workstream 2D.1A: HTTP Disconnects & Asynchronous Mutation Tracking Adversarial Suite', () => {
  let replSet;
  let savedEnv;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.BACKUP_INTERNAL_TOKEN = TEST_BACKUP_TOKEN;
    process.env.BACKUP_LEASE_DURATION_MS = '60000';
    process.env.BACKUP_MAX_WATCHDOG_MS = '180000';
    process.env.BACKUP_HEARTBEAT_EXTEND_MS = '30000';

    replSet = await startReplSet([BackupLease, Form, Response]);
  });

  afterAll(async () => {
    process.env = savedEnv;
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    resetInFlightMutations();
    setQuiescenceService(null);
    await BackupLease.deleteMany({});
    await Form.deleteMany({});
    await Response.deleteMany({});
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    resetInFlightMutations();
    setQuiescenceService(null);
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Test 1: Client disconnects before database write starts
  // =========================================================================
  it('Scenario 1: Client disconnects before database write starts releases tracking cleanly without count leaks', async () => {
    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    let dbWriteStarted = false;
    let dbWriteCompleted = false;

    app.post('/api/pre-db-disconnect', async (req, res) => {
      if (req.destroyed || res.writableEnded) {
        return;
      }
      await trackMutationOperation(async () => {
        dbWriteStarted = true;
        await sleep(50);
        dbWriteCompleted = true;
      });
      res.status(201).json({ success: true });
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/pre-db-disconnect',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      clientReq.on('error', () => {});

      clientReq.write(JSON.stringify({ name: 'test' }));
      clientReq.destroy();

      await sleep(100);

      expect(getInFlightMutationCount()).toBe(0);
      expect(getActiveOperationCount()).toBe(0);
      const drained = await waitForInFlightMutations(500);
      expect(drained).toBe(true);
      expect(dbWriteStarted).toBe(false);
      expect(dbWriteCompleted).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Test 2: Client disconnects during a delayed database write (e.g. 500ms delay)
  // =========================================================================
  it('Scenario 2: Client disconnects during a delayed database write prevents premature drain until write settles', async () => {
    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    let writeFinished = false;
    let savedDocId = null;

    app.post('/api/delayed-write', async (req, res) => {
      await trackMutationOperation(async () => {
        await sleep(350);
        const form = await Form.create({
          title: 'Persisted After Disconnect',
          ownerId: new mongoose.Types.ObjectId()
        });
        savedDocId = form._id.toString();
        writeFinished = true;
      });
      if (!res.writableEnded) {
        res.status(201).json({ success: true });
      }
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/delayed-write',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      clientReq.on('error', () => {});

      clientReq.write(JSON.stringify({ data: 'payload' }));
      clientReq.end();

      await waitForInFlightMutation();
      expect(getInFlightMutationCount()).toBe(1);
      expect(getActiveOperationCount()).toBe(1);

      // Client abruptly aborts connection mid-flight
      clientReq.destroy();

      let drainResolved = false;
      const drainPromise = drainInFlight(2000).then((res) => {
        drainResolved = res;
        return res;
      });

      // At 150ms: Client is disconnected, but DB write is STILL running!
      await sleep(100);
      expect(writeFinished).toBe(false);
      expect(drainResolved).toBe(false);
      expect(getInFlightMutationCount()).toBe(1);
      expect(getActiveOperationCount()).toBe(1);

      // Wait for delayed write to finish (around 350ms total)
      await sleep(300);
      expect(writeFinished).toBe(true);

      await drainPromise;
      expect(drainResolved).toBe(true);
      expect(getInFlightMutationCount()).toBe(0);
      expect(getActiveOperationCount()).toBe(0);

      const found = await Form.findById(savedDocId);
      expect(found).not.toBeNull();
      expect(found.title).toBe('Persisted After Disconnect');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Test 3: Client disconnects during storage promotion
  // =========================================================================
  it('Scenario 3: Client disconnects during storage promotion keeps tracking active until S3 promotion finishes', async () => {
    let copyStarted = false;
    let copyFinished = false;

    const originalCopyFile = storageService.copyFile;
    vi.spyOn(storageService, 'copyFile').mockImplementation(async (src, dest) => {
      copyStarted = true;
      await sleep(300);
      copyFinished = true;
      return { success: true, key: dest };
    });

    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    app.post('/api/promote-storage', async (req, res) => {
      await trackMutationOperation(async () => {
        await storageService.copyFile('staging/form1/file1.png', 'forms/form1/responses/file1.png');
      });
      if (!res.writableEnded) {
        res.status(200).json({ promoted: true });
      }
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/promote-storage',
        method: 'POST'
      });
      clientReq.on('error', () => {});
      clientReq.end();

      await waitForInFlightMutation();
      expect(copyStarted).toBe(true);
      expect(getInFlightMutationCount()).toBe(1);

      clientReq.destroy();

      let drained = false;
      const drainPromise = drainInFlight(1500).then((res) => {
        drained = res;
      });

      await sleep(100);
      expect(copyFinished).toBe(false);
      expect(drained).toBe(false);
      expect(getInFlightMutationCount()).toBe(1);

      await sleep(250);
      expect(copyFinished).toBe(true);

      await drainPromise;
      expect(drained).toBe(true);
      expect(getInFlightMutationCount()).toBe(0);
      expect(getActiveOperationCount()).toBe(0);
    } finally {
      if (originalCopyFile) storageService.copyFile = originalCopyFile;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Test 4: Database operation fails after client disconnect
  // =========================================================================
  it('Scenario 4: Database operation fails after client disconnect safely releases tracking handle with zero count leak', async () => {
    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    let errorThrown = false;

    app.post('/api/failing-db', async (req, res) => {
      try {
        await trackMutationOperation(async () => {
          await sleep(200);
          errorThrown = true;
          throw new Error('Simulated MongoDB Write Collision');
        });
        if (!res.writableEnded) {
          res.status(200).json({ ok: true });
        }
      } catch (err) {
        if (!res.writableEnded) {
          res.status(500).json({ error: err.message });
        }
      }
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/failing-db',
        method: 'POST'
      });
      clientReq.on('error', () => {});
      clientReq.end();

      await waitForInFlightMutation();
      expect(getInFlightMutationCount()).toBe(1);

      clientReq.destroy();

      const drainPromise = drainInFlight(1500);

      await sleep(250);
      expect(errorThrown).toBe(true);

      const drained = await drainPromise;
      expect(drained).toBe(true);
      expect(getInFlightMutationCount()).toBe(0);
      expect(getActiveOperationCount()).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Test 5: Storage operation fails after client disconnect
  // =========================================================================
  it('Scenario 5: Storage operation fails after client disconnect releases tracking handle reliably without count leak', async () => {
    let s3Failed = false;
    vi.spyOn(storageService, 'copyFile').mockImplementation(async () => {
      await sleep(150);
      s3Failed = true;
      throw new Error('S3 500 SlowDown: Storage Rate Exceeded');
    });

    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    app.post('/api/failing-storage', async (req, res) => {
      try {
        await trackMutationOperation(async () => {
          await storageService.copyFile('staged/key', 'final/key');
        });
        if (!res.writableEnded) {
          res.status(200).send();
        }
      } catch (err) {
        if (!res.writableEnded) {
          res.status(500).send();
        }
      }
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/failing-storage',
        method: 'POST'
      });
      clientReq.on('error', () => {});
      clientReq.end();

      await sleep(40);
      expect(getInFlightMutationCount()).toBe(1);

      clientReq.destroy();

      const drainPromise = drainInFlight(1500);
      await sleep(200);
      expect(s3Failed).toBe(true);

      const drained = await drainPromise;
      expect(drained).toBe(true);
      expect(getInFlightMutationCount()).toBe(0);
      expect(getActiveOperationCount()).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Test 6: Request is aborted while transaction is active
  // =========================================================================
  it('Scenario 6: Request is aborted while transaction is active waits for transaction settlement and cleans up safely', async () => {
    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    let txCommitted = false;
    let createdFormId = null;

    app.post('/api/tx-disconnect', async (req, res) => {
      try {
        await trackMutationOperation(async () => {
          await withRequiredTransaction(async (session) => {
            const form = new Form({
              title: 'Transactional Form',
              ownerId: new mongoose.Types.ObjectId()
            });
            await form.save({ session });
            createdFormId = form._id.toString();

            // Simulate transaction processing delay
            await sleep(250);
            txCommitted = true;
          });
        });
        if (!res.writableEnded) {
          res.status(201).json({ id: createdFormId });
        }
      } catch (err) {
        if (!res.writableEnded) {
          res.status(500).json({ error: err.message });
        }
      }
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/tx-disconnect',
        method: 'POST'
      });
      clientReq.on('error', () => {});
      clientReq.end();

      await waitForInFlightMutation();
      expect(getInFlightMutationCount()).toBe(1);

      // Abort client TCP socket mid-transaction
      clientReq.destroy();

      let drainedBeforeTx = false;
      const drainPromise = drainInFlight(2000).then((res) => {
        drainedBeforeTx = res;
        return res;
      });

      // Mid-transaction check: drain must NOT have finished yet
      await sleep(100);
      expect(txCommitted).toBe(false);
      expect(drainedBeforeTx).toBe(false);
      expect(getInFlightMutationCount()).toBe(1);

      // Wait for transaction to complete
      await sleep(200);
      expect(txCommitted).toBe(true);

      const drained = await drainPromise;
      expect(drained).toBe(true);
      expect(getInFlightMutationCount()).toBe(0);

      const persisted = await Form.findById(createdFormId);
      expect(persisted).not.toBeNull();
      expect(persisted.title).toBe('Transactional Form');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Test 7: Multiple concurrent mutations finish in different orders
  // =========================================================================
  it('Scenario 7: Multiple concurrent mutations finish in different orders (success, disconnect, failure) and settle cleanly', async () => {
    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    let m1Finished = false; // Disconnect, delayed 300ms
    let m2Finished = false; // Normal connected, 100ms
    let m3Failed = false;   // Disconnect, fails at 200ms

    app.post('/api/mutation-1', async (req, res) => {
      await trackMutationOperation(async () => {
        await sleep(300);
        m1Finished = true;
      });
      if (!res.writableEnded) res.status(200).send();
    });

    app.post('/api/mutation-2', async (req, res) => {
      await trackMutationOperation(async () => {
        await sleep(100);
        m2Finished = true;
      });
      if (!res.writableEnded) res.status(200).send();
    });

    app.post('/api/mutation-3', async (req, res) => {
      try {
        await trackMutationOperation(async () => {
          await sleep(200);
          m3Failed = true;
          throw new Error('Mutation 3 Failure');
        });
        if (!res.writableEnded) res.status(200).send();
      } catch {
        if (!res.writableEnded) res.status(500).send();
      }
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      // Launch all 3 concurrently
      const req1 = http.request({ hostname: '127.0.0.1', port, path: '/api/mutation-1', method: 'POST' });
      const req2 = http.request({ hostname: '127.0.0.1', port, path: '/api/mutation-2', method: 'POST' });
      const req3 = http.request({ hostname: '127.0.0.1', port, path: '/api/mutation-3', method: 'POST' });

      req1.on('error', () => {});
      req2.on('error', () => {});
      req3.on('error', () => {});

      req1.end();
      req2.end();
      req3.end();

      await sleep(40);
      expect(getInFlightMutationCount()).toBe(3);
      expect(getActiveOperationCount()).toBe(3);

      // Client 1 and Client 3 abort their connections
      req1.destroy();
      req3.destroy();

      let drainResolved = false;
      const drainPromise = drainInFlight(2000).then((res) => {
        drainResolved = res;
        return res;
      });

      // At 150ms: Mutation 2 finished, Mutations 1 & 3 still active
      await sleep(110);
      expect(m2Finished).toBe(true);
      expect(m3Failed).toBe(false);
      expect(m1Finished).toBe(false);
      expect(drainResolved).toBe(false);
      expect(getInFlightMutationCount()).toBe(2);

      // At 250ms: Mutation 3 has failed and released, Mutation 1 still active
      await sleep(100);
      expect(m3Failed).toBe(true);
      expect(m1Finished).toBe(false);
      expect(drainResolved).toBe(false);
      expect(getInFlightMutationCount()).toBe(1);

      // At 350ms: Mutation 1 finishes
      await sleep(110);
      expect(m1Finished).toBe(true);

      const drained = await drainPromise;
      expect(drained).toBe(true);
      expect(getInFlightMutationCount()).toBe(0);
      expect(getActiveOperationCount()).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Test 8: Drain begins while operations are active
  // =========================================================================
  it('Scenario 8: Drain begins while operations are active and awaits all active operations', async () => {
    let op1Done = false;
    let op2Done = false;

    trackMutationOperation(async () => {
      await sleep(150);
      op1Done = true;
    });

    trackMutationOperation(async () => {
      await sleep(250);
      op2Done = true;
    });

    expect(getActiveOperationCount()).toBe(2);
    expect(getInFlightMutationCount()).toBe(2);

    const startTime = Date.now();
    const drained = await drainInFlight(2000);
    const elapsed = Date.now() - startTime;

    expect(drained).toBe(true);
    expect(op1Done).toBe(true);
    expect(op2Done).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(getActiveOperationCount()).toBe(0);
    expect(getInFlightMutationCount()).toBe(0);
  });

  // =========================================================================
  // Test 9: Drain completes ONLY after all relevant operations reach safe terminal states
  // =========================================================================
  it('Scenario 9: Drain returns false if timeout expires before operations reach terminal state', async () => {
    let longOpFinished = false;

    const longOp = trackMutationOperation(async () => {
      await sleep(400);
      longOpFinished = true;
    });

    const drained = await drainInFlight(100);
    expect(drained).toBe(false);
    expect(longOpFinished).toBe(false);
    expect(getActiveOperationCount()).toBe(1);
    expect(getInFlightMutationCount()).toBe(1);

    await longOp;
    expect(longOpFinished).toBe(true);
    expect(getActiveOperationCount()).toBe(0);
    expect(getInFlightMutationCount()).toBe(0);

    const drainedAfter = await drainInFlight(500);
    expect(drainedAfter).toBe(true);
  });

  // =========================================================================
  // Test 10: Verify drain does NOT declare QUIESCED while disconnected client async write is in flight
  // =========================================================================
  it('Scenario 10: End-to-end integration: drain does NOT transition lease to QUIESCED while disconnected client async write is in flight', async () => {
    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);

    let docInserted = false;
    let savedFormId = null;

    app.post('/api/adversarial-backup-race', async (req, res) => {
      await trackMutationOperation(async () => {
        await sleep(350);
        const form = await Form.create({
          title: 'Must Be Backed Up Safely',
          ownerId: new mongoose.Types.ObjectId()
        });
        savedFormId = form._id.toString();
        docInserted = true;
      });
      if (!res.writableEnded) res.status(201).json({ ok: true });
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    let leaseId = null;
    try {
      // 1. Client initiates mutating request while status is NORMAL
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/adversarial-backup-race',
        method: 'POST'
      });
      clientReq.on('error', () => {});
      clientReq.end();

      await waitForInFlightMutation();
      expect(getInFlightMutationCount()).toBe(1);
      expect(getActiveOperationCount()).toBe(1);

      // 2. Client prematurely disconnects!
      clientReq.destroy();

      // 3. Now backup agent initiates lease acquisition in DRAINING status
      const acquireResult = await quiescenceService.acquire({
        owner: 'backup-agent-adversarial',
        leaseDurationMs: 60000,
        initialStatus: BACKUP_LEASE_STATUS.DRAINING
      });
      expect(acquireResult.success).toBe(true);
      expect(acquireResult.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      leaseId = acquireResult.leaseId;

      // 4. Backup service coordinator initiates drainInFlight
      let drainFinished = false;
      const drainPromise = quiescenceService.drainInFlight(3000, leaseId).then((res) => {
        drainFinished = true;
        return res;
      });

      // 5. Verification at 150ms:
      // Client is disconnected, but DB insert is STILL executing in background!
      await sleep(100);
      expect(docInserted).toBe(false);
      expect(drainFinished).toBe(false);

      // Check current lease status in MongoDB directly:
      // MUST NOT BE QUIESCED! If QUIESCED, backup would take snapshot missing the insert!
      const midLease = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(midLease.status).toBe(BACKUP_LEASE_STATUS.DRAINING);
      expect(midLease.status).not.toBe(BACKUP_LEASE_STATUS.QUIESCED);

      // 6. Wait for DB write to finish (at ~350ms)
      await sleep(250);
      expect(docInserted).toBe(true);

      // 7. Drain completes only after async write completed
      const drainResult = await drainPromise;
      expect(drainResult.success).toBe(true);

      // 8. Now lease safely transitions to QUIESCED
      const quiescedLease = await BackupLease.findById(BACKUP_LEASE_SINGLETON_ID).lean();
      expect(quiescedLease.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

      // 9. Document is fully verified in MongoDB before QUIESCED state was reached
      const persistedForm = await Form.findById(savedFormId).lean();
      expect(persistedForm).not.toBeNull();
      expect(persistedForm.title).toBe('Must Be Backed Up Safely');
    } finally {
      if (leaseId) {
        await quiescenceService.release({ leaseId }).catch(() => {});
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // =========================================================================
  // Test 11: withMutationScope & registerMutationScope API ergonomics
  // =========================================================================
  it('Scenario 11: withMutationScope and registerMutationScope provide clean route-level tracking without boilerplate', async () => {
    const app = express();
    app.use(quiescenceGate);

    let scopeCompleted = false;

    // Use withMutationScope helper
    app.post(
      '/api/scoped-handler',
      withMutationScope(async (req, res) => {
        await sleep(150);
        scopeCompleted = true;
        if (!res.writableEnded) {
          res.status(200).json({ scoped: true });
        }
      })
    );

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const clientReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/scoped-handler',
        method: 'POST'
      });
      clientReq.on('error', () => {});
      clientReq.end();

      await sleep(30);
      expect(getInFlightMutationCount()).toBe(1);

      // Client disconnects
      clientReq.destroy();

      let drained = false;
      const drainPromise = drainInFlight(1000).then((res) => {
        drained = res;
      });

      await sleep(50);
      expect(drained).toBe(false);

      await sleep(100);
      expect(scopeCompleted).toBe(true);

      await drainPromise;
      expect(drained).toBe(true);
      expect(getInFlightMutationCount()).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
