/**
 * Paperless Phase 2D.1K.14.1 — Offline Recovery Verifier
 *
 * Implements a strictly offline, read-only recovery verifier that evaluates
 * whether a supplied MongoDB/MinIO recovery set is internally consistent,
 * structurally valid, cryptographically intact, and safe to admit into service.
 *
 * CRITICAL SAFETY INVARIANTS:
 * 1. Zero network I/O: Never connects to MongoDB or MinIO.
 * 2. Zero process side effects: Never initializes application servers, background workers, or schedulers.
 * 3. Zero TTLMonitor side effects: Never starts or manipulates MongoDB TTLMonitor.
 * 4. Zero artifact mutation: All files inspected read-only; no modifications, renames, or deletions.
 * 5. Strictly fail-closed: Missing, ambiguous, or unverifiable properties fail closed.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const VERIFIER_VERSION = '1.0.0';
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(['1.0.0']);

export const DECISION_OUTCOMES = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_VERIFIABLE_OFFLINE: 'NOT_VERIFIABLE_OFFLINE'
});

export const DIAGNOSTIC_CODES = Object.freeze({
  // Stage A: Input & Manifest
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  ROOT_NOT_DIRECTORY: 'ROOT_NOT_DIRECTORY',
  MISSING_MANIFEST: 'MISSING_MANIFEST',
  INVALID_MANIFEST_JSON: 'INVALID_MANIFEST_JSON',
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  UNKNOWN_CRITICAL_MANIFEST_FIELD: 'UNKNOWN_CRITICAL_MANIFEST_FIELD',
  MISSING_MANDATORY_FIELD: 'MISSING_MANDATORY_FIELD',
  INVALID_FIELD_TYPE: 'INVALID_FIELD_TYPE',
  PATH_TRAVERSAL_DETECTED: 'PATH_TRAVERSAL_DETECTED',
  SYMLINK_ESCAPE_DETECTED: 'SYMLINK_ESCAPE_DETECTED',
  INPUT_SIZE_EXCEEDED: 'INPUT_SIZE_EXCEEDED',

  // Stage B: Artifact Integrity
  MISSING_ARTIFACT_FILE: 'MISSING_ARTIFACT_FILE',
  UNREADABLE_ARTIFACT: 'UNREADABLE_ARTIFACT',
  ARTIFACT_SIZE_MISMATCH: 'ARTIFACT_SIZE_MISMATCH',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',

  // Stage C: MongoDB Recovery Metadata
  MALFORMED_MONGO_BACKUP: 'MALFORMED_MONGO_BACKUP',
  UNSUPPORTED_MONGO_FORMAT: 'UNSUPPORTED_MONGO_FORMAT',
  LEASE_STATUS_NOT_QUIESCED: 'LEASE_STATUS_NOT_QUIESCED',
  LEASE_ID_MISMATCH: 'LEASE_ID_MISMATCH',
  LEASE_GENERATION_MISMATCH: 'LEASE_GENERATION_MISMATCH',
  ACTIVE_INSTANCE_DETECTED: 'ACTIVE_INSTANCE_DETECTED',
  TTL_MONITOR_NOT_DISABLED: 'TTL_MONITOR_NOT_DISABLED',
  TTL_MONITOR_UNSUPPRESSED_ADVISORY: 'TTL_MONITOR_UNSUPPRESSED_ADVISORY',
  STORAGE_FREEZE_BARRIER_UNVERIFIED: 'STORAGE_FREEZE_BARRIER_UNVERIFIED',
  UNRESOLVED_JOURNAL_OPERATIONS: 'UNRESOLVED_JOURNAL_OPERATIONS',

  // Stage D: MinIO Object Inventory Metadata
  MALFORMED_INVENTORY: 'MALFORMED_INVENTORY',
  DUPLICATE_OBJECT_KEY: 'DUPLICATE_OBJECT_KEY',
  INVALID_OBJECT_ENTRY: 'INVALID_OBJECT_ENTRY',
  INVENTORY_COUNT_MISMATCH: 'INVENTORY_COUNT_MISMATCH',
  INVENTORY_SIZE_MISMATCH: 'INVENTORY_SIZE_MISMATCH',
  JOURNAL_REFERENCE_MISSING_FROM_INVENTORY: 'JOURNAL_REFERENCE_MISSING_FROM_INVENTORY',
  JOURNAL_PAYLOAD_SIZE_MISMATCH: 'JOURNAL_PAYLOAD_SIZE_MISMATCH',
  JOURNAL_PAYLOAD_HASH_MISMATCH: 'JOURNAL_PAYLOAD_HASH_MISMATCH',
  UNEXPECTED_INVENTORY_OBJECT: 'UNEXPECTED_INVENTORY_OBJECT',
  UNJOURNALED_OBJECT_DETECTED: 'UNJOURNALED_OBJECT_DETECTED',
  CAUSAL_ORDERING_AMBIGUOUS: 'CAUSAL_ORDERING_AMBIGUOUS',
  UNEXPECTED_STORAGE_BUCKET: 'UNEXPECTED_STORAGE_BUCKET',

  // Stage E: Cross-Store Consistency & Protocol Checks
  MISMATCHED_RECOVERY_SET_ID: 'MISMATCHED_RECOVERY_SET_ID',
  MISSING_RECOVERY_GENERATION_IDENTITY: 'MISSING_RECOVERY_GENERATION_IDENTITY',
  TIMESTAMP_ONLY_ORDERING_INSUFFICIENT: 'TIMESTAMP_ONLY_ORDERING_INSUFFICIENT',
  INVALID_CAPTURE_ORDER: 'INVALID_CAPTURE_ORDER',
  MISSING_ADMISSION_FREEZE_EVIDENCE: 'MISSING_ADMISSION_FREEZE_EVIDENCE',
  MISSING_WORKER_HALT_EVIDENCE: 'MISSING_WORKER_HALT_EVIDENCE',
  MISSING_STORAGE_FREEZE_EVIDENCE: 'MISSING_STORAGE_FREEZE_EVIDENCE',
  LATE_OPERATION_UNCERTAINTY: 'LATE_OPERATION_UNCERTAINTY',
  CROSS_STORE_GENERATION_UNVERIFIABLE: 'CROSS_STORE_GENERATION_UNVERIFIABLE',
  OFFLINE_LIMITATION_CROSS_STORE_ATOMICITY: 'OFFLINE_LIMITATION_CROSS_STORE_ATOMICITY'
});

export const RESOURCE_LIMITS = Object.freeze({
  MAX_MANIFEST_BYTES: 5 * 1024 * 1024, // 5 MB
  MAX_INVENTORY_BYTES: 100 * 1024 * 1024, // 100 MB
  MAX_MONGO_BYTES: 100 * 1024 * 1024, // 100 MB
  MAX_ERRORS_PER_STAGE: 50 // Anti-DoS bounded error collection
});

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'recoverySetId',
  'createdAt',
  'capturedBy',
  'verifierVersion',
  'storage',
  'artifacts',
  'quiescence',
  'captureProtocol',
  'unresolvedLateOperationsDeclared'
]);

const ALLOWED_MONGO_FORMATS = new Set(['json', 'bson', 'archive']);
const ALLOWED_QUIESCENCE_STATUSES = new Set(['QUIESCED', 'DRAINED']);
const VALID_ADDITION_TERMINAL_STATUSES = new Set(['COMMITTED', 'COMPENSATED', 'ABANDONED']);
const VALID_DELETION_TERMINAL_STATUSES = new Set([
  'CONFIRMED',
  'COMMITTED',
  'COMPENSATED',
  'ABANDONED'
]);

/**
 * Validates that targetPath is contained strictly inside recoveryRoot and does not escape via traversal or symlinks.
 * Resolves full canonical realpath on intermediate path segments to eliminate directory symlink escapes.
 *
 * @param {string} recoveryRoot - Canonical absolute path to recovery set root
 * @param {string} relativePath - Relative path declared in manifest
 * @returns {{ valid: boolean, resolvedPath?: string, code?: string, error?: string }}
 */
