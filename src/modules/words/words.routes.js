const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const achievementsService = require('../achievements/achievements.service');
const streaksService = require('../streaks/streaks.service');

const router = express.Router();

router.use(authMiddleware);

/**
 * GET /words?groupId=...
 * List words for current user, optional filter by groupId. Order by createdAt desc.
 * Возвращает { words: [...], totalCount: number } — totalCount это общее число слов пользователя.
 */
router.get('/', async (req, res) => {
  try {
    const { groupId } = req.query;
    const where = { userId: req.user.id };
    if (groupId && typeof groupId === 'string') where.groupId = groupId;

    // Параллельно: слова + totalCount всех слов пользователя
    const [words, totalCountResult] = await Promise.all([
      prisma.word.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.word.count({ where: { userId: req.user.id } }),
    ]);

    res.json({
      words: words.map((w) => ({
        id: w.id,
        group_id: w.groupId,
        user_id: w.userId,
        original: w.original,
        translation: w.translation,
        correct_count: w.correctCount,
        last_reviewed: w.lastReviewed ? w.lastReviewed.toISOString() : null,
        created_at: w.createdAt.toISOString(),
      })),
      totalCount: totalCountResult,
    });
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
 * Оптимизировано: все операции в одной транзакции вместо 7+ отдельных запросов.
 * Когда слово набирает 5 очков (correctCount >= 5) — оно считается выученным.
 * Для бесплатных пользователей: лимит 50 выученных слов в неделю.
 */
router.post('/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    const { knew, correctDelta = 1, incorrectDelta = -1 } = req.body;

    const delta = knew ? Number(correctDelta) : Number(incorrectDelta);
    const now = new Date();
    const currentMonday = getMonday(now);

    // Вся операция в одной транзакции — атомарность и производительность
    const result = await prisma.$transaction(async (tx) => {
      // 1. Проверяем существование слова
      const existing = await tx.word.findFirst({
        where: { id, userId: req.user.id },
      });
      if (!existing) {
        throw Object.assign(new Error('Word not found'), { status: 404 });
      }

      // 2. Получаем данные пользователя
      const user = await tx.user.findUnique({
        where: { id: req.user.id },
        select: {
          isPremium: true,
          wordsLearnedThisWeek: true,
          weekStartDate: true,
        },
      });
      if (!user) {
        throw Object.assign(new Error('User not found'), { status: 404 });
      }

      const wasLearnedBefore = existing.correctCount >= 5;
      const newCount = Math.max(0, existing.correctCount + delta);
      const isNowLearned = newCount >= 5;
      const justLearned = !wasLearnedBefore && isNowLearned;

      // 3. Сброс недели если нужно
      let wordsLearnedThisWeek = user.wordsLearnedThisWeek;
      let weekStartDate = user.weekStartDate;

      if (!weekStartDate || weekStartDate < currentMonday) {
        wordsLearnedThisWeek = 0;
        weekStartDate = currentMonday;
      }

      // 4. Обновляем weekly counter если слово только что выучено
      if (justLearned && !user.isPremium && wordsLearnedThisWeek < 50) {
        wordsLearnedThisWeek++;
      }

      // 5. Обновляем слово и пользователя в одном батче
      const [, updatedUser] = await Promise.all([
        tx.word.update({
          where: { id },
          data: {
            correctCount: newCount,
            lastReviewed: now,
          },
        }),
        tx.user.update({
          where: { id: req.user.id },
          data: {
            wordsLearnedThisWeek,
            weekStartDate,
          },
        }),
      ]);

      return {
        newCount,
        justLearned,
        wordsLearnedThisWeek,
        isPremium: user.isPremium,
      };
    });

    // Достижения и streak — вне транзакции (не критично если упадут)
    if (result.justLearned) {
      achievementsService.checkAndUpdate(req.user.id, 'word_learned', 1).catch(() => {});
    }
    streaksService.checkIn(req.user.id).catch(() => {});

    res.json({
      id,
      correct_count: result.newCount,
      last_reviewed: now.toISOString(),
      just_learned: result.justLearned,
      words_learned_this_week: result.wordsLearnedThisWeek,
      limit_reached: result.wordsLearnedThisWeek >= 50 && !result.isPremium,
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
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
