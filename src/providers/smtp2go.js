/**
 * SMTP2GO Provider (https://smtp2go.com)
 * Uses SMTP2GO REST API v3
 */
const axios = require('axios');
const logger = require('../logger');

class Smtp2goProvider {
  constructor() {
    this.name = 'smtp2go';
    this.enabled = process.env.SMTP2GO_ENABLED === 'true';
    this.apiKey = process.env.SMTP2GO_API_KEY || '';
    this.fromEmail = process.env.SMTP2GO_FROM_EMAIL || process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local';
    this.fromName = process.env.SMTP2GO_FROM_NAME || process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform';
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !this.apiKey.includes('your_smtp2go');
  }

  async send({ to, cc, subject, html, text, attachments }) {
    logger.info(`[SMTP2GO] Attempting delivery to ${to.email}...`);

    const payload = {
      api_key: this.apiKey,
      to: [to.name ? `${to.name} <${to.email}>` : to.email],
      sender: `${this.fromName} <${this.fromEmail}>`,
      subject,
      html_body: html,
      text_body: text,
    };

    if (cc && cc.length) {
      payload.cc = cc.map(c => c.name ? `${c.name} <${c.email}>` : c.email);
    }

    if (attachments && attachments.length) {
      payload.attachments = attachments.map(att => ({
        filename: att.filename,
        fileblob: att.content_base64,
        mimetype: att.content_type,
      }));
    }

    const res = await axios.post('https://api.smtp2go.com/v3/email/send', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });

    const emailId = res.data && res.data.data && res.data.data.email_id ? res.data.data.email_id : `smtp2go_${Date.now()}`;
    logger.info(`[SMTP2GO] Email delivered successfully. MessageId: ${emailId}`);
    return { success: true, messageId: emailId, provider: 'smtp2go' };
  }
}

module.exports = Smtp2goProvider;
