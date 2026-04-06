const { prisma } = require('../../db/prisma');

/**
 * Предустановленные достижения
 */
const DEFAULT_ACHIEVEMENTS = [
  // Streak достижения
  { name: 'first_streak', title: 'Первый шаг', description: 'Тренируйтесь 1 день подряд', icon: '🔥', category: 'streak', threshold: 1, points: 10 },
  { name: 'week_warrior', title: 'Недельный воин', description: 'Тренируйтесь 7 дней подряд', icon: '🔥', category: 'streak', threshold: 7, points: 50 },
  { name: 'month_master', title: 'Месяц силы', description: 'Тренируйтесь 30 дней подряд', icon: '🏆', category: 'streak', threshold: 30, points: 200 },
  { name: 'streak_legend', title: 'Легенда streak', description: 'Тренируйтесь 100 дней подряд', icon: '👑', category: 'streak', threshold: 100, points: 500 },
  
  // Слова
  { name: 'first_word', title: 'Первое слово', description: 'Выучите первое слово', icon: '📚', category: 'words', threshold: 1, points: 10 },
  { name: 'word_explorer', title: 'Исследователь', description: 'Выучите 10 слов', icon: '📖', category: 'words', threshold: 10, points: 50 },
  { name: 'word_collector', title: 'Коллекционер', description: 'Выучите 50 слов', icon: '🎯', category: 'words', threshold: 50, points: 200 },
  { name: 'word_master', title: 'Мастер слов', description: 'Выучите 100 слов', icon: '🏅', category: 'words', threshold: 100, points: 500 },
  { name: 'word_legend', title: 'Легенда словаря', description: 'Выучите 500 слов', icon: '🌟', category: 'words', threshold: 500, points: 1000 },
  
  // Swipe режим
  { name: 'swipe_novice', title: 'Свайп новичок', description: 'Пройдите 10 свайп-карт', icon: '👆', category: 'swipe', threshold: 10, points: 20 },
  { name: 'swipe_master', title: 'Мастер свайпа', description: 'Пройдите 100 свайп-карт', icon: '🎮', category: 'swipe', threshold: 100, points: 100 },
  { name: 'swipe_legend', title: 'Легенда свайпа', description: 'Пройдите 500 свайп-карт', icon: '⚡', category: 'swipe', threshold: 500, points: 300 },
  
  // AI Chat
  { name: 'chat_beginner', title: 'Первый диалог', description: 'Отправьте первое сообщение AI', icon: '💬', category: 'chat', threshold: 1, points: 20 },
  { name: 'chat_enthusiast', title: 'Любитель поболтать', description: 'Отправьте 10 сообщений AI', icon: '🗣️', category: 'chat', threshold: 10, points: 100 },
  { name: 'chat_master', title: 'Мастер общения', description: 'Отправьте 50 сообщений AI', icon: '🎭', category: 'chat', threshold: 50, points: 300 },
];

/**
 * Инициализация достижений в БД
 */
const initializeAchievements = async () => {
  try {
    for (const achievement of DEFAULT_ACHIEVEMENTS) {
      await prisma.achievement.upsert({
        where: { name: achievement.name },
        update: achievement,
        create: achievement
      });
    }
    console.log('✅ Achievements initialized');
  } catch (error) {
    console.error('❌ Error initializing achievements:', error);
  }
};

/**
 * Получить все достижения с прогрессом пользователя
 */
const getUserAchievements = async (userId) => {
  const achievements = await prisma.achievement.findMany({
    where: { enabled: true },
    include: {
      userAchievements: {
        where: { userId },
        select: {
          progress: true,
          unlocked: true,
          unlockedAt: true
        }
      }
    },
    orderBy: [{ category: 'asc' }, { threshold: 'asc' }]
  });

  return achievements.map(a => ({
    id: a.id,
    name: a.name,
    title: a.title,
    description: a.description,
    icon: a.icon,
    category: a.category,
    threshold: a.threshold,
    points: a.points,
    progress: a.userAchievements[0]?.progress || 0,
    unlocked: a.userAchievements[0]?.unlocked || false,
    unlockedAt: a.userAchievements[0]?.unlockedAt
  }));
};

