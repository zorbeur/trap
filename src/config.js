require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  emailServiceApiKey: process.env.TQ_EMAIL_SERVICE_API_KEY || 'dev-secret-key',
  senderDefault: process.env.TQ_EMAIL_SENDER_DEFAULT || 'TimeQuant Platform <notifications@timequant.org>',
  smtp: {
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '1025', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  }
};
