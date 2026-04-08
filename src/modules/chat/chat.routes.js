const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const aiService = require('./aiService');
const achievementsService = require('../achievements/achievements.service');
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
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `Текст слишком длинный. Максимум: ${MAX_TEXT_LENGTH} символов` });
    }
    const result = await aiService.translateText(text);
    res.json({ result: result.trim() });
  } catch (err) {
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
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `Текст слишком длинный. Максимум: ${MAX_TEXT_LENGTH} символов` });
    }
    const result = await aiService.generateHint(text);
    res.json({ result: result.trim() });
  } catch (err) {
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
  try {
    const { messages, group_id: groupId, group_name: groupName } = req.body;
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
      select: { isPremium: true, aiMessagesUsed: true, subscriptionExpiresAt: true },
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date();
    const hasActiveSubscription =
      !!user.subscriptionExpiresAt && user.subscriptionExpiresAt.getTime() > now.getTime();
    const isPremium = user.isPremium || hasActiveSubscription;

    const currentUsed = user.aiMessagesUsed ?? 0;

    if (!isPremium && currentUsed >= FREE_MESSAGES_LIMIT) {
      return res.status(403).json({
        error: 'limit_reached',
        used: currentUsed,
      });
    }

    // Кэшируем слова — вместо N запросов на N сообщений, 1 запрос за 5 мин
    let words = getCachedWords(req.user.id, groupId);
    if (!words) {
      const wordsWhere = { userId: req.user.id };
      if (groupId) wordsWhere.groupId = groupId;
      words = await prisma.word.findMany({
        where: wordsWhere,
        orderBy: { correctCount: 'asc' },
        take: 40,
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
      systemPrompt = `You are Lexi — a real person who loves chatting with people from around the world.

The user has chosen free conversation mode.

FIRST MESSAGE ONLY: Ask in Russian which language they want to practice. One short casual question, nothing more. Example: "Какой язык хочешь практиковать?"

AFTER THEY NAME A LANGUAGE — ABSOLUTE RULES, NO EXCEPTIONS:
1. Switch to that language IMMEDIATELY and PERMANENTLY.
2. NEVER write in Russian again — not a single word, not even a greeting, not even punctuation markers.
3. If the user writes in Russian — IGNORE the Russian and reply ONLY in the chosen language. Do not acknowledge they wrote in Russian.
4. This applies to ALL languages: English, Arabic (العربية), Chinese, Japanese, French, Spanish, German, Turkish, Korean — any language at all.
5. For Arabic: write in Modern Standard Arabic or the dialect the user prefers. Never switch to English.
6. Be a genuinely engaging conversation partner. Ask about their life, plans, opinions.
7. Keep replies to 1-3 sentences. One question per message.
8. Match their energy and tone.
9. Never correct grammar. Just chat naturally like a human.
10. Never say "Let's practice!", "Great job!", "I'm an AI".`;
    } else {
      const wordPairs = words.map((w) => `${w.original} / ${w.translation}`).join(', ');
      const sampleOriginals = words.slice(0, 5).map((w) => w.original).join(' ');
      let detectedLanguage = 'English';
      if (/[\u4e00-\u9fff]/.test(sampleOriginals)) detectedLanguage = 'Chinese';
      else if (/[\u3040-\u30ff]/.test(sampleOriginals)) detectedLanguage = 'Japanese';
      else if (/[\u0600-\u06ff]/.test(sampleOriginals)) detectedLanguage = 'Arabic';
      else if (/[\u00C0-\u024F]/.test(sampleOriginals)) detectedLanguage = 'French or Spanish or another Romance language — detect precisely from the words';
      else if (/[a-zA-Z]/.test(sampleOriginals)) detectedLanguage = 'English';

      const langFromGroup = groupName ? groupName.replace(/[«»"']/g, '').trim() : null;
      const targetLanguage = langFromGroup || detectedLanguage;

      systemPrompt = `You are Lexi — a real person texting with the user. Not a teacher, not a bot. Just a native ${targetLanguage} speaker who enjoys good conversation.

LANGUAGE RULE — ABSOLUTE: Every single message in ${targetLanguage} only. Never Russian, never any other language, even if the user writes in Russian. No exceptions whatsoever. If the user writes in Russian — reply in ${targetLanguage} only, as if you didn't notice.

For Arabic (if ${targetLanguage} is Arabic): write in Arabic script only. Never transliterate. Never use English.

NO EMOJIS. Ever.

User vocabulary (background context only):
${wordPairs}

VOCABULARY RULE: These words are just a reference. Only use a word if it would come up completely naturally in real conversation. Never force a word. Naturalness wins over everything.

CONVERSATION RULES:
- Be genuinely engaging. Follow the user's lead.
- 1-3 sentences per message. One question max.
- Match their tone and energy.
- Never correct grammar. Never say "Great job!". Just talk like a human.`;
    }

    const reply = await aiService.chat(messages, systemPrompt);

    // Первое приветственное сообщение ИИ для непремиум-пользователя не засчитываем
    let newCount = currentUsed;
    const shouldBill = isPremium ? true : currentUsed > 0;

    if (shouldBill) {
      newCount = currentUsed + 1;
      await prisma.user.update({
        where: { id: req.user.id },
        data: { aiMessagesUsed: newCount },
      });
      
      // Обновляем достижения для AI chat
      try {
        const unlockedAchievements = await achievementsService.checkAndUpdate(req.user.id, 'chat_message', 1);
        if (unlockedAchievements.length > 0) {
          console.log('[chat] Achievements unlocked:', unlockedAchievements.map(a => a.title));
        }
      } catch (err) {
        console.error('[chat] Achievement check error:', err);
      }
    }

    // Обновляем streak (check-in при активности)
    try {
      await streaksService.checkIn(req.user.id);
    } catch (err) {
      console.error('[chat] Streak check-in error:', err);
    }

    res.json({ reply: reply || '...', messages_used: newCount });
  } catch (err) {
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
