import { Resend } from 'resend';

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
      .replace(/(https?:\/\/[^\s"'<>]+)?\/resetpassword\/[a-zA-Z0-9_%-]+/gi, '[REDACTED_RESET_LINK]')
      .replace(/\b[0-9a-fA-F]{40}\b/g, '[REDACTED_TOKEN]')
      .replace(/re_[a-zA-Z0-9_]{16,}/g, '[REDACTED_API_KEY]')
      .replace(/bearer\s+[a-zA-Z0-9._~+/-]+/gi, 'Bearer [REDACTED_TOKEN]');
  }

  /**
   * Send an email
   * @param {Object} options
   * @param {string} options.to - Recipient email address
   * @param {string} options.subject - Email subject
   * @param {string} options.html - HTML body of the email
   * @param {string} [options.text] - Plain text body (fallback)
   * @param {boolean} [options.isSensitive] - Whether the email contains sensitive credentials
   * @returns {Promise<Object>} Provider specific response
   */
  async sendEmail(options) {
    if (!this.resend) {
      if (process.env.NODE_ENV === 'production') {
        console.error('Email sending failed: Resend API key is not configured in production');
        throw new Error('Email service not configured');
      }
      console.log('--- Development Email Log ---');
      console.log(`To: ${options.to}`);
      console.log(`Subject: ${options.subject}`);
      console.log(`Body: ${this._formatBodyForLogging(options)}`);
      console.log('-----------------------------');
      return { id: 'dev-email-id' };
    }

    try {
      const data = await this.resend.emails.send({
        from: this.fromEmail,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || options.html.replace(/<[^>]*>?/gm, '')
      });
      return data;
    } catch (error) {
      const safeErrorMsg = this._sanitizeForLogging(error && error.message ? error.message : 'Unknown error');
      console.error('Email sending failed:', safeErrorMsg);
      throw error;
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
    console.log(`Sending response notification to ${to} for form ${form._id}`);
  }
}

// Export as class (so authController can do new EmailService)
export default EmailService;
