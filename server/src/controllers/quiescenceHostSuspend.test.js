import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import BackupLease, {
  BACKUP_LEASE_STATUS
} from '../models/backupLease.js';
import * as quiescenceService from '../services/quiescenceService.js';
import {
  shouldPauseWorker,
  resetWorkerTasks
} from '../services/workerCoordinationService.js';
import {
  resetInFlightMutations,
  setQuiescenceService
} from '../middleware/quiescenceGate.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';

describe('Phase 4.4 Workstream 2D.1C: Suspend-Aware Timing & Uptime Guard Test Suite', () => {
  let replSet;
  let savedEnv;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.BACKUP_INTERNAL_TOKEN = 'test-suspend-token';
    process.env.BACKUP_LEASE_DURATION_MS = '60000';
    process.env.BACKUP_MAX_WATCHDOG_MS = '180000';

    replSet = await startReplSet([BackupLease]);
  });

  afterAll(async () => {
    process.env = savedEnv;
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    resetInFlightMutations();
    resetWorkerTasks();
    setQuiescenceService(null);
    quiescenceService.clearMonotonicWatchdog();
    quiescenceService.resetSystemBootIdForTesting();
    quiescenceService.resetHostMonotonicForTesting();
    quiescenceService.resetSystemUptimeForTesting();
    await BackupLease.deleteMany({});
    await quiescenceService.ensureSingletonExists();
  });

  afterEach(async () => {
    resetInFlightMutations();
    resetWorkerTasks();
    setQuiescenceService(null);
    quiescenceService.clearMonotonicWatchdog();
    quiescenceService.resetSystemBootIdForTesting();
    quiescenceService.resetHostMonotonicForTesting();
    quiescenceService.resetSystemUptimeForTesting();
    vi.restoreAllMocks();
  });

  it('TS-SUSP-01: Emulated 15-minute host suspend during QUIESCED state invalidates lease immediately upon resume', async () => {
    // 1. Initial grant: lease active with initialStatus QUIESCED
    const initialUptime = 1000; // seconds
    quiescenceService.setSystemUptimeForTesting(initialUptime);

    const acquireRes = await quiescenceService.acquire({
      owner: 'suspend-test-runner',
      leaseDurationMs: 60000,
      maxWatchdogMs: 180000,
      initialStatus: BACKUP_LEASE_STATUS.QUIESCED
    });
    expect(acquireRes.success).toBe(true);
    expect(acquireRes.status).toBe(BACKUP_LEASE_STATUS.QUIESCED);

    // 2. Emulate host suspend: 15 minutes (900 seconds) elapse in physical world
    // Upon resume, os.uptime() (via CLOCK_BOOTTIME) advances by 900 seconds
    quiescenceService.setSystemUptimeForTesting(initialUptime + 900);

    // Also wall-clock advances by 15 minutes (RTC synchronization on wake)
    const baseNow = Date.now();
    const wakeWallClock = baseNow + 15 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(wakeWallClock);

    // 3. Verify on wake: isMonotonicWatchdogExpired is immediately true
    expect(quiescenceService.isMonotonicWatchdogExpired(acquireRes.leaseId)).toBe(true);

    // 4. Verify getStatus reports isExpired: true and status: NORMAL
    const status = await quiescenceService.getStatus();
    expect(status.isExpired).toBe(true);
    expect(status.status).toBe(BACKUP_LEASE_STATUS.NORMAL);

    // 5. Worker checking shouldPauseWorker sees false because lease expired fail-closed
    const workerPaused = await shouldPauseWorker();
    expect(workerPaused).toBe(false);
  });

  it('TS-SUSP-02: Suspend-aware uptime guard expires lease even if monotonic clock was paused and wall-clock is skewed', async () => {
    // Adversarial scenario: Host suspends for 200 seconds (> 180s Tmax), but wall-clock is skewed/not yet synced
    const initialUptime = 5000; // seconds
    quiescenceService.setSystemUptimeForTesting(initialUptime);

    const acquireRes = await quiescenceService.acquire({
      owner: 'suspend-skew-runner',
      leaseDurationMs: 60000,
      maxWatchdogMs: 180000 // 180 seconds max
    });
    expect(acquireRes.success).toBe(true);

    // Host sleeps for 200 seconds. CLOCK_BOOTTIME (os.uptime) advances by 200s (exceeding 180s)
    quiescenceService.setSystemUptimeForTesting(initialUptime + 200);

    // In-process monotonic clock (performance.now) was PAUSED on Linux during sleep
    // Wall-clock is maliciously or erroneously reported as only 10s passed
    const wallNow = new Date(acquireRes.grantedAt).getTime() + 10000;
    vi.spyOn(Date, 'now').mockReturnValue(wallNow);

    // Despite wall clock saying valid and performance.now not having advanced,
    // the uptime guard (CLOCK_BOOTTIME) catches the 200s suspend!
    expect(quiescenceService.isMonotonicWatchdogExpired(acquireRes.leaseId)).toBe(true);
    expect(quiescenceService.getMonotonicRemainingMs(acquireRes.leaseId)).toBe(0);

    // Heartbeat attempt is rejected fail-closed
    const heartbeatRes = await quiescenceService.heartbeat({
      leaseId: acquireRes.leaseId,
      heartbeatExtendMs: 30000
    });
    expect(heartbeatRes.success).toBe(false);
    expect(heartbeatRes.reason).toBe('WATCHDOG_DEADLINE_EXCEEDED');
  });

  it('TS-SUSP-03: Release call post-suspend detects expiration and returns wasExpired: true', async () => {
    const initialUptime = 2000;
    quiescenceService.setSystemUptimeForTesting(initialUptime);

    const acquireRes = await quiescenceService.acquire({
      owner: 'release-suspend-runner',
      leaseDurationMs: 60000,
      maxWatchdogMs: 180000
    });
    expect(acquireRes.success).toBe(true);

    // Suspend for 300 seconds
    quiescenceService.setSystemUptimeForTesting(initialUptime + 300);
    const wakeWallClock = new Date(acquireRes.grantedAt).getTime() + 300000;
    vi.spyOn(Date, 'now').mockReturnValue(wakeWallClock);

    // Release must return wasExpired: true and reason: LEASE_EXPIRED
    const releaseRes = await quiescenceService.release({ leaseId: acquireRes.leaseId });
    expect(releaseRes.success).toBe(false);
    expect(releaseRes.wasExpired).toBe(true);
    expect(releaseRes.reason).toBe('LEASE_EXPIRED');
  });
});
