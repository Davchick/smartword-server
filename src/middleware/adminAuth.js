const crypto = require('crypto');
const { env } = require('../config/env');
const { prisma } = require('../db/prisma');

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseAdminEmails(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

async function adminAuthMiddleware(req, res, next) {
  try {
    const configuredToken = env.adminApiToken;
    if (!configuredToken) {
      return res.status(503).json({
        error: 'admin_not_configured',
        message: 'Admin API token is not configured on server.',
      });
    }

    const requestToken = req.headers['x-admin-token'];
    if (!requestToken || !safeCompare(requestToken, configuredToken)) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Invalid admin token.',
      });
    }

    const allowedEmails = parseAdminEmails(env.adminEmails);
    if (allowedEmails.length === 0) {
      return res.status(503).json({
        error: 'admin_not_configured',
        message: 'ADMIN_EMAILS must contain at least one allowed admin email.',
      });
    }

    const email = String(req.headers['x-admin-email'] || '').trim().toLowerCase();
    if (!email || !allowedEmails.includes(email)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Admin email is not allowed.',
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true },
    });

    req.admin = user || { id: null, email };
    next();
  } catch (err) {
    console.error('[adminAuth] Unexpected error:', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
}

module.exports = {
  adminAuthMiddleware,
};
