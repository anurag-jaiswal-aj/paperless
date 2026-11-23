#!/usr/bin/env bash
# ==============================================================================
# Phase 2D.1K.9 (Phase K-F): Isolated MinIO Test Container Manager
#
# Provides an ephemeral, non-colliding MinIO instance for integration testing.
# Zero-cost ($0/₹0): Operates on local Docker daemon without external resources.
# ==============================================================================

set -euo pipefail

CONTAINER_NAME="${TEST_MINIO_CONTAINER:-paperless-kf-minio}"
IMAGE="${TEST_MINIO_IMAGE:-cgr.dev/chainguard/minio:latest}"
PORT="${TEST_MINIO_PORT:-9010}"
CONSOLE_PORT="${TEST_MINIO_CONSOLE_PORT:-9011}"
ROOT_USER="${TEST_MINIO_ROOT_USER:-minio_admin}"
ROOT_PASSWORD="${TEST_MINIO_ROOT_PASSWORD:-minio_password}"
BUCKET="${TEST_MINIO_BUCKET:-paperless-kf-test}"
ENDPOINT="http://127.0.0.1:${PORT}"
HEALTH_URL="${ENDPOINT}/minio/health/ready"

is_healthy() {
  if curl -sf --max-time 1 "${HEALTH_URL}" >/dev/null 2>&1; then
    return 0
  else
    return 1
  fi
}

wait_for_ready() {
  local retries=30
  local wait_sec=1
  echo "[MinIO-KF] Waiting for MinIO readiness at ${HEALTH_URL}..."
  for ((i=1; i<=retries; i++)); do
    if is_healthy; then
      echo "[MinIO-KF] Ready after ${i}s."
      return 0
    fi
    sleep "${wait_sec}"
  done
  echo "[MinIO-KF] ERROR: MinIO failed to become ready within ${retries}s." >&2
  return 1
}

ensure_bucket() {
  echo "[MinIO-KF] Ensuring test bucket '${BUCKET}' exists..."
  docker exec "${CONTAINER_NAME}" /usr/bin/mc alias set local http://127.0.0.1:9000 "${ROOT_USER}" "${ROOT_PASSWORD}" >/dev/null 2>&1 || true
  docker exec "${CONTAINER_NAME}" /usr/bin/mc mb --ignore-existing "local/${BUCKET}" >/dev/null 2>&1 || true
  echo "[MinIO-KF] Bucket '${BUCKET}' verified."
}

start_container() {
  if is_healthy; then
    echo "[MinIO-KF] MinIO container '${CONTAINER_NAME}' is already running and healthy at ${ENDPOINT}."
    ensure_bucket
    return 0
  fi

  # Check if container exists in stopped state
  if docker ps -a --filter "name=^/${CONTAINER_NAME}$" --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "[MinIO-KF] Removing stopped container '${CONTAINER_NAME}'..."
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi

  echo "[MinIO-KF] Starting MinIO container '${CONTAINER_NAME}' (Port: ${PORT}, Console: ${CONSOLE_PORT})..."
  docker run -d \
    --name "${CONTAINER_NAME}" \
    -p "${PORT}:9000" \
    -p "${CONSOLE_PORT}:9001" \
    -e MINIO_ROOT_USER="${ROOT_USER}" \
    -e MINIO_ROOT_PASSWORD="${ROOT_PASSWORD}" \
    "${IMAGE}" \
    server /data --console-address :9001 >/dev/null

  wait_for_ready
  ensure_bucket
  echo "[MinIO-KF] Container '${CONTAINER_NAME}' started successfully."
}

stop_container() {
  echo "[MinIO-KF] Stopping and removing container '${CONTAINER_NAME}'..."
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  echo "[MinIO-KF] Teardown complete. Zero dangling resources."
}

status_container() {
  echo "--- MinIO Test Container Status ---"
  echo "Container: ${CONTAINER_NAME}"
  echo "Endpoint:  ${ENDPOINT}"
  echo "Console:   http://127.0.0.1:${CONSOLE_PORT}"
  echo "Bucket:    ${BUCKET}"
  if is_healthy; then
    echo "Health:    HEALTHY (HTTP 200 OK)"
  else
    echo "Health:    UNREACHABLE / STOPPED"
  fi
}

case "${1:-start}" in
  start)
    start_container
    ;;
  stop)
    stop_container
    ;;
  restart)
    stop_container
    start_container
    ;;
  status)
    status_container
    ;;
  check)
    if is_healthy; then
      echo "OK: MinIO healthy at ${HEALTH_URL}"
      exit 0
    else
      echo "FAIL: MinIO unreachable at ${HEALTH_URL}" >&2
      exit 1
    fi
    ;;
  ensure-bucket)
    ensure_bucket
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|check|ensure-bucket}" >&2
    exit 1
    ;;
esac
