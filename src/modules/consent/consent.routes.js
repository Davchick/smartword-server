const express = require('express');
const { authMiddleware } = require('../../middleware/auth');
const {
  logConsent,
  getUserConsents,
  withdrawConsent,
  hasValidConsent,
} = require('./consent.service');

const router = express.Router();

/**
 * POST /consent/registration
 * Зафиксировать согласие при регистрации
 * Body: { email }
 */
router.post('/registration', async (req, res) => {
  try {
    const { email } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const consent = await logConsent({
      email,
      ipAddress,
      userAgent,
      consentType: 'registration',
    });

    res.json({
      message: 'Consent logged',
      consent: {
        id: consent.id,
        policyVersion: consent.policyVersion,
        createdAt: consent.createdAt,
      },
    });
  } catch (error) {
    console.error('[Consent] Error logging registration consent:', error);
    res.status(500).json({ error: 'Failed to log consent' });
  }
});

/**
 * POST /consent/ai-chat
 * Зафиксировать согласие на использование AI-чата
 * Требуется отдельное согласие для трансграничной передачи
 */
router.post('/ai-chat', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Проверяем, есть ли уже действительное согласие
    const hasConsent = await hasValidConsent({ userId, consentType: 'ai_chat' });
    if (hasConsent) {
      return res.json({ message: 'Consent already granted', alreadyGranted: true });
    }

    const consent = await logConsent({
      userId,
      ipAddress,
      userAgent,
      consentType: 'ai_chat',
    });

    res.json({
      message: 'AI chat consent logged',
      consent: {
        id: consent.id,
        policyVersion: consent.policyVersion,
        createdAt: consent.createdAt,
      },
    });
  } catch (error) {
    console.error('[Consent] Error logging AI chat consent:', error);
    res.status(500).json({ error: 'Failed to log consent' });
  }
});

/**
 * GET /consent/my
 * Получить все согласия текущего пользователя
 */
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const consents = await getUserConsents(userId);

    res.json({
      consents: consents.map(c => ({
        id: c.id,
        consentType: c.consentType,
        policyVersion: c.policyVersion,
        granted: c.granted,
        createdAt: c.createdAt,
        withdrawnAt: c.withdrawnAt,
      })),
    });
  } catch (error) {
    console.error('[Consent] Error getting consents:', error);
    res.status(500).json({ error: 'Failed to get consents' });
  }
});

/**
 * POST /consent/withdraw
 * Отозвать согласие (полностью или для конкретного типа)
 * Body: { consentType? } - если не указан, отзываются все
 */
router.post('/withdraw', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { consentType } = req.body || {};

    const count = await withdrawConsent({ userId, consentType });

    res.json({
      message: `Withdrawn ${count} consent(s)`,
      withdrawnCount: count,
    });
  } catch (error) {
    console.error('[Consent] Error withdrawing consent:', error);
    res.status(500).json({ error: 'Failed to withdraw consent' });
  }
});

/**
 * GET /consent/check/:type
 * Проверить наличие действительного согласия
 */
router.get('/check/:type', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { type } = req.params;

    const hasConsent = await hasValidConsent({ userId, consentType: type });

    res.json({
      hasConsent,
      consentType: type,
    });
  } catch (error) {
    console.error('[Consent] Error checking consent:', error);
    res.status(500).json({ error: 'Failed to check consent' });
  }
});

module.exports = router;
