/**
 * Telegram Bot Module
 * 
 * Модуль поддержки пользователей через Telegram.
 * 
 * СТАТУС: 🥶 ЗАМОРОЖЕН (отключен до востребования)
 * 
 * Для включения:
 * 1. Установите TELEGRAM_BOT_ENABLED=true в .env
 * 2. Настройте TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_CHAT_ID
 * 3. Перезапустите сервер
 */

const { env } = require('../../config/env');

// Проверяем, включен ли бот
const isEnabled = env.telegramBotEnabled === 'true' && env.telegramBotToken && env.telegramAdminChatId;

if (isEnabled) {
  console.log('[Telegram Bot] Module enabled');
  const { startPolling } = require('./bot.polling');
  startPolling();
} else {
  console.log('[Telegram Bot] Module disabled (frozen). Set TELEGRAM_BOT_ENABLED=true to enable.');
}

module.exports = {
  isEnabled,
};
