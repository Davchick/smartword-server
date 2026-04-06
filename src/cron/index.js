const cron = require('node-cron');
const { dailyStreakCheck, syncAchievementsProgress } = require('./streaks.cron');
const { prisma } = require('../db/prisma');

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

  // Синхронизация достижений каждый час
  cron.schedule('0 * * * *', async () => {
    await syncAchievementsProgress(prisma);
  }, {
    timezone: 'Europe/Moscow'
  });

  console.log('✅ Cron jobs initialized');
};

module.exports = {
  initCronJobs
};
