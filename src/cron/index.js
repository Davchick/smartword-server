const cron = require('node-cron');
const { dailyStreakCheck } = require('./streaks.cron');
const { cleanupUnverifiedUsers } = require('./cleanup.cron');

/**
 * Инициализация cron задач
 */
const initCronJobs = () => {
  console.log('🕐 Initializing cron jobs...');

  // Ежедневная проверка streaks в 3:00 AM
  cron.schedule('0 3 * * *', async () => {
    await dailyStreakCheck();
  }, {
    timezone: 'Europe/Moscow'
  });

  // Удаление непроверенных аккаунтов каждые 6 часов (в 00:00, 06:00, 12:00, 18:00 МСК)
  cron.schedule('0 */6 * * *', async () => {
    await cleanupUnverifiedUsers();
  }, {
    timezone: 'Europe/Moscow'
  });

  console.log('✅ Cron jobs initialized');
};

module.exports = {
  initCronJobs
};
