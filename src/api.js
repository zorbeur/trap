const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const basicAuth = require('express-basic-auth');
const config = require('./config');
const { emailQueue } = require('./queue');
const { connection: redis } = require('./redis');
const { SendTemplatedEmailSchema } = require('./schemas');
const logger = require('./logger');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const metrics = require('./metrics');

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
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASSWORD || 'supersecret' },
  challenge: true,
});

// Mount Bull Board UI with Basic Auth protection
api.use('/admin/queues', authMiddleware, serverAdapter.getRouter());

const path = require('path');

// Admin Settings UI Route
api.get('/admin/settings', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'admin_settings.html'));
});

// Admin Settings API Routes
api.get('/admin/api/config', authMiddleware, async (req, res) => {
  try {
    const data = await redis.get('config:email_provider');
    if (data) {
      res.json(JSON.parse(data));
    } else {
      res.json({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        user: config.smtp.user,
        pass: '', // Do not leak password via API if relying on env
        senderName: 'TimeQuant Platform',
        senderEmail: 'notifications@timequant.org'
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

api.post('/admin/api/config', authMiddleware, async (req, res) => {
  try {
    const newConfig = {
      senderName: req.body.senderName,
      senderEmail: req.body.senderEmail,
      host: req.body.host,
      port: req.body.port,
      user: req.body.user,
      pass: req.body.pass,
      secure: req.body.secure,
    };
    await redis.set('config:email_provider', JSON.stringify(newConfig));
    logger.info('SMTP provider configuration updated by administrator');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

const fs = require('fs');

// Utility to validate templateId and prevent path traversal
const isValidTemplateId = (id) => /^[a-zA-Z0-9_]+$/.test(id);

// Get template content (checks custom first, then default)
api.get('/admin/api/templates/:id', authMiddleware, (req, res) => {
  const templateId = req.params.id;
  if (!isValidTemplateId(templateId)) return res.status(400).json({ error: 'Invalid template ID' });

  const fileName = `${templateId}.html`;
  const customPath = path.join(__dirname, '..', 'data', 'templates', fileName);
  const defaultPath = path.join(__dirname, 'templates', fileName);

  try {
    if (fs.existsSync(customPath)) {
      const content = fs.readFileSync(customPath, 'utf-8');
      res.json({ content, source: 'custom' });
    } else if (fs.existsSync(defaultPath)) {
      const content = fs.readFileSync(defaultPath, 'utf-8');
      res.json({ content, source: 'default' });
    } else {
      res.status(404).json({ error: 'Template not found' });
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

api.post('/v1/emails/send-templated', authenticate, async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Missing Idempotency-Key header' });
    }

    // Check idempotency in Redis
    const cacheKey = `idempotency:email:${idempotencyKey}`;
    const cachedResult = await redis.get(cacheKey);
    
    if (cachedResult) {
      // Already processed, return identical response
      return res.status(202).json(JSON.parse(cachedResult));
    }

    // Validate payload
    const parsedBody = SendTemplatedEmailSchema.parse(req.body);

    // Rule 1: Skip if template is simulation_completed and calculation time < 6h (21600s)
    if (parsedBody.template_id === 'simulation_completed') {
      const wallTime = parsedBody.template_data?.wall_time_s;
      if (typeof wallTime === 'number' && wallTime < 21600) {
        logger.info(`Skipping email to ${parsedBody.to.email} - calculation time ${wallTime}s is less than 6h`);
        metrics.emailsSkippedCounter.labels('calculation_too_short').inc();
        return res.status(202).json({
          status: 'skipped',
          reason: 'Calculation duration under 6h threshold',
          idempotency_key: idempotencyKey,
        });
      }
    }

    // Rule 2: Generic Rate Limiting per recipient (max 10 per hour)
    const rateLimitKey = `ratelimit:email:${parsedBody.to.email}`;
    const sentCount = await redis.incr(rateLimitKey);
    if (sentCount === 1) {
      await redis.expire(rateLimitKey, 3600); // 1 hour window
    }
    if (sentCount > 10) {
      logger.warn(`Rate limiting email to ${parsedBody.to.email}`);
      metrics.emailsSkippedCounter.labels('rate_limited').inc();
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Recipient has reached the maximum allowed emails per hour.'
      });
    }

    const messageId = `msg_${uuidv4()}`;
    const createdAt = new Date().toISOString();

    // Prepare response
    const responsePayload = {
      status: 'queued',
      message_id: messageId,
      idempotency_key: idempotencyKey,
      created_at: createdAt,
    };

    // Store in Redis (expires in 24 hours = 86400 seconds)
    await redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', 86400);

    // Enqueue job
    await emailQueue.add(messageId, {
      messageId,
      payload: parsedBody,
    }, {
      jobId: messageId, // Ensure BullMQ doesn't create duplicate jobs for the same messageId
    });

    metrics.emailsQueuedCounter.inc();

    return res.status(202).json(responsePayload);

  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: 'Validation Error', details: error.errors });
    }
    // Handle specific payload too large
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload Too Large' });
    }
    logger.error({ err: error }, 'API Error');
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delivery Webhook Endpoint
api.post('/v1/webhooks/delivery', async (req, res) => {
  // Generic webhook receiver for SaaS providers
  const payload = req.body;
  const events = Array.isArray(payload) ? payload : [payload];

  for (const event of events) {
    // Attempt to extract common fields
    const messageId = event.message_id || event.MessageId || event.sg_message_id;
    const type = event.event || event.eventType || event.type; // e.g., 'bounce', 'delivered'
    
    if (messageId && type) {
      metrics.webhooksReceivedCounter.labels(type).inc();
      
      if (['bounce', 'bounced', 'hard_bounce', 'dropped', 'spamreport'].includes(type.toLowerCase())) {
        logger.warn(`Webhook: Message ${messageId} bounced/dropped`);
        await redis.set(`status:email:${messageId}`, 'bounced', 'EX', 86400 * 30); // keep for 30 days
      } else if (['delivered', 'delivered'].includes(type.toLowerCase())) {
        await redis.set(`status:email:${messageId}`, 'delivered_webhook', 'EX', 86400 * 30);
      }
    }
  }

  res.json({ success: true });
});

api.get('/v1/emails/:message_id/status', authenticate, async (req, res) => {
  const { message_id } = req.params;
  
  // 1. Check if a webhook already marked it as bounced or delivered
  const webhookStatus = await redis.get(`status:email:${message_id}`);
  
  // 2. Fallback to BullMQ status
  const job = await emailQueue.getJob(message_id);
  
  if (!job && !webhookStatus) {
    return res.status(404).json({ error: 'Message not found' });
  }

  let status = 'queued';
  
  if (webhookStatus) {
    status = webhookStatus;
  } else if (job) {
    const state = await job.getState();
    if (state === 'completed') status = 'delivered';
    else if (state === 'failed') status = 'failed';
    else if (state === 'active') status = 'sending';
    else if (state === 'delayed') status = 'queued';
  }

  res.json({
    message_id,
    status,
    delivered_at: (status.includes('delivered') && job) ? new Date(job.finishedOn).toISOString() : null,
    attempts: job ? job.attemptsMade : null,
  });
});

api.get('/v1/health', async (req, res) => {
  try {
    const counts = await emailQueue.getJobCounts('wait', 'active', 'delayed', 'failed');
    const queue_backlog = counts.wait + counts.delayed;
    
    // Check Redis connection
    await redis.ping();

    res.json({
      status: 'healthy',
      queue_backlog,
      upstream_provider: 'operational' // Mocked for now, could check SMTP connection
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err.message
    });
  }
});

module.exports = api;
