const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const achievementsService = require('../achievements/achievements.service');
const streaksService = require('../streaks/streaks.service');

const router = express.Router();

// Логирование всех запросов для отладки
router.use((req, res, next) => {
  console.log('[words.routes] Request:', req.method, req.path, 'URL:', req.url);
  next();
});

router.use(authMiddleware);

/**
 * GET /words?groupId=...
 * List words for current user, optional filter by groupId. Order by createdAt desc.
 */
router.get('/', async (req, res) => {
  try {
    const { groupId } = req.query;
    const where = { userId: req.user.id };
    if (groupId && typeof groupId === 'string') where.groupId = groupId;

    const words = await prisma.word.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    res.json(
      words.map((w) => ({
        id: w.id,
        group_id: w.groupId,
        user_id: w.userId,
        original: w.original,
        translation: w.translation,
        correct_count: w.correctCount,
        last_reviewed: w.lastReviewed ? w.lastReviewed.toISOString() : null,
        created_at: w.createdAt.toISOString(),
      }))
    );
  } catch (err) {
    console.error('[words GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /words
 * Body: { original, translation, group_id }
 */
router.post('/', async (req, res) => {
  try {
    const { original, translation, group_id: groupId } = req.body;
    if (!original || typeof original !== 'string' || !translation || typeof translation !== 'string') {
      return res.status(400).json({ error: 'original and translation are required' });
    }
    if (groupId) {
      const group = await prisma.wordGroup.findFirst({
        where: { id: groupId, userId: req.user.id },
      });
      if (!group) {
        return res.status(400).json({ error: 'Group not found' });
      }
    }
    const word = await prisma.word.create({
      data: {
        userId: req.user.id,
        groupId: groupId || null,
        original: original.trim(),
        translation: translation.trim(),
      },
    });
    res.status(201).json({
      id: word.id,
      group_id: word.groupId,
      user_id: word.userId,
      original: word.original,
      translation: word.translation,
      correct_count: word.correctCount,
      last_reviewed: word.lastReviewed ? word.lastReviewed.toISOString() : null,
      created_at: word.createdAt.toISOString(),
    });
  } catch (err) {
    console.error('[words POST]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /words/:id
 * Body: { original, translation }
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { original, translation } = req.body;
    const existing = await prisma.word.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Word not found' });
    }
    const data = {};
    if (typeof original === 'string') data.original = original.trim();
    if (typeof translation === 'string') data.translation = translation.trim();
    const updated = await prisma.word.update({
      where: { id },
      data,
    });
    res.json({
      id: updated.id,
      group_id: updated.groupId,
      user_id: updated.userId,
      original: updated.original,
      translation: updated.translation,
      correct_count: updated.correctCount,
      last_reviewed: updated.lastReviewed ? updated.lastReviewed.toISOString() : null,
      created_at: updated.createdAt.toISOString(),
    });
  } catch (err) {
    console.error('[words PATCH]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /words/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.word.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Word not found' });
    }
    await prisma.word.delete({ where: { id } });
    res.status(204).send();
  } catch (err) {
    console.error('[words DELETE]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /words/:id/progress
 * Body: { knew: boolean, correctDelta?: number, incorrectDelta?: number }
 * 
 * Когда слово набирает 5 очков (correctCount >= 5) — оно считается выученным.
 * Для бесплатных пользователей: лимит 50 выученных слов в неделю.
 */
router.post('/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    const { knew, correctDelta = 1, incorrectDelta = -1 } = req.body;
    
    console.log('[words/progress] Request:', { id, knew, correctDelta, incorrectDelta });
    
    const existing = await prisma.word.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Word not found' });
    }

    console.log('[words/progress] Existing word:', { 
      id: existing.id, 
      correctCount: existing.correctCount,
      wasLearned: existing.correctCount >= 5 
    });

    // Получаем данные пользователя для проверки лимита
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        isPremium: true,
        wordsLearnedThisWeek: true,
        weekStartDate: true,
      },
    });

    if (!user) {
      console.error('[words/progress] User not found:', req.user.id);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('[words/progress] User:', { 
      isPremium: user?.isPremium, 
      wordsLearnedThisWeek: user?.wordsLearnedThisWeek,
      weekStartDate: user?.weekStartDate 
    });

    // Проверяем и сбрасываем неделю если нужно
    const now = new Date();
    const currentMonday = getMonday(now);
    let weekStartDate = user.weekStartDate;
    let wordsLearnedThisWeek = user.wordsLearnedThisWeek;

    // Если неделя прошла — сбрасываем счётчик
    if (!weekStartDate || weekStartDate < currentMonday) {
      wordsLearnedThisWeek = 0;
      weekStartDate = currentMonday;
      try {
        await prisma.user.update({
          where: { id: req.user.id },
          data: { wordsLearnedThisWeek: 0, weekStartDate: currentMonday },
        });
        console.log('[words/progress] Week reset, new weekStartDate:', currentMonday);
      } catch (err) {
        console.error('[words/progress] Week reset error:', err);
      }
    }

    const delta = knew ? Number(correctDelta) : Number(incorrectDelta);
    const newCount = Math.max(0, existing.correctCount + delta);
    
    // Проверяем: слово было < 5, стало >= 5 → значит выучено на этой неделе
    const wasLearnedBefore = existing.correctCount >= 5;
    const isNowLearned = newCount >= 5;
    const justLearned = !wasLearnedBefore && isNowLearned;

    // Если только что выучили и пользователь не премиум — проверяем лимит
    // МЯГКИЙ ЛИМИТ: не блокируем, просто не засчитываем слова после лимита
    if (justLearned && !user.isPremium) {
      if (wordsLearnedThisWeek >= 50) {
        console.log('[words/progress] Soft limit reached - word learned but not counted:', wordsLearnedThisWeek);
        // Не блокируем, просто не увеличиваем счётчик
        // Слово всё равно уйдёт в архив (correctCount >= 5), но не засчитается в лимит
      } else {
        // Увеличиваем счётчик выученных слов
        wordsLearnedThisWeek++;
        try {
          await prisma.user.update({
            where: { id: req.user.id },
            data: { wordsLearnedThisWeek },
          });
          console.log('[words/progress] Incremented wordsLearnedThisWeek:', wordsLearnedThisWeek);
        } catch (err) {
          console.error('[words/progress] Failed to update wordsLearnedThisWeek:', err);
        }
      }
    }

    const updated = await prisma.word.update({
      where: { id },
      data: {
        correctCount: newCount,
        lastReviewed: new Date(),
      },
    });

    console.log('[words/progress] Updated:', {
      id: updated.id,
      correct_count: updated.correctCount,
      justLearned,
      newWeeklyCount: wordsLearnedThisWeek
    });

    // Обновляем достижения
    if (justLearned) {
      try {
        const unlockedAchievements = await achievementsService.checkAndUpdate(req.user.id, 'word_learned', 1);
        if (unlockedAchievements.length > 0) {
          console.log('[words/progress] Achievements unlocked:', unlockedAchievements.map(a => a.title));
        }
      } catch (err) {
        console.error('[words/progress] Achievement check error:', err);
      }
    }

    // Обновляем streak (check-in при активности)
    try {
      await streaksService.checkIn(req.user.id);
    } catch (err) {
      console.error('[words/progress] Streak check-in error:', err);
    }

    console.log('[words/progress] Updated:', {
      id: updated.id,
      correct_count: updated.correctCount,
      just_learned: justLearned,
      words_learned_this_week: wordsLearnedThisWeek,
      limit_reached: wordsLearnedThisWeek >= 50 && !user.isPremium,
    });

    res.json({
      id: updated.id,
      correct_count: updated.correctCount,
      last_reviewed: updated.lastReviewed.toISOString(),
      just_learned: justLearned,
      words_learned_this_week: wordsLearnedThisWeek,
      limit_reached: wordsLearnedThisWeek >= 50 && !user.isPremium,
    });
  } catch (err) {
    console.error('[words POST progress] Error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Утилита: получить понедельник текущей недели
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // корректировка для воскресенья
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

module.exports = router;
