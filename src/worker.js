const { Worker } = require('bullmq');
const nodemailer = require('nodemailer');
const { connection } = require('./redis');
const config = require('./config');
const { EMAIL_QUEUE_NAME } = require('./queue');
const { renderTemplate } = require('./templates');

let cachedConfig = null;
let cachedConfigString = '';
let cachedTransporter = null;

const getDynamicConfig = async () => {
  try {
    let smtpConfig = config.smtp;
    let senderString = config.senderDefault;
    
    // Check if admin has set custom config in Redis
    const redisConfigStr = await connection.get('config:email_provider');
    if (redisConfigStr) {
      if (cachedConfigString === redisConfigStr && cachedTransporter) {
        return { transporter: cachedTransporter, senderString: cachedConfig.senderString };
      }
      
      const parsed = JSON.parse(redisConfigStr);
      smtpConfig = {
        host: parsed.host,
        port: parsed.port,
        secure: parsed.secure,
        user: parsed.user,
        pass: parsed.pass,
      };
      
      if (parsed.senderName && parsed.senderEmail) {
          senderString = `"${parsed.senderName}" <${parsed.senderEmail}>`;
      }
      
      cachedConfigString = redisConfigStr;
    } else if (cachedTransporter && cachedConfig) {
        return { transporter: cachedTransporter, senderString: cachedConfig.senderString };
    }

    // Initialize new transporter
    logger.info(`[Worker] Creating SMTP transporter for host: ${smtpConfig.host}, port: ${smtpConfig.port}, secure: ${smtpConfig.secure}, user: ${smtpConfig.user ? '***' : 'none'}`);
    cachedTransporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: (smtpConfig.user && smtpConfig.pass) ? {
        user: smtpConfig.user,
        pass: smtpConfig.pass,
      } : undefined,
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === 'production'
      }
    });

    cachedConfig = { transporter: cachedTransporter, senderString };
    return cachedConfig;
  } catch (err) {
    logger.error({ err }, "Error creating transporter");
    throw err;
  }
};

const logger = require('./logger');
const { convert } = require('html-to-text');

const metrics = require('./metrics');

const processJob = async (job) => {
  const { payload } = job.data;
  const { to, cc, template_id, template_data, attachments } = payload;

  logger.info(`[Worker] Processing job ${job.id} - Template: ${template_id} to ${to.email}`);

  try {
    const htmlContent = await renderTemplate(template_id, template_data);
    const textContent = convert(htmlContent, { wordwrap: 130 });
    
    // Extract subject from <title> tag
    const titleMatch = htmlContent.match(/<title>(.*?)<\/title>/i);
    const subject = titleMatch && titleMatch[1] ? titleMatch[1] : `TimeQuant - Notification: ${template_id}`;

    const { transporter, senderString } = await getDynamicConfig();

    const mailOptions = {
      from: senderString,
      to: to.name ? `"${to.name}" <${to.email}>` : to.email,
      cc: cc ? cc.map(c => c.name ? `"${c.name}" <${c.email}>` : c.email).join(', ') : undefined,
      subject,
      html: htmlContent,
      text: textContent,
      attachments: attachments ? attachments.map(att => ({
        filename: att.filename,
        contentType: att.content_type,
        content: Buffer.from(att.content_base64, 'base64'),
      })) : undefined,
    };

    const info = await transporter.sendMail(mailOptions);
    logger.info(`[Worker] Job ${job.id} delivered. MessageId: ${info.messageId}`);
    
    // Increment success metric
    metrics.emailsSentCounter.inc();
    
    return info.messageId;

  } catch (error) {
    logger.error({ err: error }, `[Worker] Job ${job.id} failed`);
    
    // Increment fail metric
    metrics.emailsFailedCounter.inc();
    
    throw error; // Let BullMQ handle retries
  }
};

const worker = new Worker(EMAIL_QUEUE_NAME, processJob, { 
  connection,
  concurrency: 10, // Process multiple emails concurrently
});

worker.on('completed', (job) => {
  logger.info(`Job with id ${job.id} has been completed`);
});

worker.on('failed', (job, err) => {
  logger.error(`Job with id ${job.id} has failed with ${err.message}`);
});

module.exports = { worker };
