/**
 * minioTestHelper.js
 *
 * Ephemeral MinIO Container Management and Test Isolation Helper for Phase 2D.1K.9 (Phase K-F).
 *
 * Provides:
 * - Deterministic, non-colliding container lifecycle management (ports 9010 S3 / 9011 Console)
 * - Zero-cost ephemeral infrastructure (runs locally, no cloud API charges)
 * - Native S3 SDK bucket provisioning and teardown
 * - Fast HTTP /dev/health/ready and TCP readiness polling
 * - Test environment configuration for S3StorageProvider and StorageService
 */

import http from 'http';
import net from 'net';
import { execSync } from 'child_process';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3';
import { S3StorageProvider } from '../services/S3StorageProvider.js';

export const MINIO_TEST_CONFIG = Object.freeze({
  IMAGE: process.env.TEST_MINIO_IMAGE || 'cgr.dev/chainguard/minio:latest',
  CONTAINER_NAME: process.env.TEST_MINIO_CONTAINER || 'paperless-kf-minio',
  S3_PORT: parseInt(process.env.TEST_MINIO_PORT || '9010', 10),
  CONSOLE_PORT: parseInt(process.env.TEST_MINIO_CONSOLE_PORT || '9011', 10),
  ACCESS_KEY_ID: process.env.TEST_MINIO_ROOT_USER || 'minio_admin',
  SECRET_ACCESS_KEY: process.env.TEST_MINIO_ROOT_PASSWORD || 'minio_password',
  BUCKET: process.env.TEST_MINIO_BUCKET || 'paperless-kf-test',
  REGION: process.env.TEST_MINIO_REGION || 'us-east-1',
  get ENDPOINT() {
    return `http://127.0.0.1:${this.S3_PORT}`;
  },
  get HEALTH_URL() {
    return `http://127.0.0.1:${this.S3_PORT}/minio/health/ready`;
  }
});

/**
 * Checks if MinIO HTTP readiness endpoint returns 200 OK.
 *
 * @param {string} [url=MINIO_TEST_CONFIG.HEALTH_URL]
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<boolean>}
 */
export const isMinioHealthy = (url = MINIO_TEST_CONFIG.HEALTH_URL, timeoutMs = 1500) => {
  return new Promise((resolve) => {
    let req;
    const timeout = setTimeout(() => {
      if (req) req.destroy();
      resolve(false);
    }, timeoutMs);

    try {
      req = http.get(url, (res) => {
        clearTimeout(timeout);
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    } catch {
      clearTimeout(timeout);
      resolve(false);
    }
  });
};

/**
 * Checks raw TCP connectivity on the given host and port.
 *
 * @param {number} [port=MINIO_TEST_CONFIG.S3_PORT]
 * @param {string} [host='127.0.0.1']
 * @param {number} [timeoutMs=1000]
 * @returns {Promise<boolean>}
 */
export const isTcpPortOpen = (port = MINIO_TEST_CONFIG.S3_PORT, host = '127.0.0.1', timeoutMs = 1000) => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let status = false;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      status = true;
      socket.end();
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('close', () => {
      resolve(status);
    });

    socket.connect(port, host);
  });
};

/**
 * Polls until MinIO readiness probe passes or maximum wait time is exceeded.
 *
 * @param {object} [options]
 * @param {number} [options.maxWaitMs=20000]
 * @param {number} [options.intervalMs=250]
 * @param {string} [options.healthUrl=MINIO_TEST_CONFIG.HEALTH_URL]
 * @returns {Promise<boolean>}
 */
export const waitForMinioReady = async ({
  maxWaitMs = 20000,
  intervalMs = 250,
  healthUrl = MINIO_TEST_CONFIG.HEALTH_URL
} = {}) => {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ready = await isMinioHealthy(healthUrl, Math.min(intervalMs, 1000));
    if (ready) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
};

/**
 * Creates an S3Client instance configured for the MinIO test container.
 *
 * @param {object} [config=MINIO_TEST_CONFIG]
 * @returns {S3Client}
 */
export const createTestS3Client = (config = MINIO_TEST_CONFIG) => {
  return new S3Client({
    region: config.REGION,
    endpoint: config.ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.ACCESS_KEY_ID,
      secretAccessKey: config.SECRET_ACCESS_KEY
    },
    maxAttempts: 1
  });
};

/**
 * Ensures the target test bucket exists in MinIO.
 *
 * @param {string} [bucketName=MINIO_TEST_CONFIG.BUCKET]
 * @param {object} [config=MINIO_TEST_CONFIG]
 * @returns {Promise<void>}
 */
export const ensureTestBucket = async (
  bucketName = MINIO_TEST_CONFIG.BUCKET,
  config = MINIO_TEST_CONFIG
) => {
  const client = createTestS3Client(config);
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucketName }));
      return; // Bucket exists
    } catch (err) {
      const statusCode = err?.$metadata?.httpStatusCode;
      const errorName = err?.name;
      if (statusCode === 404 || errorName === 'NotFound' || errorName === 'NoSuchBucket') {
        await client.send(new CreateBucketCommand({ Bucket: bucketName }));
      } else {
        throw err;
      }
    }
  } finally {
    await client.destroy();
  }
};

/**
 * Empties all objects inside the test bucket for clean, isolated test runs.
 *
 * @param {string} [bucketName=MINIO_TEST_CONFIG.BUCKET]
 * @param {object} [config=MINIO_TEST_CONFIG]
 * @returns {Promise<number>} Number of keys deleted
 */
