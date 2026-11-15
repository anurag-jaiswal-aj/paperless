import { describe, it, expect } from 'vitest';
import { CoordinatorTask, TaskState } from './CoordinatorTask.js';

describe('CoordinatorTask Design and Lifecycle Suite', () => {
  describe('TaskState Enumeration', () => {
    it('exports an immutable frozen TaskState object with 5 canonical states', () => {
      expect(Object.isFrozen(TaskState)).toBe(true);
      expect(TaskState).toEqual({
        ADMITTED_LOOKUP: 'ADMITTED_LOOKUP',
        QUEUED: 'QUEUED',
        ACTIVE_COMPUTE: 'ACTIVE_COMPUTE',
        DB_WRITE: 'DB_WRITE',
        TERMINAL: 'TERMINAL'
      });
      expect(() => {
        TaskState.NEW_STATE = 'NEW_STATE';
      }).toThrow();
    });
  });

  describe('Task Initialization and Canonical Identity', () => {
    it('creates an instance with a valid, unique UUID v4 taskId and correct initial state', () => {
      const task = new CoordinatorTask('192.168.1.100');

      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(task.taskId).toMatch(uuidV4Regex);
      expect(task._taskId).toBe(task.taskId);
      expect(task.clientIp).toBe('192.168.1.100');
      expect(task.state).toBe(TaskState.ADMITTED_LOOKUP);

      expect(task.inPendingLookup).toBe(true);
      expect(task.inQueue).toBe(false);
      expect(task.inActiveWorker).toBe(false);
      expect(task.inDbWrite).toBe(false);
      expect(task.settled).toBe(false);

      expect(task.clientDisconnected).toBe(false);
      expect(task.holdsIpSlot).toBe(true);
      expect(task.terminalReason).toBeNull();
      expect(typeof task.createdAt).toBe('number');
      expect(task.settledAt).toBeNull();
    });

    it('guarantees identity uniqueness across 1,000 distinct task instantiations', () => {
      const ids = new Set();
      const count = 1000;

      for (let i = 0; i < count; i++) {
        const task = new CoordinatorTask('127.0.0.1');
        ids.add(task.taskId);
      }

      expect(ids.size).toBe(count);
    });

    it('rejects invalid or empty clientIp arguments', () => {
      expect(() => new CoordinatorTask('')).toThrow(TypeError);
      expect(() => new CoordinatorTask('   ')).toThrow(TypeError);
      expect(() => new CoordinatorTask(null)).toThrow(TypeError);
      expect(() => new CoordinatorTask(undefined)).toThrow(TypeError);
      expect(() => new CoordinatorTask(12345)).toThrow(TypeError);
      expect(() => new CoordinatorTask({})).toThrow(TypeError);
    });

    it('enforces immutability: properties cannot be reassigned or mutated', () => {
      const task = new CoordinatorTask('10.0.0.1');

      expect(() => {
        task.taskId = 'tampered-id';
      }).toThrow();

      expect(() => {
        task.clientIp = '1.1.1.1';
      }).toThrow();

      expect(() => {
        task.state = TaskState.TERMINAL;
      }).toThrow();

      expect(() => {
        task.arbitraryField = 'injected';
      }).toThrow();
    });
  });

  describe('Valid Lifecycle Transitions', () => {
    it('executes Path 1: ADMITTED_LOOKUP -> QUEUED -> ACTIVE_COMPUTE -> DB_WRITE -> TERMINAL', () => {
      const task = new CoordinatorTask('10.0.0.2');
      expect(task.state).toBe(TaskState.ADMITTED_LOOKUP);

      task.transitionToQueued();
      expect(task.state).toBe(TaskState.QUEUED);
      expect(task.inQueue).toBe(true);
      expect(task.inPendingLookup).toBe(false);

      task.transitionToActiveFromQueue();
      expect(task.state).toBe(TaskState.ACTIVE_COMPUTE);
      expect(task.inActiveWorker).toBe(true);
      expect(task.inQueue).toBe(false);

      task.transitionToDbWrite();
      expect(task.state).toBe(TaskState.DB_WRITE);
      expect(task.inDbWrite).toBe(true);
      expect(task.inActiveWorker).toBe(false);

      task.transitionToTerminal('SUCCESS');
      expect(task.state).toBe(TaskState.TERMINAL);
      expect(task.settled).toBe(true);
      expect(task.terminalReason).toBe('SUCCESS');
      expect(typeof task.settledAt).toBe('number');
    });

    it('executes Path 2: Direct Worker Dispatch (ADMITTED_LOOKUP -> ACTIVE_COMPUTE -> DB_WRITE -> TERMINAL)', () => {
      const task = new CoordinatorTask('10.0.0.3');
      expect(task.state).toBe(TaskState.ADMITTED_LOOKUP);

      task.transitionToActiveFromLookup();
      expect(task.state).toBe(TaskState.ACTIVE_COMPUTE);
      expect(task.inActiveWorker).toBe(true);
      expect(task.inPendingLookup).toBe(false);

      task.transitionToDbWrite();
      expect(task.state).toBe(TaskState.DB_WRITE);

      task.transitionToTerminal('PASSWORD_MISMATCH');
      expect(task.state).toBe(TaskState.TERMINAL);
      expect(task.settled).toBe(true);
      expect(task.terminalReason).toBe('PASSWORD_MISMATCH');
    });

    it('executes Path 3: Direct Termination from ADMITTED_LOOKUP (Lookup failure)', () => {
      const task = new CoordinatorTask('10.0.0.4');
      task.transitionToTerminal('LOOKUP_FAILED');
      expect(task.state).toBe(TaskState.TERMINAL);
      expect(task.settled).toBe(true);
      expect(task.terminalReason).toBe('LOOKUP_FAILED');
    });

    it('executes Path 4: Direct Termination from QUEUED (Queue timeout)', () => {
      const task = new CoordinatorTask('10.0.0.5');
      task.transitionToQueued();
      task.transitionToTerminal('QUEUE_TIMEOUT');
      expect(task.state).toBe(TaskState.TERMINAL);
      expect(task.settled).toBe(true);
      expect(task.terminalReason).toBe('QUEUE_TIMEOUT');
    });

    it('executes Path 5: Direct Termination from ACTIVE_COMPUTE (Worker crash / timeout)', () => {
      const task = new CoordinatorTask('10.0.0.6');
      task.transitionToActiveFromLookup();
      task.transitionToTerminal('WORKER_TIMEOUT');
      expect(task.state).toBe(TaskState.TERMINAL);
      expect(task.settled).toBe(true);
      expect(task.terminalReason).toBe('WORKER_TIMEOUT');
    });

    it('executes Path 6: Direct Termination from DB_WRITE (Password mismatch / lockout)', () => {
      const task = new CoordinatorTask('10.0.0.7');
      task.transitionToActiveFromLookup();
      task.transitionToDbWrite();
      task.transitionToTerminal('LOCKOUT_TRIGGERED');
      expect(task.state).toBe(TaskState.TERMINAL);
      expect(task.settled).toBe(true);
      expect(task.terminalReason).toBe('LOCKOUT_TRIGGERED');
    });
  });

  describe('Rejection of Illegal Transitions', () => {
    it('rejects illegal transitions from ADMITTED_LOOKUP', () => {
      const task = new CoordinatorTask('10.0.0.8');
      expect(() => task.transitionToActiveFromQueue()).toThrow();
      expect(() => task.transitionToDbWrite()).toThrow();
    });

    it('rejects illegal transitions from QUEUED', () => {
      const task = new CoordinatorTask('10.0.0.9');
      task.transitionToQueued();
      expect(() => task.transitionToQueued()).toThrow();
      expect(() => task.transitionToActiveFromLookup()).toThrow();
      expect(() => task.transitionToDbWrite()).toThrow();
    });

    it('rejects illegal transitions from ACTIVE_COMPUTE', () => {
      const task = new CoordinatorTask('10.0.0.10');
      task.transitionToActiveFromLookup();
      expect(() => task.transitionToQueued()).toThrow();
      expect(() => task.transitionToActiveFromLookup()).toThrow();
      expect(() => task.transitionToActiveFromQueue()).toThrow();
    });

    it('rejects illegal transitions from DB_WRITE', () => {
      const task = new CoordinatorTask('10.0.0.11');
      task.transitionToActiveFromLookup();
      task.transitionToDbWrite();
      expect(() => task.transitionToQueued()).toThrow();
      expect(() => task.transitionToActiveFromLookup()).toThrow();
      expect(() => task.transitionToActiveFromQueue()).toThrow();
      expect(() => task.transitionToDbWrite()).toThrow();
    });

    it('rejects all transitions once in TERMINAL state (including double settlement)', () => {
      const task = new CoordinatorTask('10.0.0.12');
      task.transitionToTerminal('DONE');
      expect(() => task.transitionToQueued()).toThrow();
      expect(() => task.transitionToActiveFromLookup()).toThrow();
      expect(() => task.transitionToActiveFromQueue()).toThrow();
      expect(() => task.transitionToDbWrite()).toThrow();
      expect(() => task.transitionToTerminal('AGAIN')).toThrow();
    });
  });

  describe('Flag Synchronization, IP Slot Release, and Disconnect Tracking', () => {
    it('strictly maintains mutual exclusion: exactly one state flag is true in each state', () => {
      const task = new CoordinatorTask('172.16.0.1');

      const checkFlags = (expectedFlag) => {
        const flags = {
          inPendingLookup: task.inPendingLookup,
          inQueue: task.inQueue,
          inActiveWorker: task.inActiveWorker,
          inDbWrite: task.inDbWrite,
          settled: task.settled
        };

        const trueCount = Object.values(flags).filter(Boolean).length;
        expect(trueCount).toBe(1);
        expect(flags[expectedFlag]).toBe(true);
      };

      checkFlags('inPendingLookup');

      task.transitionToQueued();
      checkFlags('inQueue');

      task.transitionToActiveFromQueue();
      checkFlags('inActiveWorker');

      task.transitionToDbWrite();
      checkFlags('inDbWrite');

      task.transitionToTerminal('DONE');
      checkFlags('settled');
    });

    it('tracks and releases IP slot idempotently', () => {
      const task = new CoordinatorTask('172.16.0.2');
      expect(task.holdsIpSlot).toBe(true);

      expect(task.releaseIpSlot()).toBe(true);
      expect(task.holdsIpSlot).toBe(false);

      // Subsequent release call returns false
      expect(task.releaseIpSlot()).toBe(false);
      expect(task.holdsIpSlot).toBe(false);
    });

    it('marks and tracks client disconnection independently of lifecycle state', () => {
      const task = new CoordinatorTask('172.16.0.3');
      expect(task.clientDisconnected).toBe(false);

      task.markClientDisconnected();
      expect(task.clientDisconnected).toBe(true);

      task.transitionToQueued();
      expect(task.clientDisconnected).toBe(true);

      task.transitionToActiveFromQueue();
      expect(task.clientDisconnected).toBe(true);

      task.transitionToTerminal('CLIENT_DISCONNECT');
      expect(task.clientDisconnected).toBe(true);
    });
  });
});
