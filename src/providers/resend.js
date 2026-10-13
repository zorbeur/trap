/**
 * Resend Provider (https://resend.com)
 * Uses Resend REST API v1
 */
const axios = require('axios');
const logger = require('../logger');

class ResendProvider {
  constructor() {
    this.name = 'resend';
    this.enabled = process.env.RESEND_ENABLED === 'true';
    this.apiKey = process.env.RESEND_API_KEY || '';
    this.fromEmail = process.env.RESEND_FROM_EMAIL || process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local';
    this.fromName = process.env.RESEND_FROM_NAME || process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform';
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
    return this.enabled && !!this.apiKey && !this.apiKey.includes('your_api_key') && !this.apiKey.includes('demo');
  }

  async send({ to, cc, subject, html, text, attachments }) {
    logger.info(`[Resend] Attempting delivery to ${to.email}...`);

    const payload = {
      from: `${this.fromName} <${this.fromEmail}>`,
      to: [to.name ? `${to.name} <${to.email}>` : to.email],
      subject,
      html,
      text,
    };

    if (cc && cc.length) {
      payload.cc = cc.map(c => c.name ? `${c.name} <${c.email}>` : c.email);
    }

    if (attachments && attachments.length) {
      payload.attachments = attachments.map(att => ({
        filename: att.filename,
        content: att.content_base64,
      }));
    }

    const res = await axios.post('https://api.resend.com/emails', payload, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const messageId = res.data && res.data.id ? res.data.id : `resend_${Date.now()}`;
    logger.info(`[Resend] Email delivered successfully. MessageId: ${messageId}`);
    return { success: true, messageId, provider: 'resend' };
  }
}

module.exports = ResendProvider;

