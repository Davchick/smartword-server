const { env } = require('../../config/env');

// === КОНФИГУРАЦИЯ ===
// OpenRouter API URL
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// === МОДЕЛЬ ===
// Используем только arcee-ai/trinity-large-preview:free
const MODEL = 'arcee-ai/trinity-large-preview:free';

// Пул API ключей OpenRouter (для увеличения бесплатных лимитов)
// Каждый ключ с пополнением $10+ даёт 1,000 бесплатных запросов/день
let currentKeyIndex = 0;
let keyFailureCounts = new Map(); // Счётчик неудач для каждого ключа
let keyDailyUsage = new Map(); // Отслеживаем использование по ключам

// Инициализируем пул ключей
const apiKeys = [];
if (env.openrouterApiKeys) {
  const keys = env.openrouterApiKeys.split(',').map(k => k.trim()).filter(k => k);
  keys.forEach((key, index) => {
    apiKeys.push({
      key: key,
      index: index,
      freeLimit: 1000, // 1,000 бесплатных запросов/день после $10+
    });
  });
}

/**
 * Получает следующий доступный API ключ (round-robin)
 */
function getNextKey() {
  if (apiKeys.length === 0) return null;
  
  // Пробуем найти ключ с доступным лимитом (начиная с текущего индекса)
  for (let i = 0; i < apiKeys.length; i++) {
    const keyIndex = (currentKeyIndex + i) % apiKeys.length;
    const keyInfo = apiKeys[keyIndex];
    const failures = keyFailureCounts.get(keyInfo.key) || 0;
    const usage = keyDailyUsage.get(keyInfo.key) || 0;
    
    // Если у ключа меньше 3 неудач подряд и не исчерпан дневной лимит
    if (failures < 3 && usage < keyInfo.freeLimit) {
      currentKeyIndex = (keyIndex + 1) % apiKeys.length;
      return keyInfo.key;
    }
  }
  
  // Все ключи имеют проблемы — сбрасываем счётчики и пробуем снова
  keyFailureCounts.clear();
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  return apiKeys[currentKeyIndex]?.key || null;
}

/**
 * Отмечает ключ как неудачный (была ошибка)
 */
function markKeyFailed(key) {
  const count = keyFailureCounts.get(key) || 0;
  keyFailureCounts.set(key, count + 1);
}

/**
 * Отмечает ключ как успешный (сбрасываем счётчик неудач)
 */
function markKeySuccess(key) {
  keyFailureCounts.delete(key);
  
  // Увеличиваем счётчик использования
  const usage = keyDailyUsage.get(key) || 0;
  keyDailyUsage.set(key, usage + 1);
}

/**
 * Сбрасывает дневное использование (вызывать раз в 24 часа)
 */
function resetDailyUsage() {
  keyDailyUsage.clear();
}

// Автосброс использования каждые 24 часа
setInterval(resetDailyUsage, 24 * 60 * 60 * 1000);

/**
 * Основной метод для вызова AI с fallback между ключами
 * @param {Array} messages - Массив сообщений {role, content}
 * @param {number} maxTokens - Максимум токенов в ответе
 * @param {number} temperature - Температура генерации
 * @param {object} options - Дополнительные опции (abortSignal для отмены при disconnect клиента)
 * @returns {Promise<string>} Ответ AI
 */