export const emptyTestBucket = async (
  bucketName = MINIO_TEST_CONFIG.BUCKET,
  config = MINIO_TEST_CONFIG
) => {
  const client = createTestS3Client(config);
  let deletedCount = 0;
  try {
    let continuationToken;
    do {
      const listResp = await client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: continuationToken
        })
      );

      const objects = (listResp.Contents || []).map((o) => ({ Key: o.Key }));
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects, Quiet: true }
          })
        );
        deletedCount += objects.length;
      }

      continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
    } while (continuationToken);

    return deletedCount;
  } finally {
    await client.destroy();
  }
};

/**
 * Checks if a Docker container with the specified name is currently running.
 *
 * @param {string} [containerName=MINIO_TEST_CONFIG.CONTAINER_NAME]
 * @returns {boolean}
 */
export const isContainerRunning = (containerName = MINIO_TEST_CONFIG.CONTAINER_NAME) => {
  try {
    const output = execSync(
      `docker ps --filter "name=^/${containerName}$" --format "{{.Names}}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
    return output === containerName;
  } catch {
    return false;
  }
};

/**
 * Starts or reuses the MinIO test container and verifies readiness and test bucket.
 *
 * @param {object} [options]
 * @param {boolean} [options.ensureBucket=true]
 * @param {number} [options.maxWaitMs=20000]
 * @returns {Promise<{ endpoint: string, bucket: string, containerName: string }>}
 */
export const startMinioTestContainer = async ({
  ensureBucket = true,
  maxWaitMs = 20000
} = {}) => {
  const {
    CONTAINER_NAME,
    IMAGE,
    S3_PORT,
    CONSOLE_PORT,
    ACCESS_KEY_ID,
    SECRET_ACCESS_KEY,
    BUCKET,
    ENDPOINT
  } = MINIO_TEST_CONFIG;

  const alreadyHealthy = await isMinioHealthy();
  if (alreadyHealthy) {
    if (ensureBucket) {
      await ensureTestBucket(BUCKET);
    }
    return { endpoint: ENDPOINT, bucket: BUCKET, containerName: CONTAINER_NAME };
  }

  // Check if container exists in stopped state; remove it cleanly if so
  try {
    const existing = execSync(
      `docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format "{{.Names}}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
    if (existing === CONTAINER_NAME) {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'ignore' });
    }
  } catch {
    // Ignore error if docker command fails
  }

  // Launch isolated MinIO container
  const dockerCmd = [
    'docker run -d',
    `--name ${CONTAINER_NAME}`,
    `-p ${S3_PORT}:9000`,
    `-p ${CONSOLE_PORT}:9001`,
    `-e MINIO_ROOT_USER=${ACCESS_KEY_ID}`,
    `-e MINIO_ROOT_PASSWORD=${SECRET_ACCESS_KEY}`,
    IMAGE,
    'server /data --console-address :9001'
  ].join(' ');

  try {
    execSync(dockerCmd, { stdio: 'pipe' });
  } catch (err) {
    // If port collision occurs or docker fails, check if another container already took it
    const isNowHealthy = await isMinioHealthy();
    if (!isNowHealthy) {
      throw new Error(`Failed to start MinIO test container: ${err.message}`);
    }
  }

  const ready = await waitForMinioReady({ maxWaitMs });
  if (!ready) {
    throw new Error(`MinIO test container failed to become ready within ${maxWaitMs}ms`);
  }

  if (ensureBucket) {
    await ensureTestBucket(BUCKET);
  }

  return { endpoint: ENDPOINT, bucket: BUCKET, containerName: CONTAINER_NAME };
};

/**
 * Stops and removes the test MinIO container and its ephemeral resources.
 *
 * @param {string} [containerName=MINIO_TEST_CONFIG.CONTAINER_NAME]
 * @returns {void}
 */
export const stopMinioTestContainer = (containerName = MINIO_TEST_CONFIG.CONTAINER_NAME) => {
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
  } catch {
    // Already removed or not running
  }
};

/**
 * Injects test MinIO configuration into process.env for S3StorageProvider and services.
 *
 * @param {object} [config=MINIO_TEST_CONFIG]
 * @returns {{ restoreEnv: () => void }}
 */
export const setupTestStorageEnv = (config = MINIO_TEST_CONFIG) => {
  const previousEnv = {
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_REGION: process.env.S3_REGION,
    S3_MAX_ATTEMPTS: process.env.S3_MAX_ATTEMPTS
  };

  process.env.S3_ENDPOINT = config.ENDPOINT;
  process.env.S3_BUCKET = config.BUCKET;
  process.env.S3_ACCESS_KEY_ID = config.ACCESS_KEY_ID;
  process.env.S3_SECRET_ACCESS_KEY = config.SECRET_ACCESS_KEY;
  process.env.S3_REGION = config.REGION;
  process.env.S3_MAX_ATTEMPTS = '1';

  return {
    restoreEnv: () => {
      for (const [key, val] of Object.entries(previousEnv)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    }
  };
};

/**
 * Instantiates and returns a dedicated, isolated S3StorageProvider connected to MinIO test container.
 *
 * @param {object} [config=MINIO_TEST_CONFIG]
 * @returns {S3StorageProvider}
 */
export const createIsolatedTestStorageProvider = (config = MINIO_TEST_CONFIG) => {
  const { restoreEnv } = setupTestStorageEnv(config);
  try {
    const provider = new S3StorageProvider();
    return provider;
  } finally {
    restoreEnv();
  }
};
