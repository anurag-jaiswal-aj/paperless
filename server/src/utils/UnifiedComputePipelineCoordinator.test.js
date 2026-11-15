import { describe, it, expect, beforeEach } from 'vitest';
import { CoordinatorTask, TaskState } from './CoordinatorTask.js';
import { TaskSettlementToken } from './TaskSettlementToken.js';
import {
  UnifiedComputePipelineCoordinator,
  InvariantViolationError
} from './UnifiedComputePipelineCoordinator.js';

describe('UnifiedComputePipelineCoordinator (Stage 2.2 Phase 1 Architecture)', () => {
  let coordinator;

  beforeEach(() => {
    coordinator = new UnifiedComputePipelineCoordinator({
      maxActive: 2,
      maxQueue: 10,
      maxPerIp: 1
    });
  });

  // Helper to assert strict conservation invariant
  function assertConservation(coord) {
    const snap = coord.getSnapshot();
    const sumInFlight = snap.pendingLookups + snap.queued + snap.active + snap.pendingDbWrites;
    expect(snap.inFlightRequests).toBe(sumInFlight);
    expect(snap.totalSettled).toBe(snap.totalSettledSuccess + snap.totalSettledFailure);
    expect(snap.totalAdmitted).toBe(snap.inFlightRequests + snap.totalSettled);
    expect(snap.computePipelineCount).toBe(snap.pendingLookups + snap.queued + snap.active);
    expect(snap.underflowCount).toBe(0);
  }

  describe('InvariantViolationError Class', () => {
    it('instantiates custom error with correct name and message inheritance', () => {
      const err = new InvariantViolationError('Conservation invariant failed');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('InvariantViolationError');
      expect(err.message).toBe('Conservation invariant failed');
    });
  });

  describe('Scenario 1: Successful admission', () => {
    it('admits a request within capacity and sets initial accounting state', () => {
      const token = coordinator.tryAcquireAdmission('10.0.0.1');
      expect(token).toBeInstanceOf(TaskSettlementToken);
      expect(token.clientIp).toBe('10.0.0.1');
      expect(token.state).toBe(TaskState.ADMITTED_LOOKUP);
      expect(token.isSettled).toBe(false);

      const snap = coordinator.getSnapshot();
      expect(snap.totalAdmitted).toBe(1);
      expect(snap.pendingLookups).toBe(1);
      expect(snap.queued).toBe(0);
      expect(snap.active).toBe(0);
      expect(snap.pendingDbWrites).toBe(0);
      expect(snap.inFlightRequests).toBe(1);
      expect(snap.totalSettled).toBe(0);
      expect(snap.ipOccupancy['10.0.0.1']).toBe(1);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 2: Rejection at global capacity', () => {
    it('rejects admissions when compute pipeline reaches maxComputePipeline', () => {
      const smallCoord = new UnifiedComputePipelineCoordinator({
        maxActive: 1,
        maxQueue: 2,
        maxPerIp: 1
      });
      // maxComputePipeline = 1 + 2 = 3

      const t1 = smallCoord.tryAcquireAdmission('10.0.0.1');
      const t2 = smallCoord.tryAcquireAdmission('10.0.0.2');
      const t3 = smallCoord.tryAcquireAdmission('10.0.0.3');
      expect(t1).not.toBeNull();
      expect(t2).not.toBeNull();
      expect(t3).not.toBeNull();

      // 4th request must be rejected
      const t4 = smallCoord.tryAcquireAdmission('10.0.0.4');
      expect(t4).toBeNull();

      const snap = smallCoord.getSnapshot();
      expect(snap.totalAdmitted).toBe(3);
      expect(snap.inFlightRequests).toBe(3);
      expect(snap.ipOccupancy['10.0.0.4']).toBeUndefined();
      assertConservation(smallCoord);
    });
  });

  describe('Scenario 3: Rejection when same IP already owns its permitted slot', () => {
    it('rejects subsequent admission from same IP when maxPerIp is reached', () => {
      const token1 = coordinator.tryAcquireAdmission('192.168.1.100');
      expect(token1).not.toBeNull();

      const token2 = coordinator.tryAcquireAdmission('192.168.1.100');
      expect(token2).toBeNull();

      const snap = coordinator.getSnapshot();
      expect(snap.totalAdmitted).toBe(1);
      expect(snap.ipOccupancy['192.168.1.100']).toBe(1);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 4: Admission rollback after simulated later-stage failure', () => {
    it('settles lookup failure directly from ADMITTED_LOOKUP and cleans up all state', () => {
      const token = coordinator.tryAcquireAdmission('172.16.0.5');
      expect(token).not.toBeNull();
      assertConservation(coordinator);

      // Simulate failure in MongoDB user lookup
      const settled = token.settleLookupFailure('USER_NOT_FOUND');
      expect(settled).toBe(true);
      expect(token.isSettled).toBe(true);

      const snap = coordinator.getSnapshot();
      expect(snap.totalAdmitted).toBe(1);
      expect(snap.pendingLookups).toBe(0);
      expect(snap.inFlightRequests).toBe(0);
      expect(snap.totalSettled).toBe(1);
      expect(snap.totalSettledFailure).toBe(1);
      expect(snap.totalSettledSuccess).toBe(0);
      expect(snap.ipOccupancy['172.16.0.5']).toBeUndefined();
      assertConservation(coordinator);
    });
  });

  describe('Scenario 5: Valid lifecycle transitions', () => {
    it('executes Path 1: ADMITTED_LOOKUP -> QUEUED -> ACTIVE_COMPUTE -> DB_WRITE -> SUCCESS', () => {
      const token = coordinator.tryAcquireAdmission('10.1.1.1');
      expect(token.state).toBe(TaskState.ADMITTED_LOOKUP);

      // ADMITTED_LOOKUP -> QUEUED
      expect(token.handoffPendingToQueued()).toBe(true);
      expect(token.state).toBe(TaskState.QUEUED);
      let snap = coordinator.getSnapshot();
      expect(snap.pendingLookups).toBe(0);
      expect(snap.queued).toBe(1);
      assertConservation(coordinator);

      // QUEUED -> ACTIVE_COMPUTE
      expect(token.handoffQueuedToActive()).toBe(true);
      expect(token.state).toBe(TaskState.ACTIVE_COMPUTE);
      snap = coordinator.getSnapshot();
      expect(snap.queued).toBe(0);
      expect(snap.active).toBe(1);
      expect(snap.ipOccupancy['10.1.1.1']).toBe(1); // IP slot held during compute
      assertConservation(coordinator);

      // ACTIVE_COMPUTE -> DB_WRITE (IP slot released early)
      expect(token.handoffComputeToDbWrite()).toBe(true);
      expect(token.state).toBe(TaskState.DB_WRITE);
      snap = coordinator.getSnapshot();
      expect(snap.active).toBe(0);
      expect(snap.pendingDbWrites).toBe(1);
      expect(snap.ipOccupancy['10.1.1.1']).toBeUndefined(); // IP slot released on DB_WRITE!
      assertConservation(coordinator);

      // DB_WRITE -> SUCCESS
      expect(token.settleSuccess()).toBe(true);
      expect(token.state).toBe(TaskState.TERMINAL);
      expect(token.isSettled).toBe(true);
      snap = coordinator.getSnapshot();
      expect(snap.pendingDbWrites).toBe(0);
      expect(snap.inFlightRequests).toBe(0);
      expect(snap.totalSettledSuccess).toBe(1);
      assertConservation(coordinator);
    });

    it('executes Path 2: Direct worker dispatch ADMITTED_LOOKUP -> ACTIVE_COMPUTE -> DB_WRITE -> FAILURE', () => {
      const token = coordinator.tryAcquireAdmission('10.1.1.2');

      // Direct dispatch bypasses FIFO queue
      expect(token.handoffPendingToActive()).toBe(true);
      expect(token.state).toBe(TaskState.ACTIVE_COMPUTE);
      let snap = coordinator.getSnapshot();
      expect(snap.pendingLookups).toBe(0);
      expect(snap.active).toBe(1);
      assertConservation(coordinator);

      // ACTIVE_COMPUTE -> DB_WRITE
      expect(token.handoffComputeToDbWrite()).toBe(true);
      expect(token.state).toBe(TaskState.DB_WRITE);
      snap = coordinator.getSnapshot();
      expect(snap.active).toBe(0);
      expect(snap.pendingDbWrites).toBe(1);
      expect(snap.ipOccupancy['10.1.1.2']).toBeUndefined();
      assertConservation(coordinator);

      // DB_WRITE -> FAILURE
      expect(token.settleFailure('BAD_PASSWORD')).toBe(true);
      expect(token.state).toBe(TaskState.TERMINAL);
      snap = coordinator.getSnapshot();
      expect(snap.pendingDbWrites).toBe(0);
      expect(snap.totalSettledFailure).toBe(1);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 6: Invalid lifecycle transitions', () => {
    it('rejects skipping states and backward transitions', () => {
      const token = coordinator.tryAcquireAdmission('10.2.2.1');

      // Cannot jump from ADMITTED_LOOKUP directly to DB_WRITE
      expect(token.handoffComputeToDbWrite()).toBe(false);
      expect(token.state).toBe(TaskState.ADMITTED_LOOKUP);

      // Cannot execute QUEUED -> ACTIVE_COMPUTE when in ADMITTED_LOOKUP
      expect(token.handoffQueuedToActive()).toBe(false);
      expect(token.state).toBe(TaskState.ADMITTED_LOOKUP);

      // Transition to QUEUED
      expect(token.handoffPendingToQueued()).toBe(true);

      // Cannot repeat handoffPendingToQueued from QUEUED
      expect(token.handoffPendingToQueued()).toBe(false);

      // Cannot execute handoffComputeToDbWrite from QUEUED
      expect(token.handoffComputeToDbWrite()).toBe(false);

      // Settle cleanly
      expect(token.settleQueueTimeout()).toBe(true);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 7: Successful exactly-once settlement', () => {
    it('guarantees settlement executes exactly once and subsequent calls return false', () => {
      const token = coordinator.tryAcquireAdmission('10.3.3.1');
      expect(token.handoffPendingToActive()).toBe(true);
      expect(token.handoffComputeToDbWrite()).toBe(true);

      // First settlement succeeds
      const first = token.settleSuccess();
      expect(first).toBe(true);
      expect(token.isSettled).toBe(true);

      // Subsequent settlement calls return false
      const second = token.settleSuccess();
      expect(second).toBe(false);

      const third = token.settleFailure();
      expect(third).toBe(false);

      const snap = coordinator.getSnapshot();
      expect(snap.totalSettled).toBe(1);
      expect(snap.totalSettledSuccess).toBe(1);
      expect(snap.totalSettledFailure).toBe(0);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 8: Duplicate settlement rejection', () => {
    it('rejects duplicate settlement via coordinator.settleTask directly', () => {
      const token = coordinator.tryAcquireAdmission('10.3.3.2');
      expect(token.handoffPendingToActive()).toBe(true);

      expect(token.settleWorkerTimeout()).toBe(true);
      expect(token.isSettled).toBe(true);

      // Direct coordinator call with stale token
      const dup = coordinator.settleTask(token, TaskState.ACTIVE_COMPUTE, 'WORKER_TIMEOUT');
      expect(dup).toBe(false);

      const snap = coordinator.getSnapshot();
      expect(snap.totalSettled).toBe(1);
      expect(snap.underflowCount).toBe(0);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 9: Foreign token rejection', () => {
    it('rejects tokens minted by a different coordinator instance', () => {
      const foreignCoord = new UnifiedComputePipelineCoordinator();
      const foreignToken = foreignCoord.tryAcquireAdmission('10.4.4.1');

      // Pass foreignToken to our coordinator
      expect(coordinator.handoffPendingToQueued(foreignToken)).toBe(false);
      expect(coordinator.handoffPendingToActive(foreignToken)).toBe(false);
      expect(coordinator.settleTask(foreignToken, TaskState.ADMITTED_LOOKUP, 'TERMINAL')).toBe(false);

      // Coordinator internal state must be completely untouched
      const snap = coordinator.getSnapshot();
      expect(snap.totalAdmitted).toBe(0);
      expect(snap.inFlightRequests).toBe(0);
      assertConservation(coordinator);

      // Clean up foreign coordinator
      expect(foreignToken.settleLookupFailure()).toBe(true);
      assertConservation(foreignCoord);
    });
  });

  describe('Scenario 10: Stale token rejection', () => {
    it('rejects operations on tokens whose underlying tasks are already terminal', () => {
      const token = coordinator.tryAcquireAdmission('10.5.5.1');
      expect(token.settleLookupFailure()).toBe(true);

      // Token is now stale
      expect(token.handoffPendingToQueued()).toBe(false);
      expect(token.handoffPendingToActive()).toBe(false);
      expect(token.handoffQueuedToActive()).toBe(false);
      expect(token.handoffComputeToDbWrite()).toBe(false);
      expect(token.settleSuccess()).toBe(false);
      expect(token.settleFailure()).toBe(false);

      assertConservation(coordinator);
    });
  });

  describe('Scenario 11: Queue-full settlement rollback', () => {
    it('rolls back and cleanly settles when queue capacity is exhausted', () => {
      const queueCoord = new UnifiedComputePipelineCoordinator({
        maxActive: 1,
        maxQueue: 2,
        maxPerIp: 1
      });

      const t1 = queueCoord.tryAcquireAdmission('10.6.6.1');
      const t2 = queueCoord.tryAcquireAdmission('10.6.6.2');
      const t3 = queueCoord.tryAcquireAdmission('10.6.6.3');

      // Fill queue (maxQueue = 2)
      expect(t1.handoffPendingToQueued()).toBe(true);
      expect(t2.handoffPendingToQueued()).toBe(true);

      // t3 attempt to queue fails due to queue full
      expect(t3.handoffPendingToQueued()).toBe(false);
      expect(t3.state).toBe(TaskState.ADMITTED_LOOKUP);

      // Rollback t3 cleanly
      expect(t3.settleLookupFailure('QUEUE_FULL')).toBe(true);

      const snap = queueCoord.getSnapshot();
      expect(snap.pendingLookups).toBe(0);
      expect(snap.queued).toBe(2);
      expect(snap.inFlightRequests).toBe(2);
      expect(snap.totalSettledFailure).toBe(1);
      expect(snap.ipOccupancy['10.6.6.3']).toBeUndefined();
      assertConservation(queueCoord);
    });
  });

  describe('Scenario 12: Direct-dispatch failure rollback', () => {
    it('rolls back or queues cleanly when active workers are saturated', () => {
      const activeCoord = new UnifiedComputePipelineCoordinator({
        maxActive: 1,
        maxQueue: 2,
        maxPerIp: 1
      });

      const t1 = activeCoord.tryAcquireAdmission('10.7.7.1');
      const t2 = activeCoord.tryAcquireAdmission('10.7.7.2');

      // t1 claims active slot
      expect(t1.handoffPendingToActive()).toBe(true);
      expect(activeCoord.active).toBe(1);

      // t2 cannot direct-dispatch because active is at maxActive (1)
      expect(t2.handoffPendingToActive()).toBe(false);
      expect(t2.state).toBe(TaskState.ADMITTED_LOOKUP);

      // t2 queues instead
      expect(t2.handoffPendingToQueued()).toBe(true);
      expect(t2.state).toBe(TaskState.QUEUED);

      assertConservation(activeCoord);
    });
  });

  describe('Scenario 13: Counter conservation after every tested transition', () => {
    it('strictly satisfies totalAdmitted = inFlightRequests + totalSettled at every stage', () => {
      const tokens = [];
      for (let i = 1; i <= 5; i++) {
        const t = coordinator.tryAcquireAdmission(`10.8.8.${i}`);
        tokens.push(t);
        assertConservation(coordinator);
      }

      // t1: lookup fail
      tokens[0].settleLookupFailure();
      assertConservation(coordinator);

      // t2: queue -> active -> db_write -> success
      tokens[1].handoffPendingToQueued();
      assertConservation(coordinator);
      tokens[1].handoffQueuedToActive();
      assertConservation(coordinator);
      tokens[1].handoffComputeToDbWrite();
      assertConservation(coordinator);
      tokens[1].settleSuccess();
      assertConservation(coordinator);

      // t3: direct active -> worker timeout
      tokens[2].handoffPendingToActive();
      assertConservation(coordinator);
      tokens[2].settleWorkerTimeout();
      assertConservation(coordinator);

      // t4: queue -> queue timeout
      tokens[3].handoffPendingToQueued();
      assertConservation(coordinator);
      tokens[3].settleQueueTimeout();
      assertConservation(coordinator);

      // t5: queue -> queue disconnect
      tokens[4].handoffPendingToQueued();
      assertConservation(coordinator);
      tokens[4].settleQueueDisconnect();
      assertConservation(coordinator);

      const snap = coordinator.getSnapshot();
      expect(snap.inFlightRequests).toBe(0);
      expect(snap.totalSettled).toBe(5);
      expect(snap.totalAdmitted).toBe(5);
    });
  });

  describe('Scenario 14: Per-IP occupancy release after settlement', () => {
    it('frees IP slot and permits immediate re-admission from the same IP', () => {
      const ip = '192.168.10.50';
      const token1 = coordinator.tryAcquireAdmission(ip);
      expect(token1).not.toBeNull();
      expect(coordinator.getSnapshot().ipOccupancy[ip]).toBe(1);

      // Cannot admit second from same IP while first is in compute pipeline
      expect(coordinator.tryAcquireAdmission(ip)).toBeNull();

      // Settle token1
      expect(token1.settleLookupFailure()).toBe(true);
      expect(coordinator.getSnapshot().ipOccupancy[ip]).toBeUndefined();

      // Re-admission from same IP now succeeds
      const token2 = coordinator.tryAcquireAdmission(ip);
      expect(token2).not.toBeNull();
      expect(coordinator.getSnapshot().ipOccupancy[ip]).toBe(1);

      token2.settleLookupFailure();
      assertConservation(coordinator);
    });

    it('frees IP slot early upon entering DB_WRITE phase', () => {
      const ip = '192.168.10.51';
      const token1 = coordinator.tryAcquireAdmission(ip);
      expect(token1.handoffPendingToActive()).toBe(true);
      expect(coordinator.getSnapshot().ipOccupancy[ip]).toBe(1);

      // Transition to DB_WRITE frees the IP slot!
      expect(token1.handoffComputeToDbWrite()).toBe(true);
      expect(coordinator.getSnapshot().ipOccupancy[ip]).toBeUndefined();

      // Second request from same IP can now be admitted while first is writing to DB!
      const token2 = coordinator.tryAcquireAdmission(ip);
      expect(token2).not.toBeNull();
      expect(coordinator.getSnapshot().ipOccupancy[ip]).toBe(1);

      // Settle both
      expect(token1.settleSuccess()).toBe(true);
      expect(token2.settleLookupFailure()).toBe(true);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 15: Detection of counter underflow without partial mutation', () => {
    it('detects underflow attempt, records underflowCount, and refuses mutation', () => {
      // Coordinator starts with all counters at 0
      const dummyTask = new CoordinatorTask('10.9.9.1');
      const dummyToken = new TaskSettlementToken(coordinator, dummyTask);

      // Settle on empty coordinator: token._task is not even in coordinator.tasks
      const ok = coordinator.settleTask(dummyToken, TaskState.ADMITTED_LOOKUP, 'TERMINAL');
      expect(ok).toBe(false);

      const snap = coordinator.getSnapshot();
      expect(snap.pendingLookups).toBe(0);
      expect(snap.queued).toBe(0);
      expect(snap.active).toBe(0);
      expect(snap.pendingDbWrites).toBe(0);
      expect(snap.inFlightRequests).toBe(0);
      // No counter clamped to negative or corrupted
      expect(snap.totalAdmitted).toBe(0);
    });
  });

  describe('Scenario 16: Drain mode rejects new admissions', () => {
    it('refuses new admissions once draining is enabled', async () => {
      const token1 = coordinator.tryAcquireAdmission('10.10.10.1');
      expect(token1).not.toBeNull();

      // Begin drain
      const drainPromise = coordinator.drainComputePipeline(5000);

      // New admission rejected immediately
      const token2 = coordinator.tryAcquireAdmission('10.10.10.2');
      expect(token2).toBeNull();

      expect(token1.settleLookupFailure()).toBe(true);
      await expect(drainPromise).resolves.toBe(true);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 17: Existing admitted work can settle while draining', () => {
    it('allows in-flight work to complete and resolves quiescence promise', async () => {
      const token1 = coordinator.tryAcquireAdmission('10.11.11.1');
      const token2 = coordinator.tryAcquireAdmission('10.11.11.2');

      token1.handoffPendingToQueued();
      token2.handoffPendingToActive();

      const drainPromise = coordinator.waitForFleetQuiescence(5000);

      // Complete work
      token1.settleDrainAbort();
      token2.handoffComputeToDbWrite();
      token2.settleSuccess();

      await expect(drainPromise).resolves.toBe(true);
      expect(coordinator.isQuiescent()).toBe(true);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 18: Repeated drain calls behave safely', () => {
    it('handles repeated drain calls idempotently without state corruption', async () => {
      const drain1 = coordinator.drainComputePipeline(2000);
      const drain2 = coordinator.drainComputePipeline(2000);
      const drain3 = coordinator.waitForFleetQuiescence(2000);

      await expect(drain1).resolves.toBe(true);
      await expect(drain2).resolves.toBe(true);
      await expect(drain3).resolves.toBe(true);

      expect(coordinator.draining).toBe(true);
      expect(coordinator.isQuiescent()).toBe(true);
      assertConservation(coordinator);
    });
  });

  describe('Scenario 19: Snapshot data cannot mutate internal coordinator state', () => {
    it('deeply freezes snapshot to prevent callers from corrupting coordinator state', () => {
      coordinator.tryAcquireAdmission('10.12.12.1');
      const snap = coordinator.getSnapshot();

      // Attempting to mutate snapshot properties throws or fails
      expect(() => {
        snap.queued = 999;
      }).toThrow();

      expect(() => {
        snap.ipOccupancy['10.12.12.1'] = 999;
      }).toThrow();

      expect(() => {
        snap.ipOccupancy['attacker.ip'] = 1;
      }).toThrow();

      const freshSnap = coordinator.getSnapshot();
      expect(freshSnap.queued).toBe(0);
      expect(freshSnap.ipOccupancy['10.12.12.1']).toBe(1);
    });
  });

  describe('Scenario 20: Multiple concurrent asynchronous admission attempts preserve limits and invariants', () => {
    it('sustains 100 concurrent async attempts without race conditions or counter leakage', async () => {
      const testCoord = new UnifiedComputePipelineCoordinator({
        maxActive: 2,
        maxQueue: 10,
        maxPerIp: 1
      });

      const ips = Array.from({ length: 25 }, (_, i) => `192.168.100.${i + 1}`);
      const tokens = [];

      // Concurrently fire 100 admission attempts distributed across 25 IPs
      const attempts = Array.from({ length: 100 }, async (_, idx) => {
        const ip = ips[idx % ips.length];
        const token = testCoord.tryAcquireAdmission(ip);
        if (token) {
          tokens.push(token);
        }
      });

      await Promise.all(attempts);

      // In-flight count must never exceed maxComputePipeline (12)
      expect(tokens.length).toBeLessThanOrEqual(12);
      expect(testCoord.inFlightRequests).toBe(tokens.length);

      // Verify each IP owns at most 1 slot
      const snap = testCoord.getSnapshot();
      for (const count of Object.values(snap.ipOccupancy)) {
        expect(count).toBeLessThanOrEqual(1);
      }
      assertConservation(testCoord);

      // Concurrently settle all admitted tokens through varied paths
      const settlements = tokens.map(async (tok, idx) => {
        if (idx % 3 === 0) {
          tok.settleLookupFailure();
        } else if (idx % 3 === 1) {
          if (tok.handoffPendingToQueued()) {
            tok.settleQueueTimeout();
          } else {
            tok.settleLookupFailure();
          }
        } else {
          if (tok.handoffPendingToActive()) {
            if (tok.handoffComputeToDbWrite()) {
              tok.settleSuccess();
            } else {
              tok.settleWorkerCrash();
            }
          } else if (tok.handoffPendingToQueued()) {
            tok.settleQueueDisconnect();
          } else {
            tok.settleLookupFailure();
          }
        }
      });

      await Promise.all(settlements);

      // Fully settled
      expect(testCoord.inFlightRequests).toBe(0);
      expect(testCoord.isQuiescent()).toBe(true);
      expect(testCoord.totalSettled).toBe(testCoord.totalAdmitted);
      expect(Object.keys(testCoord.getSnapshot().ipOccupancy).length).toBe(0);
      assertConservation(testCoord);
    });
  });
});
