#!/usr/bin/env bash
# ==============================================================================
# Paperless Staging Smoke-Test Suite
# Non-destructive post-deployment QA verification for Paperless.
# Target environment: Staging (Default: http://127.0.0.1:8080)
#
# Rules enforced:
# - Zero em dashes in text, code, or comments.
# - Non-destructive execution: does not alter real forms or user data.
# - Strict assertion of HTTP status codes, headers, and JSON structure.
# ==============================================================================

set -uo pipefail

TARGET_URL="${1:-${TARGET_URL:-http://127.0.0.1:8080}}"
TARGET_URL="${TARGET_URL%/}"

PASS_COUNT=0
FAIL_COUNT=0
TOTAL_COUNT=0

COOKIE_JAR=""
OVERSIZED_TEMP=""
SMALL_TEMP=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  if [[ -n "${COOKIE_JAR:-}" && -f "${COOKIE_JAR}" ]]; then
    rm -f "${COOKIE_JAR}"
  fi
  if [[ -n "${OVERSIZED_TEMP:-}" && -f "${OVERSIZED_TEMP}" ]]; then
    rm -f "${OVERSIZED_TEMP}"
  fi
  if [[ -n "${SMALL_TEMP:-}" && -f "${SMALL_TEMP}" ]]; then
    rm -f "${SMALL_TEMP}"
  fi
  if [[ ${exit_code} -eq 0 && "${1:-}" == "SIGNAL" ]]; then
    exit 130
  fi
  exit "${exit_code}"
}

trap 'cleanup SIGNAL' INT TERM HUP
trap 'cleanup' EXIT

COLOR_GREEN="\033[0;32m"
COLOR_RED="\033[0;31m"
COLOR_YELLOW="\033[0;33m"
COLOR_CYAN="\033[0;36m"
COLOR_RESET="\033[0m"

to_lower() {
  echo "$1" | tr '[:upper:]' '[:lower:]'
}

log_info() {
  echo -e "${COLOR_CYAN}[INFO]${COLOR_RESET} $1"
}

log_pass() {
  echo -e "  ${COLOR_GREEN}PASS:${COLOR_RESET} $1"
  ((PASS_COUNT++))
  ((TOTAL_COUNT++))
}

log_fail() {
  echo -e "  ${COLOR_RED}FAIL:${COLOR_RESET} $1"
  ((FAIL_COUNT++))
  ((TOTAL_COUNT++))
}

print_header() {
  echo ""
  echo -e "${COLOR_YELLOW}================================================================${COLOR_RESET}"
  echo -e "${COLOR_YELLOW} $1${COLOR_RESET}"
  echo -e "${COLOR_YELLOW}================================================================${COLOR_RESET}"
}

# Require jq and curl
if ! command -v curl &>/dev/null; then
  echo "Error: curl is required to execute smoke tests."
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required to validate JSON responses."
  exit 1
fi

# Preflight target reachability probe
log_info "Verifying target connectivity to ${TARGET_URL}..."
PREFLIGHT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "${TARGET_URL}/api/health" 2>/dev/null || true)
if [[ "${PREFLIGHT_CODE}" == "000" || -z "${PREFLIGHT_CODE}" ]]; then
  echo -e "${COLOR_RED}Error: Target server at ${TARGET_URL} is unreachable.${COLOR_RESET}" >&2
  echo -e "Please verify that the target environment is running and that TARGET_URL is correct." >&2
  exit 2
fi

echo -e "${COLOR_CYAN}Starting Paperless Post-Deployment Smoke Tests against: ${TARGET_URL}${COLOR_RESET}"

# ==============================================================================
# Suite 1: Health and Readiness Endpoints
# ==============================================================================
print_header "Suite 1: Health and Readiness Endpoints"

# 1.1 Liveness Probe
log_info "1.1 Verifying Liveness Probe (GET /api/health)..."
LIVENESS_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/health")
LIVENESS_BODY=$(echo "${LIVENESS_RESP}" | sed '$d')
LIVENESS_CODE=$(echo "${LIVENESS_RESP}" | tail -n 1)

if [[ "${LIVENESS_CODE}" == "200" ]]; then
  log_pass "GET /api/health returned HTTP 200"
else
  log_fail "GET /api/health returned HTTP ${LIVENESS_CODE} (expected 200)"
fi

LIVENESS_STATUS=$(echo "${LIVENESS_BODY}" | jq -r '.status // empty' 2>/dev/null || true)
LIVENESS_SUCCESS=$(echo "${LIVENESS_BODY}" | jq -r '.success // empty' 2>/dev/null || true)

if [[ "${LIVENESS_STATUS}" == "live" && "${LIVENESS_SUCCESS}" == "true" ]]; then
  log_pass "GET /api/health JSON payload valid (status: live, success: true)"
else
  log_fail "GET /api/health JSON payload invalid: ${LIVENESS_BODY}"
