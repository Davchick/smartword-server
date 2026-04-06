const config = require('./bot.config');

const TELEGRAM_API = 'https://api.telegram.org/bot';

/**
 * Отправить сообщение пользователю
 */
async function sendMessage(chatId, text, options = {}) {
  const { replyToMessageId, parseMode = 'HTML' } = options;
  
  const url = `${TELEGRAM_API}${config.getToken()}/sendMessage`;

  const body = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
  };

  if (replyToMessageId) {
    body.reply_to_message_id = replyToMessageId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[Telegram] Error sending message:', data);
    throw new Error('Failed to send Telegram message');
  }

  return data;
}

/**
 * Отправить сообщение с inline кнопками
 */
async function sendInline(chatId, text, inlineKeyboard) {
  const url = `${TELEGRAM_API}${config.getToken()}/sendMessage`;

  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: JSON.stringify(inlineKeyboard),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[Telegram] Error sending inline message:', data);
    throw new Error('Failed to send Telegram inline message');
  }

  return data;
}

/**
 * Получить последние обновления (long-polling)
 */
async function getUpdates(offset = 0, timeout = config.POLLING_TIMEOUT) {
  const url = `${TELEGRAM_API}${config.getToken()}/getUpdates`;

  const params = new URLSearchParams({
    offset: offset.toString(),
    timeout: timeout.toString(),
    allowed_updates: JSON.stringify(['message', 'callback_query']),
  });

  const response = await fetch(`${url}?${params}`);
  const data = await response.json();

  if (!response.ok) {
    // Ошибка 409 - конфликт, значит бот уже запущен в другом месте
    if (data.error_code === 409) {
      console.error('[Telegram] Conflict: another bot instance is running. Stopping polling.');
      throw new Error('TELEGRAM_CONFLICT');
    }
    console.error('[Telegram] Error getting updates:', data);
    return [];
  }

  return data.result || [];
}

/**
 * Ответ на callback query
 */
async function answerCallbackQuery(callbackQueryId) {
  const url = `${TELEGRAM_API}${config.getToken()}/answerCallbackQuery`;

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

/**
 * Редактировать сообщение
 */
async function editMessage(chatId, messageId, text, replyMarkup = {}) {
  const url = `${TELEGRAM_API}${config.getToken()}/editMessageText`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      }),
    });
  } catch (err) {
    // Игнорируем ошибки редактирования (сообщение могло не измениться)
  }
}

module.exports = {
  sendMessage,
  sendInline,
  getUpdates,
  answerCallbackQuery,
  editMessage,
};
