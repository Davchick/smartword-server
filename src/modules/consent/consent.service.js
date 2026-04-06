const { prisma } = require('../../db/prisma');

/**
 * Журнал учёта согласий на обработку персональных данных
 * Требуется по 152-ФЗ (ст. 9) и рекомендациям Роскомнадзора 2025-2026
 * 
 * Фиксирует:
 * - Дату и время согласия
 * - Версию политики
 * - IP-адрес и User-Agent
 * - Тип согласия
 */

const POLICY_VERSION = '1.0'; // Версия Политики конфиденциальности

/**
 * Зафиксировать согласие на обработку ПДн
 * @param {Object} params
 * @param {string|null} params.userId - ID пользователя (если есть)
 * @param {string|null} params.email - Email пользователя
 * @param {string} params.ipAddress - IP-адрес
 * @param {string} params.userAgent - User-Agent
 * @param {string} params.consentType - Тип согласия: 'registration', 'ai_chat', 'marketing'
 * @param {string} [params.policyVersion] - Версия политики (по умолчанию POLICY_VERSION)
 * @returns {Promise<Object>} Запись согласия
 */
async function logConsent({ userId, email, ipAddress, userAgent, consentType, policyVersion = POLICY_VERSION }) {
  try {
    const consent = await prisma.consentLog.create({
      data: {
        userId: userId || null,
        email: email || null,
        ipAddress,
        userAgent,
        policyVersion: policyVersion || POLICY_VERSION,
        consentType,
        granted: true,
      },
    });

    console.log(`[Consent] Logged ${consentType} consent for ${email || userId} (v${policyVersion})`);
    return consent;
  } catch (error) {
    console.error('[Consent] Error logging consent:', error.message);
    throw error;
  }
}

/**
 * Зафиксировать отзыв согласия на обработку ПДн
 * @param {Object} params
 * @param {string} params.userId - ID пользователя
 * @param {string} [params.consentType] - Тип согласия (если не указан, отзываются все)
 * @returns {Promise<number>} Количество отозванных согласий
 */
async function withdrawConsent({ userId, consentType }) {
  try {
    const where = {
      userId,
      granted: true,
    };

    if (consentType) {
      where.consentType = consentType;
    }

    const result = await prisma.consentLog.updateMany({
      where,
      data: {
        withdrawnAt: new Date(),
        granted: false,
      },
    });

    console.log(`[Consent] Withdrawn ${result.count} consent(s) for user ${userId}`);
    return result.count;
  } catch (error) {
    console.error('[Consent] Error withdrawing consent:', error.message);
    throw error;
  }
}

/**
 * Получить все согласия пользователя
 * @param {string} userId - ID пользователя
 * @returns {Promise<Array>} Список согласий
 */
async function getUserConsents(userId) {
  try {
    const consents = await prisma.consentLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return consents;
  } catch (error) {
    console.error('[Consent] Error getting user consents:', error.message);
    return [];
  }
}

/**
 * Проверить, есть ли действительное согласие пользователя
 * @param {Object} params
 * @param {string} params.userId - ID пользователя
 * @param {string} [params.consentType] - Тип согласия (если не указан, проверяется любой)
 * @returns {Promise<boolean>} true = согласие есть
 */
async function hasValidConsent({ userId, consentType }) {
  try {
    const where = {
      userId,
      granted: true,
      withdrawnAt: null,
    };

    if (consentType) {
      where.consentType = consentType;
    }

    const count = await prisma.consentLog.count({ where });
    return count > 0;
  } catch (error) {
    console.error('[Consent] Error checking consent:', error.message);
    return false;
  }
}

/**
 * Получить статистику согласий (для админки)
 * @returns {Promise<Object>} Статистика
 */
async function getConsentStats() {
  try {
    const total = await prisma.consentLog.count();
    const active = await prisma.consentLog.count({ where: { granted: true, withdrawnAt: null } });
    const withdrawn = await prisma.consentLog.count({ where: { granted: false } });

    // По типам
    const byType = await prisma.consentLog.groupBy({
      by: ['consentType'],
      _count: true,
    });

    return {
      total,
      active,
      withdrawn,
      byType: byType.reduce((acc, item) => {
        acc[item.consentType] = item._count;
        return acc;
      }, {}),
    };
  } catch (error) {
    console.error('[Consent] Error getting stats:', error.message);
    return { total: 0, active: 0, withdrawn: 0, byType: {} };
  }
}

module.exports = {
  logConsent,
  withdrawConsent,
  getUserConsents,
  hasValidConsent,
  getConsentStats,
  POLICY_VERSION,
};
