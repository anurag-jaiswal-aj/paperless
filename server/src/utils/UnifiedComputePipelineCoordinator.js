import { EventEmitter } from 'node:events';
import { CoordinatorTask, TaskState } from './CoordinatorTask.js';
import { TaskSettlementToken } from './TaskSettlementToken.js';

/**
 * Error raised on coordinator accounting or state invariant violations.
 */
export class InvariantViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

/**
 * UnifiedComputePipelineCoordinator
 *
 * Implements bounded logical admission, resource accounting, and lifecycle coordination
 * for progressive login protection.
 *
 * Enforces the strict conservation law:
 *   totalAdmitted(t) = inFlightRequests(t) + totalSettled(t)
 * where:
 *   inFlightRequests = pendingLookups + queued + active + pendingDbWrites
 *   totalSettled = totalSettledSuccess + totalSettledFailure
 */
export class UnifiedComputePipelineCoordinator extends EventEmitter {
  /**
   * @param {object} [options={}]
   * @param {number} [options.maxActive=2]
   * @param {number} [options.maxQueue=10]
   * @param {number} [options.maxPerIp=1]
   */
  constructor(options = {}) {
    super();

    this.maxActive =
      Number.isInteger(options.maxActive) && options.maxActive > 0 ? options.maxActive : 2;
    this.maxQueue =
      Number.isInteger(options.maxQueue) && options.maxQueue >= 0 ? options.maxQueue : 10;
    this.maxComputePipeline = this.maxActive + this.maxQueue;
    this.maxPerIp =
      Number.isInteger(options.maxPerIp) && options.maxPerIp > 0 ? options.maxPerIp : 1;

    // Instantaneous in-flight counters (strictly conserved)
    this.pendingLookups = 0;
    this.queued = 0;
    this.active = 0;
    this.pendingDbWrites = 0;

    // Cumulative lifetime metrics
    this.totalAdmitted = 0;
    this.totalSettledSuccess = 0;
    this.totalSettledFailure = 0;
    this.underflowCount = 0;

    // State collections
    this.ipOccupancy = new Map();
    this.tasks = new Map();
    this.draining = false;
  }

  /**
   * Sum of all currently in-flight logical requests.
   */
  get inFlightRequests() {
    return this.pendingLookups + this.queued + this.active + this.pendingDbWrites;
  }

  /**
   * Total number of settled requests across all terminal reasons.
   */
  get totalSettled() {
    return this.totalSettledSuccess + this.totalSettledFailure;
  }

  /**
   * Sum of requests in the compute pipeline (excluding DB_WRITE).
   */
  get computePipelineCount() {
    return this.pendingLookups + this.queued + this.active;
  }

  /**
   * True if no requests are in flight.
   */
  isQuiescent() {
    return this.inFlightRequests === 0;
  }

  /**
   * 4-Tier Precondition Validation Gate:
   * 1. Token instance and coordinator ownership binding.
   * 2. Task existence in registry.
   * 3. Task instance identity matching token reference.
   * 4. State correctness and non-terminal check.
   *
   * @param {TaskSettlementToken} token
   * @param {string} [expectedState]
   * @returns {CoordinatorTask|null}
   */
  _validateTask(token, expectedState) {
    if (!token || !(token instanceof TaskSettlementToken)) {
      return null;
    }
    if (typeof token.isOwnedBy === 'function') {
      if (!token.isOwnedBy(this)) {
        return null;
      }
    } else if (token._coordinator !== this) {
      return null;
    }

    const task = this.tasks.get(token.taskId);
    if (!task) {
      return null;
    }
    if (token._task && task !== token._task) {
      return null;
    }
    if (task.settled) {
      return null;
    }
    if (expectedState && task.state !== expectedState) {
      return null;
    }

    return task;
  }

  /**
   * Idempotently releases the IP concurrency slot for a task or IP address.
   * @param {CoordinatorTask|string} taskOrIp
   */
  _releaseIpSlot(taskOrIp) {
    let ip = null;

    if (taskOrIp && typeof taskOrIp === 'object') {
      if (typeof taskOrIp.releaseIpSlot === 'function') {
        if (!taskOrIp.releaseIpSlot()) {
          return; // Already released by this specific task
        }
      } else if (taskOrIp.holdsIpSlot !== undefined) {
        if (!taskOrIp.holdsIpSlot) {
          return;
        }
        taskOrIp.holdsIpSlot = false;
      }
      ip = taskOrIp.clientIp;
    } else if (typeof taskOrIp === 'string') {
      ip = taskOrIp.trim();
    }

    if (!ip) {
      return;
    }

    const currentCount = this.ipOccupancy.get(ip);
    if (currentCount !== undefined) {
      if (currentCount <= 1) {
        this.ipOccupancy.delete(ip);
      } else {
        this.ipOccupancy.set(ip, currentCount - 1);
      }
    }
  }

