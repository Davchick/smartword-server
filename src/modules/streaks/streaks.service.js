const { prisma } = require('../../db/prisma');

/**
 * Получить текущий streak пользователя
 */
const getUserStreak = async (userId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  let userStreak = await prisma.userStreak.findUnique({
    where: { userId }
  });

  if (!userStreak) {
    // Создаём новый streak
    userStreak = await prisma.userStreak.create({
      data: {
        userId,
        currentStreak: 0,
        longestStreak: 0,
        lastActivity: today,
        totalActivity: 0
      }
    });
  }

  // Проверяем, не истёк ли streak
  const lastActivity = new Date(userStreak.lastActivity);
  const daysDiff = Math.floor((today - lastActivity) / (1000 * 60 * 60 * 24));

  let isStreakActive = true;
  let isStreakLost = false;

  if (daysDiff > 1) {
    // Streak потерян (пропущен день)
    isStreakActive = false;
    isStreakLost = true;
    // Обновляем, сбрасывая current streak
    userStreak = await prisma.userStreak.update({
      where: { userId },
      data: {
        currentStreak: 0,
        lastActivity: today
      }
    });
  } else if (daysDiff === 1) {
    // Вчера была активность - streak активен
    isStreakActive = true;
  } else if (daysDiff === 0) {
    // Сегодня уже была активность
    isStreakActive = true;
  }

  return {
    currentStreak: userStreak.currentStreak,
    longestStreak: userStreak.longestStreak,
    totalActivity: userStreak.totalActivity,
    lastActivity: userStreak.lastActivity,
    isStreakActive,
    isStreakLost,
    checkedInToday: daysDiff === 0
  };
};

/**
 * Отметить активность сегодня (check-in)
 */
const checkIn = async (userId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  let userStreak = await prisma.userStreak.findUnique({
    where: { userId }
  });

  if (!userStreak) {
    // Первый check-in
    userStreak = await prisma.userStreak.create({
      data: {
        userId,
        currentStreak: 1,
        longestStreak: 1,
        lastActivity: today,
        totalActivity: 1
      }
    });

    return {
      currentStreak: 1,
      longestStreak: 1,
      totalActivity: 1,
      isNewStreak: true,
      isStreakContinued: false
    };
  }

  const lastActivity = new Date(userStreak.lastActivity);
  const daysDiff = Math.floor((today - lastActivity) / (1000 * 60 * 60 * 24));

  if (daysDiff === 0) {
    // Уже отмечен сегодня
    return {
      currentStreak: userStreak.currentStreak,
      longestStreak: userStreak.longestStreak,
      totalActivity: userStreak.totalActivity,
      isNewStreak: false,
      isStreakContinued: false,
      alreadyCheckedIn: true
    };
  }

  if (daysDiff > 1) {
    // Streak потерян, начинаем заново
    userStreak = await prisma.userStreak.update({
      where: { userId },
      data: {
        currentStreak: 1,
        longestStreak: Math.max(userStreak.longestStreak, userStreak.currentStreak),
        lastActivity: today,
        totalActivity: { increment: 1 }
      }
    });

    return {
      currentStreak: 1,
      longestStreak: userStreak.longestStreak,
      totalActivity: userStreak.totalActivity,
      isNewStreak: true,
      isStreakContinued: false,
      streakLost: true
    };
  }

  // Продолжаем streak (daysDiff === 1)
  const newCurrentStreak = userStreak.currentStreak + 1;
  userStreak = await prisma.userStreak.update({
    where: { userId },
    data: {
      currentStreak: newCurrentStreak,
      longestStreak: Math.max(userStreak.longestStreak, newCurrentStreak),
      lastActivity: today,
      totalActivity: { increment: 1 }
    }
  });

  return {
    currentStreak: newCurrentStreak,
    longestStreak: userStreak.longestStreak,
    totalActivity: userStreak.totalActivity,
    isNewStreak: false,
    isStreakContinued: true
  };
};

/**
 * Получить историю активности (последние 30 дней)
 */
const getHistory = async (userId) => {
  const today = new Date();
  const history = [];
  
  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    
    history.push({
      date: date.toISOString().split('T')[0],
      active: false
    });
  }
  
  // Получаем training progress за последние 30 дней
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const trainingDays = await prisma.trainingProgress.findMany({
    where: {
      userId,
      date: {
        gte: thirtyDaysAgo
      }
    },
    select: {
      date: true,
      points: true
    }
  });

  // Отмечаем активные дни
  const activeDates = trainingDays.map(t => t.date.toISOString().split('T')[0]);
  history.forEach(day => {
    if (activeDates.includes(day.date)) {
      day.active = true;
    }
  });

  return history;
};

/**
 * Автоматическая проверка и сброс streaks (для cron)
 */
const checkAllStreaks = async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const twoDaysAgo = new Date(today);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  
  // Находим пользователей, у которых lastActivity больше 2 дней назад
  const lostStreaks = await prisma.userStreak.findMany({
    where: {
      lastActivity: {
        lt: twoDaysAgo
      },
      currentStreak: {
        gt: 0
      }
    }
  });

  // Сбрасываем их streaks
  for (const streak of lostStreaks) {
    await prisma.userStreak.update({
      where: { userId: streak.userId },
      data: {
        currentStreak: 0,
        longestStreak: Math.max(streak.longestStreak, streak.currentStreak)
      }
    });
  }

  return {
    checked: lostStreaks.length,
    date: new Date()
  };
};

module.exports = {
  getUserStreak,
  checkIn,
  getHistory,
  checkAllStreaks
};
