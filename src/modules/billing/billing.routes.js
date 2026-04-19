const express = require('express');
const { randomUUID } = require('crypto');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const { env } = require('../../config/env');
const { paymentLimiter } = require('../../middleware/rateLimiter');

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
router.post('/create-payment', paymentLimiter, authMiddleware, async (req, res) => {
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
        return_url: `${env.yookassaReturnUrl}#/payment/success`,
      },
      metadata: {
        userId: req.user.id,
        planId,
        durationDays: plan.durationDays,
        method,
      },
    };

    // 15-секундный таймаут для YooKassa — не держим соединение при медленном ответе
    const yooKassaController = new AbortController();
    const yooKassaTimeout = setTimeout(() => yooKassaController.abort(), 15000);

    const response = await fetch(YOOKASSA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getAuthHeader(),
        'Idempotence-Key': idempotenceKey,
      },
      body: JSON.stringify(body),
      signal: yooKassaController.signal,
    });

    clearTimeout(yooKassaTimeout);

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.error('[billing/create-payment] YooKassa error', response.status, data?.error);
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
 * Верификация: проверяем Basic Auth (shopId:secretKey) — YooKassa отправляет
 * его в Authorization заголовке при отправке webhook.
 */
router.post('/webhook', express.json({ type: 'application/json' }), async (req, res) => {
  try {
    // 1. Верификация Basic Auth от YooKassa
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      console.warn('[billing/webhook] Missing Basic Auth header');
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const [shopId, secretKey] = credentials.split(':');

      if (!shopId || !secretKey) {
        console.warn('[billing/webhook] Invalid Basic Auth format');
        return res.status(401).json({ error: 'unauthorized' });
      }

      const expectedShopId = env.yookassaShopId;
      const expectedSecretKey = env.yookassaSecretKey;

      if (!expectedShopId || !expectedSecretKey) {
        console.error('[billing/webhook] YooKassa credentials not configured');
        return res.status(503).json({ error: 'service_unavailable' });
      }

      if (shopId !== expectedShopId || secretKey !== expectedSecretKey) {
        console.warn('[billing/webhook] Invalid Basic Auth credentials');
        return res.status(401).json({ error: 'unauthorized' });
      }
    } catch (err) {
      console.warn('[billing/webhook] Failed to parse Basic Auth:', err.message);
      return res.status(401).json({ error: 'unauthorized' });
    }

    // 2. Проверка payload
    const event = req.body?.event;
    const object = req.body?.object;

    if (!event || !object) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    if (event !== 'payment.succeeded') {
      return res.status(200).json({ ok: true });
    }

    // 3. Дополнительно: проверяем, что paymentId есть и это объект платежа
    const paymentId = object?.id;
    if (!paymentId) {
      console.warn('[billing/webhook] Missing payment id in payment.succeeded');
      return res.status(400).json({ error: 'missing_payment_id' });
    }

    const metadata = object.metadata || {};
    const userId = metadata.userId;
    const planId = metadata.planId;
    const durationDays = Number(metadata.durationDays) || 0;

    if (!userId || !planId || !durationDays || !PLANS[planId]) {
      console.error('[billing/webhook] Missing or invalid metadata', metadata);
      return res.status(200).json({ ok: true });
    }

    const expectedAmount = PLANS[planId].amount;
    const receivedAmount = object.amount?.value ? parseFloat(object.amount.value) : null;
    if (receivedAmount === null || Math.abs(receivedAmount - expectedAmount) > 0.01) {
      console.error('[billing/webhook] Amount mismatch', { expectedAmount, receivedAmount, planId });
      return res.status(200).json({ ok: true });
    }

    // 4. Проверка: не обработали ли уже этот платёж (идемпотентность)
    const existingPayment = await prisma.payment.findFirst({
      where: { yookassaPaymentId: paymentId },
      select: { id: true },
    });

    if (existingPayment) {
      console.log('[billing/webhook] Payment already processed:', paymentId);
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
      console.error('[billing/webhook] User not found, payment was not credited:', { userId, paymentId });
      return res.status(200).json({ ok: true });
    }

    const now = new Date();
    const baseDate =
      user.subscriptionExpiresAt && user.subscriptionExpiresAt.getTime() > now.getTime()
        ? user.subscriptionExpiresAt
        : now;

    const msToAdd = durationDays * 24 * 60 * 60 * 1000;
    const newExpiresAt = new Date(baseDate.getTime() + msToAdd);

    // 5. Обновляем пользователя + записываем платёж для идемпотентности
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          subscriptionType: planId,
          subscriptionExpiresAt: newExpiresAt,
          isPremium: true,
        },
      });

      await tx.payment.create({
        data: {
          userId: user.id,
          yookassaPaymentId: paymentId,
          planId,
          amount: object.amount?.value ? parseFloat(object.amount.value) : null,
          status: object.status || 'succeeded',
        },
      });
    });

    // 6. Инвалидируем auth cache, чтобы isPremium обновился немедленно
    const { invalidateUserCache } = require('../../middleware/auth');
    invalidateUserCache(user.id);

    console.log(`[billing/webhook] Payment processed: user=${user.id}, plan=${planId}, expires=${newExpiresAt.toISOString()}`);

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

