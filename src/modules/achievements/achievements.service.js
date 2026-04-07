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
 *
 * Оптимизировано: один $transaction вместо N+1 запросов.
 * Вместо цикла с upsert + update на каждую записъ —
 * собираем все операции и выполняем атомарно.
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

  // Получаем достижения категории (кешируется Prisma на уровне запросов)
  const achievements = await prisma.achievement.findMany({
    where: {
      category,
      enabled: true
    },
    select: { id: true, name: true, title: true, description: true, icon: true, threshold: true, points: true }
  });

  if (achievements.length === 0) return [];

  // Все операции выполняем в одной транзакции
  const unlockedNow = await prisma.$transaction(async (tx) => {
    const unlocked = [];

    // Получаем существующие записи пользователя одним запросом
    const existingRecords = await tx.userAchievement.findMany({
      where: {
        userId,
        achievementId: { in: achievements.map(a => a.id) }
      },
      select: { id: true, achievementId: true, progress: true, unlocked: true }
    });

    const existingMap = new Map();
    for (const record of existingRecords) {
      existingMap.set(record.achievementId, record);
    }

    const now = new Date();
    const createPromises = [];
    const updatePromises = [];

    for (const achievement of achievements) {
      const existing = existingMap.get(achievement.id);

      if (existing) {
        // Записъ существует — обновляем прогресс
        const newProgress = existing.progress + value;
        const shouldUnlock = !existing.unlocked && newProgress >= achievement.threshold;

        updatePromises.push(
          tx.userAchievement.update({
            where: { id: existing.id },
            data: {
              progress: newProgress,
              ...(shouldUnlock ? { unlocked: true, unlockedAt: now } : {})
            }
          })
        );

        if (shouldUnlock) {
          unlocked.push({
            id: achievement.id,
            name: achievement.name,
            title: achievement.title,
            description: achievement.description,
            icon: achievement.icon,
            points: achievement.points
          });
        }
      } else {
        // Записи нет — создаём
        const newProgress = value;
        const shouldUnlock = newProgress >= achievement.threshold;

        createPromises.push(
          tx.userAchievement.create({
            data: {
              userId,
              achievementId: achievement.id,
              progress: newProgress,
              unlocked: shouldUnlock,
              unlockedAt: shouldUnlock ? now : null
            }
          })
        );

        if (shouldUnlock) {
          unlocked.push({
            id: achievement.id,
            name: achievement.name,
            title: achievement.title,
            description: achievement.description,
            icon: achievement.icon,
            points: achievement.points
          });
        }
      }
    }

    // Выполняем все create параллельно
    if (createPromises.length > 0) {
      await Promise.all(createPromises);
    }

    // Выполняем все update параллельно
    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
    }

    return unlocked;
  });

  return unlockedNow;
};

/**
 * Обновить прогресс достижения (установить конкретное значение)
 *
 * Оптимизировано: один $transaction вместо N+1 запросов.
 */
const updateProgress = async (userId, category, newValue) => {
  const achievements = await prisma.achievement.findMany({
    where: {
      category,
      enabled: true
    },
    select: { id: true, name: true, title: true, description: true, icon: true, threshold: true, points: true }
  });

  if (achievements.length === 0) return [];

  const unlockedNow = await prisma.$transaction(async (tx) => {
    const unlocked = [];

    // Получаем существующие записи одним запросом
    const existingRecords = await tx.userAchievement.findMany({
      where: {
        userId,
        achievementId: { in: achievements.map(a => a.id) }
      },
      select: { id: true, achievementId: true, unlocked: true }
    });

    const existingMap = new Map();
    for (const record of existingRecords) {
      existingMap.set(record.achievementId, record);
    }

    const now = new Date();
    const createPromises = [];
    const updatePromises = [];

    for (const achievement of achievements) {
      const existing = existingMap.get(achievement.id);
      const shouldUnlock = newValue >= achievement.threshold;

      if (existing) {
        updatePromises.push(
          tx.userAchievement.update({
            where: { id: existing.id },
            data: {
              progress: newValue,
              ...(!existing.unlocked && shouldUnlock ? { unlocked: true, unlockedAt: now } : {})
            }
          })
        );

        if (!existing.unlocked && shouldUnlock) {
          unlocked.push({
            id: achievement.id,
            name: achievement.name,
            title: achievement.title,
            description: achievement.description,
            icon: achievement.icon,
            points: achievement.points
          });
        }
      } else {
        createPromises.push(
          tx.userAchievement.create({
            data: {
              userId,
              achievementId: achievement.id,
              progress: newValue,
              unlocked: shouldUnlock,
              unlockedAt: shouldUnlock ? now : null
            }
          })
        );

        if (shouldUnlock) {
          unlocked.push({
            id: achievement.id,
            name: achievement.name,
            title: achievement.title,
            description: achievement.description,
            icon: achievement.icon,
            points: achievement.points
          });
        }
      }
    }

    if (createPromises.length > 0) {
      await Promise.all(createPromises);
    }
    if (updatePromises.length > 0) {
      await Promise.all(updatePromises);
    }

    return unlocked;
  });

  return unlockedNow;
};

module.exports = {
  initializeAchievements,
  getUserAchievements,
  getSummary,
  checkAndUpdate,
  updateProgress
};
