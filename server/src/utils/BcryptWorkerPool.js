import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { TaskSettlementToken } from './TaskSettlementToken.js';
import { logger as defaultLogger } from './logger.js';
import { incrementDiagnosticCounter } from '../services/SecurityAuditService.js';

/**
 * Physical worker lifecycle states.
 */
export const WorkerState = Object.freeze({
  STARTING: 'STARTING',
  IDLE: 'IDLE',
  BUSY: 'BUSY',
  STOPPING: 'STOPPING',
  EXITED: 'EXITED',
  FAILED: 'FAILED'
});

/**
 * Error thrown when worker pool shutdown times out before all workers confirm exit.
 */
export class ShutdownTimeoutError extends Error {
  /**
   * @param {string} message
   * @param {string[]} remainingWorkers
   */
  constructor(message, remainingWorkers = []) {
    super(message);
    this.name = 'ShutdownTimeoutError';
    this.remainingWorkers = remainingWorkers;
  }
}

/**
 * Error thrown when coordinator queue is saturated.
 */
export class QueueFullError extends Error {
  constructor(message = 'Queue capacity exhausted') {
    super(message);
    this.name = 'QueueFullError';
  }
}

/**
 * Error thrown when a worker task exceeds its execution timeout.
 */
export class WorkerTimeoutError extends Error {
  constructor(message = 'Worker compute task timed out') {
    super(message);
    this.name = 'WorkerTimeoutError';
  }
}

/**
 * Error thrown when a worker crashes or errors during compute.
 */
export class WorkerCrashError extends Error {
  constructor(message = 'Worker process crashed or errored during compute') {
    super(message);
    this.name = 'WorkerCrashError';
  }
}

/**
 * BcryptWorkerPool
 *
 * Implements a bounded, fault-tolerant Node.js worker_threads pool for bcrypt compute.
 * Coordinates with UnifiedComputePipelineCoordinator for logical resource accounting.
 *
 * Invariants:
 * - physicalWorkersCreatedOrStartingOrAlive <= maxWorkers (default: 2)
 * - Worker owns at most one active task
 * - Task is assigned to at most one worker
 * - An idle worker owns no task
 * - A busy worker has exactly one valid task assignment
 * - Physical worker slots are never reused before confirmed exit
 */