  /**
   * Attempts atomic logical admission for a client request.
   * @param {string} clientIp
   * @returns {TaskSettlementToken|null}
   */
  tryAcquireAdmission(clientIp) {
    if (this.draining) {
      return null;
    }
    if (typeof clientIp !== 'string' || clientIp.trim().length === 0) {
      return null;
    }
    const normalizedIp = clientIp.trim();

    if (this.computePipelineCount >= this.maxComputePipeline) {
      return null;
    }

    const ipCount = this.ipOccupancy.get(normalizedIp) || 0;
    if (ipCount >= this.maxPerIp) {
      return null;
    }

    // Atomic logical admission
    this.totalAdmitted++;
    this.pendingLookups++;
    this.ipOccupancy.set(normalizedIp, ipCount + 1);

    const task = new CoordinatorTask(normalizedIp);
    this.tasks.set(task.taskId, task);

    return new TaskSettlementToken(this, task);
  }

  /**
   * Transitions a task from ADMITTED_LOOKUP to QUEUED.
   * @param {TaskSettlementToken} token
   * @returns {boolean}
   */
  handoffPendingToQueued(token) {
    const task = this._validateTask(token, TaskState.ADMITTED_LOOKUP);
    if (!task || !task.inPendingLookup) {
      return false;
    }

    if (this.pendingLookups <= 0) {
      this.underflowCount++;
      return false;
    }

    if (this.queued >= this.maxQueue) {
      return false;
    }

    this.pendingLookups--;
    this.queued++;

    if (typeof task.transitionToQueued === 'function') {
      task.transitionToQueued();
    } else {
      task.inPendingLookup = false;
      task.inQueue = true;
      task.state = TaskState.QUEUED;
    }

    return true;
  }

  /**
   * Transitions a task from QUEUED to ACTIVE_COMPUTE.
   * @param {TaskSettlementToken} token
   * @returns {boolean}
   */
  handoffQueuedToActive(token) {
    const task = this._validateTask(token, TaskState.QUEUED);
    if (!task || !task.inQueue) {
      return false;
    }

    if (this.queued <= 0) {
      this.underflowCount++;
      return false;
    }

    if (this.active >= this.maxActive) {
      return false;
    }

    this.queued--;
    this.active++;

    if (typeof task.transitionToActiveFromQueue === 'function') {
      task.transitionToActiveFromQueue();
    } else {
      task.inQueue = false;
      task.inActiveWorker = true;
      task.state = TaskState.ACTIVE_COMPUTE;
    }

    return true;
  }

  /**
   * Transitions a task directly from ADMITTED_LOOKUP to ACTIVE_COMPUTE.
   * @param {TaskSettlementToken} token
   * @returns {boolean}
   */
  handoffPendingToActive(token) {
    const task = this._validateTask(token, TaskState.ADMITTED_LOOKUP);
    if (!task || !task.inPendingLookup) {
      return false;
    }

    if (this.pendingLookups <= 0) {
      this.underflowCount++;
      return false;
    }

    if (this.active >= this.maxActive) {
      return false;
    }

    this.pendingLookups--;
    this.active++;

    if (typeof task.transitionToActiveFromLookup === 'function') {
      task.transitionToActiveFromLookup();
    } else {
      task.inPendingLookup = false;
      task.inActiveWorker = true;
      task.state = TaskState.ACTIVE_COMPUTE;
    }

    return true;
  }

  /**
   * Transitions a task from ACTIVE_COMPUTE to DB_WRITE.
   * Releases the IP occupancy slot upon entering DB_WRITE.
   * @param {TaskSettlementToken} token
   * @returns {boolean}
   */
  handoffComputeToDbWrite(token) {
    const task = this._validateTask(token, TaskState.ACTIVE_COMPUTE);
    if (!task || !task.inActiveWorker) {
      return false;
    }

    if (this.active <= 0) {
      this.underflowCount++;
      return false;
    }

    this.active--;
    this.pendingDbWrites++;

    if (typeof task.transitionToDbWrite === 'function') {
      task.transitionToDbWrite();
    } else {
      task.inActiveWorker = false;
      task.inDbWrite = true;
      task.state = TaskState.DB_WRITE;
    }

    // IP slot is released upon entering DB write phase
    this._releaseIpSlot(task);

    return true;
  }

