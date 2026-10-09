const promClient = require('prom-client');

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const emailsQueuedCounter = new promClient.Counter({
  name: 'timequant_emails_queued_total',
  help: 'Total number of emails added to the queue',
});

const emailsSentCounter = new promClient.Counter({
  name: 'timequant_emails_sent_total',
  help: 'Total number of emails successfully sent',
});

const emailsFailedCounter = new promClient.Counter({
  name: 'timequant_emails_failed_total',
  help: 'Total number of emails that failed to send',
});

const emailsSkippedCounter = new promClient.Counter({
  name: 'timequant_emails_skipped_total',
  help: 'Total number of emails skipped (e.g. calculation < 6h or rate limited)',
  labelNames: ['reason'],
});

const webhooksReceivedCounter = new promClient.Counter({
  name: 'timequant_webhooks_received_total',
  help: 'Total number of delivery webhooks received',
  labelNames: ['event'],
});

register.registerMetric(emailsQueuedCounter);
register.registerMetric(emailsSentCounter);
register.registerMetric(emailsFailedCounter);
register.registerMetric(emailsSkippedCounter);
register.registerMetric(webhooksReceivedCounter);

module.exports = {
  register,
  emailsQueuedCounter,
  emailsSentCounter,
  emailsFailedCounter,
  emailsSkippedCounter,
  webhooksReceivedCounter
};
