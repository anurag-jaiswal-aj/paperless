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
   * Send an email
   * @param {Object} options
   * @param {string} options.to - Recipient email address
   * @param {string} options.subject - Email subject
   * @param {string} options.html - HTML body of the email
   * @param {string} [options.text] - Plain text body (fallback)
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
      console.log(`Body: ${options.text || options.html}`);
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
      console.error('Email sending failed', error);
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
      html: `<p>You requested a password reset. Please click the link to reset your password:</p><a href="${resetUrl}">${resetUrl}</a>`
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
