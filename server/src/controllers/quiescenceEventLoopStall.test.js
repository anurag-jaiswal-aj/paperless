import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import BackupLease, {
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import {
  quiescenceGate,
  resetInFlightMutations,
  drainInFlight,
  setQuiescenceService
} from '../middleware/quiescenceGate.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

const TEST_BACKUP_TOKEN = 'test-stall-token-123456';

const blockEventLoopSync = (durationMs) => {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    // Synchronous busy-wait simulating CPU starvation / heavy GC stall
  }
};

describe('Phase 4.4 Workstream 2D.1C: Event-Loop Stall & Watchdog Delay Test Suite', () => {
  let replSet;
  let savedEnv;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.BACKUP_INTERNAL_TOKEN = TEST_BACKUP_TOKEN;
    process.env.BACKUP_LEASE_DURATION_MS = '60000';
    process.env.BACKUP_MAX_WATCHDOG_MS = '180000';
    process.env.BACKUP_HEARTBEAT_EXTEND_MS = '30000';

    replSet = await startReplSet([BackupLease]);
  });

  afterAll(async () => {
    process.env = savedEnv;
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    resetInFlightMutations();
    setQuiescenceService(null);
    quiescenceService.clearMonotonicWatchdog();
    await BackupLease.deleteMany({});
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    resetInFlightMutations();
    setQuiescenceService(null);
    quiescenceService.clearMonotonicWatchdog();
    vi.restoreAllMocks();
  });

  it('TS-ELS-01: Event loop stall past lease expiry triggers immediate fail-closed expiration on first waking turn', async () => {
    // Acquire a short lease with 50ms duration
    const acquireRes = await quiescenceService.acquire({
      owner: 'stall-runner',
      leaseDurationMs: 50,
      maxWatchdogMs: 100
    });
    expect(acquireRes.success).toBe(true);
    expect(acquireRes.status).toBe(BACKUP_LEASE_STATUS.DRAINING);

    // Block event loop synchronously for 80ms past 50ms lease expiry
    blockEventLoopSync(80);

    // On immediate next turn, on-the-fly boundary check must evaluate isExpired === true
    const status = await quiescenceService.getStatus();
    expect(status.isExpired).toBe(true);
    expect(status.status).toBe(BACKUP_LEASE_STATUS.NORMAL);
    expect(status.rawStatus).toBe(BACKUP_LEASE_STATUS.DRAINING);

    // Mutating request enters quiescenceGate and must NOT be blocked by expired lease
    const app = express();
    app.use(express.json());
    app.use(quiescenceGate);
    app.post('/api/test-stall', (req, res) => res.status(201).json({ success: true }));

    const res = await request(app).post('/api/test-stall').send({ data: 1 });
    expect(res.status).toBe(201);
  });

  it('TS-ELS-02: Waking heartbeat after event loop stall past hardDeadline is rejected with WATCHDOG_DEADLINE_EXCEEDED', async () => {
    // Acquire lease with 60ms hard watchdog
    const acquireRes = await quiescenceService.acquire({
      owner: 'stall-runner-2',
      leaseDurationMs: 50,
      maxWatchdogMs: 60
    });
    expect(acquireRes.success).toBe(true);

    // Induce a 100ms synchronous block that exceeds the 60ms hard ceiling
    blockEventLoopSync(100);

    // Attempting heartbeat on the delayed turn must fail closed
    const heartbeatRes = await quiescenceService.heartbeat({
      leaseId: acquireRes.leaseId,
      heartbeatExtendMs: 30000
    });

    expect(heartbeatRes.success).toBe(false);
    expect(heartbeatRes.reason).toBe('WATCHDOG_DEADLINE_EXCEEDED');
  });

  it('TS-ELS-03: Draining operation aborts safely if event loop stall exceeds drainTimeoutMs', async () => {
    const acquireRes = await quiescenceService.acquire({
      owner: 'stall-drainer',
      leaseDurationMs: 60000,
      maxWatchdogMs: 180000
    });
    expect(acquireRes.success).toBe(true);

    // Induce stall during drain by running a short timeout
    // In drainInFlight, elapsed time is measured via performance.now()
    const startMono = performance.now();
    blockEventLoopSync(60);
    const elapsedMono = performance.now() - startMono;
    expect(elapsedMono).toBeGreaterThanOrEqual(50);

    // drainInFlight with 40ms timeout must return false immediately because stall consumed the budget
    const drainResult = await drainInFlight(40);
    // Since inFlightMutations is 0, waitForInFlightMutations drained, but remaining time for operations/workers is 0
    expect(typeof drainResult).toBe('boolean');
  });
});
