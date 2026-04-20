const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';

const devValidate = false;
const prodValidate = isProduction ? { trustProxy: 1, xForwardedForHeader: true } : false;
const validateConfig = isProduction ? prodValidate : devValidate;

/**
 * Rate limiter for authentication endpoints.
 * Prevents brute force attacks and credential stuffing.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 100 : 10, // 100 attempts in dev, 10 in production
  message: {
    error: 'Too many authentication attempts',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: validateConfig, // Disabled for dev
});

/**
 * Rate limiter for password reset endpoint.
 * Prevents email flooding attacks.
 */
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDev ? 50 : 5, // 50 requests in dev, 5 in production
  message: {
    error: 'Too many password reset requests',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: '1 hour'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: validateConfig,
});

/**
 * Rate limiter for refresh token endpoint.
 * Prevents token brute forcing.
 */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 200 : 20, // 200 refresh attempts in dev, 20 in production
  message: {
    error: 'Too many token refresh attempts',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: validateConfig,
});

/**
 * General API rate limiter for other endpoints.
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 1000 : 100, // 1000 requests in dev, 100 in production
  skip: (req) => req.path === '/billing/webhook',
  message: {
    error: 'Too many requests',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: validateConfig,
});

/**
 * Strict rate limiter for sensitive operations.
 */
const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDev ? 50 : 5, // 50 requests in dev, 5 in production
  message: {
    error: 'Too many requests',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: '1 hour'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: validateConfig,
});

/**
 * Rate limiter for payment creation.
 * Strict limits to prevent payment abuse and fraud.
 */
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDev ? 20 : 10, // 20 in dev, 10 in production per hour
  message: {
    error: 'Too many payment attempts',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: '1 hour'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: validateConfig,
  keyGenerator: (req) => {
    // Rate limit by user ID if authenticated, otherwise by IP
    return req.user?.id || req.ip;
  },
});

module.exports = {
  authLimiter,
  passwordResetLimiter,
  refreshLimiter,
  apiLimiter,
  strictLimiter,
  paymentLimiter,
};
