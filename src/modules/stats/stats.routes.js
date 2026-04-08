const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const { Prisma } = require('@prisma/client');
const { LRUCache } = require('../../utils/lruCache');

const router = express.Router();

const DAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const LEARNED_THRESHOLD = 5;

function toDateStr(date) {
  // Локальная дата (без смещения часового пояса)
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDayLabel(date) {
  return DAY_LABELS[date.getDay()];
}

/**
 * LRU кэш для stats.
 * TTL: 60 сек — снижает нагрузку на БД при частых запросах.
 * 5000 entries — достаточно для 250K пользователей (LRU сам чистит).
 */
const statsCache = new LRUCache(5000, 60 * 1000);

/**
 * Инвалидирует кэш stats для пользователя.
 * Вызывается из batch progress endpoint после тренировки.
 */
function invalidateCachedStats(userId) {
  statsCache.delete(userId);
}

// Экспортируется через router.invalidateCachedStats (см. конец файла)

// Обёртки для совместимости с существующим кодом
function getCachedStats(userId) {
  return statsCache.get(userId);
}

function setCachedStats(userId, data) {
  statsCache.set(userId, data);
}

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
      WHERE "userId" = ${userId}
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

// attach invalidateCachedStats to router so other modules can require it
router.invalidateCachedStats = invalidateCachedStats;

module.exports = router;
