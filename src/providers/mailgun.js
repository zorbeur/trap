/**
 * Mailgun Provider (https://mailgun.com)
 * Uses Mailgun REST API v3
 */
const axios = require('axios');
const logger = require('../logger');

class MailgunProvider {
  constructor() {
    this.name = 'mailgun';
    this.enabled = process.env.MAILGUN_ENABLED === 'true';
    this.apiKey = process.env.MAILGUN_API_KEY || '';
    this.domain = process.env.MAILGUN_DOMAIN || '';
    this.region = process.env.MAILGUN_REGION || 'us';
    this.fromEmail = process.env.MAILGUN_FROM_EMAIL || process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local';
    this.fromName = process.env.MAILGUN_FROM_NAME || process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform';
  }

  updateConfig(cfg = {}) {
    if (cfg.enabled !== undefined) this.enabled = Boolean(cfg.enabled);
    if (cfg.apiKey !== undefined && !String(cfg.apiKey).includes('••••')) this.apiKey = cfg.apiKey;
    if (cfg.domain !== undefined) this.domain = cfg.domain;
    if (cfg.region !== undefined) this.region = cfg.region;
    if (cfg.fromEmail !== undefined) this.fromEmail = cfg.fromEmail;
    if (cfg.fromName !== undefined) this.fromName = cfg.fromName;
  }

  getConfig(masked = true) {
    return {
      enabled: this.enabled,
      apiKey: masked ? (this.apiKey ? `${this.apiKey.slice(0, 4)}••••${this.apiKey.slice(-4)}` : '') : this.apiKey,
      domain: this.domain,
      region: this.region,
      fromEmail: this.fromEmail,
      fromName: this.fromName,
    };
  }

  isAvailable() {
    return this.enabled && !!this.apiKey && !!this.domain && !this.apiKey.includes('your_mailgun');
  }

  async send({ to, cc, subject, html, text }) {
    logger.info(`[Mailgun] Attempting delivery to ${to.email}...`);

    const host = this.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
    const url = `https://${host}/v3/${this.domain}/messages`;

    const params = new URLSearchParams();
    params.append('from', `${this.fromName} <${this.fromEmail}>`);
    params.append('to', to.name ? `${to.name} <${to.email}>` : to.email);
    if (cc && cc.length) {
      cc.forEach(c => params.append('cc', c.name ? `${c.name} <${c.email}>` : c.email));
    }
    params.append('subject', subject);
    if (html) params.append('html', html);
    if (text) params.append('text', text);

    const auth = Buffer.from(`api:${this.apiKey}`).toString('base64');
    const res = await axios.post(url, params.toString(), {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    });

    const id = res.data && res.data.id ? res.data.id : `mg_${Date.now()}`;
    logger.info(`[Mailgun] Email delivered successfully. MessageId: ${id}`);
    return { success: true, messageId: id, provider: 'mailgun' };
  }
}

module.exports = MailgunProvider;

