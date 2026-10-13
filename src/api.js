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
