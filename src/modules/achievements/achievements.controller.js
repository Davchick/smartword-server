const { prisma } = require('../../db/prisma');
const achievementsService = require('./achievements.service');

/**
 * Get all achievements with user progress
 */
const getUserAchievements = async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    const achievements = await achievementsService.getUserAchievements(userId);
    
    res.json({
      success: true,
      data: achievements
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get achievements summary
 */
const getAchievementsSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    const summary = await achievementsService.getSummary(userId);
    
    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Check and update achievements progress
 */
const checkAchievements = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { action, value } = req.body;
    
    const newAchievements = await achievementsService.checkAndUpdate(userId, action, value);
    
    res.json({
      success: true,
      data: {
        unlocked: newAchievements
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUserAchievements,
  getAchievementsSummary,
  checkAchievements
};
