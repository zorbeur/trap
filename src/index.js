const api = require('./api');
const config = require('./config');
const logger = require('./logger');
// Ensure worker is loaded and started
const { worker } = require('./worker');

const server = api.listen(config.port, () => {
  logger.info(`[TimeQuant Email Service] API listening on port ${config.port}`);
  logger.info(`[TimeQuant Email Service] Worker is ready and connected to Redis`);
  logger.info(`[TimeQuant Email Service] Bull-Board available at http://localhost:${config.port}/admin/queues`);
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down server...');
  await worker.close();
  logger.info('Worker closed.');
  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
