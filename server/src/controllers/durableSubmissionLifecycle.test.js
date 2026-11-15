import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import User from '../models/user.js';
import SubmissionReservation from '../models/submissionReservation.js';
import { executeFormDeletion, recoverAbandonedFormDeletions } from './formController.js';
import { submitResponse } from './responseController.js';
import { SubmissionReservationManager } from '../utils/submissionReservationManager.js';
import storageService from '../services/StorageService.js';

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('Stage 4.3.5 B1: Durable Submission Lifecycle & Deletion Coordination', () => {
  let mongod;
  let app;
  let testUser;
  let userId;
  let activeS3Objects;

  beforeAll(async () => {
    mongod = await startReplSet();

    app = express();
    app.use(express.json());
    app.post('/api/responses/:formId', submitResponse);
  });

  afterAll(async () => {
    await stopReplSet(mongod);
  });

  beforeEach(async () => {
    await Form.deleteMany({});
    await Question.deleteMany({});
    await Response.deleteMany({});
    await SubmissionReservation.deleteMany({});
    await User.deleteMany({});

    testUser = await User.create({
      name: 'Owner User',
      email: `owner-${crypto.randomUUID()}@example.com`,
      password: 'password123'
    });
    userId = testUser._id.toString();

    activeS3Objects = new Map();

    vi.spyOn(storageService, 'uploadFile').mockImplementation(async (fileStream, key, mime) => {
      activeS3Objects.set(key, { mime, timestamp: Date.now() });
      return key;
    });

    vi.spyOn(storageService, 'deleteFile').mockImplementation(async (key) => {
      activeS3Objects.delete(key);
      return Promise.resolve();
    });

    vi.spyOn(storageService, 'deleteFiles').mockImplementation(async (keys) => {
      const deletedKeys = [];
      for (const k of keys) {
        activeS3Objects.delete(k);
        deletedKeys.push(k);
      }
      return { success: true, deletedKeys, failedKeys: [], totalRequested: keys.length };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Scenario A: Active reservation with missing or null expiry
  // --------------------------------------------------------------------------
  it('Scenario A: form deletion CAS filter does NOT claim form when activeSubmissions > 0 and expiry is null', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario A Form',
      status: 'published',
      activeSubmissions: 1,
      activeSubmissionsExpiresAt: null // Legacy or corrupted state
    });

    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });

    // Deletion must be rejected because activeSubmissions is positive without a proven past expiry
    expect(delResult.statusCode).toBe(409);
    expect(delResult.message).toContain('submissions in flight');

    // Form and questions remain intact
    const formAfter = await Form.findById(form._id);
    expect(formAfter).not.toBeNull();
    expect(formAfter.status).toBe('published');
  });

  // --------------------------------------------------------------------------
  // Scenario B: Two submissions with independent lease expiries
  // --------------------------------------------------------------------------
  it('Scenario B: coordinates two concurrent submissions with independent lease expiries', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario B Form',
      status: 'published'
    });

    // Sub A arrives at T=0 (expires at T+30s)
    const resA = await SubmissionReservationManager.acquire(form._id, { ttlMs: 30000 });
    expect(resA.success).toBe(true);

    // Advance time slightly: Sub B arrives at T=5s (expires at T+35s)
    const resB = await SubmissionReservationManager.acquire(form._id, { ttlMs: 35000 });
    expect(resB.success).toBe(true);

    // Form deletion attempted while both are active
    const delResult1 = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult1.statusCode).toBe(409);

    // Sub A completes and releases its lease
    await SubmissionReservationManager.finalize(resA.leaseId, resA.fenceToken);

    // Sub B is still active: deletion must still be blocked!
    const delResult2 = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult2.statusCode).toBe(409);

    // Sub B completes and releases its lease
    await SubmissionReservationManager.finalize(resB.leaseId, resB.fenceToken);

    // Now deletion succeeds cleanly
    const delResult3 = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult3.statusCode).toBe(200);
    expect(await Form.findById(form._id)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario C: Submission A expires while submission B remains active
  // --------------------------------------------------------------------------
  it('Scenario C: submission A expiring does not invalidate active protection of submission B', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario C Form',
      status: 'published'
    });

    // Sub A created already expired
    await SubmissionReservation.create({
      formId: form._id,
      leaseId: crypto.randomUUID(),
      fenceToken: crypto.randomUUID(),
      status: 'active',
      expiresAt: new Date(Date.now() - 5000)
    });

    // Sub B created active in the future
    const resB = await SubmissionReservationManager.acquire(form._id, { ttlMs: 30000 });
    expect(resB.success).toBe(true);

    // Deletion attempted: Sub B must keep the form protected
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(409);
    expect(delResult.message).toContain('submissions in flight');

    const formAfter = await Form.findById(form._id);
    expect(formAfter).not.toBeNull();
    expect(formAfter.status).toBe('published');
  });

  // --------------------------------------------------------------------------
  // Scenario D: Long-running upload with successful heartbeat renewal
  // --------------------------------------------------------------------------
  it('Scenario D: heartbeat renews reservation during long-running upload and keeps form protected', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario D Form',
      status: 'published'
    });

    const res = await SubmissionReservationManager.acquire(form._id, { ttlMs: 10000 });
    expect(res.success).toBe(true);

    // Renew lease via heartbeat
    const renewed = await SubmissionReservationManager.renew(
      res.leaseId,
      res.fenceToken,
      form._id,
      30000
    );
    expect(renewed).toBe(true);

    const doc = await SubmissionReservation.findOne({ leaseId: res.leaseId });
    expect(new Date(doc.expiresAt).getTime()).toBeGreaterThan(Date.now() + 20000);

    // Deletion is blocked
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(409);
  });

  // --------------------------------------------------------------------------
  // Scenario E: Heartbeat failure during an upload (form deleted / lease revoked)
  // --------------------------------------------------------------------------
  it('Scenario E: heartbeat detects revocation and renew fails if form status changed', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario E Form',
      status: 'published'
    });

    const res = await SubmissionReservationManager.acquire(form._id, { ttlMs: 30000 });
    expect(res.success).toBe(true);

    // Admin or deletion claims form
    await Form.updateOne(
      { _id: form._id },
      {
        $set: {
          status: 'deleting',
          'deletionProgress.leaseId': crypto.randomUUID(),
          'deletionProgress.leaseExpiresAt': new Date(Date.now() + 30000)
        }
      }
    );

    // Next heartbeat renewal must fail immediately
    const renewed = await SubmissionReservationManager.renew(res.leaseId, res.fenceToken, form._id);
    expect(renewed).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Scenario F: Stale worker attempts persistence after deletion ownership acquired
  // --------------------------------------------------------------------------
  it('Scenario F: stale worker persistence is rejected by CAS fence after deletion ownership acquired', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario F Form',
      status: 'published'
    });

    const res = await SubmissionReservationManager.acquire(form._id, { ttlMs: 30000 });

    // Deletion claims ownership
    await Form.updateOne(
      { _id: form._id },
      {
        $set: {
          status: 'deleting',
          'deletionProgress.leaseId': crypto.randomUUID(),
          'deletionProgress.leaseExpiresAt': new Date(Date.now() + 30000)
        }
      }
    );

    // Stale worker attempts to finalize
    // Mark reservation expired to simulate stale lease
    await SubmissionReservation.updateOne(
      { leaseId: res.leaseId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } }
    );

    const isFinalized = await SubmissionReservationManager.finalize(res.leaseId, res.fenceToken);
    expect(isFinalized).toBe(false);

    // Stale worker calls release with staged keys to rollback
    const stagedKey = `forms/${form._id}/staging/${res.leaseId}/file1.pdf`;
    activeS3Objects.set(stagedKey, { mime: 'application/pdf' });

    await SubmissionReservationManager.release(res.leaseId, res.fenceToken, [stagedKey], form._id);

    // Key was deleted from S3
    expect(activeS3Objects.has(stagedKey)).toBe(false);
    // Zero responses created in DB
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario G: S3 upload completes after reservation expiry
  // --------------------------------------------------------------------------
  it('Scenario G: upload completing after reservation expiry fails finalization and triggers rollback', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario G Form',
      status: 'published'
    });

    const res = await SubmissionReservationManager.acquire(form._id, { ttlMs: 1000 });

    // Simulate clock advancing past expiry
    await SubmissionReservation.updateOne(
      { leaseId: res.leaseId },
      { $set: { expiresAt: new Date(Date.now() - 5000) } }
    );

    const uploadedKey = `forms/${form._id}/staging/${res.leaseId}/slow.jpg`;
    activeS3Objects.set(uploadedKey, { mime: 'image/jpeg' });

    // Finalize fails
    const finalized = await SubmissionReservationManager.finalize(res.leaseId, res.fenceToken);
    expect(finalized).toBe(false);

    // Compensation roll back
    await SubmissionReservationManager.release(
      res.leaseId,
      res.fenceToken,
      [uploadedKey],
      form._id
    );
    expect(activeS3Objects.has(uploadedKey)).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Scenario H: Process crashes after S3 upload but before MongoDB persistence
  // --------------------------------------------------------------------------
  it('Scenario H: S3 objects from crashed workers are collected and cleaned up by deletion saga', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario H Form',
      status: 'published'
    });

    const leaseId = crypto.randomUUID();
    const stagedKey = `forms/${form._id}/staging/${leaseId}/orphaned.png`;
    activeS3Objects.set(stagedKey, { mime: 'image/png' });

    // Worker crashed: left reservation with stagedKeys and expired TTL
    await SubmissionReservation.create({
      formId: form._id,
      leaseId,
      fenceToken: crypto.randomUUID(),
      status: 'active',
      expiresAt: new Date(Date.now() - 10000), // Expired
      stagedKeys: [stagedKey]
    });

    // Form deletion runs: must sweep stagedKeys and delete S3 file
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(200);

    // Staged key deleted from S3
    expect(activeS3Objects.has(stagedKey)).toBe(false);
    // Reservation document deleted from MongoDB
    expect(await SubmissionReservation.findOne({ leaseId })).toBeNull();
    // Form deleted
    expect(await Form.findById(form._id)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario I: Process crashes after reservation acquisition
  // --------------------------------------------------------------------------
  it('Scenario I: abandoned reservation without files auto-expires and does not block deletion', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario I Form',
      status: 'published'
    });

    // Worker crashed immediately after acquiring reservation
    await SubmissionReservation.create({
      formId: form._id,
      leaseId: crypto.randomUUID(),
      fenceToken: crypto.randomUUID(),
      status: 'active',
      expiresAt: new Date(Date.now() - 5000)
    });

    // Deletion detects expired reservation, marks it abandoned, and deletes form
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(200);
    expect(await Form.findById(form._id)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario J: Deletion retries after abandoned reservation recovery
  // --------------------------------------------------------------------------
  it('Scenario J: recovers abandoned form deletion and retries failed S3 cleanup keys', async () => {
    const formId = new mongoose.Types.ObjectId();
    const retryKey = `forms/${formId}/retry.pdf`;
    activeS3Objects.set(retryKey, { mime: 'application/pdf' });

    const form = await Form.create({
      _id: formId,
      ownerId: userId,
      title: 'Scenario J Form',
      status: 'deleting',
      deletionProgress: {
        stage: 's3_cleanup',
        leaseId: 'abandoned-del-lease',
        leaseExpiresAt: new Date(Date.now() - 10000), // Expired deletion lease
        failedKeys: [retryKey]
      }
    });

    const recoveryResult = await recoverAbandonedFormDeletions();
    expect(recoveryResult.recoveredCount).toBe(1);
    expect(recoveryResult.failedCount).toBe(0);

    // Stored failed key was retried and deleted from S3
    expect(activeS3Objects.has(retryKey)).toBe(false);
    expect(await Form.findById(form._id)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario K: Duplicate idempotency requests with simultaneous file uploads
  // --------------------------------------------------------------------------
  it('Scenario K: duplicate idempotency collision purges redundant S3 upload', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario K Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Text Answer',
      order: 0
    });

    const idempotencyKey = `idem-${crypto.randomUUID()}`;

    // Request 1 acquires reservation and persists response
    const resA = await SubmissionReservationManager.acquire(form._id);
    const existing = await Response.create({
      formId: form._id,
      idempotencyKey,
      payloadHash: 'hash-abc',
      answers: [{ questionId: question._id, value: 'Hello' }],
      submittedBy: '127.0.0.1'
    });
    await SubmissionReservationManager.finalize(resA.leaseId, resA.fenceToken);

    // Request 2 arrived concurrently: uploaded redundant S3 file
    const resB = await SubmissionReservationManager.acquire(form._id);
    const redundantKey = `forms/${form._id}/staging/${resB.leaseId}/duplicate.pdf`;
    activeS3Objects.set(redundantKey, { mime: 'application/pdf' });

    // Request 2 encounters duplicate key / existing response: releases reservation and purges S3 file
    await SubmissionReservationManager.release(
      resB.leaseId,
      resB.fenceToken,
      [redundantKey],
      form._id
    );

    expect(activeS3Objects.has(redundantKey)).toBe(false);
    expect(await Response.countDocuments({ formId: form._id, idempotencyKey })).toBe(1);
    expect(existing._id).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // Scenario L: Cleanup runs repeatedly and remains idempotent
  // --------------------------------------------------------------------------
  it('Scenario L: repeated deletion runs remain strictly idempotent', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario L Form',
      status: 'published'
    });

    const del1 = await executeFormDeletion(form._id, { userId });
    expect(del1.statusCode).toBe(200);

    const del2 = await executeFormDeletion(form._id, { userId });
    expect(del2.statusCode).toBe(404);

    const del3 = await executeFormDeletion(form._id, { userId });
    expect(del3.statusCode).toBe(404);
  });

  // --------------------------------------------------------------------------
  // Scenario M: Release attempts after deletion or ownership change
  // --------------------------------------------------------------------------
  it('Scenario M: release attempts after form deletion execute safely without errors', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario M Form',
      status: 'published'
    });

    const res = await SubmissionReservationManager.acquire(form._id);
    await Form.findByIdAndDelete(form._id);

    // Release executes on already-deleted form
    await expect(
      SubmissionReservationManager.release(res.leaseId, res.fenceToken, [], form._id)
    ).resolves.not.toThrow();

    expect(await SubmissionReservation.findOne({ leaseId: res.leaseId })).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario N: Counter underflow or stale release cannot corrupt state
  // --------------------------------------------------------------------------
  it('Scenario N: zero-underflow guard ensures activeSubmissions never drops below 0', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario N Form',
      status: 'published',
      activeSubmissions: 0
    });

    // Fire 3 consecutive release calls when activeSubmissions is 0
    for (let i = 0; i < 3; i++) {
      await SubmissionReservationManager.release(
        crypto.randomUUID(),
        crypto.randomUUID(),
        [],
        form._id
      );
    }

    const freshForm = await Form.findById(form._id);
    expect(freshForm.activeSubmissions).toBe(0);
    expect(freshForm.activeSubmissions).toBeGreaterThanOrEqual(0);
  });

  // --------------------------------------------------------------------------
  // Scenario O: Deletion-first race - submission rejected before upload
  // --------------------------------------------------------------------------
  it('Scenario O: deletion-first race rejects submission with 409 and creates zero reservations or S3 objects', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario O Form',
      status: 'published'
    });

    // Deletion claims form first
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(200);

    // Concurrent submission arrives while form is deleted
    const subResult = await SubmissionReservationManager.acquire(form._id);
    expect(subResult.success).toBe(false);
    expect(subResult.statusCode).toBe(404);

    // Zero reservations left behind
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
    expect(activeS3Objects.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario P: Staging pre-allocation ensures crashed uploads are swept
  // --------------------------------------------------------------------------
  it('Scenario P: staging pre-allocation tracks S3 keys before upload completes so deletion saga purges them', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario P Form',
      status: 'published'
    });

    const res = await SubmissionReservationManager.acquire(form._id);
    expect(res.success).toBe(true);

    const plannedKey = `forms/${form._id}/staging/${res.leaseId}/test.pdf`;
    // Pre-record key in reservation prior to S3 upload completion
    await SubmissionReservationManager.recordStagedKey(res.leaseId, res.fenceToken, plannedKey);
    activeS3Objects.set(plannedKey, { mime: 'application/pdf' });

    // Verify key was persisted to MongoDB reservation
    const savedRes = await SubmissionReservation.findOne({ leaseId: res.leaseId });
    expect(savedRes.stagedKeys).toContain(plannedKey);

    // Simulate worker crash: lease expires
    const expiredDate = new Date(Date.now() - 5000);
    await SubmissionReservation.updateOne(
      { leaseId: res.leaseId },
      { $set: { expiresAt: expiredDate } }
    );
    await Form.updateOne({ _id: form._id }, { $set: { activeSubmissionsExpiresAt: expiredDate } });

    // Deletion runs: must collect pre-staged key and delete from S3
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(200);

    expect(activeS3Objects.has(plannedKey)).toBe(false);
    expect(await Form.findById(form._id)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario Q: Deletion drain barrier blocks deletion while persistence is pending
  // --------------------------------------------------------------------------
  it('Scenario Q: deletion cannot pass drain barrier while submission S can still persist; drains and cascades cleanly after S commits', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario Q Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Feedback',
      order: 0
    });

    // Synchronization barriers (zero arbitrary sleeps)
    const persistenceReachedBarrier = createDeferred();
    const allowPersistenceBarrier = createDeferred();

    // Hook immediately before persistence transaction acquires Form write lock
    const originalFormFindOneAndUpdate = Form.findOneAndUpdate.bind(Form);
    let createInvocations = 0;

    vi.spyOn(Form, 'findOneAndUpdate').mockImplementation(async (filter, update, ...rest) => {
      if (
        filter?.status === 'published' &&
        update?.$inc?.lifecycleVersion === 1 &&
        !update?.$inc?.activeSubmissions
      ) {
        createInvocations++;
        persistenceReachedBarrier.resolve();
        await allowPersistenceBarrier.promise;
      }
      return originalFormFindOneAndUpdate(filter, update, ...rest);
    });

    // Launch submission S asynchronously
    const submissionPromise = (async () => {
      return await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [{ questionId: question._id.toString(), value: 'Deterministic test response' }]
        });
    })();

    // Await S reaching the exact point immediately before persistence
    await persistenceReachedBarrier.promise;
    expect(createInvocations).toBe(1);

    // Deletion D attempts to claim and drain the form
    const delResult1 = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });

    // Invariant 1: Deletion CANNOT pass its drain barrier while S can still persist
    expect(delResult1.statusCode).toBe(409);
    expect(delResult1.message).toContain('submissions in flight');

    const formDuring = await Form.findById(form._id);
    expect(formDuring).not.toBeNull();
    expect(formDuring.status).toBe('published');

    // Unpause S: S completes response persistence
    allowPersistenceBarrier.resolve();
    const subResult = await submissionPromise;
    expect(subResult.status).toBe(201);
    expect(subResult.body.success).toBe(true);

    // Verify response is persisted in DB
    expect(await Response.countDocuments({ formId: form._id })).toBe(1);

    // Deletion D retries: now drains and completes cleanly
    const delResult2 = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult2.statusCode).toBe(200);
    expect(delResult2.message).toContain('deleted successfully');

    // Verify both form and the created response are completely deleted
    expect(await Form.findById(form._id)).toBeNull();
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
    expect(await Question.countDocuments({ formId: form._id })).toBe(0);
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);

    // Invariant 2: Verify NO response can ever be created AFTER deletion passed cleanup barrier
    const lateSubmission = await request(app)
      .post(`/api/responses/${form._id}`)
      .send({
        answers: [{ questionId: question._id.toString(), value: 'Late attempt after delete' }]
      });
    expect(lateSubmission.status).toBe(404);
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario R: Deletion claims form first; submission commit rejected with 409
  // --------------------------------------------------------------------------
  it('Scenario R: deletion claims form and enters cleanup before submission commit; submission S is rejected with 409 and rolls back S3 files with 0 responses in DB', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario R Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Note',
      order: 0
    });

    const commitAttemptBarrier = createDeferred();
    const allowCommitBarrier = createDeferred();

    // Hook immediately before persistence transaction acquires Form write lock
    const originalFormFindOneAndUpdate = Form.findOneAndUpdate.bind(Form);
    vi.spyOn(Form, 'findOneAndUpdate').mockImplementation(async (filter, update, ...rest) => {
      if (
        filter?.status === 'published' &&
        update?.$inc?.lifecycleVersion === 1 &&
        !update?.$inc?.activeSubmissions
      ) {
        commitAttemptBarrier.resolve();
        await allowCommitBarrier.promise;
      }
      return originalFormFindOneAndUpdate(filter, update, ...rest);
    });

    // Launch submission S asynchronously
    const submissionPromise = (async () => {
      return await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [{ questionId: question._id.toString(), value: 'Concurrent submission' }]
        });
    })();

    // Wait until S has acquired reservation and is about to commit
    await commitAttemptBarrier.promise;

    // Simulate staged S3 file tracked under active reservation
    const activeRes = await SubmissionReservation.findOne({ formId: form._id, status: 'active' });
    expect(activeRes).not.toBeNull();
    const stagedKey = `forms/${form._id}/staging/${activeRes.leaseId}/attachment.pdf`;
    activeS3Objects.set(stagedKey, { mime: 'application/pdf' });
    await SubmissionReservationManager.recordStagedKey(
      activeRes.leaseId,
      activeRes.fenceToken,
      stagedKey
    );

    // Deletion D claims the form and advances into cleanup
    const deletionLeaseId = crypto.randomUUID();
    await Form.updateOne(
      { _id: form._id },
      {
        $set: {
          status: 'deleting',
          'deletionProgress.leaseId': deletionLeaseId,
          'deletionProgress.leaseExpiresAt': new Date(Date.now() + 30000),
          'deletionProgress.stage': 's3_cleanup'
        }
      }
    );

    // Unpause S: S attempts to commit
    allowCommitBarrier.resolve();
    const subResult = await submissionPromise;

    // Verify S is rejected with HTTP 409 conflict
    expect(subResult.status).toBe(409);
    expect(subResult.body.success).toBe(false);
    expect(subResult.body.message).toContain('currently being deleted');

    // Verify staged S3 file was rolled back and reservation released
    await vi.waitFor(async () => {
      expect(activeS3Objects.has(stagedKey)).toBe(false);
      const resCount = await SubmissionReservation.countDocuments({ formId: form._id });
      expect(resCount).toBe(0);
    });

    // Verify 0 responses were created in MongoDB
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario S: Crash recovery after response persistence but before finalize
  // --------------------------------------------------------------------------
  it('Scenario S: incomplete/unfinalized idempotency record is rejected with 409 and deletion cleans both after expiry', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario S Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Feedback',
      order: 0
    });

    const idempotencyKey = 'idem-boundary-6-' + crypto.randomUUID();

    // S acquires reservation and marks committing, leaving an incomplete pending Response
    const res = await SubmissionReservationManager.acquire(form._id);
    expect(res.success).toBe(true);

    const committing = await SubmissionReservationManager.markCommitting(
      res.leaseId,
      res.fenceToken
    );
    expect(committing).toBe(true);

    const pendingResponse = await Response.create({
      formId: form._id,
      answers: [{ questionId: question._id, value: 'Boundary 6 answer' }],
      submittedBy: '127.0.0.1',
      reservationLeaseId: res.leaseId,
      commitStatus: 'pending',
      idempotencyKey
    });
    expect(pendingResponse).not.toBeNull();

    // Client retries submission with same idempotencyKey BEFORE finalization:
    // Defect C guard must NOT return 200 on an uncommitted/unfinalized response
    const retryRes = await request(app)
      .post(`/api/responses/${form._id}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        answers: [{ questionId: question._id.toString(), value: 'Boundary 6 answer' }]
      });
    expect(retryRes.status).toBe(409);

    // Reservation expires
    const expiredDate = new Date(Date.now() - 5000);
    await SubmissionReservation.updateOne(
      { leaseId: res.leaseId },
      { $set: { expiresAt: expiredDate } }
    );
    await Form.updateOne({ _id: form._id }, { $set: { activeSubmissionsExpiresAt: expiredDate } });

    // Deletion runs: sweeps expired reservation, drains cleanly, deletes form and response
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(200);

    // Both form and response are deleted
    expect(await Form.findById(form._id)).toBeNull();
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario T (Test A1): Stale submission worker pauses immediately before
  // persistence transaction; lease expires and deletion cascades form; worker resumes,
  // fails inside replica-set transaction, self-compensates, and returns 409 with 0 orphan responses.
  // --------------------------------------------------------------------------
  it('Scenario T (Test A1): stale submission worker resuming after lease expiry and form deletion fails transaction and rolls back', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Test A1 Stale Worker Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Question A1',
      order: 0
    });

    const persistenceReachedBarrier = createDeferred();
    const allowPersistenceBarrier = createDeferred();

    const originalFormFindOneAndUpdate = Form.findOneAndUpdate.bind(Form);
    let createInvocations = 0;

    vi.spyOn(Form, 'findOneAndUpdate').mockImplementation(async (filter, update, ...rest) => {
      if (
        filter?.status === 'published' &&
        update?.$inc?.lifecycleVersion === 1 &&
        !update?.$inc?.activeSubmissions
      ) {
        createInvocations++;
        persistenceReachedBarrier.resolve();
        // Deterministic hold before acquiring Form write lock while lease expires and form is deleted
        await allowPersistenceBarrier.promise;
      }
      return originalFormFindOneAndUpdate(filter, update, ...rest);
    });

    // 1. Launch submission worker asynchronously via IIFE
    const submissionPromise = (async () => {
      return await request(app)
        .post(`/api/responses/${form._id}`)
        .send({
          answers: [{ questionId: question._id.toString(), value: 'Stale submission response' }]
        });
    })();

    // 2. Await submission reaching the barrier immediately before persistence transaction
    await persistenceReachedBarrier.promise;
    expect(createInvocations).toBe(1);

    // Retrieve active reservation
    const activeRes = await SubmissionReservation.findOne({ formId: form._id });
    expect(activeRes).not.toBeNull();
    expect(activeRes.status).toBe('active');

    // 3. Simulate clock advancement / lease expiry
    const expiredDate = new Date(Date.now() - 5000);
    await SubmissionReservation.updateOne(
      { leaseId: activeRes.leaseId },
      { $set: { expiresAt: expiredDate } }
    );
    await Form.updateOne({ _id: form._id }, { $set: { activeSubmissionsExpiresAt: expiredDate } });

    // 4. Form deletion executes: drain recognizes expired lease and deletes form
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(200);
    expect(await Form.findById(form._id)).toBeNull();

    // 5. Unpause stale submission worker
    allowPersistenceBarrier.resolve();
    const subResult = await submissionPromise;

    // 6. Assertions: Stale worker must receive 409 Conflict
    expect(subResult.status).toBe(409);
    expect(subResult.body.success).toBe(false);
    expect(subResult.body.message).toContain('Form is currently being deleted');

    // Invariant: Zero orphan responses, questions, or reservations left behind
    expect(await Form.findById(form._id)).toBeNull();
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
    expect(await Question.countDocuments({ formId: form._id })).toBe(0);
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario U (Test B): Staged S3 keys and reservation preservation across lease expiry
  // Proves that vacuumAt: null prevents TTL destruction, and release failures preserve metadata
  // --------------------------------------------------------------------------
  it('Scenario U (Test B): uncleaned staged S3 keys are protected from TTL vacuum and preserved on release failure', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Test B TTL Orphan Form',
      status: 'published'
    });

    // 1. Worker acquires reservation and stages an uploaded file in S3
    const res = await SubmissionReservationManager.acquire(form._id, { ttlMs: 1000 });
    expect(res.success).toBe(true);

    const stagedKey = `forms/${form._id}/staging/${res.leaseId}/crashed_upload.pdf`;
    activeS3Objects.set(stagedKey, { mime: 'application/pdf' });
    await SubmissionReservationManager.recordStagedKey(res.leaseId, res.fenceToken, stagedKey);

    // Verify reservation records staged key and vacuumAt is null
    const savedRes = await SubmissionReservation.findOne({ leaseId: res.leaseId });
    expect(savedRes.stagedKeys).toContain(stagedKey);
    expect(savedRes.vacuumAt).toBeNull();

    // 2. Worker crashes. Reservation lease expires
    const expiredDate = new Date(Date.now() - 65000); // 65 seconds ago
    await SubmissionReservation.updateOne(
      { leaseId: res.leaseId },
      { $set: { expiresAt: expiredDate } }
    );
    await Form.updateOne({ _id: form._id }, { $set: { activeSubmissionsExpiresAt: expiredDate } });

    // 3. Document is NOT eligible for vacuuming because vacuumAt is null
    const eligibleForVacuum = await SubmissionReservation.countDocuments({
      leaseId: res.leaseId,
      vacuumAt: { $ne: null, $lte: new Date() }
    });
    expect(eligibleForVacuum).toBe(0);
    expect(await SubmissionReservation.findOne({ leaseId: res.leaseId })).not.toBeNull();

    // 4. Test S3 release failure preservation: if S3 delete fails during release, record is preserved
    vi.spyOn(storageService, 'deleteFile').mockRejectedValueOnce(new Error('S3 503 Slow Down'));
    await SubmissionReservationManager.release(res.leaseId, res.fenceToken, [stagedKey], form._id);

    // Record is NOT deleted: preserved as abandoned with failedKeys in stagedKeys and vacuumAt: null
    const preservedRes = await SubmissionReservation.findOne({ leaseId: res.leaseId });
    expect(preservedRes).not.toBeNull();
    expect(preservedRes.status).toBe('abandoned');
    expect(preservedRes.stagedKeys).toContain(stagedKey);
    expect(preservedRes.vacuumAt).toBeNull();

    // 5. Form deletion saga executes: sweeps abandoned reservation and deletes the S3 file
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(200);
    expect(await Form.findById(form._id)).toBeNull();
    expect(activeS3Objects.has(stagedKey)).toBe(false);
    expect(await SubmissionReservation.findOne({ leaseId: res.leaseId })).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario V (Test A6): Deletion worker 1 pauses inside S3 cleanup or cascade;
  // lease expires; Worker 2 reclaims deletion and completes;
  // Worker 1 resumes, detects lease loss via CAS, and aborts with 409 cleanly.
  // --------------------------------------------------------------------------
  it('Scenario V (Test A6): deletion worker 1 detects lease reclaim by worker 2 and aborts cleanly without double-cascade', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Test A6 Lease Reclaim Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Q1',
      order: 0
    });

    const responseDoc = await Response.create({
      formId: form._id,
      answers: [{ questionId: question._id, value: 'Answer 1' }],
      submittedBy: '127.0.0.1'
    });

    const testFileKey = `forms/${form._id}/responses/file1.pdf`;
    activeS3Objects.set(testFileKey, { mime: 'application/pdf' });

    // Update response to reference S3 key
    await Response.updateOne(
      { _id: responseDoc._id },
      { $set: { 'answers.0.value': { key: testFileKey } } }
    );

    const worker1InsideS3Barrier = createDeferred();
    const allowWorker1ResumeBarrier = createDeferred();
    let deleteFilesCallCount = 0;

    vi.spyOn(storageService, 'deleteFiles').mockImplementation(async (keys) => {
      deleteFilesCallCount++;
      if (deleteFilesCallCount === 1) {
        // Worker 1 enters S3 deletion and pauses
        worker1InsideS3Barrier.resolve();
        await allowWorker1ResumeBarrier.promise;
      }
      const deletedKeys = [];
      for (const k of keys) {
        activeS3Objects.delete(k);
        deletedKeys.push(k);
      }
      return { success: true, deletedKeys, failedKeys: [], totalRequested: keys.length };
    });

    // 1. Launch Deletion Worker 1 asynchronously
    const worker1Promise = executeFormDeletion(form._id, { userId, drainWaitMs: 0 });

    // 2. Wait until Worker 1 has claimed the form and paused inside S3 cleanup
    await worker1InsideS3Barrier.promise;
    const claimedFormW1 = await Form.findById(form._id);
    expect(claimedFormW1.status).toBe('deleting');
    const worker1LeaseId = claimedFormW1.deletionProgress.leaseId;
    expect(worker1LeaseId).toBeDefined();

    // 3. Worker 1 deletion lease expires
    const expiredDate = new Date(Date.now() - 5000);
    await Form.updateOne(
      { _id: form._id },
      { $set: { 'deletionProgress.leaseExpiresAt': expiredDate } }
    );

    // 4. Deletion Worker 2 (or automated recovery job) reclaims the expired deletion lease
    const worker2Result = await executeFormDeletion(form._id, {
      isSystemRecovery: true,
      drainWaitMs: 0
    });
    expect(worker2Result.statusCode).toBe(200);
    expect(worker2Result.success).toBe(true);

    // Form and response are now completely deleted by Worker 2
    expect(await Form.findById(form._id)).toBeNull();
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
    expect(activeS3Objects.has(testFileKey)).toBe(false);

    // 5. Worker 1 unpauses and attempts to advance stage or execute cascade
    allowWorker1ResumeBarrier.resolve();
    const worker1Result = await worker1Promise;

    // 6. Assertions for Worker 1:
    // Worker 1 must detect that its lease was reclaimed and return HTTP 409
    expect(worker1Result.success).toBe(false);
    expect(worker1Result.statusCode).toBe(409);
    expect(worker1Result.message).toContain('reclaimed by another worker');

    // Verify database remains cleanly deleted with no phantom errors or double-cascade
    expect(await Form.findById(form._id)).toBeNull();
    expect(await Question.countDocuments({ formId: form._id })).toBe(0);
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario W (Race 3): Deletion claim interleaves between reservation Phase 1 and Phase 2
  // --------------------------------------------------------------------------
  it('Scenario W (Race 3): deletion claim interleaves concurrently with reservation acquire; transaction rejects acquire with 409 and 0 orphan reservations', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario W Form',
      status: 'published'
    });

    const originalFindOneAndUpdate = Form.findOneAndUpdate.bind(Form);
    let phase2Intercepted = false;

    vi.spyOn(Form, 'findOneAndUpdate').mockImplementation(async (filter, update, ...rest) => {
      if (
        filter &&
        filter._id &&
        filter.status === 'published' &&
        update?.$inc?.activeSubmissions === 1 &&
        !phase2Intercepted
      ) {
        phase2Intercepted = true;
        // Concurrent deletion worker claims form immediately before acquire transaction executes
        await originalFindOneAndUpdate(
          { _id: form._id },
          {
            $set: {
              status: 'deleting',
              'deletionProgress.leaseId': crypto.randomUUID(),
              'deletionProgress.leaseExpiresAt': new Date(Date.now() + 30000)
            }
          }
        );
      }
      return originalFindOneAndUpdate(filter, update, ...rest);
    });

    const res = await SubmissionReservationManager.acquire(form._id);

    expect(phase2Intercepted).toBe(true);
    expect(res.success).toBe(false);
    expect(res.statusCode).toBe(409);
    expect(res.message).toBe('Form is currently being deleted');

    // Invariant: no orphaned reservations survive transaction abort
    const survivingReservations = await SubmissionReservation.countDocuments({ formId: form._id });
    expect(survivingReservations).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Scenario X (Race 5): S3 upload completes late after deletion completed; post-upload assertion purges file
  // --------------------------------------------------------------------------
  it('Scenario X (Race 5): S3 upload completes late after deletion has occurred; post-upload assertion purges file and rejects with 409', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario X Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment X',
      required: true,
      order: 0
    });

    const tmpDir = os.tmpdir();
    const tmpFilePath = path.join(tmpDir, `test-upload-x-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(tmpFilePath, '%PDF-1.4\nTest Content\n%%EOF');

    const uploadStartedBarrier = createDeferred();
    const allowUploadCompleteBarrier = createDeferred();
    let uploadedKeyCaptured = null;

    vi.spyOn(storageService, 'uploadFile').mockImplementation(async (fileStream, key, mime) => {
      uploadedKeyCaptured = key;
      activeS3Objects.set(key, { mime, timestamp: Date.now() });
      uploadStartedBarrier.resolve();
      // Hold upload in flight
      await allowUploadCompleteBarrier.promise;
      return key;
    });

    const mockReq = {
      params: { formId: form._id.toString() },
      targetForm: { _id: form._id, status: 'published', ownerId: userId },
      body: { answers: JSON.stringify([]) },
      files: [
        {
          fieldname: `file_${question._id.toString()}`,
          originalname: 'test.pdf',
          mimetype: 'application/pdf',
          size: 25,
          path: tmpFilePath
        }
      ],
      headers: {},
      ip: '127.0.0.1',
      on: vi.fn(),
      off: vi.fn()
    };

    let responseResult = null;
    const mockRes = {
      statusCode: null,
      body: null,
      writableEnded: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        this.writableEnded = true;
        responseResult = { statusCode: this.statusCode, body: this.body };
        return this;
      }
    };

    const next = vi.fn();

    // 1. Launch submission in background
    const submissionPromise = submitResponse(mockReq, mockRes, next);

    // 2. Wait until file upload has entered storageService.uploadFile
    await uploadStartedBarrier.promise;
    expect(uploadedKeyCaptured).not.toBeNull();
    expect(activeS3Objects.has(uploadedKeyCaptured)).toBe(true);

    // 3. Lease expires while upload is paused
    const expiredDate = new Date(Date.now() - 5000);
    await SubmissionReservation.updateMany(
      { formId: form._id },
      { $set: { expiresAt: expiredDate } }
    );
    await Form.updateOne({ _id: form._id }, { $set: { activeSubmissionsExpiresAt: expiredDate } });

    // 4. Form deletion runs to completion
    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(delResult.statusCode).toBe(200);
    expect(await Form.findById(form._id)).toBeNull();

    // 5. Upload completes late after form deletion has finished
    allowUploadCompleteBarrier.resolve();
    await submissionPromise;

    // 6. Assertions:
    // Post-upload assertion must detect lost lease, purge uploaded S3 key, and return 409
    expect(responseResult.statusCode).toBe(409);
    expect(responseResult.body.message).toContain('Form is currently being deleted');
    expect(activeS3Objects.has(uploadedKeyCaptured)).toBe(false);
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);

    // Cleanup temp file
    if (fs.existsSync(tmpFilePath)) {
      fs.unlinkSync(tmpFilePath);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario Y (Race 6): Client abort or heartbeat failure triggers upload cancellation
  // --------------------------------------------------------------------------
  it('Scenario Y (Race 6): client abort during upload triggers abortSignal, terminating upload and cleaning S3', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario Y Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'file',
      label: 'Attachment Y',
      required: true,
      order: 0
    });

    const tmpDir = os.tmpdir();
    const tmpFilePath = path.join(tmpDir, `test-upload-y-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(tmpFilePath, '%PDF-1.4\nTest Content Y\n%%EOF');

    const uploadStartedBarrier = createDeferred();
    let abortedSignalObserved = false;
    let uploadedKey = null;

    vi.spyOn(storageService, 'uploadFile').mockImplementation(
      async (fileStream, key, mime, options) => {
        uploadedKey = key;
        activeS3Objects.set(key, { mime, timestamp: Date.now() });
        uploadStartedBarrier.resolve();

        return new Promise((resolve, reject) => {
          if (options?.abortSignal) {
            options.abortSignal.addEventListener('abort', () => {
              abortedSignalObserved = true;
              const err = new Error('Upload aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
    );

    const emitter = new EventEmitter();
    const mockReq = Object.assign(emitter, {
      params: { formId: form._id.toString() },
      targetForm: { _id: form._id, status: 'published', ownerId: userId },
      body: { answers: JSON.stringify([]) },
      files: [
        {
          fieldname: `file_${question._id.toString()}`,
          originalname: 'test.pdf',
          mimetype: 'application/pdf',
          size: 25,
          path: tmpFilePath
        }
      ],
      headers: {},
      ip: '127.0.0.1'
    });

    const mockRes = {
      statusCode: null,
      body: null,
      writableEnded: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      }
    };

    const next = vi.fn();

    // 1. Launch submission
    const submissionPromise = submitResponse(mockReq, mockRes, next);

    // 2. Wait until upload starts
    await uploadStartedBarrier.promise;
    expect(uploadedKey).not.toBeNull();

    // 3. Client disconnects while upload is running
    mockReq.emit('close');

    await submissionPromise;

    // 4. Verification: abortSignal was triggered, S3 object was rolled back
    expect(abortedSignalObserved).toBe(true);
    expect(activeS3Objects.has(uploadedKey)).toBe(false);
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);

    // Temp file cleaned up
    if (fs.existsSync(tmpFilePath)) {
      fs.unlinkSync(tmpFilePath);
    }
  });

  // --------------------------------------------------------------------------
  // Scenario Z (Race 1 & Race 2): Standalone MongoDB bookend sweep wipes racing Response before Form deletion
  // --------------------------------------------------------------------------
  it('Scenario Z (Race 1 & Race 2): replica-set transaction serialization blocks concurrent submission launched during deletion cascade', async () => {
    const form = await Form.create({
      ownerId: userId,
      title: 'Scenario Z Form',
      status: 'published'
    });

    const question = await Question.create({
      formId: form._id,
      type: 'short_text',
      label: 'Question Z',
      order: 0
    });

    const originalQuestionDeleteMany = Question.deleteMany.bind(Question);
    let racingSubmissionPromise = null;

    // Intercept inside T_del after Form write lock: trigger concurrent submitResponse without blocking T_del
    vi.spyOn(Question, 'deleteMany').mockImplementation(async (...args) => {
      const result = await originalQuestionDeleteMany(...args);
      if (!racingSubmissionPromise) {
        racingSubmissionPromise = request(app)
          .post(`/api/responses/${form._id}`)
          .send({
            answers: [{ questionId: question._id.toString(), value: 'Racing concurrent response' }]
          });
      }
      return result;
    });

    const delResult = await executeFormDeletion(form._id, { userId, drainWaitMs: 0 });
    expect(racingSubmissionPromise).not.toBeNull();
    const subResult = await racingSubmissionPromise;

    expect(delResult.statusCode).toBe(200);
    expect(delResult.success).toBe(true);
    expect([404, 409]).toContain(subResult.status);

    // Invariant: Zero orphan form, questions, responses, or reservations survive
    expect(await Form.findById(form._id)).toBeNull();
    expect(await Question.countDocuments({ formId: form._id })).toBe(0);
    expect(await Response.countDocuments({ formId: form._id })).toBe(0);
    expect(await SubmissionReservation.countDocuments({ formId: form._id })).toBe(0);
  });
});
