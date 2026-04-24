const { env } = require('../../config/env');

// === КОНФИГУРАЦИЯ ===
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OLLAMA_CHAT_URL = `${env.ollamaBaseUrl.replace(/\/+$/, '')}/api/chat`;

// === МОДЕЛИ ===
const OPENROUTER_MODEL = 'minimax/minimax-m2.5:free';
const OLLAMA_MODEL = env.ollamaModel || 'gemini-3-flash-preview:cloud';

function parseKeys(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function buildPool(keys, freeLimit) {
  return {
    keys: keys.map((key, index) => ({ key, index, freeLimit })),
    currentKeyIndex: 0,
    keyFailureCounts: new Map(),
    keyDailyUsage: new Map(),
  };
}

const providers = {
  ollama: buildPool(parseKeys(env.ollamaApiKeys), 1000000),
  openrouter: buildPool(parseKeys(env.openrouterApiKeys), 1000),
};

/**
 * Получает следующий доступный API ключ провайдера (round-robin)
 */
function getNextKey(providerName) {
  const provider = providers[providerName];
  if (!provider || provider.keys.length === 0) return null;

  for (let i = 0; i < provider.keys.length; i++) {
    const keyIndex = (provider.currentKeyIndex + i) % provider.keys.length;
    const keyInfo = provider.keys[keyIndex];
    const failures = provider.keyFailureCounts.get(keyInfo.key) || 0;
    const usage = provider.keyDailyUsage.get(keyInfo.key) || 0;

    if (failures < 3 && usage < keyInfo.freeLimit) {
      provider.currentKeyIndex = (keyIndex + 1) % provider.keys.length;
      return keyInfo.key;
    }
  }

  provider.keyFailureCounts.clear();
  provider.currentKeyIndex = (provider.currentKeyIndex + 1) % provider.keys.length;
  return provider.keys[provider.currentKeyIndex]?.key || null;
}

/**
 * Отмечает ключ провайдера как неудачный (была ошибка)
 */
function markKeyFailed(providerName, key) {
  const provider = providers[providerName];
  if (!provider) return;

  const count = provider.keyFailureCounts.get(key) || 0;
  provider.keyFailureCounts.set(key, count + 1);
}

/**
 * Отмечает ключ провайдера как успешный (сбрасываем счётчик неудач)
 */
function markKeySuccess(providerName, key) {
  const provider = providers[providerName];
  if (!provider) return;

  provider.keyFailureCounts.delete(key);
  const usage = provider.keyDailyUsage.get(key) || 0;
  provider.keyDailyUsage.set(key, usage + 1);
}

/**
 * Сбрасывает дневное использование (вызывать раз в 24 часа) по всем провайдерам
 */
function resetDailyUsage() {
  Object.values(providers).forEach((provider) => provider.keyDailyUsage.clear());
}

// Автосброс использования каждые 24 часа
setInterval(resetDailyUsage, 24 * 60 * 60 * 1000);

function shouldRetryStatus(statusCode) {
  return statusCode === 429 || statusCode === 401 || statusCode === 403 || (statusCode >= 500 && statusCode < 600);
}

function createRequestController(timeoutMs, abortSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let abortListener;
  if (abortSignal) {
    abortListener = () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
    abortSignal.addEventListener('abort', abortListener, { once: true });
  }

  return {
    controller,
    cleanup() {
      clearTimeout(timeoutId);
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener('abort', abortListener);
      }
    },
  };
}

/**
 * Вызов Ollama Cloud с fallback между его ключами
 */
