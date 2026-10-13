/**
 * db.js - Dedicated MySQL Database Manager for TimeQuant Standalone Mailer Service
 * ABSOLUTELY NO SQLITE. Connects strictly to MySQL with connection pool and auto-migration.
 */
const mysql = require('mysql2/promise');
const logger = require('./logger');

let pool = null;

const getMysqlConfig = () => {
  return {
    host: process.env.MYSQL_HOST || '192.168.1.84',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'Amos1436',
    database: process.env.MYSQL_DATABASE || 'timequant_mailer',
    waitForConnections: true,
    connectionLimit: parseInt(process.env.MYSQL_POOL_SIZE || '10', 10),
    queueLimit: 0,
    connectTimeout: 5000,
  };
};

async function initDatabase() {
  const cfg = getMysqlConfig();
  logger.info(`[MySQL] Initializing connection to MySQL server at ${cfg.host}:${cfg.port}...`);

  // 1. Ensure database exists
  let rootConn;
  try {
    rootConn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      connectTimeout: cfg.connectTimeout,
    });
    await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await rootConn.end();
    logger.info(`[MySQL] Database '${cfg.database}' verified/created.`);
  } catch (err) {
    if (rootConn) await rootConn.end().catch(() => {});
    // Fallback: try adjacent DHCP IP if LAN moved (e.g. 192.168.1.67 <-> 192.168.1.84)
    if (cfg.host.startsWith('192.168.1.')) {
      const candidates = ['192.168.1.67', '192.168.1.84', '192.168.1.83', '127.0.0.1'];
      let connected = false;
      for (const cand of candidates) {
        if (cand === cfg.host) continue;
        try {
          logger.info(`[MySQL] Probing alternative host ${cand}...`);
          const probe = await mysql.createConnection({
            host: cand,
            port: cfg.port,
            user: cfg.user,
            password: cfg.password,
            connectTimeout: 2000,
          });
          await probe.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
          await probe.end();
          process.env.MYSQL_HOST = cand;
          cfg.host = cand;
          connected = true;
          logger.info(`[MySQL] Successfully connected via discovered host ${cand}.`);
          break;
        } catch (_) {}
      }
      if (!connected) {
        logger.error({ err }, '[MySQL] Failed to connect to MySQL database.');
        throw err;
      }
    } else {
      throw err;
    }
  }

  // 2. Initialize connection pool
  pool = mysql.createPool(cfg);

  // 3. Create tables if not exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emails (
      id VARCHAR(64) PRIMARY KEY,
      idempotency_key VARCHAR(128) UNIQUE,
      recipient_email VARCHAR(255) NOT NULL,
      recipient_name VARCHAR(255),
      template_id VARCHAR(100) NOT NULL,
      subject VARCHAR(500),
      status ENUM('queued', 'rendering', 'sending', 'delivered', 'failed', 'bounced') DEFAULT 'queued',
      provider_used VARCHAR(50),
      message_id VARCHAR(255),
      attempts INT DEFAULT 0,
      error_message TEXT,
      metadata_json JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_recipient (recipient_email),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code_hash VARCHAR(128) NOT NULL,
      purpose VARCHAR(64) NOT NULL,
      attempts_left INT DEFAULT 3,
      max_attempts INT DEFAULT 3,
      expires_at DATETIME NOT NULL,
      verified_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_otp_lookup (email, purpose, verified_at, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_metrics (
      provider_name VARCHAR(50) PRIMARY KEY,
      is_enabled BOOLEAN DEFAULT TRUE,
      success_count INT DEFAULT 0,
      fail_count INT DEFAULT 0,
      last_error TEXT,
      last_success_at DATETIME NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  logger.info('[MySQL] Schema verification & migrations complete. MySQL is READY.');
  return pool;
}

function getPool() {
  if (!pool) {
    throw new Error('[MySQL] Database pool has not been initialized. Call initDatabase() first.');
  }
  return pool;
}

module.exports = {
  initDatabase,
  getPool,
};
