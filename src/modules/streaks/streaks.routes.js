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

module.exports = router;
