const helmet = require('helmet');

const isDev = process.env.NODE_ENV === 'development';

/**
 * Security headers middleware using Helmet.
 * Protects against common web vulnerabilities.
 * Different configurations for development and production.
 */
const securityHeaders = helmet({
  // Content Security Policy - different for dev/prod
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: isDev 
        ? ["'self'", "'unsafe-eval'"] // Allow eval for Metro bundler in dev
        : ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:', 'http:'], // Allow http for dev images
      connectSrc: isDev
        ? ["'self'", 'https://api.telegram.org', 'https://openrouter.ai', 'http://localhost:*', 'ws://localhost:*', 'exp://']
        : ["'self'", 'https://api.telegram.org', 'https://openrouter.ai'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
      upgradeInsecureRequests: isDev ? null : [], // Force HTTPS only in prod
    },
  },

  // Prevent MIME type sniffing
  noSniff: true,

  // XSS Protection
  xssFilter: true,

  // Prevent clickjacking
  frameguard: {
    action: 'deny',
  },

  // HSTS (force HTTPS) - only in production
  hsts: isDev ? false : {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },

  // Hide X-Powered-By header
  hidePoweredBy: true,

  // DNS Prefetch Control
  dnsPrefetchControl: {
    allow: isDev, // Allow in dev for faster resolution
  },

  // IE Download Options
  ieNoOpen: true,

  // Referrer Policy
  referrerPolicy: {
    policy: isDev ? 'no-referrer' : 'strict-origin-when-cross-origin',
  },

  // Cross-Origin Embedder Policy - disabled in dev for Metro
  crossOriginEmbedderPolicy: isDev ? false : true,

  // Cross-Origin Opener Policy
  crossOriginOpenerPolicy: true,

  // Cross-Origin Resource Policy
  crossOriginResourcePolicy: {
    policy: isDev ? 'cross-origin' : 'same-site',
  },

  // Origin Agent Cluster
  originAgentCluster: true,

  // Permitted Cross-Origin Policies
  permittedCrossOriginPolicies: true,
});

module.exports = { securityHeaders };
