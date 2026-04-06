const dotenv = require('dotenv');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';
const isProd = process.env.NODE_ENV === 'production';

// Load environment-specific .env file
// Priority: .env.development (dev mode) > .env (production/fallback)
const envFile = isDev ? '.env.development' : '.env';

const envPath = path.resolve(process.cwd(), envFile);

// Try to load NODE_ENV-specific file first
let loaded = dotenv.config({ path: envPath });

// Fallback to .env if specific file not found
if (!loaded.parsed) {
  loaded = dotenv.config({ path: path.resolve(process.cwd(), '.env') });
}

/**
 * Validate that a secret is strong enough (min 32 chars, not a default value)
 */
function validateSecret(value, name, isProduction) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  
  // In production, enforce strict validation
  if (isProduction) {
    if (value.length < 32) {
      throw new Error(`${name} must be at least 32 characters long`);
    }
    if (value.includes('change_me') || value.includes('dev_') || value === 'secret' || value.includes('CHANGE_ME')) {
      throw new Error(`${name} contains default/weak value. Generate a secure random value`);
    }
  } else {
    // In development, allow weaker secrets but warn
    if (value.length < 8) {
      throw new Error(`${name} must be at least 8 characters long`);
    }
  }
  
  return value;
}

/**
 * Validate critical security configuration on startup.
 * Fails fast if security requirements are not met.
 */
function validateSecurityConfig() {
  const errors = [];
  const isProduction = process.env.NODE_ENV === 'production';

  // Validate JWT secrets
  try {
    validateSecret(process.env.JWT_SECRET, 'JWT_SECRET', isProduction);
  } catch (err) {
    errors.push(err.message);
  }

  try {
    validateSecret(process.env.JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET', isProduction);
  } catch (err) {
    errors.push(err.message);
  }

  // Validate database URL
  if (!process.env.DATABASE_URL) {
    errors.push('DATABASE_URL is required');
  }

  // Production-only validations
  if (isProduction) {
    if (!process.env.SMTP_HOST) {
      errors.push('SMTP_HOST is required in production');
    }
  }

  // Warn about optional but recommended settings
  if (!process.env.SMTP_HOST) {
    console.warn('[CONFIG] SMTP not configured - email features will use test mode');
  }

  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn('[CONFIG] Google OAuth not configured - Google Sign-In will be disabled');
  }

  // Log environment info
  console.log(`[CONFIG] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[CONFIG] Config file: ${envFile}`);

  // Throw if critical errors
  if (errors.length > 0) {
    console.error('\n=== SECURITY CONFIGURATION ERRORS ===\n');
    errors.forEach(err => console.error(`  ❌ ${err}`));
    console.error('\n=== Generate secure values with: ===\n');
    console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    console.error('\n=====================================\n');
    throw new Error(`Security configuration validation failed: ${errors.join('; ')}`);
  }

  console.log('[CONFIG] Security configuration validated ✓');
}

const isProduction = process.env.NODE_ENV === 'production';

const env = {
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: validateSecret(process.env.JWT_SECRET, 'JWT_SECRET', isProduction),
  jwtRefreshSecret: validateSecret(process.env.JWT_REFRESH_SECRET, 'JWT_REFRESH_SECRET', isProduction),
  // OpenRouter API ключи (через запятую для fallback, минимум 1)
  // Каждый ключ с $10+ даёт 1,000 бесплатных запросов/день
  openrouterApiKeys: process.env.OPENROUTER_API_KEYS || '',
  // Публичный URL приложения/бэкенда для ссылок в письмах
  appPublicUrl: process.env.APP_PUBLIC_URL || process.env.BASE_URL || (isProduction ? 'https://api.smartword.app' : 'http://localhost:3000'),
  // SMTP (для разработки можно использовать Ethereal или Mailtrap)
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@smartword.app',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',

  // ЮKassa (подписка)
  yookassaShopId: process.env.YOOKASSA_SHOP_ID || '',
  yookassaSecretKey: process.env.YOOKASSA_SECRET_KEY || '',
  yookassaReturnUrl: process.env.YOOKASSA_RETURN_URL || process.env.APP_PUBLIC_URL || process.env.BASE_URL || (isProduction ? 'https://api.smartword.app' : 'http://localhost:3000'),

  // Telegram Support Bot
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID || '',
  
  // Environment info
  isDevelopment: isDev,
  isProduction: isProduction,
};

// Run validation before exporting
validateSecurityConfig();

module.exports = { env };
