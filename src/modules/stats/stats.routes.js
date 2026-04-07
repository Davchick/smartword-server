const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const { Prisma } = require('@prisma/client');

const router = express.Router();

const DAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const LEARNED_THRESHOLD = 5;

function toDateStr(date) {
  return date.toISOString().split('T')[0];
}

function getDayLabel(date) {
  return DAY_LABELS[date.getDay()];
}

/**
 * In-memory кэш для stats.
 * TTL: 60 сек — снижает нагрузку на БД при частых запросах.
 */
const statsCache = new Map();
const STATS_CACHE_TTL_MS = 60 * 1000;
const STATS_CACHE_MAX = 5000;

function getCachedStats(userId) {
  const entry = statsCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > STATS_CACHE_TTL_MS) {
    statsCache.delete(userId);
    return null;
  }
  return entry.data;
}

function setCachedStats(userId, data) {
  if (statsCache.size >= STATS_CACHE_MAX) {
    const oldestKey = statsCache.keys().next().value;
    statsCache.delete(oldestKey);
  }
  statsCache.set(userId, { data, timestamp: Date.now() });
}

/**
 * Инвалидирует кэш stats для пользователя.
 * Вызывается из batch progress endpoint после тренировки.
 */
function invalidateCachedStats(userId) {
  statsCache.delete(userId);
}

// Экспортируем для использования из других модулей
module.exports.invalidateCachedStats = invalidateCachedStats;

/**
 * GET /stats
 * Returns totalWords, learnedWords (correct_count >= 5), currentStreak, weekActivity.
 *
 * Оптимизировано:
 * - currentStreak берётся из UserStreak (быстрый unique lookup, не raw SQL сканирование)
 * - weekActivity: DISTINCT DATE с ограничением 7 дней (не 1 год)
 * - In-memory кэш с TTL 60 сек
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Проверяем кэш
    const cached = getCachedStats(userId);
    if (cached) {
      return res.json(cached);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Считаем слова агрегациями — без загрузки в память
    const [totalWords, learnedWords] = await prisma.$transaction([
      prisma.word.count({ where: { userId } }),
      prisma.word.count({ where: { userId, correctCount: { gte: LEARNED_THRESHOLD } } }),
    ]);

    // Текущий streak — из UserStreak таблицы (unique index lookup, очень быстро)
    const userStreak = await prisma.userStreak.findUnique({
      where: { userId },
      select: { currentStreak: true, lastActivity: true },
    });

    const currentStreak = userStreak?.currentStreak ?? 0;

    // WeekActivity: уникальные даты только за последнюю неделю (не за год!)
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const activeDatesResult = await prisma.$queryRaw`
      SELECT DISTINCT DATE("lastReviewed") as date
      FROM "Word"
      WHERE "userId" = ${userId}::uuid
        AND "lastReviewed" >= ${weekAgo}
        AND "lastReviewed" IS NOT NULL
    `;

    const activeDays = new Set();
    for (const row of activeDatesResult) {
      activeDays.add(toDateStr(row.date));
    }

    const dayOfWeek = today.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    const weekActivity = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + i);
      const dateStr = toDateStr(day);
      const todayStr = toDateStr(today);
      weekActivity.push({
        date: dateStr,
        dayLabel: DAY_LABELS[day.getDay()],
        hasActivity: activeDays.has(dateStr),
        isFuture: day > today,
        isToday: dateStr === todayStr,
      });
    }

    const result = {
      totalWords,
      learnedWords,
      currentStreak,
      weekActivity,
    };

    // Кэшируем
    setCachedStats(userId, result);

    res.json(result);
  } catch (err) {
    console.error('[stats GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /stats/training-progress
 * Returns training points for the last 7 days.
 */
router.get('/training-progress', authMiddleware, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    const progressRecords = await prisma.trainingProgress.findMany({
      where: {
        userId: req.user.id,
        date: {
          gte: sevenDaysAgo,
          lte: today,
        },
      },
      orderBy: { date: 'asc' },
    });

    const progressMap = new Map();
    for (const record of progressRecords) {
      progressMap.set(toDateStr(record.date), record.points);
    }

    const result = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(sevenDaysAgo);
      date.setDate(sevenDaysAgo.getDate() + i);
      const dateStr = toDateStr(date);
      result.push({
        date: dateStr,
        dayLabel: getDayLabel(date),
        points: progressMap.get(dateStr) || 0,
        isToday: dateStr === toDateStr(today),
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[stats/training-progress GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /stats/training-progress
 * Add training points for today.
 */
router.post('/training-progress', authMiddleware, async (req, res) => {
  try {
    const { points } = req.body;

    if (typeof points !== 'number' || points < 0) {
      return res.status(400).json({ error: 'Invalid points value' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.trainingProgress.upsert({
      where: {
        userId_date: {
          userId: req.user.id,
          date: today,
        },
      },
      update: {
        points: { increment: points },
      },
      create: {
        userId: req.user.id,
        date: today,
        points,
      },
    });

    // Инвалидируем кэш — данные изменились
    invalidateCachedStats(req.user.id);

    res.json({ success: true });
  } catch (err) {
    console.error('[stats/training-progress POST]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
