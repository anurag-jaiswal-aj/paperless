/**
 * Suite 4: Ambiguous Commit Outcome & Non-Destructive Quarantine
 * File: server/src/tests/causalFence/ambiguousCommit.test.js
 *
 * Verifies:
 * - isUnknownTransactionCommitResult detection of commit ambiguities
 * - Preservation of S3 objects under ambiguous commit results (zero deletions)
 * - Non-destructive quarantine arming on SubmissionReservation
 * - HTTP 503 Service Unavailable contract with Retry-After: 2
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import multer from 'multer';
import os from 'os';
import mongoose from 'mongoose';
import { startReplSet, stopReplSet } from '../../testUtils/replSetHelper.js';
import Form from '../../models/form.js';
import Question from '../../models/question.js';
import Response from '../../models/response.js';
import User from '../../models/user.js';
import SubmissionReservation from '../../models/submissionReservation.js';
import StorageJournal from '../../models/storageJournal.js';
import { submitResponse } from '../../controllers/responseController.js';
import { SubmissionReservationManager } from '../../utils/submissionReservationManager.js';
import storageService from '../../services/StorageService.js';
import * as dbTxMod from '../../utils/dbTransaction.js';
import * as instanceLeaseService from '../../services/instanceLeaseService.js';

describe('Suite 4: Ambiguous Commit Outcome (ambiguousCommit)', () => {
  let replSet;
  let app;
  let testUser;

  beforeAll(async () => {
    replSet = await startReplSet([
      Form,
      Question,
      Response,
      User,
      SubmissionReservation,
      StorageJournal
    ]);

    const upload = multer({ dest: os.tmpdir() });
    app = express();
    app.use(express.json());
    app.post('/api/forms/:formId/responses', upload.any(), submitResponse);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      console.log('EXPRESS ERROR HANDLER CAUGHT:', err);
      res.status(500).json({ error: err.message, stack: err.stack });
    });
  });

  afterAll(async () => {
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await StorageJournal.deleteMany({});

    testUser = await User.create({
      name: 'Ambiguous User',
      email: `ambiguous-${Date.now()}@test.com`,
      password: 'password123'
    });

    await instanceLeaseService.ensureInstanceSingletonExists();
    await instanceLeaseService.acquireInstanceLease({
      instanceId: 'inst-suite-4',
      skipHeartbeat: true
    });
  });

  it('4.1: isUnknownTransactionCommitResult detects MongoNetworkTimeoutError, wtimeout, and labels', () => {
    const { isUnknownTransactionCommitResult } = dbTxMod;

    expect(isUnknownTransactionCommitResult(null)).toBe(false);
    expect(isUnknownTransactionCommitResult(new Error('Regular application error'))).toBe(false);

    // Error with hasErrorLabel
    const labelErr = new Error('Unknown outcome');
    labelErr.hasErrorLabel = (label) => label === 'UnknownTransactionCommitResult';
    expect(isUnknownTransactionCommitResult(labelErr)).toBe(true);

    // Network timeout
    const timeoutErr = new Error('Socket timeout');
    timeoutErr.name = 'MongoNetworkTimeoutError';
    expect(isUnknownTransactionCommitResult(timeoutErr)).toBe(true);

    // Write concern failure
    const wcErr = new Error('waiting for replication timed out');
    wcErr.name = 'MongoWriteConcernError';
    wcErr.code = 64;
    expect(isUnknownTransactionCommitResult(wcErr)).toBe(true);

    // Socket disconnect
    const socketErr = new Error('Connection closed');
    socketErr.code = 'ECONNRESET';
    expect(isUnknownTransactionCommitResult(socketErr)).toBe(true);
  });

  it('4.2: Intercepts ambiguous commit, arms non-destructive quarantine, and preserves S3 files', async () => {
    const form = await Form.create({
      title: 'Ambiguous Commit Test Form',
      ownerId: testUser._id,
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      label: 'Feedback',
      type: 'short_text',
      required: false
    });

    // Spy on SubmissionReservationManager.release to assert it is NEVER called
    const releaseSpy = vi.spyOn(SubmissionReservationManager, 'release');
    const deleteFileSpy = vi.spyOn(storageService, 'deleteFile');

    // Simulate an ambiguous commit error specifically on the publication transaction commit
    let sessionCount = 0;
    const originalStartSession = mongoose.startSession.bind(mongoose);
    vi.spyOn(mongoose, 'startSession').mockImplementation(async (opts) => {
      sessionCount++;
      const currentSessionIdx = sessionCount;
      const realSession = await originalStartSession(opts);
      const originalWithTransaction = realSession.withTransaction.bind(realSession);

      realSession.withTransaction = async (cb) => {
        if (currentSessionIdx >= 2) {
          // Execute callback inside an active transaction, then simulate commit timeout abort
          realSession.startTransaction();
          await cb();
          await realSession.abortTransaction();

          const commitErr = new mongoose.mongo.MongoServerError({
            message: 'Commit transaction timed out waiting for majority write concern',
            errorLabels: ['UnknownTransactionCommitResult']
          });
          commitErr.code = 64;
          throw commitErr;
        }
        return originalWithTransaction(cb);
      };
      return realSession;
    });

    const res = await request(app)
      .post(`/api/forms/${form._id}/responses`)
      .send({
        answers: JSON.stringify([{ questionId: question._id, value: 'test answer' }])
      });

    console.log('RES BODY:', res.status, res.body);

    // HTTP 503 Service Unavailable with Retry-After: 2
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('TRANSACTION_COMMIT_AMBIGUOUS');
    expect(res.body.retryable).toBe(true);

    // Assert release was NOT invoked (zero destructive rollbacks)
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(deleteFileSpy).not.toHaveBeenCalled();

    // Verify reservation was quarantined non-destructively
    const reservations = await SubmissionReservation.find({ formId: form._id });
    expect(reservations.length).toBe(1);
    const reservation = reservations[0];
    expect(reservation.status).toBe('committing');
    expect(reservation.quarantinedUntil).toBeDefined();
    expect(reservation.quarantinedUntil.getTime()).toBeGreaterThan(Date.now());
    expect(reservation.ambiguousCommitAt).toBeDefined();
    expect(reservation.vacuumAt).toBeNull();
  });
});
