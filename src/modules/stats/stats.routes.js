const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');

const router = express.Router();

// Логирование всех запросов для отладки
router.use((req, res, next) => {
  console.log('[stats.routes] Request:', req.method, req.path, 'URL:', req.url);
  next();
});

const DAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const LEARNED_THRESHOLD = 5;

function toDateStr(date) {
  return date.toISOString().split('T')[0];
}

function getDayLabel(date) {
  return DAY_LABELS[date.getDay()];
}

/**
 * GET /stats
 * Returns totalWords, learnedWords (correct_count >= 5), currentStreak, weekActivity.
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const words = await prisma.word.findMany({
      where: { userId: req.user.id },
      select: { correctCount: true, lastReviewed: true },
    });

    const allWords = words.map((w) => ({
      correct_count: w.correctCount,
      last_reviewed: w.lastReviewed ? w.lastReviewed.toISOString() : null,
    }));

    const totalWords = allWords.length;
    const learnedWords = allWords.filter((w) => w.correct_count >= LEARNED_THRESHOLD).length;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    const activeDays = new Set();
    for (const w of allWords) {
      if (w.last_reviewed) {
        const d = new Date(w.last_reviewed);
        d.setHours(0, 0, 0, 0);
        activeDays.add(toDateStr(d));
      }
    }

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

    let streak = 0;
    const cursor = new Date(today);
    while (true) {
      const dateStr = toDateStr(cursor);
      if (activeDays.has(dateStr)) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else {
        break;
      }
    }

    res.json({
      totalWords,
      learnedWords,
      currentStreak: streak,
      weekActivity,
    });
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

    res.json({ success: true });
  } catch (err) {
    console.error('[stats/training-progress POST]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
