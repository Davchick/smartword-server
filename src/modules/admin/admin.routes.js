const express = require('express');
const { prisma } = require('../../db/prisma');
const { adminAuthMiddleware } = require('../../middleware/adminAuth');

const router = express.Router();
router.use(adminAuthMiddleware);

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function mapUser(user) {
  const now = Date.now();
  const expiresAt = user.subscriptionExpiresAt ? user.subscriptionExpiresAt.getTime() : 0;
  return {
    id: user.id,
    email: user.email,
    created_at: toIso(user.createdAt),
    email_verified: user.emailVerified,
    subscription_type: user.subscriptionType,
    subscription_expires_at: toIso(user.subscriptionExpiresAt),
    is_premium_active: expiresAt > now,
    words_learned_this_week: user.wordsLearnedThisWeek,
    ai_messages_used: user.aiMessagesUsed,
  };
}

async function writeAdminAudit(req, action, targetType, targetId, metadata = {}, outcome = 'success') {
  try {
    if (!prisma.adminAuditLog) {
      return;
    }
    await prisma.adminAuditLog.create({
      data: {
        adminEmail: req.admin?.email || null,
        adminUserId: req.admin?.id || null,
        action,
        targetType,
        targetId: targetId || null,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: String(req.headers['user-agent'] || ''),
        outcome,
        metadata,
      },
    });
  } catch (auditErr) {
    console.error('[admin/audit]', auditErr);
  }
}

