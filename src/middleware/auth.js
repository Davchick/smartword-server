const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { prisma } = require('../db/prisma');
const { generateDeviceFingerprint } = require('./deviceFingerprint');

/**
 * Простой LRU кэш для аутентифицированных пользователей.
 * Снижает нагрузку на БД: avoids prisma.user.findUnique on every request.
 * Реализован через Map с перемещением при доступе — настоящий LRU.
 */
class LRUCache {
  constructor(maxSize, ttlMs) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // Перемещаем в конец — это самый «горячий» элемент
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.data;
  }

  set(key, data) {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Удаляем самый старый (первый) элемент — настоящий LRU eviction
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, { data, timestamp: Date.now() });
  }

  delete(key) {
    this.map.delete(key);
  }
}

const userCache = new LRUCache(10000, 5 * 60 * 1000); // 10K entries, 5 min TTL

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
    let user = userCache.get(userId);

    if (!user) {
      user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          isPremium: true,
          aiMessagesUsed: true,
          lastAiMessageResetAt: true,
          createdAt: true,
        },
      });

      if (!user) {
        return res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
      }

      userCache.set(userId, user);
    }

    // Store device fingerprint for security monitoring
    req.deviceFingerprint = req.deviceFingerprint || generateDeviceFingerprint(req);

    req.user = user;
    next();
  } catch (err) {
    console.error('[authMiddleware] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

/**
 * Инвалидация кеша пользователя (например, после обновления подписки)
 */
function invalidateUserCache(userId) {
  userCache.delete(userId);
}

module.exports = { authMiddleware, invalidateUserCache };