async function callOpenRouter(messages, maxTokens = 300, temperature = 0.85, options = {}) {
  if (apiKeys.length === 0) {
    throw new Error('No OpenRouter API keys configured');
  }

  const { abortSignal } = options;

  // Пробуем каждый ключ (максимум 2 круга)
  for (let attempt = 0; attempt < apiKeys.length * 2; attempt++) {
    const apiKey = getNextKey();
    if (!apiKey) {
      throw new Error('No available OpenRouter API keys (all keys exhausted daily limits or failed)');
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      if (abortSignal && abortSignal.aborted) {
        clearTimeout(timeoutId);
        throw new Error('Request aborted by client');
      }

      const abortListener = () => {
        clearTimeout(timeoutId);
        controller.abort();
      };
      if (abortSignal) {
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }

      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://smartword.app',
          'X-Title': 'SmartWord',
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortListener);
      }

      if (!response.ok) {
        const errorText = await response.text();
        const errorCode = response.status;

        // 429 — Rate limit
        if (errorCode === 429) {
          markKeyFailed(apiKey);
          continue;
        }

        // 401/403 — Неверный ключ
        if (errorCode === 401 || errorCode === 403) {
          markKeyFailed(apiKey);
          continue;
        }

        // 5xx — Ошибка сервера OpenRouter
        if (errorCode >= 500 && errorCode < 600) {
          markKeyFailed(apiKey);
          continue;
        }

        throw new Error(`OpenRouter error: ${errorCode} ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content ?? '';

      // Проверяем, что OpenRouter не вернул ошибку в content (бывает при 200)
      if (content && (content.includes('Internal server error') || content.includes('rate limit exceeded') || content.includes('overloaded'))) {
        throw new Error(`OpenRouter returned error in content: ${content}`);
      }

      markKeySuccess(apiKey);

      if (!content) {
        throw new Error('Empty response from AI');
      }

      return content;

    } catch (error) {
      // Клиент отключился — пробрасываем сразу
      if (error.name === 'AbortError' && abortSignal && abortSignal.aborted) {
        throw new Error('Request aborted by client');
      }

      // Network error — пробуем следующий ключ
      if (error.name === 'TypeError' || error.name === 'AbortError') {
        markKeyFailed(apiKey);
        continue;
      }

      // Другие ошибки — пробуем следующий ключ
      if (!error.message.includes('OpenRouter error')) {
        markKeyFailed(apiKey);
        continue;
      }

      throw error;
    }
  }

  throw new Error('All OpenRouter API keys exhausted');
}

/**
 * Обёртка для translate endpoint
 */
async function translateText(text, options = {}) {
  const prompt = `Translate the following text into Russian. Return ONLY the translation, no explanations, no quotes:\n\n${text}`;
  return await callOpenRouter([{ role: 'user', content: prompt }], 200, 0.5, options);
}

/**
 * Обёртка для hint endpoint
 */
async function generateHint(text, options = {}) {
  const prompt = `The user is learning a foreign language and doesn't know how to respond to this message:\n\n"${text}"\n\nWrite 2-3 short natural reply suggestions. CRITICAL RULES:\n- Use EXACTLY the same language, dialect, and style as the message above. If the message is in American English slang — reply in American English slang. If Arabic — reply in Arabic. If French — reply in French. Zero exceptions.\n- Never use Russian or any other language not present in the message.\n- Match the tone and register precisely (casual, formal, slang, etc.).\n- Keep each suggestion to one short sentence.\n- Format as a numbered list (1. 2. 3.). No explanations, no translations.`;
  return await callOpenRouter([{ role: 'user', content: prompt }], 200, 0.5, options);
}

/**
 * Обёртка для chat endpoint
 */
async function chat(messages, systemPrompt, options = {}) {
  const openRouterMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  return await callOpenRouter(openRouterMessages, 300, 0.85, options);
}

/**
 * Получить статистику использования ключей
 */
function getUsageStats() {
  return apiKeys.map(keyInfo => ({
    key: keyInfo.key.substring(0, 8) + '...',
    usage: keyDailyUsage.get(keyInfo.key) || 0,
    limit: keyInfo.freeLimit,
    remaining: keyInfo.freeLimit - (keyDailyUsage.get(keyInfo.key) || 0),
  }));
}

/**
 * Получить информацию о используемой модели
 */
function getModelInfo() {
  return {
    model: MODEL,
  };
}

module.exports = {
  callOpenRouter,
  translateText,
  generateHint,
  chat,
  getUsageStats,
  resetDailyUsage,
  getModelInfo,
};