export const assertSafePath = (recoveryRoot, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return {
      valid: false,
      code: DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
      error: 'Path must be a non-empty string'
    };
  }

  // Prevent null-byte injection
  if (relativePath.includes('\0')) {
    return {
      valid: false,
      code: DIAGNOSTIC_CODES.PATH_TRAVERSAL_DETECTED,
      error: 'Path contains null byte'
    };
  }

  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(recoveryRoot);
  } catch (rootErr) {
    if (rootErr.code === 'ENOENT') {
      canonicalRoot = path.resolve(recoveryRoot);
    } else {
      return {
        valid: false,
        code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
        error: `Cannot resolve recovery root: ${rootErr.message}`
      };
    }
  }

  const resolved = path.resolve(canonicalRoot, relativePath);

  // Path resolution lexical check
  if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) {
    return {
      valid: false,
      code: DIAGNOSTIC_CODES.PATH_TRAVERSAL_DETECTED,
      error: `Path escapes recovery set root: ${relativePath}`
    };
  }

  // Authoritative realpath and lstat check on disk to eliminate intermediate and leaf symlink escapes
  try {
    const real = fs.realpathSync(resolved);
    if (real !== canonicalRoot && !real.startsWith(canonicalRoot + path.sep)) {
      return {
        valid: false,
        code: DIAGNOSTIC_CODES.SYMLINK_ESCAPE_DETECTED,
        error: `Symlink target escapes recovery set root: ${relativePath} -> ${real}`
      };
    }

    // Reject all symbolic links for artifact leaves (defense-in-depth before openSync O_NOFOLLOW)
    const lstat = fs.lstatSync(resolved);
    if (lstat.isSymbolicLink()) {
      return {
        valid: false,
        code: DIAGNOSTIC_CODES.SYMLINK_ESCAPE_DETECTED,
        error: `Artifact path cannot be a symbolic link: ${relativePath}`
      };
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Path does not exist on disk yet; lexical check passed, openSync will authoritatively catch ENOENT
      return { valid: true, resolvedPath: resolved };
    }
    if (err.code === 'ELOOP') {
      return {
        valid: false,
        code: DIAGNOSTIC_CODES.SYMLINK_ESCAPE_DETECTED,
        error: `Symlink loop detected for path: ${relativePath}`
      };
    }
    return {
      valid: false,
      code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
      error: `Failed to resolve realpath for path: ${err.message}`
    };
  }

  return { valid: true, resolvedPath: resolved };
};

/**
 * Recomputes SHA-256 digest of a file safely using stream processing.
 *
 * @param {string} filePath
 * @returns {Promise<string>} 64-char lowercase hex digest
 */
export const computeFileSha256 = async (filePath) => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { flags: 'r' });

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', (err) => reject(err));
  });
};

/**
 * 7-Pillar File-Descriptor Architecture Reader (OBS-8).
 * Opens file descriptors safely using non-blocking, no-follow flags to prevent
 * process hangs on special files (e.g. FIFOs, UNIX sockets, character devices)
 * and verifies size and cryptographic integrity in a single pass without TOCTOU windows.
 *
 * @param {object} params
 * @param {string} params.canonicalRoot - Canonical recovery set root directory
 * @param {string} params.relativePath - Relative path declared in manifest
 * @param {number} params.maxBytes - Maximum permitted size limit
 * @param {number} [params.declaredSizeBytes] - Optional exact declared size in bytes
 * @param {string} [params.declaredSha256] - Optional expected SHA-256 hex digest
 * @param {string} [params.artifactName='artifact'] - Identifier for diagnostics
 * @returns {Promise<{
 *   success: boolean,
 *   buffer?: Buffer,
 *   stat?: fs.Stats,
 *   actualSha256?: string,
 *   resolvedPath?: string,
 *   code?: string,
 *   error?: string
 * }>}
 */
export const readArtifactFd = async ({
  canonicalRoot,
  relativePath,
  maxBytes,
  declaredSizeBytes,
  declaredSha256,
  artifactName = 'artifact'
}) => {
  const pathCheck = assertSafePath(canonicalRoot, relativePath);
  if (!pathCheck.valid) {
    return { success: false, code: pathCheck.code, error: pathCheck.error };
  }

  const resolvedPath = pathCheck.resolvedPath;

  // Redundant fs.existsSync removed: fs.openSync is the sole atomic gate.
  // Flags: O_RDONLY | O_NONBLOCK (no FIFO hang) | O_NOFOLLOW (reject leaf symlinks)
  const openFlags =
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  let fd;

  try {
    fd = fs.openSync(resolvedPath, openFlags);
  } catch (openErr) {
    if (openErr.code === 'ENOENT') {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.MISSING_ARTIFACT_FILE,
        error: `Artifact file missing for ${artifactName}: ${resolvedPath}`
      };
    }
    if (openErr.code === 'ELOOP') {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.SYMLINK_ESCAPE_DETECTED,
        error: `Symlink detected while opening ${artifactName} (O_NOFOLLOW): ${resolvedPath}`
      };
    }
    if (openErr.code === 'EACCES' || openErr.code === 'EPERM') {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
        error: `Permission denied opening ${artifactName}: ${openErr.message}`
      };
    }
    return {
      success: false,
      code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
      error: `Failed to open ${artifactName}: ${openErr.message}`
    };
  }

  try {
    const stat = fs.fstatSync(fd);

    // Reject non-regular files (FIFOs, sockets, directories, device nodes)
    if (!stat.isFile()) {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
        error: `${artifactName} is not a regular file (isFIFO=${stat.isFIFO()}, isDirectory=${stat.isDirectory()})`
      };
    }

    // Defensive check: non-negative safe integer size
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
        error: `${artifactName} has invalid descriptor size: ${stat.size}`
      };
    }

    // Size bounds checks
    if (stat.size > maxBytes) {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.INPUT_SIZE_EXCEEDED,
        error: `${artifactName} exceeds maximum size limit of ${maxBytes} bytes`
      };
    }

    if (declaredSizeBytes !== undefined && stat.size !== declaredSizeBytes) {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.ARTIFACT_SIZE_MISMATCH,
        error: `${artifactName} size mismatch: observed ${stat.size} bytes, declared ${declaredSizeBytes} bytes`
      };
    }

    // Single-pass pinned read into Buffer
    const buffer = Buffer.alloc(stat.size);
    let totalBytesRead = 0;
    while (totalBytesRead < stat.size) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        totalBytesRead,
        stat.size - totalBytesRead,
        totalBytesRead
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }

    if (totalBytesRead !== stat.size) {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
        error: `${artifactName} incomplete read: expected ${stat.size} bytes, read ${totalBytesRead} bytes`
      };
    }

    // Detect concurrent file size change during read
    const postStat = fs.fstatSync(fd);
    if (postStat.size !== stat.size) {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
        error: `${artifactName} size changed during read: initial ${stat.size} bytes, post-read ${postStat.size} bytes (concurrent mutation detected)`
      };
    }

    // Cryptographic digest verification from verified in-memory buffer
    const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
    if (declaredSha256 && actualSha256 !== declaredSha256.toLowerCase()) {
      return {
        success: false,
        code: DIAGNOSTIC_CODES.CHECKSUM_MISMATCH,
        error: `${artifactName} sha256 mismatch: observed ${actualSha256}, declared ${declaredSha256.toLowerCase()}`
      };
    }

    return {
      success: true,
      buffer,
      stat,
      actualSha256,
      resolvedPath
    };
  } catch (readErr) {
    return {
      success: false,
      code: DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
      error: `Failed to read ${artifactName} from descriptor: ${readErr.message}`
    };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Non-fatal descriptor close cleanup
      }
    }
  }
};

