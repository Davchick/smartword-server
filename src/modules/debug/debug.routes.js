const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');

const router = express.Router();

/**
 * POST /debug/set-weekly-limit
 * Body: { count: number }
 * Временно для тестирования: устанавливает лимит выученных слов
 */
router.post('/set-weekly-limit', authMiddleware, async (req, res) => {
  try {
    const { count } = req.body;
    
    if (typeof count !== 'number' || count < 0 || count > 50) {
      return res.status(400).json({ error: 'count must be between 0 and 50' });
    }

    const currentMonday = getMonday(new Date());
    
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        wordsLearnedThisWeek: count,
        weekStartDate: currentMonday,
      },
    });

    res.json({
      success: true,
      wordsLearnedThisWeek: count,
      message: `Weekly limit set to ${count}/50`,
    });
  } catch (err) {
    console.error('[debug POST set-weekly-limit]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /debug/weekly-progress
 * Возвращает текущий прогресс пользователя
 */
router.get('/weekly-progress', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        isPremium: true,
        wordsLearnedThisWeek: true,
        weekStartDate: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date();
    const currentMonday = getMonday(now);
    let wordsLearnedThisWeek = user.wordsLearnedThisWeek;
    
    if (!user.weekStartDate || user.weekStartDate < currentMonday) {
      wordsLearnedThisWeek = 0;
    }

    res.json({
      email: user.email,
      is_premium: user.isPremium,
      words_learned_this_week: wordsLearnedThisWeek,
      weekly_limit: user.isPremium ? Infinity : 50,
      week_start: currentMonday.toISOString(),
    });
  } catch (err) {
    console.error('[debug GET weekly-progress]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

module.exports = router;
