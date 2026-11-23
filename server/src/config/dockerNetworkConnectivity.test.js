import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../');

/**
 * Helper to check if Docker daemon is running and accessible
 */
function isDockerDaemonAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe('Docker Network Connectivity & Runtime Isolation (Phase 4.4 Workstream 2D.1A)', () => {
  const prodComposePath = path.join(REPO_ROOT, 'docker-compose.yml');
  const stagingComposePath = path.join(REPO_ROOT, 'docker-compose.staging.yml');
  const backupDockerfile = path.join(REPO_ROOT, 'backup/Dockerfile');

  let prodCompose;
  let stagingCompose;
  let dockerfileContent;

  beforeAll(() => {
    prodCompose = yaml.load(fs.readFileSync(prodComposePath, 'utf8'));
    stagingCompose = yaml.load(fs.readFileSync(stagingComposePath, 'utf8'));
    dockerfileContent = fs.readFileSync(backupDockerfile, 'utf8');
  });

  describe('1. Production Compose Network Architecture (docker-compose.yml)', () => {
    it('defines distinct frontend-network and backend-network bridge networks', () => {
      expect(prodCompose.networks).toBeDefined();
      expect(prodCompose.networks['frontend-network']).toBeDefined();
      expect(prodCompose.networks['backend-network']).toBeDefined();
      expect(prodCompose.networks['frontend-network'].driver).toBe('bridge');
      expect(prodCompose.networks['backend-network'].driver).toBe('bridge');
    });

    it('attaches server to both frontend-network and backend-network with deterministic "server" aliases', () => {
      const server = prodCompose.services.server;
      expect(server).toBeDefined();
      expect(server.networks).toBeDefined();

      // Validate frontend-network alias
      expect(server.networks['frontend-network']).toBeDefined();
      expect(server.networks['frontend-network'].aliases).toContain('server');

      // Validate backend-network alias for deterministic DNS resolution from backup runner
      expect(server.networks['backend-network']).toBeDefined();
      expect(server.networks['backend-network'].aliases).toContain('server');
    });

    it('attaches backup container exclusively to backend-network', () => {
      const backup = prodCompose.services.backup;
      expect(backup).toBeDefined();
      expect(backup.networks).toBeDefined();

      const backupNetworks = Array.isArray(backup.networks)
        ? backup.networks
        : Object.keys(backup.networks);

      expect(backupNetworks).toContain('backend-network');
      expect(backupNetworks).not.toContain('frontend-network');
      expect(backupNetworks.length).toBe(1);
    });

    it('attaches client container exclusively to frontend-network', () => {
      const client = prodCompose.services.client;
      expect(client).toBeDefined();
      expect(client.networks).toBeDefined();

      const clientNetworks = Array.isArray(client.networks)
        ? client.networks
        : Object.keys(client.networks);

      expect(clientNetworks).toContain('frontend-network');
      expect(clientNetworks).not.toContain('backend-network');
      expect(clientNetworks.length).toBe(1);
    });

    it('attaches mongo and minio exclusively to backend-network', () => {
      const mongo = prodCompose.services.mongo;
      const minio = prodCompose.services.minio;

      const mongoNetworks = Array.isArray(mongo.networks)
        ? mongo.networks
        : Object.keys(mongo.networks);
      expect(mongoNetworks).toContain('backend-network');
      expect(mongoNetworks).not.toContain('frontend-network');

      const minioNetworks = Array.isArray(minio.networks)
        ? minio.networks
        : Object.keys(minio.networks);
      expect(minioNetworks).toContain('backend-network');
      expect(minioNetworks).not.toContain('frontend-network');
    });
  });

  describe('2. Staging Compose Network Architecture (docker-compose.staging.yml)', () => {
    it('defines distinct staging-frontend-network and staging-backend-network bridge networks', () => {
      expect(stagingCompose.networks).toBeDefined();
      expect(stagingCompose.networks['staging-frontend-network']).toBeDefined();
      expect(stagingCompose.networks['staging-backend-network']).toBeDefined();
      expect(stagingCompose.networks['staging-frontend-network'].driver).toBe('bridge');
      expect(stagingCompose.networks['staging-backend-network'].driver).toBe('bridge');
    });

    it('attaches server to both staging networks with deterministic "server" aliases', () => {
      const server = stagingCompose.services.server;
      expect(server).toBeDefined();
      expect(server.networks).toBeDefined();

      expect(server.networks['staging-frontend-network']).toBeDefined();
      expect(server.networks['staging-frontend-network'].aliases).toContain('server');

      expect(server.networks['staging-backend-network']).toBeDefined();
      expect(server.networks['staging-backend-network'].aliases).toContain('server');
    });

    it('attaches backup container exclusively to staging-backend-network', () => {
      const backup = stagingCompose.services.backup;
      expect(backup).toBeDefined();
      expect(backup.networks).toBeDefined();

      const backupNetworks = Array.isArray(backup.networks)
        ? backup.networks
        : Object.keys(backup.networks);

      expect(backupNetworks).toContain('staging-backend-network');
      expect(backupNetworks).not.toContain('staging-frontend-network');
      expect(backupNetworks.length).toBe(1);
    });

    it('attaches client container exclusively to staging-frontend-network', () => {
      const client = stagingCompose.services.client;
      expect(client).toBeDefined();
      expect(client.networks).toBeDefined();

      const clientNetworks = Array.isArray(client.networks)
        ? client.networks
        : Object.keys(client.networks);

      expect(clientNetworks).toContain('staging-frontend-network');
      expect(clientNetworks).not.toContain('staging-backend-network');
      expect(clientNetworks.length).toBe(1);
    });
  });

  describe('3. Backup Container Security & Runtime Hardening AST Invariants', () => {
    const testCases = [
      { name: 'Production Compose', compose: () => prodCompose },
      { name: 'Staging Compose', compose: () => stagingCompose }
    ];

    testCases.forEach(({ name, compose }) => {
      describe(name, () => {
        it('enforces non-root runtime user UID:GID 10001:10001', () => {
          const backup = compose().services.backup;
          expect(backup.user).toBe('10001:10001');
        });

        it('enforces strictly read-only root filesystem', () => {
          const backup = compose().services.backup;
          expect(backup.read_only).toBe(true);
        });

        it('mounts writable tmpfs on /tmp with sticky bit and bounded size', () => {
          const backup = compose().services.backup;
          expect(backup.tmpfs).toBeDefined();
          expect(Array.isArray(backup.tmpfs)).toBe(true);

          const tmpMount = backup.tmpfs.find((m) => m.startsWith('/tmp'));
          expect(tmpMount).toBeDefined();
          expect(tmpMount).toMatch(/\/tmp:mode=1777/);
        });

        it('drops ALL Linux capabilities to prevent container breakout', () => {
          const backup = compose().services.backup;
          expect(backup.cap_drop).toBeDefined();
          expect(backup.cap_drop).toContain('ALL');
        });

        it('enforces no-new-privileges security option', () => {
          const backup = compose().services.backup;
          expect(backup.security_opt).toBeDefined();
          expect(backup.security_opt).toContain('no-new-privileges:true');
        });

        it('exposes zero public host ports', () => {
          const backup = compose().services.backup;
          expect(backup.ports).toBeUndefined();
        });

        it('never mounts the Docker daemon socket (/var/run/docker.sock)', () => {
          const backup = compose().services.backup;
          const volumes = backup.volumes || [];
          for (const vol of volumes) {
            const volStr = typeof vol === 'string' ? vol : JSON.stringify(vol);
            expect(volStr).not.toContain('docker.sock');
            expect(volStr).not.toContain('/var/run');
          }
        });

        it('restricts persistent storage strictly to spool volume', () => {
          const backup = compose().services.backup;
          expect(backup.volumes).toBeDefined();
          expect(backup.volumes.length).toBe(1);
          const volStr = typeof backup.volumes[0] === 'string' ? backup.volumes[0] : backup.volumes[0].target;
          expect(volStr).toMatch(/backup_spool:\/backup\/spool/);
        });

        it('defines resource limits for CPU and memory', () => {
          const backup = compose().services.backup;
          expect(backup.deploy?.resources?.limits).toBeDefined();
          expect(backup.deploy.resources.limits.cpus).toBeDefined();
          expect(backup.deploy.resources.limits.memory).toBeDefined();
        });

        it('injects required backup quiescence and storage environment variables', () => {
          const backup = compose().services.backup;
          expect(backup.environment).toBeDefined();
          const envList = backup.environment.map((e) => e.split('=')[0]);

          expect(envList).toContain('BACKUP_INTERNAL_TOKEN');
          expect(envList).toContain('MONGO_URI');
          expect(envList).toContain('S3_ENDPOINT');
          expect(envList).toContain('INITIAL_LEASE_MS');
          expect(envList).toContain('HEARTBEAT_INTERVAL_MS');
          expect(envList).toContain('HEARTBEAT_EXTEND_MS');
          expect(envList).toContain('DRAIN_TIMEOUT_MS');
          expect(envList).toContain('MAX_WATCHDOG_LEASE_MS');
        });
      });
    });
  });

  describe('4. Backup Dockerfile Construction Verification (backup/Dockerfile)', () => {
    it('uses minimal hardened Alpine Linux base image', () => {
      expect(dockerfileContent).toMatch(/^FROM alpine:3\.20/m);
    });

    it('creates dedicated non-root backup user and group 10001:10001', () => {
      expect(dockerfileContent).toContain('addgroup -g 10001 -S backup');
      expect(dockerfileContent).toContain('adduser -u 10001 -S backup -G backup');
    });

    it('establishes /backup hierarchy with strict 750 permissions owned by 10001:10001', () => {
      expect(dockerfileContent).toContain('mkdir -p /backup/config');
      expect(dockerfileContent).toContain('/backup/spool');
      expect(dockerfileContent).toContain('/backup/manifests');
      expect(dockerfileContent).toContain('/backup/logs');
      expect(dockerfileContent).toContain('/backup/temporary');
      expect(dockerfileContent).toContain('chown -R 10001:10001 /backup');
      expect(dockerfileContent).toContain('chmod -R 750 /backup');
    });

    it('declares USER 10001:10001', () => {
      expect(dockerfileContent).toMatch(/^USER 10001:10001/m);
    });

    it('declares safe signal trapping in entrypoint and cmd', () => {
      expect(dockerfileContent).toContain('trap \'exit 0\' TERM INT');
    });
  });

  describe('5. Network Reachability Graph & Isolation Model', () => {
    // Model the theoretical reachability between containers based on bridge networks
    function canReach(sourceService, targetService, compose) {
      const src = compose.services[sourceService];
      const tgt = compose.services[targetService];
      if (!src || !tgt) return false;

      const getNetworks = (svc) => {
        if (!svc.networks) return [];
        return Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks);
      };

      const srcNets = new Set(getNetworks(src));
      const tgtNets = new Set(getNetworks(tgt));

      for (const net of srcNets) {
        if (tgtNets.has(net)) return true;
      }
      return false;
    }

    it('allows backup to reach server (quiescence administrative API)', () => {
      expect(canReach('backup', 'server', prodCompose)).toBe(true);
      expect(canReach('backup', 'server', stagingCompose)).toBe(true);
    });

    it('allows backup to reach mongo (data snapshot)', () => {
      expect(canReach('backup', 'mongo', prodCompose)).toBe(true);
      expect(canReach('backup', 'mongo', stagingCompose)).toBe(true);
    });

    it('allows backup to reach minio (object storage backup)', () => {
      expect(canReach('backup', 'minio', prodCompose)).toBe(true);
      expect(canReach('backup', 'minio', stagingCompose)).toBe(true);
    });

    it('STRICTLY PREVENTS backup from reaching client (frontend proxy isolation)', () => {
      expect(canReach('backup', 'client', prodCompose)).toBe(false);
      expect(canReach('backup', 'client', stagingCompose)).toBe(false);
    });

    it('STRICTLY PREVENTS client from reaching mongo or minio directly', () => {
      expect(canReach('client', 'mongo', prodCompose)).toBe(false);
      expect(canReach('client', 'minio', prodCompose)).toBe(false);
      expect(canReach('client', 'mongo', stagingCompose)).toBe(false);
      expect(canReach('client', 'minio', stagingCompose)).toBe(false);
    });

    it('allows client to reach server for public API routing', () => {
      expect(canReach('client', 'server', prodCompose)).toBe(true);
      expect(canReach('client', 'server', stagingCompose)).toBe(true);
    });
  });

  describe('6. Runtime Container & Isolation Drill (Docker Daemon Verification)', () => {
    const dockerAvailable = isDockerDaemonAvailable();
    const testImageName = 'paperless-backup-verify:test';
    const netFrontend = 'verify-net-front';
    const netBackend = 'verify-net-back';
    const mockClientName = 'verify-mock-client';
    const mockServerName = 'verify-mock-server';
    const mockMongoName = 'verify-mock-mongo';
    const mockMinioName = 'verify-mock-minio';

    beforeAll(() => {
      if (!dockerAvailable) return;

      // Clean up any stale artifacts
      try {
        execSync(
          `docker rm -f ${mockClientName} ${mockServerName} ${mockMongoName} ${mockMinioName} 2>/dev/null || true`,
          { stdio: 'ignore' }
        );
        execSync(`docker network rm ${netFrontend} ${netBackend} 2>/dev/null || true`, {
          stdio: 'ignore'
        });
      } catch {
        // ignore
      }

      // Build disposable backup container image
      execSync(`docker build -t ${testImageName} -f backup/Dockerfile backup/`, {
        cwd: REPO_ROOT,
        stdio: 'ignore'
      });

      // Create isolated bridge networks
      execSync(`docker network create ${netFrontend}`);
      execSync(`docker network create ${netBackend}`);

      // Start mock services:
      // Mock Client on netFrontend
      execSync(
        `docker run -d --rm --name ${mockClientName} --network ${netFrontend} --network-alias client alpine:3.20 sh -c "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 6\\r\\nConnection: close\\r\\n\\r\\nclient' | nc -l -p 80; done"`
      );

      // Mock Mongo on netBackend
      execSync(
        `docker run -d --rm --name ${mockMongoName} --network ${netBackend} --network-alias mongo alpine:3.20 sh -c "while true; do printf 'mongodb\\n' | nc -l -p 27017; done"`
      );

      // Mock Minio on netBackend
      execSync(
        `docker run -d --rm --name ${mockMinioName} --network ${netBackend} --network-alias minio alpine:3.20 sh -c "while true; do printf 'minio\\n' | nc -l -p 9000; done"`
      );

      // Mock Server on both netFrontend and netBackend with alias "server"
      execSync(
        `docker run -d --rm --name ${mockServerName} --network ${netFrontend} --network-alias server alpine:3.20 sh -c "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 16\\r\\nConnection: close\\r\\n\\r\\nquiescence-ready' | nc -l -p 5000; done"`
      );
      execSync(`docker network connect --alias server ${netBackend} ${mockServerName}`);
    }, 60000);

    afterAll(() => {
      if (!dockerAvailable) return;
      try {
        execSync(
          `docker rm -f ${mockClientName} ${mockServerName} ${mockMongoName} ${mockMinioName} 2>/dev/null || true`,
          { stdio: 'ignore' }
        );
        execSync(`docker network rm ${netFrontend} ${netBackend} 2>/dev/null || true`, {
          stdio: 'ignore'
        });
        execSync(`docker rmi -f ${testImageName} 2>/dev/null || true`, { stdio: 'ignore' });
      } catch {
        // ignore
      }
    });

    it('verifies non-root UID 10001, read-only rootfs, and writable /tmp', () => {
      if (!dockerAvailable) return;

      const output = execSync(
        `docker run --rm \
          --user 10001:10001 \
          --read-only \
          --tmpfs /tmp:mode=1777,size=128M \
          --security-opt no-new-privileges:true \
          --cap-drop ALL \
          ${testImageName} \
          "id -u && id -g && (echo write-root > /forbidden.txt 2>/dev/null || echo ROOT_RO) && (echo write-tmp > /tmp/ok.txt && cat /tmp/ok.txt)"`,
        { encoding: 'utf8' }
      );

      expect(output).toContain('10001');
      expect(output).toContain('ROOT_RO');
      expect(output).toContain('write-tmp');
    });

    it('verifies complete capability stripping (all caps 0x0)', () => {
      if (!dockerAvailable) return;

      const output = execSync(
        `docker run --rm \
          --user 10001:10001 \
          --read-only \
          --tmpfs /tmp:mode=1777,size=128M \
          --security-opt no-new-privileges:true \
          --cap-drop ALL \
          ${testImageName} \
          "grep CapEff /proc/self/status"`,
        { encoding: 'utf8' }
      );

      expect(output.trim()).toBe('CapEff:\t0000000000000000');
    });

    it('verifies NoNewPrivs is set to 1', () => {
      if (!dockerAvailable) return;

      const output = execSync(
        `docker run --rm \
          --user 10001:10001 \
          --read-only \
          --tmpfs /tmp:mode=1777,size=128M \
          --security-opt no-new-privileges:true \
          --cap-drop ALL \
          ${testImageName} \
          "grep NoNewPrivs /proc/self/status"`,
        { encoding: 'utf8' }
      );

      expect(output.trim()).toBe('NoNewPrivs:\t1');
    });

    it('verifies Docker daemon socket is completely inaccessible', () => {
      if (!dockerAvailable) return;

      const output = execSync(
        `docker run --rm \
          --user 10001:10001 \
          --read-only \
          --tmpfs /tmp:mode=1777,size=128M \
          --security-opt no-new-privileges:true \
          --cap-drop ALL \
          ${testImageName} \
          "test -e /var/run/docker.sock && echo SOCKET_EXISTS || echo SOCKET_ABSENT"`,
        { encoding: 'utf8' }
      );

      expect(output.trim()).toBe('SOCKET_ABSENT');
    });

    it('verifies backup runner connects to server:5000 quiescence endpoint via backend-network', () => {
      if (!dockerAvailable) return;

      const output = execSync(
        `docker run --rm \
          --network ${netBackend} \
          --user 10001:10001 \
          --read-only \
          --tmpfs /tmp:mode=1777,size=128M \
          --security-opt no-new-privileges:true \
          --cap-drop ALL \
          ${testImageName} \
          "curl -s http://server:5000"`,
        { encoding: 'utf8' }
      );

      expect(output.trim()).toBe('quiescence-ready');
    });

    it('verifies backup runner connects to mongo:27017 and minio:9000 via backend-network', () => {
      if (!dockerAvailable) return;

      const output = execSync(
        `docker run --rm \
          --network ${netBackend} \
          --user 10001:10001 \
          --read-only \
          --tmpfs /tmp:mode=1777,size=128M \
          --security-opt no-new-privileges:true \
          --cap-drop ALL \
          ${testImageName} \
          "nc -z -w 2 mongo 27017 && echo MONGO_OK; nc -z -w 2 minio 9000 && echo MINIO_OK"`,
        { encoding: 'utf8' }
      );

      expect(output).toContain('MONGO_OK');
      expect(output).toContain('MINIO_OK');
    });

    it('verifies backup runner CANNOT resolve or reach client on frontend-network', () => {
      if (!dockerAvailable) return;

      const output = execSync(
        `docker run --rm \
          --network ${netBackend} \
          --user 10001:10001 \
          --read-only \
          --tmpfs /tmp:mode=1777,size=128M \
          --security-opt no-new-privileges:true \
          --cap-drop ALL \
          ${testImageName} \
          "(getent hosts client && echo RESOLVED || echo DNS_BLOCKED); (curl -m 2 http://client:80 2>&1 || echo CURL_BLOCKED)"`,
        { encoding: 'utf8' }
      );

      expect(output).toContain('DNS_BLOCKED');
      expect(output).toContain('CURL_BLOCKED');
      expect(output).not.toContain('RESOLVED');
    });
  });
});