/**
 * Evaluates whether an explicitly supplied recovery-set satisfies all defined consistency,
 * integrity, and safety requirements offline.
 *
 * @param {string} recoveryRoot - Path to directory containing recovery set artifacts
 * @param {object} [options={}] - Verification options
 * @returns {Promise<{
 *   decision: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_VERIFIABLE_OFFLINE',
 *   diagnosticCodes: string[],
 *   details: object,
 *   stages: object,
 *   summary: string
 * }>}
 */
export async function verifyRecoverySet(recoveryRoot, options = {}) {
  const {
    allowTimestampOnly = false,
    maxManifestBytes = RESOURCE_LIMITS.MAX_MANIFEST_BYTES,
    maxInventoryBytes = RESOURCE_LIMITS.MAX_INVENTORY_BYTES,
    maxMongoBytes = RESOURCE_LIMITS.MAX_MONGO_BYTES,
    maxErrorsPerStage = RESOURCE_LIMITS.MAX_ERRORS_PER_STAGE,
    enforceTwoWayReconciliation = true
  } = options;

  const diagnosticCodes = [];
  const details = {
    errors: [],
    warnings: [],
    limitations: []
  };

  const stages = {
    stageA_manifestValidation: { passed: false, details: null },
    stageB_artifactIntegrity: { passed: false, details: null },
    stageC_mongoMetadata: { passed: false, details: null },
    stageD_minioInventory: { passed: false, details: null },
    stageE_crossStoreConsistency: { passed: false, details: null }
  };

  let stageErrorCount = 0;

  const addFailure = (code, message) => {
    if (!diagnosticCodes.includes(code)) diagnosticCodes.push(code);
    if (stageErrorCount < maxErrorsPerStage) {
      details.errors.push({ code, message });
      stageErrorCount++;
    } else if (stageErrorCount === maxErrorsPerStage) {
      details.errors.push({ code, message: '... additional stage errors omitted (rate-limited)' });
      stageErrorCount++;
    }
  };

  const addWarning = (code, message) => {
    if (!diagnosticCodes.includes(code)) diagnosticCodes.push(code);
    details.warnings.push({ code, message });
  };

  const addLimitation = (code, message) => {
    if (!diagnosticCodes.includes(code)) diagnosticCodes.push(code);
    details.limitations.push({ code, message });
  };

  try {
    // Pre-check: Root directory existence
    if (!recoveryRoot || typeof recoveryRoot !== 'string') {
      addFailure(DIAGNOSTIC_CODES.ROOT_NOT_FOUND, 'Recovery root path was not provided');
      return compileDecision(diagnosticCodes, details, stages);
    }

    let canonicalRoot;
    try {
      if (!fs.existsSync(recoveryRoot)) {
        addFailure(
          DIAGNOSTIC_CODES.ROOT_NOT_FOUND,
          `Recovery root does not exist: ${recoveryRoot}`
        );
        return compileDecision(diagnosticCodes, details, stages);
      }
      const stat = fs.statSync(recoveryRoot);
      if (!stat.isDirectory()) {
        addFailure(
          DIAGNOSTIC_CODES.ROOT_NOT_DIRECTORY,
          `Recovery root is not a directory: ${recoveryRoot}`
        );
        return compileDecision(diagnosticCodes, details, stages);
      }
      canonicalRoot = fs.realpathSync(recoveryRoot);
    } catch (rootErr) {
      addFailure(
        DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT,
        `Cannot read recovery root: ${rootErr.message}`
      );
      return compileDecision(diagnosticCodes, details, stages);
    }

    // =========================================================================
    // STAGE A: Input and Manifest Validation
    // =========================================================================
    stageErrorCount = 0;
    const manifestRead = await readArtifactFd({
      canonicalRoot,
      relativePath: 'manifest.json',
      maxBytes: maxManifestBytes,
      artifactName: 'manifest.json'
    });

    if (!manifestRead.success) {
      const code =
        manifestRead.code === DIAGNOSTIC_CODES.MISSING_ARTIFACT_FILE
          ? DIAGNOSTIC_CODES.MISSING_MANIFEST
          : manifestRead.code;
      addFailure(code, manifestRead.error);
      return compileDecision(diagnosticCodes, details, stages);
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestRead.buffer.toString('utf8'));
    } catch (jsonErr) {
      addFailure(
        DIAGNOSTIC_CODES.INVALID_MANIFEST_JSON,
        `manifest.json is not valid JSON: ${jsonErr.message}`
      );
      return compileDecision(diagnosticCodes, details, stages);
    }

    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      addFailure(
        DIAGNOSTIC_CODES.INVALID_MANIFEST_JSON,
        'manifest.json root must be a JSON object'
      );
      return compileDecision(diagnosticCodes, details, stages);
    }

    // Strict Schema: Reject unknown critical top-level fields
    for (const key of Object.keys(manifest)) {
      if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
        addFailure(
          DIAGNOSTIC_CODES.UNKNOWN_CRITICAL_MANIFEST_FIELD,
          `Unknown top-level field in manifest: "${key}"`
        );
      }
    }

    // Validate schema version
    if (!manifest.schemaVersion || !SUPPORTED_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
      addFailure(
        DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA_VERSION,
        `Unsupported schemaVersion: "${manifest.schemaVersion}". Supported: [${SUPPORTED_SCHEMA_VERSIONS.join(', ')}]`
      );
    }

    // Validate mandatory fields
    const mandatoryFields = [
      'recoverySetId',
      'createdAt',
      'verifierVersion',
      'storage',
      'artifacts',
      'quiescence',
      'captureProtocol',
      'unresolvedLateOperationsDeclared'
    ];
    for (const field of mandatoryFields) {
      if (manifest[field] === undefined || manifest[field] === null) {
        addFailure(
          DIAGNOSTIC_CODES.MISSING_MANDATORY_FIELD,
          `Missing mandatory manifest field: "${field}"`
        );
      }
    }

    if (typeof manifest.unresolvedLateOperationsDeclared !== 'boolean') {
      addFailure(
        DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
        'unresolvedLateOperationsDeclared must be a boolean'
      );
    }

    // Detailed validation of storage sub-schema
    if (manifest.storage) {
      if (typeof manifest.storage.bucket !== 'string' || !manifest.storage.bucket.trim()) {
        addFailure(
          DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
          'storage.bucket must be a non-empty string'
        );
      }
    }

    // Detailed validation of artifacts sub-schema
    if (manifest.artifacts) {
      if (!manifest.artifacts.mongo) {
        addFailure(
          DIAGNOSTIC_CODES.MISSING_MANDATORY_FIELD,
          'Missing mandatory artifact: "artifacts.mongo"'
        );
      } else {
        const m = manifest.artifacts.mongo;
        if (
          typeof m.path !== 'string' ||
          !Number.isSafeInteger(m.sizeBytes) ||
          m.sizeBytes < 0 ||
          typeof m.sha256 !== 'string' ||
          !m.sha256.trim()
        ) {
          addFailure(
            DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
            'artifacts.mongo must specify valid path, non-negative integer sizeBytes, and sha256'
          );
        } else {
          if (!m.format || !ALLOWED_MONGO_FORMATS.has(m.format)) {
            addFailure(
              DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
              `artifacts.mongo.format must be one of [${Array.from(ALLOWED_MONGO_FORMATS).join(', ')}]`
            );
          }
          const pathCheck = assertSafePath(canonicalRoot, m.path);
          if (!pathCheck.valid) {
            addFailure(pathCheck.code, `artifacts.mongo: ${pathCheck.error}`);
          }
        }
      }

      if (!manifest.artifacts.minio) {
        addFailure(
          DIAGNOSTIC_CODES.MISSING_MANDATORY_FIELD,
          'Missing mandatory artifact: "artifacts.minio"'
        );
      } else {
        const mi = manifest.artifacts.minio;
        if (
          typeof mi.path !== 'string' ||
          !Number.isSafeInteger(mi.sizeBytes) ||
          mi.sizeBytes < 0 ||
          typeof mi.sha256 !== 'string' ||
          !mi.sha256.trim() ||
          !Number.isSafeInteger(mi.objectCount) ||
          mi.objectCount < 0 ||
          !Number.isSafeInteger(mi.totalSizeBytes) ||
          mi.totalSizeBytes < 0
        ) {
          addFailure(
            DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
            'artifacts.minio must specify valid path, sizeBytes, sha256, non-negative integer objectCount, totalSizeBytes'
          );
        } else {
          if (mi.format !== 'inventory_json') {
            addFailure(
              DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
              'artifacts.minio.format must be strictly "inventory_json"'
            );
          }
          const pathCheck = assertSafePath(canonicalRoot, mi.path);
          if (!pathCheck.valid) {
            addFailure(pathCheck.code, `artifacts.minio: ${pathCheck.error}`);
          }
        }
      }
    }

    // Detailed validation of quiescence sub-schema
    if (manifest.quiescence) {
      const q = manifest.quiescence;
      if (typeof q.leaseId !== 'string' || !q.leaseId.trim()) {
        addFailure(
          DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
          'quiescence.leaseId must be a non-empty string'
        );
      }
      if (!ALLOWED_QUIESCENCE_STATUSES.has(q.status)) {
        addFailure(
          DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
          `quiescence.status must be one of [${Array.from(ALLOWED_QUIESCENCE_STATUSES).join(', ')}]`
        );
      }
      if (typeof q.admissionFreeze !== 'boolean') {
        addFailure(
          DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
          'quiescence.admissionFreeze must be a boolean'
        );
      }
      if (typeof q.workerHalt !== 'boolean') {
        addFailure(DIAGNOSTIC_CODES.INVALID_FIELD_TYPE, 'quiescence.workerHalt must be a boolean');
      }
      if (typeof q.storageFreeze !== 'boolean') {
        addFailure(
          DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
          'quiescence.storageFreeze must be a boolean'
        );
      }
      if (
        q.activeInstanceId !== undefined &&
        q.activeInstanceId !== null &&
        typeof q.activeInstanceId !== 'string'
      ) {
        addFailure(
          DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
          'quiescence.activeInstanceId must be a string or null'
        );
      }
    }

    // Detailed validation of captureProtocol sub-schema
    if (manifest.captureProtocol) {
      const cp = manifest.captureProtocol;
      if (typeof cp.protocol !== 'string' || !cp.protocol.trim()) {
        addFailure(
          DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
          'captureProtocol.protocol must be a non-empty string'
        );
      }
      if (!Array.isArray(cp.order) || cp.order.length === 0) {
        addFailure(
          DIAGNOSTIC_CODES.INVALID_FIELD_TYPE,
          'captureProtocol.order must be a non-empty array of strings'
        );
      }
    }

    if (details.errors.length > 0) {
      stages.stageA_manifestValidation = { passed: false, details: 'Manifest validation failed' };
      return compileDecision(diagnosticCodes, details, stages);
    }

    stages.stageA_manifestValidation = { passed: true, details: 'Manifest schema and paths valid' };

    // =========================================================================
    // STAGE B: Artifact Integrity Verification (7-Pillar File-Descriptor Hardening)
    // =========================================================================
    stageErrorCount = 0;
    let mongoBuffer = null;
    let minioBuffer = null;

    const mongoRead = await readArtifactFd({
      canonicalRoot,
      relativePath: manifest.artifacts.mongo.path,
      maxBytes: maxMongoBytes,
      declaredSizeBytes: manifest.artifacts.mongo.sizeBytes,
      declaredSha256: manifest.artifacts.mongo.sha256,
      artifactName: 'artifacts.mongo'
    });

    if (!mongoRead.success) {
      addFailure(mongoRead.code, mongoRead.error);
    } else {
      mongoBuffer = mongoRead.buffer;
    }

    const minioRead = await readArtifactFd({
      canonicalRoot,
      relativePath: manifest.artifacts.minio.path,
      maxBytes: maxInventoryBytes,
      declaredSizeBytes: manifest.artifacts.minio.sizeBytes,
      declaredSha256: manifest.artifacts.minio.sha256,
      artifactName: 'artifacts.minio'
    });

    if (!minioRead.success) {
      addFailure(minioRead.code, minioRead.error);
    } else {
      minioBuffer = minioRead.buffer;
    }

    if (!mongoRead.success || !minioRead.success) {
      stages.stageB_artifactIntegrity = {
        passed: false,
        details: 'Artifact integrity checks failed'
      };
      return compileDecision(diagnosticCodes, details, stages);
    }

    stages.stageB_artifactIntegrity = {
      passed: true,
      details: 'Artifact sizes and sha256 digests verified'
    };

    // =========================================================================
    // STAGE C: MongoDB Recovery Metadata Verification
    // =========================================================================
    stageErrorCount = 0;
    let mongoData = null;
    const mongoFormat = manifest.artifacts.mongo.format || 'json';

    if (mongoFormat !== 'json') {
      addLimitation(
        DIAGNOSTIC_CODES.UNSUPPORTED_MONGO_FORMAT,
        `MongoDB artifact format "${mongoFormat}" cannot be parsed offline without restore tooling`
      );
      stages.stageC_mongoMetadata = {
        passed: false,
        details: 'Offline BSON/archive parsing not supported'
      };
    } else {
      try {
        const rawMongo = mongoBuffer.toString('utf8');
        mongoData = JSON.parse(rawMongo);
      } catch (parseErr) {
        addFailure(
          DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP,
          `Failed to parse MongoDB backup artifact as JSON: ${parseErr.message}`
        );
      }

      if (typeof mongoData !== 'object' || mongoData === null || Array.isArray(mongoData)) {
        addFailure(
          DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP,
          'MongoDB backup artifact must be a JSON object'
        );
      } else {
        // Enforce mandatory structure in MongoDB backup
        if (typeof mongoData.recoverySetId !== 'string' || !mongoData.recoverySetId.trim()) {
          addFailure(
            DIAGNOSTIC_CODES.MISMATCHED_RECOVERY_SET_ID,
            'MongoDB backup artifact is missing mandatory "recoverySetId"'
          );
        } else if (mongoData.recoverySetId !== manifest.recoverySetId) {
          addFailure(
            DIAGNOSTIC_CODES.MISMATCHED_RECOVERY_SET_ID,
            `MongoDB recoverySetId "${mongoData.recoverySetId}" does not match manifest recoverySetId "${manifest.recoverySetId}"`
          );
        }

        if (!mongoData.backupLease || typeof mongoData.backupLease !== 'object') {
          addFailure(
            DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP,
            'MongoDB backup artifact is missing mandatory "backupLease" singleton document'
          );
        } else {
          const bl = mongoData.backupLease;
          if (!ALLOWED_QUIESCENCE_STATUSES.has(bl.status)) {
            addFailure(
              DIAGNOSTIC_CODES.LEASE_STATUS_NOT_QUIESCED,
              `BackupLease status in MongoDB artifact is "${bl.status}", expected QUIESCED or DRAINED`
            );
          } else if (bl.status !== manifest.quiescence.status) {
            addFailure(
              DIAGNOSTIC_CODES.LEASE_STATUS_NOT_QUIESCED,
              `BackupLease status "${bl.status}" does not match manifest quiescence.status "${manifest.quiescence.status}"`
            );
          }

          if (
            !bl.leaseId ||
            typeof bl.leaseId !== 'string' ||
            bl.leaseId !== manifest.quiescence.leaseId
          ) {
            addFailure(
              DIAGNOSTIC_CODES.LEASE_ID_MISMATCH,
              `BackupLease leaseId "${bl.leaseId}" does not match manifest quiescence.leaseId "${manifest.quiescence.leaseId}"`
            );
          }

          if (
            typeof manifest.artifacts.mongo.declaredGeneration === 'number' &&
            bl.generation !== manifest.artifacts.mongo.declaredGeneration
          ) {
            addFailure(
              DIAGNOSTIC_CODES.LEASE_GENERATION_MISMATCH,
              `BackupLease generation ${bl.generation} does not match declared generation ${manifest.artifacts.mongo.declaredGeneration}`
            );
          }

          if (manifest.quiescence && 'activeInstanceId' in manifest.quiescence) {
            if (manifest.quiescence.activeInstanceId === null) {
              if (bl.activeInstanceId !== null && bl.activeInstanceId !== undefined) {
                addFailure(
                  DIAGNOSTIC_CODES.ACTIVE_INSTANCE_DETECTED,
                  `BackupLease indicates active application instance "${bl.activeInstanceId}" was running during declared offline capture`
                );
              }
            } else {
              if (bl.activeInstanceId !== manifest.quiescence.activeInstanceId) {
                addFailure(
                  DIAGNOSTIC_CODES.ACTIVE_INSTANCE_DETECTED,
                  `BackupLease activeInstanceId "${bl.activeInstanceId}" does not match declared manifest quiescence.activeInstanceId "${manifest.quiescence.activeInstanceId}"`
                );
              } else {
                const isVerifiedOnlineQuiescence =
                  ALLOWED_QUIESCENCE_STATUSES.has(bl.status) &&
                  manifest.quiescence?.admissionFreeze === true &&
                  manifest.quiescence?.storageFreeze === true &&
                  bl.storageLocked === true;
                if (!isVerifiedOnlineQuiescence) {
                  addFailure(
                    DIAGNOSTIC_CODES.ACTIVE_INSTANCE_DETECTED,
                    `Active application instance "${bl.activeInstanceId}" permitted only when online quiescence barriers are verified`
                  );
                }
              }
            }
          } else {
            // Default: fail closed if any active instance ID is present in BackupLease without explicit manifest authorization
            if (bl.activeInstanceId !== null && bl.activeInstanceId !== undefined) {
              addFailure(
                DIAGNOSTIC_CODES.ACTIVE_INSTANCE_DETECTED,
                `BackupLease indicates active application instance "${bl.activeInstanceId}" was running without explicit manifest authorization`
              );
            }
          }

          if (bl.ttlMonitorDisabled !== true) {
            if (bl.ttlMonitorError && manifest.quiescence?.strictTtl !== true) {
              addLimitation(
                DIAGNOSTIC_CODES.TTL_MONITOR_UNSUPPRESSED_ADVISORY,
                `TTLMonitor was not suppressed during quiescence due to privilege limitation (${bl.ttlMonitorError}), operating under non-strict mode`
              );
            } else {
              addFailure(
                DIAGNOSTIC_CODES.TTL_MONITOR_NOT_DISABLED,
                'BackupLease indicates ttlMonitorDisabled is false; TTLMonitor was active during capture'
              );
            }
          }

          // Cross-check storageFreeze against BackupLease.storageLocked
          if (manifest.quiescence.storageFreeze === true && bl.storageLocked !== true) {
            addFailure(
              DIAGNOSTIC_CODES.STORAGE_FREEZE_BARRIER_UNVERIFIED,
              'Manifest declares storageFreeze=true, but MongoDB BackupLease.storageLocked is false or unset'
            );
          }
        }

        // Validate StorageJournals
        if (!Array.isArray(mongoData.storageJournals)) {
          addFailure(
            DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP,
            'MongoDB backup artifact is missing mandatory "storageJournals" array'
          );
        } else {
          for (let idx = 0; idx < mongoData.storageJournals.length; idx++) {
            const j = mongoData.storageJournals[idx];
            if (!j || typeof j !== 'object') {
              addFailure(
                DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP,
                `Invalid journal record at index ${idx}`
              );
              continue;
            }

            const isAddition = ['PutObject', 'CopyObject', 'MultipartUpload'].includes(j.type);
            const isDeletion = ['DeleteObject', 'DeleteObjects'].includes(j.type);

            if (isAddition) {
              if (!VALID_ADDITION_TERMINAL_STATUSES.has(j.status)) {
                addFailure(
                  DIAGNOSTIC_CODES.UNRESOLVED_JOURNAL_OPERATIONS,
                  `StorageJournal addition operation "${j.operationId || idx}" (${j.type}) has non-terminal status "${j.status}"; additions must reach COMMITTED, COMPENSATED, or ABANDONED`
                );
              }
            } else if (isDeletion) {
              if (!VALID_DELETION_TERMINAL_STATUSES.has(j.status)) {
                addFailure(
                  DIAGNOSTIC_CODES.UNRESOLVED_JOURNAL_OPERATIONS,
                  `StorageJournal deletion operation "${j.operationId || idx}" (${j.type}) has non-terminal status "${j.status}"`
                );
              }
            } else {
              addFailure(
                DIAGNOSTIC_CODES.UNRESOLVED_JOURNAL_OPERATIONS,
                `StorageJournal operation "${j.operationId || idx}" has unsupported type "${j.type}"`
              );
            }
          }
        }

        stages.stageC_mongoMetadata = {
          passed: details.errors.length === 0,
          details: 'MongoDB lease state, storage barrier, and journal operations inspected'
        };
      }
    }

    // =========================================================================
    // STAGE D: MinIO Object Inventory Metadata Verification
    // =========================================================================
    stageErrorCount = 0;
    let inventoryData = null;
    try {
      inventoryData = JSON.parse(minioBuffer.toString('utf8'));
    } catch (invErr) {
      addFailure(
        DIAGNOSTIC_CODES.MALFORMED_INVENTORY,
        `Failed to parse MinIO inventory file as JSON: ${invErr.message}`
      );
    }

    const inventoryKeysMap = new Map();

    if (inventoryData) {
      if (!Array.isArray(inventoryData)) {
        addFailure(
          DIAGNOSTIC_CODES.MALFORMED_INVENTORY,
          'MinIO inventory must be a JSON array of object records'
        );
      } else {
        if (inventoryData.length !== manifest.artifacts.minio.objectCount) {
          addFailure(
            DIAGNOSTIC_CODES.INVENTORY_COUNT_MISMATCH,
            `Inventory object count ${inventoryData.length} does not match declared objectCount ${manifest.artifacts.minio.objectCount}`
          );
        }

        let totalObservedBytes = 0;
        const declaredPrefix = manifest.storage?.prefix || '';

        for (let i = 0; i < inventoryData.length; i++) {
          const entry = inventoryData[i];
          if (
            !entry ||
            typeof entry.key !== 'string' ||
            !entry.key.trim() ||
            entry.key.includes('\0') ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0
          ) {
            addFailure(
              DIAGNOSTIC_CODES.INVALID_OBJECT_ENTRY,
              `Invalid inventory record at index ${i}`
            );
            continue;
          }

          if (inventoryKeysMap.has(entry.key)) {
            addFailure(
              DIAGNOSTIC_CODES.DUPLICATE_OBJECT_KEY,
              `Duplicate object key found in inventory: "${entry.key}"`
            );
          } else {
            inventoryKeysMap.set(entry.key, entry);
          }

          totalObservedBytes += entry.size;

          if (declaredPrefix && !entry.key.startsWith(declaredPrefix)) {
            addFailure(
              DIAGNOSTIC_CODES.UNEXPECTED_INVENTORY_OBJECT,
              `Object "${entry.key}" does not match declared storage prefix "${declaredPrefix}"`
            );
          }
        }

        if (totalObservedBytes !== manifest.artifacts.minio.totalSizeBytes) {
          addFailure(
            DIAGNOSTIC_CODES.INVENTORY_SIZE_MISMATCH,
            `Aggregated inventory size ${totalObservedBytes} bytes does not match declared totalSizeBytes ${manifest.artifacts.minio.totalSizeBytes} bytes`
          );
        }

        // Cross-reference StorageJournal with MinIO inventory (OBS-4, OBS-5, OBS-6)
        if (mongoData && Array.isArray(mongoData.storageJournals)) {
          const accountedInventoryKeys = new Set();
          const journalMapByKey = new Map();

          for (let idx = 0; idx < mongoData.storageJournals.length; idx++) {
            const j = mongoData.storageJournals[idx];
            if (!j || typeof j !== 'object') continue;

            // Foreign and missing bucket validation
            const declaredBucket = manifest.storage?.bucket;
            if (!declaredBucket || typeof declaredBucket !== 'string' || !declaredBucket.trim()) {
              addFailure(
                DIAGNOSTIC_CODES.UNEXPECTED_STORAGE_BUCKET,
                'Manifest storage bucket is missing, invalid, or empty'
              );
              continue;
            }

            if (
              !j.bucket ||
              typeof j.bucket !== 'string' ||
              j.bucket.trim() !== declaredBucket.trim()
            ) {
              addFailure(
                DIAGNOSTIC_CODES.UNEXPECTED_STORAGE_BUCKET,
                `StorageJournal operation "${j.operationId || idx}" specifies invalid or foreign bucket "${j.bucket}" (expected "${declaredBucket}")`
              );
              continue;
            }

            // Map operations to individual target keys
            const keysForEntry = [];
            if (
              j.type === 'DeleteObjects' &&
              Array.isArray(j.targetKeys) &&
              j.targetKeys.length > 0
            ) {
              for (const tk of j.targetKeys) {
                if (typeof tk === 'string' && tk.trim()) keysForEntry.push(tk.trim());
              }
            } else if (j.destinationKey) {
              keysForEntry.push(j.destinationKey);
            }

            for (const key of keysForEntry) {
              if (!journalMapByKey.has(key)) {
                journalMapByKey.set(key, []);
              }
              journalMapByKey.get(key).push({ journal: j, index: idx });
            }
          }

          const getJournalTimestamp = (journal) => {
            const raw = journal.updatedAt || journal.createdAt;
            if (!raw) return null;
            const time = new Date(raw).getTime();
            return Number.isFinite(time) ? time : null;
          };

          // Evaluate each key chronologically (OBS-4, OBS-5)
          for (const [key, entries] of journalMapByKey.entries()) {
            // Sort entries chronologically:
            // 1. Authoritative completion/update timestamp (updatedAt || createdAt)
            // 2. Tie-breaker: MongoDB ObjectId generation timestamp / hex, or array index
            entries.sort((a, b) => {
              const timeA = getJournalTimestamp(a.journal);
              const timeB = getJournalTimestamp(b.journal);

              if (timeA !== null && timeB !== null && timeA !== timeB) {
                return timeA - timeB;
              }
              if (timeA === null && timeB !== null) return -1;
              if (timeA !== null && timeB === null) return 1;

              if (
                a.journal._id &&
                b.journal._id &&
                typeof a.journal._id === 'string' &&
                typeof b.journal._id === 'string'
              ) {
                const idCmp = a.journal._id.localeCompare(b.journal._id);
                if (idCmp !== 0) return idCmp;
              }
              return a.index - b.index;
            });

            // Check for ambiguous ordering: conflicting operations with identical or indeterminate timestamps
            for (let i = 0; i < entries.length - 1; i++) {
              const curr = entries[i].journal;
              const next = entries[i + 1].journal;
              const timeCurr = getJournalTimestamp(curr);
              const timeNext = getJournalTimestamp(next);

              const isIndeterminate = timeCurr === null || timeNext === null;
              const isIdentical =
                timeCurr !== null && timeNext !== null && Math.abs(timeCurr - timeNext) === 0;

              const isConflicting =
                curr.type !== next.type ||
                curr.payloadHash !== next.payloadHash ||
                curr.payloadSize !== next.payloadSize;

              if (
                curr.operationId !== next.operationId &&
                (isIndeterminate || isIdentical) &&
                isConflicting
              ) {
                addWarning(
                  DIAGNOSTIC_CODES.CAUSAL_ORDERING_AMBIGUOUS,
                  `Conflicting storage operations "${curr.operationId}" (${curr.type}) and "${next.operationId}" (${next.type}) for key "${key}" have identical or indeterminate timestamps (${timeCurr} vs ${timeNext}); ordering is ambiguous`
                );
              }
            }

            // Extract latest terminal operation for this key
            const latestEntry = entries[entries.length - 1];
            const j = latestEntry.journal;

            // Terminal Additions (PutObject, CopyObject, MultipartUpload)
            if (['PutObject', 'CopyObject', 'MultipartUpload'].includes(j.type)) {
              if (j.status === 'COMMITTED') {
                const invEntry = inventoryKeysMap.get(key);
                if (!invEntry) {
                  addFailure(
                    DIAGNOSTIC_CODES.JOURNAL_REFERENCE_MISSING_FROM_INVENTORY,
                    `Committed journal ${j.type} operation "${j.operationId}" references key "${key}" absent from inventory`
                  );
                } else {
                  accountedInventoryKeys.add(key);

                  let hasVerifiedSize = false;
                  if (typeof j.payloadSize === 'number' && j.payloadSize >= 0) {
                    if (invEntry.size !== j.payloadSize) {
                      addFailure(
                        DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_SIZE_MISMATCH,
                        `Payload size mismatch for "${key}": journal has ${j.payloadSize}, inventory has ${invEntry.size}`
                      );
                    } else {
                      hasVerifiedSize = true;
                    }
                  }

                  let hasVerifiedHash = false;
                  if (j.payloadHash && invEntry.sha256) {
                    if (j.payloadHash.toLowerCase() !== invEntry.sha256.toLowerCase()) {
                      addFailure(
                        DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_HASH_MISMATCH,
                        `Payload hash mismatch for "${key}": journal has ${j.payloadHash}, inventory has ${invEntry.sha256}`
                      );
                    } else {
                      hasVerifiedHash = true;
                    }
                  }

                  // Mandatory relational evidence for CopyObject when metadata was omitted
                  if (j.type === 'CopyObject' && (!hasVerifiedSize || !hasVerifiedHash)) {
                    if (!j.sourceKey || typeof j.sourceKey !== 'string' || !j.sourceKey.trim()) {
                      addFailure(
                        DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_SIZE_MISMATCH,
                        `CopyObject operation "${j.operationId}" lacks payload metadata and specifies no sourceKey; cannot verify integrity`
                      );
                    } else {
                      const sourceInvEntry = inventoryKeysMap.get(j.sourceKey);
                      if (!sourceInvEntry) {
                        addFailure(
                          DIAGNOSTIC_CODES.JOURNAL_REFERENCE_MISSING_FROM_INVENTORY,
                          `CopyObject operation "${j.operationId}" lacks payload metadata and sourceKey "${j.sourceKey}" is missing from inventory; cannot verify copy integrity`
                        );
                      } else {
                        if (!hasVerifiedSize) {
                          if (invEntry.size !== sourceInvEntry.size) {
                            addFailure(
                              DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_SIZE_MISMATCH,
                              `CopyObject size mismatch for "${key}": destination has ${invEntry.size}, source "${j.sourceKey}" has ${sourceInvEntry.size}`
                            );
                          }
                        }
                        if (!hasVerifiedHash && sourceInvEntry.sha256 && invEntry.sha256) {
                          if (
                            invEntry.sha256.toLowerCase() !== sourceInvEntry.sha256.toLowerCase()
                          ) {
                            addFailure(
                              DIAGNOSTIC_CODES.JOURNAL_PAYLOAD_HASH_MISMATCH,
                              `CopyObject hash mismatch for "${key}": destination has ${invEntry.sha256}, source "${j.sourceKey}" has ${sourceInvEntry.sha256}`
                            );
                          }
                        }
                      }
                    }
                  }
                }
              } else if (['COMPENSATED', 'ABANDONED'].includes(j.status)) {
                if (inventoryKeysMap.has(key)) {
                  addFailure(
                    DIAGNOSTIC_CODES.UNEXPECTED_INVENTORY_OBJECT,
                    `Compensated/abandoned object "${key}" (journal operation ${j.operationId}) is unexpectedly present in inventory`
                  );
                }
              }
            }

            // Terminal Deletions (DeleteObject, DeleteObjects) - OBS-5
            if (['DeleteObject', 'DeleteObjects'].includes(j.type)) {
              if (['COMMITTED', 'CONFIRMED'].includes(j.status)) {
                if (inventoryKeysMap.has(key)) {
                  addFailure(
                    DIAGNOSTIC_CODES.UNEXPECTED_INVENTORY_OBJECT,
                    `Deleted object "${key}" (journal operation ${j.operationId}) is unexpectedly present in inventory`
                  );
                }
              }
            }
          }

          // Optional strict two-way reconciliation: check for unjournaled objects in prefix
          if (enforceTwoWayReconciliation) {
            for (const key of inventoryKeysMap.keys()) {
              if (!accountedInventoryKeys.has(key)) {
                addFailure(
                  DIAGNOSTIC_CODES.UNJOURNALED_OBJECT_DETECTED,
                  `Inventory object "${key}" is not accounted for by any committed StorageJournal entry`
                );
              }
            }
          }

          // Cross-check committed Response attachments against inventory and StorageJournal
          if (mongoData && Array.isArray(mongoData.responses)) {
            for (const resp of mongoData.responses) {
              if (!resp || typeof resp !== 'object') continue;
              if (resp.commitStatus && resp.commitStatus !== 'committed') continue;

              const answers = Array.isArray(resp.answers) ? resp.answers : [];
              for (const ans of answers) {
                const key =
                  ans?.value?.key ||
                  (typeof ans?.value === 'string' && ans.value.startsWith('forms/')
                    ? ans.value
                    : null);
                if (key && typeof key === 'string' && key.trim()) {
                  const trimmedKey = key.trim();
                  // 1. Must be present in inventory
                  if (!inventoryKeysMap.has(trimmedKey)) {
                    addFailure(
                      DIAGNOSTIC_CODES.JOURNAL_REFERENCE_MISSING_FROM_INVENTORY,
                      `Committed Response "${resp._id || 'unknown'}" references attachment key "${trimmedKey}" absent from inventory`
                    );
                  }
                  // 2. Must be backed by a committed StorageJournal entry
                  const journalEntries = journalMapByKey.get(trimmedKey);
                  const hasCommittedJournal =
                    journalEntries && journalEntries.some((e) => e.journal?.status === 'COMMITTED');
                  if (!hasCommittedJournal) {
                    addFailure(
                      DIAGNOSTIC_CODES.UNJOURNALED_OBJECT_DETECTED,
                      `Committed Response "${resp._id || 'unknown'}" references attachment key "${trimmedKey}" without any committed StorageJournal entry`
                    );
                  }
                }
              }
            }
          }
        }

        stages.stageD_minioInventory = {
          passed: details.errors.length === 0,
          details: `Validated ${inventoryKeysMap.size} inventory entries and cross-referenced with storage journals`
        };
      }
    }

    // =========================================================================
    // STAGE E: Cross-Store Consistency & Protocol Verification
    // =========================================================================
    stageErrorCount = 0;

    // Check generation tracking capabilities and gaps
    // In Paperless, MinIO does not store lease epochs.
    if (manifest.artifacts.minio.declaredGeneration !== undefined) {
      addLimitation(
        DIAGNOSTIC_CODES.CROSS_STORE_GENERATION_UNVERIFIABLE,
        'MinIO schema does not store generation epochs; cross-store generation matching is unverifiable offline'
      );
    }

    // Capture protocol ordering checks
    const cp = manifest.captureProtocol;
    if (cp.protocol === 'TIMESTAMP_ONLY' && !allowTimestampOnly) {
      addWarning(
        DIAGNOSTIC_CODES.TIMESTAMP_ONLY_ORDERING_INSUFFICIENT,
        'Capture protocol relies solely on timestamps; timestamps alone do not prove causal ordering or quiescence'
      );
    }

    const validOrders = [
      ['STORAGE_FREEZE', 'MINIO_INVENTORY', 'MONGO_CAPTURE', 'UNQUIESCE'],
      ['STORAGE_FREEZE', 'MINIO_SNAPSHOT', 'MONGO_SNAPSHOT', 'UNQUIESCE'],
      ['STORAGE_FREEZE', 'MINIO_INVENTORY', 'MONGO_SNAPSHOT', 'UNQUIESCE']
    ];

    const orderMatches = validOrders.some((expected) => {
      if (expected.length !== cp.order.length) return false;
      return expected.every((val, idx) => val === cp.order[idx]);
    });

    if (!orderMatches) {
      addWarning(
        DIAGNOSTIC_CODES.INVALID_CAPTURE_ORDER,
        `Capture order [${cp.order.join(', ')}] does not match recommended Protocol D ordering [STORAGE_FREEZE -> MINIO -> MONGO -> UNQUIESCE]`
      );
    }

    // Quiescence barrier evidence
    const q = manifest.quiescence;
    if (q.admissionFreeze !== true) {
      addWarning(
        DIAGNOSTIC_CODES.MISSING_ADMISSION_FREEZE_EVIDENCE,
        'quiescence.admissionFreeze is false; mutation ingress was not confirmed frozen'
      );
    }

    if (q.workerHalt !== true) {
      addWarning(
        DIAGNOSTIC_CODES.MISSING_WORKER_HALT_EVIDENCE,
        'quiescence.workerHalt is false; background workers were not confirmed halted'
      );
    }

    if (q.storageFreeze !== true) {
      addWarning(
        DIAGNOSTIC_CODES.MISSING_STORAGE_FREEZE_EVIDENCE,
        'quiescence.storageFreeze is false; storage barrier was not confirmed active'
      );
    }

    // Late operation uncertainty check
    if (manifest.unresolvedLateOperationsDeclared === true) {
      addWarning(
        DIAGNOSTIC_CODES.LATE_OPERATION_UNCERTAINTY,
        'Manifest explicitly declares unresolved late remote operations were possible at capture time'
      );
    }

    // Always document offline distributed limitation
    addLimitation(
      DIAGNOSTIC_CODES.OFFLINE_LIMITATION_CROSS_STORE_ATOMICITY,
      'Offline verification cannot mathematically prove simultaneous hardware capture across decoupled physical stores'
    );

    stages.stageE_crossStoreConsistency = {
      passed: details.errors.length === 0 && details.warnings.length === 0,
      details: 'Cross-store protocol, quiescence fences, and late-operation uncertainty evaluated'
    };
  } catch (uncaughtErr) {
    addFailure(
      DIAGNOSTIC_CODES.MALFORMED_MONGO_BACKUP,
      `Uncaught exception during verification execution: ${uncaughtErr.message}`
    );
  }

  return compileDecision(diagnosticCodes, details, stages);
}

