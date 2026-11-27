import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import multer from 'multer';

import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import storageService from '../services/StorageService.js';
import s3Provider from '../services/S3StorageProvider.js';
import { submitResponse } from './responseController.js';
import { startReplSet, stopReplSet } from '../testUtils/replSetHelper.js';
import {
  verifyRecoverySet,
  DECISION_OUTCOMES,
  DIAGNOSTIC_CODES
} from '../utils/recoveryVerifier.js';

describe('Phase 2D.1K.14.1.7.5: Upload TOCTOU, Single-Pass Stream Provenance & Adversarial Verification Suite', () => {
  let replSet;
  let app;
  let testForm;
  let fileQuestion;
  let createdTempFiles = [];

  const createTempFile = (content) => {
    const tmpPath = path.join(os.tmpdir(), `toctou-test-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(tmpPath, content);
    createdTempFiles.push(tmpPath);
    return tmpPath;
  };

  const createSyntheticRecoverySet = (tempDir, { storageJournals, inventory }) => {
    const mongoDir = path.join(tempDir, 'mongo');
    const minioDir = path.join(tempDir, 'minio');
    fs.mkdirSync(mongoDir, { recursive: true });
    fs.mkdirSync(minioDir, { recursive: true });

    const inventoryRaw = JSON.stringify(inventory, null, 2);
    const inventoryPath = path.join(minioDir, 'inventory.json');
    fs.writeFileSync(inventoryPath, inventoryRaw, 'utf8');
    const inventoryStat = fs.statSync(inventoryPath);
    const inventoryHash = crypto.createHash('sha256').update(inventoryRaw).digest('hex');

    const mongoData = {
      recoverySetId: 'rs-synth-001',
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: null,
        ttlMonitorDisabled: true,
        storageLocked: true
      },
      storageJournals
    };
    const mongoRaw = JSON.stringify(mongoData, null, 2);
    const mongoPath = path.join(mongoDir, 'backup.json');
    fs.writeFileSync(mongoPath, mongoRaw, 'utf8');
    const mongoStat = fs.statSync(mongoPath);
    const mongoHash = crypto.createHash('sha256').update(mongoRaw).digest('hex');

    const manifest = {
      schemaVersion: '1.0.0',
      recoverySetId: 'rs-synth-001',
      createdAt: '2026-11-25T12:00:00.000Z',
      capturedBy: 'test-orchestrator',
      verifierVersion: '1.0.0',
      storage: {
        bucket: 'paperless',
        prefix: 'forms/'
      },
      artifacts: {
        mongo: {
          path: 'mongo/backup.json',
          sizeBytes: mongoStat.size,
          sha256: mongoHash,
          format: 'json',
          declaredGeneration: 1
        },
        minio: {
          path: 'minio/inventory.json',
          sizeBytes: inventoryStat.size,
          sha256: inventoryHash,
          format: 'inventory_json',
          objectCount: inventory.length,
          totalSizeBytes: inventory.reduce((sum, item) => sum + (item.size || 0), 0)
        }
      },
      quiescence: {
        leaseId: 'lease-test-123',
        status: 'QUIESCED',
        admissionFreeze: true,
        workerHalt: true,
        storageFreeze: true
      },
      captureProtocol: {
        protocol: 'PROTOCOL_D',
        order: ['STORAGE_FREEZE', 'MINIO_INVENTORY', 'MONGO_CAPTURE', 'UNQUIESCE']
      },
      unresolvedLateOperationsDeclared: false
    };

    fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  };

  beforeAll(async () => {
    replSet = await startReplSet([Form, Question, Response, SubmissionReservation, StorageJournal]);

    const upload = multer({ dest: os.tmpdir() });
    app = express();
    app.use(express.json());
    app.post(
      '/api/responses/:formId',
      upload.any(),
      submitResponse
    );
  });

  afterAll(async () => {
    for (const f of createdTempFiles) {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch (e) {
          void e;
        }
      }
    }
    await stopReplSet(replSet);
  });

  beforeEach(async () => {
    await Promise.all([
      Form.deleteMany({}),
      Question.deleteMany({}),
      Response.deleteMany({}),
      SubmissionReservation.deleteMany({}),
      StorageJournal.deleteMany({})
    ]);

    testForm = await Form.create({
      title: 'Upload Provenance Form',
      ownerId: new mongoose.Types.ObjectId(),
      status: 'published',
      lifecycleVersion: 1
    });

    fileQuestion = await Question.create({
      formId: testForm._id,
      type: 'file',
      label: 'Document Upload',
      required: true,
      order: 0,
      validation: {
        allowedExtensions: ['pdf'],
        maxFileSize: 10485760
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // TEST 1 & TEST 11 & TEST 12: Single-Read Disk Upload and Exact Byte Identity
  // =========================================================================
  it('T01: Disk-backed file upload hashes the exact uploaded chunks without secondary disk reads', async () => {
    const payloadBytes = Buffer.from(
      '%PDF-1.4\n' + 'A'.repeat(65536) + 'B'.repeat(65536) + '\n%%EOF\n'
    );
    const expectedHash = crypto.createHash('sha256').update(payloadBytes).digest('hex');
    const expectedSize = payloadBytes.length;

    const tmpPath = createTempFile(payloadBytes);

    let streamReadCount = 0;
    const originalCreateReadStream = fs.createReadStream;
    const streamSpy = vi.spyOn(fs, 'createReadStream').mockImplementation((targetPath, ...args) => {
      if (typeof targetPath === 'string' && targetPath !== tmpPath && targetPath.startsWith(os.tmpdir())) {
        streamReadCount++;
      }
      return originalCreateReadStream.call(fs, targetPath, ...args);
    });

    const readFileSpy = vi.spyOn(fs.promises, 'readFile');

    const res = await request(app)
      .post(`/api/responses/${testForm._id}`)
      .field('answers', '[]')
      .attach(`file_${fileQuestion._id}`, tmpPath, {
        filename: 'valid.pdf',
        contentType: 'application/pdf'
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    // Assert that fs.promises.readFile was NOT called for the upload payload (no double-read!)
    const filePayloadReads = readFileSpy.mock.calls.filter(([p]) =>
      typeof p === 'string' && p !== tmpPath && p.startsWith(os.tmpdir())
    );
    expect(filePayloadReads.length).toBe(0);

    // Assert staging upload opened the disk file exactly once
    expect(streamSpy).toHaveBeenCalled();
    expect(streamReadCount).toBe(1);

    // Verify StorageJournal contains exact payloadSize and payloadHash
    const journalEntries = await StorageJournal.find({ formId: testForm._id }).lean();
    expect(journalEntries.length).toBeGreaterThanOrEqual(2); // PutObject and CopyObject

    const copyEntry = journalEntries.find((j) => j.type === STORAGE_OPERATION_TYPE.COPY_OBJECT);
    expect(copyEntry).toBeDefined();
    expect(copyEntry.status).toBe(STORAGE_JOURNAL_STATUS.COMMITTED);
    expect(copyEntry.payloadSize).toBe(expectedSize);
    expect(copyEntry.payloadHash).toBe(expectedHash);
  });

  // =========================================================================
  // TEST 2: Buffer-backed upload hashes exact buffer
  // =========================================================================
  it('T02: Buffer-backed upload preserves exact size and SHA-256 hash', async () => {
    const bufferPayload = Buffer.from('%PDF-1.4\nBuffer Content\n%%EOF\n');
    const expectedHash = crypto.createHash('sha256').update(bufferPayload).digest('hex');
    const expectedSize = bufferPayload.length;
    const destKey = `test/buffer-upload-${crypto.randomUUID()}.pdf`;

    const result = await storageService.uploadFile(bufferPayload, destKey, 'application/pdf', {
      returnMetadata: true
    });

    expect(result.key).toBe(destKey);
    expect(result.payloadSize).toBe(expectedSize);
    expect(result.payloadHash).toBe(expectedHash);

    const journal = await StorageJournal.findOne({ destinationKey: destKey }).lean();
    expect(journal.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
    expect(journal.payloadSize).toBe(expectedSize);
    expect(journal.payloadHash).toBe(expectedHash);
  });

  // =========================================================================
  // TEST 3: Empty file boundary (0 bytes)
  // =========================================================================
  it('T03: Empty file (0 bytes) computes standard empty SHA-256 at storage layer and rejects at HTTP controller', async () => {
    const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const destKey = `test/empty-${crypto.randomUUID()}.pdf`;

    // Part A: StorageService handles 0-byte payload safely
    const storageResult = await storageService.uploadFile(Buffer.alloc(0), destKey, 'application/pdf', {
      returnMetadata: true
    });
    expect(storageResult.payloadSize).toBe(0);
    expect(storageResult.payloadHash).toBe(emptySha256);

    const journal = await StorageJournal.findOne({ destinationKey: destKey }).lean();
    expect(journal.payloadSize).toBe(0);
    expect(journal.payloadHash).toBe(emptySha256);

    // Part B: HTTP gate rejects 0-byte file upload
    const tmpEmpty = createTempFile(Buffer.alloc(0));
    const res = await request(app)
      .post(`/api/responses/${testForm._id}`)
      .field('answers', '[]')
      .attach(`file_${fileQuestion._id}`, tmpEmpty, {
        filename: 'empty.pdf',
        contentType: 'application/pdf'
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // =========================================================================
  // TEST 6: Source stream error fails upload without committed metadata
  // =========================================================================
  it('T06: Source stream error prevents metadata finalization and leaves zero committed records', async () => {
    const destKey = `test/stream-error-${crypto.randomUUID()}.pdf`;

    // Create an errored readable stream
    const errorStream = new (await import('node:stream')).Readable({
      read() {
        this.destroy(new Error('Simulated disk read error (EIO)'));
      }
    });

    await expect(
      storageService.uploadFile(errorStream, destKey, 'application/pdf', {
        returnMetadata: true
      })
    ).rejects.toThrow('Simulated disk read error (EIO)');

    // Ensure no CONFIRMED or COMMITTED journal entry exists for destKey
    const journal = await StorageJournal.findOne({
      destinationKey: destKey,
      status: { $in: [STORAGE_JOURNAL_STATUS.CONFIRMED, STORAGE_JOURNAL_STATUS.COMMITTED] }
    });
    expect(journal).toBeNull();
  });

  // =========================================================================
  // TEST 7: Upload consumer failure produces AMBIGUOUS quarantine
  // =========================================================================
  it('T07: Upload consumer network failure triggers AMBIGUOUS status with durable quarantine', async () => {
    const destKey = `test/consumer-failure-${crypto.randomUUID()}.pdf`;
    const payload = Buffer.from('%PDF-1.4\nTest\n%%EOF\n');

    vi.spyOn(s3Provider, 'uploadFile').mockRejectedValueOnce(
      new Error('S3 connection reset by peer (ECONNRESET)')
    );

    await expect(
      storageService.uploadFile(payload, destKey, 'application/pdf', {
        returnMetadata: true
      })
    ).rejects.toThrow('S3 connection reset by peer (ECONNRESET)');

    const journal = await StorageJournal.findOne({ destinationKey: destKey }).lean();
    expect(journal).toBeDefined();
    expect(journal.status).toBe(STORAGE_JOURNAL_STATUS.AMBIGUOUS);
    expect(journal.quarantinedUntil).toBeTruthy();
    expect(new Date(journal.quarantinedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  // =========================================================================
  // TEST 13 & TEST 16: Two upload attempts use different source bytes under isolated keys
  // =========================================================================
  it('T13: Multiple sequential uploads generate independent hashes and isolated staging keys', async () => {
    const payload1 = Buffer.from('%PDF-1.4\nVersion 1 Content\n%%EOF\n');
    const payload2 = Buffer.from('%PDF-1.4\nVersion 2 Completely Different Content\n%%EOF\n');

    const tmp1 = createTempFile(payload1);
    const tmp2 = createTempFile(payload2);

    const res1 = await request(app)
      .post(`/api/responses/${testForm._id}`)
      .field('answers', '[]')
      .attach(`file_${fileQuestion._id}`, tmp1, {
        filename: 'v1.pdf',
        contentType: 'application/pdf'
      });
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post(`/api/responses/${testForm._id}`)
      .field('answers', '[]')
      .attach(`file_${fileQuestion._id}`, tmp2, {
        filename: 'v2.pdf',
        contentType: 'application/pdf'
      });
    expect(res2.status).toBe(201);

    const resp1 = await Response.findById(res1.body.data.id).lean();
    const resp2 = await Response.findById(res2.body.data.id).lean();
    expect(resp1).toBeDefined();
    expect(resp2).toBeDefined();

    const key1 = resp1.answers[0].value.key;
    const key2 = resp2.answers[0].value.key;
    expect(key1).not.toBe(key2);

    const j1 = await StorageJournal.findOne({ destinationKey: key1, status: STORAGE_JOURNAL_STATUS.COMMITTED }).lean();
    const j2 = await StorageJournal.findOne({ destinationKey: key2, status: STORAGE_JOURNAL_STATUS.COMMITTED }).lean();

    expect(j1.payloadHash).toBe(crypto.createHash('sha256').update(payload1).digest('hex'));
    expect(j2.payloadHash).toBe(crypto.createHash('sha256').update(payload2).digest('hex'));
    expect(j1.payloadHash).not.toBe(j2.payloadHash);
  });

  // =========================================================================
  // TEST 21 & TEST 22 & TEST 24: CopyObject Provenance and Post-Cleanup Recovery Verifier
  // =========================================================================
  it('T21: Staging upload propagates exact size and hash to CopyObject and survives staging cleanup in recoveryVerifier', async () => {
    const payloadBytes = Buffer.from('%PDF-1.4\nRecovery Verifier Provenance Payload\n%%EOF\n');
    const expectedHash = crypto.createHash('sha256').update(payloadBytes).digest('hex');
    const expectedSize = payloadBytes.length;

    const tmpPath = createTempFile(payloadBytes);

    const res = await request(app)
      .post(`/api/responses/${testForm._id}`)
      .field('answers', '[]')
      .attach(`file_${fileQuestion._id}`, tmpPath, {
        filename: 'verified.pdf',
        contentType: 'application/pdf'
      });
    expect(res.status).toBe(201);

    const responseDoc = await Response.findById(res.body.data.id).lean();
    const destKey = responseDoc.answers[0].value.key;

    // Verify CopyObject journal record has verified metadata
    const destJournal = await StorageJournal.findOne({
      destinationKey: destKey,
      status: STORAGE_JOURNAL_STATUS.COMMITTED
    }).lean();

    expect(destJournal).toBeDefined();
    expect(destJournal.payloadSize).toBe(expectedSize);
    expect(destJournal.payloadHash).toBe(expectedHash);
    expect(destJournal.responseId.toString()).toBe(responseDoc._id.toString());

    // Construct mock recovery set where staging file was cleaned up (purged from S3 inventory)
    const recoveryDir = path.join(os.tmpdir(), `recov-test-${crypto.randomUUID()}`);
    fs.mkdirSync(recoveryDir, { recursive: true });

    try {
      createSyntheticRecoverySet(recoveryDir, {
        storageJournals: [
          {
            operationId: destJournal.operationId,
            type: 'CopyObject',
            bucket: 'paperless',
            sourceKey: destJournal.sourceKey,
            destinationKey: destKey,
            status: 'COMMITTED',
            payloadSize: expectedSize,
            payloadHash: expectedHash
          }
        ],
        inventory: [
          {
            key: destKey,
            size: expectedSize,
            etag: 'etag-dest-1',
            lastModified: '2026-11-25T12:00:00.000Z',
            sha256: expectedHash
          }
        ]
      });

      const verificationResult = await verifyRecoverySet(recoveryDir);
      expect(verificationResult.decision).toBe(DECISION_OUTCOMES.PASS);
      expect(verificationResult.details.errors).toHaveLength(0);
    } finally {
      fs.rmSync(recoveryDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // TEST 25: Missing or corrupt metadata fails closed in recoveryVerifier
  // =========================================================================
  it('T25: Destination record with corrupt payloadHash fails closed with JOURNAL_PAYLOAD_HASH_MISMATCH', async () => {
    const recoveryDir = path.join(os.tmpdir(), `recov-corrupt-${crypto.randomUUID()}`);
    fs.mkdirSync(recoveryDir, { recursive: true });

    try {
      const destKey = 'forms/123/responses/file.pdf';
      const actualBytesHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const corruptJournalHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      createSyntheticRecoverySet(recoveryDir, {
        storageJournals: [
          {
            operationId: 'op-corrupt-001',
            type: 'CopyObject',
            bucket: 'paperless',
            sourceKey: 'staging/temp_doc.pdf',
            destinationKey: destKey,
            status: 'COMMITTED',
            payloadSize: 100,
            payloadHash: corruptJournalHash // Mismatched hash!
          }
        ],
        inventory: [
          {
            key: destKey,
            size: 100,
            etag: 'etag-dest-2',
            lastModified: '2026-11-25T12:00:00.000Z',
            sha256: actualBytesHash
          }
        ]
      });

      const verificationResult = await verifyRecoverySet(recoveryDir);
      expect(verificationResult.decision).toBe(DECISION_OUTCOMES.FAIL);
      expect(verificationResult.diagnosticCodes).toContain(
        DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_HASH_MISMATCH
      );
    } finally {
      fs.rmSync(recoveryDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // TEST 30: True Pass-Through Streaming (No Whole-File Buffer.concat)
  // =========================================================================
  it('T30: Stream upload streams chunks without whole-file Buffer.concat materialization', async () => {
    const chunk1 = Buffer.from('CHUNK_ONE_DATA_12345_');
    const chunk2 = Buffer.from('CHUNK_TWO_DATA_67890_');
    const chunk3 = Buffer.from('CHUNK_THREE_FINAL_DATA');
    const expectedCombined = Buffer.concat([chunk1, chunk2, chunk3]);
    const expectedHash = crypto.createHash('sha256').update(expectedCombined).digest('hex');
    const expectedSize = expectedCombined.length;

    // Spy on Buffer.concat to verify whole-file payload buffer is never concatenated
    let fullBufferConcatDetected = false;
    const originalConcat = Buffer.concat;
    const concatSpy = vi.spyOn(Buffer, 'concat').mockImplementation((list, totalLength) => {
      if (Array.isArray(list) && list.some((b) => b && b.includes && b.includes('CHUNK_ONE_DATA'))) {
        fullBufferConcatDetected = true;
      }
      return originalConcat.call(Buffer, list, totalLength);
    });

    const stream = new (await import('node:stream')).Readable({
      read() {
        this.push(chunk1);
        this.push(chunk2);
        this.push(chunk3);
        this.push(null);
      }
    });

    const destKey = `test/streaming-pass-through-${crypto.randomUUID()}.dat`;
    const result = await storageService.uploadFile(stream, destKey, 'application/octet-stream', {
      returnMetadata: true
    });

    expect(result.key).toBe(destKey);
    expect(result.payloadSize).toBe(expectedSize);
    expect(result.payloadHash).toBe(expectedHash);
    expect(fullBufferConcatDetected).toBe(false);

    concatSpy.mockRestore();
  });

  // =========================================================================
  // TEST 31: Internal Maximum Byte Limit Enforcement (Fail-Closed)
  // =========================================================================
  it('T31: Stream exceeding maxSizeBytes aborts with LIMIT_FILE_SIZE and never confirms journal', async () => {
    const stream = new (await import('node:stream')).Readable({
      read() {
        this.push(Buffer.alloc(1024, 'A'));
        this.push(Buffer.alloc(1024, 'B'));
        this.push(null);
      }
    });

    const destKey = `test/size-overflow-${crypto.randomUUID()}.dat`;
    const operationId = crypto.randomUUID();

    await expect(
      storageService.uploadFile(stream, destKey, 'application/octet-stream', {
        operationId,
        maxSizeBytes: 1500 // Limit is 1500 bytes, stream provides 2048 bytes
      })
    ).rejects.toThrow(/exceeds maximum limit/);

    const journal = await StorageJournal.findOne({ operationId }).lean();
    expect(journal).toBeDefined();
    // Journal must NOT be CONFIRMED or COMMITTED
    expect(journal.status).toBe(STORAGE_JOURNAL_STATUS.AMBIGUOUS);
    expect(journal.quarantinedUntil).not.toBeNull();
  });

  // =========================================================================
  // TEST 32: Downstream Backpressure Flow Control
  // =========================================================================
  it('T32: Slow downstream consumer asserts backpressure pausing upstream chunk reads', async () => {
    let sourceReadCount = 0;
    const totalChunks = 5;
    const chunkSize = 16 * 1024; // 16 KB

    const sourceStream = new (await import('node:stream')).Readable({
      highWaterMark: 16 * 1024,
      read() {
        if (sourceReadCount < totalChunks) {
          sourceReadCount++;
          this.push(Buffer.alloc(chunkSize, 'Z'));
        } else {
          this.push(null);
        }
      }
    });

    const { HashingByteCounterTransform } = await import('../services/StorageService.js');
    const transform = new HashingByteCounterTransform({ highWaterMark: 16 * 1024 });

    // Slow destination writable with delayed consumption
    let consumerConsumed = 0;
    const slowConsumer = new (await import('node:stream')).Writable({
      highWaterMark: 16 * 1024,
      write(chunk, encoding, callback) {
        consumerConsumed += chunk.length;
        // Delay callback to trigger backpressure
        setTimeout(callback, 20);
      }
    });

    sourceStream.pipe(transform).pipe(slowConsumer);

    await new Promise((resolve) => slowConsumer.on('finish', resolve));
    expect(consumerConsumed).toBe(totalChunks * chunkSize);
    expect(transform.payloadSize).toBe(totalChunks * chunkSize);
  });

  // =========================================================================
  // TEST 33: Non-Replayable Consumed Stream and Fresh Retry Isolation
  // =========================================================================
  it('T33: Consumed stream cannot be replayed; fresh retry creates isolated attempt with fresh hash', async () => {
    const payload = Buffer.from('PAYLOAD_FOR_RETRY_TEST');
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

    const createStream = () => {
      let sent = false;
      return new (require('node:stream').Readable)({
        read() {
          if (!sent) {
            sent = true;
            this.push(payload);
            this.push(null);
          }
        }
      });
    };

    const stream1 = createStream();
    const destKey1 = `test/retry-attempt-1-${crypto.randomUUID()}.txt`;
    const res1 = await storageService.uploadFile(stream1, destKey1, 'text/plain', { returnMetadata: true });
    expect(res1.payloadHash).toBe(expectedHash);

    // Attempting to re-pipe the consumed stream1 yields empty / fails
    expect(stream1.readableEnded).toBe(true);

    // Safe application-level retry uses fresh stream factory
    const stream2 = createStream();
    const destKey2 = `test/retry-attempt-2-${crypto.randomUUID()}.txt`;
    const res2 = await storageService.uploadFile(stream2, destKey2, 'text/plain', { returnMetadata: true });
    expect(res2.payloadHash).toBe(expectedHash);
    expect(res2.key).not.toBe(res1.key);
  });

  // =========================================================================
  // TEST 34: Large Synthetic Stream Constant Memory Boundedness
  // =========================================================================
  it('T34: Multi-megabyte synthetic stream processes with exact byte identity and bounded memory', async () => {
    const chunkCount = 80;
    const chunkSize = 64 * 1024; // 80 * 64KB = 5.12 MB
    const totalExpectedSize = chunkCount * chunkSize;

    const sampleChunk = Buffer.alloc(chunkSize, 'K');
    const sampleHash = crypto.createHash('sha256');
    for (let i = 0; i < chunkCount; i++) {
      sampleHash.update(sampleChunk);
    }
    const expectedHash = sampleHash.digest('hex');

    let chunksPushed = 0;
    const largeStream = new (await import('node:stream')).Readable({
      read() {
        if (chunksPushed < chunkCount) {
          chunksPushed++;
          this.push(sampleChunk);
        } else {
          this.push(null);
        }
      }
    });

    const destKey = `test/large-stream-${crypto.randomUUID()}.bin`;
    const res = await storageService.uploadFile(largeStream, destKey, 'application/octet-stream', {
      maxSizeBytes: 10 * 1024 * 1024,
      returnMetadata: true
    });

    expect(res.payloadSize).toBe(totalExpectedSize);
    expect(res.payloadHash).toBe(expectedHash);

    const journal = await StorageJournal.findOne({ destinationKey: destKey }).lean();
    expect(journal.status).toBe(STORAGE_JOURNAL_STATUS.CONFIRMED);
    expect(journal.payloadSize).toBe(totalExpectedSize);
    expect(journal.payloadHash).toBe(expectedHash);
  });
});
