import { describe, it, expect } from 'vitest';
import { TaskSettlementToken } from './TaskSettlementToken.js';
import { CoordinatorTask, TaskState } from './CoordinatorTask.js';

/**
 * Mock coordinator helper to capture delegations and state transitions.
 */
class MockCoordinator {
  constructor() {
    this.handoffCalls = [];
    this.settleCalls = [];
    this.handoffReturnValue = true;
    this.settleReturnValue = true;
  }

  handoffPendingToQueued(token, ...args) {
    this.handoffCalls.push({ method: 'handoffPendingToQueued', token, args });
    return this.handoffReturnValue;
  }

  handoffQueuedToActive(token, ...args) {
    this.handoffCalls.push({ method: 'handoffQueuedToActive', token, args });
    return this.handoffReturnValue;
  }

  handoffPendingToActive(token, ...args) {
    this.handoffCalls.push({ method: 'handoffPendingToActive', token, args });
    return this.handoffReturnValue;
  }

  handoffComputeToDbWrite(token, ...args) {
    this.handoffCalls.push({ method: 'handoffComputeToDbWrite', token, args });
    return this.handoffReturnValue;
  }

  settleTask(token, expectedState, reason) {
    this.settleCalls.push({ token, expectedState, reason });
    if (this.settleReturnValue && token._task && typeof token._task.transitionToTerminal === 'function') {
      try {
        token._task.transitionToTerminal(reason);
      } catch {
        // Task might already be terminal in test edge cases
      }
    }
    return this.settleReturnValue;
  }
}