/**
 * Получить сводку по достижениям
 */
const getSummary = async (userId) => {
  const userAchievements = await prisma.userAchievement.findMany({
    where: { userId },
    include: {
      achievement: {
        select: {
          points: true,
          category: true
        }
      }
    }
  });

  const unlocked = userAchievements.filter(ua => ua.unlocked);
  const totalPoints = unlocked.reduce((sum, ua) => sum + ua.achievement.points, 0);
  
  // Прогресс по категориям
  const categories = ['streak', 'words', 'swipe', 'chat'];
  const categoryProgress = {};
  
  for (const category of categories) {
    const catAchievements = userAchievements.filter(ua => ua.achievement.category === category);
    const catUnlocked = catAchievements.filter(ua => ua.unlocked);
    categoryProgress[category] = {
      unlocked: catUnlocked.length,
      total: catAchievements.length,
      percentage: catAchievements.length > 0 
        ? Math.round((catUnlocked.length / catAchievements.length) * 100) 
        : 0
    };
  }

  return {
    total: userAchievements.length,
    unlocked: unlocked.length,
    totalPoints,
    categoryProgress
  };
};

/**
 * Проверить и обновить прогресс достижений
 */
const checkAndUpdate = async (userId, action, value) => {
  const categoryMap = {
    'word_learned': 'words',
    'swipe_completed': 'swipe',
    'chat_message': 'chat',
    'streak_day': 'streak'
  };

  const category = categoryMap[action];
  if (!category) return [];

  // Получаем достижения категории
  const achievements = await prisma.achievement.findMany({
    where: {
      category,
      enabled: true
    }
  });

  const unlockedNow = [];

  for (const achievement of achievements) {
    const userAchievement = await prisma.userAchievement.upsert({
      where: {
        userId_achievementId: {
          userId,
          achievementId: achievement.id
        }
      },
      update: {
        progress: { increment: value }
      },
      create: {
        userId,
        achievementId: achievement.id,
        progress: value,
        unlocked: false
      }
    });

    // Проверяем, не было ли уже разблокировано
    if (!userAchievement.unlocked && userAchievement.progress >= achievement.threshold) {
      await prisma.userAchievement.update({
        where: { id: userAchievement.id },
        data: {
          unlocked: true,
          unlockedAt: new Date()
        }
      });

      unlockedNow.push({
        id: achievement.id,
        name: achievement.name,
        title: achievement.title,
        description: achievement.description,
        icon: achievement.icon,
        points: achievement.points
      });
    }
  }

  return unlockedNow;
};

/**
 * Обновить прогресс достижения (установить конкретное значение)
 */
const updateProgress = async (userId, category, newValue) => {
  const achievements = await prisma.achievement.findMany({
    where: {
      category,
      enabled: true
    }
  });

  const unlockedNow = [];

  for (const achievement of achievements) {
    const userAchievement = await prisma.userAchievement.upsert({
      where: {
        userId_achievementId: {
          userId,
          achievementId: achievement.id
        }
      },
      update: {
        progress: newValue
      },
      create: {
        userId,
        achievementId: achievement.id,
        progress: newValue,
        unlocked: false
      }
    });

    if (!userAchievement.unlocked && userAchievement.progress >= achievement.threshold) {
      await prisma.userAchievement.update({
        where: { id: userAchievement.id },
        data: {
          unlocked: true,
          unlockedAt: new Date()
        }
      });

      unlockedNow.push({
        id: achievement.id,
        name: achievement.name,
        title: achievement.title,
        description: achievement.description,
        icon: achievement.icon,
        points: achievement.points
      });
    }
  }

  return unlockedNow;
};

module.exports = {
  initializeAchievements,
  getUserAchievements,
  getSummary,
  checkAndUpdate,
  updateProgress
};
