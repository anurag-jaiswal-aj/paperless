/**
 * Suite 1: Partition & Fence Identity
 * File: server/src/tests/causalFence/slotCollision.test.js
 *
 * Verifies:
 * - Strict partitionKey enforcement (no random UUID fallback)
 * - PartitionKeyRequiredError validation on missing/invalid keys
 * - 16-slot OCC mapping distribution and stability
 * - Slot stability across transaction retry attempts
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  withRequiredTransaction,
  computeDesignatedSlotId,
  PartitionKeyRequiredError
} from '../../utils/dbTransaction.js';
import { startReplSet, stopReplSet } from '../../testUtils/replSetHelper.js';
import InstanceLease, { InstanceLeaseSlot } from '../../models/instanceLease.js';
import Form from '../../models/form.js';
import * as instanceLeaseService from '../../services/instanceLeaseService.js';

describe('Suite 1: Partition & Fence Identity (slotCollision)', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await startReplSet([InstanceLease, InstanceLeaseSlot, Form]);
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Form.deleteMany({});
    await instanceLeaseService.ensureInstanceSingletonExists();
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-suite-1',
      skipHeartbeat: true
    });
  });

  it('1.1: Rejects transaction execution when partitionKey is missing (undefined/null)', async () => {
    const op = vi.fn().mockResolvedValue('ok');

    await expect(withRequiredTransaction(op)).rejects.toThrow(PartitionKeyRequiredError);
    await expect(withRequiredTransaction(op, {})).rejects.toThrow(PartitionKeyRequiredError);
    await expect(withRequiredTransaction(op, { partitionKey: null })).rejects.toThrow(
      PartitionKeyRequiredError
    );
    expect(op).not.toHaveBeenCalled();
  });

  it('1.2: Rejects empty strings, whitespace, NaN, and invalid objects', async () => {
    const op = vi.fn().mockResolvedValue('ok');

    await expect(withRequiredTransaction(op, { partitionKey: '' })).rejects.toThrow(
      PartitionKeyRequiredError
    );
    await expect(withRequiredTransaction(op, { partitionKey: '   ' })).rejects.toThrow(
      PartitionKeyRequiredError
    );
    await expect(withRequiredTransaction(op, { partitionKey: NaN })).rejects.toThrow(
      PartitionKeyRequiredError
    );
    await expect(withRequiredTransaction(op, { partitionKey: false })).rejects.toThrow(
      PartitionKeyRequiredError
    );
    await expect(withRequiredTransaction(op, { partitionKey: {} })).rejects.toThrow(
      PartitionKeyRequiredError
    );
    expect(op).not.toHaveBeenCalled();
  });

  it('1.3: Accepts valid strings, numbers, and ObjectId partition keys', async () => {
    const op = vi.fn().mockImplementation(async (session) => {
      const form = new Form({
        title: 'Partition Test Form',
        ownerId: new mongoose.Types.ObjectId()
      });
      await form.save({ session });
      return form._id;
    });

    const res1 = await withRequiredTransaction(op, { partitionKey: 'form_12345' });
    expect(res1).toBeDefined();

    const res2 = await withRequiredTransaction(op, { partitionKey: 42 });
    expect(res2).toBeDefined();

    const objectId = new mongoose.Types.ObjectId();
    const res3 = await withRequiredTransaction(op, { partitionKey: objectId });
    expect(res3).toBeDefined();
  });

  it('1.4: computeDesignatedSlotId maps deterministically to 16 slots (slot_0 to slot_15)', () => {
    const observedSlots = new Set();
    for (let i = 0; i < 200; i++) {
      const slot = computeDesignatedSlotId(`key_${i}`);
      expect(slot).toMatch(/^slot_(1[0-5]|[0-9])$/);
      observedSlots.add(slot);
    }
    // High probability of covering all 16 slots in 200 iterations
    expect(observedSlots.size).toBe(16);

    // Strict deterministic equality
    expect(computeDesignatedSlotId('same-key')).toBe(computeDesignatedSlotId('same-key'));
    expect(computeDesignatedSlotId('form-abc-123')).toBe(computeDesignatedSlotId('form-abc-123'));
  });

  it('1.5: Designated slot ID is calculated once in outer scope and remains stable across retries', async () => {
    let callCount = 0;
    const trackedSlots = [];

    const leaseMod = await import('../../services/instanceLeaseService.js');
    const originalVerifyFence = leaseMod.verifyTransactionalFence;
    const verifySpy = vi.spyOn(leaseMod, 'verifyTransactionalFence').mockImplementation(
      async (session, opts) => {
        callCount++;
        trackedSlots.push(opts.slotId);
        if (callCount === 1) {
          // Simulate transient write conflict on first attempt
          const transientErr = new mongoose.mongo.MongoServerError({
            message: 'WriteConflict on slot',
            errorLabels: ['TransientTransactionError']
          });
          throw transientErr;
        }
        return originalVerifyFence(session, opts);
      }
    );

    const partitionKey = 'stable-slot-key-999';
    const expectedSlot = computeDesignatedSlotId(partitionKey);

    const result = await withRequiredTransaction(
      async () => {
        return 'success-after-retry';
      },
      { partitionKey }
    );

    expect(result).toBe('success-after-retry');
    expect(callCount).toBe(2);
    expect(trackedSlots[0]).toBe(expectedSlot);
    expect(trackedSlots[1]).toBe(expectedSlot);
    expect(trackedSlots[0]).toBe(trackedSlots[1]);

    verifySpy.mockRestore();
  });
});
