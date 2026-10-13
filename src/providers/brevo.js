/**
 * Brevo (Sendinblue) Provider
 * Supports both high-speed SMTP Relay and REST API v3
 */
const nodemailer = require('nodemailer');
const axios = require('axios');
const logger = require('../logger');

class BrevoProvider {
  constructor() {
    this.name = 'brevo';
    this.enabled = process.env.BREVO_ENABLED === 'true';
    this.apiKey = process.env.BREVO_API_KEY || '';
    this.smtpHost = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
    this.smtpPort = parseInt(process.env.BREVO_SMTP_PORT || '587', 10);
    this.smtpUser = process.env.BREVO_SMTP_USER || '';
    this.smtpPass = process.env.BREVO_SMTP_PASS || '';
    this.fromEmail = process.env.BREVO_FROM_EMAIL || process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local';
    this.fromName = process.env.BREVO_FROM_NAME || process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform';

    if (this.smtpUser && this.smtpPass) {
      this.transporter = nodemailer.createTransport({
        host: this.smtpHost,
        port: this.smtpPort,
        secure: process.env.BREVO_SMTP_SECURE === 'true',
        auth: {
          user: this.smtpUser,
          pass: this.smtpPass,
        },
        tls: { rejectUnauthorized: false },
      });
    }
  }

  isAvailable() {
    return this.enabled && ((this.smtpUser && this.smtpPass) || this.apiKey);
  }

  async send({ to, cc, subject, html, text, attachments }) {
    logger.info(`[Brevo] Attempting delivery to ${to.email}...`);

    // 1. Try SMTP if credentials present
    if (this.transporter) {
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
      logger.info(`[Brevo SMTP] Email delivered successfully. MessageId: ${info.messageId}`);
      return { success: true, messageId: info.messageId, provider: 'brevo' };
    }

    // 2. Fallback to Brevo REST API v3
    if (this.apiKey) {
      const payload = {
        sender: { name: this.fromName, email: this.fromEmail },
        to: [{ email: to.email, name: to.name || undefined }],
        subject,
        htmlContent: html,
        textContent: text,
      };
      if (cc && cc.length) {
        payload.cc = cc.map(c => ({ email: c.email, name: c.name || undefined }));
      }
      if (attachments && attachments.length) {
        payload.attachment = attachments.map(att => ({
          name: att.filename,
          content: att.content_base64,
        }));
      }

      const res = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
        headers: {
          'api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      const messageId = res.data && res.data.messageId ? res.data.messageId : `brevo_${Date.now()}`;
      logger.info(`[Brevo API] Email delivered successfully. MessageId: ${messageId}`);
      return { success: true, messageId, provider: 'brevo' };
    }

    throw new Error('Brevo provider has neither valid SMTP credentials nor API key configured');
  }
}

module.exports = BrevoProvider;
