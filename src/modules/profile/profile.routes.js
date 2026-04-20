const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');

const router = express.Router();

/**
 * GET /profile
 * Returns current user profile (id, email, is_premium, ai_messages_used, created_at, subscription).
 *
 * Оптимизировано: без UPDATE на GET. Сброс счётчиков —
 * lazy (при следующем POST/PATCH или через cron).
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        isPremium: true,
        aiMessagesUsed: true,
        lastAiMessageResetAt: true,
        createdAt: true,
        subscriptionType: true,
        subscriptionExpiresAt: true,
        wordsLearnedThisWeek: true,
        weekStartDate: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date();
    const hasActiveSubscription =
      !!user.subscriptionExpiresAt && user.subscriptionExpiresAt.getTime() > now.getTime();
    const isPremium = hasActiveSubscription;

    // Lazy daily reset для aiMessagesUsed
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lastReset = user.lastAiMessageResetAt ? new Date(user.lastAiMessageResetAt) : null;
    const isNewDay = !lastReset || lastReset < today;
    let aiMessagesUsed = isNewDay ? 0 : (user.aiMessagesUsed ?? 0);

    // Lazy проверка актуальности недели — без UPDATE в БД
    const currentMonday = getMonday(now);
    let wordsLearnedThisWeek = user.wordsLearnedThisWeek || 0;
    let weekNeedsReset = false;

    if (!user.weekStartDate || user.weekStartDate < currentMonday) {
      wordsLearnedThisWeek = 0;
      weekNeedsReset = true;
    }

    res.json({
      id: user.id,
      email: user.email,
      is_premium: isPremium,
      ai_messages_used: aiMessagesUsed,
      last_ai_message_reset_at: lastReset ? lastReset.toISOString() : null,
      created_at: user.createdAt.toISOString(),
      subscription_type: user.subscriptionType || null,
      subscription_expires_at: user.subscriptionExpiresAt
        ? user.subscriptionExpiresAt.toISOString()
        : null,
      words_learned_this_week: wordsLearnedThisWeek,
      weekly_limit: isPremium ? 999999 : 50,
      _week_needs_reset: weekNeedsReset, // internal flag, not used by client
    });
  } catch (err) {
    console.error('[profile GET]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Утилита: получить понедельник текущей недели
function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * PATCH /profile
 * Optional: update profile fields (e.g. for IAP / is_premium). For now only allow updating ai_messages_used from server-side; client can refetch.
 *
 * Lazy reset недельного счётчика — если наступила новая неделя.
 */