  /**
   * Terminates and settles a task from any valid lifecycle state.
   * Reconciles counters, releases IP slot if still held, and deletes task from registry.
   *
   * @param {TaskSettlementToken} token
   * @param {string} expectedState
   * @param {string} [reason='TERMINAL']
   * @returns {boolean}
   */
  settleTask(token, expectedState, reason = 'TERMINAL') {
    const task = this._validateTask(token, expectedState);
    if (!task) {
      return false;
    }

    let counterName = null;
    switch (expectedState) {
      case TaskState.ADMITTED_LOOKUP:
        if (!task.inPendingLookup) return false;
        counterName = 'pendingLookups';
        break;
      case TaskState.QUEUED:
        if (!task.inQueue) return false;
        counterName = 'queued';
        break;
      case TaskState.ACTIVE_COMPUTE:
        if (!task.inActiveWorker) return false;
        counterName = 'active';
        break;
      case TaskState.DB_WRITE:
        if (!task.inDbWrite) return false;
        counterName = 'pendingDbWrites';
        break;
      default:
        return false;
    }

    if (this[counterName] <= 0) {
      this.underflowCount++;
      return false; // Zero mutation on underflow detection
    }

    this[counterName]--;

    if (typeof task.transitionToTerminal === 'function') {
      task.transitionToTerminal(reason);
    } else {
      if (counterName === 'pendingLookups') task.inPendingLookup = false;
      if (counterName === 'queued') task.inQueue = false;
      if (counterName === 'active') task.inActiveWorker = false;
      if (counterName === 'pendingDbWrites') task.inDbWrite = false;
      task.state = TaskState.TERMINAL;
      task.settled = true;
      task.settleReason = reason;
    }

    if (reason === 'SUCCESS') {
      this.totalSettledSuccess++;
    } else {
      this.totalSettledFailure++;
    }

    // Release IP slot if not already released during DB_WRITE transition
    this._releaseIpSlot(task);

    this.tasks.delete(task.taskId);

    if (this.draining && this.inFlightRequests === 0) {
      this.emit('drainComplete');
    }

    return true;
  }

  /**
   * Provides an observable, isolated snapshot of coordinator state.
   * Returned object is deeply frozen to prevent external mutation.
   * @returns {object}
   */
  getSnapshot() {
    const ipOccupancyCopy = {};
    for (const [ip, count] of this.ipOccupancy.entries()) {
      ipOccupancyCopy[ip] = count;
    }

    return Object.freeze({
      inFlightRequests: this.inFlightRequests,
      pendingLookups: this.pendingLookups,
      queued: this.queued,
      active: this.active,
      pendingDbWrites: this.pendingDbWrites,
      totalAdmitted: this.totalAdmitted,
      totalSettled: this.totalSettled,
      totalSettledSuccess: this.totalSettledSuccess,
      totalSettledFailure: this.totalSettledFailure,
      underflowCount: this.underflowCount,
      computePipelineCount: this.computePipelineCount,
      ipOccupancy: Object.freeze(ipOccupancyCopy),
      draining: this.draining,
      tasksCount: this.tasks.size
    });
  }

  /**
   * Synchronously starts draining the compute pipeline, rejecting any new admissions.
   */
  startDraining() {
    this.draining = true;
    if (this.inFlightRequests === 0) {
      this.emit('drainComplete');
    }
  }

  /**
   * Initiates graceful shutdown and waits for in-flight tasks to quiesce.
   * @param {number} [timeoutMs=15000]
   * @returns {Promise<boolean>}
   */
  async waitForFleetQuiescence(timeoutMs = 15000) {
    this.startDraining();
    if (this.inFlightRequests === 0) {
      return true;
    }

    return new Promise((resolve, reject) => {
      let timer = null;

      const onDrainComplete = () => {
        cleanup();
        resolve(true);
      };

      const onTimeout = () => {
        cleanup();
        reject(
          new Error(
            `Fleet quiescence timeout: ${this.inFlightRequests} in-flight request(s) remaining`
          )
        );
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.removeListener('drainComplete', onDrainComplete);
      };

      timer = setTimeout(onTimeout, timeoutMs);
      this.once('drainComplete', onDrainComplete);
    });
  }

  /**
   * Alias for waitForFleetQuiescence.
   * @param {number} [timeoutMs=15000]
   * @returns {Promise<boolean>}
   */
  drainComputePipeline(timeoutMs = 15000) {
    return this.waitForFleetQuiescence(timeoutMs);
  }
}
