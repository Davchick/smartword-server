const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const streaksService = require('../streaks/streaks.service');
const statsRoutes = require('../stats/stats.routes');
const chatRoutes = require('../chat/chat.routes');

const router = express.Router();

router.use(authMiddleware);

/**
 * GET /words?groupId=...&archived=true&fields=groupId,correctCount&limit=100&cursor=...&search=...
 * List words for current user, optional filters.
 *
 * Параметры:
 *  - groupId: фильтр по группе
 *  - archived: true (только выученные) / false (только не выученные)
 *  - search: поиск по original или translation (case-insensitive)
 *  - fields: comma-separated список полей (по умолчанию все). Пример: "id,groupId,correctCount"
 *  - limit: максимум записей (по умолчанию 200, максимум 500)
 *  - cursor: ID последнего полученного слова (cursor-based pagination)
 *
 * Возвращает { words: [...], totalCount: number, hasNext: boolean }
 */
router.get('/', async (req, res) => {
  try {
    const { groupId, archived, fields, limit: limitStr, cursor, search } = req.query;

    const where = { userId: req.user.id };
    if (groupId && typeof groupId === 'string') where.groupId = groupId;
    if (archived === 'true') where.correctCount = { gte: 5 };
    if (archived === 'false') where.correctCount = { lt: 5 };
    // Server-side search
    if (search && typeof search === 'string' && search.trim()) {
      const q = search.trim().toLowerCase();
      where.OR = [
        { original: { contains: q, mode: 'insensitive' } },
        { translation: { contains: q, mode: 'insensitive' } },
      ];
    }

    // Парсим limit с ограничениями безопасности
    const limit = Math.min(Math.max(1, Number(limitStr) || 200), 500);

    // Определяем какие поляли возвращать
    const allFields = [
      'id', 'group_id', 'user_id', 'original', 'translation',
      'correct_count', 'last_reviewed', 'created_at'
    ];
    let selectedFields = allFields;
    if (fields && typeof fields === 'string') {
      const requested = fields.split(',').map(f => f.trim());
      selectedFields = allFields.filter(f => requested.includes(f));
      // Всегда включаем id — нужен клиенту
      if (!selectedFields.includes('id')) selectedFields.unshift('id');
    }

    // Cursor-based pagination
    const paginationWhere = cursor ? { ...where, id: { lt: cursor } } : where;

    // Параллельно: слова + totalCount
    const [words, totalCount] = await Promise.all([
      prisma.word.findMany({
        where: paginationWhere,
        orderBy: { id: 'desc' },
        take: limit + 1, // Берём на 1 больше чтобы узнать hasNext
        select: getWordSelect(selectedFields),
      }),
      prisma.word.count({ where }),
    ]);

    const hasNext = words.length > limit;
    if (hasNext) words.pop(); // Убираем лишний элемент

    const mappedWords = words.map((w) => mapWordResponse(w, selectedFields));

    res.json({
      words: mappedWords,
      totalCount,
      hasNext,
      nextCursor: hasNext && words.length > 0 ? words[words.length - 1].id : null,
    });
  } catch (err) {
    console.error('[words GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Получить объект select для Prisma query на основе запрошенных полей
 */
function getWordSelect(fields) {
  const fieldMap = {
    id: true,
    group_id: 'groupId',
    user_id: 'userId',
    original: true,
    translation: true,
    correct_count: 'correctCount',
    last_reviewed: 'lastReviewed',
    created_at: 'createdAt',
  };
  const select = {};
  for (const field of fields) {
    const prismaField = fieldMap[field];
    if (prismaField) {
      select[prismaField === true ? field : prismaField] = true;
    }
  }
  return select;
}

/**
 * Маппинг ответа с учётом выбранных полей
 */
function mapWordResponse(w, fields) {
  const response = {};
  if (fields.includes('id')) response.id = w.id;
  if (fields.includes('group_id')) response.group_id = w.groupId;
  if (fields.includes('user_id')) response.user_id = w.userId;
  if (fields.includes('original')) response.original = w.original;
  if (fields.includes('translation')) response.translation = w.translation;
  if (fields.includes('correct_count')) response.correct_count = w.correctCount;
  if (fields.includes('last_reviewed')) response.last_reviewed = w.lastReviewed ? w.lastReviewed.toISOString() : null;
  if (fields.includes('created_at')) response.created_at = w.createdAt.toISOString();
  return response;
}

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

    // Streak — вне транзакции (не критично если упадет)
    streaksService.checkIn(req.user.id).catch(err => {
      console.error('[words POST progress] Streak check-in error:', err?.message || err);
    });

    // Инвалидируем кэш stats — данные изменились
    statsRoutes.invalidateCachedStats(req.user.id);
    // Инвалидируем кэш слов чата — чтобы ИИ использовал актуальные слова
    chatRoutes.invalidateCachedWords(req.user.id);

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

/**
 * POST /words/progress/batch
 * Body: { updates: [{ wordId, knew, correctDelta?, incorrectDelta? }], totalPoints? }
 *
 * Batch update для результатов тренировочной сессии.
 * Заменяет N отдельных POST /words/:id/progress одним запросом.
 * Все операции в одной транзакции — атомарность и производительность.
 *
 * Возвращает { updated: number, just_learned: number, words_learned_this_week, limit_reached }
 */
router.post('/progress/batch', async (req, res) => {
  try {
    const { updates, totalPoints } = req.body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates array is required' });
    }

    // Ограничиваем размер батча — защита от abuse
    const MAX_BATCH_SIZE = 200;
    if (updates.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ error: `Max ${MAX_BATCH_SIZE} updates per batch` });
    }

    const now = new Date();
    const currentMonday = getMonday(now);
    let totalJustLearned = 0;

    // Вся операция в одной транзакции — атомарность и производительность
    const result = await prisma.$transaction(async (tx) => {
      // 1. Получаем данные пользователя один раз
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

      // 2. Получаем ВСЕ слова из батча одним запросом (вместо N запросов)
      const wordIds = updates.map(u => u.wordId);
      const words = await tx.word.findMany({
        where: { id: { in: wordIds }, userId: req.user.id },
        select: { id: true, correctCount: true },
      });

      const wordMap = new Map();
      for (const w of words) {
        wordMap.set(w.id, w);
      }

      // 3. Сброс недели если нужно
      let wordsLearnedThisWeek = user.wordsLearnedThisWeek;
      let weekStartDate = user.weekStartDate;

      if (!weekStartDate || weekStartDate < currentMonday) {
        wordsLearnedThisWeek = 0;
        weekStartDate = currentMonday;
      }

      // 4. Формируем все update операции для слов
      const wordUpdates = [];
      const justLearnedWordIds = [];

      for (const update of updates) {
        const word = wordMap.get(update.wordId);
        if (!word) continue; // Пропускаем несуществующие слова (не ошибка)

        const delta = update.knew
          ? Number(update.correctDelta ?? 1)
          : Number(update.incorrectDelta ?? -1);

        const wasLearnedBefore = word.correctCount >= 5;
        const newCount = Math.max(0, word.correctCount + delta);
        const isNowLearned = newCount >= 5;
        const justLearned = !wasLearnedBefore && isNowLearned;

        if (justLearned) {
          totalJustLearned++;
          justLearnedWordIds.push(update.wordId);
        }

        // Обновляем weekly counter если слово только что выучено
        if (justLearned && !user.isPremium && wordsLearnedThisWeek < 50) {
          wordsLearnedThisWeek++;
        }

        wordUpdates.push({
          where: { id: update.wordId },
          data: { correctCount: newCount, lastReviewed: now },
        });
      }

      // 5. Выполняем все обновления слов параллельно (Prisma batch)
      if (wordUpdates.length > 0) {
        await Promise.all(
          wordUpdates.map(wu => tx.word.update(wu))
        );
      }

      // 6. Обновляем training progress (очки) если переданы
      if (typeof totalPoints === 'number' && totalPoints > 0) {
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);

        await tx.trainingProgress.upsert({
          where: {
            userId_date: {
              userId: req.user.id,
              date: today,
            },
          },
          update: {
            points: { increment: totalPoints },
          },
          create: {
            userId: req.user.id,
            date: today,
            points: totalPoints,
          },
        });
      }

      // 7. Обновляем пользователя один раз
      await tx.user.update({
        where: { id: req.user.id },
        data: {
          wordsLearnedThisWeek,
          weekStartDate,
        },
      });

      return {
        updated: wordUpdates.length,
        wordsLearnedThisWeek,
        isPremium: user.isPremium,
      };
    });

    // Streak — вне транзакции (не критично если упадет)
    streaksService.checkIn(req.user.id).catch(err => {
      console.error('[words/batch] Streak check-in error:', err);
    });

    // Инвалидируем кэш stats — данные изменились
    statsRoutes.invalidateCachedStats(req.user.id);
    // Инвалидируем кэш слов чата — чтобы ИИ использовал актуальные слова
    chatRoutes.invalidateCachedWords(req.user.id);

    res.json({
      updated: result.updated,
      just_learned: totalJustLearned,
      words_learned_this_week: result.wordsLearnedThisWeek,
      limit_reached: result.wordsLearnedThisWeek >= 50 && !result.isPremium,
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    console.error('[words POST progress/batch] Error:', err);
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
