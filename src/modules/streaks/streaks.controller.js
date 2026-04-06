const { prisma } = require('../../db/prisma');
const streaksService = require('./streaks.service');

/**
 * Get current user streak
 */
const getUserStreak = async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    const streak = await streaksService.getUserStreak(userId);
    
    res.json({
      success: true,
      data: streak
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Check-in for today
 */
const checkIn = async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    const result = await streaksService.checkIn(userId);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get streak history
 */
const getStreakHistory = async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    const history = await streaksService.getHistory(userId);
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUserStreak,
  checkIn,
  getStreakHistory
};
