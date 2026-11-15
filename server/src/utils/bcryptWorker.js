import { parentPort, isMainThread } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

/**
 * Paperless Stage 2.2 Phase 2: Bcrypt Worker Thread Entry Point
 *
 * Runs strictly within a worker thread. Executes CPU-intensive bcrypt operations
 * off the Express event loop.
 *
 * Security:
 * - Never logs passwords, hashes, tokens, or sensitive payloads.
 * - Scrubs sensitive references immediately after execution.
 * - Does not import or connect to Express, MongoDB, or network services.
 */

if (isMainThread) {
  throw new Error('bcryptWorker.js must be executed inside a Worker thread');
}

if (!parentPort) {
  throw new Error('bcryptWorker.js requires a valid parentPort');
}

/**
 * Handle incoming execution requests from the worker pool.
 */
parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') {
    return;
  }

  const { type, workerId, generation, taskId, operation } = msg;

  // Handle pool shutdown command
  if (type === 'TERMINATE') {
    process.exit(0);
  }

  // Handle execution command
  if (type === 'EXECUTE') {
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      parentPort.postMessage({
        type: 'ERROR',
        workerId,
        generation,
        taskId: taskId || 'unknown',
        operation: operation || 'unknown',
        success: false,
        error: 'INVALID_TASK_ID'
      });
      return;
    }

    // Controlled test hook: simulate worker crash
    if (operation === '__TEST_CRASH__') {
      process.exit(42);
    }

    // Controlled test hook: simulate slow execution / timeout
    if (operation === '__TEST_DELAY__') {
      const delayMs = Number.isInteger(msg.delayMs) && msg.delayMs > 0 ? msg.delayMs : 15000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      parentPort.postMessage({
        type: 'RESULT',
        workerId,
        generation,
        taskId,
        operation: '__TEST_DELAY__',
        success: true,
        delayed: true
      });
      return;
    }

    if (operation === 'COMPARE') {
      let pwd = typeof msg.password === 'string' ? msg.password : '';
      let targetHash = typeof msg.hash === 'string' ? msg.hash : '';

      try {
        const isMatch = await bcrypt.compare(pwd, targetHash);
        parentPort.postMessage({
          type: 'RESULT',
          workerId,
          generation,
          taskId,
          operation: 'COMPARE',
          success: true,
          isMatch: Boolean(isMatch)
        });
      } catch (err) {
        parentPort.postMessage({
          type: 'ERROR',
          workerId,
          generation,
          taskId,
          operation: 'COMPARE',
          success: false,
          error: err.message || 'BCRYPT_COMPARE_ERROR'
        });
      } finally {
        // Immediate in-scope scrub of sensitive strings
        pwd = null;
        targetHash = null;
      }
      return;
    }

    if (operation === 'HASH') {
      let pwd = typeof msg.password === 'string' ? msg.password : '';
      const rounds =
        Number.isInteger(msg.saltOrRounds) && msg.saltOrRounds > 0 ? msg.saltOrRounds : 10;

      try {
        const computedHash = await bcrypt.hash(pwd, rounds);
        parentPort.postMessage({
          type: 'RESULT',
          workerId,
          generation,
          taskId,
          operation: 'HASH',
          success: true,
          hash: computedHash
        });
      } catch (err) {
        parentPort.postMessage({
          type: 'ERROR',
          workerId,
          generation,
          taskId,
          operation: 'HASH',
          success: false,
          error: err.message || 'BCRYPT_HASH_ERROR'
        });
      } finally {
        // Immediate in-scope scrub of sensitive strings
        pwd = null;
      }
      return;
    }

    // Unknown operation
    parentPort.postMessage({
      type: 'ERROR',
      workerId,
      generation,
      taskId,
      operation: operation || 'unknown',
      success: false,
      error: `UNSUPPORTED_OPERATION: ${operation}`
    });
  }
});

// Signal to the parent pool that this worker has completed initialization and is ready
parentPort.postMessage({ type: 'READY' });
