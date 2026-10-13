const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const basicAuth = require('express-basic-auth');
const config = require('./config');
const { emailQueue } = require('./queue');
const { connection: redis } = require('./redis');
const { SendTemplatedEmailSchema, GenerateOtpSchema, VerifyOtpSchema } = require('./schemas');
const logger = require('./logger');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const metrics = require('./metrics');
const { getPool } = require('./db');
const { generateOtp, verifyOtp, OTP_EXPIRE_MINUTES } = require('./otp');
const providerManager = require('./providers');
const path = require('path');
const fs = require('fs');

const api = express();

// Initialize Bull Board
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

api.use(helmet({
  contentSecurityPolicy: false,
}));
api.use(cors());
api.use(express.json({ limit: '20mb' })); // Allow up to 20mb for base64 attachments

// Prometheus Metrics Route
api.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

const authMiddleware = basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASSWORD || 'timequant_admin_secret_2026' },
  challenge: true,
});

// Mount Bull Board UI with Basic Auth protection
api.use('/admin/queues', authMiddleware, serverAdapter.getRouter());

// Admin Settings UI Route
api.get('/admin/settings', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'admin_settings.html'));
});

// Utility to validate templateId and prevent path traversal
const isValidTemplateId = (id) => /^[a-zA-Z0-9_]+$/.test(id);

// ── Admin Endpoints ──────────────────────────────────────────────────

// System Overview & Realtime Metrics
api.get('/admin/api/overview', authMiddleware, async (req, res) => {
  try {
    const pool = getPool();
    const [statsRows] = await pool.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) as sending,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
      FROM emails;
    `);

    const stats = statsRows[0] || { total: 0, delivered: 0, queued: 0, sending: 0, failed: 0 };
    const deliveredCount = Number(stats.delivered) || 0;
    const totalCount = Number(stats.total) || 0;
    const deliveryRate = totalCount > 0 ? Math.round((deliveredCount / totalCount) * 100) : 100;

    let counts = { wait: 0, active: 0, delayed: 0, completed: 0, failed: 0 };
    try {
      counts = await emailQueue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
    } catch (_) {}

    const [recentRows] = await pool.query(`
      SELECT id, recipient_email, template_id, status, provider_used, attempts, error_message, created_at 
      FROM emails 
      ORDER BY created_at DESC 
      LIMIT 6;
    `);

    const available = providerManager.getAvailableProviders();

    return res.json({
      stats: {
        total: totalCount,
        delivered: deliveredCount,
        queued: Number(stats.queued) || 0,
        sending: Number(stats.sending) || 0,
        failed: Number(stats.failed) || 0,
        deliveryRate,
      },
      queue: counts,
      providers: {
        total: Object.keys(providerManager.providers).length,
        active: available.length,
        strategy: providerManager.strategy,
        order: providerManager.order,
      },
      recent_activity: recentRows,
    });
  } catch (err) {
    logger.error({ err }, '[Admin API] Overview error');
    res.status(500).json({ error: err.message });
  }
});

// Providers Status & Masked Configurations
api.get('/admin/api/providers', authMiddleware, async (req, res) => {
  try {
    const providers = await providerManager.getAllProvidersDetails();
    res.json({
      strategy: providerManager.strategy,
      order: providerManager.order,
      providers,
    });
  } catch (err) {
    logger.error({ err }, '[Admin API] Error getting providers');
    res.status(500).json({ error: err.message });
  }
});

// Update specific provider config
api.post('/admin/api/providers/:name', authMiddleware, async (req, res) => {
  try {
    const name = req.params.name;
    const updated = await providerManager.updateProviderConfig(name, req.body);
    res.json({ success: true, provider: updated });
  } catch (err) {
    logger.error({ err }, '[Admin API] Error updating provider');
    res.status(400).json({ error: err.message });
  }
});

// Toggle provider enabled state
api.post('/admin/api/providers/:name/toggle', authMiddleware, async (req, res) => {
  try {
    const name = req.params.name;
    const enabled = Boolean(req.body.enabled);
    const updated = await providerManager.toggleProvider(name, enabled);
    res.json({ success: true, provider: updated });
  } catch (err) {
    logger.error({ err }, '[Admin API] Error toggling provider');
    res.status(400).json({ error: err.message });
  }
});

// Test single provider delivery in real time
api.post('/admin/api/providers/:name/test', authMiddleware, async (req, res) => {
  try {
    const name = req.params.name;
    const toEmail = req.body.toEmail || req.body.to;
    if (!toEmail) {
      return res.status(400).json({ error: 'Adresse email de destination requise pour le test.' });
    }
    const result = await providerManager.testProvider(name, toEmail);
    res.json(result);
  } catch (err) {
    logger.error({ err }, `[Admin API] Error testing provider ${req.params.name}`);
    res.status(400).json({ error: err.message });
  }
});

// Routing strategy & failover order
api.get('/admin/api/routing', authMiddleware, (req, res) => {
  res.json({
    strategy: providerManager.strategy,
    order: providerManager.order,
  });
});

api.post('/admin/api/routing', authMiddleware, async (req, res) => {
  try {
    const { strategy, order } = req.body;
    const result = await providerManager.updateRouting(strategy, order);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, '[Admin API] Error updating routing');
    res.status(400).json({ error: err.message });
  }
});

// Logs & Email Delivery History
api.get('/admin/api/logs', authMiddleware, async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const status = req.query.status;
    const search = req.query.search ? `%${req.query.search}%` : null;

    let whereClauses = [];
    let params = [];

    if (status && status !== 'all') {
      whereClauses.push('status = ?');
      params.push(status);
    }
    if (search) {
      whereClauses.push('(recipient_email LIKE ? OR recipient_name LIKE ? OR template_id LIKE ? OR id LIKE ?)');
      params.push(search, search, search, search);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM emails ${whereSql};`, params);
    const total = countRows[0]?.total || 0;

    const [rows] = await pool.query(
      `SELECT id, idempotency_key, recipient_email, recipient_name, template_id, status, provider_used, message_id, attempts, error_message, metadata_json, created_at, updated_at 
       FROM emails 
       ${whereSql} 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?;`,
      [...params, limit, offset]
    );

    res.json({ total, limit, offset, items: rows });
  } catch (err) {
    logger.error({ err }, '[Admin API] Error querying logs');
    res.status(500).json({ error: err.message });
  }
});

