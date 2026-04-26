const crypto = require('crypto');
const { env } = require('../config/env');
const { prisma } = require('../db/prisma');

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const DEFAULT_SCOPES = ['admin:read', 'admin:write'];

function parseAdminIdentities(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => ({
        email: String(entry?.email || '').trim().toLowerCase(),
        token: String(entry?.token || ''),
        role: String(entry?.role || 'viewer').trim().toLowerCase(),
        scopes: Array.isArray(entry?.scopes)
          ? entry.scopes.map((scope) => String(scope).trim()).filter(Boolean)
          : [],
      }))
      .filter((entry) => entry.email && entry.token);
  } catch (err) {
    console.error('[adminAuth] Failed to parse ADMIN_IDENTITIES:', err);
    return [];
  }
}

function resolveAdminIdentities() {
  const identityList = parseAdminIdentities(env.adminIdentities);
  if (identityList.length > 0) return identityList;

  // Legacy fallback to reduce deployment risk while migrating configs.
  if (env.adminApiToken && env.adminEmails) {
    return env.adminEmails
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .map((email) => ({
        email,
        token: env.adminApiToken,
        role: 'super_admin',
        scopes: DEFAULT_SCOPES,
      }));
  }

  return [];
}

function parseAdminBearerToken(req) {
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Bearer ')) return '';
  return authHeader.slice(7).trim();
}

async function adminAuthMiddleware(req, res, next) {
  try {
    const identities = resolveAdminIdentities();
    if (identities.length === 0) {
      return res.status(503).json({
        error: 'admin_not_configured',
        message: 'No admin identities configured. Set ADMIN_IDENTITIES.',
      });
    }

    const email = String(req.headers['x-admin-email'] || '').trim().toLowerCase();
    const headerToken = String(req.headers['x-admin-token'] || '').trim();
    const bearerToken = parseAdminBearerToken(req);
    const providedToken = bearerToken || headerToken;

    if (!email || !providedToken) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Missing admin credentials.',
      });
    }

    const identity = identities.find((entry) => (
      safeCompare(entry.email, email) && safeCompare(entry.token, providedToken)
    ));

    if (!identity) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'Admin identity is not allowed.',
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true },
    });

    req.admin = {
      id: user?.id || null,
      email,
      role: identity.role || 'viewer',
      scopes: identity.scopes.length > 0 ? identity.scopes : DEFAULT_SCOPES,
    };
    next();
  } catch (err) {
    console.error('[adminAuth] Unexpected error:', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
}

function requireAdminScope(requiredScope) {
  return (req, res, next) => {
    const scopes = Array.isArray(req.admin?.scopes) ? req.admin.scopes : [];
    if (!scopes.includes(requiredScope)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `Missing required scope: ${requiredScope}`,
      });
    }
    return next();
  };
}

module.exports = {
  adminAuthMiddleware,
  requireAdminScope,
};
