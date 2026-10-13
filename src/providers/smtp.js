/**
 * Generic SMTP Fallback Provider
 */
const nodemailer = require('nodemailer');
const logger = require('../logger');

class GenericSmtpProvider {
  constructor() {
    this.name = 'smtp';
    this.enabled = process.env.SMTP_ENABLED === 'true';
    this.host = process.env.SMTP_HOST || 'localhost';
    this.port = parseInt(process.env.SMTP_PORT || '1025', 10);
    this.secure = process.env.SMTP_SECURE === 'true';
    this.user = process.env.SMTP_USER || '';
    this.pass = process.env.SMTP_PASS || '';
    this.fromEmail = process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local';
    this.fromName = process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform';

    if (this.host) {
      this.transporter = nodemailer.createTransport({
        host: this.host,
        port: this.port,
        secure: this.secure,
        auth: (this.user && this.pass) ? { user: this.user, pass: this.pass } : undefined,
        tls: { rejectUnauthorized: false },
      });
    }
  }

  isAvailable() {
    return this.enabled && !!this.host;
  }

  async send({ to, cc, subject, html, text, attachments }) {
    logger.info(`[SMTP] Attempting delivery to ${to.email} via ${this.host}:${this.port}...`);
    const mailOptions = {
      from: `"${this.fromName}" <${this.fromEmail}>`,
      to: to.name ? `"${to.name}" <${to.email}>` : to.email,
      cc: cc && cc.length ? cc.map(c => c.name ? `"${c.name}" <${c.email}>` : c.email).join(', ') : undefined,
      subject,
      html,
      text,
      attachments: attachments && attachments.length ? attachments.map(att => ({
        filename: att.filename,
        contentType: att.content_type,
        content: Buffer.from(att.content_base64, 'base64'),
      })) : undefined,
    };

    const info = await this.transporter.sendMail(mailOptions);
    logger.info(`[SMTP] Email delivered successfully. MessageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId, provider: 'smtp' };
  }
}

module.exports = GenericSmtpProvider;
