import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import storageService from './StorageService.js';
import { app, readinessHandler, resetActiveDbPingPromise } from '../server.js';

describe('Readiness Probe and Compose Orchestration', () => {
  const originalDb = mongoose.connection.db;
  const originalClient = mongoose.connection.client;

  const mockReplicaSetHealthy = () => {
    mongoose.connection.client = {
      topology: { description: { type: 'ReplicaSetWithPrimary' } }
    };
    mongoose.connection.db = {
      admin: vi.fn().mockReturnValue({
        command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true, setName: 'rs0' })
      })
    };
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    resetActiveDbPingPromise();
    mockReplicaSetHealthy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetActiveDbPingPromise();
    mongoose.connection.db = originalDb;
    mongoose.connection.client = originalClient;
  });

  describe('readinessHandler Unit Tests', () => {
    it('returns HTTP 200 when both database and storage are healthy', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: true,
        status: 'connected'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: 'ready',
          database: 'connected',
          storage: 'connected',
          timestamp: expect.any(String)
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('returns HTTP 503 when database is disconnected even if storage is healthy', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: true,
        status: 'connected'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'disconnected',
          storage: 'connected',
          timestamp: expect.any(String)
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('returns HTTP 503 when storage is unreachable even if database is connected', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: false,
        status: 'unreachable',
        error: 'storage_unreachable'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'connected',
          storage: 'unreachable',
          timestamp: expect.any(String)
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('returns HTTP 503 when bucket is missing (404)', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: false,
        status: 'bucket_not_found',
        error: 'bucket_not_found'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'connected',
          storage: 'bucket_not_found',
          timestamp: expect.any(String)
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('returns HTTP 503 when storage request times out', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: false,
        status: 'timeout',
        error: 'storage_timeout'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'connected',
          storage: 'timeout',
          timestamp: expect.any(String)
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('returns HTTP 503 when bucket access is denied (403)', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: false,
        status: 'bucket_access_denied',
        error: 'bucket_access_denied'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'connected',
          storage: 'bucket_access_denied',
          timestamp: expect.any(String)
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('returns HTTP 503 when both database and storage are disconnected', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: false,
        status: 'unreachable',
        error: 'storage_unreachable'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'disconnected',
          storage: 'unreachable',
          timestamp: expect.any(String)
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('safely handles unexpected rejection from storageService without crashing', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockRejectedValueOnce(
        new Error('Fatal driver crash')
      );

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'connected',
          storage: 'error',
          timestamp: expect.any(String)
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('returns HTTP 200 when database admin().command({ hello: 1 }) confirms replica-set primary', async () => {
      const origReadyState = mongoose.connection.readyState;
      const origDb = mongoose.connection.db;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      mongoose.connection.db = {
        admin: vi.fn().mockReturnValue({
          command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true, setName: 'rs0' })
        })
      };
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: true,
        status: 'connected'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: 'ready',
          database: 'connected'
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
      mongoose.connection.db = origDb;
    });

    it('returns HTTP 503 when database readyState is 1 but admin hello command fails', async () => {
      const origReadyState = mongoose.connection.readyState;
      const origDb = mongoose.connection.db;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      mongoose.connection.db = {
        admin: vi.fn().mockReturnValue({
          command: vi.fn().mockRejectedValue(new Error('Connection lost to primary'))
        })
      };
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: true,
        status: 'connected'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'disconnected',
          storage: 'connected'
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
      mongoose.connection.db = origDb;
    });

    it('returns HTTP 503 when database readiness check times out (>2000ms)', async () => {
      const origReadyState = mongoose.connection.readyState;
      const origDb = mongoose.connection.db;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

      // Simulate a hung hello command that never resolves
      const hangingPing = new Promise(() => {});
      mongoose.connection.db = {
        admin: vi.fn().mockReturnValue({
          command: vi.fn().mockReturnValue(hangingPing)
        })
      };
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValue({
        ok: true,
        status: 'connected'
      });

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {};
      const res = { status: statusMock };

      await readinessHandler(req, res);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'disconnected',
          storage: 'connected'
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
      mongoose.connection.db = origDb;
    }, 5000);

    it('rejects repeated probe with HTTP 503 and avoids duplicate commands when previous check is still in flight', async () => {
      const origReadyState = mongoose.connection.readyState;
      const origDb = mongoose.connection.db;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

      let finishPing;
      const slowPing = new Promise((resolve) => {
        finishPing = resolve;
      });
      const commandMock = vi.fn().mockReturnValue(slowPing);

      mongoose.connection.db = {
        admin: vi.fn().mockReturnValue({
          command: commandMock
        })
      };
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValue({
        ok: true,
        status: 'connected'
      });

      // Launch probe 1 (which starts slowPing and keeps it in flight)
      const res1Status = vi.fn().mockReturnValue({ json: vi.fn() });
      const probe1 = readinessHandler({}, { status: res1Status });

      // Immediately launch probe 2 while probe 1 is still in flight
      const res2Json = vi.fn();
      const res2Status = vi.fn().mockReturnValue({ json: res2Json });
      await readinessHandler({}, { status: res2Status });

      // Probe 2 should fail fast with 503 without invoking command a second time
      expect(commandMock).toHaveBeenCalledTimes(1);
      expect(res2Status).toHaveBeenCalledWith(503);
      expect(res2Json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          status: 'not_ready',
          database: 'disconnected'
        })
      );

      // Now settle probe 1's command
      finishPing({ ok: 1, isWritablePrimary: true, setName: 'rs0' });
      await probe1;
      expect(res1Status).toHaveBeenCalledWith(200);

      // Subsequent probe 3 arrives after settlement and should start a new command and succeed
      const res3Json = vi.fn();
      const res3Status = vi.fn().mockReturnValue({ json: res3Json });
      commandMock.mockResolvedValueOnce({ ok: 1, isWritablePrimary: true, setName: 'rs0' });
      await readinessHandler({}, { status: res3Status });

      expect(commandMock).toHaveBeenCalledTimes(2);
      expect(res3Status).toHaveBeenCalledWith(200);
      expect(res3Json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: 'ready',
          database: 'connected'
        })
      );

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
      mongoose.connection.db = origDb;
    });

    it('returns HTTP 503 when database topology is standalone (Single) or ReplicaSetNoPrimary', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValue({
        ok: true,
        status: 'connected'
      });

      for (const badType of ['Single', 'ReplicaSetNoPrimary', 'Unknown']) {
        mongoose.connection.client = { topology: { description: { type: badType } } };
        const jsonMock = vi.fn();
        const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
        await readinessHandler({}, { status: statusMock });

        expect(statusMock).toHaveBeenCalledWith(503);
        expect(jsonMock).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            status: 'not_ready',
            database: 'disconnected'
          })
        );
      }

      // Also reject if hello reports standalone (no setName) even with ReplicaSetWithPrimary mock
      mongoose.connection.client = {
        topology: { description: { type: 'ReplicaSetWithPrimary' } }
      };
      mongoose.connection.db = {
        admin: vi.fn().mockReturnValue({
          command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true })
        })
      };
      const jsonStandaloneHello = vi.fn();
      const statusStandaloneHello = vi.fn().mockReturnValue({ json: jsonStandaloneHello });
      await readinessHandler({}, { status: statusStandaloneHello });
      expect(statusStandaloneHello).toHaveBeenCalledWith(503);

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });
  });

  describe('Readiness HTTP Endpoint Integration', () => {
    it('serves readiness status on /health/ready, /ready, /api/health/ready, and /api/ready', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValue({
        ok: true,
        status: 'connected'
      });

      const endpoints = ['/health/ready', '/ready', '/api/health/ready', '/api/ready'];

      for (const endpoint of endpoints) {
        const response = await request(app).get(endpoint);
        expect(response.status).toBe(200);
        expect(response.body).toEqual(
          expect.objectContaining({
            success: true,
            status: 'ready',
            database: 'connected',
            storage: 'connected',
            timestamp: expect.any(String)
          })
        );
      }

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });

    it('returns HTTP 503 on /ready when storage is degraded', async () => {
      const origReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
      vi.spyOn(storageService, 'checkBucketAccess').mockResolvedValueOnce({
        ok: false,
        status: 'unreachable',
        error: 'storage_unreachable'
      });

      const response = await request(app).get('/ready');
      expect(response.status).toBe(503);
      expect(response.body.success).toBe(false);
      expect(response.body.status).toBe('not_ready');
      expect(response.body.database).toBe('connected');
      expect(response.body.storage).toBe('unreachable');

      Object.defineProperty(mongoose.connection, 'readyState', {
        value: origReadyState,
        configurable: true
      });
    });
  });

  describe('Compose Staging Orchestration Configuration Verification', () => {
    const composePath = fs.existsSync(path.resolve(process.cwd(), 'docker-compose.staging.yml'))
      ? path.resolve(process.cwd(), 'docker-compose.staging.yml')
      : path.resolve(process.cwd(), '..', 'docker-compose.staging.yml');
    const composeContent = fs.readFileSync(composePath, 'utf8');

    it('ensures server service depends on minio-init completing successfully', () => {
      expect(composeContent).toContain('minio-init:');
      expect(composeContent).toContain('condition: service_completed_successfully');

      // Verify server service block includes minio-init dependency
      const serverBlockMatch = composeContent.match(
        /server:[\s\S]*?depends_on:([\s\S]*?)environment:/
      );
      expect(serverBlockMatch).not.toBeNull();
      const dependsOnSection = serverBlockMatch[1];
      expect(dependsOnSection).toContain('minio-init:');
      expect(dependsOnSection).toContain('condition: service_completed_successfully');
    });

    it('ensures minio-init has restart: "no"', () => {
      const minioInitMatch = composeContent.match(/minio-init:[\s\S]*?restart:\s*["']?no["']?/);
      expect(minioInitMatch).not.toBeNull();
    });

    it('ensures minio-init entrypoint script uses literal block scalar, set -e, and does not swallow failures with exit 0', () => {
      const entrypointMatch = composeContent.match(/entrypoint:\s*\|([\s\S]*?)environment:/);
      expect(entrypointMatch).not.toBeNull();
      const entrypoint = entrypointMatch[1];

      expect(entrypoint).toContain('set -e');
      expect(entrypoint).toContain("until /usr/bin/bash -c 'exec 3<>/dev/tcp/minio/9000'");
      expect(entrypoint).toContain('/usr/bin/mc alias set');
      expect(entrypoint).toContain('/usr/bin/mc mb --ignore-existing');
      expect(entrypoint).not.toContain('exit 0;');
      expect(entrypoint).not.toMatch(/exit\s+0/);
    });

    it('validates shell execution semantics for set -e failure propagation', () => {
      // Simulating failure in alias or bucket creation command
      expect(() => {
        execSync('/bin/sh -c "set -e; false; echo unreachable"', { stdio: 'pipe' });
      }).toThrow();

      // Simulating successful sequential commands
      const result = execSync('/bin/sh -c "set -e; true; echo success"', {
        stdio: 'pipe',
        encoding: 'utf8'
      });
      expect(result.trim()).toBe('success');
    });
  });
});
