/**
 * MailerSend Provider (https://mailersend.com)
 * Uses MailerSend REST API v1
 */
const axios = require('axios');
const logger = require('../logger');

class MailerSendProvider {
  constructor() {
    this.name = 'mailersend';
    this.enabled = process.env.MAILERSEND_ENABLED === 'true';
    this.apiKey = process.env.MAILERSEND_API_KEY || '';
    this.fromEmail = process.env.MAILERSEND_FROM_EMAIL || process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local';
    this.fromName = process.env.MAILERSEND_FROM_NAME || process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform';
  }

  updateConfig(cfg = {}) {
    if (cfg.enabled !== undefined) this.enabled = Boolean(cfg.enabled);
    if (cfg.apiKey !== undefined && !String(cfg.apiKey).includes('••••')) this.apiKey = cfg.apiKey;
    if (cfg.fromEmail !== undefined) this.fromEmail = cfg.fromEmail;
    if (cfg.fromName !== undefined) this.fromName = cfg.fromName;
  }

  getConfig(masked = true) {
    return {
      enabled: this.enabled,
      apiKey: masked ? (this.apiKey ? `${this.apiKey.slice(0, 4)}••••${this.apiKey.slice(-4)}` : '') : this.apiKey,
      fromEmail: this.fromEmail,
      fromName: this.fromName,
    };
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !this.apiKey.includes('your_mailersend');
  }

  async send({ to, cc, subject, html, text }) {
    logger.info(`[MailerSend] Attempting delivery to ${to.email}...`);

    const payload = {
      from: { email: this.fromEmail, name: this.fromName },
      to: [{ email: to.email, name: to.name || undefined }],
      subject,
      html,
      text,
    };

    if (cc && cc.length) {
      payload.cc = cc.map(c => ({ email: c.email, name: c.name || undefined }));
    }

    const res = await axios.post('https://api.mailersend.com/v1/email', payload, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const msgId = res.headers['x-message-id'] || `ms_${Date.now()}`;
    logger.info(`[MailerSend] Email delivered successfully. MessageId: ${msgId}`);
    return { success: true, messageId: msgId, provider: 'mailersend' };
  }
}

module.exports = MailerSendProvider;

