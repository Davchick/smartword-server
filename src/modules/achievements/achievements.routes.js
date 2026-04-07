const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../../middleware/auth');
const achievementsController = require('./achievements.controller');

/**
 * @route   GET /api/achievements
 * @desc    Get all achievements with user progress
 * @access  Private
 */
router.get('/', auth, achievementsController.getUserAchievements);

/**
 * @route   GET /api/achievements/summary
 * @desc    Get achievements summary (total, unlocked count, points)
 * @access  Private
 */
router.get('/summary', auth, achievementsController.getAchievementsSummary);

/**
 * @route   GET /api/achievements/all
 * @desc    Get achievements + summary в одном запросе (оптимизация)
 * @access  Private
 */
router.get('/all', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const achievementsService = require('./achievements.service');

    const [achievements, summary] = await Promise.all([
      achievementsService.getUserAchievements(userId),
      achievementsService.getSummary(userId),
    ]);

    res.json({
      success: true,
      data: { achievements, summary },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/achievements/check
 * @desc    Check and update achievements progress (triggered by actions)
 * @access  Private
 */
router.post('/check', auth, achievementsController.checkAchievements);

module.exports = router;