fi

# 1.2 Database Readiness Probe
log_info "1.2 Verifying Database Readiness Probe (GET /api/health/ready)..."
READINESS_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/health/ready")
READINESS_BODY=$(echo "${READINESS_RESP}" | sed '$d')
READINESS_CODE=$(echo "${READINESS_RESP}" | tail -n 1)

if [[ "${READINESS_CODE}" == "200" ]]; then
  log_pass "GET /api/health/ready returned HTTP 200"
else
  log_fail "GET /api/health/ready returned HTTP ${READINESS_CODE} (expected 200)"
fi

READINESS_STATUS=$(echo "${READINESS_BODY}" | jq -r '.status // empty' 2>/dev/null || true)
READINESS_DB=$(echo "${READINESS_BODY}" | jq -r '.database // empty' 2>/dev/null || true)

if [[ "${READINESS_STATUS}" == "ready" && "${READINESS_DB}" == "connected" ]]; then
  log_pass "GET /api/health/ready confirmed database: connected, status: ready"
else
  log_fail "GET /api/health/ready database probe failed: ${READINESS_BODY}"
fi

# 1.3 Root API Info Probe
log_info "1.3 Verifying Root API Info Probe (GET /api/)..."
API_ROOT_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/")
API_ROOT_BODY=$(echo "${API_ROOT_RESP}" | sed '$d')
API_ROOT_CODE=$(echo "${API_ROOT_RESP}" | tail -n 1)

if [[ "${API_ROOT_CODE}" == "200" ]]; then
  log_pass "GET /api/ returned HTTP 200"
else
  log_fail "GET /api/ returned HTTP ${API_ROOT_CODE} (expected 200)"
fi

API_VERSION=$(echo "${API_ROOT_BODY}" | jq -r '.version // empty' 2>/dev/null || true)
if [[ "${API_VERSION}" == "1.0.0" ]]; then
  log_pass "GET /api version is 1.0.0"
else
  log_fail "GET /api version unexpected: ${API_ROOT_BODY}"
fi

# ==============================================================================
# Suite 2: Frontend SPA and Static Assets Verification
# ==============================================================================
print_header "Suite 2: Frontend SPA and Static Assets Verification"

# 2.1 Frontend SPA Index
log_info "2.1 Verifying Frontend SPA Index (GET /)..."
SPA_RESP=$(curl -s -i "${TARGET_URL}/")
SPA_CODE=$(echo "${SPA_RESP}" | grep -E "^HTTP/[1-2](\.[0-9])? " | awk '{print $2}' | tail -n 1)

if [[ "${SPA_CODE}" == "200" ]]; then
  log_pass "GET / returned HTTP 200"
else
  log_fail "GET / returned HTTP ${SPA_CODE} (expected 200)"
fi

if echo "${SPA_RESP}" | grep -qi -E "(<div id=\"root\"|<html|<!doctype html)"; then
  log_pass "GET / returned valid HTML with SPA root container"
else
  log_fail "GET / did not contain expected HTML structure"
fi

# 2.2 Security Headers on Frontend SPA
log_info "2.2 Verifying Security Headers on Frontend SPA (GET /)..."
X_FRAME=$(echo "${SPA_RESP}" | grep -i "^X-Frame-Options:" | tr -d '\r' | awk -F': ' '{print $2}')
X_CONTENT=$(echo "${SPA_RESP}" | grep -i "^X-Content-Type-Options:" | tr -d '\r' | awk -F': ' '{print $2}')
REF_POLICY=$(echo "${SPA_RESP}" | grep -i "^Referrer-Policy:" | tr -d '\r' | awk -F': ' '{print $2}')
CSP_HEADER=$(echo "${SPA_RESP}" | grep -i "^Content-Security-Policy:" | tr -d '\r' | awk -F': ' '{print $2}')

if [[ "$(to_lower "${X_FRAME}")" =~ "sameorigin" ]]; then
  log_pass "Header X-Frame-Options: SAMEORIGIN verified"
else
  log_fail "Header X-Frame-Options missing or invalid: '${X_FRAME}'"
fi

if [[ "$(to_lower "${X_CONTENT}")" =~ "nosniff" ]]; then
  log_pass "Header X-Content-Type-Options: nosniff verified"
else
  log_fail "Header X-Content-Type-Options missing or invalid: '${X_CONTENT}'"
fi

if [[ "$(to_lower "${REF_POLICY}")" =~ "strict-origin-when-cross-origin" ]]; then
  log_pass "Header Referrer-Policy: strict-origin-when-cross-origin verified"
else
  log_fail "Header Referrer-Policy missing or invalid: '${REF_POLICY}'"
fi

if [[ "$(to_lower "${CSP_HEADER}")" =~ "frame-ancestors 'self'" ]]; then
  log_pass "Header Content-Security-Policy: frame-ancestors 'self' verified"
