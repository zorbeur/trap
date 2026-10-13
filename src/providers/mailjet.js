/**
 * Mailjet Provider (https://mailjet.com)
 * Uses Mailjet REST API v3.1
 */
const axios = require('axios');
const logger = require('../logger');

class MailjetProvider {
  constructor() {
    this.name = 'mailjet';
    this.enabled = process.env.MAILJET_ENABLED === 'true';
    this.apiKey = process.env.MAILJET_API_KEY || '';
    this.secretKey = process.env.MAILJET_SECRET_KEY || '';
    this.fromEmail = process.env.MAILJET_FROM_EMAIL || process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local';
    this.fromName = process.env.MAILJET_FROM_NAME || process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform';
  }

  updateConfig(cfg = {}) {
    if (cfg.enabled !== undefined) this.enabled = Boolean(cfg.enabled);
    if (cfg.apiKey !== undefined && !String(cfg.apiKey).includes('••••')) this.apiKey = cfg.apiKey;
    if (cfg.secretKey !== undefined && !String(cfg.secretKey).includes('••••')) this.secretKey = cfg.secretKey;
    if (cfg.fromEmail !== undefined) this.fromEmail = cfg.fromEmail;
    if (cfg.fromName !== undefined) this.fromName = cfg.fromName;
  }

  getConfig(masked = true) {
    return {
      enabled: this.enabled,
      apiKey: masked ? (this.apiKey ? `${this.apiKey.slice(0, 4)}••••${this.apiKey.slice(-4)}` : '') : this.apiKey,
      secretKey: masked ? (this.secretKey ? '••••••••' : '') : this.secretKey,
      fromEmail: this.fromEmail,
      fromName: this.fromName,
    };
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !!this.secretKey && !this.apiKey.includes('your_mailjet');
  }

  async send({ to, cc, subject, html, text, attachments }) {
    logger.info(`[Mailjet] Attempting delivery to ${to.email}...`);

    const message = {
      From: { Email: this.fromEmail, Name: this.fromName },
      To: [{ Email: to.email, Name: to.name || undefined }],
      Subject: subject,
      HTMLPart: html,
      TextPart: text,
    };

    if (cc && cc.length) {
      message.Cc = cc.map(c => ({ Email: c.email, Name: c.name || undefined }));
    }

    if (attachments && attachments.length) {
      message.Attachments = attachments.map(att => ({
        ContentType: att.content_type,
        Filename: att.filename,
        Base64Content: att.content_base64,
      }));
    }

    const auth = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString('base64');
    const res = await axios.post('https://api.mailjet.com/v3.1/send', { Messages: [message] }, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const msgInfo = res.data && res.data.Messages && res.data.Messages[0];
    const messageId = msgInfo && msgInfo.To && msgInfo.To[0] && msgInfo.To[0].MessageID ? String(msgInfo.To[0].MessageID) : `mailjet_${Date.now()}`;
    logger.info(`[Mailjet] Email delivered successfully. MessageId: ${messageId}`);
    return { success: true, messageId, provider: 'mailjet' };
  }
}

module.exports = MailjetProvider;

