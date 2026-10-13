const { initDatabase } = require('./db');
const api = require('./api');
const config = require('./config');
const logger = require('./logger');

let server = null;
let worker = null;

async function bootstrap() {
  try {
    // 1. Initialize dedicated MySQL Database
    await initDatabase();

    // 2. Load dynamic provider settings and routing from MySQL
    const providerManager = require('./providers');
    await providerManager.loadSettingsFromDb();

    // 3. Load worker
    const workerModule = require('./worker');
    worker = workerModule.worker;

    // 4. Start HTTP server
    server = api.listen(config.port, () => {
      logger.info(`[TimeQuant Email Service] API listening on port ${config.port}`);
      logger.info(`[TimeQuant Email Service] Worker is ready and connected to Redis`);
      logger.info(`[TimeQuant Email Service] Bull-Board available at http://localhost:${config.port}/admin/queues`);
    });
  } catch (err) {
    logger.error({ err }, '[TimeQuant Email Service] Fatal startup failure');
    process.exit(1);
  }
}

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down server...');
  if (worker) {
    await worker.close();
    logger.info('Worker closed.');
  }
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

bootstrap();
