/**
 * ProviderManager - Aggregator & Failover Engine for Multi-Provider Email Delivery
 * Aggregates: Brevo, Mailjet, SMTP2GO, Resend, Mailgun, Elastic Email, MailerSend, SMTP
 */
const BrevoProvider = require('./brevo');
const ResendProvider = require('./resend');
const MailjetProvider = require('./mailjet');
const Smtp2goProvider = require('./smtp2go');
const MailgunProvider = require('./mailgun');
const ElasticEmailProvider = require('./elastic_email');
const MailerSendProvider = require('./mailersend');
const GenericSmtpProvider = require('./smtp');
const { getPool } = require('../db');
const logger = require('../logger');

class ProviderManager {
  constructor() {
    this.providers = {
      brevo: new BrevoProvider(),
      resend: new ResendProvider(),
      mailjet: new MailjetProvider(),
      smtp2go: new Smtp2goProvider(),
      mailgun: new MailgunProvider(),
      elastic_email: new ElasticEmailProvider(),
      mailersend: new MailerSendProvider(),
      smtp: new GenericSmtpProvider(),
    };

    this.strategy = process.env.MAILER_ROUTING_STRATEGY || 'priority';
    const orderEnv = process.env.MAILER_PROVIDER_ORDER || 'brevo,mailjet,smtp2go,resend,mailgun,elastic_email,mailersend,smtp';
    this.order = orderEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    this.roundRobinIndex = 0;
  }

  getAvailableProviders() {
    return this.order
      .filter(name => this.providers[name] && this.providers[name].isAvailable())
      .map(name => this.providers[name]);
  }

  async recordMetric(providerName, success, errorMsg = null) {
    try {
      const pool = getPool();
      if (success) {
        await pool.query(`
          INSERT INTO provider_metrics (provider_name, is_enabled, success_count, last_success_at)
          VALUES (?, TRUE, 1, NOW())
          ON DUPLICATE KEY UPDATE success_count = success_count + 1, last_success_at = NOW();
        `, [providerName]);
      } else {
        await pool.query(`
          INSERT INTO provider_metrics (provider_name, is_enabled, fail_count, last_error)
          VALUES (?, TRUE, 1, ?)
          ON DUPLICATE KEY UPDATE fail_count = fail_count + 1, last_error = ?;
        `, [providerName, String(errorMsg || '').slice(0, 500), String(errorMsg || '').slice(0, 500)]);
      }
    } catch (e) {
      logger.debug({ err: e }, '[ProviderManager] Could not update provider_metrics in MySQL');
    }
  }

  async send(mailData) {
    const available = this.getAvailableProviders();
    if (available.length === 0) {
      throw new Error('[ProviderManager] No email provider is configured or available. Check services/mailer/.env');
    }

    // Determine sequence of providers to try
    let candidateProviders = [];
    if (this.strategy === 'round_robin') {
      const startIdx = this.roundRobinIndex % available.length;
      this.roundRobinIndex++;
      candidateProviders = [
        ...available.slice(startIdx),
        ...available.slice(0, startIdx),
      ];
    } else {
      // Default: priority order
      candidateProviders = [...available];
    }

    const errors = [];
    for (const provider of candidateProviders) {
      try {
        logger.info(`[ProviderManager] Routing email to provider '${provider.name}'...`);
        const result = await provider.send(mailData);
        await this.recordMetric(provider.name, true);
        return result;
      } catch (err) {
        const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        logger.warn(`[ProviderManager] Provider '${provider.name}' failed: ${errorMsg}. Failing over to next provider...`);
        errors.push({ provider: provider.name, error: errorMsg });
        await this.recordMetric(provider.name, false, errorMsg);
      }
    }

    const failureSummary = errors.map(e => `${e.provider}: ${e.error}`).join(' | ');
    throw new Error(`[ProviderManager] All email providers in failover chain failed: ${failureSummary}`);
  }
}

const providerManager = new ProviderManager();
module.exports = providerManager;