export class BcryptWorkerPool extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.coordinator - UnifiedComputePipelineCoordinator instance
   * @param {number} [options.maxWorkers=2] - Strict physical worker limit
   * @param {string|URL} [options.workerScriptPath] - Path to worker thread script
   * @param {number} [options.taskTimeoutMs=10000] - Compute execution timeout
   * @param {number} [options.queueTimeoutMs=5000] - Authoritative queue wait timeout
   * @param {number} [options.maxRestartsPerSlot=5] - Circuit breaker per slot
   */
  constructor(options = {}) {
    super();

    if (!options.coordinator || typeof options.coordinator !== 'object') {
      throw new TypeError('BcryptWorkerPool requires a valid coordinator instance');
    }

    this.coordinator = options.coordinator;
    this.maxWorkers =
      Number.isInteger(options.maxWorkers) && options.maxWorkers > 0 ? options.maxWorkers : 2;
    this.workerScriptPath =
      options.workerScriptPath || new URL('./bcryptWorker.js', import.meta.url);
    this.taskTimeoutMs =
      Number.isInteger(options.taskTimeoutMs) && options.taskTimeoutMs > 0
        ? options.taskTimeoutMs
        : 10000;
    this.queueTimeoutMs =
      Number.isInteger(options.queueTimeoutMs) && options.queueTimeoutMs > 0
        ? options.queueTimeoutMs
        : 5000;
    this.maxRestartsPerSlot = Number.isInteger(options.maxRestartsPerSlot)
      ? options.maxRestartsPerSlot
      : 5;

    // Structured logger with non-crashing fallback
    this.logger = options.logger !== undefined ? options.logger : defaultLogger;

    // Physical worker slot registry: Map<string, WorkerSlot>
    this.workers = new Map();

    // Authoritative waiting queue: Array of pending queue items tied to coordinator QUEUED state
    this.queue = [];

    // Lifetime tracking
    this.totalCreated = 0;
    this.shuttingDown = false;
    this._shutdownPromise = null;
  }

  /**
   * Internal failure-isolated logging helper.
   * Catches all exceptions from the logger to ensure worker pool reliability is never impaired.
   * @param {string} level - 'debug' | 'info' | 'warn' | 'error' | 'fatal'
   * @param {string} event - Structured event name
   * @param {object} [metadata={}] - Bounded diagnostic metadata
   * @private
   */
  _log(level, event, metadata = {}) {
    if (!this.logger) return;
    try {
      const fn = this.logger[level];
      if (typeof fn === 'function') {
        fn.call(this.logger, event, metadata);
      }
    } catch {
      // Failure-isolated: logger errors must never crash worker operations
    }
  }

  /**
   * Current count of live or starting physical workers.
   */
  get aliveWorkerCount() {
    let count = 0;
    for (const slot of this.workers.values()) {
      if (
        slot.state === WorkerState.STARTING ||
        slot.state === WorkerState.IDLE ||
        slot.state === WorkerState.BUSY ||
        slot.state === WorkerState.STOPPING
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * Initializes the physical worker slots up to maxWorkers.
   * Resolves when all initial workers have signalled READY.
   * @returns {Promise<boolean>}
   */
  async initialize() {
    if (this.shuttingDown) {
      throw new Error('Cannot initialize worker pool during shutdown');
    }

    const initPromises = [];

    for (let i = 0; i < this.maxWorkers; i++) {
      const slotId = `worker-${i}`;
      if (!this.workers.has(slotId)) {
        const slot = {
          id: slotId,
          generation: 1,
          worker: null,
          state: WorkerState.STARTING,
          currentTask: null,
          readyPromise: null,
          readyResolve: null,
          readyReject: null,
          exitPromise: null,
          exitResolve: null,
          restartsCount: 0
        };

        this.workers.set(slotId, slot);
        initPromises.push(this._spawnWorkerForSlot(slot));
      }
    }

    try {
      await Promise.all(initPromises);
      this._log('info', 'worker.pool.initialized', {
        maxWorkers: this.maxWorkers,
        taskTimeoutMs: this.taskTimeoutMs,
        queueTimeoutMs: this.queueTimeoutMs
      });
      return true;
    } catch (err) {
      await this.shutdown({ timeoutMs: 3000, graceful: false }).catch(() => {});
      throw err;
    }
  }

  /**
   * Spawns a native Worker for the given slot.
   * @param {object} slot
   * @returns {Promise<boolean>}
   */
  _spawnWorkerForSlot(slot) {
    if (this.shuttingDown) {
      slot.state = WorkerState.EXITED;
      return Promise.resolve(false);
    }

    if (this.aliveWorkerCount > this.maxWorkers) {
      throw new Error(
        `Physical worker invariant violation: alive workers (${this.aliveWorkerCount}) exceeds maxWorkers (${this.maxWorkers})`
      );
    }

    this.totalCreated++;
    slot.state = WorkerState.STARTING;

    slot.readyPromise = new Promise((resolve, reject) => {
      slot.readyResolve = resolve;
      slot.readyReject = reject;
    });

    slot.exitPromise = new Promise((resolve) => {
      slot.exitResolve = resolve;
    });

    try {
      const worker = new Worker(this.workerScriptPath);
      slot.worker = worker;
      slot.threadId = worker.threadId;

      worker.on('message', (msg) => this._onWorkerMessage(slot, msg));
      worker.on('error', (err) => this._onWorkerError(slot, err));
      worker.on('exit', (code) => this._onWorkerExit(slot, code));

      incrementDiagnosticCounter('worker_spawn_total');
      this._log('debug', 'worker.spawned', {
        slotId: slot.id,
        generation: slot.generation,
        threadId: slot.threadId
      });

      return slot.readyPromise;
    } catch (err) {
      slot.state = WorkerState.FAILED;
      if (slot.readyReject) {
        slot.readyReject(err);
      }
      return Promise.reject(err);
    }
  }

  /**
   * Dispatches or queues a bcrypt compare operation.
   * @param {TaskSettlementToken} token
   * @param {string} password
   * @param {string} hash
   * @returns {Promise<{ isMatch: boolean }>}
   */
  async executeCompare(token, password, hash) {
    return this._submitTask(token, {
      operation: 'COMPARE',
      password,
      hash
    });
  }

  /**
   * Dispatches or queues a bcrypt hash operation.
   * @param {TaskSettlementToken} token
   * @param {string} password
   * @param {number} [saltOrRounds=10]
   * @returns {Promise<{ hash: string }>}
   */
  async executeHash(token, password, saltOrRounds = 10) {
    return this._submitTask(token, {
      operation: 'HASH',
      password,
      saltOrRounds
    });
  }

  /**
   * Core task submission logic: validates token, checks available workers,
   * performs direct dispatch or coordinator queue handoff.
   * @param {TaskSettlementToken} token
   * @param {object} payload
   * @returns {Promise<any>}
   */
  async _submitTask(token, payload) {
    if (this.shuttingDown) {
      throw new Error('POOL_SHUTDOWN');
    }

    if (!token || !(token instanceof TaskSettlementToken)) {
      throw new TypeError('token must be an instance of TaskSettlementToken');
    }

    if (token.isSettled) {
      throw new Error('Cannot execute task on an already settled token');
    }

    if (token.clientDisconnected) {
      token.settleLookupFailure('CLIENT_DISCONNECTED_BEFORE_DISPATCH');
      throw new Error('CLIENT_DISCONNECTED');
    }

    // Check for an available IDLE worker
    const idleSlot = this._findIdleWorkerSlot();

    if (idleSlot) {
      // Direct worker dispatch path
      const handoffOk = token.handoffPendingToActive();
      if (handoffOk) {
        return new Promise((resolve, reject) => {
          this._dispatchToWorker(idleSlot, token, payload, resolve, reject);
        });
      }
    }

    // Queue path: coordinator queue admission
    const queuedOk = token.handoffPendingToQueued();
    if (!queuedOk) {
      // Coordinator queue is saturated: clean rollback
      incrementDiagnosticCounter('coordinator_task_saturated_total');
      this._log('warn', 'worker.queue.saturated', {
        queueLength: this.queue.length,
        maxQueue: this.maxQueue || 10
      });
      token.settleLookupFailure('QUEUE_FULL');
      throw new QueueFullError('Compute pipeline queue capacity exhausted');
    }

    incrementDiagnosticCounter('coordinator_task_queued_total');

    // Enqueue task item in authoritative waiting list
    return new Promise((resolve, reject) => {
      const taskItem = {
        token,
        payload,
        resolve,
        reject,
        timer: null,
        dispatched: false,
        queuedAt: Date.now()
      };

      taskItem.timer = setTimeout(() => {
        if (taskItem.dispatched) {
          return;
        }
        taskItem.dispatched = true;

        const idx = this.queue.indexOf(taskItem);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }

        incrementDiagnosticCounter('coordinator_task_timeout_total');
        this._log('warn', 'worker.queue.timeout', {
          taskId: token.taskId,
          queueTimeoutMs: this.queueTimeoutMs
        });

        token.settleQueueTimeout('QUEUE_TIMEOUT');
        reject(new Error('QUEUE_TIMEOUT'));
      }, this.queueTimeoutMs);

      this.queue.push(taskItem);
    });
  }

  /**
   * Finds the first available IDLE worker slot.
   * @returns {object|null}
   */
  _findIdleWorkerSlot() {
    for (const slot of this.workers.values()) {
      if (slot.state === WorkerState.IDLE) {
        return slot;
      }
    }
    return null;
  }

  /**
   * Dispatches a task to a verified IDLE worker.
   * @param {object} slot
   * @param {TaskSettlementToken} token
   * @param {object} payload
   * @param {Function} resolve
   * @param {Function} reject
   */
  _dispatchToWorker(slot, token, payload, resolve, reject) {
    if (slot.state !== WorkerState.IDLE) {
      throw new Error(`Worker slot ${slot.id} is not IDLE (state: ${slot.state})`);
    }

    slot.state = WorkerState.BUSY;

    const now = Date.now();
    const taskRecord = {
      taskId: token.taskId,
      token,
      operation: payload.operation,
      resolve,
      reject,
      timer: null,
      startedAt: now,
      enqueuedAt: payload.queuedAt || null
    };

    taskRecord.timer = setTimeout(() => {
      this._handleTaskTimeout(slot);
    }, this.taskTimeoutMs);

    slot.currentTask = taskRecord;

    const queueDurationMs = payload.queuedAt ? Math.max(0, now - payload.queuedAt) : 0;
    this._log('debug', 'worker.task.started', {
      slotId: slot.id,
      taskId: token.taskId,
      operation: payload.operation,
      queueDurationMs
    });

    // Send execution message with correlation metadata
    slot.worker.postMessage({
      type: 'EXECUTE',
      workerId: slot.id,
      generation: slot.generation,
      taskId: token.taskId,
      operation: payload.operation,
      password: payload.password,
      hash: payload.hash,
      saltOrRounds: payload.saltOrRounds,
      delayMs: payload.delayMs
    });

    // Strip sensitive payload references immediately
    payload.password = null;
    payload.hash = null;
  }

  /**
   * Processes the next eligible task from the coordinator queue when a worker becomes IDLE.
   * @param {object} slot
   */
  _drainNextQueuedTask(slot) {
    if (this.shuttingDown || slot.state !== WorkerState.IDLE) {
      return;
    }

    while (this.queue.length > 0) {
      const taskItem = this.queue.shift();
      if (!taskItem) {
        break;
      }

      if (taskItem.timer) {
        clearTimeout(taskItem.timer);
      }
      taskItem.dispatched = true;

      // Handle disconnected or already settled tasks in queue
      if (taskItem.token.isSettled || taskItem.token.clientDisconnected) {
        if (!taskItem.token.isSettled) {
          taskItem.token.settleQueueDisconnect('CLIENT_DISCONNECTED_BEFORE_DISPATCH');
        }
        taskItem.reject(new Error('CLIENT_DISCONNECTED'));
        continue;
      }

      // Handoff from QUEUED to ACTIVE_COMPUTE
      const handoffOk = taskItem.token.handoffQueuedToActive();
      if (handoffOk) {
        this._dispatchToWorker(
          slot,
          taskItem.token,
          taskItem.payload,
          taskItem.resolve,
          taskItem.reject
        );
        return;
      }

      // Failed handoff to active: settle cleanly
      taskItem.token.settleLookupFailure('HANDOFF_QUEUED_TO_ACTIVE_FAILED');
      taskItem.reject(new Error('HANDOFF_QUEUED_TO_ACTIVE_FAILED'));
    }
  }

  /**
   * Handles incoming messages from a worker thread.
   * @param {object} slot
   * @param {object} msg
   */
  _onWorkerMessage(slot, msg) {
    if (!msg || typeof msg !== 'object') {
      return;
    }

    // 1. Worker readiness notification
    if (msg.type === 'READY') {
      if (slot.state === WorkerState.STARTING) {
        slot.state = WorkerState.IDLE;
        if (slot.readyResolve) {
          slot.readyResolve(true);
        }
        incrementDiagnosticCounter('worker_ready_total');
        this._log('debug', 'worker.ready', {
          slotId: slot.id,
          generation: slot.generation,
          threadId: slot.threadId
        });
        this.emit('workerReady', slot.id);
        this._drainNextQueuedTask(slot);
      }
      return;
    }

    // 2. Validate message correlation and worker state
    if (slot.state !== WorkerState.BUSY || !slot.currentTask) {
      return; // Drop message for inactive or already cleared task
    }

    if (msg.workerId !== slot.id || msg.generation !== slot.generation) {
      return; // Drop stale generation message
    }

    if (msg.taskId !== slot.currentTask.taskId) {
      return; // Drop mismatched task correlation message
    }

    // Clear active task execution timer
    if (slot.currentTask.timer) {
      clearTimeout(slot.currentTask.timer);
    }

    const { token, resolve, reject, operation, startedAt } = slot.currentTask;
    slot.currentTask = null;
    const durationMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;

    if (msg.type === 'RESULT' && msg.success) {
      incrementDiagnosticCounter('worker_task_success_total');
      this._log('debug', 'worker.task.completed', {
        slotId: slot.id,
        taskId: token.taskId,
        operation,
        durationMs
      });

      // Transition token from ACTIVE_COMPUTE to DB_WRITE
      const handoffOk = token.handoffComputeToDbWrite();
      if (handoffOk) {
        if (operation === 'COMPARE') {
          resolve({ isMatch: Boolean(msg.isMatch) });
        } else {
          resolve({ hash: msg.hash });
        }
      } else {
        token.settleWorkerCrash('HANDOFF_TO_DB_WRITE_FAILED');
        reject(new WorkerCrashError('HANDOFF_TO_DB_WRITE_FAILED'));
      }
    } else {
      incrementDiagnosticCounter('worker_task_failure_total');
      this._log('warn', 'worker.task.failed', {
        slotId: slot.id,
        taskId: token.taskId,
        operation,
        durationMs,
        error: msg.error || 'WORKER_COMPUTE_ERROR'
      });

      // Error message or failed computation
      token.settleWorkerCrash(msg.error || 'WORKER_COMPUTE_ERROR');
      reject(new WorkerCrashError(msg.error || 'WORKER_COMPUTE_ERROR'));
    }

    // Worker returns to IDLE and drains next queued item, or terminates if shutting down
    if (!this.shuttingDown) {
      slot.state = WorkerState.IDLE;
      this._drainNextQueuedTask(slot);
    } else {
      slot.state = WorkerState.STOPPING;
      if (slot.worker) {
        try {
          slot.worker.postMessage({ type: 'TERMINATE' });
        } catch {
          slot.worker.terminate().catch(() => {});
        }
      }
    }
  }

  /**
   * Handles worker process execution timeout.
   * @param {object} slot
   */
  _handleTaskTimeout(slot) {
    if (slot.state !== WorkerState.BUSY || !slot.currentTask) {
      return;
    }

    const { token, reject, operation } = slot.currentTask;
    slot.currentTask = null;

    incrementDiagnosticCounter('worker_task_failure_total');
    incrementDiagnosticCounter('coordinator_task_timeout_total');
    this._log('warn', 'worker.task.timeout', {
      slotId: slot.id,
      taskId: token.taskId,
      operation,
      timeoutMs: this.taskTimeoutMs
    });

    // Settle task logically before terminating physical thread
    token.settleWorkerTimeout('WORKER_TIMEOUT');
    reject(new WorkerTimeoutError('Worker compute task timed out'));

    // Terminate unresponsive worker
    slot.state = WorkerState.STOPPING;
    if (slot.worker) {
      slot.worker.terminate().catch(() => {});
    }
  }

  /**
   * Handles native worker thread error event.
   * @param {object} slot
   * @param {Error} err
   */
  _onWorkerError(slot, err) {
    if (slot.state === WorkerState.STARTING) {
      slot.state = WorkerState.FAILED;
      if (slot.readyReject) {
        slot.readyReject(err);
        slot.readyReject = null;
      }
    }

    this._log('error', 'worker.error', {
      slotId: slot.id,
      generation: slot.generation,
      threadId: slot.threadId,
      error: err?.message || 'Worker thread error'
    });

    this.emit('workerError', { workerId: slot.id, error: err });
    // Terminate worker to guarantee clean exit handling
    if (slot.worker) {
      slot.worker.terminate().catch(() => {});
    }
  }

  /**
   * Handles native worker thread exit event.
   * Confirms physical exit, settles active task if needed, and handles replacement.
   * @param {object} slot
   * @param {number} code
   */
  _onWorkerExit(slot, code) {
    if (slot.state === WorkerState.STARTING) {
      slot.state = WorkerState.FAILED;
      if (slot.readyReject) {
        slot.readyReject(new Error(`Worker startup failed with exit code ${code}`));
        slot.readyReject = null;
      }
    } else {
      slot.state = code === 0 ? WorkerState.EXITED : WorkerState.FAILED;
    }

    const hadActiveTask = !!slot.currentTask;

    // If worker exited while holding an active task, settle task immediately
    if (slot.currentTask) {
      if (slot.currentTask.timer) {
        clearTimeout(slot.currentTask.timer);
      }
      const { token, reject } = slot.currentTask;
      slot.currentTask = null;

      incrementDiagnosticCounter('worker_task_failure_total');
      token.settleWorkerCrash(`WORKER_EXIT_${code}`);
      reject(new WorkerCrashError(`Worker exited unexpectedly with code ${code}`));
    }

    if (slot.exitResolve) {
      slot.exitResolve(code);
    }

    if (!this.shuttingDown && code !== 0) {
      incrementDiagnosticCounter('worker_unexpected_exit_total');
    }

    this._log(
      code === 0 && this.shuttingDown ? 'debug' : code === 0 ? 'info' : 'error',
      'worker.exit',
      {
        slotId: slot.id,
        generation: slot.generation,
        threadId: slot.threadId,
        exitCode: code,
        activeTask: hadActiveTask
      }
    );

    this.emit('workerExited', { workerId: slot.id, code });

    // Handle replacement only after physical exit is confirmed
    if (!this.shuttingDown) {
      if (slot.restartsCount >= this.maxRestartsPerSlot) {
        incrementDiagnosticCounter('worker_replacement_failure_total');
        this._log('error', 'worker.circuit_breaker.tripped', {
          slotId: slot.id,
          restartsCount: slot.restartsCount,
          maxRestartsPerSlot: this.maxRestartsPerSlot
        });
      } else {
        slot.generation++;
        slot.restartsCount++;
        incrementDiagnosticCounter('worker_replacement_attempt_total');
        this._log('info', 'worker.replacement.attempted', {
          slotId: slot.id,
          generation: slot.generation,
          restartsCount: slot.restartsCount
        });
        this._spawnWorkerForSlot(slot)
          .then(() => {
            this._log('info', 'worker.replacement.succeeded', {
              slotId: slot.id,
              generation: slot.generation
            });
          })
          .catch((err) => {
            incrementDiagnosticCounter('worker_replacement_failure_total');
            this._log('error', 'worker.replacement.failed', {
              slotId: slot.id,
              error: err?.message || 'Replacement spawn failed'
            });
            this.emit('workerReplacementFailed', { workerId: slot.id, error: err });
          });
      }
    }
  }

  /**
   * Graceful or immediate shutdown of the worker pool.
   * Awaits confirmed exit of all live worker threads.
   * @param {object} [options={}]
   * @param {number} [options.timeoutMs=15000]
   * @param {boolean} [options.graceful=true]
   * @returns {Promise<boolean>}
   */
  shutdown(options = {}) {
    if (this._shutdownPromise) {
      return this._shutdownPromise;
    }

    this.shuttingDown = true;
    const timeoutMs =
      Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
    const graceful = options.graceful !== false;

    this._log('info', 'worker.pool.shutdown.started', {
      graceful,
      timeoutMs,
      activeWorkers: this.aliveWorkerCount,
      queueLength: this.queue.length
    });

    this._shutdownPromise = (async () => {
      // 1. Drain and reject all queued tasks
      while (this.queue.length > 0) {
        const taskItem = this.queue.shift();
        if (taskItem) {
          if (taskItem.timer) {
            clearTimeout(taskItem.timer);
          }
          taskItem.dispatched = true;
          taskItem.token.settleDrainAbort('POOL_SHUTDOWN');
          taskItem.reject(new Error('POOL_SHUTDOWN'));
        }
      }

      // 2. Terminate idle/starting workers, request termination for busy workers
      const exitPromises = [];

      for (const slot of this.workers.values()) {
        if (
          slot.state === WorkerState.STARTING ||
          slot.state === WorkerState.IDLE ||
          slot.state === WorkerState.STOPPING
        ) {
          slot.state = WorkerState.STOPPING;
          if (slot.worker) {
            slot.worker.terminate().catch(() => {});
          }
          if (slot.exitPromise) {
            exitPromises.push(slot.exitPromise);
          }
        } else if (slot.state === WorkerState.BUSY) {
          if (!graceful) {
            if (slot.currentTask) {
              if (slot.currentTask.timer) {
                clearTimeout(slot.currentTask.timer);
              }
              slot.currentTask.token.settleDrainAbort('POOL_SHUTDOWN');
              slot.currentTask.reject(new Error('POOL_SHUTDOWN'));
              slot.currentTask = null;
            }
            slot.state = WorkerState.STOPPING;
            if (slot.worker) {
              slot.worker.terminate().catch(() => {});
            }
          }
          if (slot.exitPromise) {
            exitPromises.push(slot.exitPromise);
          }
        }
      }

      if (exitPromises.length === 0) {
        this._log('info', 'worker.pool.shutdown.completed', {});
        return true;
      }

      // 3. Await confirmed exit of all live threads within timeoutMs
      let timer = null;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const remaining = Array.from(this.workers.values())
            .filter((s) => s.state !== WorkerState.EXITED && s.state !== WorkerState.FAILED)
            .map((s) => s.id);

          reject(
            new ShutdownTimeoutError(
              `Worker pool shutdown timed out after ${timeoutMs}ms with ${remaining.length} worker(s) still terminating`,
              remaining
            )
          );
        }, timeoutMs);
      });

      try {
        await Promise.race([Promise.all(exitPromises), timeoutPromise]);
        this._log('info', 'worker.pool.shutdown.completed', {});
        return true;
      } catch (err) {
        incrementDiagnosticCounter('worker_shutdown_failure_total');
        this._log('error', 'worker.pool.shutdown.failed', {
          timeoutMs,
          error: err?.message || 'Shutdown failed'
        });
        throw err;
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    })();

    return this._shutdownPromise;
  }

  /**
   * Returns an isolated, deeply frozen snapshot of physical worker pool state.
   * Strictly excludes passwords, hashes, tokens, or raw IPs.
   * @returns {object}
   */
  getSnapshot() {
    let idleCount = 0;
    let busyCount = 0;
    let startingCount = 0;
    let stoppingCount = 0;
    let failedCount = 0;
    let aliveCount = 0;

    const workerSnapshots = [];

    for (const slot of this.workers.values()) {
      if (slot.state === WorkerState.IDLE) idleCount++;
      if (slot.state === WorkerState.BUSY) busyCount++;
      if (slot.state === WorkerState.STARTING) startingCount++;
      if (slot.state === WorkerState.STOPPING) stoppingCount++;
      if (slot.state === WorkerState.FAILED || slot.state === WorkerState.EXITED) failedCount++;

      if (
        slot.state === WorkerState.STARTING ||
        slot.state === WorkerState.IDLE ||
        slot.state === WorkerState.BUSY ||
        slot.state === WorkerState.STOPPING
      ) {
        aliveCount++;
      }

      workerSnapshots.push(
        Object.freeze({
          id: slot.id,
          generation: slot.generation,
          state: slot.state,
          isBusy: slot.state === WorkerState.BUSY,
          restartsCount: slot.restartsCount
        })
      );
    }

    return Object.freeze({
      totalCreated: this.totalCreated,
      aliveWorkers: aliveCount,
      idleWorkers: idleCount,
      busyWorkers: busyCount,
      startingWorkers: startingCount,
      stoppingWorkers: stoppingCount,
      failedWorkers: failedCount,
      maxWorkers: this.maxWorkers,
      queuedTasks: this.queue.length,
      shuttingDown: this.shuttingDown,
      workers: Object.freeze(workerSnapshots)
    });
  }
}
