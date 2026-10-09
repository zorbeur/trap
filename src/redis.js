const Redis = require('ioredis');
const config = require('./config');

const connection = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null, // Required for bullmq
});

module.exports = { connection };
