/**
 * otp.js - One-Time Password (OTP) Verification Engine
 * Generates and validates secure 6-digit numeric codes with MySQL persistence.
 * Replaces magic links with modern, secure numeric codes.
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('./db');
const logger = require('./logger');

const OTP_DIGITS = parseInt(process.env.OTP_DIGITS || '6', 10);
const OTP_EXPIRE_MINUTES = parseInt(process.env.OTP_EXPIRE_MINUTES || '10', 10);
const OTP_MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS || '3', 10);
const OTP_COOLDOWN_SECONDS = parseInt(process.env.OTP_COOLDOWN_SECONDS || '60', 10);

function hashCode(email, code, purpose) {
  return crypto.createHash('sha256').update(`${email.toLowerCase()}:${purpose}:${code}`).digest('hex');
}

/**
 * Generate a new 6-digit OTP code and store it in MySQL
 */
async function generateOtp(email, purpose = 'verification') {
  const pool = getPool();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Valid email address is required for OTP generation');
  }

  // 1. Check cooldown: has an OTP been issued in the last OTP_COOLDOWN_SECONDS?
  const [recentRows] = await pool.query(`
    SELECT created_at, TIMESTAMPDIFF(SECOND, created_at, NOW()) as elapsed_s
    FROM otp_codes
    WHERE email = ? AND purpose = ? AND verified_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;
  `, [normalizedEmail, purpose]);

  if (recentRows.length > 0) {
    const elapsed = recentRows[0].elapsed_s;
    if (elapsed < OTP_COOLDOWN_SECONDS) {
      const waitTime = OTP_COOLDOWN_SECONDS - elapsed;
      const err = new Error(`Veuillez patienter encore ${waitTime} secondes avant de demander un nouveau code.`);
      err.cooldown = true;
      err.remainingSeconds = waitTime;
      throw err;
    }
  }

  // 2. Generate random numeric code (e.g. 6 digits: 100000 - 999999)
  const min = Math.pow(10, OTP_DIGITS - 1);
  const max = Math.pow(10, OTP_DIGITS) - 1;
  const rawCode = String(crypto.randomInt(min, max + 1));
  const codeHash = hashCode(normalizedEmail, rawCode, purpose);
  const otpId = uuidv4();

  // 3. Persist to MySQL
  await pool.query(`
    INSERT INTO otp_codes (id, email, code_hash, purpose, attempts_left, max_attempts, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE));
  `, [otpId, normalizedEmail, codeHash, purpose, OTP_MAX_ATTEMPTS, OTP_MAX_ATTEMPTS, OTP_EXPIRE_MINUTES]);

  logger.info(`[OTP] Generated ${OTP_DIGITS}-digit code for ${normalizedEmail} (purpose: ${purpose}, id: ${otpId}).`);

  return {
    otpId,
    code: rawCode,
    email: normalizedEmail,
    purpose,
    expiresMinutes: OTP_EXPIRE_MINUTES,
  };
}

/**
 * Verify a user-submitted OTP code
 */
async function verifyOtp(email, code, purpose = 'verification') {
  const pool = getPool();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const submittedCode = String(code || '').trim();

  // 1. Find the latest active unverified code for this email and purpose
  const [rows] = await pool.query(`
    SELECT id, code_hash, attempts_left, expires_at,
           TIMESTAMPDIFF(SECOND, NOW(), expires_at) as remaining_s
    FROM otp_codes
    WHERE email = ? AND purpose = ? AND verified_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1;
  `, [normalizedEmail, purpose]);

  if (rows.length === 0) {
    return {
      valid: false,
      error: 'Code introuvable ou déjà utilisé. Veuillez demander un nouveau code.',
    };
  }

  const record = rows[0];

  // 2. Check if expired
  if (record.remaining_s <= 0) {
    return {
      valid: false,
      error: 'Ce code de vérification a expiré (durée de validité de 10 minutes dépassée).',
      expired: true,
    };
  }

  // 3. Check if attempts exceeded
  if (record.attempts_left <= 0) {
    return {
      valid: false,
      error: 'Nombre maximal de tentatives dépassé. Veuillez demander un nouveau code.',
      attemptsExceeded: true,
    };
  }

  // 4. Compare hash
  const expectedHash = hashCode(normalizedEmail, submittedCode, purpose);
  if (crypto.timingSafeEqual(Buffer.from(expectedHash), Buffer.from(record.code_hash))) {
    // Correct! Mark as verified
    await pool.query(`
      UPDATE otp_codes SET verified_at = NOW() WHERE id = ?;
    `, [record.id]);

    logger.info(`[OTP] Verification SUCCESS for ${normalizedEmail} (purpose: ${purpose})`);
    return {
      valid: true,
      message: 'Code validé avec succès.',
    };
  } else {
    // Incorrect! Decrement attempts left
    const newAttempts = record.attempts_left - 1;
    await pool.query(`
      UPDATE otp_codes SET attempts_left = ? WHERE id = ?;
    `, [newAttempts, record.id]);

    logger.warn(`[OTP] Verification FAILED for ${normalizedEmail} (${newAttempts} attempts left)`);
    return {
      valid: false,
      error: newAttempts > 0
        ? `Code incorrect. Il vous reste ${newAttempts} tentative(s).`
        : 'Code incorrect. Nombre maximal de tentatives atteint.',
      attemptsLeft: newAttempts,
    };
  }
}

module.exports = {
  generateOtp,
  verifyOtp,
  OTP_DIGITS,
  OTP_EXPIRE_MINUTES,
};