else
  log_fail "Header Content-Security-Policy missing or invalid: '${CSP_HEADER}'"
fi

# 2.3 Static Asset Caching and Protection Headers
STATIC_ASSET_PATH=$(curl -s "${TARGET_URL}/" | grep -o 'assets/[^"]*' | head -n 1 || true)
if [[ -z "${STATIC_ASSET_PATH}" ]]; then
  STATIC_ASSET_PATH="assets/index-CfC2cyAf.css"
fi
log_info "2.3 Verifying Static Asset Caching Rule (GET /${STATIC_ASSET_PATH})..."
ASSET_RESP=$(curl -s -i "${TARGET_URL}/${STATIC_ASSET_PATH}")
ASSET_CACHE=$(echo "${ASSET_RESP}" | grep -i "^Cache-Control:" | tr -d '\r' | awk -F': ' '{print $2}')
ASSET_X_CONTENT=$(echo "${ASSET_RESP}" | grep -i "^X-Content-Type-Options:" | tr -d '\r' | awk -F': ' '{print $2}')

if [[ "$(to_lower "${ASSET_CACHE}")" =~ "public, no-transform" ]]; then
  log_pass "Static asset Cache-Control verified: 'public, no-transform'"
else
  log_fail "Static asset Cache-Control missing or invalid: '${ASSET_CACHE}'"
fi

if [[ "$(to_lower "${ASSET_X_CONTENT}")" =~ "nosniff" ]]; then
  log_pass "Static asset X-Content-Type-Options: nosniff verified"
else
  log_fail "Static asset X-Content-Type-Options missing or invalid: '${ASSET_X_CONTENT}'"
fi

# ==============================================================================
# Suite 3: Security Headers on API Reverse Proxy
# ==============================================================================
print_header "Suite 3: Security Headers on API Reverse Proxy"

log_info "3.1 Verifying Helmet Security Headers on API Endpoints (GET /api/health)..."
API_HEADERS_RESP=$(curl -s -i "${TARGET_URL}/api/health")
API_X_CONTENT=$(echo "${API_HEADERS_RESP}" | grep -i "^x-content-type-options:" | tr -d '\r' | awk -F': ' '{print $2}')
API_X_FRAME=$(echo "${API_HEADERS_RESP}" | grep -i "^x-frame-options:" | tr -d '\r' | awk -F': ' '{print $2}')

if [[ "$(to_lower "${API_X_CONTENT}")" =~ "nosniff" ]]; then
  log_pass "API Header x-content-type-options: nosniff verified"
else
  log_fail "API Header x-content-type-options missing or invalid: '${API_X_CONTENT}'"
fi

if [[ "$(to_lower "${API_X_FRAME}")" =~ "sameorigin" ]]; then
  log_pass "API Header x-frame-options: SAMEORIGIN verified"
else
  log_fail "API Header x-frame-options missing or invalid: '${API_X_FRAME}'"
fi

# ==============================================================================
# Suite 4: Authentication and Authorization Endpoints
# ==============================================================================
print_header "Suite 4: Authentication and Authorization Endpoints"

# 4.1 GET /api/auth/me unauthenticated must return 401
log_info "4.1 Verifying unauthenticated GET /api/auth/me returns 401..."
AUTH_ME_UNAUTH_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/auth/me")
AUTH_ME_UNAUTH_BODY=$(echo "${AUTH_ME_UNAUTH_RESP}" | sed '$d')
AUTH_ME_UNAUTH_CODE=$(echo "${AUTH_ME_UNAUTH_RESP}" | tail -n 1)

if [[ "${AUTH_ME_UNAUTH_CODE}" == "401" ]]; then
  log_pass "Unauthenticated GET /api/auth/me returned HTTP 401"
else
  log_fail "Unauthenticated GET /api/auth/me returned HTTP ${AUTH_ME_UNAUTH_CODE} (expected 401)"
fi

AUTH_ME_MSG=$(echo "${AUTH_ME_UNAUTH_BODY}" | jq -r '.message // empty' 2>/dev/null || true)
if [[ "${AUTH_ME_MSG}" == "Not authorized, no token provided" ]]; then
  log_pass "Unauthenticated GET /api/auth/me error message correctly sanitized"
else
  log_fail "Unauthenticated GET /api/auth/me message unexpected: '${AUTH_ME_MSG}'"
fi

# 4.2 GET /api/auth/me with invalid token must return 401
log_info "4.2 Verifying GET /api/auth/me with invalid Bearer token returns 401..."
AUTH_ME_BAD_RESP=$(curl -s -w "\n%{http_code}" -H "Authorization: Bearer invalid.token.signature" "${TARGET_URL}/api/auth/me")
AUTH_ME_BAD_CODE=$(echo "${AUTH_ME_BAD_RESP}" | tail -n 1)

