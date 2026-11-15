import { TaskState } from './CoordinatorTask.js';

/**
 * TaskSettlementToken
 *
 * Lightweight capability token bound to a specific UnifiedComputePipelineCoordinator
 * instance and an underlying CoordinatorTask.
 *
 * Exposes canonical taskId with defensive backward-compatible _taskId alias,
 * state and telemetry getters, client disconnect notification, handoff delegations,
 * and guarded terminal settlement methods.
 */
export class TaskSettlementToken {
  /**
   * @param {object} coordinator
   * @param {object} task
   */
  constructor(coordinator, task) {
    if (!coordinator || typeof coordinator !== 'object') {
      throw new TypeError('coordinator must be a valid object');
    }
    if (!task || typeof task !== 'object' || typeof task.taskId !== 'string' || task.taskId.trim().length === 0) {
      throw new TypeError('task must be a valid task object with a non-empty string taskId');
    }

    // Bind references as non-writable, non-configurable, enumerable properties
    Object.defineProperty(this, '_coordinator', {
      value: coordinator,
      writable: false,
      enumerable: true,
      configurable: false
    });

    Object.defineProperty(this, '_task', {
      value: task,
      writable: false,
      enumerable: true,
      configurable: false
    });

    // Seal token instance to prevent unauthorized tampering
    Object.seal(this);
  }

  /**
   * Immutable canonical taskId.
   */
  get taskId() {
    return this._task.taskId;
  }

  /**
   * Defensive backward-compatibility alias returning canonical taskId.
   */
  get _taskId() {
    return this._task.taskId;
  }

  /**
   * Client IP address associated with this task.
   */
  get clientIp() {
    return this._task.clientIp;
  }

  /**
   * Current lifecycle state of the task.
   */
  get state() {
    return this._task.state;
  }

  /**
   * Whether the underlying task has reached terminal settlement.
   */
  get isSettled() {
    return Boolean(this._task.settled || this._task.isSettled);
  }

  /**
   * Whether the client disconnected during processing.
   */
  get clientDisconnected() {
    return Boolean(this._task.clientDisconnected);
  }

  /**
   * Whether this token task currently holds an IP concurrency slot.
   */
  get holdsIpSlot() {
    return Boolean(this._task.holdsIpSlot);
  }

  /**
   * Marks that the client connection has closed or aborted.
   */
  markClientDisconnected() {
    if (typeof this._task.markClientDisconnected === 'function') {
      this._task.markClientDisconnected();
    } else {
      this._task.clientDisconnected = true;
    }
  }

  /**
   * Verifies that this token is owned by and bound to the specified coordinator.
   * @param {object} coordinator
   * @returns {boolean}
   */
  isOwnedBy(coordinator) {
    return this._coordinator === coordinator;
  }

  // State Handoff Delegations

  /**
   * Transition from ADMITTED_LOOKUP to QUEUED.
   * @returns {boolean}
   */
  handoffPendingToQueued(...args) {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.handoffPendingToQueued(this, ...args));
  }

  /**
   * Transition from QUEUED to ACTIVE_COMPUTE.
   * @returns {boolean}
   */
  handoffQueuedToActive(...args) {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.handoffQueuedToActive(this, ...args));
  }

  /**
   * Transition from ADMITTED_LOOKUP to ACTIVE_COMPUTE (direct worker dispatch).
   * @returns {boolean}
   */
  handoffPendingToActive(...args) {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.handoffPendingToActive(this, ...args));
  }

  /**
   * Transition from ACTIVE_COMPUTE to DB_WRITE.
   * @returns {boolean}
   */
  handoffComputeToDbWrite(...args) {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.handoffComputeToDbWrite(this, ...args));
  }

  // Terminal Settlement Delegations

  /**
   * Terminal settlement on successful authentication completion from DB_WRITE.
   * @param {string} [reason='SUCCESS']
   * @returns {boolean}
   */
  settleSuccess(reason = 'SUCCESS') {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.settleTask(this, TaskState.DB_WRITE, reason));
  }

  /**
   * Terminal settlement on authentication failure from DB_WRITE.
   * @param {string} [reason='FAILURE']
   * @returns {boolean}
   */
  settleFailure(reason = 'FAILURE') {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.settleTask(this, TaskState.DB_WRITE, reason));
  }

  /**
   * Terminal settlement on MongoDB lookup error from ADMITTED_LOOKUP.
   * @param {string} [reason='LOOKUP_FAILED']
   * @returns {boolean}
   */
  settleLookupFailure(reason = 'LOOKUP_FAILED') {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.settleTask(this, TaskState.ADMITTED_LOOKUP, reason));
  }

  /**
   * Terminal settlement on FIFO queue wait timeout from QUEUED.
   * @param {string} [reason='QUEUE_TIMEOUT']
   * @returns {boolean}
   */
  settleQueueTimeout(reason = 'QUEUE_TIMEOUT') {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.settleTask(this, TaskState.QUEUED, reason));
  }

  /**
   * Terminal settlement on client TCP disconnect while waiting in QUEUED state.
   * @param {string} [reason='CLIENT_DISCONNECTED_BEFORE_DISPATCH']
   * @returns {boolean}
   */
  settleQueueDisconnect(reason = 'CLIENT_DISCONNECTED_BEFORE_DISPATCH') {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.settleTask(this, TaskState.QUEUED, reason));
  }

  /**
   * Terminal settlement on worker thread timeout from ACTIVE_COMPUTE.
   * @param {string} [reason='WORKER_TIMEOUT']
   * @returns {boolean}
   */
  settleWorkerTimeout(reason = 'WORKER_TIMEOUT') {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.settleTask(this, TaskState.ACTIVE_COMPUTE, reason));
  }

  /**
   * Terminal settlement on worker thread crash/error from ACTIVE_COMPUTE.
   * @param {string} [reason='WORKER_CRASH']
   * @returns {boolean}
   */
  settleWorkerCrash(reason = 'WORKER_CRASH') {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.settleTask(this, TaskState.ACTIVE_COMPUTE, reason));
  }

  /**
   * Terminal settlement during coordinator graceful drain abort.
   * Settles task from its current active state.
   * @param {string} [reason='DRAIN_ABORT']
   * @returns {boolean}
   */
  settleDrainAbort(reason = 'DRAIN_ABORT') {
    if (this.isSettled) {
      return false;
    }
    return Boolean(this._coordinator.settleTask(this, this._task.state, reason));
  }
}

export default TaskSettlementToken;
