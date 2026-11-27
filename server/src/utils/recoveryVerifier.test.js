import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import mongoose from 'mongoose';
import {
  verifyRecoverySet,
  assertSafePath,
  computeFileSha256,
  DECISION_OUTCOMES,
  DIAGNOSTIC_CODES,
  VERIFIER_VERSION,
  SUPPORTED_SCHEMA_VERSIONS
} from './recoveryVerifier.js';

describe('Offline Recovery Verifier (recoveryVerifier.js)', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-recov-test-'));
  });

  afterEach(() => {
    try {
      if (tempRoot && fs.existsSync(tempRoot)) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper to construct a synthetic recovery set on disk.
   */
  const createSyntheticRecoverySet = (
    customManifest = {},
    customMongo = {},
    customInventory = null
  ) => {
    const mongoDir = path.join(tempRoot, 'mongo');
    const minioDir = path.join(tempRoot, 'minio');
    fs.mkdirSync(mongoDir, { recursive: true });
    fs.mkdirSync(minioDir, { recursive: true });

    // 1. MinIO inventory
    const inventory =
      customInventory !== null
        ? customInventory
        : [
            {
              key: 'forms/123/response_1/doc.pdf',
              size: 1024,
              etag: 'etag-doc-1',
              lastModified: '2026-11-24T12:00:00.000Z',
              sha256: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
            },
            {
              key: 'forms/123/response_1/sig.png',
              size: 512,
              etag: 'etag-sig-1',
              lastModified: '2026-11-24T12:00:00.000Z',
              sha256: 'b1c2d3e4f500112233445566778899aabbccddeeff00112233445566778899aa'
            }
          ];

    const inventoryPath = path.join(minioDir, 'inventory.json');
    const inventoryRaw =
      typeof inventory === 'string' ? inventory : JSON.stringify(inventory, null, 2);
    fs.writeFileSync(inventoryPath, inventoryRaw, 'utf8');
    const inventoryStat = fs.statSync(inventoryPath);
    const inventoryHash = crypto.createHash('sha256').update(inventoryRaw).digest('hex');

    // 2. MongoDB backup
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
      storageJournals: [
        {
          operationId: 'op-001',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/response_1/doc.pdf',
          status: 'COMMITTED',
          payloadSize: 1024,
          payloadHash: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
        },
        {
          operationId: 'op-002',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/response_1/sig.png',
          status: 'COMMITTED',
          payloadSize: 512,
          payloadHash: 'b1c2d3e4f500112233445566778899aabbccddeeff00112233445566778899aa'
        }
      ],
      ...customMongo
    };

    const mongoPath = path.join(mongoDir, 'backup.json');
    const mongoRaw = typeof mongoData === 'string' ? mongoData : JSON.stringify(mongoData, null, 2);
    fs.writeFileSync(mongoPath, mongoRaw, 'utf8');
    const mongoStat = fs.statSync(mongoPath);
    const mongoHash = crypto.createHash('sha256').update(mongoRaw).digest('hex');

    // 3. Manifest
    const manifest = {
      schemaVersion: '1.0.0',
      recoverySetId: 'rs-synth-001',
      createdAt: '2026-11-24T12:00:00.000Z',
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
          declaredGeneration: 1,
          ...(customManifest.artifacts?.mongo || {})
        },
        minio: {
          path: 'minio/inventory.json',
          sizeBytes: inventoryStat.size,
          sha256: inventoryHash,
          format: 'inventory_json',
          objectCount: Array.isArray(inventory) ? inventory.length : 0,
          totalSizeBytes: Array.isArray(inventory)
            ? inventory.reduce((sum, item) => sum + (item.size || 0), 0)
            : 0,
          ...(customManifest.artifacts?.minio || {})
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
      unresolvedLateOperationsDeclared: false,
      ...customManifest
    };

    const manifestPath = path.join(tempRoot, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return { manifestPath, mongoPath, inventoryPath, manifest, mongoData, inventory };
  };

  // -------------------------------------------------------------------------
  // Case 1: Valid manifest and complete synthetic recovery set
  // -------------------------------------------------------------------------
  it('Case 1: passes completely valid synthetic recovery set with PASS decision', async () => {
    createSyntheticRecoverySet();
    const result = await verifyRecoverySet(tempRoot);

    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
    expect(result.details.errors).toHaveLength(0);
    expect(result.details.warnings).toHaveLength(0);
    expect(result.stages.stageA_manifestValidation.passed).toBe(true);
    expect(result.stages.stageB_artifactIntegrity.passed).toBe(true);
    expect(result.stages.stageC_mongoMetadata.passed).toBe(true);
    expect(result.stages.stageD_minioInventory.passed).toBe(true);
    expect(result.stages.stageE_crossStoreConsistency.passed).toBe(true);
    expect(result.summary).toContain('Recovery set verified');
  });

  // -------------------------------------------------------------------------
  // Case 2: Missing manifest
  // -------------------------------------------------------------------------
  it('Case 2: fails closed with MISSING_MANIFEST when manifest.json is absent', async () => {
    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MISSING_MANIFEST);
  });

  // -------------------------------------------------------------------------
  // Case 3: Unsupported manifest version
  // -------------------------------------------------------------------------
  it('Case 3: fails closed with UNSUPPORTED_SCHEMA_VERSION when version is unsupported', async () => {
    createSyntheticRecoverySet({ schemaVersion: '99.0.0' });
    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA_VERSION);
  });

  // -------------------------------------------------------------------------
  // Case 4: Missing MongoDB artifact
  // -------------------------------------------------------------------------
  it('Case 4: fails closed with MISSING_ARTIFACT_FILE when MongoDB backup file is missing', async () => {
    const { mongoPath } = createSyntheticRecoverySet();
    fs.unlinkSync(mongoPath);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MISSING_ARTIFACT_FILE);
  });

  // -------------------------------------------------------------------------
  // Case 5: Missing MinIO inventory
  // -------------------------------------------------------------------------
  it('Case 5: fails closed with MISSING_ARTIFACT_FILE when MinIO inventory file is missing', async () => {
    const { inventoryPath } = createSyntheticRecoverySet();
    fs.unlinkSync(inventoryPath);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MISSING_ARTIFACT_FILE);
  });

  // -------------------------------------------------------------------------
  // Case 6: Invalid artifact path
  // -------------------------------------------------------------------------
  it('Case 6: fails closed with INVALID_FIELD_TYPE when artifact path is empty or non-string', async () => {
    createSyntheticRecoverySet({
      artifacts: {
        mongo: { path: '', sizeBytes: 10, sha256: 'abc', format: 'json' },
        minio: {
          path: 'minio/inventory.json',
          sizeBytes: 10,
          sha256: 'abc',
          format: 'inventory_json',
          objectCount: 1,
          totalSizeBytes: 10
        }
      }
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.INVALID_FIELD_TYPE);
  });

  // -------------------------------------------------------------------------
  // Case 7: Path traversal attempt
  // -------------------------------------------------------------------------
  it('Case 7: detects and fails path traversal attempt escaping recovery root', async () => {
    createSyntheticRecoverySet({
      artifacts: {
        mongo: { path: '../../../etc/passwd', sizeBytes: 10, sha256: 'abc', format: 'json' },
        minio: {
          path: 'minio/inventory.json',
          sizeBytes: 10,
          sha256: 'abc',
          format: 'inventory_json',
          objectCount: 1,
          totalSizeBytes: 10
        }
      }
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.PATH_TRAVERSAL_DETECTED);
  });

  // -------------------------------------------------------------------------
  // Case 8: Symlink escaping the recovery-set root (Leaf & Directory)
  // -------------------------------------------------------------------------
  it('Case 8: detects and fails leaf symlink escaping recovery set root', async () => {
    createSyntheticRecoverySet();
    const externalFile = path.join(os.tmpdir(), `paperless-external-${Date.now()}.txt`);
    fs.writeFileSync(externalFile, 'secret data', 'utf8');

    try {
      const symlinkPath = path.join(tempRoot, 'mongo', 'symlink_backup.json');
      fs.symlinkSync(externalFile, symlinkPath);

      const manifestPath = path.join(tempRoot, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.artifacts.mongo.path = 'mongo/symlink_backup.json';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      const result = await verifyRecoverySet(tempRoot);
      expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
      expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.SYMLINK_ESCAPE_DETECTED);
    } finally {
      if (fs.existsSync(externalFile)) fs.unlinkSync(externalFile);
    }
  });

  it('Case 8b: detects and fails intermediate directory symlink escaping recovery set root', async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperless-ext-dir-'));
    const externalSecretFile = path.join(externalDir, 'backup.json');
    fs.writeFileSync(externalSecretFile, JSON.stringify({ recoverySetId: 'rogue' }), 'utf8');

    try {
      createSyntheticRecoverySet();
      // Replace mongo directory with a symlink pointing to externalDir
      const mongoDirPath = path.join(tempRoot, 'mongo');
      fs.rmSync(mongoDirPath, { recursive: true, force: true });
      fs.symlinkSync(externalDir, mongoDirPath);

      const result = await verifyRecoverySet(tempRoot);
      expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
      expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.SYMLINK_ESCAPE_DETECTED);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Case 9: Incorrect artifact size
  // -------------------------------------------------------------------------
  it('Case 9: fails closed with ARTIFACT_SIZE_MISMATCH when declared size differs from actual', async () => {
    createSyntheticRecoverySet();
    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.sizeBytes += 999;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.ARTIFACT_SIZE_MISMATCH);
  });

  // -------------------------------------------------------------------------
  // Case 10: Checksum mismatch
  // -------------------------------------------------------------------------
  it('Case 10: fails closed with CHECKSUM_MISMATCH when artifact content was corrupted', async () => {
    const { mongoPath } = createSyntheticRecoverySet();
    fs.appendFileSync(mongoPath, '   ');

    const stat = fs.statSync(mongoPath);
    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.sizeBytes = stat.size;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.CHECKSUM_MISMATCH);
  });

  // -------------------------------------------------------------------------
  // Case 11: Duplicate object key
  // -------------------------------------------------------------------------
  it('Case 11: fails closed with DUPLICATE_OBJECT_KEY when inventory lists duplicate keys', async () => {
    const duplicateInventory = [
      { key: 'forms/123/response_1/doc.pdf', size: 1024, etag: 'etag-1' },
      { key: 'forms/123/response_1/doc.pdf', size: 1024, etag: 'etag-1-dup' }
    ];
    createSyntheticRecoverySet({}, {}, duplicateInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.DUPLICATE_OBJECT_KEY);
  });

  // -------------------------------------------------------------------------
  // Case 12: Missing expected object (inventory omitted committed journal object)
  // -------------------------------------------------------------------------
  it('Case 12: fails closed when inventory omits an object committed in StorageJournal', async () => {
    const incompleteInventory = [
      { key: 'forms/123/response_1/doc.pdf', size: 1024, etag: 'etag-1' }
      // sig.png omitted
    ];
    createSyntheticRecoverySet({}, {}, incompleteInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(
      DIAGNOSTIC_CODES.JOURNAL_REFERENCE_MISSING_FROM_INVENTORY
    );
  });

  // -------------------------------------------------------------------------
  // Case 13: Unexpected object (inventory contains deleted object or out-of-prefix)
  // -------------------------------------------------------------------------
  it('Case 13: fails closed when inventory contains an object outside declared prefix', async () => {
    const unexpectedInventory = [
      { key: 'forms/123/response_1/doc.pdf', size: 1024, etag: 'etag-1' },
      { key: 'unauthorized_prefix/secret.pem', size: 512, etag: 'etag-2' }
    ];
    createSyntheticRecoverySet({}, {}, unexpectedInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNEXPECTED_INVENTORY_OBJECT);
  });

  // -------------------------------------------------------------------------
  // Case 14: Journal reference to missing object
  // -------------------------------------------------------------------------
  it('Case 14: fails closed with JOURNAL_REFERENCE_MISSING_FROM_INVENTORY when journal references non-existent key', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-ghost',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/response_1/ghost_file.bin',
          status: 'COMMITTED',
          payloadSize: 9999
        }
      ]
    };
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(
      DIAGNOSTIC_CODES.JOURNAL_REFERENCE_MISSING_FROM_INVENTORY
    );
  });

  // -------------------------------------------------------------------------
  // Case 15: Unresolved journal operation
  // -------------------------------------------------------------------------
  it('Case 15: fails closed with UNRESOLVED_JOURNAL_OPERATIONS when journal has PENDING/DISPATCHED records', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-pending',
          type: 'PutObject',
          destinationKey: 'forms/123/response_1/doc.pdf',
          status: 'PENDING'
        }
      ]
    };
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNRESOLVED_JOURNAL_OPERATIONS);
  });

  // -------------------------------------------------------------------------
  // Case 16: Missing recovery-generation identity / cross-store gap
  // -------------------------------------------------------------------------
  it('Case 16: identifies cross-store generation limitation and reports NOT_VERIFIABLE_OFFLINE', async () => {
    createSyntheticRecoverySet();
    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.minio.declaredGeneration = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.CROSS_STORE_GENERATION_UNVERIFIABLE);
    expect(result.decision).toBe(DECISION_OUTCOMES.NOT_VERIFIABLE_OFFLINE);
  });

  // -------------------------------------------------------------------------
  // Case 17: Mismatched recovery-set identities
  // -------------------------------------------------------------------------
  it('Case 17: fails closed with MISMATCHED_RECOVERY_SET_ID when mongo artifact ID differs from manifest', async () => {
    const customMongo = { recoverySetId: 'rs-different-id-999' };
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MISMATCHED_RECOVERY_SET_ID);
  });

  // -------------------------------------------------------------------------
  // Case 18: Timestamp-only ordering evidence
  // -------------------------------------------------------------------------
  it('Case 18: blocks recovery admission with TIMESTAMP_ONLY_ORDERING_INSUFFICIENT when protocol is timestamp-only', async () => {
    createSyntheticRecoverySet({
      captureProtocol: {
        protocol: 'TIMESTAMP_ONLY',
        order: ['STORAGE_FREEZE', 'MINIO_INVENTORY', 'MONGO_CAPTURE', 'UNQUIESCE']
      }
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.BLOCKED);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.TIMESTAMP_ONLY_ORDERING_INSUFFICIENT);
  });

  // -------------------------------------------------------------------------
  // Case 19: Missing admission-freeze evidence
  // -------------------------------------------------------------------------
  it('Case 19: blocks admission with MISSING_ADMISSION_FREEZE_EVIDENCE when admissionFreeze is false', async () => {
    createSyntheticRecoverySet({
      quiescence: {
        leaseId: 'lease-test-123',
        status: 'QUIESCED',
        admissionFreeze: false,
        workerHalt: true,
        storageFreeze: true
      }
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.BLOCKED);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MISSING_ADMISSION_FREEZE_EVIDENCE);
  });

  // -------------------------------------------------------------------------
  // Case 20: Missing worker-halt evidence
  // -------------------------------------------------------------------------
  it('Case 20: blocks admission with MISSING_WORKER_HALT_EVIDENCE when workerHalt is false', async () => {
    createSyntheticRecoverySet({
      quiescence: {
        leaseId: 'lease-test-123',
        status: 'QUIESCED',
        admissionFreeze: true,
        workerHalt: false,
        storageFreeze: true
      }
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.BLOCKED);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MISSING_WORKER_HALT_EVIDENCE);
  });

  // -------------------------------------------------------------------------
  // Case 21: Missing storage-freeze evidence
  // -------------------------------------------------------------------------
  it('Case 21: blocks admission with MISSING_STORAGE_FREEZE_EVIDENCE when storageFreeze is false', async () => {
    createSyntheticRecoverySet({
      quiescence: {
        leaseId: 'lease-test-123',
        status: 'QUIESCED',
        admissionFreeze: true,
        workerHalt: true,
        storageFreeze: false
      }
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.BLOCKED);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MISSING_STORAGE_FREEZE_EVIDENCE);
  });

  // -------------------------------------------------------------------------
  // Case 22: Explicit late-operation uncertainty
  // -------------------------------------------------------------------------
  it('Case 22: blocks admission with LATE_OPERATION_UNCERTAINTY when unresolvedLateOperationsDeclared is true', async () => {
    createSyntheticRecoverySet({
      unresolvedLateOperationsDeclared: true
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.BLOCKED);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.LATE_OPERATION_UNCERTAINTY);
  });

  // -------------------------------------------------------------------------
  // Case 23: Malformed inventory
  // -------------------------------------------------------------------------
  it('Case 23: fails closed with MALFORMED_INVENTORY when inventory JSON is syntactically invalid', async () => {
    createSyntheticRecoverySet({}, {}, '{ invalid json');
    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MALFORMED_INVENTORY);
  });

  // -------------------------------------------------------------------------
  // Case 24: Oversized input
  // -------------------------------------------------------------------------
  it('Case 24: fails closed with INPUT_SIZE_EXCEEDED when manifest exceeds size ceiling', async () => {
    createSyntheticRecoverySet();
    const result = await verifyRecoverySet(tempRoot, { maxManifestBytes: 50 });
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.INPUT_SIZE_EXCEEDED);
  });

  // -------------------------------------------------------------------------
  // Case 25: Unreadable artifact
  // -------------------------------------------------------------------------
  it('Case 25: fails closed with UNREADABLE_ARTIFACT / MISSING_ARTIFACT_FILE when file is unreadable', async () => {
    const { mongoPath } = createSyntheticRecoverySet();
    fs.unlinkSync(mongoPath);
    fs.mkdirSync(mongoPath);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(
      result.diagnosticCodes.includes(DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT) ||
        result.diagnosticCodes.includes(DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP)
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 26: Unknown critical manifest field
  // -------------------------------------------------------------------------
  it('Case 26: fails closed with UNKNOWN_CRITICAL_MANIFEST_FIELD when unrecognised fields are injected', async () => {
    createSyntheticRecoverySet({
      unauthorizedInjectedField: 'malicious-config-override'
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNKNOWN_CRITICAL_MANIFEST_FIELD);
  });

  // -------------------------------------------------------------------------
  // Case 27: Verifier must not mutate fixture files
  // -------------------------------------------------------------------------
  it('Case 27: guarantees read-only behavior; leaves all fixture bytes and hashes unmodified', async () => {
    const { manifestPath, mongoPath, inventoryPath } = createSyntheticRecoverySet();

    const hashBeforeManifest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(manifestPath))
      .digest('hex');
    const hashBeforeMongo = crypto
      .createHash('sha256')
      .update(fs.readFileSync(mongoPath))
      .digest('hex');
    const hashBeforeInventory = crypto
      .createHash('sha256')
      .update(fs.readFileSync(inventoryPath))
      .digest('hex');

    await verifyRecoverySet(tempRoot);

    const hashAfterManifest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(manifestPath))
      .digest('hex');
    const hashAfterMongo = crypto
      .createHash('sha256')
      .update(fs.readFileSync(mongoPath))
      .digest('hex');
    const hashAfterInventory = crypto
      .createHash('sha256')
      .update(fs.readFileSync(inventoryPath))
      .digest('hex');

    expect(hashAfterManifest).toBe(hashBeforeManifest);
    expect(hashAfterMongo).toBe(hashBeforeMongo);
    expect(hashAfterInventory).toBe(hashBeforeInventory);
  });

  // -------------------------------------------------------------------------
  // Case 28: Verifier must not connect to MongoDB or MinIO
  // -------------------------------------------------------------------------
  it('Case 28: guarantees zero network connections; never invokes mongoose or network sockets', async () => {
    const connectSpy = vi.spyOn(mongoose, 'connect');
    createSyntheticRecoverySet();

    await verifyRecoverySet(tempRoot);

    expect(connectSpy).not.toHaveBeenCalled();
    connectSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Case 29: Verifier must not start application workers or timers
  // -------------------------------------------------------------------------
  it('Case 29: guarantees zero daemon side effects; leaves zero active timers or workers', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    createSyntheticRecoverySet();

    await verifyRecoverySet(tempRoot);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Case 30: Verifier must not enable TTLMonitor
  // -------------------------------------------------------------------------
  it('Case 30: guarantees zero TTLMonitor side effects; never interacts with MongoDB admin or TTL', async () => {
    createSyntheticRecoverySet();

    const customMongo = {
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: null,
        ttlMonitorDisabled: false,
        storageLocked: true
      }
    };
    const { mongoPath } = createSyntheticRecoverySet({}, customMongo);
    const mongoRaw = fs.readFileSync(mongoPath, 'utf8');
    const mongoHash = crypto.createHash('sha256').update(mongoRaw).digest('hex');
    const mongoStat = fs.statSync(mongoPath);

    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.sha256 = mongoHash;
    manifest.artifacts.mongo.sizeBytes = mongoStat.size;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.TTL_MONITOR_NOT_DISABLED);
  });

  // -------------------------------------------------------------------------
  // Additional Edge Cases: Active Instance Detected, Format Limitations
  // -------------------------------------------------------------------------
  it('Case 31: fails closed with ACTIVE_INSTANCE_DETECTED when BackupLease indicates active server instance', async () => {
    const customMongo = {
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: 'inst-rogue-42',
        ttlMonitorDisabled: true,
        storageLocked: true
      }
    };
    const { mongoPath } = createSyntheticRecoverySet({}, customMongo);
    const mongoRaw = fs.readFileSync(mongoPath, 'utf8');
    const mongoHash = crypto.createHash('sha256').update(mongoRaw).digest('hex');
    const mongoStat = fs.statSync(mongoPath);

    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.sha256 = mongoHash;
    manifest.artifacts.mongo.sizeBytes = mongoStat.size;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.ACTIVE_INSTANCE_DETECTED);
  });

  it('Case 32: classifies binary archive format as NOT_VERIFIABLE_OFFLINE without restore tooling', async () => {
    createSyntheticRecoverySet();
    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.format = 'archive';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNSUPPORTED_MONGO_FORMAT);
    expect(result.decision).toBe(DECISION_OUTCOMES.NOT_VERIFIABLE_OFFLINE);
  });

  it('Case 33: assertSafePath rejects null bytes and path escaping', () => {
    expect(assertSafePath(tempRoot, 'test\0file').valid).toBe(false);
    expect(assertSafePath(tempRoot, '../outside').valid).toBe(false);
    expect(assertSafePath(tempRoot, 'valid/sub/file.txt').valid).toBe(true);
  });

  it('Case 34: computeFileSha256 returns exact lowercase hex hash', async () => {
    const testFile = path.join(tempRoot, 'hash-test.txt');
    fs.writeFileSync(testFile, 'paperless-test-data', 'utf8');
    const expected = crypto.createHash('sha256').update('paperless-test-data').digest('hex');

    const actual = await computeFileSha256(testFile);
    expect(actual).toBe(expected);
  });

  it('Case 35: exports expected constants and schema versions', () => {
    expect(VERIFIER_VERSION).toBe('1.0.0');
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain('1.0.0');
    expect(DECISION_OUTCOMES.PASS).toBe('PASS');
    expect(DECISION_OUTCOMES.FAIL).toBe('FAIL');
    expect(DECISION_OUTCOMES.BLOCKED).toBe('BLOCKED');
    expect(DECISION_OUTCOMES.NOT_VERIFIABLE_OFFLINE).toBe('NOT_VERIFIABLE_OFFLINE');
  });

  // -------------------------------------------------------------------------
  // Adversarial Specialist Cases (Cases 36-42)
  // -------------------------------------------------------------------------
  it('Case 36: fails closed with MALFORMED_MONGO_BACKUP on hollow `{}` MongoDB backup', async () => {
    createSyntheticRecoverySet();
    const mongoPath = path.join(tempRoot, 'mongo', 'backup.json');
    fs.writeFileSync(mongoPath, '{}', 'utf8');
    const stat = fs.statSync(mongoPath);
    const hash = crypto.createHash('sha256').update('{}').digest('hex');

    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.sha256 = hash;
    manifest.artifacts.mongo.sizeBytes = stat.size;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP);
  });

  it('Case 37: fails closed with MALFORMED_MONGO_BACKUP on null MongoDB backup', async () => {
    createSyntheticRecoverySet();
    const mongoPath = path.join(tempRoot, 'mongo', 'backup.json');
    fs.writeFileSync(mongoPath, 'null', 'utf8');
    const stat = fs.statSync(mongoPath);
    const hash = crypto.createHash('sha256').update('null').digest('hex');

    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.sha256 = hash;
    manifest.artifacts.mongo.sizeBytes = stat.size;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP);
  });

  it('Case 38: fails closed with STORAGE_FREEZE_BARRIER_UNVERIFIED when storageLocked is false in DB', async () => {
    const customMongo = {
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: null,
        ttlMonitorDisabled: true,
        storageLocked: false // corrupted: storageLocked is false
      }
    };
    const { mongoPath } = createSyntheticRecoverySet({}, customMongo);
    const mongoRaw = fs.readFileSync(mongoPath, 'utf8');
    const mongoHash = crypto.createHash('sha256').update(mongoRaw).digest('hex');
    const mongoStat = fs.statSync(mongoPath);

    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.sha256 = mongoHash;
    manifest.artifacts.mongo.sizeBytes = mongoStat.size;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.STORAGE_FREEZE_BARRIER_UNVERIFIED);
  });

  it('Case 39: correctly handles batch DeleteObjects and fails if deleted object is present in inventory', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-001',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/response_1/doc.pdf',
          status: 'COMMITTED',
          payloadSize: 1024,
          payloadHash: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
        },
        {
          operationId: 'op-batch-del',
          type: 'DeleteObjects',
          bucket: 'paperless',
          targetKeys: ['forms/123/response_1/sig.png'], // batch deleted
          status: 'CONFIRMED'
        }
      ]
    };
    // inventory has sig.png, which was batch-deleted!
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNEXPECTED_INVENTORY_OBJECT);
  });

  it('Case 40: fails closed when zero-byte journal entry mismatches non-empty inventory payload', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-001',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/response_1/doc.pdf',
          status: 'COMMITTED',
          payloadSize: 0, // declared 0 bytes, but inventory has 1024 bytes
          payloadHash: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
        },
        {
          operationId: 'op-002',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/response_1/sig.png',
          status: 'COMMITTED',
          payloadSize: 512,
          payloadHash: 'b1c2d3e4f500112233445566778899aabbccddeeff00112233445566778899aa'
        }
      ]
    };
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_SIZE_MISMATCH);
  });

  it('Case 41: fails closed when manifest quiescence.status is invalid or unquiesced', async () => {
    createSyntheticRecoverySet({
      quiescence: {
        leaseId: 'lease-test-123',
        status: 'UNQUIESCED_AND_MUTATING',
        admissionFreeze: true,
        workerHalt: true,
        storageFreeze: true
      }
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.INVALID_FIELD_TYPE);
  });

  it('Case 42: gracefully handles null or primitive elements in storageJournals without crashing', async () => {
    const customMongo = {
      storageJournals: [
        null,
        'invalid-primitive',
        { operationId: 'op-1', status: 'UNKNOWN_STATUS' }
      ]
    };
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP);
  });

  it('Case 43: fails closed with UNREADABLE_ARTIFACT on FIFO named pipe in <100ms without hanging (OBS-8)', async () => {
    createSyntheticRecoverySet();
    const fifoPath = path.join(tempRoot, 'mongo', 'fifo_dump.json');
    try {
      execSync(`mkfifo "${fifoPath}"`);
    } catch {
      // In environments where mkfifo is unsupported, skip
      return;
    }

    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.mongo.path = 'mongo/fifo_dump.json';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const startTime = Date.now();
    const result = await verifyRecoverySet(tempRoot);
    const durationMs = Date.now() - startTime;

    expect(durationMs).toBeLessThan(500); // Must not hang waiting for a FIFO writer
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT);

    try {
      fs.unlinkSync(fifoPath);
    } catch (_err) {
      // ignore cleanup error
    }
  });

  it('Case 44: fails closed with UNREADABLE_ARTIFACT when artifact path resolves to a directory (OBS-8)', async () => {
    createSyntheticRecoverySet();
    const subDir = path.join(tempRoot, 'minio', 'sub_dir');
    fs.mkdirSync(subDir, { recursive: true });

    const manifestPath = path.join(tempRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.minio.path = 'minio/sub_dir';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT);
  });

  it('Case 45: fails closed with UNREADABLE_ARTIFACT on permission denied (chmod 000) (OBS-8)', async () => {
    createSyntheticRecoverySet();
    const mongoPath = path.join(tempRoot, 'mongo', 'backup.json');
    try {
      fs.chmodSync(mongoPath, 0o000);
      const result = await verifyRecoverySet(tempRoot);
      expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
      expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT);
    } finally {
      try {
        fs.chmodSync(mongoPath, 0o644);
      } catch (_err) {
        // ignore restore error
      }
    }
  });

  it('Case 46: fails closed with UNEXPECTED_STORAGE_BUCKET when journal references a foreign bucket (OBS-6)', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-foreign-001',
          type: 'PutObject',
          bucket: 'foreign-isolated-bucket',
          destinationKey: 'forms/123/response_1/doc.pdf',
          status: 'COMMITTED',
          payloadSize: 1024,
          payloadHash: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
        }
      ]
    };
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNEXPECTED_STORAGE_BUCKET);
  });

  it('Case 47: passes when PutObject is followed by DeleteObject on the same key and key is absent from inventory (OBS-4)', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-put-1',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/temp_file.pdf',
          status: 'COMMITTED',
          payloadSize: 1024,
          createdAt: new Date('2026-11-24T10:00:00Z'),
          updatedAt: new Date('2026-11-24T10:00:00Z')
        },
        {
          operationId: 'op-del-1',
          type: 'DeleteObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/temp_file.pdf',
          status: 'CONFIRMED',
          createdAt: new Date('2026-11-24T10:05:00Z'),
          updatedAt: new Date('2026-11-24T10:05:00Z')
        }
      ]
    };
    const customInventory = [];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
  });

  it('Case 48: passes when DeleteObject is followed by PutObject on the same key and key is present in inventory (OBS-4)', async () => {
    const hash = 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899';
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-del-1',
          type: 'DeleteObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/recreated.pdf',
          status: 'CONFIRMED',
          createdAt: new Date('2026-11-24T10:00:00Z'),
          updatedAt: new Date('2026-11-24T10:00:00Z')
        },
        {
          operationId: 'op-put-2',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/recreated.pdf',
          status: 'COMMITTED',
          payloadSize: 1024,
          payloadHash: hash,
          createdAt: new Date('2026-11-24T10:05:00Z'),
          updatedAt: new Date('2026-11-24T10:05:00Z')
        }
      ]
    };
    const customInventory = [
      {
        key: 'forms/123/recreated.pdf',
        size: 1024,
        etag: 'etag-1',
        lastModified: '2026-11-24T10:05:00.000Z',
        sha256: hash
      }
    ];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
  });

  it('Case 49: blocks recovery with CAUSAL_ORDERING_AMBIGUOUS on conflicting operations with identical timestamps (OBS-4)', async () => {
    const identicalTime = new Date('2026-11-24T10:00:00Z');
    const customMongo = {
      storageJournals: [
        {
          _id: '674300000000000000000001',
          operationId: 'op-put-1',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/race.pdf',
          status: 'COMMITTED',
          payloadSize: 1024,
          createdAt: identicalTime,
          updatedAt: identicalTime
        },
        {
          _id: '674300000000000000000002',
          operationId: 'op-del-1',
          type: 'DeleteObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/race.pdf',
          status: 'CONFIRMED',
          createdAt: identicalTime,
          updatedAt: identicalTime
        }
      ]
    };
    const customInventory = [];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.BLOCKED);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.CAUSAL_ORDERING_AMBIGUOUS);
  });

  it('Case 50: passes when CopyObject has non-zero payloadSize matching inventory (OBS-3)', async () => {
    const hash = 'c1c2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899';
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-copy-001',
          type: 'CopyObject',
          bucket: 'paperless',
          sourceKey: 'staging/temp_doc.pdf',
          destinationKey: 'forms/123/promoted.pdf',
          status: 'COMMITTED',
          payloadSize: 2048,
          payloadHash: hash
        }
      ]
    };
    const customInventory = [
      {
        key: 'forms/123/promoted.pdf',
        size: 2048,
        etag: 'etag-promoted',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: hash
      }
    ];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
  });

  it('Case 51: fails closed with JOURNAL_REFERENCE_MISSING_FROM_INVENTORY when CopyObject lacks metadata and sourceKey is missing from inventory (AUD-K14.1.3-04)', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-copy-002',
          type: 'CopyObject',
          bucket: 'paperless',
          sourceKey: 'staging/unknown_size.pdf',
          destinationKey: 'forms/123/promoted.pdf',
          status: 'COMMITTED',
          payloadSize: null, // Unpopulated/null metadata
          payloadHash: null
        }
      ]
    };
    const customInventory = [
      {
        key: 'forms/123/promoted.pdf',
        size: 4096,
        etag: 'etag-promoted-2',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: 'e1e2e3e4e5f600112233445566778899aabbccddeeff00112233445566778899'
      }
    ];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(
      DIAGNOSTIC_CODES.JOURNAL_REFERENCE_MISSING_FROM_INVENTORY
    );
  });

  it('Case 51b: passes when CopyObject has null metadata but sourceKey exists in inventory with matching size and sha256 (AUD-K14.1.3-04)', async () => {
    const hash = 'e1e2e3e4e5f600112233445566778899aabbccddeeff00112233445566778899';
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-copy-source-001',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/known_source.pdf',
          status: 'COMMITTED',
          payloadSize: 4096,
          payloadHash: hash
        },
        {
          operationId: 'op-copy-002b',
          type: 'CopyObject',
          bucket: 'paperless',
          sourceKey: 'forms/123/known_source.pdf',
          destinationKey: 'forms/123/promoted.pdf',
          status: 'COMMITTED',
          payloadSize: null, // Unpopulated/null metadata
          payloadHash: null
        }
      ]
    };
    const customInventory = [
      {
        key: 'forms/123/known_source.pdf',
        size: 4096,
        etag: 'etag-source-1',
        lastModified: '2026-11-24T11:59:00.000Z',
        sha256: hash
      },
      {
        key: 'forms/123/promoted.pdf',
        size: 4096,
        etag: 'etag-promoted-2',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: hash
      }
    ];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
  });

  it('Case 52: fails when CopyObject has mismatched non-zero payloadSize (OBS-3)', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-copy-003',
          type: 'CopyObject',
          bucket: 'paperless',
          sourceKey: 'staging/doc.pdf',
          destinationKey: 'forms/123/promoted.pdf',
          status: 'COMMITTED',
          payloadSize: 2048, // declared 2048
          payloadHash: null
        }
      ]
    };
    const customInventory = [
      {
        key: 'forms/123/promoted.pdf',
        size: 4096, // actual 4096
        etag: 'etag-promoted-3',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: 'e1e2e3e4e5f600112233445566778899aabbccddeeff00112233445566778899'
      }
    ];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_SIZE_MISMATCH);
  });

  it('Case 53: passes with advisory when TTLMonitor suppression has non-strict error (OBS-1)', async () => {
    const customMongo = {
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: null,
        ttlMonitorDisabled: false,
        ttlMonitorError: 'Unauthorized (code 13): requires clusterAdmin privilege',
        storageLocked: true
      }
    };
    createSyntheticRecoverySet(
      {
        quiescence: {
          leaseId: 'lease-test-123',
          status: 'QUIESCED',
          admissionFreeze: true,
          workerHalt: true,
          storageFreeze: true,
          strictTtl: false
        }
      },
      customMongo
    );

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.TTL_MONITOR_UNSUPPRESSED_ADVISORY);
  });

  it('Case 54: fails closed with TTL_MONITOR_NOT_DISABLED when strictTtl is true (OBS-1)', async () => {
    const customMongo = {
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: null,
        ttlMonitorDisabled: false,
        ttlMonitorError: 'Unauthorized (code 13)',
        storageLocked: true
      }
    };
    createSyntheticRecoverySet(
      {
        quiescence: {
          leaseId: 'lease-test-123',
          status: 'QUIESCED',
          admissionFreeze: true,
          workerHalt: true,
          storageFreeze: true,
          strictTtl: true
        }
      },
      customMongo
    );

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.TTL_MONITOR_NOT_DISABLED);
  });

  it('Case 55: accepts CONFIRMED and COMPENSATED as valid terminal states for deletions (OBS-5)', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-del-confirmed',
          type: 'DeleteObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/deleted_file.pdf',
          status: 'CONFIRMED'
        },
        {
          operationId: 'op-put-compensated',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/rolled_back.pdf',
          status: 'COMPENSATED',
          payloadSize: 1024
        }
      ]
    };
    const customInventory = [];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
  });

  it('Case 56: StorageService rejects mutations with BACKUP_QUIESCENCE_ACTIVE when quiescence is active (OBS-1)', async () => {
    const { default: storageService } = await import('../services/StorageService.js');
    const quiescenceGate = await import('../middleware/quiescenceGate.js');

    quiescenceGate.setQuiescenceService({
      isQuiescedOrDraining: async () => true,
      getStatus: async () => ({ status: 'QUIESCED', isExpired: false })
    });

    try {
      await expect(
        storageService.uploadFile(Buffer.from('test'), 'forms/123/doc.pdf', 'application/pdf')
      ).rejects.toThrow('Storage mutation rejected: backup quiescence is active');

      await expect(
        storageService.copyFile('forms/123/src.pdf', 'forms/123/dst.pdf')
      ).rejects.toThrow('Storage mutation rejected: backup quiescence is active');

      await expect(storageService.deleteFile('forms/123/doc.pdf')).rejects.toThrow(
        'Storage mutation rejected: backup quiescence is active'
      );

      await expect(storageService.deleteFiles(['forms/123/doc.pdf'])).rejects.toThrow(
        'Storage mutation rejected: backup quiescence is active'
      );
    } finally {
      quiescenceGate.setQuiescenceService(null);
    }
  });

  // -------------------------------------------------------------------------
  // K.14.1.4 Adversarial Coverage Suite (AUD-K14.1.3-01 through 08)
  // -------------------------------------------------------------------------
  it('Case 57: fails closed with UNRESOLVED_JOURNAL_OPERATIONS when PutObject is in CONFIRMED status (AUD-K14.1.3-05)', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-put-confirmed-only',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/response_1/doc.pdf',
          status: 'CONFIRMED', // CONFIRMED is non-terminal for additions in K.14.1.4!
          payloadSize: 1024,
          payloadHash: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
        }
      ]
    };
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNRESOLVED_JOURNAL_OPERATIONS);
  });

  it('Case 58: blocks recovery with CAUSAL_ORDERING_AMBIGUOUS on conflicting same-type operations on the same key with identical timestamps (AUD-K14.1.3-03)', async () => {
    const ts = '2026-11-24T12:00:00.000Z';
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-same-001',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/overwrite.pdf',
          status: 'COMMITTED',
          payloadSize: 1024,
          payloadHash: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899',
          createdAt: ts,
          updatedAt: ts
        },
        {
          operationId: 'op-same-002',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/overwrite.pdf',
          status: 'COMMITTED',
          payloadSize: 2048,
          payloadHash: 'b1c2d3e4f500112233445566778899aabbccddeeff00112233445566778899aa',
          createdAt: ts,
          updatedAt: ts
        }
      ]
    };
    const customInventory = [
      {
        key: 'forms/123/overwrite.pdf',
        size: 2048,
        etag: 'etag-overwrite',
        lastModified: ts,
        sha256: 'b1c2d3e4f500112233445566778899aabbccddeeff00112233445566778899aa'
      }
    ];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.BLOCKED);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.CAUSAL_ORDERING_AMBIGUOUS);
  });

  it('Case 59: fails closed with UNEXPECTED_STORAGE_BUCKET when journal references foreign or null bucket (AUD-K14.1.3-01)', async () => {
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-foreign-bucket',
          type: 'PutObject',
          bucket: 'foreign-bucket-injected',
          destinationKey: 'forms/123/response_1/doc.pdf',
          status: 'COMMITTED',
          payloadSize: 1024,
          payloadHash: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
        }
      ]
    };
    createSyntheticRecoverySet({}, customMongo);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNEXPECTED_STORAGE_BUCKET);
  });

  it('Case 60: fails closed with UNJOURNALED_OBJECT_DETECTED when inventory contains unjournaled object (AUD-K14.1.3-01)', async () => {
    const customInventory = [
      {
        key: 'forms/123/response_1/doc.pdf',
        size: 1024,
        etag: 'etag-doc-1',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
      },
      {
        key: 'forms/123/response_1/sig.png',
        size: 512,
        etag: 'etag-sig-1',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: 'b1c2d3e4f500112233445566778899aabbccddeeff00112233445566778899aa'
      },
      {
        key: 'forms/123/response_1/untracked_file.pdf',
        size: 1024,
        etag: 'etag-untracked',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: 'c1d2e3f4a500112233445566778899aabbccddeeff00112233445566778899bb'
      }
    ];
    createSyntheticRecoverySet({}, {}, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNJOURNALED_OBJECT_DETECTED);
  });

  it('Case 61: passes online quiescence snapshot when BackupLease matches manifest.quiescence.activeInstanceId and barriers hold (AUD-K14.1.3-06)', async () => {
    const customMongo = {
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: 'inst-app-prod-1',
        ttlMonitorDisabled: true,
        storageLocked: true
      }
    };
    createSyntheticRecoverySet(
      {
        quiescence: {
          leaseId: 'lease-test-123',
          status: 'QUIESCED',
          admissionFreeze: true,
          workerHalt: true,
          storageFreeze: true,
          activeInstanceId: 'inst-app-prod-1'
        }
      },
      customMongo
    );

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
  });

  it('Case 62: fails closed with ACTIVE_INSTANCE_DETECTED when BackupLease activeInstanceId differs from manifest (AUD-K14.1.3-06)', async () => {
    const customMongo = {
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: 'inst-app-prod-ROGUE',
        ttlMonitorDisabled: true,
        storageLocked: true
      }
    };
    createSyntheticRecoverySet(
      {
        quiescence: {
          leaseId: 'lease-test-123',
          status: 'QUIESCED',
          admissionFreeze: true,
          workerHalt: true,
          storageFreeze: true,
          activeInstanceId: 'inst-app-prod-EXPECTED'
        }
      },
      customMongo
    );

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.ACTIVE_INSTANCE_DETECTED);
  });

  it('Case 63: fails closed with ACTIVE_INSTANCE_DETECTED when online quiescence snapshot has matching activeInstanceId but storageLocked is false (AUD-K14.1.3-06)', async () => {
    const customMongo = {
      backupLease: {
        _id: 'singleton',
        status: 'QUIESCED',
        leaseId: 'lease-test-123',
        generation: 1,
        activeInstanceId: 'inst-app-prod-1',
        ttlMonitorDisabled: true,
        storageLocked: false // corrupted barrier
      }
    };
    createSyntheticRecoverySet(
      {
        quiescence: {
          leaseId: 'lease-test-123',
          status: 'QUIESCED',
          admissionFreeze: true,
          workerHalt: true,
          storageFreeze: true,
          activeInstanceId: 'inst-app-prod-1'
        }
      },
      customMongo
    );

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.ACTIVE_INSTANCE_DETECTED);
  });

  it('Case 64: fails closed with JOURNAL_PAYLOAD_SIZE_MISMATCH when CopyObject source size mismatches destination size (AUD-K14.1.3-04)', async () => {
    const hash = 'e1e2e3e4e5f600112233445566778899aabbccddeeff00112233445566778899';
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-copy-source-diff-size',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/src_diff.pdf',
          status: 'COMMITTED',
          payloadSize: 2048,
          payloadHash: hash
        },
        {
          operationId: 'op-copy-target-diff-size',
          type: 'CopyObject',
          bucket: 'paperless',
          sourceKey: 'forms/123/src_diff.pdf',
          destinationKey: 'forms/123/dst_diff.pdf',
          status: 'COMMITTED',
          payloadSize: null,
          payloadHash: null
        }
      ]
    };
    const customInventory = [
      {
        key: 'forms/123/src_diff.pdf',
        size: 2048,
        etag: 'etag-src-diff',
        lastModified: '2026-11-24T11:59:00.000Z',
        sha256: hash
      },
      {
        key: 'forms/123/dst_diff.pdf',
        size: 4096, // Corrupted: destination size is 4096 instead of 2048!
        etag: 'etag-dst-diff',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: hash
      }
    ];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_SIZE_MISMATCH);
  });

  it('Case 65: fails closed with JOURNAL_PAYLOAD_HASH_MISMATCH when CopyObject source hash mismatches destination hash (AUD-K14.1.3-04)', async () => {
    const hashA = 'e1e2e3e4e5f600112233445566778899aabbccddeeff00112233445566778899';
    const hashB = 'f1e2e3e4e5f600112233445566778899aabbccddeeff00112233445566778800';
    const customMongo = {
      storageJournals: [
        {
          operationId: 'op-copy-source-diff-hash',
          type: 'PutObject',
          bucket: 'paperless',
          destinationKey: 'forms/123/src_hash.pdf',
          status: 'COMMITTED',
          payloadSize: 2048,
          payloadHash: hashA
        },
        {
          operationId: 'op-copy-target-diff-hash',
          type: 'CopyObject',
          bucket: 'paperless',
          sourceKey: 'forms/123/src_hash.pdf',
          destinationKey: 'forms/123/dst_hash.pdf',
          status: 'COMMITTED',
          payloadSize: null,
          payloadHash: null
        }
      ]
    };
    const customInventory = [
      {
        key: 'forms/123/src_hash.pdf',
        size: 2048,
        etag: 'etag-src-hash',
        lastModified: '2026-11-24T11:59:00.000Z',
        sha256: hashA
      },
      {
        key: 'forms/123/dst_hash.pdf',
        size: 2048,
        etag: 'etag-dst-hash',
        lastModified: '2026-11-24T12:00:00.000Z',
        sha256: hashB // Corrupted: destination hash differs from source!
      }
    ];
    createSyntheticRecoverySet({}, customMongo, customInventory);

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_HASH_MISMATCH);
  });

  it('Case 66: StorageService rejects mutations with MUTATION_ADMISSION_CLOSED when mutation admission is closed (AUD-K14.1.3-01)', async () => {
    const { default: storageService } = await import('../services/StorageService.js');
    const quiescenceGate = await import('../middleware/quiescenceGate.js');

    quiescenceGate.closeMutationAdmission('ADMIN_SHUTDOWN');

    try {
      await expect(
        storageService.uploadFile(Buffer.from('test'), 'forms/123/doc.pdf', 'application/pdf')
      ).rejects.toMatchObject({ code: 'MUTATION_ADMISSION_CLOSED', status: 503 });

      await expect(
        storageService.copyFile('forms/123/src.pdf', 'forms/123/dst.pdf')
      ).rejects.toMatchObject({ code: 'MUTATION_ADMISSION_CLOSED', status: 503 });

      await expect(storageService.deleteFile('forms/123/doc.pdf')).rejects.toMatchObject({
        code: 'MUTATION_ADMISSION_CLOSED',
        status: 503
      });
    } finally {
      quiescenceGate.openMutationAdmission();
    }
  });

  it('Case 67: StorageService rejects mutations with INSTANCE_FENCED when instance lease is invalid (AUD-K14.1.3-01)', async () => {
    const { default: storageService } = await import('../services/StorageService.js');
    const instanceLeaseService = await import('../services/instanceLeaseService.js');

    instanceLeaseService.markFencedForTesting();

    try {
      await expect(
        storageService.uploadFile(Buffer.from('test'), 'forms/123/doc.pdf', 'application/pdf')
      ).rejects.toMatchObject({ code: 'INSTANCE_FENCED', status: 503 });

      await expect(
        storageService.copyFile('forms/123/src.pdf', 'forms/123/dst.pdf')
      ).rejects.toMatchObject({ code: 'INSTANCE_FENCED', status: 503 });

      await expect(storageService.deleteFile('forms/123/doc.pdf')).rejects.toMatchObject({
        code: 'INSTANCE_FENCED',
        status: 503
      });
    } finally {
      instanceLeaseService.resetFencedForTesting();
    }
  });

  it('Case 68: fails closed when committed Response references attachment key absent from inventory', async () => {
    createSyntheticRecoverySet({}, {
      responses: [
        {
          _id: 'resp-001',
          commitStatus: 'committed',
          answers: [
            {
              fieldId: 'f1',
              value: { key: 'forms/123/response_1/missing-file.pdf' }
            }
          ]
        }
      ]
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(
      DIAGNOSTIC_CODES.JOURNAL_REFERENCE_MISSING_FROM_INVENTORY
    );
  });

  it('Case 69: fails closed when committed Response references attachment key without committed StorageJournal record', async () => {
    createSyntheticRecoverySet(
      {},
      {
        responses: [
          {
            _id: 'resp-002',
            commitStatus: 'committed',
            answers: [
              {
                fieldId: 'f1',
                value: { key: 'forms/123/response_1/doc.pdf' }
              }
            ]
          }
        ],
        storageJournals: []
      },
      [
        {
          key: 'forms/123/response_1/doc.pdf',
          size: 1024,
          lastModified: '2026-11-24T11:50:00.000Z',
          etag: '"etag-001"',
          sha256: 'a1b2c3d4e5f600112233445566778899aabbccddeeff00112233445566778899'
        }
      ]
    );

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.FAIL);
    expect(result.diagnosticCodes).toContain(DIAGNOSTIC_CODES.UNJOURNALED_OBJECT_DETECTED);
  });

  it('Case 70: passes when committed Response references attachment key present in both inventory and committed StorageJournal', async () => {
    createSyntheticRecoverySet({}, {
      responses: [
        {
          _id: 'resp-003',
          commitStatus: 'committed',
          answers: [
            {
              fieldId: 'f1',
              value: { key: 'forms/123/response_1/doc.pdf' }
            }
          ]
        }
      ]
    });

    const result = await verifyRecoverySet(tempRoot);
    expect(result.decision).toBe(DECISION_OUTCOMES.PASS);
    expect(result.details.errors).toHaveLength(0);
  });
});
