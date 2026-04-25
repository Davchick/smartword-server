const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const aiService = require('./aiService');
const streaksService = require('../streaks/streaks.service');
const { LRUCache } = require('../../utils/lruCache');

const router = express.Router();

// Максимум бесплатных сообщений ИИ для непремиум-пользователя
const FREE_MESSAGES_LIMIT = 10;

// Лимиты валидации сообщений
const MAX_MESSAGE_LENGTH = 1000; // символов на одно сообщение
const MAX_MESSAGES_COUNT = 50;   // максимум сообщений в одном запросе
const MAX_TEXT_LENGTH = 500;     // для translate/hint

/**
 * LRU кэш для слов пользователя в чате.
 * TTL: 5 мин — слова меняются редко во время чат-сессии.
 * Снижает нагрузку на БД: вместо N запросов на N сообщений — 1 запрос за 5 мин.
 */
const chatWordsCache = new LRUCache(5000, 5 * 60 * 1000);

function getCachedWords(userId, groupId) {
  const key = `${userId}:${groupId || 'none'}`;
  return chatWordsCache.get(key);
}

function setCachedWords(userId, groupId, words) {
  const key = `${userId}:${groupId || 'none'}`;
  chatWordsCache.set(key, words);
}

/**
 * Инвалидирует кэш слов для пользователя (все группы).
 * Вызывается при изменении слов — чтобы чат использовал актуальные данные.
 */
function invalidateCachedWords(userId) {
  // Удаляем все записи для данного пользователя
  // chatWordsCache использует ключи вида "userId:groupId"
  for (const key of chatWordsCache.cache.keys()) {
    if (key.startsWith(`${userId}:`)) {
      chatWordsCache.delete(key);
    }
  }
}

// Экспорт будет в конце файла через router.invalidateCachedWords

/**
 * POST /chat/translate
 * Body: { text }
 * Returns: { result }
 */
router.post('/translate', authMiddleware, async (req, res) => {
  // AbortController для отмены при disconnect клиента
  const abortController = new AbortController();
  req.socket.on('close', () => { abortController.abort(); });

  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `Текст слишком длинный. Максимум: ${MAX_TEXT_LENGTH} символов` });
    }
    const result = await aiService.translateText(text, { abortSignal: abortController.signal });
    res.json({ result: result.trim() });
  } catch (err) {
    if (err.message === 'Request aborted by client') {
      if (!req.socket.destroyed) {
        return res.status(499).json({ error: 'Client disconnected' });
      }
      return;
    }
    console.error('[chat/translate]', err);
    res.status(502).json({ error: 'AI service error' });
  }
});

/**
 * POST /chat/hint
 * Body: { text }
 * Returns: { result }
 */
router.post('/hint', authMiddleware, async (req, res) => {
  // AbortController для отмены при disconnect клиента
  const abortController = new AbortController();
  req.socket.on('close', () => { abortController.abort(); });

  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `Текст слишком длинный. Максимум: ${MAX_TEXT_LENGTH} символов` });
    }
    const result = await aiService.generateHint(text, { abortSignal: abortController.signal });
    res.json({ result: result.trim() });
  } catch (err) {
    if (err.message === 'Request aborted by client') {
      if (!req.socket.destroyed) {
        return res.status(499).json({ error: 'Client disconnected' });
      }
      return;
    }
    console.error('[chat/hint]', err);
    res.status(502).json({ error: 'AI service error' });
  }
});

/**
 * POST /chat
 * Body: { messages, group_id?, group_name? }
 * Returns: { reply, messages_used } or 403 { error: "limit_reached", used }
 */