// Retry / Re-enqueue failed or stalled email
api.post('/admin/api/logs/:id/retry', authMiddleware, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM emails WHERE id = ? LIMIT 1;', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Email non trouvé' });

    const item = rows[0];
    await pool.query('UPDATE emails SET status = "queued", attempts = 0, error_message = NULL WHERE id = ?;', [item.id]);

    let metadata = {};
    try {
      metadata = typeof item.metadata_json === 'string' ? JSON.parse(item.metadata_json) : (item.metadata_json || {});
    } catch (_) {}

    await emailQueue.add(item.id, {
      messageId: item.id,
      payload: {
        id: item.id,
        to: { email: item.recipient_email, name: item.recipient_name },
        template_id: item.template_id,
        template_data: metadata,
        priority: 'high',
      },
    }, {
      jobId: `${item.id}_retry_${Date.now()}`,
      priority: 1,
    });

    res.json({ success: true, message: 'Email réinséré dans la file de traitement.' });
  } catch (err) {
    logger.error({ err }, '[Admin API] Error retrying email');
    res.status(500).json({ error: err.message });
  }
});

// Legacy single-config route for backward compatibility
api.get('/admin/api/config', authMiddleware, (req, res) => {
  const smtp = providerManager.providers.smtp;
  const cfg = smtp ? smtp.getConfig(true) : {};
  res.json({
    host: cfg.host || '',
    port: cfg.port || 587,
    user: cfg.user || '',
    pass: cfg.pass || '',
    secure: cfg.secure || false,
    senderName: process.env.MAIL_DEFAULT_FROM_NAME || 'TimeQuant Platform',
    senderEmail: process.env.MAIL_DEFAULT_FROM_EMAIL || 'notifications@timequant.local',
  });
});

