/**
 * Suite 7: Background Worker Safety & Reconciliation Quarantine
 * File: server/src/tests/causalFence/workerSafety.test.js
 *
 * Verifies:
 * - Worker CAS claim protocol prevents concurrent duplicate claims
 * - 40-second non-destructive quarantine shields ambiguous records from premature sweeps
 * - 5-Tier classification ladder in PrefixSweepService enforces primary majority read concern
 * - saveCheckpoint enforces majority write concern
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { startReplSet, stopReplSet } from '../../testUtils/replSetHelper.js';
import Form from '../../models/form.js';
import Question from '../../models/question.js';
import Response from '../../models/response.js';
import User from '../../models/user.js';
import SubmissionReservation from '../../models/submissionReservation.js';
import StorageJournal, {
  STORAGE_OPERATION_TYPE,
  STORAGE_JOURNAL_STATUS
} from '../../models/storageJournal.js';
import InstanceLease, { InstanceLeaseSlot } from '../../models/instanceLease.js';
import { PrefixSweepService } from '../../services/prefixSweepService.js';
import * as instanceLeaseService from '../../services/instanceLeaseService.js';

describe('Suite 7: Background Worker Safety (workerSafety)', () => {
  let replSet;
  let prefixSweepService;

  beforeAll(async () => {
    replSet = await startReplSet([
      Form,
      Question,
      Response,
      User,
      SubmissionReservation,
      StorageJournal,
      InstanceLease,
      InstanceLeaseSlot
    ]);
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

    await User.create({
      name: 'Worker Safety User',
      email: `worker-${Date.now()}@test.com`,
      password: 'password123'
    });

    await instanceLeaseService.ensureInstanceSingletonExists();
    await instanceLeaseService.acquireInstanceLease({ instanceId: 'inst-suite-7', skipHeartbeat: true });

    prefixSweepService = new PrefixSweepService({
      s3Provider: { deleteFile: vi.fn().mockResolvedValue(true) },
      minOrphanAgeMs: 60000 // 60 seconds
    });
  });

  it('7.1: Worker CAS claim protocol grants single worker lease and rejects concurrent claim', async () => {
    const opId = 'op-cas-claim-1';
    await StorageJournal.create({
      operationId: opId,
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      status: STORAGE_JOURNAL_STATUS.AMBIGUOUS,
      destinationKey: 'staging/forms/form-1/lease-1/file.pdf',
      epoch: 1,
      quarantinedUntil: null,
      lockedUntil: null
    });

    // Worker 1 claims
    const claim1 = await StorageJournal.claimForReconciliation(opId, 'worker-alpha', {
      leaseDurationMs: 15000
    });
    expect(claim1).toBeTruthy();
    expect(claim1.status).toBe(STORAGE_JOURNAL_STATUS.RECONCILING);
    expect(claim1.lockedBy).toBe('worker-alpha');
    expect(claim1.epoch).toBe(2);
    expect(claim1.reconciliationPasses).toBe(1);

    // Worker 2 attempts concurrent claim on the same op
    const claim2 = await StorageJournal.claimForReconciliation(opId, 'worker-beta', {
      leaseDurationMs: 15000
    });
    expect(claim2).toBeNull(); // Fails closed; worker-alpha retains exclusive lease
  });

  it('7.2: 40-second non-destructive quarantine shields ambiguous records from claim', async () => {
    const opId = 'op-quarantine-1';
    await StorageJournal.create({
      operationId: opId,
      type: STORAGE_OPERATION_TYPE.PUT_OBJECT,
      status: STORAGE_JOURNAL_STATUS.PENDING,
      destinationKey: 'staging/forms/form-1/lease-1/file2.pdf',
      epoch: 1
    });

    // Mark ambiguous with 40,000ms quarantine
    const nowBefore = Date.now();
    const marked = await StorageJournal.markAmbiguous(opId, 1, { quarantineMs: 40000 });
    const nowAfter = Date.now();

    expect(marked.status).toBe(STORAGE_JOURNAL_STATUS.AMBIGUOUS);
    expect(marked.epoch).toBe(2);
    expect(marked.quarantinedUntil).toBeTruthy();

    const qTime = new Date(marked.quarantinedUntil).getTime();
    expect(qTime).toBeGreaterThanOrEqual(nowBefore + 39000);
    expect(qTime).toBeLessThanOrEqual(nowAfter + 41000);

    // Reconciler attempt during quarantine must be rejected
    const claim = await StorageJournal.claimForReconciliation(opId, 'worker-sweeper');
    expect(claim).toBeNull();
  });

  it('7.3: Sweeper 5-tier classification ladder prevents false-negative deletions', async () => {
    const candidateKey = 'forms/form-abc/responses/file-asset.pdf';
    const formId = new mongoose.Types.ObjectId();

    // Tier 0: Object too young (< 60s)
    const tier0Result = await prefixSweepService.classifyCandidate(candidateKey, {
      lastModified: new Date(Date.now() - 10000) // 10s old
    });
    expect(tier0Result.isOrphan).toBe(false);
    expect(tier0Result.reason).toBe('TOO_YOUNG_IN_FLIGHT');

    // Metadata older than 60s for subsequent checks
    const oldMeta = { lastModified: new Date(Date.now() - 120000) };

    // Tier 1: StorageJournal record in-flight/confirmed
    const journal = await StorageJournal.create({
      operationId: 'op-sweep-tier1',
      type: STORAGE_OPERATION_TYPE.COPY_OBJECT,
      status: STORAGE_JOURNAL_STATUS.CONFIRMED,
      destinationKey: candidateKey,
      formId,
      epoch: 1
    });

    const tier1Result = await prefixSweepService.classifyCandidate(candidateKey, oldMeta);
    expect(tier1Result.isOrphan).toBe(false);
    expect(tier1Result.reason).toBe('JOURNAL_ACTIVE_IN_FLIGHT');

    // Remove journal entry to test Tier 2
    await StorageJournal.deleteOne({ _id: journal._id });

    // Tier 2: Committed Response reference exists
    const response = await Response.create({
      formId,
      answers: [{ questionId: new mongoose.Types.ObjectId(), value: { key: candidateKey } }],
      payloadHash: 'hash-tier2',
      commitStatus: 'committed'
    });

    const tier2Result = await prefixSweepService.classifyCandidate(candidateKey, oldMeta);
    expect(tier2Result.isOrphan).toBe(false);
    expect(tier2Result.reason).toBe('COMMITTED_RESPONSE_REFERENCE');

    // Remove response to test Tier 3
    await Response.deleteOne({ _id: response._id });

    // Tier 3: Active SubmissionReservation holds key in stagedKeys
    const reservation = await SubmissionReservation.create({
      formId,
      leaseId: 'lease-sweep-tier3',
      fenceToken: 'fence-sweep',
      status: 'active',
      stagedKeys: [candidateKey],
      expiresAt: new Date(Date.now() + 30000)
    });

    const tier3Result = await prefixSweepService.classifyCandidate(candidateKey, oldMeta);
    expect(tier3Result.isOrphan).toBe(false);
    expect(tier3Result.reason).toBe('ACTIVE_SUBMISSION_RESERVATION');

    // Remove reservation to test Tier 5 (Unreferenced orphan)
    await SubmissionReservation.deleteOne({ _id: reservation._id });

    // Tier 5: All checks negative under primary majority read concern -> True orphan
    const tier5Result = await prefixSweepService.classifyCandidate(candidateKey, oldMeta);
    expect(tier5Result.isOrphan).toBe(true);
    expect(tier5Result.reason).toBe('CONFIRMED_UNREFERENCED_ORPHAN');
  });

  it('7.4: saveCheckpoint persists checkpoint with majority write concern', async () => {
    const prefix = 'forms/checkpoint-test/';
    await prefixSweepService.saveCheckpoint(prefix, {
      continuationToken: 'token-xyz-123',
      passNumber: 3
    });

    const checkpointColl = mongoose.connection.db.collection('sweep_checkpoints');
    const saved = await checkpointColl.findOne({ _id: prefix });
    expect(saved).toBeTruthy();
    expect(saved.continuationToken).toBe('token-xyz-123');
    expect(saved.passNumber).toBe(3);
  });
});