/**
 * Compiles final deterministic decision from collected diagnostic codes and stage outcomes.
 */
function compileDecision(diagnosticCodes, details, stages) {
  let decision;
  const allStagesPassed = Object.values(stages).every((s) => s.passed === true);

  // 1. Errors (integrity, path escape, schema corruption) fail closed
  if (details.errors.length > 0) {
    decision = DECISION_OUTCOMES.FAIL;
  }
  // 2. Warnings (missing evidence, protocol deviation, late-op uncertainty) block admission
  else if (details.warnings.length > 0) {
    decision = DECISION_OUTCOMES.BLOCKED;
  }
  // 3. Unverifiable offline formats or limitations
  else if (
    !allStagesPassed &&
    (diagnosticCodes.includes(DIAGNOSTIC_CODES.UNSUPPORTED_MONGO_FORMAT) ||
      diagnosticCodes.includes(DIAGNOSTIC_CODES.CROSS_STORE_GENERATION_UNVERIFIABLE))
  ) {
    decision = DECISION_OUTCOMES.NOT_VERIFIABLE_OFFLINE;
  }
  // 4. Incomplete stages without explicit warnings or limitations fail closed
  else if (!allStagesPassed) {
    decision = DECISION_OUTCOMES.FAIL;
  }
  // 5. Explicit offline limitations
  else if (
    diagnosticCodes.includes(DIAGNOSTIC_CODES.UNSUPPORTED_MONGO_FORMAT) ||
    diagnosticCodes.includes(DIAGNOSTIC_CODES.CROSS_STORE_GENERATION_UNVERIFIABLE)
  ) {
    decision = DECISION_OUTCOMES.NOT_VERIFIABLE_OFFLINE;
  }
  // 6. All mandatory stages passed with verified evidence
  else {
    decision = DECISION_OUTCOMES.PASS;
  }

  const errorSummary = details.errors
    .slice(0, 10)
    .map((e) => `[${e.code}] ${e.message}`)
    .join('; ');
  const warningSummary = details.warnings
    .slice(0, 10)
    .map((w) => `[${w.code}] ${w.message}`)
    .join('; ');
  const summary =
    decision === DECISION_OUTCOMES.PASS
      ? 'Recovery set verified: all mandatory stages satisfied with valid cryptographic and structural evidence.'
      : `Recovery set rejected with status ${decision}. Errors: ${errorSummary || 'None'}. Warnings: ${warningSummary || 'None'}.`;

  return {
    decision,
    diagnosticCodes,
    details,
    stages,
    summary
  };
}
