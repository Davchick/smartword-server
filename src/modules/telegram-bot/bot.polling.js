const telegram = require('./bot.service');
const config = require('./bot.config');
const { handleUpdate } = require('./bot.handlers');
const db = require('./ticket.db');

let lastUpdateId = 0;
let isRunning = false;

/**
 * Запуск long-polling
 */
async function startPolling() {
  if (isRunning) {
    console.log('[Telegram Bot] Polling already running');
    return;
  }

  if (!config.isEnabled()) {
    console.log('[Telegram Bot] Not configured, skipping polling');
    return;
  }

  isRunning = true;
  console.log('[Telegram Bot] Starting long-polling...');

  // Инициализация БД
  db.init();

  // Получаем последнее update_id
  try {
    const initialUpdates = await telegram.getUpdates(0, 1);
    if (initialUpdates.length > 0) {
      lastUpdateId = initialUpdates[initialUpdates.length - 1].update_id + 1;
      console.log('[Telegram Bot] Starting from update_id:', lastUpdateId);
    }
  } catch (err) {
    // Если конфликт - другой бот уже запущен, останавливаемся
    if (err.message === 'TELEGRAM_CONFLICT') {
      console.error('[Telegram Bot] Another bot instance is already running. Stopping.');
      stopPolling();
      return;
    }
    console.error('[Telegram Bot] Error getting initial updates:', err);
  }

  // Основной цикл
  while (isRunning) {
    try {
      const updates = await telegram.getUpdates(lastUpdateId, config.POLLING_TIMEOUT);

      for (const update of updates) {
        await handleUpdate(update);
      }

      // Обновляем lastUpdateId
      if (updates.length > 0) {
        lastUpdateId = updates[updates.length - 1].update_id + 1;
      }
    } catch (err) {
      // Если конфликт (409) - останавливаем polling
      if (err.message === 'TELEGRAM_CONFLICT') {
        console.error('[Telegram Bot] Stopping polling due to conflict (another bot instance running)');
        stopPolling();
        break;
      }
      console.error('[Telegram Bot] Polling error:', err);
      await new Promise((resolve) => setTimeout(resolve, config.RECONNECT_INTERVAL));
    }
  }
}

/**
 * Остановка polling
 */
function stopPolling() {
  isRunning = false;
  console.log('[Telegram Bot] Stopping long-polling...');
}

module.exports = {
  startPolling,
  stopPolling,
};