if [[ "${AUTH_ME_BAD_CODE}" == "401" ]]; then
  log_pass "Invalid Bearer token GET /api/auth/me returned HTTP 401"
else
  log_fail "Invalid Bearer token GET /api/auth/me returned HTTP ${AUTH_ME_BAD_CODE} (expected 401)"
fi

# 4.3 GET /api/auth/logout must return 404 (preventing state modification via GET)
log_info "4.3 Verifying GET /api/auth/logout returns 404..."
LOGOUT_GET_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/auth/logout")
LOGOUT_GET_BODY=$(echo "${LOGOUT_GET_RESP}" | sed '$d')
LOGOUT_GET_CODE=$(echo "${LOGOUT_GET_RESP}" | tail -n 1)

if [[ "${LOGOUT_GET_CODE}" == "404" ]]; then
  log_pass "GET /api/auth/logout returned HTTP 404"
else
  log_fail "GET /api/auth/logout returned HTTP ${LOGOUT_GET_CODE} (expected 404)"
fi

LOGOUT_GET_MSG=$(echo "${LOGOUT_GET_BODY}" | jq -r '.message // empty' 2>/dev/null || true)
if [[ "${LOGOUT_GET_MSG}" =~ "Not Found - /api/auth/logout" ]]; then
  log_pass "GET /api/auth/logout response formatted correctly as 404"
else
  log_fail "GET /api/auth/logout message unexpected: '${LOGOUT_GET_MSG}'"
fi

# 4.4 POST /api/auth/logout CSRF enforcement: Missing Origin header must return 403
log_info "4.4 Verifying POST /api/auth/logout without Origin header returns 403 (CSRF Protection)..."
LOGOUT_NO_ORIGIN_RESP=$(curl -s -w "\n%{http_code}" -X POST "${TARGET_URL}/api/auth/logout")
LOGOUT_NO_ORIGIN_BODY=$(echo "${LOGOUT_NO_ORIGIN_RESP}" | sed '$d')
LOGOUT_NO_ORIGIN_CODE=$(echo "${LOGOUT_NO_ORIGIN_RESP}" | tail -n 1)

if [[ "${LOGOUT_NO_ORIGIN_CODE}" == "403" ]]; then
  log_pass "POST /api/auth/logout without Origin header returned HTTP 403"
else
  log_fail "POST /api/auth/logout without Origin header returned HTTP ${LOGOUT_NO_ORIGIN_CODE} (expected 403)"
fi

LOGOUT_NO_ORIGIN_MSG=$(echo "${LOGOUT_NO_ORIGIN_BODY}" | jq -r '.message // empty' 2>/dev/null || true)
if [[ "${LOGOUT_NO_ORIGIN_MSG}" == "Forbidden: invalid or untrusted request origin" ]]; then
  log_pass "POST /api/auth/logout CSRF error message verified"
else
  log_fail "POST /api/auth/logout CSRF message unexpected: '${LOGOUT_NO_ORIGIN_MSG}'"
fi

# 4.5 POST /api/auth/logout CSRF enforcement: Untrusted Origin header must return 403
log_info "4.5 Verifying POST /api/auth/logout with untrusted Origin returns 403..."
LOGOUT_EVIL_ORIGIN_RESP=$(curl -s -w "\n%{http_code}" -X POST -H "Origin: https://evil-attacker.example.com" "${TARGET_URL}/api/auth/logout")
LOGOUT_EVIL_ORIGIN_CODE=$(echo "${LOGOUT_EVIL_ORIGIN_RESP}" | tail -n 1)

if [[ "${LOGOUT_EVIL_ORIGIN_CODE}" == "403" ]]; then
  log_pass "POST /api/auth/logout with untrusted Origin returned HTTP 403"
else
  log_fail "POST /api/auth/logout with untrusted Origin returned HTTP ${LOGOUT_EVIL_ORIGIN_CODE} (expected 403)"
fi

# 4.6 Non-destructive Auth allowlist verification using an isolated ephemeral smoke user
log_info "4.6 Verifying authenticated GET /api/auth/me returns strictly allowlisted fields..."
EPHEMERAL_EMAIL="smoke_qa_$(date +%s)_$RANDOM@paperless-smoke.local"
COOKIE_JAR=$(mktemp)
chmod 600 "${COOKIE_JAR}"

STAGING_ORIGIN="${STAGING_ORIGIN:-${ORIGIN:-}}"
if [[ -z "${STAGING_ORIGIN}" ]]; then
  STAGING_ORIGIN=$(grep '^FRONTEND_URL=' .env.staging 2>/dev/null | cut -d '=' -f 2- | tr -d ' "' || true)
fi
if [[ -z "${STAGING_ORIGIN}" ]]; then
  STAGING_ORIGIN="${TARGET_URL}"
fi

