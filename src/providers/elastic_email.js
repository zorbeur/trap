/**
 * Elastic Email Provider (https://elasticemail.com)
 * Uses Elastic Email REST API v4
 */
const axios = require('axios');
const logger = require('../logger');

class ElasticEmailProvider {
  constructor() {
    this.name = 'elastic_email';
    this.enabled = process.env.ELASTIC_EMAIL_ENABLED === 'true';
    this.apiKey = process.env.ELASTIC_EMAIL_API_KEY || '';
    this.fromEmail = process.env.ELASTIC_EMAIL_FROM_EMAIL || process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local';
    this.fromName = process.env.ELASTIC_EMAIL_FROM_NAME || process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform';
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
    return this.enabled && !!this.apiKey && !this.apiKey.includes('your_elastic');
  }

  async send({ to, subject, html, text }) {
    logger.info(`[ElasticEmail] Attempting delivery to ${to.email}...`);

    const payload = {
      Recipients: [{ Email: to.email }],
      Content: {
        Body: [
          { ContentType: 'HTML', Content: html, Charset: 'utf-8' },
          { ContentType: 'PlainText', Content: text, Charset: 'utf-8' },
        ],
        From: `${this.fromName} <${this.fromEmail}>`,
        Subject: subject,
      },
    };

    const res = await axios.post('https://api.elasticemail.com/v4/emails/transactional', payload, {
      headers: {
        'X-ElasticEmail-ApiKey': this.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const msgId = res.data && res.data.TransactionID ? res.data.TransactionID : `ee_${Date.now()}`;
    logger.info(`[ElasticEmail] Email delivered successfully. MessageId: ${msgId}`);
    return { success: true, messageId: msgId, provider: 'elastic_email' };
  }
}

module.exports = ElasticEmailProvider;

