const { Queue } = require('bullmq');
const { connection } = require('./redis');

const EMAIL_QUEUE_NAME = 'timequant_email_queue';

const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 60000, // 1 minute
    },
    removeOnComplete: true,
    removeOnFail: false, // Keep failed jobs for the Dead Letter Queue behavior
  },
});

module.exports = { emailQueue, EMAIL_QUEUE_NAME };