router.post('/', authMiddleware, async (req, res) => {
  // AbortController для отмены при disconnect клиента
  const abortController = new AbortController();
  req.socket.on('close', () => { abortController.abort(); });

  try {
    const { messages, group_id: groupId, isInitialMessage } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }
    if (messages.length > MAX_MESSAGES_COUNT) {
      return res.status(400).json({ error: `Слишком много сообщений. Максимум: ${MAX_MESSAGES_COUNT}` });
    }
    // Валидация длины каждого сообщения
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (typeof msg.content !== 'string' || msg.content.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `Сообщение слишком длинное. Максимум: ${MAX_MESSAGE_LENGTH} символов` });
      }
      if (!msg.role || !['user', 'assistant'].includes(msg.role)) {
        return res.status(400).json({ error: 'Некорректный формат сообщений' });
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { isPremium: true, aiMessagesUsed: true, subscriptionExpiresAt: true, lastAiMessageResetAt: true },
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date();
    const hasActiveSubscription =
      !!user.subscriptionExpiresAt && user.subscriptionExpiresAt.getTime() > now.getTime();
    const isPremium = hasActiveSubscription;

    // Daily reset: если последний сброс был не сегодня — обнуляем счётчик
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lastReset = user.lastAiMessageResetAt ? new Date(user.lastAiMessageResetAt) : null;
    const isNewDay = !lastReset || lastReset < today;

    let currentUsed = user.aiMessagesUsed ?? 0;

    if (!isPremium && isNewDay) {
      // Сбрасываем счётчик — новый день
      currentUsed = 0;
      await prisma.user.update({
        where: { id: req.user.id },
        data: { aiMessagesUsed: 0, lastAiMessageResetAt: now },
      });
    }

    if (!isPremium && currentUsed >= FREE_MESSAGES_LIMIT) {
      return res.status(403).json({
        error: 'limit_reached',
        used: currentUsed,
      });
    }

    // Stable source of dictionary language: WordGroup.language
    // group_name is treated as UI-only and is not used for language selection
    let groupLanguage = null;
    if (groupId) {
      const group = await prisma.wordGroup.findFirst({
        where: { id: groupId, userId: req.user.id },
        select: { language: true },
      });
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }
      groupLanguage = typeof group.language === 'string' ? group.language.trim() : '';
    }

    // Кэшируем слова — вместо N запросов на N сообщений, 1 запрос за 5 мин
    let words = getCachedWords(req.user.id, groupId);
    if (!words) {
      const wordsWhere = { userId: req.user.id };
      if (groupId) wordsWhere.groupId = groupId;
      words = await prisma.word.findMany({
        where: wordsWhere,
        orderBy: { correctCount: 'asc' },
        take: 12,
        select: { original: true, translation: true },
      });
      setCachedWords(req.user.id, groupId, words);
    }
    const hasWords = words.length > 0;

    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const lastContent = lastUserMsg?.content ?? '';
    const isFreeChat = lastContent.includes('Свободное общение');

    let systemPrompt;
    if (isFreeChat || !hasWords) {
      systemPrompt = `Role: You are Lexi — a friendly, authentic conversation partner from around the world. You hate formal teaching and "AI-style" encouragement.

Interaction Rules:
1. The Hook: Start strictly in Russian: "Привет! Какой язык хочешь практиковать?"
2. Mirroring: From the second message onward, always respond in the same language the user used in their last message.
3. Seamless Transitions: If the user switches languages at any point, switch with them immediately.
4. True Peer Persona: Never say "Great job!", "Keep going!", or "I'm an AI." Do not act like a tutor. Talk like a real person sharing a coffee.
5. Natural Flow: Keep replies short (1-5 sentences). Share brief opinions or tiny "personal" details to keep it human. No bullet points or lists.
6. The One-Question Rule: End your messages with exactly one engaging question about the user's life, plans, or opinions.
7. No "Practice" Talk: Never mention "practicing," "learning," or "improving." Just have a genuine conversation. Never use emojis`;
    } else {
      const targetLanguage = groupLanguage || 'the target language of the user dictionary';
      const activeTargetWords = words
        .map((w) => (typeof w.original === 'string' ? w.original.trim() : ''))
        .filter(Boolean)
        .slice(0, 8);

      systemPrompt = `Role: You are Lexi — a friendly, authentic conversation partner. Not a tutor, not a bot.

Mode: Dictionary chat. The conversation should start immediately in ${targetLanguage}.

Top priority: Natural human conversation. Never sacrifice naturalness for vocabulary usage.

Language policy:
- Default: reply in ${targetLanguage}.
- Russian is allowed only when the user explicitly asks for Russian/translation/explanation, or when the user writes in Russian and is clearly stuck. In that case, reply briefly in Russian and gently return to ${targetLanguage}.

No "practice talk": Never mention practicing, learning, improving, vocabulary lists, or anything like that.
No AI-style encouragement: Never say "Great job!", "Keep going!", or "I'm an AI."
No emojis.

Vocabulary (hidden background context; do NOT mention this list to the user):
${activeTargetWords.join(', ')}

Vocabulary usage rule (very gentle):
- Sometimes you may naturally use at most ONE word from the list above, but only if it fits perfectly.
- If no word fits, use none. Do not force it. Do not steer the conversation around the list.

Style rules:
- Keep replies short (1-4 sentences).
- End with exactly one engaging question about the user's life, plans, or opinions.
- No bullet points or lists in your replies.`;
    }

    const reply = await aiService.chat(messages, systemPrompt, { abortSignal: abortController.signal });

    // Первое приветственное сообщение ИИ для непремиум-пользователя не засчитываем
    // Но счётчик ВСЕГДА обновляется в БД для синхронизации состояния между запросами
    // isInitialMessage — служебное сообщение от фронтенда (выбор словаря/свободное общение) не засчитываем
    const shouldBill = isPremium ? true : (isInitialMessage ? false : currentUsed > 0);
    const newCount = currentUsed + 1;

    // ВСЕГДА обновляем БД — синхронизируем состояние между запросами
    await prisma.user.update({
      where: { id: req.user.id },
      data: { aiMessagesUsed: newCount, lastAiMessageResetAt: now },
    });

    // Определяем, что показать клиенту:
    // - Для премиум: показываем сколько сообщений использовано (newCount - 1 = currentUsed)
    // - Для непремиум: первое бесплатное показываем как 0, последующие - сколько использовано
    //   newCount - 1 = текущее использование (0 для первого, 1 для второго...)
    const clientCount = newCount - 1;

    if (shouldBill) {
      // Обновляем streak (check-in при активности)
      try {
        await streaksService.checkIn(req.user.id);
      } catch (err) {
        console.error('[chat] Streak check-in error:', err);
      }
    }

    res.json({ reply: reply || '...', messages_used: clientCount });
  } catch (err) {
    if (err.message === 'Request aborted by client') {
      if (!abortController.signal.aborted) {
        return res.status(499).json({ error: 'Client disconnected' });
      }
      return;
    }
    console.error('[chat POST]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /chat/usage
 * Returns usage stats for all API keys
 */
router.get('/usage', authMiddleware, async (req, res) => {
  try {
    const stats = aiService.getUsageStats();
    res.json({ stats });
  } catch (err) {
    console.error('[chat/usage]', err);
    res.status(500).json({ error: 'Failed to get usage stats' });
  }
});

router.invalidateCachedWords = invalidateCachedWords;

module.exports = router;
