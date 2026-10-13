/**
 * worker.js - BullMQ Worker for Asynchronous Email Delivery
 * Powered by Multi-Provider Aggregation & MySQL Persistence
 */
const { Worker } = require('bullmq');
const { connection } = require('./redis');
const { EMAIL_QUEUE_NAME } = require('./queue');
const { renderTemplate } = require('./templates');
const providerManager = require('./providers');
const { getPool } = require('./db');
const logger = require('./logger');
const { convert } = require('html-to-text');
const metrics = require('./metrics');

const processJob = async (job) => {
  const { payload } = job.data;
  const { id: emailRecordId, to, cc, template_id, template_data, attachments } = payload;

  logger.info(`[Worker] Processing job ${job.id} (EmailID: ${emailRecordId || 'auto'}) - Template: ${template_id} to ${to.email}`);

  const pool = getPool();

  // Mark status as 'sending' in MySQL if record exists
  if (emailRecordId) {
    try {
      await pool.query('UPDATE emails SET status = "sending", attempts = ? WHERE id = ?;', [
        (job.attemptsMade || 0) + 1,
        emailRecordId,
      ]);
    } catch (e) {
      logger.debug({ err: e }, '[Worker] Could not update email status to sending');
    }
  }

  try {
    const htmlContent = await renderTemplate(template_id, template_data);
    const textContent = convert(htmlContent, { wordwrap: 130 });

    // Extract subject from <title> tag
    const titleMatch = htmlContent.match(/<title>(.*?)<\/title>/i);
    const subject = titleMatch && titleMatch[1] ? titleMatch[1] : `TimeQuant - Notification: ${template_id}`;

    // Dispatch through Multi-Provider Failover Engine
    const result = await providerManager.send({
      to,
      cc,
      subject,
      html: htmlContent,
      text: textContent,
      attachments,
    });

    logger.info(`[Worker] Job ${job.id} delivered via '${result.provider}'. MessageId: ${result.messageId}`);

    // Update MySQL status to 'delivered'
    if (emailRecordId) {
      try {
        await pool.query(`
          UPDATE emails
          SET status = "delivered", provider_used = ?, message_id = ?, subject = ?, attempts = ?
          WHERE id = ?;
        `, [result.provider, result.messageId, subject, (job.attemptsMade || 0) + 1, emailRecordId]);
      } catch (e) {
        logger.debug({ err: e }, '[Worker] Could not update email status to delivered');
      }
    }

    // Increment success metric
    metrics.emailsSentCounter.inc();
    return result;

  } catch (error) {
    const errMsg = error.message || String(error);
    logger.error({ err: error }, `[Worker] Job ${job.id} failed delivery: ${errMsg}`);

    // Update MySQL status to 'failed'
    if (emailRecordId) {
      try {
        await pool.query(`
          UPDATE emails
          SET status = "failed", error_message = ?, attempts = ?
          WHERE id = ?;
        `, [errMsg.slice(0, 1000), (job.attemptsMade || 0) + 1, emailRecordId]);
      } catch (e) {
        logger.debug({ err: e }, '[Worker] Could not update email status to failed');
      }
    }

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
  logger.info(`[Worker] Job with id ${job.id} has been completed.`);
});

worker.on('failed', (job, err) => {
  logger.error(`[Worker] Job with id ${job.id} has failed after attempts: ${err.message}`);
});

module.exports = { worker };