async function callOllama(messages, maxTokens = 300, temperature = 0.85, options = {}) {
  const providerName = 'ollama';
  const provider = providers[providerName];
  if (provider.keys.length === 0) {
    throw new Error('No Ollama API keys configured');
  }

  const { abortSignal } = options;

  for (let attempt = 0; attempt < provider.keys.length * 2; attempt++) {
    const apiKey = getNextKey(providerName);
    if (!apiKey) {
      throw new Error('No available Ollama API keys');
    }

    try {
      if (abortSignal && abortSignal.aborted) {
        throw new Error('Request aborted by client');
      }

      const requestController = createRequestController(22000, abortSignal);
      const response = await fetch(OLLAMA_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          stream: false,
          options: {
            temperature,
            num_predict: maxTokens,
          },
        }),
        signal: requestController.controller.signal,
      });
      requestController.cleanup();

      if (!response.ok) {
        const errorText = await response.text();
        if (shouldRetryStatus(response.status)) {
          markKeyFailed(providerName, apiKey);
          continue;
        }
        throw new Error(`Ollama error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const content = data.message?.content || data.choices?.[0]?.message?.content || '';
      if (!content) {
        markKeyFailed(providerName, apiKey);
        continue;
      }

      markKeySuccess(providerName, apiKey);
      return content;
    } catch (error) {
      if (error.name === 'AbortError' && abortSignal && abortSignal.aborted) {
        throw new Error('Request aborted by client');
      }
      if (error.name === 'TypeError' || error.name === 'AbortError' || !error.message.includes('Ollama error')) {
        markKeyFailed(providerName, apiKey);
        continue;
      }
      throw error;
    }
  }

  throw new Error('All Ollama API keys exhausted');
}

/**
 * Вызов OpenRouter с fallback между его ключами
 * @param {Array} messages - Массив сообщений {role, content}
 * @param {number} maxTokens - Максимум токенов в ответе
 * @param {number} temperature - Температура генерации
 * @param {object} options - Дополнительные опции (abortSignal для отмены при disconnect клиента)
 * @returns {Promise<string>} Ответ AI
 */
async function callOpenRouter(messages, maxTokens = 300, temperature = 0.85, options = {}) {
  const providerName = 'openrouter';
  const provider = providers[providerName];
  if (provider.keys.length === 0) {
    throw new Error('No OpenRouter API keys configured');
  }

  const { abortSignal } = options;

  for (let attempt = 0; attempt < provider.keys.length * 2; attempt++) {
    const apiKey = getNextKey(providerName);
    if (!apiKey) {
      throw new Error('No available OpenRouter API keys (all keys exhausted daily limits or failed)');
    }

    try {
      if (abortSignal && abortSignal.aborted) {
        throw new Error('Request aborted by client');
      }
      const requestController = createRequestController(25000, abortSignal);

      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://smartword.app',
          'X-Title': 'SmartWord',
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: requestController.controller.signal,
      });

      requestController.cleanup();

      if (!response.ok) {
        const errorText = await response.text();
        const errorCode = response.status;

        if (shouldRetryStatus(errorCode)) {
          markKeyFailed(providerName, apiKey);
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

      markKeySuccess(providerName, apiKey);

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
        markKeyFailed(providerName, apiKey);
        continue;
      }

      // Другие ошибки — пробуем следующий ключ
      if (!error.message.includes('OpenRouter error')) {
        markKeyFailed(providerName, apiKey);
        continue;
      }

      throw error;
    }
  }

  throw new Error('All OpenRouter API keys exhausted');
}

/**
 * Основной метод: сначала Ollama (primary), затем OpenRouter (fallback)
 */
async function callAiWithFallback(messages, maxTokens = 300, temperature = 0.85, options = {}) {
  let ollamaError = null;

  if (providers.ollama.keys.length > 0) {
    try {
      return await callOllama(messages, maxTokens, temperature, options);
    } catch (error) {
      ollamaError = error;
      if (error.message === 'Request aborted by client') {
        throw error;
      }
      console.warn('[AI] Ollama failed, falling back to OpenRouter:', error.message);
    }
  }

  try {
    return await callOpenRouter(messages, maxTokens, temperature, options);
  } catch (openRouterError) {
    if (ollamaError) {
      throw new Error(`Primary+fallback failed. Ollama: ${ollamaError.message}. OpenRouter: ${openRouterError.message}`);
    }
    throw openRouterError;
  }
}

/**
 * Обёртка для translate endpoint
 */
async function translateText(text, options = {}) {
  const prompt = `Translate the following text into Russian. Return ONLY the translation, no explanations, no quotes:\n\n${text}`;
  return await callAiWithFallback([{ role: 'user', content: prompt }], 200, 0.5, options);
}

/**
 * Обёртка для hint endpoint
 */
async function generateHint(text, options = {}) {
  const prompt = `The user is learning a foreign language and doesn't know how to respond to this message:\n\n"${text}"\n\nWrite 2-3 short natural reply suggestions. CRITICAL RULES:\n- Use EXACTLY the same language, dialect, and style as the message above. If the message is in American English slang — reply in American English slang. If Arabic — reply in Arabic. If French — reply in French. Zero exceptions.\n- Never use Russian or any other language not present in the message.\n- Match the tone and register precisely (casual, formal, slang, etc.).\n- Keep each suggestion to one short sentence.\n- Format as a numbered list (1. 2. 3.). No explanations, no translations.`;
  return await callAiWithFallback([{ role: 'user', content: prompt }], 200, 0.5, options);
}

/**
 * Обёртка для chat endpoint
 */
async function chat(messages, systemPrompt, options = {}) {
  const openRouterMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  return await callAiWithFallback(openRouterMessages, 300, 0.85, options);
}

/**
 * Получить статистику использования ключей
 */
function getUsageStats() {
  return {
    priority: ['ollama', 'openrouter'],
    providers: {
      ollama: providers.ollama.keys.map((keyInfo) => ({
        key: keyInfo.key.substring(0, 8) + '...',
        usage: providers.ollama.keyDailyUsage.get(keyInfo.key) || 0,
        limit: keyInfo.freeLimit,
        remaining: keyInfo.freeLimit - (providers.ollama.keyDailyUsage.get(keyInfo.key) || 0),
      })),
      openrouter: providers.openrouter.keys.map((keyInfo) => ({
        key: keyInfo.key.substring(0, 8) + '...',
        usage: providers.openrouter.keyDailyUsage.get(keyInfo.key) || 0,
        limit: keyInfo.freeLimit,
        remaining: keyInfo.freeLimit - (providers.openrouter.keyDailyUsage.get(keyInfo.key) || 0),
      })),
    },
  };
}

/**
 * Получить информацию о используемой модели
 */
function getModelInfo() {
  return {
    primary: {
      provider: 'ollama',
      model: OLLAMA_MODEL,
      url: OLLAMA_CHAT_URL,
    },
    fallback: {
      provider: 'openrouter',
      model: OPENROUTER_MODEL,
      url: OPENROUTER_URL,
    },
  };
}

module.exports = {
  callOllama,
  callOpenRouter,
  callAiWithFallback,
  translateText,
  generateHint,
  chat,
  getUsageStats,
  resetDailyUsage,
  getModelInfo,
};
