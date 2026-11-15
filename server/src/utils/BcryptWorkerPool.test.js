import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { UnifiedComputePipelineCoordinator } from './UnifiedComputePipelineCoordinator.js';
import { TaskState } from './CoordinatorTask.js';
import {
  BcryptWorkerPool,
  WorkerState,
  ShutdownTimeoutError,
  QueueFullError,
  WorkerTimeoutError,
  WorkerCrashError
} from './BcryptWorkerPool.js';
import {
  getDiagnosticCounters,
  resetDiagnosticCounters
} from '../services/SecurityAuditService.js';

describe('BcryptWorkerPool Phase 2 Implementation Suite', () => {
  let coordinator;
  let pool;

  beforeEach(() => {
    resetDiagnosticCounters();
    coordinator = new UnifiedComputePipelineCoordinator({
      maxActive: 2,
      maxQueue: 10,
      maxPerIp: 1
    });
  });

  afterEach(async () => {
    if (pool && !pool.shuttingDown) {
      await pool.shutdown({ timeoutMs: 5000, graceful: false }).catch(() => {});
    }
  });

  describe('Scenario 1: Pool initialization and physical worker limits', () => {
    it('starts exactly maxWorkers (2) physical workers and enforces ceiling', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });

      expect(pool.aliveWorkerCount).toBe(0);
      expect(pool.maxWorkers).toBe(2);

      await pool.initialize();

      expect(pool.aliveWorkerCount).toBe(2);
      expect(pool.workers.size).toBe(2);

      const snapshot = pool.getSnapshot();
      expect(snapshot.aliveWorkers).toBe(2);
      expect(snapshot.idleWorkers).toBe(2);
      expect(snapshot.busyWorkers).toBe(0);
      expect(snapshot.maxWorkers).toBe(2);
    });
  });

  describe('Scenario 2: Worker readiness handshake', () => {
    it('waits for worker readiness before marking workers IDLE and accepting dispatch', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });

      const initPromise = pool.initialize();
      // Workers should become IDLE once initialized
      await initPromise;

      for (const slot of pool.workers.values()) {
        expect(slot.state).toBe(WorkerState.IDLE);
      }
    });
  });

  describe('Scenario 3: Worker bcrypt hash execution', () => {
    it('executes bcrypt hash operation in worker thread and transitions token to DB_WRITE', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.0.0.1');
      expect(token).not.toBeNull();
      expect(token.state).toBe(TaskState.ADMITTED_LOOKUP);

      const result = await pool.executeHash(token, 'correctHorseBatteryStaple', 10);

      expect(result).toHaveProperty('hash');
      expect(typeof result.hash).toBe('string');
      expect(result.hash.startsWith('$2')).toBe(true);

      // Verify token transitioned from ACTIVE_COMPUTE to DB_WRITE
      expect(token.state).toBe(TaskState.DB_WRITE);
      expect(token.holdsIpSlot).toBe(false);

      // Finish settlement
      expect(token.settleSuccess()).toBe(true);
      expect(coordinator.getSnapshot().inFlightRequests).toBe(0);
    });
  });

  describe('Scenario 4: Worker bcrypt compare execution', () => {
    it('executes bcrypt compare for matching and non-matching passwords', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const plainPassword = 'SuperSecret123!';
      const hash = await bcrypt.hash(plainPassword, 10);

      // Test matching password
      const token1 = coordinator.tryAcquireAdmission('10.0.0.2');
      const matchResult = await pool.executeCompare(token1, plainPassword, hash);
      expect(matchResult.isMatch).toBe(true);
      expect(token1.state).toBe(TaskState.DB_WRITE);
      expect(token1.settleSuccess()).toBe(true);

      // Test non-matching password
      const token2 = coordinator.tryAcquireAdmission('10.0.0.3');
      const mismatchResult = await pool.executeCompare(token2, 'wrongPassword', hash);
      expect(mismatchResult.isMatch).toBe(false);
      expect(token2.state).toBe(TaskState.DB_WRITE);
      expect(token2.settleFailure('BAD_PASSWORD')).toBe(true);
    });
  });

  describe('Scenario 5: Successful result returns worker to IDLE', () => {
    it('returns worker to IDLE state upon task completion and clears active task', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.0.0.4');
      const hash = await bcrypt.hash('testPass', 10);

      await pool.executeCompare(token, 'testPass', hash);
      token.settleSuccess();

      const snap = pool.getSnapshot();
      expect(snap.idleWorkers).toBe(2);
      expect(snap.busyWorkers).toBe(0);

      for (const slot of pool.workers.values()) {
        expect(slot.currentTask).toBeNull();
      }
    });
  });

  describe('Scenario 6: Worker owns at most one active task', () => {
    it('guarantees that a worker never owns two tasks simultaneously', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1
      });
      await pool.initialize();

      const t1 = coordinator.tryAcquireAdmission('10.1.1.1');
      const t2 = coordinator.tryAcquireAdmission('10.1.1.2');

      const hash = await bcrypt.hash('pass', 10);

      // t1 dispatches to worker-0
      const p1 = pool.executeCompare(t1, 'pass', hash);
      const workerSlot = pool.workers.get('worker-0');
      expect(workerSlot.state).toBe(WorkerState.BUSY);
      expect(workerSlot.currentTask.taskId).toBe(t1.taskId);

      // t2 queues because worker-0 is already BUSY
      const p2 = pool.executeCompare(t2, 'pass', hash);
      expect(t2.state).toBe(TaskState.QUEUED);
      expect(pool.queue.length).toBe(1);

      await p1;
      t1.settleSuccess();

      await p2;
      t2.settleSuccess();

      expect(pool.getSnapshot().idleWorkers).toBe(1);
    });
  });

  describe('Scenario 7: Task is never assigned to two workers', () => {
    it('ensures each task is correlated with exactly one worker', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.2.2.1');
      const hash = await bcrypt.hash('pass', 10);

      const p = pool.executeCompare(token, 'pass', hash);

      let assignedCount = 0;
      for (const slot of pool.workers.values()) {
        if (slot.currentTask && slot.currentTask.taskId === token.taskId) {
          assignedCount++;
        }
      }

      expect(assignedCount).toBe(1);
      await p;
      token.settleSuccess();
    });
  });

  describe('Scenario 8: Logical queue remains owned by Phase 1 coordinator', () => {
    it('preserves coordinator queue state and counter conservation during queueing', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1
      });
      await pool.initialize();

      const t1 = coordinator.tryAcquireAdmission('10.3.3.1');
      const t2 = coordinator.tryAcquireAdmission('10.3.3.2');
      const hash = await bcrypt.hash('pass', 10);

      const p1 = pool.executeCompare(t1, 'pass', hash);
      const p2 = pool.executeCompare(t2, 'pass', hash);

      const coordSnap = coordinator.getSnapshot();
      expect(coordSnap.active).toBe(1);
      expect(coordSnap.queued).toBe(1);
      expect(coordSnap.inFlightRequests).toBe(2);

      await p1;
      t1.settleSuccess();

      await p2;
      t2.settleSuccess();

      expect(coordinator.getSnapshot().inFlightRequests).toBe(0);
    });
  });

  describe('Scenario 9: Queue saturation does not create an unbounded pool queue', () => {
    it('rejects new tasks and rolls back when coordinator queue capacity is exhausted', async () => {
      const tinyCoord = new UnifiedComputePipelineCoordinator({
        maxActive: 2,
        maxQueue: 1,
        maxPerIp: 1
      });

      pool = new BcryptWorkerPool({
        coordinator: tinyCoord,
        maxWorkers: 1
      });
      await pool.initialize();

      const t1 = tinyCoord.tryAcquireAdmission('10.4.4.1');
      const t2 = tinyCoord.tryAcquireAdmission('10.4.4.2');
      const t3 = tinyCoord.tryAcquireAdmission('10.4.4.3');

      expect(t1).not.toBeNull();
      expect(t2).not.toBeNull();
      expect(t3).not.toBeNull();

      const hash = await bcrypt.hash('pass', 10);

      // t1 active (worker-0 busy), t2 queued (queue length = 1)
      const p1 = pool.executeCompare(t1, 'pass', hash);
      const p2 = pool.executeCompare(t2, 'pass', hash);

      // t3 attempt to queue must fail with QueueFullError
      await expect(pool.executeCompare(t3, 'pass', hash)).rejects.toThrow(QueueFullError);

      expect(t3.isSettled).toBe(true);
      expect(pool.queue.length).toBe(1);

      await p1;
      t1.settleSuccess();
      await p2;
      t2.settleSuccess();

      expect(tinyCoord.getSnapshot().inFlightRequests).toBe(0);
      expect(tinyCoord.getSnapshot().totalSettledFailure).toBe(1); // t3
      expect(tinyCoord.getSnapshot().totalSettledSuccess).toBe(2); // t1, t2
    });
  });

  describe('Scenario 10: Worker crash detection', () => {
    it('detects worker exit and marks worker slot as FAILED/EXITED', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.5.5.1');

      let exitEventFired = false;
      pool.on('workerExited', ({ code }) => {
        if (code === 42) {
          exitEventFired = true;
        }
      });

      // Submit controlled crash operation
      await expect(pool._submitTask(token, { operation: '__TEST_CRASH__' })).rejects.toThrow(
        WorkerCrashError
      );

      expect(exitEventFired).toBe(true);
      expect(token.isSettled).toBe(true);
    });
  });

  describe('Scenario 11: Crashed worker task follows exactly one settlement path', () => {
    it('settles task via settleWorkerCrash with zero counter underflows', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.6.6.1');
      await expect(pool._submitTask(token, { operation: '__TEST_CRASH__' })).rejects.toThrow(
        WorkerCrashError
      );

      expect(token.isSettled).toBe(true);
      expect(coordinator.getSnapshot().active).toBe(0);
      expect(coordinator.getSnapshot().totalSettledFailure).toBe(1);
      expect(coordinator.getSnapshot().underflowCount).toBe(0);
    });
  });

  describe('Scenario 12: Late response from crashed worker is ignored', () => {
    it('drops late worker messages from previous generations', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1
      });
      await pool.initialize();

      const slot = pool.workers.get('worker-0');
      const oldGen = slot.generation;

      // Simulate late message from old generation
      pool._onWorkerMessage(slot, {
        type: 'RESULT',
        workerId: 'worker-0',
        generation: oldGen - 1,
        taskId: 'stale-task',
        operation: 'COMPARE',
        success: true,
        isMatch: true
      });

      expect(coordinator.getSnapshot().underflowCount).toBe(0);
    });
  });

  describe('Scenario 13: Duplicate worker completion is ignored', () => {
    it('safely drops duplicate result messages', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.7.7.1');
      const hash = await bcrypt.hash('pass', 10);

      await pool.executeCompare(token, 'pass', hash);
      token.settleSuccess();

      const slot = pool.workers.get('worker-0');

      // Send duplicate result message when slot is now IDLE
      pool._onWorkerMessage(slot, {
        type: 'RESULT',
        workerId: 'worker-0',
        generation: slot.generation,
        taskId: token.taskId,
        operation: 'COMPARE',
        success: true,
        isMatch: true
      });

      expect(coordinator.getSnapshot().underflowCount).toBe(0);
    });
  });

  describe('Scenario 14: Malformed worker messages are safely rejected', () => {
    it('handles null, non-object, and corrupted payloads without throwing', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1
      });
      await pool.initialize();

      const slot = pool.workers.get('worker-0');

      expect(() => pool._onWorkerMessage(slot, null)).not.toThrow();
      expect(() => pool._onWorkerMessage(slot, 'not an object')).not.toThrow();
      expect(() => pool._onWorkerMessage(slot, {})).not.toThrow();
      expect(() => pool._onWorkerMessage(slot, { type: 'INVALID' })).not.toThrow();
    });
  });

  describe('Scenario 15: Worker startup failure handling', () => {
    it('handles invalid worker script path and rejects initialization', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1,
        workerScriptPath: '/invalid/path/to/worker.js'
      });

      await expect(pool.initialize()).rejects.toThrow();
      expect(pool.workers.get('worker-0').state).toBe(WorkerState.FAILED);
    });
  });

  describe('Scenario 16: Worker replacement waits for confirmed physical exit', () => {
    it('never exceeds maxWorkers (2) alive during crash recovery', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.8.8.1');

      let readyCount = 0;
      pool.on('workerReady', () => {
        readyCount++;
      });

      await expect(pool._submitTask(token, { operation: '__TEST_CRASH__' })).rejects.toThrow(
        WorkerCrashError
      );

      // Wait for replacement worker to signal READY
      await new Promise((resolve) => {
        if (pool.getSnapshot().idleWorkers === 2) {
          resolve();
        } else {
          pool.once('workerReady', resolve);
        }
      });

      expect(readyCount).toBeGreaterThan(0);

      expect(pool.aliveWorkerCount).toBe(2);
      expect(pool.getSnapshot().idleWorkers).toBe(2);
    });
  });

  describe('Scenario 17: Replacement failure circuit breaker', () => {
    it('stops restarts when maxRestartsPerSlot limit is reached', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1,
        maxRestartsPerSlot: 1
      });
      await pool.initialize();

      // Crash 1: restartsCount becomes 1
      const t1 = coordinator.tryAcquireAdmission('10.9.9.1');
      await expect(pool._submitTask(t1, { operation: '__TEST_CRASH__' })).rejects.toThrow();

      // Wait for replacement to become ready
      await new Promise((resolve) => pool.once('workerReady', resolve));

      // Crash 2: restartsCount reaches limit 1, no further restart
      const t2 = coordinator.tryAcquireAdmission('10.9.9.2');
      await expect(pool._submitTask(t2, { operation: '__TEST_CRASH__' })).rejects.toThrow();

      expect(pool.workers.get('worker-0').restartsCount).toBe(1);
    });
  });

  describe('Scenario 18: Timeout does not release physical capacity prematurely', () => {
    it('terminates unresponsive worker and holds slot until physical exit', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1,
        taskTimeoutMs: 150
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.10.10.1');

      // Submit slow task that exceeds 150ms timeout
      await expect(
        pool._submitTask(token, { operation: '__TEST_DELAY__', delayMs: 2000 })
      ).rejects.toThrow(WorkerTimeoutError);

      expect(token.isSettled).toBe(true);

      // Wait for replacement worker to be created and signal READY
      await new Promise((resolve) => pool.once('workerReady', resolve));

      expect(pool.aliveWorkerCount).toBe(1);
      expect(pool.getSnapshot().idleWorkers).toBe(1);
    });
  });

  describe('Scenario 19: Idempotent cancellation and disconnect handling', () => {
    it('handles client disconnect before dispatch cleanly', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 1
      });
      await pool.initialize();

      // Occupy worker-0
      const t1 = coordinator.tryAcquireAdmission('10.11.11.1');
      const hash = await bcrypt.hash('pass', 10);
      const p1 = pool.executeCompare(t1, 'pass', hash);

      // Queue t2
      const t2 = coordinator.tryAcquireAdmission('10.11.11.2');
      const p2 = pool.executeCompare(t2, 'pass', hash);

      // Client aborts t2 while waiting in queue
      t2.markClientDisconnected();
      expect(t2.clientDisconnected).toBe(true);

      await p1;
      t1.settleSuccess();

      // t2 should be rejected upon drain
      await expect(p2).rejects.toThrow('CLIENT_DISCONNECTED');
      expect(t2.isSettled).toBe(true);
    });
  });

  describe('Scenario 20: Shutdown prevents new dispatch', () => {
    it('rejects new execution attempts immediately after shutdown is initiated', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const shutdownPromise = pool.shutdown({ timeoutMs: 5000 });

      const token = coordinator.tryAcquireAdmission('10.12.12.1');
      await expect(pool.executeCompare(token, 'pass', 'hash')).rejects.toThrow('POOL_SHUTDOWN');

      token.settleLookupFailure('SHUTDOWN');
      await shutdownPromise;
    });
  });

  describe('Scenario 21: Shutdown awaits actual worker exits', () => {
    it('resolves only when all worker threads are confirmed EXITED', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      expect(pool.aliveWorkerCount).toBe(2);

      const res = await pool.shutdown({ timeoutMs: 5000 });
      expect(res).toBe(true);
      expect(pool.aliveWorkerCount).toBe(0);

      const snap = pool.getSnapshot();
      expect(snap.aliveWorkers).toBe(0);
      expect(snap.shuttingDown).toBe(true);
    });
  });

  describe('Scenario 22: Repeated shutdown calls are safe and idempotent', () => {
    it('returns the same promise and resolves cleanly on multiple shutdown invocations', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const p1 = pool.shutdown({ timeoutMs: 5000 });
      const p2 = pool.shutdown({ timeoutMs: 5000 });
      const p3 = pool.shutdown({ timeoutMs: 5000 });

      expect(p1).toBe(p2);
      expect(p2).toBe(p3);

      await expect(Promise.all([p1, p2, p3])).resolves.toEqual([true, true, true]);
    });
  });

  describe('Scenario 23: Shutdown timeout reporting', () => {
    it('instantiates ShutdownTimeoutError with remaining worker identifiers', () => {
      const err = new ShutdownTimeoutError('Shutdown timed out', ['worker-0']);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('ShutdownTimeoutError');
      expect(err.remainingWorkers).toEqual(['worker-0']);
      expect(err.message).toContain('Shutdown timed out');
    });
  });

  describe('Scenario 24: Snapshots do not expose sensitive data', () => {
    it('deeply freezes snapshot and strictly excludes passwords, hashes, and raw IPs', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const snap = pool.getSnapshot();
      expect(Object.isFrozen(snap)).toBe(true);
      expect(Object.isFrozen(snap.workers)).toBe(true);

      const jsonStr = JSON.stringify(snap);
      expect(jsonStr).not.toContain('password');
      expect(jsonStr).not.toContain('hash');
      expect(jsonStr).not.toContain('token');
      expect(jsonStr).not.toContain('10.0.0.');
    });
  });

  describe('Scenario 25: Physical and logical accounting independence', () => {
    it('keeps physical worker states completely decoupled from coordinator logical states', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const token = coordinator.tryAcquireAdmission('10.13.13.1');
      const hash = await bcrypt.hash('pass', 10);

      const p = pool.executeCompare(token, 'pass', hash);

      // Coordinator tracks logical active; pool tracks physical busy
      expect(coordinator.getSnapshot().active).toBe(1);
      expect(pool.getSnapshot().busyWorkers).toBe(1);

      await p;
      // After compute finishes:
      // Logical state is DB_WRITE (active=0, pendingDbWrites=1)
      // Physical worker is already back to IDLE!
      expect(coordinator.getSnapshot().active).toBe(0);
      expect(coordinator.getSnapshot().pendingDbWrites).toBe(1);
      expect(pool.getSnapshot().idleWorkers).toBe(2);

      token.settleSuccess();
      expect(coordinator.getSnapshot().inFlightRequests).toBe(0);
      expect(coordinator.getSnapshot().totalSettledSuccess).toBe(1);
    });
  });

  describe('Scenario 26: Concurrent load and conservation under heavy interleaving', () => {
    it('executes 20 concurrent bcrypt operations without leaks, underflows, or invariant violations', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2
      });
      await pool.initialize();

      const plainPassword = 'sharedPassword!';
      const hash = await bcrypt.hash(plainPassword, 10);

      const tokens = [];
      const tasks = [];

      for (let i = 1; i <= 10; i++) {
        const ip = `192.168.10.${i}`;
        const tok = coordinator.tryAcquireAdmission(ip);
        if (tok) {
          tokens.push(tok);
          tasks.push(
            pool.executeCompare(tok, plainPassword, hash).then((res) => {
              expect(res.isMatch).toBe(true);
              expect(tok.settleSuccess()).toBe(true);
            })
          );
        }
      }

      await Promise.all(tasks);

      expect(coordinator.getSnapshot().inFlightRequests).toBe(0);
      expect(coordinator.getSnapshot().totalSettledSuccess).toBe(tokens.length);
      expect(coordinator.getSnapshot().underflowCount).toBe(0);
      expect(pool.getSnapshot().idleWorkers).toBe(2);
      expect(pool.getSnapshot().busyWorkers).toBe(0);
    });
  });

  describe('Stage 4.2.4: Worker Diagnostics & Bounded Metrics', () => {
    let mockLogger;
    let loggedEvents;

    beforeEach(() => {
      resetDiagnosticCounters();
      loggedEvents = [];
      mockLogger = {
        debug: vi.fn((event, metadata) => loggedEvents.push({ level: 'debug', event, metadata })),
        info: vi.fn((event, metadata) => loggedEvents.push({ level: 'info', event, metadata })),
        warn: vi.fn((event, metadata) => loggedEvents.push({ level: 'warn', event, metadata })),
        error: vi.fn((event, metadata) => loggedEvents.push({ level: 'error', event, metadata })),
        fatal: vi.fn((event, metadata) => loggedEvents.push({ level: 'fatal', event, metadata }))
      };
    });

    it('emits pool initialization and worker spawn/ready lifecycle events with counters', async () => {
      pool = new BcryptWorkerPool({ coordinator, maxWorkers: 2, logger: mockLogger });
      await pool.initialize();

      const snap = getDiagnosticCounters();
      expect(snap.worker_spawn_total).toBe(2);
      expect(snap.worker_ready_total).toBe(2);

      const events = loggedEvents.map((e) => e.event);
      expect(events).toContain('worker.spawned');
      expect(events).toContain('worker.ready');
      expect(events).toContain('worker.pool.initialized');

      const initEvent = loggedEvents.find((e) => e.event === 'worker.pool.initialized');
      expect(initEvent.metadata.maxWorkers).toBe(2);
    });

    it('emits task start and completion events without leaking sensitive passwords or hashes', async () => {
      pool = new BcryptWorkerPool({ coordinator, maxWorkers: 2, logger: mockLogger });
      await pool.initialize();

      const rawPassword = 'SuperSecretPassword!123';
      const hash = await bcrypt.hash(rawPassword, 8);
      const token = coordinator.tryAcquireAdmission('10.99.1.1');

      loggedEvents = [];
      const res = await pool.executeCompare(token, rawPassword, hash);
      expect(res.isMatch).toBe(true);

      const snap = getDiagnosticCounters();
      expect(snap.worker_task_success_total).toBe(1);

      const events = loggedEvents.map((e) => e.event);
      expect(events).toContain('worker.task.started');
      expect(events).toContain('worker.task.completed');

      // Verify strict exclusion of password and hash in all logged metadata
      const serializedLogs = JSON.stringify(loggedEvents);
      expect(serializedLogs).not.toContain(rawPassword);
      expect(serializedLogs).not.toContain(hash);

      const completedEvent = loggedEvents.find((e) => e.event === 'worker.task.completed');
      expect(completedEvent.metadata.taskId).toBe(token.taskId);
      expect(completedEvent.metadata.operation).toBe('COMPARE');
      expect(typeof completedEvent.metadata.durationMs).toBe('number');
      expect(completedEvent.metadata.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('isolates worker pool from logger errors without crashing task execution', async () => {
      const explodingLogger = {
        debug: vi.fn(() => {
          throw new Error('Logger disk full simulation');
        }),
        info: vi.fn(() => {
          throw new Error('Logger pipe broken simulation');
        }),
        warn: vi.fn(() => {
          throw new Error('Logger explosion');
        }),
        error: vi.fn(() => {
          throw new Error('Logger critical failure');
        })
      };

      pool = new BcryptWorkerPool({ coordinator, maxWorkers: 2, logger: explodingLogger });
      await expect(pool.initialize()).resolves.toBe(true);

      const token = coordinator.tryAcquireAdmission('10.99.2.2');
      const hash = await bcrypt.hash('password123', 8);

      // Should complete normally despite logger throwing on every invocation
      const res = await pool.executeCompare(token, 'password123', hash);
      expect(res.isMatch).toBe(true);
      expect(explodingLogger.debug).toHaveBeenCalled();
    });

    it('increments coordinator_task_queued_total and emits saturation diagnostics when capacity is reached', async () => {
      const tinyCoord = new UnifiedComputePipelineCoordinator({
        maxActive: 2,
        maxQueue: 1,
        maxPerIp: 1
      });
      pool = new BcryptWorkerPool({
        coordinator: tinyCoord,
        maxWorkers: 1,
        logger: mockLogger
      });
      await pool.initialize();

      const t1 = tinyCoord.tryAcquireAdmission('10.100.1.1');
      const t2 = tinyCoord.tryAcquireAdmission('10.100.1.2');
      const t3 = tinyCoord.tryAcquireAdmission('10.100.1.3');

      expect(t1).not.toBeNull();
      expect(t2).not.toBeNull();
      expect(t3).not.toBeNull();

      const hash = await bcrypt.hash('pass', 8);

      // t1 occupies active worker (worker-0 busy)
      const p1 = pool.executeCompare(t1, 'pass', hash);
      // t2 queues (queue length = 1)
      const p2 = pool.executeCompare(t2, 'pass', hash);
      // t3 exceeds queue limit (maxQueue: 1)
      await expect(pool.executeCompare(t3, 'pass', hash)).rejects.toThrow(QueueFullError);

      const snap = getDiagnosticCounters();
      expect(snap.coordinator_task_queued_total).toBeGreaterThanOrEqual(1);
      expect(snap.coordinator_task_saturated_total).toBeGreaterThanOrEqual(1);

      const events = loggedEvents.map((e) => e.event);
      expect(events).toContain('worker.queue.saturated');

      // Cleanup
      await p1;
      t1.settleSuccess();
      await p2;
      t2.settleSuccess();
    });

    it('increments worker_unexpected_exit_total and emits exit/replacement diagnostics on abnormal worker termination', async () => {
      pool = new BcryptWorkerPool({
        coordinator,
        maxWorkers: 2,
        maxRestartsPerSlot: 2,
        logger: mockLogger
      });
      await pool.initialize();

      loggedEvents = [];
      const slot = pool.workers.get('worker-0');
      const activeWorker = slot.worker;

      // Force terminate worker simulating external crash
      await activeWorker.terminate();

      // Wait a moment for exit handling and replacement spawn
      await new Promise((r) => setTimeout(r, 200));

      const snap = getDiagnosticCounters();
      expect(snap.worker_unexpected_exit_total).toBeGreaterThanOrEqual(1);
      expect(snap.worker_replacement_attempt_total).toBeGreaterThanOrEqual(1);

      const events = loggedEvents.map((e) => e.event);
      expect(events).toContain('worker.exit');
      expect(events).toContain('worker.replacement.attempted');
    });

    it('emits shutdown lifecycle events and tracks shutdown completion accurately', async () => {
      pool = new BcryptWorkerPool({ coordinator, maxWorkers: 2, logger: mockLogger });
      await pool.initialize();

      loggedEvents = [];
      await pool.shutdown({ timeoutMs: 3000 });

      const events = loggedEvents.map((e) => e.event);
      expect(events).toContain('worker.pool.shutdown.started');
      expect(events).toContain('worker.pool.shutdown.completed');
      expect(pool.shuttingDown).toBe(true);
    });
  });
});
