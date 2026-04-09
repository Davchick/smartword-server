const { prisma } = require('../db/prisma');

/**
 * Удаляет непроверенные аккаунты старше 24 часов.
 * Запускается каждые 6 часов — каскадно удаляет refresh tokens,
 * password reset tokens, consent logs (Prisma onDelete: Cascade).
 */
const cleanupUnverifiedUsers = async () => {
  try {
    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Находим количество до удаления — для логов
    const count = await prisma.user.count({
      where: {
        emailVerified: false,
        createdAt: { lt: cutoffDate },
      },
    });

    if (count === 0) {
      console.log('[Cron] No unverified users to cleanup');
      return { deleted: 0 };
    }

    console.log(`[Cron] Cleaning up ${count} unverified user(s) older than 24h...`);

    // Удаляем батчем — Prisma каскадно удалит связанные записи
    const result = await prisma.user.deleteMany({
      where: {
        emailVerified: false,
        createdAt: { lt: cutoffDate },
      },
    });

    console.log(`[Cron] Deleted ${result.count} unverified user(s)`);
    return { deleted: result.count };
  } catch (error) {
    console.error('[Cron] Error in cleanup unverified users:', error);
    throw error;
  }
};

module.exports = {
  cleanupUnverifiedUsers,
};
