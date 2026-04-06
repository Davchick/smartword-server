const express = require('express');
const { randomUUID } = require('crypto');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const { env } = require('../../config/env');

const router = express.Router();

const YOOKASSA_API_URL = 'https://api.yookassa.ru/v3/payments';

const PLANS = {
  month: {
    amount: 299,
    durationDays: 30,
    description: 'Подписка SmartWord на месяц',
  },
  half_year: {
    amount: 1699,
    durationDays: 182,
    description: 'Подписка SmartWord на полгода',
  },
  year: {
    amount: 3169,
    durationDays: 365,
    description: 'Подписка SmartWord на год',
  },
};

// Варианты способов оплаты на фронте — на бэкенде пока не навязываем тип,
// чтобы не ломать сценарии, если что-то изменится на стороне ЮKassa.
const ALLOWED_METHODS = new Set(['card', 'sbp', 'sberpay', 'tpay']);

function getAuthHeader() {
  if (!env.yookassaShopId || !env.yookassaSecretKey) {
    throw new Error('YOOKASSA_SHOP_ID or YOOKASSA_SECRET_KEY is not configured');
  }
  const credentials = Buffer.from(`${env.yookassaShopId}:${env.yookassaSecretKey}`).toString(
    'base64',
  );
  return `Basic ${credentials}`;
}

/**
 * POST /billing/create-payment
 * Body: { planId: 'month' | 'half_year' | 'year', method: 'card' | 'sbp' | 'sberpay' | 'tpay' }
 * Returns: { payment_id, status, confirmation_url }
 */
router.post('/create-payment', authMiddleware, async (req, res) => {
  try {
    const { planId, method } = req.body || {};

    if (!planId || typeof planId !== 'string' || !PLANS[planId]) {
      return res.status(400).json({ error: 'invalid_plan', message: 'Некорректный тариф' });
    }

    if (!method || typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
      return res.status(400).json({ error: 'invalid_method', message: 'Некорректный способ оплаты' });
    }

    const plan = PLANS[planId];

    const idempotenceKey = randomUUID();

    const body = {
      amount: {
        value: plan.amount.toFixed(2),
        currency: 'RUB',
      },
      capture: true,
      description: plan.description,
      confirmation: {
        type: 'redirect',
        return_url: env.yookassaReturnUrl,
      },
      metadata: {
        userId: req.user.id,
        planId,
        durationDays: plan.durationDays,
        method,
      },
    };

    const response = await fetch(YOOKASSA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getAuthHeader(),
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.error('[billing/create-payment] YooKassa error', response.status, data);
      return res.status(502).json({ error: 'yookassa_error' });
    }

    const confirmationUrl = data?.confirmation?.confirmation_url;

    return res.status(201).json({
      payment_id: data.id,
      status: data.status,
      confirmation_url: confirmationUrl || null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[billing/create-payment]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /billing/webhook
 * Webhook от ЮKassa. Обрабатываем только payment.succeeded.
 */
router.post('/webhook', express.json({ type: 'application/json' }), async (req, res) => {
  try {
    const event = req.body?.event;
    const object = req.body?.object;

    if (!event || !object) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    if (event !== 'payment.succeeded') {
      return res.status(200).json({ ok: true });
    }

    const metadata = object.metadata || {};
    const userId = metadata.userId;
    const planId = metadata.planId;
    const durationDays = Number(metadata.durationDays) || 0;

    if (!userId || !planId || !durationDays || !PLANS[planId]) {
      // eslint-disable-next-line no-console
      console.error('[billing/webhook] Missing metadata in payment.succeeded', metadata);
      return res.status(200).json({ ok: true });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        subscriptionType: true,
        subscriptionExpiresAt: true,
      },
    });

    if (!user) {
      return res.status(200).json({ ok: true });
    }

    const now = new Date();
    const baseDate =
      user.subscriptionExpiresAt && user.subscriptionExpiresAt.getTime() > now.getTime()
        ? user.subscriptionExpiresAt
        : now;

    const msToAdd = durationDays * 24 * 60 * 60 * 1000;
    const newExpiresAt = new Date(baseDate.getTime() + msToAdd);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionType: planId,
        subscriptionExpiresAt: newExpiresAt,
        isPremium: true,
      },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[billing/webhook]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /billing/subscription
 * Возвращает тип и дату окончания подписки текущего пользователя.
 */
router.get('/subscription', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        subscriptionType: true,
        subscriptionExpiresAt: true,
        isPremium: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const now = new Date();
    const hasActiveSubscription =
      !!user.subscriptionExpiresAt && user.subscriptionExpiresAt.getTime() > now.getTime();

    res.json({
      subscription_type: user.subscriptionType || null,
      subscription_expires_at: user.subscriptionExpiresAt
        ? user.subscriptionExpiresAt.toISOString()
        : null,
      is_premium: user.isPremium || hasActiveSubscription,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[billing/subscription]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

