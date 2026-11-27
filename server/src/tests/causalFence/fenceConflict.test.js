/**
 * Suite 2: Transactional Fence Conflict
 * File: server/src/tests/causalFence/fenceConflict.test.js
 *
 * Verifies:
 * - Publication vs barrier race condition resolution
 * - Predicate matching on barrierGeneration and status
 * - Driver callback retry abort upon barrier invalidation
 * - Zero zombie data committed under concurrent fencing
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { withRequiredTransaction } from '../../utils/dbTransaction.js';
import { startReplSet, stopReplSet } from '../../testUtils/replSetHelper.js';
import Form from '../../models/form.js';
import Response from '../../models/response.js';
import SubmissionReservation from '../../models/submissionReservation.js';
import { SubmissionReservationManager } from '../../utils/submissionReservationManager.js';
import * as instanceLeaseService from '../../services/instanceLeaseService.js';
import { InstanceLeaseSlot } from '../../models/instanceLease.js';

describe('Suite 2: Transactional Fence Conflict (fenceConflict)', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await startReplSet([Form, Response, SubmissionReservation, InstanceLeaseSlot]);
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Form.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await instanceLeaseService.ensureInstanceSingletonExists();
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-suite-2',
      skipHeartbeat: true
    });
  });

  it('2.1: markCommitting succeeds when barrierGeneration matches expected value', async () => {
    const form = await Form.create({
      title: 'Fence Test Form',
      ownerId: new mongoose.Types.ObjectId(),
      status: 'published'
    });

    const acq = await SubmissionReservationManager.acquire(form._id);
    expect(acq.success).toBe(true);

    const initialRes = await SubmissionReservation.findOne({ leaseId: acq.leaseId });
    expect(initialRes.barrierGeneration).toBe(0);
    expect(initialRes.status).toBe('active');

    // Transition with expected generation 0
    const committed = await SubmissionReservationManager.markCommitting(
      acq.leaseId,
      acq.fenceToken,
      null,
      30000,
      0
    );
    expect(committed).toBe(true);

    const updatedRes = await SubmissionReservation.findOne({ leaseId: acq.leaseId });
    expect(updatedRes.status).toBe('committing');
    expect(updatedRes.barrierGeneration).toBe(1);
  });

  it('2.2: markCommitting fails when barrierGeneration was advanced by external barrier', async () => {
    const form = await Form.create({
      title: 'Barrier Race Form',
      ownerId: new mongoose.Types.ObjectId(),
      status: 'published'
    });

    const acq = await SubmissionReservationManager.acquire(form._id);
    expect(acq.success).toBe(true);

    // Simulate concurrent barrier invalidating reservation
    await SubmissionReservation.updateOne(
      { leaseId: acq.leaseId },
      {
        $set: { status: 'abandoned' },
        $inc: { barrierGeneration: 1 }
      }
    );

    // Attempt to commit with expected generation 0
    const committed = await SubmissionReservationManager.markCommitting(
      acq.leaseId,
      acq.fenceToken,
      null,
      30000,
      0
    );
    expect(committed).toBe(false);
  });

  it('2.3: Driver callback retry aborts when barrier invalidates reservation between attempts', async () => {
    const form = await Form.create({
      title: 'Callback Retry Fencing Form',
      ownerId: new mongoose.Types.ObjectId(),
      status: 'published'
    });

    const acq = await SubmissionReservationManager.acquire(form._id);
    expect(acq.success).toBe(true);

    let callbackAttempt = 0;
    const partitionKey = form._id.toString();

    const txPromise = withRequiredTransaction(
      async (session) => {
        callbackAttempt++;

        if (callbackAttempt === 1) {
          // Attempt 1: Invalidate reservation externally before retrying
          await SubmissionReservation.updateOne(
            { leaseId: acq.leaseId },
            {
              $set: { status: 'abandoned' },
              $inc: { barrierGeneration: 1 }
            }
          );

          // Raise transient error to trigger driver retry
          const transientErr = new mongoose.mongo.MongoServerError({
            message: 'WriteConflict on Form',
            errorLabels: ['TransientTransactionError']
          });
          throw transientErr;
        }

        // Attempt 2: Callback re-executes. markCommitting must fail closed!
        const canCommit = await SubmissionReservationManager.markCommitting(
          acq.leaseId,
          acq.fenceToken,
          session,
          30000,
          0
        );

        if (!canCommit) {
          const fencedErr = new Error('Publication attempt invalidated by barrier');
          fencedErr.name = 'PublicationFencedError';
          fencedErr.code = 'PUBLICATION_FENCED';
          fencedErr.statusCode = 409;
          throw fencedErr;
        }

        // Must never reach response insertion
        await Response.create(
          [
            {
              formId: form._id,
              answers: [],
              reservationLeaseId: acq.leaseId,
              commitStatus: 'committed'
            }
          ],
          { session }
        );
      },
      { partitionKey }
    );

    await expect(txPromise).rejects.toThrow('Publication attempt invalidated by barrier');
    expect(callbackAttempt).toBe(2);

    // Zero zombie data committed!
    const responses = await Response.find({ formId: form._id });
    expect(responses.length).toBe(0);

    const reservation = await SubmissionReservation.findOne({ leaseId: acq.leaseId });
    expect(reservation.status).toBe('abandoned');
  });
});