router.patch('/', authMiddleware, async (req, res) => {
  try {
    const { is_premium } = req.body;
    const data = {};
    if (typeof is_premium === 'boolean') data.isPremium = is_premium;

    const now = new Date();
    const currentMonday = getMonday(now);

    if (Object.keys(data).length === 0) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          email: true,
          isPremium: true,
          aiMessagesUsed: true,
          lastAiMessageResetAt: true,
          createdAt: true,
          subscriptionType: true,
          subscriptionExpiresAt: true,
          wordsLearnedThisWeek: true,
          weekStartDate: true,
        },
      });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const hasActiveSubscription =
        !!user.subscriptionExpiresAt && user.subscriptionExpiresAt.getTime() > now.getTime();
      const isPremium = hasActiveSubscription;

      // Lazy daily reset
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const lastReset = user.lastAiMessageResetAt ? new Date(user.lastAiMessageResetAt) : null;
      const isNewDay = !lastReset || lastReset < today;
      let aiMessagesUsed = isNewDay ? 0 : (user.aiMessagesUsed ?? 0);

      let wordsLearnedThisWeek = user.wordsLearnedThisWeek;
      if (!user.weekStartDate || user.weekStartDate < currentMonday) {
        wordsLearnedThisWeek = 0;
      }

      return res.json({
        id: user.id,
        email: user.email,
        is_premium: isPremium,
        ai_messages_used: aiMessagesUsed,
        last_ai_message_reset_at: lastReset ? lastReset.toISOString() : null,
        created_at: user.createdAt.toISOString(),
        subscription_type: user.subscriptionType || null,
        subscription_expires_at: user.subscriptionExpiresAt
          ? user.subscriptionExpiresAt.toISOString()
          : null,
        words_learned_this_week: wordsLearnedThisWeek,
        weekly_limit: isPremium ? 999999 : 50,
      });
    }

    // Lazy reset недели если нужно
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { weekStartDate: true, wordsLearnedThisWeek: true },
    });

    if (user && (!user.weekStartDate || user.weekStartDate < currentMonday)) {
      data.weekStartDate = currentMonday;
      data.wordsLearnedThisWeek = 0;
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true,
        email: true,
        isPremium: true,
        aiMessagesUsed: true,
        lastAiMessageResetAt: true,
        createdAt: true,
        subscriptionType: true,
        subscriptionExpiresAt: true,
        wordsLearnedThisWeek: true,
        weekStartDate: true,
      },
    });

    const hasActiveSubscription =
      !!updated.subscriptionExpiresAt && updated.subscriptionExpiresAt.getTime() > now.getTime();
    const isPremium = hasActiveSubscription;

    let wordsLearnedThisWeek = updated.wordsLearnedThisWeek;
    if (!updated.weekStartDate || updated.weekStartDate < currentMonday) {
      wordsLearnedThisWeek = 0;
    }

    res.json({
      id: updated.id,
      email: updated.email,
      is_premium: isPremium,
      ai_messages_used: updated.aiMessagesUsed,
      last_ai_message_reset_at: updated.lastAiMessageResetAt ? updated.lastAiMessageResetAt.toISOString() : null,
      created_at: updated.createdAt.toISOString(),
      subscription_type: updated.subscriptionType || null,
      subscription_expires_at: updated.subscriptionExpiresAt
        ? updated.subscriptionExpiresAt.toISOString()
        : null,
      words_learned_this_week: wordsLearnedThisWeek,
      weekly_limit: isPremium ? 999999 : 50,
    });
  } catch (err) {
    console.error('[profile PATCH]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /profile/import-guest
 * Импортирует гостевые словари и слова в новый аккаунт.
 * Используется ОДИН РАЗ — только когда у пользователя в базе ещё нет данных.
 * Body: { groups: GuestGroup[], words: GuestWord[] }
 * Оптимизировано: используем createMany вместо цикла отдельных INSERT.
 */
router.post('/import-guest', authMiddleware, async (req, res) => {
  try {
    const { groups, words } = req.body || {};

    if ((!Array.isArray(groups) || groups.length === 0) && (!Array.isArray(words) || words.length === 0)) {
      return res.status(400).json({ error: 'No guest data to import' });
    }

    // Не допускаем импорт в уже существующий аккаунт с данными
    const [existingGroups, existingWords] = await prisma.$transaction([
      prisma.wordGroup.count({ where: { userId: req.user.id } }),
      prisma.word.count({ where: { userId: req.user.id } }),
    ]);

    if (existingGroups > 0 || existingWords > 0) {
      return res.status(409).json({ error: 'already_initialized' });
    }

    const groupIdMap = new Map();

    await prisma.$transaction(async (tx) => {
      // 1. Создаём группы батчем через createMany
      const validGroups = (Array.isArray(groups) ? groups : [])
        .filter(g => g && typeof g.name === 'string')
        .map(g => ({
          userId: req.user.id,
          name: g.name.trim(),
          language: typeof g.language === 'string' ? g.language.trim() : '',
          createdAt: g.created_at ? new Date(g.created_at) : new Date(),
        }));

      if (validGroups.length > 0) {
        await tx.wordGroup.createMany({
          data: validGroups,
        });

        // Запрашиваем созданные группы для маппинга guest_id → db_id
        const createdGroups = await tx.wordGroup.findMany({
          where: { userId: req.user.id },
          select: { id: true, name: true, createdAt: true },
        });

        // Маппим guest_id → new_id по name+createdAt
        for (const created of createdGroups) {
          const guestGroup = groups.find(gg =>
            gg && typeof gg.name === 'string' &&
            gg.name.trim() === created.name &&
            (!gg.created_at || Math.abs(new Date(gg.created_at).getTime() - created.createdAt.getTime()) < 5000)
          );
          if (guestGroup?.id) {
            groupIdMap.set(guestGroup.id, created.id);
          }
        }
      }

      // 2. Создаём слова батчем через createMany
      const validWords = (Array.isArray(words) ? words : [])
        .filter(w => w && typeof w.original === 'string' && typeof w.translation === 'string')
        .map(w => ({
          userId: req.user.id,
          groupId: w.group_id ? (groupIdMap.get(w.group_id) || null) : null,
          original: w.original.trim(),
          translation: w.translation.trim(),
          correctCount: typeof w.correct_count === 'number' ? w.correct_count : 0,
          lastReviewed: w.last_reviewed ? new Date(w.last_reviewed) : null,
          createdAt: w.created_at ? new Date(w.created_at) : new Date(),
        }));

      if (validWords.length > 0) {
        await tx.word.createMany({
          data: validWords,
        });
      }
    });

    return res.status(201).json({
      imported_groups: Array.isArray(groups) ? groups.filter(g => g && typeof g.name === 'string').length : 0,
      imported_words: Array.isArray(words) ? words.filter(w => w && typeof w.original === 'string' && typeof w.translation === 'string').length : 0,
    });
  } catch (err) {
    console.error('[profile/import-guest]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
