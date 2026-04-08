const { prisma } = require('../db/prisma');
const streaksService = require('../modules/streaks/streaks.service');
const achievementsService = require('../modules/achievements/achievements.service');

/**
 * Ежедневная задача для проверки и сброса streaks
 * Запускается в 3:00 AM каждый день
 */
const dailyStreakCheck = async () => {
  try {
    console.log('[Cron] Running daily streak check...');

    const result = await streaksService.checkAllStreaks();

    console.log(`[Cron] Daily streak check completed. Lost streaks: ${result.checked}`);

    return result;
  } catch (error) {
    console.error('[Cron] Error in daily streak check:', error);
    throw error;
  }
};

/**
 * Задача для синхронизации прогресса достижений.
 * Оптимизировано: используем агрегации вместо цикла по каждому пользователю.
 * Вместо O(N) запросов делаем O(1) запросов на категорию достижений.
 */
const syncAchievementsProgress = async (prisma) => {
  try {
    console.log('[Cron] Syncing achievements progress (batched)...');

    // 1. Батчевый запрос: считаем выученные слова для ВСЕХ пользователей одним запросом
    const learnedWordsByUser = await prisma.word.groupBy({
      by: ['userId'],
      where: { correctCount: { gte: 5 } },
      _count: { id: true },
    });

    // 2. Батчевый запрос: training progress для ВСЕХ пользователей
    const trainingByUser = await prisma.trainingProgress.groupBy({
      by: ['userId'],
      _sum: { points: true },
    });

    const wordsMap = new Map();
    for (const entry of learnedWordsByUser) {
      wordsMap.set(entry.userId, entry._count.id);
    }

    const trainingMap = new Map();
    for (const entry of trainingByUser) {
      trainingMap.set(entry.userId, entry._sum.points || 0);
    }

    // Обновляем достижения только для пользователей с активностью
    const userIds = new Set([...wordsMap.keys(), ...trainingMap.keys()]);
    let updatedCount = 0;

    for (const userId of userIds) {
      const learnedWords = wordsMap.get(userId) || 0;
      const totalTraining = trainingMap.get(userId) || 0;

      if (learnedWords > 0) {
        await achievementsService.updateProgress(userId, 'words', learnedWords);
        updatedCount++;
      }
      if (totalTraining > 0) {
        await achievementsService.updateProgress(userId, 'swipe', totalTraining);
        updatedCount++;
      }
    }

    console.log(`[Cron] Achievements sync completed. Users processed: ${userIds.size}, updates: ${updatedCount}`);
  } catch (error) {
    console.error('[Cron] Error in achievements sync:', error);
    throw error;
  }
};

module.exports = {
  dailyStreakCheck,
  syncAchievementsProgress
};
