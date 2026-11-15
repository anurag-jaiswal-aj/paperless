import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SecurityAuditService,
  SECURITY_AUDIT_EVENTS,
  DIAGNOSTIC_COUNTER_NAMES,
  incrementDiagnosticCounter,
  getDiagnosticCounters,
  resetDiagnosticCounters
} from './SecurityAuditService.js';
import { runWithRequestContext } from '../middleware/requestCorrelation.js';

describe('SecurityAuditService', () => {
  let mockLogger;
  let loggedRecords;

  beforeEach(() => {
    resetDiagnosticCounters();
    loggedRecords = [];

    mockLogger = {
      info: vi.fn((event, payload) => {
        loggedRecords.push({ level: 'info', event, payload });
      }),
      warn: vi.fn((event, payload) => {
        loggedRecords.push({ level: 'warn', event, payload });
      }),
      error: vi.fn((event, payload) => {
        loggedRecords.push({ level: 'error', event, payload });
      })
    };
  });

  describe('Event Taxonomy and Names', () => {
    it('defines frozen, namespaced security audit events', () => {
      expect(Object.isFrozen(SECURITY_AUDIT_EVENTS)).toBe(true);
      expect(SECURITY_AUDIT_EVENTS.AUTH_LOGIN_SUCCESS).toBe('security.auth.login.success');
      expect(SECURITY_AUDIT_EVENTS.AUTH_LOGIN_FAILURE).toBe('security.auth.login.failure');
      expect(SECURITY_AUDIT_EVENTS.AUTH_LOCKOUT).toBe('security.auth.lockout');
      expect(SECURITY_AUDIT_EVENTS.AUTH_DELAY_APPLIED).toBe('security.auth.delay.applied');
      expect(SECURITY_AUDIT_EVENTS.AUTH_TOKEN_REFRESH).toBe('security.auth.token.refresh');
      expect(SECURITY_AUDIT_EVENTS.AUTH_TOKEN_REPLAY).toBe('security.auth.token.replay');
      expect(SECURITY_AUDIT_EVENTS.AUTH_TOKEN_RACE_REJECTED).toBe(
        'security.auth.token.race_rejected'
      );
      expect(SECURITY_AUDIT_EVENTS.AUTH_LOGOUT).toBe('security.auth.logout');
      expect(SECURITY_AUDIT_EVENTS.AUTH_PASSWORD_RESET_REQUESTED).toBe(
        'security.auth.password_reset.requested'
      );
      expect(SECURITY_AUDIT_EVENTS.AUTH_PASSWORD_RESET_COMPLETED).toBe(
        'security.auth.password_reset.completed'
      );
      expect(SECURITY_AUDIT_EVENTS.CSRF_REJECTED).toBe('security.csrf.rejected');
    });
  });

  describe('Diagnostic Counters', () => {
    it('defines frozen counter names initialized to zero', () => {
      expect(Object.isFrozen(DIAGNOSTIC_COUNTER_NAMES)).toBe(true);
      const counters = getDiagnosticCounters();
      expect(Object.isFrozen(counters)).toBe(true);

      for (const name of DIAGNOSTIC_COUNTER_NAMES) {
        expect(counters[name]).toBe(0);
      }

      // Assert worker and coordinator diagnostic counters are included
      const expectedWorkerCounters = [
        'worker_spawn_total',
        'worker_ready_total',
        'worker_task_success_total',
        'worker_task_failure_total',
        'worker_unexpected_exit_total',
        'worker_replacement_attempt_total',
        'worker_replacement_failure_total',
        'worker_shutdown_failure_total',
        'coordinator_task_queued_total',
        'coordinator_task_timeout_total',
        'coordinator_task_saturated_total'
      ];
      for (const name of expectedWorkerCounters) {
        expect(DIAGNOSTIC_COUNTER_NAMES).toContain(name);
        expect(counters[name]).toBe(0);
      }
    });

    it('safely increments worker and coordinator diagnostic counters', () => {
      expect(incrementDiagnosticCounter('worker_spawn_total', 2)).toBe(2);
      expect(incrementDiagnosticCounter('worker_ready_total', 2)).toBe(2);
      expect(incrementDiagnosticCounter('worker_task_success_total', 5)).toBe(5);
      expect(incrementDiagnosticCounter('worker_task_failure_total', 1)).toBe(1);
      expect(incrementDiagnosticCounter('worker_unexpected_exit_total', 1)).toBe(1);
      expect(incrementDiagnosticCounter('worker_replacement_attempt_total', 1)).toBe(1);
      expect(incrementDiagnosticCounter('worker_replacement_failure_total', 1)).toBe(1);
      expect(incrementDiagnosticCounter('worker_shutdown_failure_total', 1)).toBe(1);
      expect(incrementDiagnosticCounter('coordinator_task_queued_total', 3)).toBe(3);
      expect(incrementDiagnosticCounter('coordinator_task_timeout_total', 1)).toBe(1);
      expect(incrementDiagnosticCounter('coordinator_task_saturated_total', 2)).toBe(2);

      const snap = getDiagnosticCounters();
      expect(snap.worker_spawn_total).toBe(2);
      expect(snap.worker_ready_total).toBe(2);
      expect(snap.worker_task_success_total).toBe(5);
      expect(snap.worker_task_failure_total).toBe(1);
      expect(snap.worker_unexpected_exit_total).toBe(1);
      expect(snap.worker_replacement_attempt_total).toBe(1);
      expect(snap.worker_replacement_failure_total).toBe(1);
      expect(snap.worker_shutdown_failure_total).toBe(1);
      expect(snap.coordinator_task_queued_total).toBe(3);
      expect(snap.coordinator_task_timeout_total).toBe(1);
      expect(snap.coordinator_task_saturated_total).toBe(2);
    });

    it('safely increments valid counters and ignores invalid names', () => {
      const val1 = incrementDiagnosticCounter('auth_login_success_total');
      expect(val1).toBe(1);

      const val2 = incrementDiagnosticCounter('auth_login_success_total', 4);
      expect(val2).toBe(5);

      const invalidVal = incrementDiagnosticCounter('unknown_counter_name');
      expect(invalidVal).toBe(0);

      const snapshot = getDiagnosticCounters();
      expect(snapshot.auth_login_success_total).toBe(5);
    });

    it('rejects non-positive and non-finite amounts as safe no-ops without altering count', () => {
      const before = getDiagnosticCounters().auth_login_failure_total;
      expect(before).toBe(0);

      const res1 = incrementDiagnosticCounter('auth_login_failure_total', -10);
      expect(res1).toBe(0);
      expect(getDiagnosticCounters().auth_login_failure_total).toBe(0);

      const res2 = incrementDiagnosticCounter('auth_login_failure_total', 0);
      expect(res2).toBe(0);
      expect(getDiagnosticCounters().auth_login_failure_total).toBe(0);

      const res3 = incrementDiagnosticCounter('auth_login_failure_total', NaN);
      expect(res3).toBe(0);
      expect(getDiagnosticCounters().auth_login_failure_total).toBe(0);

      const res4 = incrementDiagnosticCounter('auth_login_failure_total', Infinity);
      expect(res4).toBe(0);
      expect(getDiagnosticCounters().auth_login_failure_total).toBe(0);

      const res5 = incrementDiagnosticCounter('auth_login_failure_total', 'invalid');
      expect(res5).toBe(0);
      expect(getDiagnosticCounters().auth_login_failure_total).toBe(0);
    });

    it('caps counter increments at Number.MAX_SAFE_INTEGER without overflow', () => {
      incrementDiagnosticCounter('auth_login_success_total', Number.MAX_SAFE_INTEGER);
      expect(getDiagnosticCounters().auth_login_success_total).toBe(Number.MAX_SAFE_INTEGER);

      // Subsequent increments should safely clamp at MAX_SAFE_INTEGER
      const result = incrementDiagnosticCounter('auth_login_success_total', 100);
      expect(result).toBe(Number.MAX_SAFE_INTEGER);
      expect(getDiagnosticCounters().auth_login_success_total).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('resets all diagnostic counters to zero on resetDiagnosticCounters', () => {
      incrementDiagnosticCounter('auth_login_success_total', 10);
      incrementDiagnosticCounter('security_csrf_rejection_total', 3);

      resetDiagnosticCounters();

      const snapshot = getDiagnosticCounters();
      expect(snapshot.auth_login_success_total).toBe(0);
      expect(snapshot.security_csrf_rejection_total).toBe(0);
    });
  });

  describe('Event Recording Methods & SEC-423-01 Identifier Stripping', () => {
    it('records login success without raw userId or sessionId and resolves server req.id', () => {
      const service = new SecurityAuditService({ logger: mockLogger });
      const req = { id: 'a0000000-0000-4000-8000-000000000001' };

      const ok = service.recordLoginSuccess({
        req,
        userId: '507f1f77bcf86cd799439011',
        sessionId: 'session-uuid-secret-999',
        email: 'test.user@example.com'
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().auth_login_success_total).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.info.mock.calls[0];
      expect(event).toBe('security.auth.login.success');
      expect(payload.audit).toBe(true);
      expect(payload.action).toBe('security.auth.login.success');
      expect(payload.category).toBe('authentication');
      expect(payload.outcome).toBe('success');
      expect(payload.requestId).toBe('a0000000-0000-4000-8000-000000000001');
      expect(payload.userId).toBeUndefined();
      expect(payload.sessionId).toBeUndefined();
      expect(payload.emailMasked).toBe('te***@example.com');
    });

    it('records login failure without adopting client headers as requestId', () => {
      const service = new SecurityAuditService({ logger: mockLogger });
      const req = { headers: { 'x-request-id': 'untrusted-client-header-id' } };

      const ok = service.recordLoginFailure({
        req,
        email: 'victim@company.org',
        ipHash: '64charhexvalue1234567890abcdef',
        reason: 'invalid_credentials',
        accountExists: true,
        failedAttempts: 3
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().auth_login_failure_total).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.warn.mock.calls[0];
      expect(event).toBe('security.auth.login.failure');
      expect(payload.audit).toBe(true);
      expect(payload.action).toBe('security.auth.login.failure');
      expect(payload.category).toBe('authentication');
      expect(payload.outcome).toBe('failure');
      // SEC-423-02: Client headers must be ignored
      expect(payload.requestId).toBeUndefined();
      expect(payload.emailMasked).toBe('vi***@company.org');
      expect(payload.ipHash).toBe('64charhexvalue1234567890abcdef');
      expect(payload.accountExists).toBe(true);
      expect(payload.failedAttempts).toBe(3);
    });

    it('records lockout and increments auth_lockout_active_total', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      const ok = service.recordLockout({
        email: 'target@example.com',
        ipHash: 'hash-abc',
        retryAfterSeconds: 60,
        tier: 'pair',
        stage: 'pre_check',
        status: 'ACTIVE_LOCKOUT',
        failedAttempts: 5
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().auth_lockout_active_total).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.warn.mock.calls[0];
      expect(event).toBe('security.auth.lockout');
      expect(payload.outcome).toBe('blocked');
      expect(payload.tier).toBe('pair');
      expect(payload.stage).toBe('pre_check');
      expect(payload.retryAfterSeconds).toBe(60);
      expect(payload.status).toBe('ACTIVE_LOCKOUT');
      expect(payload.failedAttempts).toBe(5);
    });

    it('records spray delay applied and increments auth_delay_applied_total', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      const ok = service.recordSprayDelay({
        email: 'spray@target.com',
        ipHash: 'ip-hash-spray',
        delayMs: 750,
        distinctIpsCount: 4
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().auth_delay_applied_total).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.info.mock.calls[0];
      expect(event).toBe('security.auth.delay.applied');
      expect(payload.outcome).toBe('applied');
      expect(payload.delayMs).toBe(750);
      expect(payload.distinctIpsCount).toBe(4);
    });

    it('records token refresh without userId/sessionId and without altering session revocation counter', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      const ok = service.recordTokenRefresh({
        userId: 'user-789',
        sessionId: 'session-789',
        ipHash: 'hash-789'
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().auth_session_revoked_total).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.info.mock.calls[0];
      expect(event).toBe('security.auth.token.refresh');
      expect(payload.category).toBe('session');
      expect(payload.outcome).toBe('success');
      expect(payload.userId).toBeUndefined();
      expect(payload.sessionId).toBeUndefined();
    });

    it('records token replay attack without userId/sessionId and increments both replay and revocation counters', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      const ok = service.recordTokenReplay({
        userId: 'compromised-user',
        sessionId: 'compromised-session',
        ipHash: 'attacker-ip-hash',
        timeSinceRotationMs: 15000
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().security_token_replay_total).toBe(1);
      expect(getDiagnosticCounters().auth_session_revoked_total).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.warn.mock.calls[0];
      expect(event).toBe('security.auth.token.replay');
      expect(payload.outcome).toBe('detected');
      expect(payload.timeSinceRotationMs).toBe(15000);
      expect(payload.userId).toBeUndefined();
      expect(payload.sessionId).toBeUndefined();
    });

    it('records token race rejected within grace window without userId/sessionId', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      const ok = service.recordTokenRaceRejected({
        userId: 'racing-user',
        sessionId: 'racing-session'
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().security_token_replay_total).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.info.mock.calls[0];
      expect(event).toBe('security.auth.token.race_rejected');
      expect(payload.outcome).toBe('rejected');
      expect(payload.userId).toBeUndefined();
      expect(payload.sessionId).toBeUndefined();
    });

    it('records logout and increments auth_session_revoked_total only when sessionRevoked is true (SEC-423-05)', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      // Unauthenticated or failed logout: sessionRevoked defaults to false
      const ok1 = service.recordLogout({
        userId: 'logging-out-user',
        sessionId: 'session-to-close',
        sessionRevoked: false
      });

      expect(ok1).toBe(true);
      expect(getDiagnosticCounters().auth_session_revoked_total).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      const [, payload1] = mockLogger.info.mock.calls[0];
      expect(payload1.outcome).toBe('success');
      expect(payload1.userId).toBeUndefined();
      expect(payload1.sessionId).toBeUndefined();

      // Confirmed session revocation
      const ok2 = service.recordLogout({
        sessionRevoked: true
      });

      expect(ok2).toBe(true);
      expect(getDiagnosticCounters().auth_session_revoked_total).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledTimes(2);
    });

    it('records password reset requested without accountExists (SEC-423-04) and without userId', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      const ok = service.recordPasswordResetRequested({
        email: 'reset.request@example.com',
        accountExists: true,
        userId: 'some-user-id'
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().auth_password_reset_request_total).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.info.mock.calls[0];
      expect(event).toBe('security.auth.password_reset.requested');
      expect(payload.outcome).toBe('requested');
      expect(payload.emailMasked).toBe('re***@example.com');
      // SEC-423-04: accountExists must be stripped
      expect(payload.accountExists).toBeUndefined();
      // SEC-423-01: userId must be stripped
      expect(payload.userId).toBeUndefined();
    });

    it('records password reset completed without userId and increments revocation counter', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      const ok = service.recordPasswordResetCompleted({
        userId: 'reset-completed-user'
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().auth_password_reset_success_total).toBe(1);
      expect(getDiagnosticCounters().auth_session_revoked_total).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.info.mock.calls[0];
      expect(event).toBe('security.auth.password_reset.completed');
      expect(payload.outcome).toBe('success');
      expect(payload.userId).toBeUndefined();
    });
  });

  describe('CSRF Rejection and Origin Sanitization (SEC-423-03)', () => {
    it('records valid CSRF rejection origin and increments counter', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      const ok = service.recordCsrfRejection({
        origin: 'http://malicious.evil.com',
        reason: 'untrusted_origin'
      });

      expect(ok).toBe(true);
      expect(getDiagnosticCounters().security_csrf_rejection_total).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      const [event, payload] = mockLogger.warn.mock.calls[0];
      expect(event).toBe('security.csrf.rejected');
      expect(payload.outcome).toBe('rejected');
      expect(payload.category).toBe('csrf');
      expect(payload.origin).toBe('http://malicious.evil.com');
      expect(payload.reason).toBe('untrusted_origin');
    });

    it('sanitizes oversized CSRF origin to 128 characters', () => {
      const service = new SecurityAuditService({ logger: mockLogger });
      const longOrigin = 'https://' + 'a'.repeat(300) + '.evil.com';

      service.recordCsrfRejection({ origin: longOrigin });

      const payload = mockLogger.warn.mock.calls[0][1];
      expect(payload.origin).toBeDefined();
      expect(payload.origin.length).toBe(128);
      expect(payload.origin).toBe(longOrigin.slice(0, 128));
    });

    it('strips control characters and escape sequences from CSRF origin', () => {
      const service = new SecurityAuditService({ logger: mockLogger });
      const taintedOrigin = 'http://attacker.com\r\nHeader-Injection: evil\x00\x1b[31m';

      service.recordCsrfRejection({ origin: taintedOrigin });

      const payload = mockLogger.warn.mock.calls[0][1];
      expect(payload.origin).toBe('http://attacker.comHeader-Injection: evil[31m');
      expect(payload.origin).not.toContain('\r');
      expect(payload.origin).not.toContain('\n');
      expect(payload.origin).not.toContain('\x00');
    });

    it('handles empty or non-string origin safely', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      service.recordCsrfRejection({ origin: '' });
      service.recordCsrfRejection({ origin: null });
      service.recordCsrfRejection({ origin: 12345 });

      expect(mockLogger.warn).toHaveBeenCalledTimes(3);
      for (const call of mockLogger.warn.mock.calls) {
        expect(call[1].origin).toBeUndefined();
      }
    });
  });

  describe('Request ID Trust Boundary (SEC-423-02)', () => {
    it('resolves valid UUID v4 from AsyncLocalStorage context', () => {
      const service = new SecurityAuditService({ logger: mockLogger });
      const validUuid = 'c0000000-0000-4000-8000-000000000002';

      runWithRequestContext({ requestId: validUuid }, () => {
        service.recordLoginFailure({ reason: 'invalid_credentials' });
      });

      const payload = mockLogger.warn.mock.calls[0][1];
      expect(payload.requestId).toBe(validUuid);
    });

    it('resolves valid UUID v4 from server-assigned req.id when outside ALS', () => {
      const service = new SecurityAuditService({ logger: mockLogger });
      const serverUuid = 'd0000000-0000-4000-8000-000000000003';

      service.recordLoginFailure({
        req: { id: serverUuid },
        reason: 'invalid_credentials'
      });

      const payload = mockLogger.warn.mock.calls[0][1];
      expect(payload.requestId).toBe(serverUuid);
    });

    it('rejects untrusted client headers even if they resemble UUIDs', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      service.recordLoginFailure({
        req: {
          headers: {
            'x-request-id': 'e0000000-0000-4000-8000-000000000004'
          }
        },
        reason: 'invalid_credentials'
      });

      const payload = mockLogger.warn.mock.calls[0][1];
      expect(payload.requestId).toBeUndefined();
    });

    it('rejects malformed, non-UUID v4 or oversized req.id', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      // Non-UUID v4 format
      service.recordLoginFailure({
        req: { id: 'req-12345' },
        reason: 'invalid_credentials'
      });
      expect(mockLogger.warn.mock.calls[0][1].requestId).toBeUndefined();

      // Oversized string
      service.recordLoginFailure({
        req: { id: 'a'.repeat(65) },
        reason: 'invalid_credentials'
      });
      expect(mockLogger.warn.mock.calls[1][1].requestId).toBeUndefined();

      // Injection attempt
      service.recordLoginFailure({
        req: { id: '123; DROP TABLE logs; --' },
        reason: 'invalid_credentials'
      });
      expect(mockLogger.warn.mock.calls[2][1].requestId).toBeUndefined();
    });
  });

  describe('Privacy and IP Hash Handling', () => {
    it('never logs raw client IP in cleartext when no protection service is configured', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      service.recordLoginFailure({
        clientIp: '203.0.113.195',
        ip: '203.0.113.195',
        reason: 'invalid_credentials'
      });

      const payload = mockLogger.warn.mock.calls[0][1];
      expect(payload.clientIp).toBeUndefined();
      expect(payload.ip).toBeUndefined();
      expect(payload.ipHash).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('203.0.113.195');
    });

    it('uses protection service deriveIpHash when available and excludes raw IP', () => {
      const mockProtectionService = {
        deriveIpHash: vi.fn(() => '5f4dcc3b5aa765d61d8327deb882cf992b3628e9')
      };
      const service = new SecurityAuditService({
        logger: mockLogger,
        protectionService: mockProtectionService
      });

      service.recordLoginFailure({
        clientIp: '198.51.100.22',
        reason: 'invalid_credentials'
      });

      expect(mockProtectionService.deriveIpHash).toHaveBeenCalledWith('198.51.100.22');
      const payload = mockLogger.warn.mock.calls[0][1];
      expect(payload.ipHash).toBe('5f4dcc3b5aa765d61d8327deb882cf992b3628e9');
      expect(payload.clientIp).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('198.51.100.22');
    });
  });

  describe('Resilience and Non-Throwing Guarantee', () => {
    it('does not throw when logger throws an error and returns false', () => {
      const faultyLogger = {
        info: vi.fn(() => {
          throw new Error('Logger disk full write error');
        })
      };
      const service = new SecurityAuditService({ logger: faultyLogger });

      expect(() => {
        const ok = service.recordLoginSuccess({ userId: 'u123' });
        expect(ok).toBe(false);
      }).not.toThrow();
    });

    it('handles null, undefined, and empty argument objects safely', () => {
      const service = new SecurityAuditService({ logger: mockLogger });

      expect(() => service.recordLoginSuccess(undefined)).not.toThrow();
      expect(() => service.recordLoginFailure(null)).not.toThrow();
      expect(() => service.recordLockout({})).not.toThrow();
      expect(() => service.recordSprayDelay()).not.toThrow();
      expect(() => service.recordTokenRefresh()).not.toThrow();
      expect(() => service.recordTokenReplay()).not.toThrow();
      expect(() => service.recordTokenRaceRejected()).not.toThrow();
      expect(() => service.recordLogout()).not.toThrow();
      expect(() => service.recordPasswordResetRequested()).not.toThrow();
      expect(() => service.recordPasswordResetCompleted()).not.toThrow();
      expect(() => service.recordCsrfRejection()).not.toThrow();
    });
  });
});