describe('TaskSettlementToken Design and Delegation Suite', () => {
  describe('Constructor Validation and Binding', () => {
    it('successfully binds coordinator and task instances', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.0.0.1');
      const token = new TaskSettlementToken(coordinator, task);

      expect(token._coordinator).toBe(coordinator);
      expect(token._task).toBe(task);
      expect(token.isOwnedBy(coordinator)).toBe(true);

      const foreignCoordinator = new MockCoordinator();
      expect(token.isOwnedBy(foreignCoordinator)).toBe(false);
    });

    it('rejects invalid or missing coordinator arguments', () => {
      const task = new CoordinatorTask('10.0.0.1');

      expect(() => new TaskSettlementToken(null, task)).toThrow(TypeError);
      expect(() => new TaskSettlementToken(undefined, task)).toThrow(TypeError);
      expect(() => new TaskSettlementToken('not-an-object', task)).toThrow(TypeError);
      expect(() => new TaskSettlementToken(12345, task)).toThrow(TypeError);
    });

    it('rejects invalid or missing task arguments', () => {
      const coordinator = new MockCoordinator();

      expect(() => new TaskSettlementToken(coordinator, null)).toThrow(TypeError);
      expect(() => new TaskSettlementToken(coordinator, undefined)).toThrow(TypeError);
      expect(() => new TaskSettlementToken(coordinator, 'not-an-object')).toThrow(TypeError);
      expect(() => new TaskSettlementToken(coordinator, {})).toThrow(TypeError);
      expect(() => new TaskSettlementToken(coordinator, { taskId: '' })).toThrow(TypeError);
      expect(() => new TaskSettlementToken(coordinator, { taskId: '   ' })).toThrow(TypeError);
      expect(() => new TaskSettlementToken(coordinator, { taskId: 12345 })).toThrow(TypeError);
    });

    it('enforces object sealing: prevents addition and mutation of properties', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.0.0.2');
      const token = new TaskSettlementToken(coordinator, task);

      expect(Object.isSealed(token)).toBe(true);

      expect(() => {
        token.injectedProperty = 'malicious';
      }).toThrow(TypeError);

      expect(() => {
        token._coordinator = new MockCoordinator();
      }).toThrow(TypeError);

      expect(() => {
        token._task = new CoordinatorTask('10.0.0.3');
      }).toThrow(TypeError);
    });
  });

  describe('Canonical Identity and Getters Immutability', () => {
    it('exposes canonical taskId, _taskId alias, clientIp, state, isSettled, clientDisconnected', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('192.168.1.50');
      const token = new TaskSettlementToken(coordinator, task);

      expect(token.taskId).toBe(task.taskId);
      expect(token._taskId).toBe(task.taskId);
      expect(token.clientIp).toBe('192.168.1.50');
      expect(token.state).toBe(TaskState.ADMITTED_LOOKUP);
      expect(token.isSettled).toBe(false);
      expect(token.clientDisconnected).toBe(false);
      expect(token.holdsIpSlot).toBe(true);
    });

    it('strictly prevents mutation of getters', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('192.168.1.51');
      const token = new TaskSettlementToken(coordinator, task);

      expect(() => {
        token.taskId = 'tampered-task-id';
      }).toThrow(TypeError);

      expect(() => {
        token._taskId = 'tampered-task-id';
      }).toThrow(TypeError);

      expect(() => {
        token.clientIp = '10.0.0.99';
      }).toThrow(TypeError);

      expect(() => {
        token.state = TaskState.TERMINAL;
      }).toThrow(TypeError);

      expect(() => {
        token.isSettled = true;
      }).toThrow(TypeError);

      expect(() => {
        token.clientDisconnected = true;
      }).toThrow(TypeError);
    });

    it('tracks client disconnection via markClientDisconnected()', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('192.168.1.52');
      const token = new TaskSettlementToken(coordinator, task);

      expect(token.clientDisconnected).toBe(false);
      token.markClientDisconnected();
      expect(token.clientDisconnected).toBe(true);
      expect(task.clientDisconnected).toBe(true);
    });

    it('works with duck-typed task objects that do not define markClientDisconnected method', () => {
      const coordinator = new MockCoordinator();
      const mockTask = {
        taskId: 'duck-typed-uuid',
        clientIp: '127.0.0.1',
        state: 'ADMITTED_LOOKUP',
        settled: false,
        clientDisconnected: false
      };
      const token = new TaskSettlementToken(coordinator, mockTask);

      expect(token.clientDisconnected).toBe(false);
      token.markClientDisconnected();
      expect(token.clientDisconnected).toBe(true);
      expect(mockTask.clientDisconnected).toBe(true);
    });
  });

  describe('State Handoff Delegations', () => {
    it('delegates handoffPendingToQueued to coordinator and returns boolean result', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('172.16.0.1');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.handoffPendingToQueued('extra-arg');
      expect(res).toBe(true);
      expect(coordinator.handoffCalls.length).toBe(1);
      expect(coordinator.handoffCalls[0].method).toBe('handoffPendingToQueued');
      expect(coordinator.handoffCalls[0].token).toBe(token);
      expect(coordinator.handoffCalls[0].args).toEqual(['extra-arg']);
    });

    it('delegates handoffQueuedToActive to coordinator and returns boolean result', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('172.16.0.2');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.handoffQueuedToActive('worker-id-1');
      expect(res).toBe(true);
      expect(coordinator.handoffCalls.length).toBe(1);
      expect(coordinator.handoffCalls[0].method).toBe('handoffQueuedToActive');
      expect(coordinator.handoffCalls[0].token).toBe(token);
      expect(coordinator.handoffCalls[0].args).toEqual(['worker-id-1']);
    });

    it('delegates handoffPendingToActive to coordinator and returns boolean result', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('172.16.0.3');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.handoffPendingToActive('worker-id-2');
      expect(res).toBe(true);
      expect(coordinator.handoffCalls.length).toBe(1);
      expect(coordinator.handoffCalls[0].method).toBe('handoffPendingToActive');
      expect(coordinator.handoffCalls[0].token).toBe(token);
      expect(coordinator.handoffCalls[0].args).toEqual(['worker-id-2']);
    });

    it('delegates handoffComputeToDbWrite to coordinator and returns boolean result', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('172.16.0.4');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.handoffComputeToDbWrite();
      expect(res).toBe(true);
      expect(coordinator.handoffCalls.length).toBe(1);
      expect(coordinator.handoffCalls[0].method).toBe('handoffComputeToDbWrite');
      expect(coordinator.handoffCalls[0].token).toBe(token);
      expect(coordinator.handoffCalls[0].args).toEqual([]);
    });

    it('propagates false when coordinator handoff returns false', () => {
      const coordinator = new MockCoordinator();
      coordinator.handoffReturnValue = false;
      const task = new CoordinatorTask('172.16.0.5');
      const token = new TaskSettlementToken(coordinator, task);

      expect(token.handoffPendingToQueued()).toBe(false);
      expect(token.handoffQueuedToActive()).toBe(false);
      expect(token.handoffPendingToActive()).toBe(false);
      expect(token.handoffComputeToDbWrite()).toBe(false);
    });

    it('prevents handoff execution once task is settled', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('172.16.0.6');
      task.transitionToTerminal('TERMINATED_EARLY');
      const token = new TaskSettlementToken(coordinator, task);

      expect(token.isSettled).toBe(true);
      expect(token.handoffPendingToQueued()).toBe(false);
      expect(token.handoffQueuedToActive()).toBe(false);
      expect(token.handoffPendingToActive()).toBe(false);
      expect(token.handoffComputeToDbWrite()).toBe(false);
      expect(coordinator.handoffCalls.length).toBe(0);
    });
  });

  describe('Terminal Settlement Delegations', () => {
    it('settleSuccess delegates to coordinator with DB_WRITE state and default/custom reason', () => {
      const coordinator = new MockCoordinator();
      const task1 = new CoordinatorTask('10.1.1.1');
      const token1 = new TaskSettlementToken(coordinator, task1);

      const res1 = token1.settleSuccess();
      expect(res1).toBe(true);
      expect(coordinator.settleCalls.length).toBe(1);
      expect(coordinator.settleCalls[0].expectedState).toBe(TaskState.DB_WRITE);
      expect(coordinator.settleCalls[0].reason).toBe('SUCCESS');

      const task2 = new CoordinatorTask('10.1.1.2');
      const token2 = new TaskSettlementToken(coordinator, task2);
      const res2 = token2.settleSuccess('CUSTOM_SUCCESS');
      expect(res2).toBe(true);
      expect(coordinator.settleCalls.length).toBe(2);
      expect(coordinator.settleCalls[1].expectedState).toBe(TaskState.DB_WRITE);
      expect(coordinator.settleCalls[1].reason).toBe('CUSTOM_SUCCESS');
    });

    it('settleFailure delegates to coordinator with DB_WRITE state and default/custom reason', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.1.1.3');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.settleFailure();
      expect(res).toBe(true);
      expect(coordinator.settleCalls[0].expectedState).toBe(TaskState.DB_WRITE);
      expect(coordinator.settleCalls[0].reason).toBe('FAILURE');
    });

    it('settleLookupFailure delegates to coordinator with ADMITTED_LOOKUP state and default/custom reason', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.1.1.4');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.settleLookupFailure();
      expect(res).toBe(true);
      expect(coordinator.settleCalls[0].expectedState).toBe(TaskState.ADMITTED_LOOKUP);
      expect(coordinator.settleCalls[0].reason).toBe('LOOKUP_FAILED');

      const task2 = new CoordinatorTask('10.1.1.5');
      const token2 = new TaskSettlementToken(coordinator, task2);
      token2.settleLookupFailure('USER_NOT_FOUND');
      expect(coordinator.settleCalls[1].expectedState).toBe(TaskState.ADMITTED_LOOKUP);
      expect(coordinator.settleCalls[1].reason).toBe('USER_NOT_FOUND');
    });

    it('settleQueueTimeout delegates to coordinator with QUEUED state and default/custom reason', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.1.1.6');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.settleQueueTimeout();
      expect(res).toBe(true);
      expect(coordinator.settleCalls[0].expectedState).toBe(TaskState.QUEUED);
      expect(coordinator.settleCalls[0].reason).toBe('QUEUE_TIMEOUT');
    });

    it('settleQueueDisconnect delegates to coordinator with QUEUED state and default/custom reason', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.1.1.7');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.settleQueueDisconnect();
      expect(res).toBe(true);
      expect(coordinator.settleCalls[0].expectedState).toBe(TaskState.QUEUED);
      expect(coordinator.settleCalls[0].reason).toBe('CLIENT_DISCONNECTED_BEFORE_DISPATCH');

      const task2 = new CoordinatorTask('10.1.1.8');
      const token2 = new TaskSettlementToken(coordinator, task2);
      token2.settleQueueDisconnect('SOCKET_ABORT');
      expect(coordinator.settleCalls[1].expectedState).toBe(TaskState.QUEUED);
      expect(coordinator.settleCalls[1].reason).toBe('SOCKET_ABORT');
    });

    it('settleWorkerTimeout delegates to coordinator with ACTIVE_COMPUTE state and default/custom reason', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.1.1.9');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.settleWorkerTimeout();
      expect(res).toBe(true);
      expect(coordinator.settleCalls[0].expectedState).toBe(TaskState.ACTIVE_COMPUTE);
      expect(coordinator.settleCalls[0].reason).toBe('WORKER_TIMEOUT');
    });

    it('settleWorkerCrash delegates to coordinator with ACTIVE_COMPUTE state and default/custom reason', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.1.1.10');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.settleWorkerCrash();
      expect(res).toBe(true);
      expect(coordinator.settleCalls[0].expectedState).toBe(TaskState.ACTIVE_COMPUTE);
      expect(coordinator.settleCalls[0].reason).toBe('WORKER_CRASH');
    });

    it('settleDrainAbort delegates to coordinator with current task state and default/custom reason', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('10.1.1.11');
      task.transitionToQueued();
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.settleDrainAbort();
      expect(res).toBe(true);
      expect(coordinator.settleCalls[0].expectedState).toBe(TaskState.QUEUED);
      expect(coordinator.settleCalls[0].reason).toBe('DRAIN_ABORT');
    });
  });

  describe('Exactly-Once Settlement Semantics', () => {
    it('returns false immediately on subsequent settlement calls once settled', () => {
      const coordinator = new MockCoordinator();
      const task = new CoordinatorTask('192.168.0.10');
      const token = new TaskSettlementToken(coordinator, task);

      const firstSettle = token.settleLookupFailure('LOOKUP_FAILED');
      expect(firstSettle).toBe(true);
      expect(token.isSettled).toBe(true);
      expect(coordinator.settleCalls.length).toBe(1);

      expect(token.settleSuccess()).toBe(false);
      expect(token.settleFailure()).toBe(false);
      expect(token.settleLookupFailure()).toBe(false);
      expect(token.settleQueueTimeout()).toBe(false);
      expect(token.settleQueueDisconnect()).toBe(false);
      expect(token.settleWorkerTimeout()).toBe(false);
      expect(token.settleWorkerCrash()).toBe(false);
      expect(token.settleDrainAbort()).toBe(false);

      expect(coordinator.settleCalls.length).toBe(1);
    });

    it('propagates false when coordinator settlement rejects (e.g. state mismatch)', () => {
      const coordinator = new MockCoordinator();
      coordinator.settleReturnValue = false;
      const task = new CoordinatorTask('192.168.0.11');
      const token = new TaskSettlementToken(coordinator, task);

      const res = token.settleSuccess('SUCCESS');
      expect(res).toBe(false);
      expect(token.isSettled).toBe(false);
    });
  });
});
