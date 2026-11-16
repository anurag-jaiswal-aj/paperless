import { Resend } from 'resend';
import { logger } from '../utils/logger.js';

/**
 * Default call-level timeout for email delivery in milliseconds.
 */
export const DEFAULT_EMAIL_TIMEOUT_MS = 5000;

/**
 * EmailService
 *
 * Abstraction layer for email operations.
 * Isolates the application from the underlying email provider (e.g., Resend).
 */
class EmailService {
  constructor() {
    this.resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    this.fromEmail = process.env.EMAIL_FROM || 'noreply@example.com';
  }

  /**
   * Helper to format email body for development logging.
   * Completely omits sensitive password reset content so credentials and tokens
   * never appear in log streams under any format or encoding.
   * @param {Object} options
   * @returns {string}
   */
  _formatBodyForLogging(options) {
    if (!options || typeof options !== 'object') return '';
    const subject = (options.subject || '').toLowerCase();
    const content = options.text || options.html || '';

    if (
      options.isSensitive ||
      subject.includes('password reset') ||
      subject.includes('reset password') ||
      (typeof content === 'string' && /resetpassword/i.test(content))
    ) {
      return '[Omitted: Sensitive password reset content is never written to logs]';
    }

    return this._sanitizeForLogging(content);
  }

  /**
   * Redacts sensitive reset URLs, raw token strings, email addresses, and API credentials from text.
   * Defense-in-depth sanitization for email content and error messages.
   * @param {string} content
   * @returns {string}
   */
  _sanitizeForLogging(content) {
    if (typeof content !== 'string') return '';
    return content
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
      .replace(
        /(https?:\/\/[^\s"'<>]+)?\/resetpassword\/[a-zA-Z0-9_%-]+/gi,
        '[REDACTED_RESET_LINK]'
      )
      .replace(/\b[0-9a-fA-F]{40}\b/g, '[REDACTED_TOKEN]')
      .replace(/re_[a-zA-Z0-9_]{16,}/g, '[REDACTED_API_KEY]')
      .replace(/bearer\s+[a-zA-Z0-9._~+/-]+/gi, 'Bearer [REDACTED_TOKEN]');
  }

  /**
   * Send an email with a default 5,000ms call-level timeout and genuine AbortSignal cancellation.
   *
   * @param {Object} options
   * @param {string} options.to - Recipient email address
   * @param {string} options.subject - Email subject
   * @param {string} options.html - HTML body of the email
   * @param {string} [options.text] - Plain text body (fallback)
   * @param {boolean} [options.isSensitive] - Whether the email contains sensitive credentials
   * @param {number} [options.timeoutMs] - Optional call-level timeout in ms (default: 5000)
   * @param {AbortSignal} [options.abortSignal] - Optional parent cancellation signal
   * @param {AbortSignal} [options.signal] - Alias for abortSignal
   * @returns {Promise<Object>} Provider specific response
   */
  async sendEmail(options = {}) {
    if (!this.resend) {
      if (process.env.NODE_ENV === 'production') {
        logger.error('Email sending failed: Resend API key is not configured in production', {
          event: 'email.resend_unconfigured'
        });
        throw new Error('Email service not configured');
      }
      logger.info('Development mock email generated', {
        event: 'email.dev_mock_sent',
        to: options.to,
        subject: options.subject,
        body: this._formatBodyForLogging(options)
      });
      return { id: 'dev-email-id' };
    }

    const timeoutMs =
      typeof options.timeoutMs === 'number'
        ? options.timeoutMs
        : parseInt(process.env.EMAIL_TIMEOUT_MS, 10) || DEFAULT_EMAIL_TIMEOUT_MS;

    const parentSignal = options.abortSignal || options.signal;
    const controller = new AbortController();

    let removeParentListener = null;
    let timerId = null;

    const timeoutError = new Error(`Email delivery timed out after ${timeoutMs}ms`);
    timeoutError.name = 'TimeoutError';
    timeoutError.code = 'ETIMEDOUT';

    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort(parentSignal.reason);
      } else {
        const onParentAbort = () => {
          controller.abort(parentSignal.reason);
        };
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        removeParentListener = () => parentSignal.removeEventListener('abort', onParentAbort);
      }
    }

    timerId = setTimeout(() => {
      controller.abort(timeoutError);
    }, timeoutMs);

    const cleanup = () => {
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (removeParentListener) {
        removeParentListener();
        removeParentListener = null;
      }
    };

    // Construct a promise that rejects when controller aborts
    const abortPromise = new Promise((_, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(controller.signal.reason);
        },
        { once: true }
      );
    });

    let sendPromise;
    try {
      // Pass genuine AbortSignal to Resend SDK requestOptions
      sendPromise = this.resend.emails.send(
        {
          from: this.fromEmail,
          to: options.to,
          subject: options.subject,
          html: options.html,
          text: options.text || options.html?.replace(/<[^>]*>?/gm, '')
        },
        { signal: controller.signal }
      );

      // Attach catch handler to suppress late unhandled promise rejections
      // if provider settles after timeout or cancellation
      if (sendPromise && typeof sendPromise.catch === 'function') {
        sendPromise.catch((lateErr) => {
          const lateMsg = this._sanitizeForLogging(lateErr?.message || 'Unknown late error');
          logger.debug('email.late_rejection_suppressed', { error: lateMsg });
        });
      }

      const data = await Promise.race([sendPromise, abortPromise]);

      if (data && data.error) {
        const errorMsg = data.error.message || 'Resend provider error';
        const providerError = new Error(errorMsg);
        providerError.name = data.error.name || 'ResendError';
        providerError.statusCode = data.error.statusCode;
        providerError.status = data.error.statusCode;
        throw providerError;
      }

      return data;
    } catch (error) {
      const safeErrorMsg = this._sanitizeForLogging(
        error && error.message ? error.message : 'Unknown error'
      );
      logger.error(`Email sending failed: ${safeErrorMsg}`, error, {
        event: 'email.delivery_failed',
        sanitizedMessage: safeErrorMsg
      });
      throw error;
    } finally {
      cleanup();
    }
  }

  /**
   * Send password reset email
   * @param {string} to - Recipient email address
   * @param {string} resetToken - The password reset token
   * @returns {Promise<void>}
   */
  async sendPasswordResetEmail(to, resetToken) {
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/resetpassword/${resetToken}`;
    const message = `You requested a password reset. Please click the link to reset your password:\n\n${resetUrl}`;

    await this.sendEmail({
      to,
      subject: 'Paperless - Password Reset',
      text: message,
      html: `<p>You requested a password reset. Please click the link to reset your password:</p><a href="${resetUrl}">${resetUrl}</a>`,
      isSensitive: true
    });
  }

  /**
   * Send new response notification to form owner
   * @param {string} to - Owner email address
   * @param {Object} form - Form data
   * @returns {Promise<void>}
   */
  async sendResponseNotification(to, form) {
    // Will be fully integrated in Phase 3
    logger.debug('notification.stub', { to, formId: form._id });
  }
}

// Export as class (so authController can do new EmailService)
export default EmailService;