REGISTER_RESP=$(curl -s -w "\n%{http_code}" -c "${COOKIE_JAR}" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: ${STAGING_ORIGIN}" \
  -d "{\"name\":\"QA Smoke Tester\",\"email\":\"${EPHEMERAL_EMAIL}\",\"password\":\"SmokeP@ssw0rd!\"}" \
  "${TARGET_URL}/api/auth/register")
REGISTER_BODY=$(echo "${REGISTER_RESP}" | sed '$d')
REGISTER_CODE=$(echo "${REGISTER_RESP}" | tail -n 1)

if [[ "${REGISTER_CODE}" == "201" ]]; then
  log_pass "Ephemeral smoke user registration succeeded (HTTP 201)"
else
  log_fail "Ephemeral smoke user registration failed (HTTP ${REGISTER_CODE}): ${REGISTER_BODY}"
fi

# Query /api/auth/me with session cookie
AUTH_ME_ACTIVE_RESP=$(curl -s -w "\n%{http_code}" -b "${COOKIE_JAR}" "${TARGET_URL}/api/auth/me")
AUTH_ME_ACTIVE_BODY=$(echo "${AUTH_ME_ACTIVE_RESP}" | sed '$d')
AUTH_ME_ACTIVE_CODE=$(echo "${AUTH_ME_ACTIVE_RESP}" | tail -n 1)

if [[ "${AUTH_ME_ACTIVE_CODE}" == "200" ]]; then
  log_pass "Authenticated GET /api/auth/me returned HTTP 200"
else
  log_fail "Authenticated GET /api/auth/me returned HTTP ${AUTH_ME_ACTIVE_CODE}: ${AUTH_ME_ACTIVE_BODY}"
fi

# Verify allowlist fields present
USER_DATA_EMAIL=$(echo "${AUTH_ME_ACTIVE_BODY}" | jq -r '.data.email // empty' 2>/dev/null || true)
USER_DATA_NAME=$(echo "${AUTH_ME_ACTIVE_BODY}" | jq -r '.data.name // empty' 2>/dev/null || true)
USER_DATA_ID=$(echo "${AUTH_ME_ACTIVE_BODY}" | jq -r '.data.id // empty' 2>/dev/null || true)

if [[ "${USER_DATA_EMAIL}" == "${EPHEMERAL_EMAIL}" && -n "${USER_DATA_NAME}" && -n "${USER_DATA_ID}" ]]; then
  log_pass "Authenticated GET /api/auth/me returned expected user profile fields"
else
  log_fail "Authenticated GET /api/auth/me profile fields incomplete: ${AUTH_ME_ACTIVE_BODY}"
fi

# Verify sensitive fields are strictly excluded
HAS_PASSWORD=$(echo "${AUTH_ME_ACTIVE_BODY}" | jq 'has("password") or (.data | has("password"))' 2>/dev/null || echo "true")
HAS_REFRESH=$(echo "${AUTH_ME_ACTIVE_BODY}" | jq 'has("refreshTokens") or (.data | has("refreshTokens"))' 2>/dev/null || echo "true")
HAS_RESET_TOKEN=$(echo "${AUTH_ME_ACTIVE_BODY}" | jq 'has("resetPasswordToken") or (.data | has("resetPasswordToken"))' 2>/dev/null || echo "true")
HAS_LOGOUT_AT=$(echo "${AUTH_ME_ACTIVE_BODY}" | jq 'has("lastLogoutAt") or (.data | has("lastLogoutAt"))' 2>/dev/null || echo "true")

if [[ "${HAS_PASSWORD}" == "false" && "${HAS_REFRESH}" == "false" && "${HAS_RESET_TOKEN}" == "false" && "${HAS_LOGOUT_AT}" == "false" ]]; then
  log_pass "Strict allowlist confirmed: password, refreshTokens, and reset tokens excluded"
else
  log_fail "Sensitive data leak detected in /api/auth/me response (forbidden attributes present)"
fi

# 4.7 Clean logout of ephemeral test user using trusted Origin
log_info "4.7 Verifying POST /api/auth/logout with valid Origin and session cookie..."
LOGOUT_VALID_RESP=$(curl -s -i -b "${COOKIE_JAR}" -c "${COOKIE_JAR}" -X POST \
  -H "Origin: ${STAGING_ORIGIN}" \
  "${TARGET_URL}/api/auth/logout")
LOGOUT_VALID_CODE=$(echo "${LOGOUT_VALID_RESP}" | grep -E "^HTTP/[1-2](\.[0-9])? " | awk '{print $2}' | tail -n 1)

if [[ "${LOGOUT_VALID_CODE}" == "200" ]]; then
  log_pass "POST /api/auth/logout with valid Origin returned HTTP 200"
else
  log_fail "POST /api/auth/logout with valid Origin returned HTTP ${LOGOUT_VALID_CODE}"
fi

if echo "${LOGOUT_VALID_RESP}" | grep -qi "token=none"; then
  log_pass "POST /api/auth/logout cleared session cookies"
else
  log_fail "POST /api/auth/logout did not return cookie clearing header"
fi

rm -f "${COOKIE_JAR}"
COOKIE_JAR=""

# ==============================================================================
# Suite 5: Multipart Upload Ingestion Boundary Validation
# ==============================================================================
print_header "Suite 5: Multipart Upload Ingestion Boundary Validation"

# Sentinel non-existent form ID ensures complete non-destructiveness
SENTINEL_FORM_ID="000000000000000000000000"

# 5.1 Rejection of Oversized File (> 5MB)
log_info "5.1 Verifying rejection of oversized file (> 5MB limit)..."
OVERSIZED_TEMP=$(mktemp)
dd if=/dev/zero of="${OVERSIZED_TEMP}" bs=1M count=6 2>/dev/null

OVERSIZED_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -F "answers=[]" \
  -F "file=@${OVERSIZED_TEMP};filename=large_file.pdf;type=application/pdf" \
  "${TARGET_URL}/api/responses/${SENTINEL_FORM_ID}")