api.post('/admin/api/config', authMiddleware, async (req, res) => {
  try {
    if (providerManager.providers.smtp) {
      await providerManager.updateProviderConfig('smtp', {
        enabled: true,
        host: req.body.host,
        port: req.body.port,
        secure: req.body.secure,
        user: req.body.user,
        pass: req.body.pass,
        fromEmail: req.body.senderEmail,
        fromName: req.body.senderName,
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get template content (checks custom first, then default)
api.get('/admin/api/templates/:id', authMiddleware, (req, res) => {
  const templateId = req.params.id;
  if (!isValidTemplateId(templateId)) return res.status(400).json({ error: 'Invalid template ID' });

  const customPath = path.join(__dirname, '..', 'data', 'templates', `${templateId}.html`);
  const defaultPath = path.join(__dirname, 'templates', `${templateId}.html`);

  try {
    if (fs.existsSync(customPath)) {
      return res.json({ id: templateId, isCustom: true, content: fs.readFileSync(customPath, 'utf-8') });
    } else if (fs.existsSync(defaultPath)) {
      return res.json({ id: templateId, isCustom: false, content: fs.readFileSync(defaultPath, 'utf-8') });
    } else {
      return res.status(404).json({ error: 'Template not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error reading template' });
  }
});

// Save custom template
api.post('/admin/api/templates/:id', authMiddleware, (req, res) => {
  const templateId = req.params.id;
  if (!isValidTemplateId(templateId)) return res.status(400).json({ error: 'Invalid template ID' });

  const content = req.body.content;
  const customDir = path.join(__dirname, '..', 'data', 'templates');
  const customPath = path.join(customDir, `${templateId}.html`);

  try {
    if (!fs.existsSync(customDir)) {
      fs.mkdirSync(customDir, { recursive: true });
    }
    fs.writeFileSync(customPath, content, 'utf-8');
    logger.info(`Template ${templateId} customized by administrator`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error saving template' });
  }
});

// Restore default template (Delete custom)
api.delete('/admin/api/templates/:id', authMiddleware, (req, res) => {
  const templateId = req.params.id;
  if (!isValidTemplateId(templateId)) return res.status(400).json({ error: 'Invalid template ID' });

  const customPath = path.join(__dirname, '..', 'data', 'templates', `${templateId}.html`);

  try {
    if (fs.existsSync(customPath)) {
      fs.unlinkSync(customPath);
      logger.info(`Template ${templateId} restored to default by administrator`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error deleting template' });
  }
});

// Authentication Middleware (for platform API)
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== config.emailServiceApiKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
  next();
};

// ── Providers Information ─────────────────────────────────────────
api.get('/v1/providers', authenticate, (req, res) => {
  const available = providerManager.getAvailableProviders().map(p => ({
    name: p.name,
    available: true,
  }));
  res.json({
    strategy: providerManager.strategy,
    configured_order: providerManager.order,
    active_providers: available,
  });
});

// ── Send Templated Email Endpoint ──────────────────────────────────
api.post(['/v1/emails/send-templated', '/v1/send-templated'], authenticate, async (req, res) => {

  try {
    const idempotencyKey = req.headers['idempotency-key'] || `idemp_${uuidv4()}`;
    const pool = getPool();

    // 1. Check idempotency in MySQL
    if (idempotencyKey) {
      const [existing] = await pool.query(
        'SELECT id, status, provider_used, message_id, created_at FROM emails WHERE idempotency_key = ? LIMIT 1;',
        [idempotencyKey]
      );
      if (existing.length > 0) {
        const row = existing[0];
        return res.status(202).json({
          status: row.status,
          message_id: row.id,
          provider_used: row.provider_used,
          idempotency_key: idempotencyKey,
          created_at: row.created_at,
          cached: true,
        });
      }
    }

    // 2. Validate payload
    const parsedBody = SendTemplatedEmailSchema.parse(req.body);

    // Optional duration filter (default 0s, skips only if explicitly set in env)
    const minWallTime = parseInt(process.env.MIN_SIMULATION_DURATION_S || '0', 10);
    if (parsedBody.template_id === 'simulation_completed' && minWallTime > 0) {
      const wallTime = parsedBody.template_data?.wall_time_s;
      if (typeof wallTime === 'number' && wallTime < minWallTime) {
        logger.info(`Skipping email to ${parsedBody.to.email} - duration ${wallTime}s is under ${minWallTime}s threshold`);
        metrics.emailsSkippedCounter.labels('calculation_too_short').inc();
        return res.status(202).json({
          status: 'skipped',
          reason: `Calculation duration under ${minWallTime}s threshold`,
          idempotency_key: idempotencyKey,
        });
      }
    }

    // 3. Generic Rate Limiting per recipient in Redis (max 50 per hour)
    const rateLimitKey = `ratelimit:email:${parsedBody.to.email}`;
    const sentCount = await redis.incr(rateLimitKey);
    if (sentCount === 1) {
      await redis.expire(rateLimitKey, 3600); // 1 hour window
    }
    if (sentCount > 50) {
      logger.warn(`Rate limiting email to ${parsedBody.to.email}`);
      metrics.emailsSkippedCounter.labels('rate_limited').inc();
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Recipient has reached the maximum allowed emails per hour.'
      });
    }

    const messageId = `msg_${uuidv4()}`;
    const createdAt = new Date().toISOString();

    // 4. Persist immediately into MySQL 'emails' table (status: 'queued')
    await pool.query(`
      INSERT INTO emails (id, idempotency_key, recipient_email, recipient_name, template_id, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, 'queued', ?);
    `, [
      messageId,
      idempotencyKey,
      parsedBody.to.email,
      parsedBody.to.name || null,
      parsedBody.template_id,
      JSON.stringify(parsedBody.metadata || {}),
    ]);

    // Prepare response
    const responsePayload = {
      status: 'queued',
      message_id: messageId,
      email_id: messageId,
      idempotency_key: idempotencyKey,
      created_at: createdAt,
    };


    // 5. Enqueue job into BullMQ
    parsedBody.id = messageId; // attach database id so worker updates this exact row
    await emailQueue.add(messageId, {
      messageId,
      payload: parsedBody,
    }, {
      jobId: messageId,
      priority: parsedBody.priority === 'high' ? 1 : (parsedBody.priority === 'low' ? 5 : 3),
    });

    metrics.emailsQueuedCounter.inc();
    return res.status(202).json(responsePayload);

  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Validation Error', details: error.errors });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload Too Large' });
    }
    logger.error({ err: error }, 'API Error');
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// ── One-Time Password (OTP) Endpoints ──────────────────────────────

// Generate and Send OTP verification code
api.post('/v1/otp/generate-and-send', authenticate, async (req, res) => {
  try {
    const { email, user_name, purpose } = GenerateOtpSchema.parse(req.body);
    const pool = getPool();

    // 1. Generate OTP (persisted hashed in MySQL)
    const otpData = await generateOtp(email, purpose);

    // 2. Select appropriate template based on purpose
    let templateId = 'email_verification';
    if (purpose === 'reset_password') {
      templateId = 'password_reset';
    }

    const messageId = `msg_otp_${uuidv4()}`;
    const idempotencyKey = `idemp_otp_${otpData.otpId}`;

    const templateData = {
      user_name: user_name || 'Chercheur',
      email: email,
      otp_code: otpData.code,
      code: otpData.code,
      expiry_minutes: otpData.expiresMinutes,
      purpose,
    };

    // 3. Record in MySQL emails table
    await pool.query(`
      INSERT INTO emails (id, idempotency_key, recipient_email, recipient_name, template_id, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, 'queued', ?);
    `, [
      messageId,
      idempotencyKey,
      email,
      user_name || null,
      templateId,
      JSON.stringify({ otp_id: otpData.otpId, purpose }),
    ]);

    // 4. Enqueue high-priority delivery job
    await emailQueue.add(messageId, {
      messageId,
      payload: {
        id: messageId,
        to: { email, name: user_name },
        template_id: templateId,
        template_data: templateData,
        priority: 'high',
      },
    }, {
      jobId: messageId,
      priority: 1, // highest priority
    });

    return res.status(202).json({
      status: 'queued',
      message_id: messageId,
      email,
      purpose,
      expires_minutes: otpData.expiresMinutes,
      cooldown_seconds: 60,
    });

  } catch (error) {
    if (error.cooldown) {
      return res.status(429).json({
        error: 'Cooldown active',
        message: error.message,
        remaining_seconds: error.remainingSeconds,
      });
    }
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Validation Error', details: error.errors });
    }
    logger.error({ err: error }, '[API] OTP generation failed');
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// Verify OTP code submitted by user
api.post('/v1/otp/verify', authenticate, async (req, res) => {
  try {
    const { email, code, purpose } = VerifyOtpSchema.parse(req.body);
    const result = await verifyOtp(email, code, purpose);
    if (!result.valid) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Validation Error', details: error.errors });
    }
    logger.error({ err: error }, '[API] OTP verification error');
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

// ── Delivery Status Endpoint ───────────────────────────────────────
api.get('/v1/emails/:message_id/status', authenticate, async (req, res) => {
  const { message_id } = req.params;
  const pool = getPool();

  try {
    const [rows] = await pool.query(
      'SELECT id, status, provider_used, message_id as upstream_id, attempts, error_message, created_at, updated_at FROM emails WHERE id = ? OR idempotency_key = ? LIMIT 1;',
      [message_id, message_id]
    );

    if (rows.length > 0) {
      const row = rows[0];
      return res.json({
        message_id: row.id,
        status: row.status,
        provider_used: row.provider_used,
        upstream_id: row.upstream_id,
        attempts: row.attempts,
        error_message: row.error_message,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }

    // Fallback to BullMQ
    const job = await emailQueue.getJob(message_id);
    if (!job) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const state = await job.getState();
    let status = 'queued';
    if (state === 'completed') status = 'delivered';
    else if (state === 'failed') status = 'failed';
    else if (state === 'active') status = 'sending';

    return res.json({
      message_id,
      status,
      attempts: job.attemptsMade,
    });

  } catch (err) {
    logger.error({ err }, '[API] Status query failed');
    return res.status(500).json({ error: 'Database error' });
  }
});

// ── Health Check Endpoint ──────────────────────────────────────────
api.get('/v1/health', async (req, res) => {
  try {
    const counts = await emailQueue.getJobCounts('wait', 'active', 'delayed', 'failed');
    const queue_backlog = counts.wait + counts.delayed;

    // Check Redis connection
    await redis.ping();

    // Check MySQL connection
    const pool = getPool();
    await pool.query('SELECT 1;');

    const activeProviders = providerManager.getAvailableProviders().map(p => p.name);

    res.json({
      status: 'healthy',
      database: 'mysql_connected',
      queue_backlog,
      active_providers: activeProviders,
      routing_strategy: providerManager.strategy,
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err.message,
    });
  }
});

module.exports = api;
