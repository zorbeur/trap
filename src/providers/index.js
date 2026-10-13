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
const { getPool, getSetting, setSetting, getAllSettings } = require('../db');
const logger = require('../logger');

const PROVIDER_METADATA = {
  brevo: {
    displayName: 'Brevo (Sendinblue)',
    type: 'Relais SMTP & REST API',
    website: 'https://brevo.com',
    description: 'Relais transactionnel haute délivrabilité européen (ex-Sendinblue).',
    fields: [
      { name: 'apiKey', label: 'Clé API REST (v3)', type: 'password', placeholder: 'xkeysib-...' },
      { name: 'smtpHost', label: 'Hôte SMTP', type: 'text', default: 'smtp-relay.brevo.com' },
      { name: 'smtpPort', label: 'Port SMTP', type: 'number', default: 587 },
      { name: 'smtpSecure', label: 'Sécurité SSL direct (465)', type: 'checkbox', default: false },
      { name: 'smtpUser', label: 'Utilisateur SMTP', type: 'text', placeholder: 'votre-login@smtp-brevo.com' },
      { name: 'smtpPass', label: 'Mot de passe SMTP', type: 'password' },
      { name: 'fromEmail', label: 'Email Expéditeur vérifié', type: 'email', placeholder: 'notifications@timequant.org' },
      { name: 'fromName', label: 'Nom Expéditeur', type: 'text', placeholder: 'TimeQuant Platform' },
    ],
  },
  mailjet: {
    displayName: 'Mailjet',
    type: 'REST API v3.1',
    website: 'https://mailjet.com',
    description: 'Service européen conforme RGPD avec routage direct API.',
    fields: [
      { name: 'apiKey', label: 'Clé API Publique', type: 'text', placeholder: 'Clé API Mailjet' },
      { name: 'secretKey', label: 'Clé API Secrète', type: 'password', placeholder: 'Secret Mailjet' },
      { name: 'fromEmail', label: 'Email Expéditeur vérifié', type: 'email', placeholder: 'notifications@timequant.org' },
      { name: 'fromName', label: 'Nom Expéditeur', type: 'text', placeholder: 'TimeQuant Platform' },
    ],
  },
  smtp2go: {
    displayName: 'SMTP2GO',
    type: 'REST API v3',
    website: 'https://smtp2go.com',
    description: 'Réseau mondial dédié aux emails transactionnels critiques.',
    fields: [
      { name: 'apiKey', label: 'Clé API (api-...)', type: 'password', placeholder: 'api-...' },
      { name: 'fromEmail', label: 'Email Expéditeur vérifié', type: 'email', placeholder: 'notifications@timequant.org' },
      { name: 'fromName', label: 'Nom Expéditeur', type: 'text', placeholder: 'TimeQuant Platform' },
    ],
  },
  resend: {
    displayName: 'Resend',
    type: 'REST API v1',
    website: 'https://resend.com',
    description: 'Plateforme moderne axée sur la réactivité pour développeurs.',
    fields: [
      { name: 'apiKey', label: 'Clé API Resend (re_...)', type: 'password', placeholder: 're_...' },
      { name: 'fromEmail', label: 'Email Expéditeur vérifié', type: 'email', placeholder: 'notifications@timequant.org' },
      { name: 'fromName', label: 'Nom Expéditeur', type: 'text', placeholder: 'TimeQuant Platform' },
    ],
  },
  mailgun: {
    displayName: 'Mailgun',
    type: 'REST API v3',
    website: 'https://mailgun.com',
    description: 'Infrastructure haute cadence avec analyse SPF/DKIM.',
    fields: [
      { name: 'apiKey', label: 'Clé API Mailgun', type: 'password', placeholder: 'key-...' },
      { name: 'domain', label: 'Domaine d\'envoi configuré', type: 'text', placeholder: 'mg.votredomaine.com' },
      { name: 'region', label: 'Région (us ou eu)', type: 'select', options: ['us', 'eu'], default: 'us' },
      { name: 'fromEmail', label: 'Email Expéditeur vérifié', type: 'email', placeholder: 'notifications@timequant.org' },
      { name: 'fromName', label: 'Nom Expéditeur', type: 'text', placeholder: 'TimeQuant Platform' },
    ],
  },
  elastic_email: {
    displayName: 'Elastic Email',
    type: 'REST API v4',
    website: 'https://elasticemail.com',
    description: 'API transactionnelle performante et économique.',
    fields: [
      { name: 'apiKey', label: 'Clé API Elastic Email', type: 'password', placeholder: 'Clé API' },
      { name: 'fromEmail', label: 'Email Expéditeur vérifié', type: 'email', placeholder: 'notifications@timequant.org' },
      { name: 'fromName', label: 'Nom Expéditeur', type: 'text', placeholder: 'TimeQuant Platform' },
    ],
  },
  mailersend: {
    displayName: 'MailerSend',
    type: 'REST API v1',
    website: 'https://mailersend.com',
    description: 'API transactionnelle moderne conçue par MailerLite.',
    fields: [
      { name: 'apiKey', label: 'Jeton API (mlsn....)', type: 'password', placeholder: 'mlsn....' },
      { name: 'fromEmail', label: 'Email Expéditeur vérifié', type: 'email', placeholder: 'notifications@timequant.org' },
      { name: 'fromName', label: 'Nom Expéditeur', type: 'text', placeholder: 'TimeQuant Platform' },
    ],
  },
  smtp: {
    displayName: 'SMTP Personnalisé / Interne',
    type: 'Serveur SMTP Standard',
    website: '',
    description: 'Serveur de relais SMTP d\'entreprise, Postfix ou passerelle locale.',
    fields: [
      { name: 'host', label: 'Serveur Hôte (Host)', type: 'text', placeholder: 'mail.entreprise.lan' },
      { name: 'port', label: 'Port SMTP (587, 465, 25)', type: 'number', default: 587 },
      { name: 'secure', label: 'SSL/TLS direct (port 465)', type: 'checkbox', default: false },
      { name: 'user', label: 'Identifiant / Nom d\'utilisateur', type: 'text', placeholder: 'smtp-user' },
      { name: 'pass', label: 'Mot de passe SMTP', type: 'password' },
      { name: 'fromEmail', label: 'Email Expéditeur', type: 'email', placeholder: 'notifications@timequant.org' },
      { name: 'fromName', label: 'Nom Expéditeur', type: 'text', placeholder: 'TimeQuant Platform' },
    ],
  },
};

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
    this.isLoadedFromDb = false;
  }

  async loadSettingsFromDb() {
    try {
      const settings = await getAllSettings();
      if (settings.routing_strategy) {
        this.strategy = settings.routing_strategy;
      }
      if (settings.provider_order) {
        const orderArr = typeof settings.provider_order === 'string'
          ? settings.provider_order.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
          : settings.provider_order;
        if (Array.isArray(orderArr) && orderArr.length > 0) {
          this.order = orderArr;
        }
      }

      for (const [name, provider] of Object.entries(this.providers)) {
        const key = `provider_${name}`;
        if (settings[key] && typeof settings[key] === 'object') {
          provider.updateConfig(settings[key]);
        }
      }
      this.isLoadedFromDb = true;
      logger.info(`[ProviderManager] Loaded dynamic settings from MySQL: strategy=${this.strategy}, order=${this.order.join(',')}`);
    } catch (err) {
      logger.debug({ err }, '[ProviderManager] Note: Could not load dynamic settings from MySQL yet (will use env defaults)');
    }
  }

  getAvailableProviders() {
    return this.order
      .filter(name => this.providers[name] && this.providers[name].isAvailable())
      .map(name => this.providers[name]);
  }

  async updateProviderConfig(name, newConfig) {
    const provider = this.providers[name];
    if (!provider) {
      throw new Error(`Fournisseur '${name}' inconnu.`);
    }

    provider.updateConfig(newConfig);

    // Save full unmasked config into MySQL mailer_settings
    const unmaskedConfig = provider.getConfig(false);
    await setSetting(`provider_${name}`, unmaskedConfig);

    // Update is_enabled in provider_metrics if exists
    try {
      const pool = getPool();
      await pool.query(`
        INSERT INTO provider_metrics (provider_name, is_enabled)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled);
      `, [name, provider.enabled]);
    } catch (_) {}

    logger.info(`[ProviderManager] Updated config for provider '${name}' (enabled: ${provider.enabled})`);
    return this.getProviderDetail(name);
  }

  async toggleProvider(name, enabled) {
    const provider = this.providers[name];
    if (!provider) {
      throw new Error(`Fournisseur '${name}' inconnu.`);
    }
    return this.updateProviderConfig(name, { enabled: Boolean(enabled) });
  }

  async updateRouting(strategy, order) {
    if (strategy && ['priority', 'round_robin'].includes(strategy)) {
      this.strategy = strategy;
      await setSetting('routing_strategy', strategy);
    }

    if (order) {
      let orderArr = [];
      if (Array.isArray(order)) {
        orderArr = order;
      } else if (typeof order === 'string') {
        orderArr = order.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      }
      // Ensure all valid providers are included
      const validNames = Object.keys(this.providers);
      const filtered = orderArr.filter(n => validNames.includes(n));
      for (const n of validNames) {
        if (!filtered.includes(n)) filtered.push(n);
      }
      this.order = filtered;
      await setSetting('provider_order', this.order.join(','));
    }

    logger.info(`[ProviderManager] Updated routing: strategy=${this.strategy}, order=${this.order.join(',')}`);
    return {
      strategy: this.strategy,
      order: this.order,
    };
  }

  async testProvider(name, toEmail) {
    const provider = this.providers[name];
    if (!provider) {
      throw new Error(`Fournisseur '${name}' inconnu.`);
    }

    const testRecipient = toEmail || process.env.MAIL_DEFAULT_FROM_EMAIL || 'test@timequant.local';
    const startTime = Date.now();

    const mailData = {
      to: { email: testRecipient, name: 'Admin Test' },
      subject: `[Test Live TimeQuant] Test de connectivité - ${PROVIDER_METADATA[name]?.displayName || name}`,
      html: `
        <div style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 8px;">
          <h2 style="color: #38bdf8; margin-top: 0;">Test de Connexion Opérationnel</h2>
          <p>Ce message confirme que le fournisseur <strong>${PROVIDER_METADATA[name]?.displayName || name}</strong> est correctement configuré et opérationnel sur la plateforme TimeQuant.</p>
          <hr style="border: none; border-top: 1px solid #334155; margin: 16px 0;" />
          <ul style="color: #94a3b8; font-size: 13px;">
            <li><strong>Fournisseur :</strong> ${name}</li>
            <li><strong>Protocole / API :</strong> ${PROVIDER_METADATA[name]?.type || 'N/A'}</li>
            <li><strong>Horodatage :</strong> ${new Date().toISOString()}</li>
          </ul>
        </div>
      `,
      text: `Test de connectivité réussi pour ${name} sur TimeQuant Platform à ${new Date().toISOString()}`,
    };

    try {
      logger.info(`[ProviderManager] Testing single provider '${name}' to ${testRecipient}...`);
      const result = await provider.send(mailData);
      const latencyMs = Date.now() - startTime;
      await this.recordMetric(name, true);
      return {
        success: true,
        provider: name,
        messageId: result.messageId || 'ok',
        latency_ms: latencyMs,
        details: result,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
      await this.recordMetric(name, false, errorMsg);
      throw new Error(`Échec du test [${name}]: ${errorMsg}`);
    }
  }

  async getAllProvidersDetails() {
    let metricsMap = {};
    try {
      const pool = getPool();
      const [rows] = await pool.query('SELECT provider_name, is_enabled, success_count, fail_count, last_error, last_success_at, updated_at FROM provider_metrics;');
      for (const r of rows) {
        metricsMap[r.provider_name] = r;
      }
    } catch (_) {}

    return Object.keys(this.providers).map(id => {
      const provider = this.providers[id];
      const meta = PROVIDER_METADATA[id] || {};
      const metric = metricsMap[id] || {};
      const isAvailable = provider.isAvailable();

      let health = 'unconfigured';
      if (!provider.enabled) {
        health = isAvailable ? 'disabled' : 'unconfigured';
      } else if (metric.fail_count > 0 && metric.last_error && (!metric.last_success_at || metric.updated_at > metric.last_success_at)) {
        health = 'error';
      } else if (isAvailable) {
        health = 'healthy';
      }

      return {
        id,
        name: meta.displayName || id,
        type: meta.type || 'Standard',
        description: meta.description || '',
        website: meta.website || '',
        enabled: provider.enabled,
        isAvailable,
        health,
        priorityRank: this.order.indexOf(id) !== -1 ? this.order.indexOf(id) + 1 : 99,
        config: provider.getConfig(true),
        fields: meta.fields || [],
        metrics: {
          success_count: metric.success_count || 0,
          fail_count: metric.fail_count || 0,
          last_error: metric.last_error || null,
          last_success_at: metric.last_success_at || null,
        },
      };
    }).sort((a, b) => a.priorityRank - b.priorityRank);
  }

  async getProviderDetail(name) {
    const list = await this.getAllProvidersDetails();
    return list.find(p => p.id === name);
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
      throw new Error('[ProviderManager] Aucun fournisseur de messagerie n\'est configuré ou disponible. Veuillez activer et configurer un fournisseur dans l\'administration.');
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
    throw new Error(`[ProviderManager] Tous les fournisseurs dans la chaîne de secours ont échoué: ${failureSummary}`);
  }
}

const providerManager = new ProviderManager();
module.exports = providerManager;