rm -f "${OVERSIZED_TEMP}"
OVERSIZED_TEMP=""

OVERSIZED_BODY=$(echo "${OVERSIZED_RESP}" | sed '$d')
OVERSIZED_CODE=$(echo "${OVERSIZED_RESP}" | tail -n 1)

if [[ "${OVERSIZED_CODE}" == "400" ]]; then
  log_pass "Oversized file upload returned HTTP 400 Bad Request"
else
  log_fail "Oversized file upload returned HTTP ${OVERSIZED_CODE} (expected 400)"
fi

OVERSIZED_MSG=$(echo "${OVERSIZED_BODY}" | jq -r '.message // empty' 2>/dev/null || true)
if [[ "${OVERSIZED_MSG}" == "File size exceeds maximum limit of 5MB" ]]; then
  log_pass "Oversized file error message matches sanitized string: '${OVERSIZED_MSG}'"
else
  log_fail "Oversized file error message unexpected: '${OVERSIZED_MSG}'"
fi

# 5.2 Rejection of Excessive Files (> 10 files)
log_info "5.2 Verifying rejection of excessive files (> 10 files limit)..."
SMALL_TEMP=$(mktemp)
echo "sample non-destructive data" > "${SMALL_TEMP}"

EXCESSIVE_FILES_CURL=(curl -s -w "\n%{http_code}" -X POST "${TARGET_URL}/api/responses/${SENTINEL_FORM_ID}" -F "answers=[]")
for i in {1..11}; do
  EXCESSIVE_FILES_CURL+=(-F "file_${i}=@${SMALL_TEMP};filename=test_${i}.txt;type=text/plain")
done

EXCESSIVE_FILES_RESP=$("${EXCESSIVE_FILES_CURL[@]}")
EXCESSIVE_FILES_BODY=$(echo "${EXCESSIVE_FILES_RESP}" | sed '$d')
EXCESSIVE_FILES_CODE=$(echo "${EXCESSIVE_FILES_RESP}" | tail -n 1)

if [[ "${EXCESSIVE_FILES_CODE}" == "400" ]]; then
  log_pass "Excessive files upload returned HTTP 400 Bad Request"
else
  log_fail "Excessive files upload returned HTTP ${EXCESSIVE_FILES_CODE} (expected 400)"
fi

EXCESSIVE_FILES_MSG=$(echo "${EXCESSIVE_FILES_BODY}" | jq -r '.message // empty' 2>/dev/null || true)
if [[ "${EXCESSIVE_FILES_MSG}" == "Too many files uploaded (maximum 10 allowed)" ]]; then
  log_pass "Excessive files error message matches sanitized string: '${EXCESSIVE_FILES_MSG}'"
else
  log_fail "Excessive files error message unexpected: '${EXCESSIVE_FILES_MSG}'"
fi

# 5.3 Rejection of Excessive Form Fields (> 50 fields)
log_info "5.3 Verifying rejection of excessive form fields (> 50 fields limit)..."
EXCESSIVE_FIELDS_CURL=(curl -s -w "\n%{http_code}" -X POST "${TARGET_URL}/api/responses/${SENTINEL_FORM_ID}")
for i in {1..52}; do
  EXCESSIVE_FIELDS_CURL+=(-F "field_${i}=value_${i}")
done

EXCESSIVE_FIELDS_RESP=$("${EXCESSIVE_FIELDS_CURL[@]}")
EXCESSIVE_FIELDS_BODY=$(echo "${EXCESSIVE_FIELDS_RESP}" | sed '$d')
EXCESSIVE_FIELDS_CODE=$(echo "${EXCESSIVE_FIELDS_RESP}" | tail -n 1)