router.get('/overview', async (_req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [usersTotal, usersNew7d, verifiedUsers, activePremiumUsers, wordsTotal, groupsTotal, paymentsTotal, payments30d] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
        prisma.user.count({ where: { emailVerified: true } }),
        prisma.user.count({ where: { subscriptionExpiresAt: { gt: now } } }),
        prisma.word.count(),
        prisma.wordGroup.count(),
        prisma.payment.count(),
        prisma.payment.aggregate({
          _sum: { amount: true },
          where: { createdAt: { gte: thirtyDaysAgo }, status: 'succeeded' },
        }),
      ]);

    res.json({
      users_total: usersTotal,
      users_new_7d: usersNew7d,
      users_verified: verifiedUsers,
      users_premium_active: activePremiumUsers,
      words_total: wordsTotal,
      groups_total: groupsTotal,
      payments_total: paymentsTotal,
      revenue_30d_rub: payments30d._sum.amount || 0,
    });
  } catch (err) {
    console.error('[admin/overview]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const search = String(req.query.search || '').trim();
    const skip = (page - 1) * pageSize;

    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' } },
            { id: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          email: true,
          createdAt: true,
          emailVerified: true,
          subscriptionType: true,
          subscriptionExpiresAt: true,
          wordsLearnedThisWeek: true,
          aiMessagesUsed: true,
        },
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
      users: users.map(mapUser),
    });
  } catch (err) {
    console.error('[admin/users]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        createdAt: true,
        emailVerified: true,
        subscriptionType: true,
        subscriptionExpiresAt: true,
        wordsLearnedThisWeek: true,
        aiMessagesUsed: true,
        weekStartDate: true,
        _count: {
          select: {
            words: true,
            groups: true,
            payments: true,
            refreshTokens: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const payments = await prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        yookassaPaymentId: true,
        planId: true,
        amount: true,
        status: true,
        createdAt: true,
      },
    });

    res.json({
      ...mapUser(user),
      week_start_date: toIso(user.weekStartDate),
      counts: {
        words: user._count.words,
        groups: user._count.groups,
        payments: user._count.payments,
        active_sessions: user._count.refreshTokens,
      },
      recent_payments: payments.map((item) => ({
        id: item.id,
        payment_id: item.yookassaPaymentId,
        plan_id: item.planId,
        amount: item.amount,
        status: item.status,
        created_at: toIso(item.createdAt),
      })),
    });
  } catch (err) {
    console.error('[admin/user detail]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.patch('/users/:userId/subscription', async (req, res) => {
  try {
    const { userId } = req.params;
    const durationDays = Number(req.body?.duration_days);
    const planId = String(req.body?.plan_id || '').trim();

    if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 3650) {
      return res.status(400).json({ error: 'invalid_duration_days' });
    }
    if (!planId) {
      return res.status(400).json({ error: 'invalid_plan_id' });
    }

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, subscriptionExpiresAt: true },
    });
    if (!existing) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const now = Date.now();
    const baseMs = existing.subscriptionExpiresAt && existing.subscriptionExpiresAt.getTime() > now
      ? existing.subscriptionExpiresAt.getTime()
      : now;
    const expiresAt = new Date(baseMs + durationDays * 24 * 60 * 60 * 1000);

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionType: planId,
        subscriptionExpiresAt: expiresAt,
        isPremium: true,
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
        emailVerified: true,
        subscriptionType: true,
        subscriptionExpiresAt: true,
        wordsLearnedThisWeek: true,
        aiMessagesUsed: true,
      },
    });

    await writeAdminAudit(
      req,
      'grant_subscription',
      'user',
      userId,
      { duration_days: durationDays, plan_id: planId, expires_at: expiresAt.toISOString() },
      'success',
    );

    res.json(mapUser(updated));
  } catch (err) {
    await writeAdminAudit(req, 'grant_subscription', 'user', req.params?.userId, {
      error: err?.message || 'unknown_error',
    }, 'error');
    console.error('[admin/user subscription]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.post('/users/:userId/reset-weekly-limit', async (req, res) => {
  try {
    const { userId } = req.params;
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff));
    monday.setHours(0, 0, 0, 0);

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        wordsLearnedThisWeek: 0,
        weekStartDate: monday,
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
        emailVerified: true,
        subscriptionType: true,
        subscriptionExpiresAt: true,
        wordsLearnedThisWeek: true,
        aiMessagesUsed: true,
      },
    });

    await writeAdminAudit(req, 'reset_weekly_limit', 'user', userId, {
      week_start_date: monday.toISOString(),
    }, 'success');

    res.json(mapUser(updated));
  } catch (err) {
    await writeAdminAudit(req, 'reset_weekly_limit', 'user', req.params?.userId, {
      error: err?.message || 'unknown_error',
    }, 'error');
    console.error('[admin/user reset-weekly-limit]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/audit', async (req, res) => {
  try {
    if (!prisma.adminAuditLog) {
      return res.status(503).json({
        error: 'admin_audit_not_ready',
        message: 'Admin audit storage is not ready. Run Prisma migration and generate client.',
      });
    }

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const audit = await prisma.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        adminEmail: true,
        adminUserId: true,
        action: true,
        targetType: true,
        targetId: true,
        ipAddress: true,
        outcome: true,
        createdAt: true,
      },
    });

    res.json({
      items: audit.map((item) => ({
        id: item.id,
        admin_email: item.adminEmail,
        admin_user_id: item.adminUserId,
        action: item.action,
        target_type: item.targetType,
        target_id: item.targetId,
        ip_address: item.ipAddress,
        outcome: item.outcome,
        created_at: toIso(item.createdAt),
      })),
    });
  } catch (err) {
    console.error('[admin/audit list]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const payments = await prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        userId: true,
        yookassaPaymentId: true,
        planId: true,
        amount: true,
        status: true,
        createdAt: true,
      },
    });

    res.json({
      payments: payments.map((payment) => ({
        id: payment.id,
        user_id: payment.userId,
        payment_id: payment.yookassaPaymentId,
        plan_id: payment.planId,
        amount: payment.amount,
        status: payment.status,
        created_at: toIso(payment.createdAt),
      })),
    });
  } catch (err) {
    console.error('[admin/payments]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/consents', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const consents = await prisma.consentLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        userId: true,
        email: true,
        consentType: true,
        policyVersion: true,
        granted: true,
        ipAddress: true,
        createdAt: true,
      },
    });

    res.json({
      consents: consents.map((item) => ({
        id: item.id,
        user_id: item.userId,
        email: item.email,
        consent_type: item.consentType,
        policy_version: item.policyVersion,
        granted: item.granted,
        ip_address: item.ipAddress,
        created_at: toIso(item.createdAt),
      })),
    });
  } catch (err) {
    console.error('[admin/consents]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

module.exports = router;
