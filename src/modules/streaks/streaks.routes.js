const express = require('express');
const router = express.Router();
const { authMiddleware: auth } = require('../../middleware/auth');
const streaksController = require('./streaks.controller');

/**
 * @route   GET /api/streaks
 * @desc    Get current user streak
 * @access  Private
 */
router.get('/', auth, streaksController.getUserStreak);

/**
 * @route   POST /api/streaks/check-in
 * @desc    Check-in for today (mark activity)
 * @access  Private
 */
router.post('/check-in', auth, streaksController.checkIn);

/**
 * @route   GET /api/streaks/history
 * @desc    Get streak history (last 30 days)
 * @access  Private
 */
router.get('/history', auth, streaksController.getStreakHistory);

/**
 * @route   GET /api/streaks/summary
 * @desc    Get current streak + history в одном запросе (оптимизация)
 * @access  Private
 */
router.get('/summary', auth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const streaksService = require('./streaks.service');

    const [streak, history] = await Promise.all([
      streaksService.getUserStreak(userId),
      streaksService.getHistory(userId),
    ]);

    res.json({
      success: true,
      data: { streak, history },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
