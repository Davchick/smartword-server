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
 * Задача для синхронизации прогресса достижений
 * Проверяет слова и training progress
 */
const syncAchievementsProgress = async (prisma) => {
  try {
    console.log('[Cron] Syncing achievements progress...');
    
    // Получаем всех пользователей
    const users = await prisma.user.findMany({
      select: { id: true }
    });
    
    for (const user of users) {
      // Синхронизируем слова
      const learnedWords = await prisma.word.count({
        where: {
          userId: user.id,
          correctCount: { gte: 5 }
        }
      });
      
      await achievementsService.updateProgress(user.id, 'words', learnedWords);
      
      // Синхронизируем swipe (по training progress)
      const totalTraining = await prisma.trainingProgress.aggregate({
        where: { userId: user.id },
        _sum: { points: true }
      });
      
      if (totalTraining._sum) {
        await achievementsService.updateProgress(user.id, 'swipe', totalTraining._sum.points || 0);
      }
    }
    
    console.log(`[Cron] Achievements sync completed. Users processed: ${users.length}`);
  } catch (error) {
    console.error('[Cron] Error in achievements sync:', error);
    throw error;
  }
};

module.exports = {
  dailyStreakCheck,
  syncAchievementsProgress
};
