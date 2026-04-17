const streaksService = require('../modules/streaks/streaks.service');

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

module.exports = {
  dailyStreakCheck
};
