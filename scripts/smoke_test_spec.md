# Post-Deployment Smoke-Test Specification and QA Design

Target Environment: Paperless Staging (Default: http://127.0.0.1:8080)
Target Commit: `69d7926f2256bdd7a9a4726d3be0d51679d4b7ed` on branch `main`
Automation Script: [smoke_test_staging.sh](file:///Users/anurag/Developer/paperless/scripts/smoke_test_staging.sh)

---

## 1. Endpoint Catalog and Routing Architecture

Paperless staging operates behind an Nginx reverse proxy mapped to port 8080 on loopback (`127.0.0.1:8080`), configured in [docker-compose.staging.yml](file:///Users/anurag/Developer/paperless/docker-compose.staging.yml#L100-L105) and [nginx.conf](file:///Users/anurag/Developer/paperless/client/nginx.conf#L1-L41).

| Endpoint Path | HTTP Method | Access Level | Component Handler | Validation Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `/` | `GET` | Public | [nginx.conf](file:///Users/anurag/Developer/paperless/client/nginx.conf#L27-L33) | SPA HTML index delivery and security headers |
| `/*.(js\|css\|png\|...)` | `GET` | Public | [nginx.conf](file:///Users/anurag/Developer/paperless/client/nginx.conf#L36-L40) | Static asset caching and content sniffing prevention |
| `/api` | `GET` | Public | [server.js](file:///Users/anurag/Developer/paperless/server/src/server.js#L142-L154) | Root API service discovery and version metadata |
| `/api/health` | `GET` | Public | [server.js](file:///Users/anurag/Developer/paperless/server/src/server.js#L112-L119) | Application liveness probe |
| `/api/health/ready` | `GET` | Public | [`readinessHandler`](file:///Users/anurag/Developer/paperless/server/src/server.js#L122-L133) | Database and backing service readiness probe |
| `/api/auth/me` | `GET` | Protected | [`getMe`](file:///Users/anurag/Developer/paperless/server/src/controllers/authController.js#L303-L322) | Identity verification with strict allowlist (no secrets/tokens) |
| `/api/auth/logout` | `GET` | Blocked (404) | [authRoutes.js](file:///Users/anurag/Developer/paperless/server/src/routes/authRoutes.js#L37) | Prevention of state mutation via safe GET request |
| `/api/auth/logout` | `POST` | Protected / CSRF | [`logout`](file:///Users/anurag/Developer/paperless/server/src/controllers/authController.js#L208-L296) | CSRF origin validation, session revocation, cookie invalidation |
| `/api/responses/:formId` | `POST` | Public | [`handleMultipartUpload`](file:///Users/anurag/Developer/paperless/server/src/routes/responseRoutes.js#L92-L138) | Multipart ingestion limits enforcement and payload validation |
| `/api/responses/:formId/:responseId/file/:questionId` | `GET` | Protected | [`downloadResponseFile`](file:///Users/anurag/Developer/paperless/server/src/controllers/responseController.js#L886-L928) | Storage service access gate and download authorization |
| `/api/forms/:id` | `GET` | Public / Optional | [`getForm`](file:///Users/anurag/Developer/paperless/server/src/controllers/formController.js#L39-L65) | CastError handling and error sanitization verification |

---

## 2. Executable Test Suite with Exact curl Commands

The following test steps provide exact curl commands, HTTP response codes, headers, and JSON structure assertions for post-deployment verification.

### Suite 1: Health and Backing Service Readiness

#### Test 1.1: Application Liveness Probe
- Purpose: Verify that the Node.js Express process is up and responding through Nginx.
- Command:
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:8080/api/health
```
- Expected Status Code: `200 OK`
- Expected Headers:
  - `Content-Type: application/json; charset=utf-8`
- Expected JSON Structure:
```json
{
  "success": true,
  "status": "live",
  "message": "Server is running",
  "timestamp": "<ISO-8601 String>"
}
```

#### Test 1.2: Database Readiness Probe
- Purpose: Verify MongoDB connectivity from within the application container.
- Command:
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:8080/api/health/ready
```
- Expected Status Code: `200 OK` (returns `503 Service Unavailable` if database is down)
- Expected JSON Structure:
```json
{
  "success": true,
  "status": "ready",
  "database": "connected",
  "timestamp": "<ISO-8601 String>"
}
```

#### Test 1.3: Root API Documentation Probe
- Purpose: Verify API service discovery index.
- Command:
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:8080/api
```
- Expected Status Code: `200 OK`
- Expected JSON Structure:
```json
{
  "success": true,
  "message": "Welcome to Paperless API",
  "version": "1.0.0",
  "endpoints": {
    "auth": "/api/auth",
    "forms": "/api/forms",
    "responses": "/api/responses",
    "ai": "/api/ai"
  }
}
```

---

### Suite 2: Frontend SPA and Static Assets Verification

#### Test 2.1: Frontend SPA Index Delivery
- Purpose: Verify Nginx serves the Vite single-page application root.
- Command:
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:8080/
```
- Expected Status Code: `200 OK`
- Expected Content: Valid HTML containing `<!doctype html>` and root container `<div id="root"></div>`.

#### Test 2.2: Frontend Security Headers on Root Path
- Purpose: Verify security headers configured in [nginx.conf](file:///Users/anurag/Developer/paperless/client/nginx.conf#L29-L32).
- Command:
```bash
curl -s -I http://127.0.0.1:8080/
```
- Expected Header Assertions:
  - `X-Frame-Options: SAMEORIGIN`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Content-Security-Policy: frame-ancestors 'self'`

#### Test 2.3: Static Asset Caching and Header Verification
- Purpose: Verify Nginx asset caching and protection rules for static files.
- Command:
```bash
curl -s -I http://127.0.0.1:8080/test_probe.css
```
- Expected Header Assertions:
  - `Cache-Control: public, no-transform`
  - `X-Content-Type-Options: nosniff`

---

### Suite 3: Security Headers on Reverse Proxy & API

#### Test 3.1: Helmet Security Headers on API Gateway
- Purpose: Verify backend Helmet middleware execution on proxied requests.
- Command:
```bash
curl -s -I http://127.0.0.1:8080/api/health
```
- Expected Header Assertions:
  - `x-content-type-options: nosniff`
  - `x-frame-options: SAMEORIGIN`

---

### Suite 4: Authentication and Authorization Flow

#### Test 4.1: Unauthenticated User Info Query
- Purpose: Verify that unauthenticated requests to `/api/auth/me` are rejected with HTTP 401.
- Command:
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:8080/api/auth/me
```
- Expected Status Code: `401 Unauthorized`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Not authorized, no token provided"
}
```

#### Test 4.2: Invalid Token Authorization Attempt
- Purpose: Verify that forged or expired tokens are rejected.
- Command:
```bash
curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer invalid.jwt.signature" \
  http://127.0.0.1:8080/api/auth/me
```
- Expected Status Code: `401 Unauthorized`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Not authorized, token invalid or expired"
}
```

#### Test 4.3: Prohibition of GET on Logout Route
- Purpose: Verify GET `/api/auth/logout` returns 404 and does not modify session state.
- Command:
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:8080/api/auth/logout
```
- Expected Status Code: `404 Not Found`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Not Found - /api/auth/logout"
}
```

#### Test 4.4: POST Logout CSRF Rejection (Missing Origin)
- Purpose: Verify [`csrfProtection`](file:///Users/anurag/Developer/paperless/server/src/middleware/csrfProtection.js#L114-L127) blocks browser-like mutations lacking an Origin header.
- Command:
```bash
curl -s -w "\n%{http_code}" -X POST http://127.0.0.1:8080/api/auth/logout
```
- Expected Status Code: `403 Forbidden`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Forbidden: invalid or untrusted request origin"
}
```

#### Test 4.5: POST Logout CSRF Rejection (Untrusted Origin)
- Purpose: Verify CSRF middleware rejects untrusted origin domains.
- Command:
```bash
curl -s -w "\n%{http_code}" -X POST \
  -H "Origin: https://malicious-site.example.com" \
  http://127.0.0.1:8080/api/auth/logout
```
- Expected Status Code: `403 Forbidden`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Forbidden: invalid or untrusted request origin"
}
```

#### Test 4.6: Authenticated User Profile and Allowlist Audit
- Purpose: Verify that authenticated user profile returns strictly allowlisted fields and never leaks password hashes, refresh token arrays, or reset tokens.
- Commands:
```bash
COOKIE_FILE=$(mktemp)
TEST_EMAIL="smoke_test_$(date +%s)_$RANDOM@paperless-smoke.local"

# 1. Register ephemeral test account
curl -s -c "${COOKIE_FILE}" -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:8080" \
  -d "{\"name\":\"Smoke Tester\",\"email\":\"${TEST_EMAIL}\",\"password\":\"SmokeSecurePass123!\"}" \
  http://127.0.0.1:8080/api/auth/register

# 2. Fetch authenticated profile
curl -s -w "\n%{http_code}" -b "${COOKIE_FILE}" \
  http://127.0.0.1:8080/api/auth/me
```
- Expected Status Code: `200 OK`
- Expected JSON Structure:
```json
{
  "success": true,
  "data": {
    "_id": "<MongoDB-ObjectId>",
    "id": "<MongoDB-ObjectId>",
    "name": "Smoke Tester",
    "email": "<TEST_EMAIL>",
    "createdAt": "<ISO-8601 String>"
  }
}
```
- Strict Allowlist Assertions:
  - `data.password` MUST BE undefined.
  - `data.refreshTokens` MUST BE undefined.
  - `data.resetPasswordToken` MUST BE undefined.
  - `data.resetPasswordExpire` MUST BE undefined.
  - `data.lastLogoutAt` MUST BE undefined.

#### Test 4.7: Authenticated Session Termination via Trusted Origin
- Purpose: Verify clean logout with trusted Origin header and cookie clearing.
- Command:
```bash
curl -s -i -b "${COOKIE_FILE}" -X POST \
  -H "Origin: http://127.0.0.1:8080" \
  http://127.0.0.1:8080/api/auth/logout
rm -f "${COOKIE_FILE}"
```
- Expected Status Code: `200 OK`
- Expected Response Headers:
  - `Set-Cookie: token=none; Path=/; Expires=...; HttpOnly`
  - `Set-Cookie: refreshToken=none; Path=/; Expires=...; HttpOnly`
- Expected JSON Structure:
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

### Suite 5: Multipart Upload Boundary Validation

All multipart ingestion tests target the sentinel non-existent form ID `000000000000000000000000`. This guarantees complete non-destructiveness because Multer boundary validation triggers and cleans up files prior to any form handling.

#### Test 5.1: Rejection of Oversized File (> 5MB limit)
- Purpose: Verify Multer enforces `MAX_FILE_SIZE` (default 5MB) and returns a sanitized error message without leaking paths.
- Command:
```bash
TMP_LARGE=$(mktemp)
dd if=/dev/zero of="${TMP_LARGE}" bs=1M count=6 2>/dev/null

curl -s -w "\n%{http_code}" -X POST \
  -F "answers=[]" \
  -F "file=@${TMP_LARGE};filename=oversized.pdf;type=application/pdf" \
  http://127.0.0.1:8080/api/responses/000000000000000000000000
rm -f "${TMP_LARGE}"
```
- Expected Status Code: `400 Bad Request`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "File size exceeds maximum limit of 5MB"
}
```

#### Test 5.2: Rejection of Excessive Files (> 10 files limit)
- Purpose: Verify Multer enforces `MAX_UPLOAD_FILES` (maximum 10 allowed).
- Command:
```bash
TMP_SMALL=$(mktemp)
echo "smoke test payload" > "${TMP_SMALL}"

CMD=(curl -s -w "\n%{http_code}" -X POST http://127.0.0.1:8080/api/responses/000000000000000000000000 -F "answers=[]")
for i in {1..11}; do
  CMD+=(-F "file_${i}=@${TMP_SMALL};filename=doc_${i}.txt;type=text/plain")
done
"${CMD[@]}"
rm -f "${TMP_SMALL}"
```
- Expected Status Code: `400 Bad Request`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Too many files uploaded (maximum 10 allowed)"
}
```

#### Test 5.3: Rejection of Excessive Form Fields (> 50 fields limit)
- Purpose: Verify Multer enforces `MAX_UPLOAD_FIELDS` (maximum 50 allowed).
- Command:
```bash
CMD=(curl -s -w "\n%{http_code}" -X POST http://127.0.0.1:8080/api/responses/000000000000000000000000)
for i in {1..52}; do
  CMD+=(-F "field_${i}=val_${i}")
done
"${CMD[@]}"
```
- Expected Status Code: `400 Bad Request`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Too many form fields (maximum 50 allowed)"
}
```

#### Test 5.4: Rejection of Excessive Multipart Parts (> 60 parts limit)
- Purpose: Verify Multer enforces `MAX_UPLOAD_PARTS` (maximum 60 allowed).
- Command:
```bash
CMD=(curl -s -w "\n%{http_code}" -X POST http://127.0.0.1:8080/api/responses/000000000000000000000000)
for i in {1..62}; do
  CMD+=(-F "part_${i}=val_${i}")
done
"${CMD[@]}"
```
- Expected Status Code: `400 Bad Request`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Too many multipart parts (maximum 60 allowed)"
}
```

#### Test 5.5: Corrupted Multipart Stream Handling
- Purpose: Verify handling of truncated or invalid multipart boundaries without internal crash leaks.
- Command:
```bash
curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: multipart/form-data; boundary=corrupt_boundary_marker" \
  --data-raw "malformed-unclosed-stream" \
  http://127.0.0.1:8080/api/responses/000000000000000000000000
```
- Expected Status Code: `400 Bad Request`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Invalid upload request"
}
```

#### Non-Destructive Ingestion Failure Verification
Because Multer boundary validation is invoked in [`createMultipartUploadHandler`](file:///Users/anurag/Developer/paperless/server/src/routes/responseRoutes.js#L92-L135) before controller logic, any limit violation triggers immediate temporary file unlinking and returns HTTP 400. The underlying database response collection is never touched.

---

### Suite 6: Error Handling and Leak Prevention in Staging

#### Test 6.1: Unmapped Route 404 Masking
- Purpose: Verify unmapped endpoints return 404 without exposing stack traces.
- Command:
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:8080/api/smoke_test_unmapped_probe
```
- Expected Status Code: `404 Not Found`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Not Found - /api/smoke_test_unmapped_probe"
}
```
- Assertion: Property `stack` MUST BE undefined.

#### Test 6.2: Invalid Resource ID CastError Masking
- Purpose: Verify invalid ObjectId parameters return sanitized 400 without leaking Mongoose internal traces.
- Command:
```bash
curl -s -w "\n%{http_code}" http://127.0.0.1:8080/api/forms/invalid_object_id_string
```
- Expected Status Code: `400 Bad Request`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Invalid resource ID"
}
```
- Assertion: Property `stack` MUST BE undefined.

#### Test 6.3: Malformed JSON Syntax Masking
- Purpose: Verify Express body-parser syntax errors return 400 without internal directory paths.
- Command:
```bash
curl -s -w "\n%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  --data-raw '{"malformed_json_body": ' \
  http://127.0.0.1:8080/api/auth/login
```
- Expected Status Code: `400 Bad Request`
- Assertion: Property `stack` MUST BE undefined.

#### Test 6.4: Unhandled 500 Sanitization Contract
- Purpose: In staging (`NODE_ENV=production`), [`errorHandler`](file:///Users/anurag/Developer/paperless/server/src/middleware/errorHandler.js#L116-L124) masks any unexpected internal 500 error to:
```json
{
  "success": false,
  "message": "Internal Server Error"
}
```
Stack traces are strictly suppressed.

---

### Suite 7: Storage and Database Connectivity Verification

#### Test 7.1: MongoDB Operational Readiness
- Purpose: Confirm active MongoDB connection via application health interface.
- Command:
```bash
curl -s http://127.0.0.1:8080/api/health/ready | jq '{success, status, database}'
```
- Expected Output:
```json
{
  "success": true,
  "status": "ready",
  "database": "connected"
}
```

#### Test 7.2: Storage Service Access Gate Verification
- Purpose: Verify the storage download route contract without mutating storage bucket objects.
- Command:
```bash
curl -s -w "\n%{http_code}" \
  http://127.0.0.1:8080/api/responses/000000000000000000000000/000000000000000000000000/file/000000000000000000000000
```
- Expected Status Code: `401 Unauthorized`
- Expected JSON Structure:
```json
{
  "success": false,
  "message": "Not authorized, no token provided"
}
```
- Assertion: Storage routes are guarded by auth middleware before storage client streams are requested.

---

## 3. Safety and Non-Destructiveness Analysis

The smoke-test plan is strictly non-destructive:

1. Zero Real Data Mutation:
   All multipart and upload limit probes use sentinel ObjectId `000000000000000000000000`. No existing forms or user responses in the staging database are queried, updated, or removed.

2. Ephemeral User Lifecycle:
   The single auth test creates a dedicated ephemeral user (`smoke_qa_<timestamp>_<random>@paperless-smoke.local`), performs the read-only allowlist audit on `GET /api/auth/me`, and immediately terminates the session via `POST /api/auth/logout`.

3. Clean Temporary Storage and Signal Trapping:
   All temporary files in `/tmp` (cookie jars, oversized payloads, multipart parts) are created with restricted permissions (`chmod 600`). A centralized bash trap handler captures `EXIT`, `INT`, `TERM`, and `HUP` signals to guarantee immediate unlinking, even if the suite fails or is interrupted. Multer disk storage cleanup logic in [errorHandler.js](file:///Users/anurag/Developer/paperless/server/src/middleware/errorHandler.js#L12-L24) and [responseRoutes.js](file:///Users/anurag/Developer/paperless/server/src/routes/responseRoutes.js#L95-L107) unlinks rejected chunks from the server container.

4. Secret and Token Protection:
   No real API secrets, JWT secret keys, or MinIO root credentials are exchanged over test commands or printed in logs. Assertions validating exclusion of sensitive attributes in `/api/auth/me` do not output the response body upon failure, preventing credential leakage in test logs.

5. Preflight Target Reachability:
   The suite validates endpoint connectivity before running test suites. If the staging server is unreachable or offline, the script terminates immediately with exit code 2 and an informative diagnostic message rather than generating false-positive assertion failures.

6. Configuration Portability:
   The suite supports target URLs supplied via positional CLI argument or `TARGET_URL` environment variable (defaulting to `http://127.0.0.1:8080`). Origin headers adapt to `STAGING_ORIGIN`, `ORIGIN`, `.env.staging`, or the target URL automatically.

---

## 4. Criteria for Post-Deployment Release Sign-Off

The deployment may be signed off for staging release only when all of the following criteria are satisfied:

| Category | Verification Criterion | Status Requirement |
| :--- | :--- | :--- |
| Gateway & Health | `GET /api/health` returns HTTP 200 with `status: "live"` | Mandatory PASS |
| Database Connectivity | `GET /api/health/ready` returns HTTP 200 with `database: "connected"` | Mandatory PASS |
| Frontend Delivery | `GET /` returns HTTP 200 HTML with `#root` container | Mandatory PASS |
| Static Asset Policy | `GET /*.(js\|css)` returns `Cache-Control: public, no-transform` and `nosniff` | Mandatory PASS |
| Security Headers | `X-Frame-Options: SAMEORIGIN` and `X-Content-Type-Options: nosniff` present | Mandatory PASS |
| CSP Header | `Content-Security-Policy: frame-ancestors 'self'` present on frontend | Mandatory PASS |
| Authentication | `GET /api/auth/me` returns 401 when unauthenticated | Mandatory PASS |
| Allowlist Integrity | `GET /api/auth/me` returns ONLY allowlisted fields; excludes password and tokens | Mandatory PASS |
| Logout Method Guard | `GET /api/auth/logout` returns HTTP 404; session remains intact | Mandatory PASS |
| CSRF Origin Guard | `POST /api/auth/logout` rejects missing/untrusted Origin with HTTP 403 | Mandatory PASS |
| Upload Limits | Oversized, excessive files, fields, and parts rejected with sanitized 400 | Mandatory PASS |
| Error Masking | Staging responses never leak `stack` property, database traces, or server paths | Mandatory PASS |

### Immediate Rollback Triggers:
1. `GET /api/health/ready` returns HTTP 503 or `database: disconnected`.
2. Any auth endpoint leaks `password`, `refreshTokens`, or `resetPasswordToken`.
3. `POST /api/auth/logout` permits execution without Origin validation or Bearer auth.
4. Any 400, 404, or 500 error exposes a JavaScript stack trace or local server file path.
5. Oversized multipart payloads (> 5MB) bypass ingestion limits.
