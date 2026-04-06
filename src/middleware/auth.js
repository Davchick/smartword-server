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
 * Проверяет Authorization: Bearer <access_token>, верифицирует JWT,
 * загружает пользователя из БД и кладёт в req.user.
 * При ошибке возвращает 401.
 */
async function authMiddleware(req, res, next) {
  try {
    console.log('[authMiddleware] Path:', req.path, 'Method:', req.method);
    const authHeader = req.headers.authorization;
    console.log('[authMiddleware] Auth header:', authHeader ? 'present' : 'missing');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[authMiddleware] Missing or invalid Authorization header');
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    let decoded;
    try {
      decoded = jwt.verify(token, env.jwtSecret);
      console.log('[authMiddleware] Token decoded:', { userId: decoded.userId, sub: decoded.sub });
    } catch (err) {
      console.log('[authMiddleware] Token verification failed:', err.message);
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }

    if (!decoded.sub || decoded.sub !== decoded.userId) {
      const userId = decoded.userId || decoded.sub;
      if (!userId) {
        console.log('[authMiddleware] Invalid token payload');
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token payload' });
      }
    }

    const userId = decoded.userId || decoded.sub;
    console.log('[authMiddleware] Fetching user:', userId);
    const user = await prisma.user.findUnique({
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
      console.log('[authMiddleware] User not found:', userId);
      return res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
    }

    // Store device fingerprint for security monitoring
    req.deviceFingerprint = generateDeviceFingerprint(req);
    
    console.log('[authMiddleware] User authenticated:', user.id);
    req.user = user;
    next();
  } catch (err) {
    console.error('[authMiddleware] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}

module.exports = { authMiddleware };
