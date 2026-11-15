import crypto from 'node:crypto';

/**
 * TaskState enumeration for lifecycle state tracking.
 */
export const TaskState = Object.freeze({
  ADMITTED_LOOKUP: 'ADMITTED_LOOKUP',
  QUEUED: 'QUEUED',
  ACTIVE_COMPUTE: 'ACTIVE_COMPUTE',
  DB_WRITE: 'DB_WRITE',
  TERMINAL: 'TERMINAL'
});

/**
 * Represents an in-flight authentication request within the coordinator.
 * Encapsulates state transitions with strict validation to prevent invalid lifecycles.
 */
export class CoordinatorTask {
  #taskId;
  #clientIp;
  #state;
  #terminalReason;
  #clientDisconnected;
  #holdsIpSlot;
  #createdAt;
  #settledAt;

  /**
   * @param {string} clientIp
   */
  constructor(clientIp) {
    if (typeof clientIp !== 'string' || clientIp.trim().length === 0) {
      throw new TypeError('clientIp must be a non-empty string');
    }

    this.#taskId = crypto.randomUUID();
    this.#clientIp = clientIp.trim();
    this.#state = TaskState.ADMITTED_LOOKUP;
    this.#terminalReason = null;
    this.#clientDisconnected = false;
    this.#holdsIpSlot = true;
    this.#createdAt = Date.now();
    this.#settledAt = null;

    Object.seal(this);
  }

  /**
   * Immutable canonical task identifier.
   */
  get taskId() {
    return this.#taskId;
  }

  /**
   * Backward-compatibility alias.
   */
  get _taskId() {
    return this.#taskId;
  }

  /**
   * Client IP address associated with this task.
   */
  get clientIp() {
    return this.#clientIp;
  }

  /**
   * Current TaskState.
   */
  get state() {
    return this.#state;
  }

  /**
   * True if task is currently in ADMITTED_LOOKUP state.
   */
  get inPendingLookup() {
    return this.#state === TaskState.ADMITTED_LOOKUP;
  }

  /**
   * True if task is currently in QUEUED state.
   */
  get inQueue() {
    return this.#state === TaskState.QUEUED;
  }

  /**
   * True if task is currently in ACTIVE_COMPUTE state.
   */
  get inActiveWorker() {
    return this.#state === TaskState.ACTIVE_COMPUTE;
  }

  /**
   * True if task is currently in DB_WRITE state.
   */
  get inDbWrite() {
    return this.#state === TaskState.DB_WRITE;
  }

  /**
   * True if task is in TERMINAL state.
   */
  get settled() {
    return this.#state === TaskState.TERMINAL;
  }

  /**
   * Reason for terminal settlement, or null if not terminal.
   */
  get terminalReason() {
    return this.#terminalReason;
  }

  /**
   * Creation timestamp in epoch milliseconds.
   */
  get createdAt() {
    return this.#createdAt;
  }

  /**
   * Settlement timestamp in epoch milliseconds, or null if active.
   */
  get settledAt() {
    return this.#settledAt;
  }

  /**
   * Whether the client disconnected during processing.
   */
  get clientDisconnected() {
    return this.#clientDisconnected;
  }

  /**
   * Whether this task currently holds an IP concurrency slot.
   */
  get holdsIpSlot() {
    return this.#holdsIpSlot;
  }

  /**
   * Idempotently releases the IP slot held by this task.
   * Returns true on initial release, false if already released.
   */
  releaseIpSlot() {
    if (!this.#holdsIpSlot) {
      return false;
    }
    this.#holdsIpSlot = false;
    return true;
  }

  /**
   * Marks that the client connection has closed or aborted.
   */
  markClientDisconnected() {
    this.#clientDisconnected = true;
  }

  /**
   * Transition from ADMITTED_LOOKUP to QUEUED.
   */
  transitionToQueued() {
    if (this.#state !== TaskState.ADMITTED_LOOKUP) {
      throw new Error(`Illegal state transition: cannot transition to QUEUED from ${this.#state}`);
    }
    this.#state = TaskState.QUEUED;
    return this;
  }

  /**
   * Transition from ADMITTED_LOOKUP to ACTIVE_COMPUTE (direct worker dispatch).
   */
  transitionToActiveFromLookup() {
    if (this.#state !== TaskState.ADMITTED_LOOKUP) {
      throw new Error(`Illegal state transition: cannot transition to ACTIVE_COMPUTE from ${this.#state}`);
    }
    this.#state = TaskState.ACTIVE_COMPUTE;
    return this;
  }

  /**
   * Transition from QUEUED to ACTIVE_COMPUTE (queue worker dispatch).
   */
  transitionToActiveFromQueue() {
    if (this.#state !== TaskState.QUEUED) {
      throw new Error(`Illegal state transition: cannot transition to ACTIVE_COMPUTE from ${this.#state}`);
    }
    this.#state = TaskState.ACTIVE_COMPUTE;
    return this;
  }

  /**
   * Transition from ACTIVE_COMPUTE to DB_WRITE (compute completed).
   */
  transitionToDbWrite() {
    if (this.#state !== TaskState.ACTIVE_COMPUTE) {
      throw new Error(`Illegal state transition: cannot transition to DB_WRITE from ${this.#state}`);
    }
    this.#state = TaskState.DB_WRITE;
    return this;
  }

  /**
   * Transition from any active state to TERMINAL.
   * @param {string} reason
   */
  transitionToTerminal(reason) {
    if (this.#state === TaskState.TERMINAL) {
      throw new Error('Illegal state transition: task is already in TERMINAL state');
    }
    this.#terminalReason = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'TERMINATED';
    this.#settledAt = Date.now();
    this.#state = TaskState.TERMINAL;
    return this;
  }
}
