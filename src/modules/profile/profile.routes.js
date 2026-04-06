const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');

const router = express.Router();

/**
 * GET /profile
 * Returns current user profile (id, email, is_premium, ai_messages_used, created_at, subscription).
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
    const isPremium = user.isPremium || hasActiveSubscription;

    // Проверяем актуальность недели
    const currentMonday = getMonday(now);
    let wordsLearnedThisWeek = user.wordsLearnedThisWeek || 0;

    if (!user.weekStartDate || user.weekStartDate < currentMonday) {
      wordsLearnedThisWeek = 0;
      // Сбрасываем счётчик в БД
      await prisma.user.update({
        where: { id: req.user.id },
        data: { wordsLearnedThisWeek: 0, weekStartDate: currentMonday },
      });
    }

    res.json({
      id: user.id,
      email: user.email,
      is_premium: isPremium,
      ai_messages_used: user.aiMessagesUsed,
      created_at: user.createdAt.toISOString(),
      subscription_type: user.subscriptionType || null,
      subscription_expires_at: user.subscriptionExpiresAt
        ? user.subscriptionExpiresAt.toISOString()
        : null,
      words_learned_this_week: wordsLearnedThisWeek,
      weekly_limit: isPremium ? Infinity : 50,
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
 */
router.patch('/', authMiddleware, async (req, res) => {
  try {
    const { is_premium } = req.body;
    const data = {};
    if (typeof is_premium === 'boolean') data.isPremium = is_premium;

    if (Object.keys(data).length === 0) {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          email: true,
          isPremium: true,
          aiMessagesUsed: true,
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
      const isPremium = user.isPremium || hasActiveSubscription;

      // Проверяем актуальность недели
      const currentMonday = getMonday(now);
      let wordsLearnedThisWeek = user.wordsLearnedThisWeek;
      
      if (!user.weekStartDate || user.weekStartDate < currentMonday) {
        wordsLearnedThisWeek = 0;
      }

      return res.json({
        id: user.id,
        email: user.email,
        is_premium: isPremium,
        ai_messages_used: user.aiMessagesUsed,
        created_at: user.createdAt.toISOString(),
        subscription_type: user.subscriptionType || null,
        subscription_expires_at: user.subscriptionExpiresAt
          ? user.subscriptionExpiresAt.toISOString()
          : null,
        words_learned_this_week: wordsLearnedThisWeek,
        weekly_limit: isPremium ? Infinity : 50,
      });
    }

    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true,
        email: true,
        isPremium: true,
        aiMessagesUsed: true,
        createdAt: true,
        subscriptionType: true,
        subscriptionExpiresAt: true,
        wordsLearnedThisWeek: true,
        weekStartDate: true,
      },
    });

    const now = new Date();
    const hasActiveSubscription =
      !!updated.subscriptionExpiresAt && updated.subscriptionExpiresAt.getTime() > now.getTime();
    const isPremium = updated.isPremium || hasActiveSubscription;

    // Проверяем актуальность недели
    const currentMonday = getMonday(now);
    let wordsLearnedThisWeek = updated.wordsLearnedThisWeek;
    
    if (!updated.weekStartDate || updated.weekStartDate < currentMonday) {
      wordsLearnedThisWeek = 0;
    }

    res.json({
      id: updated.id,
      email: updated.email,
      is_premium: isPremium,
      ai_messages_used: updated.aiMessagesUsed,
      created_at: updated.createdAt.toISOString(),
      subscription_type: updated.subscriptionType || null,
      subscription_expires_at: updated.subscriptionExpiresAt
        ? updated.subscriptionExpiresAt.toISOString()
        : null,
      words_learned_this_week: wordsLearnedThisWeek,
      weekly_limit: isPremium ? Infinity : 50,
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
    let importedGroups = 0;
    let importedWords = 0;

    await prisma.$transaction(async (tx) => {
      if (Array.isArray(groups)) {
        for (const g of groups) {
          if (!g || typeof g.name !== 'string') continue;
          const created = await tx.wordGroup.create({
            data: {
              userId: req.user.id,
              name: g.name.trim(),
              language: typeof g.language === 'string' ? g.language.trim() : '',
              createdAt: g.created_at ? new Date(g.created_at) : new Date(),
            },
          });
          if (g.id) {
            groupIdMap.set(g.id, created.id);
          }
          importedGroups += 1;
        }
      }

      if (Array.isArray(words)) {
        for (const w of words) {
          if (!w || typeof w.original !== 'string' || typeof w.translation !== 'string') continue;
          const mappedGroupId = w.group_id ? groupIdMap.get(w.group_id) : null;
          await tx.word.create({
            data: {
              userId: req.user.id,
              groupId: mappedGroupId || null,
              original: w.original.trim(),
              translation: w.translation.trim(),
              correctCount: typeof w.correct_count === 'number' ? w.correct_count : 0,
              lastReviewed: w.last_reviewed ? new Date(w.last_reviewed) : null,
              createdAt: w.created_at ? new Date(w.created_at) : new Date(),
            },
          });
          importedWords += 1;
        }
      }
    });

    return res.status(201).json({
      imported_groups: importedGroups,
      imported_words: importedWords,
    });
  } catch (err) {
    console.error('[profile/import-guest]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