if [[ "${EXCESSIVE_FIELDS_CODE}" == "400" ]]; then
  log_pass "Excessive fields upload returned HTTP 400 Bad Request"
else
  log_fail "Excessive fields upload returned HTTP ${EXCESSIVE_FIELDS_CODE} (expected 400)"
fi

EXCESSIVE_FIELDS_MSG=$(echo "${EXCESSIVE_FIELDS_BODY}" | jq -r '.message // empty' 2>/dev/null || true)
if [[ "${EXCESSIVE_FIELDS_MSG}" == "Too many form fields (maximum 50 allowed)" ]]; then
  log_pass "Excessive fields error message matches sanitized string: '${EXCESSIVE_FIELDS_MSG}'"
else
  log_fail "Excessive fields error message unexpected: '${EXCESSIVE_FIELDS_MSG}'"
fi

# 5.4 Rejection of Excessive Multipart Parts (> 60 parts)
log_info "5.4 Verifying rejection of excessive multipart parts (> 60 parts limit)..."
EXCESSIVE_PARTS_CURL=(curl -s -w "\n%{http_code}" -X POST "${TARGET_URL}/api/responses/${SENTINEL_FORM_ID}")
for i in {1..62}; do
  EXCESSIVE_PARTS_CURL+=(-F "part_${i}=val_${i}")
done

EXCESSIVE_PARTS_RESP=$("${EXCESSIVE_PARTS_CURL[@]}")
EXCESSIVE_PARTS_BODY=$(echo "${EXCESSIVE_PARTS_RESP}" | sed '$d')
EXCESSIVE_PARTS_CODE=$(echo "${EXCESSIVE_PARTS_RESP}" | tail -n 1)

if [[ "${EXCESSIVE_PARTS_CODE}" == "400" ]]; then
  log_pass "Excessive parts upload returned HTTP 400 Bad Request"
else
  log_fail "Excessive parts upload returned HTTP ${EXCESSIVE_PARTS_CODE} (expected 400)"
fi

EXCESSIVE_PARTS_MSG=$(echo "${EXCESSIVE_PARTS_BODY}" | jq -r '.message // empty' 2>/dev/null || true)
if [[ "${EXCESSIVE_PARTS_MSG}" == "Too many multipart parts (maximum 60 allowed)" || "${EXCESSIVE_PARTS_MSG}" == "Too many form fields (maximum 50 allowed)" ]]; then
  log_pass "Excessive parts error message matches sanitized string: '${EXCESSIVE_PARTS_MSG}'"
else
  log_fail "Excessive parts error message unexpected: '${EXCESSIVE_PARTS_MSG}'"
fi

rm -f "${SMALL_TEMP}"
SMALL_TEMP=""

# 5.5 Rejection of Malformed Multipart Request
log_info "5.5 Verifying rejection of malformed multipart request..."
MALFORMED_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: multipart/form-data; boundary=boundary_without_terminator" \
  --data-raw "malformed-unparsed-stream" \
  "${TARGET_URL}/api/responses/${SENTINEL_FORM_ID}")
MALFORMED_BODY=$(echo "${MALFORMED_RESP}" | sed '$d')
MALFORMED_CODE=$(echo "${MALFORMED_RESP}" | tail -n 1)

if [[ "${MALFORMED_CODE}" == "400" ]]; then
  log_pass "Malformed multipart request returned HTTP 400 Bad Request"
else
  log_fail "Malformed multipart request returned HTTP ${MALFORMED_CODE} (expected 400)"
fi

MALFORMED_MSG=$(echo "${MALFORMED_BODY}" | jq -r '.message // empty' 2>/dev/null || true)
if [[ "${MALFORMED_MSG}" == "Invalid upload request" ]]; then
  log_pass "Malformed multipart error message sanitized without path leakage"
else
  log_fail "Malformed multipart error message unexpected: '${MALFORMED_MSG}'"
fi

# ==============================================================================
# Suite 6: Error Handling and Stack Trace Suppression
# ==============================================================================
print_header "Suite 6: Error Handling and Stack Trace Suppression in Staging"

# 6.1 Unmapped 404 Route does not leak stack trace
log_info "6.1 Verifying unmapped endpoint returns 404 without stack trace..."
NOT_FOUND_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/smoke_test_unmapped_probe")
NOT_FOUND_BODY=$(echo "${NOT_FOUND_RESP}" | sed '$d')
NOT_FOUND_CODE=$(echo "${NOT_FOUND_RESP}" | tail -n 1)

if [[ "${NOT_FOUND_CODE}" == "404" ]]; then
  log_pass "Unmapped route returned HTTP 404"
else
  log_fail "Unmapped route returned HTTP ${NOT_FOUND_CODE} (expected 404)"
fi

