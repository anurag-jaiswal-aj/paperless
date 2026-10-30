import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EmailService from './EmailService.js';

describe('EmailService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Sanitization and Body Omission for Logging', () => {
    it('completely omits body when isSensitive flag is true', () => {
      const emailService = new EmailService();
      const output = emailService._formatBodyForLogging({
        subject: 'Account Notice',
        text: 'Sensitive secret payload with token 12345',
        isSensitive: true
      });

      expect(output).toBe('[Omitted: Sensitive password reset content is never written to logs]');
      expect(output).not.toContain('12345');
    });

    it('completely omits body when subject indicates password reset', () => {
      const emailService = new EmailService();
      const output = emailService._formatBodyForLogging({
        subject: 'Paperless - Password Reset',
        text: 'https://example.com/resetpassword/48924b8109312847291748291749281749281749'
      });

      expect(output).toBe('[Omitted: Sensitive password reset content is never written to logs]');
      expect(output).not.toContain('48924b8109312847291748291749281749281749');
    });

    it('completely omits body when text content contains resetpassword keyword', () => {
      const emailService = new EmailService();
      const output = emailService._formatBodyForLogging({
        subject: 'Notification',
        text: 'Please visit http://localhost:5173/resetpassword/abcdef1234567890abcdef1234567890abcdef12 to reset'
      });

      expect(output).toBe('[Omitted: Sensitive password reset content is never written to logs]');
      expect(output).not.toContain('abcdef1234567890abcdef1234567890abcdef12');
    });

    it('redacts complete reset URLs from log content in defense-in-depth sanitization', () => {
      const emailService = new EmailService();
      const rawBody = 'Click here: http://localhost:5173/resetpassword/abcdef0123456789abcdef0123456789abcdef01 to proceed';
      const sanitized = emailService._sanitizeForLogging(rawBody);

      expect(sanitized).not.toContain('abcdef0123456789abcdef0123456789abcdef01');
      expect(sanitized).toContain('[REDACTED_RESET_LINK]');
    });

    it('redacts HTML links containing reset tokens in defense-in-depth sanitization', () => {
      const emailService = new EmailService();
      const rawHtml = '<a href="https://example.com/resetpassword/0123456789abcdef0123456789abcdef01234567">Reset</a>';
      const sanitized = emailService._sanitizeForLogging(rawHtml);

      expect(sanitized).not.toContain('0123456789abcdef0123456789abcdef01234567');
      expect(sanitized).toContain('<a href="[REDACTED_RESET_LINK]">Reset</a>');
    });

    it('redacts standalone 40-character hex reset tokens in defense-in-depth sanitization', () => {
      const emailService = new EmailService();
      const rawText = 'Your reset token is: a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0';
      const sanitized = emailService._sanitizeForLogging(rawText);

      expect(sanitized).not.toContain('a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0');
      expect(sanitized).toContain('Your reset token is: [REDACTED_TOKEN]');
    });

    it('redacts email addresses, API keys, and authorization headers in defense-in-depth sanitization', () => {
      const emailService = new EmailService();
      const rawText = 'Error for user target@example.com with key re_1234567890123456 and Bearer secrettoken123';
      const sanitized = emailService._sanitizeForLogging(rawText);

      expect(sanitized).not.toContain('target@example.com');
      expect(sanitized).not.toContain('re_1234567890123456');
      expect(sanitized).not.toContain('secrettoken123');
      expect(sanitized).toContain('[REDACTED_EMAIL]');
      expect(sanitized).toContain('[REDACTED_API_KEY]');
      expect(sanitized).toContain('Bearer [REDACTED_TOKEN]');
    });

    it('preserves non-sensitive email content intact', () => {
      const emailService = new EmailService();
      const body = 'You have received a new submission for your form Customer Feedback.';
      const output = emailService._formatBodyForLogging({
        subject: 'New submission for form: Customer Feedback',
        text: body
      });

      expect(output).toBe(body);
    });

    it('handles non-string and empty inputs safely without throwing', () => {
      const emailService = new EmailService();
      expect(emailService._formatBodyForLogging(null)).toBe('');
      expect(emailService._formatBodyForLogging(undefined)).toBe('');
      expect(emailService._sanitizeForLogging(null)).toBe('');
      expect(emailService._sanitizeForLogging(undefined)).toBe('');
      expect(emailService._sanitizeForLogging(12345)).toBe('');
    });
  });

  describe('sendEmail in Non-Production Environment', () => {
    it('logs mock development email without exposing raw reset token or reset URL', async () => {
      process.env.NODE_ENV = 'development';
      const emailService = new EmailService();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const rawToken = '11223344556677889900aabbccddeeff00112233';
      const resetUrl = `http://localhost:5173/resetpassword/${rawToken}`;

      const result = await emailService.sendEmail({
        to: 'user@example.com',
        subject: 'Paperless - Password Reset',
        text: `Reset password: ${resetUrl}`,
        html: `<p>Reset password: <a href="${resetUrl}">${resetUrl}</a></p>`,
        isSensitive: true
      });

      expect(result).toEqual({ id: 'dev-email-id' });
      expect(logSpy).toHaveBeenCalled();

      // Ensure that neither the raw token nor the complete URL was logged anywhere
      for (const callArgs of logSpy.mock.calls) {
        const loggedString = callArgs.join(' ');
        expect(loggedString).not.toContain(rawToken);
        expect(loggedString).not.toContain(resetUrl);
      }
      const allLogs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(allLogs).toContain('[Omitted: Sensitive password reset content is never written to logs]');
    });

    it('correctly logs non-sensitive recipient, subject, and body in development', async () => {
      process.env.NODE_ENV = 'development';
      const emailService = new EmailService();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await emailService.sendEmail({
        to: 'recipient@example.com',
        subject: 'Notification Subject',
        text: 'Notification body text'
      });

      const loggedOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(loggedOutput).toContain('To: recipient@example.com');
      expect(loggedOutput).toContain('Subject: Notification Subject');
      expect(loggedOutput).toContain('Notification body text');
    });
  });

  describe('sendEmail in Production Environment', () => {
    it('throws an error and prevents mock email delivery when API key is missing', async () => {
      process.env.NODE_ENV = 'production';
      const emailService = new EmailService();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        emailService.sendEmail({
          to: 'target@example.com',
          subject: 'Password Reset',
          text: 'http://localhost:5173/resetpassword/abcdef0123456789abcdef0123456789abcdef01'
        })
      ).rejects.toThrow('Email service not configured');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Resend API key is not configured in production')
      );
      // Confirm console.log mock output was never triggered
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('sanitizes provider error message and strips sensitive data before logging', async () => {
      process.env.NODE_ENV = 'production';
      process.env.RESEND_API_KEY = 're_testkey1234567890';
      const emailService = new EmailService();

      // Mock provider send to reject with sensitive information in error message
      emailService.resend = {
        emails: {
          send: vi.fn().mockRejectedValue(
            new Error('Failed sending to target@example.com using key re_secretkey123456789')
          )
        }
      };

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        emailService.sendEmail({
          to: 'target@example.com',
          subject: 'Test Subject',
          text: 'Test Body'
        })
      ).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalled();
      const loggedError = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(loggedError).not.toContain('target@example.com');
      expect(loggedError).not.toContain('re_secretkey123456789');
      expect(loggedError).toContain('[REDACTED_EMAIL]');
      expect(loggedError).toContain('[REDACTED_API_KEY]');
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('constructs expected reset link and routes through sendEmail with body omission', async () => {
      process.env.NODE_ENV = 'development';
      process.env.FRONTEND_URL = 'https://app.paperless.test';
      const emailService = new EmailService();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const rawToken = '44556677889900112233aabbccddeeff44556677';

      await emailService.sendPasswordResetEmail('member@example.com', rawToken);

      const loggedOutput = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(loggedOutput).not.toContain(rawToken);
      expect(loggedOutput).not.toContain('https://app.paperless.test/resetpassword/44556677889900112233aabbccddeeff44556677');
      expect(loggedOutput).toContain('[Omitted: Sensitive password reset content is never written to logs]');
    });
  });
});
