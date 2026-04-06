/**
 * Telegram Bot Configuration
 */

const { env } = require('../../config/env');

module.exports = {
  // Включён ли бот
  isEnabled: () => env.telegramBotEnabled === 'true' && env.telegramBotToken && env.telegramAdminChatId,
  
  // Токен бота
  getToken: () => env.telegramBotToken,
  
  // Chat ID админа
  getAdminChatId: () => env.telegramAdminChatId,
  
  // Таймаут long-polling (секунды)
  POLLING_TIMEOUT: 30,
  
  // Максимум обработанных update_id в памяти
  MAX_PROCESSED_UPDATES: 200,
  
  // Интервал повторного подключения при ошибке (мс)
  RECONNECT_INTERVAL: 5000,
};
