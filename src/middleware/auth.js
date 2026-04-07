const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { prisma } = require('../db/prisma');
const crypto = require('crypto');

/**
 * Generate a device fingerprint from request headers
 */
function generateDeviceFingerprint(req) {
  const userAgent = req.headers['user-agent'] || '';
  const acceptLanguage = req.headers['accept-language'] || '';
  const fingerprint = `${userAgent}-${acceptLanguage}`;
  return crypto.createHash('sha256').update(fingerprint).digest('hex');
}

/**
 * In-memory LRU cache for authenticated users.
 * Reduces DB load: avoids prisma.user.findUnique on every request.
 * TTL: 5 minutes, max size: 10,000 entries.
 */
const userCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 10000;

function getCachedUser(userId) {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    userCache.delete(userId);
    return null;
  }
  return entry.data;
}

function setCachedUser(userId, data) {
  if (userCache.size >= CACHE_MAX_SIZE) {
    // Remove oldest entry (simple LRU approximation)
    const oldestKey = userCache.keys().next().value;
    userCache.delete(oldestKey);
  }
  userCache.set(userId, { data, timestamp: Date.now() });
}

/**
 * Проверяет Authorization: Bearer <access_token>, верифицирует JWT,
 * загружает пользователя из БД и кладёт в req.user.
 * При ошибке возвращает 401.
 * Оптимизировано: кэширует пользователя в памяти для снижения нагрузки на БД.
 */
async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    let decoded;
    try {
      decoded = jwt.verify(token, env.jwtSecret);
    } catch (err) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }

    const userId = decoded.userId || decoded.sub;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token payload' });
    }

    // Проверяем кэш перед запросом к БД
    let user = getCachedUser(userId);

    if (!user) {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          isPremium: true,
          aiMessagesUsed: true,
          createdAt: true,
        },
      });

      if (!user) {
        return res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
      }

      setCachedUser(userId, user);
    }

    // Store device fingerprint for security monitoring
    req.deviceFingerprint = generateDeviceFingerprint(req);

    req.user = user;
    next();
  } catch (err) {
    console.error('[authMiddleware] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

module.exports = { authMiddleware };