HAS_STACK_404=$(echo "${NOT_FOUND_BODY}" | jq 'has("stack")' 2>/dev/null || echo "true")
if [[ "${HAS_STACK_404}" == "false" ]]; then
  log_pass "HTTP 404 response does not leak stack trace"
else
  log_fail "HTTP 404 response leaked stack trace: ${NOT_FOUND_BODY}"
fi

# 6.2 Malformed Resource ID (CastError) does not leak stack trace
log_info "6.2 Verifying invalid ObjectId CastError returns 400 without stack trace..."
CAST_ERR_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/forms/invalid_object_id_string")
CAST_ERR_BODY=$(echo "${CAST_ERR_RESP}" | sed '$d')
CAST_ERR_CODE=$(echo "${CAST_ERR_RESP}" | tail -n 1)

if [[ "${CAST_ERR_CODE}" == "400" ]]; then
  log_pass "Invalid resource ID returned HTTP 400 Bad Request"
else
  log_fail "Invalid resource ID returned HTTP ${CAST_ERR_CODE} (expected 400)"
fi

HAS_STACK_CAST=$(echo "${CAST_ERR_BODY}" | jq 'has("stack")' 2>/dev/null || echo "true")
if [[ "${HAS_STACK_CAST}" == "false" ]]; then
  log_pass "CastError response does not leak stack trace"
else
  log_fail "CastError response leaked stack trace: ${CAST_ERR_BODY}"
fi

# 6.3 Malformed JSON Body does not leak stack trace
log_info "6.3 Verifying malformed JSON payload returns 400 without stack trace..."
JSON_ERR_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  --data-raw '{"broken_json": ' \
  "${TARGET_URL}/api/auth/login")
JSON_ERR_BODY=$(echo "${JSON_ERR_RESP}" | sed '$d')
JSON_ERR_CODE=$(echo "${JSON_ERR_RESP}" | tail -n 1)

if [[ "${JSON_ERR_CODE}" == "400" ]]; then
  log_pass "Malformed JSON returned HTTP 400 Bad Request"
else
  log_fail "Malformed JSON returned HTTP ${JSON_ERR_CODE} (expected 400)"
fi

HAS_STACK_JSON=$(echo "${JSON_ERR_BODY}" | jq 'has("stack")' 2>/dev/null || echo "true")
if [[ "${HAS_STACK_JSON}" == "false" ]]; then
  log_pass "Malformed JSON response does not leak stack trace"
else
  log_fail "Malformed JSON response leaked stack trace: ${JSON_ERR_BODY}"
fi

# ==============================================================================
# Suite 7: Storage and Database Connectivity Verification
# ==============================================================================
print_header "Suite 7: Storage and Database Connectivity Verification"

log_info "7.1 Re-verifying database readiness probe..."
DB_CHECK_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/health/ready")
DB_CHECK_BODY=$(echo "${DB_CHECK_RESP}" | sed '$d')
DB_CHECK_CODE=$(echo "${DB_CHECK_RESP}" | tail -n 1)

if [[ "${DB_CHECK_CODE}" == "200" ]]; then
  log_pass "Database readiness check confirmed live MongoDB connection (HTTP 200)"
else
  log_fail "Database readiness check failed (HTTP ${DB_CHECK_CODE}): ${DB_CHECK_BODY}"
fi

log_info "7.2 Verifying protected storage file download endpoint auth contract..."
FILE_DL_RESP=$(curl -s -w "\n%{http_code}" "${TARGET_URL}/api/responses/${SENTINEL_FORM_ID}/000000000000000000000000/file/000000000000000000000000")
FILE_DL_CODE=$(echo "${FILE_DL_RESP}" | tail -n 1)

if [[ "${FILE_DL_CODE}" == "401" ]]; then
  log_pass "Protected storage file endpoint enforces authentication (HTTP 401)"
else
  log_fail "Protected storage file endpoint returned HTTP ${FILE_DL_CODE} (expected 401)"
fi

# ==============================================================================
# Final Summary and Sign-off Evaluation
# ==============================================================================
print_header "Smoke-Test Suite Execution Summary"
echo -e "Total assertions executed: ${TOTAL_COUNT}"
echo -e "Passed assertions:         ${COLOR_GREEN}${PASS_COUNT}${COLOR_RESET}"
echo -e "Failed assertions:         ${COLOR_RED}${FAIL_COUNT}${COLOR_RESET}"

if [[ ${FAIL_COUNT} -eq 0 ]]; then
  echo ""
  echo -e "${COLOR_GREEN}>>> POST-DEPLOYMENT SMOKE TESTS PASSED: RELEASE READY FOR STAGING SIGN-OFF <<<${COLOR_RESET}"
  exit 0
else
  echo ""
  echo -e "${COLOR_RED}>>> POST-DEPLOYMENT SMOKE TESTS FAILED: DO NOT SIGN OFF RELEASE <<<${COLOR_RESET}"
  exit 1
fi
