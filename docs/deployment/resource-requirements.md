# Deployment Resource Requirements & Host Prerequisites

This document specifies the enforced resource policy, temporary storage bounds, and host verification prerequisites for Paperless (`docker-compose.yml` and `docker-compose.staging.yml`).

---

## 1. Server Container Resource Policy

The `server` service is configured with the following resource bounds:

| Parameter | Configured Value | Enforcement Mechanism |
|---|---:|---|
| **Server container memory limit** | `1 GiB` (`1024M` / `1024m`) | Docker cgroup `memory.max` / `mem_limit` |
| **Server memory reservation** | `256 MiB` (`256M`) | Docker `reservations.memory` |
| **Node.js old-space limit** | `256 MiB` (`--max-old-space-size=256`) | `NODE_OPTIONS` environment variable |
| **Docker `/tmp` tmpfs** | `768 MiB` (`size=768M,mode=1777`) | Volatile kernel `shmem` mount |
| **Active upload capacity** | `10` (`UPLOAD_ADMISSION_MAX_CONCURRENT`) | `UploadAdmissionService` (hard ceiling: 10) |
| **Waiting queue capacity** | `50` (`UPLOAD_ADMISSION_MAX_QUEUE_SIZE`) | `UploadAdmissionService` bounded FIFO queue (hard ceiling: 50; resource-profile limit, not a universal HTTP capacity guarantee) |
| **Admission timeout** | `30 seconds` (`30000 ms`) | `UPLOAD_ADMISSION_QUEUE_TIMEOUT_MS` |

---

## 2. Temporary Storage (`/tmp` tmpfs)

- `/tmp` is mounted as a **volatile `tmpfs`** (`mode=1777,size=768M`).
- **Multer** (`server/src/routes/responseRoutes.js`) is the sole application writer to `/tmp` (`os.tmpdir()`).
- **Maximum active temporary payload:** $10\text{ active uploads} \times 10\text{ files} \times 5\text{ MiB} = 500\text{ MiB}$ ($524.29\text{ MB}$).
- **Remaining nominal tmpfs capacity:** $768\text{ MiB} - 500\text{ MiB} = 268\text{ MiB}$ ($34.90\%$ headroom).
- **Monitoring:** Actual filesystem use must be monitored during deployment.
- **Persistence warning:** Do **not** mount persistent storage at `/tmp` without a separately reviewed orphan-cleanup design; volatile `tmpfs` guarantees automatic cleanup on container restart/crash.

---

## 3. Memory Accounting Model

- `--max-old-space-size=256` limits **V8 old space**, not total process RSS.
- `tmpfs` maximum (`768M`) is a filesystem capacity, **not** a preallocated memory reservation; `tmpfs` pages are charged to cgroup memory (`shmem`) as they are written.
- Stream buffers ($\sim 2.34\text{ MiB}$) and queue waiters ($\sim 0.05\text{ MiB}$) are **already included** in Node.js process RSS ($\sim 180\text{ MiB}$ analytical estimate) and must not be added twice.
- Estimated peak container cgroup memory under full saturation: $180\text{ MiB (RSS)} + 500\text{ MiB (tmpfs)} + 15\text{ MiB (kmem)} = 695\text{ MiB} \le 1024\text{ MiB}$ ($329\text{ MiB}$ headroom).
- Cgroup memory pressure may trigger an OOM kill even when the Node.js V8 heap is below `256 MiB`.

---

## 4. Host Prerequisites & Planning Target

The independent audit recommends **at least 4 GB physical RAM** as a minimum planning target for the full multi-container stack (`server`, `mongo`, `minio`, `client`, `backup`), subject to actual workload validation. **4 GB is a planning target, not a universal mathematical guarantee.**

Before production deployment, operators must verify:

1. **Physical RAM** on the host.
2. **Docker daemon memory usage**.
3. **Server container memory limit** (`1024M` enforced).
4. **MongoDB container memory** (note: `mongo` has no `mem_limit` in Compose; WiredTiger cache defaults to 50% of `(Host RAM - 1 GB)`).
5. **MinIO container memory** (note: `minio` has no `mem_limit` in Compose).
6. **Nginx (`client`) and `backup` container memory** (`backup` is capped at `512M`).
7. **Other host workloads** sharing the machine.
8. **Swap configuration** (optional host-level operational decision; swap does not replace a sufficient physical memory budget and may affect latency).
9. **Host memory headroom during simultaneous upload bursts**.
10. **Actual cgroup memory pressure and OOM events**.

### MongoDB & Swap Notes
- **MongoDB WiredTiger cache:** Only configure `--wiredTigerCacheSizeGB` as an optional tuning consideration if your existing MongoDB deployment configuration and actual host memory budget justify it.
- **Swap:** Swap is an optional host-level operational decision, not a substitute for physical RAM.

---

## 5. Safe Read-Only Operator Verification Commands

Cgroup paths differ across Linux distributions, kernel versions (cgroup v1 vs v2), and Docker versions. Use these read-only commands to inspect your host:

```bash
# Host physical memory and swap
free -h
swapon --show

# Live container memory usage
docker stats --no-stream

# Inspect server container memory limit and tmpfs mount
docker inspect paperless-server --format '{{.HostConfig.Memory}} {{.HostConfig.Tmpfs}}'

# Cgroup v2 memory metrics (if mounted at /sys/fs/cgroup)
cat /sys/fs/cgroup/memory.current 2>/dev/null || true
cat /sys/fs/cgroup/memory.max 2>/dev/null || true
cat /sys/fs/cgroup/memory.events 2>/dev/null || true
```
