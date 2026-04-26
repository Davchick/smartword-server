const express = require('express');
const { prisma } = require('../../db/prisma');
const { adminAuthMiddleware, requireAdminScope } = require('../../middleware/adminAuth');
const { parseBooleanQuery, buildUsersWhere } = require('./usersFilters');

const router = express.Router();
router.use(adminAuthMiddleware);
router.use(requireAdminScope('admin:read'));

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

const PERIODS = {
  '7d': { days: 7, prevDays: 7 },
  '30d': { days: 30, prevDays: 30 },
  '90d': { days: 90, prevDays: 30 },
};

function getPeriodParams(period) {
  const config = PERIODS[period] || PERIODS['30d'];
  const now = new Date();
  const periodStart = new Date(now.getTime() - config.days * 24 * 60 * 60 * 1000);
  const prevPeriodStart = new Date(periodStart.getTime() - config.prevDays * 24 * 60 * 60 * 1000);
  return { now, periodStart, prevPeriodStart, days: config.days };
}

function calculateChange(current, previous) {
  if (!previous || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

router.get('/overview', async (req, res) => {
  try {
    const period = String(req.query.period || '30d');
    const { now, periodStart, prevPeriodStart } = getPeriodParams(period);

    const [
      usersTotal,
      usersInPeriod,
      usersPrevPeriod,
      verifiedUsers,
      activePremiumUsers,
      premiumInPeriod,
      premiumPrevPeriod,
      wordsTotal,
      groupsTotal,
      paymentsTotal,
      paymentsInPeriod,
      paymentsPrevPeriod,
      revenueInPeriod,
      revenuePrevPeriod,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: periodStart } } }),
      prisma.user.count({ where: { createdAt: { gte: prevPeriodStart, lt: periodStart } } }),
      prisma.user.count({ where: { emailVerified: true } }),
      prisma.user.count({ where: { subscriptionExpiresAt: { gt: now } } }),
      prisma.user.count({ where: { subscriptionExpiresAt: { gte: periodStart, gt: now }, createdAt: { lt: periodStart } } }),
      prisma.user.count({ where: { subscriptionExpiresAt: { gte: prevPeriodStart, lt: periodStart }, createdAt: { lt: prevPeriodStart } } }),
      prisma.word.count(),
      prisma.wordGroup.count(),
      prisma.payment.count(),
      prisma.payment.count({ where: { createdAt: { gte: periodStart }, status: 'succeeded' } }),
      prisma.payment.count({ where: { createdAt: { gte: prevPeriodStart, lt: periodStart }, status: 'succeeded' } }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { createdAt: { gte: periodStart }, status: 'succeeded' },
      }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: { createdAt: { gte: prevPeriodStart, lt: periodStart }, status: 'succeeded' },
      }),
    ]);

    res.json({
      users_total: usersTotal,
      users_new: usersInPeriod,
      users_new_change: calculateChange(usersInPeriod, usersPrevPeriod),
      users_verified: verifiedUsers,
      users_premium_active: activePremiumUsers,
      users_premium_new: premiumInPeriod,
      users_premium_change: calculateChange(premiumInPeriod, premiumPrevPeriod),
      words_total: wordsTotal,
      groups_total: groupsTotal,
      payments_total: paymentsTotal,
      payments_count: paymentsInPeriod,
      payments_change: calculateChange(paymentsInPeriod, paymentsPrevPeriod),
      revenue: revenueInPeriod._sum.amount || 0,
      revenue_change: calculateChange(revenueInPeriod._sum.amount || 0, revenuePrevPeriod._sum.amount || 0),
    });
  } catch (err) {
    console.error('[admin/overview]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/overview/chart/users', async (req, res) => {
  try {
    const period = String(req.query.period || '30d');
    const config = PERIODS[period] || PERIODS['30d'];
    const now = new Date();
    const days = config.days;

    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const payments = await prisma.payment.groupBy({
      by: ['createdAt'],
      _sum: { amount: true },
      _count: { id: true },
      where: { createdAt: { gte: startDate }, status: 'succeeded' },
      orderBy: { createdAt: 'asc' },
    });

    const usersByDate = await prisma.user.groupBy({
      by: ['createdAt'],
      _count: { id: true },
      where: { createdAt: { gte: startDate } },
      orderBy: { createdAt: 'asc' },
    });

    const dailyData = new Map();
    for (let i = 0; i < days; i++) {
      const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      const key = date.toISOString().split('T')[0];
      dailyData.set(key, { date: key, users: 0, revenue: 0, payments: 0 });
    }

    let cumulativeUsers = 0;
    for (const u of usersByDate) {
      const key = u.createdAt.toISOString().split('T')[0];
      if (dailyData.has(key)) {
        cumulativeUsers += u._count.id;
        dailyData.get(key).users = cumulativeUsers;
      }
    }

    for (const p of payments) {
      const key = p.createdAt.toISOString().split('T')[0];
      if (dailyData.has(key)) {
        const d = dailyData.get(key);
        d.revenue += p._sum.amount || 0;
        d.payments += p._count.id;
      }
    }

    const chartData = Array.from(dailyData.values());

    res.json({ data: chartData });
  } catch (err) {
    console.error('[admin/overview/chart/users]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const skip = (page - 1) * pageSize;
    const where = buildUsersWhere(req.query);

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

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [payments, wordsLast30d, wordsLast7d, sessionsLast30d, sessionsLast7d, recentSession, streak] = await Promise.all([
      prisma.payment.findMany({
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
      }),
      prisma.word.count({ where: { userId, createdAt: { gte: thirtyDaysAgo } } }),
      prisma.word.count({ where: { userId, createdAt: { gte: sevenDaysAgo } } }),
      prisma.refreshToken.count({ where: { userId, lastUsedAt: { gte: thirtyDaysAgo } } }),
      prisma.refreshToken.count({ where: { userId, lastUsedAt: { gte: sevenDaysAgo } } }),
      prisma.refreshToken.findFirst({
        where: { userId, lastUsedAt: { not: null } },
        orderBy: { lastUsedAt: 'desc' },
        select: { lastUsedAt: true },
      }),
      prisma.userStreak.findUnique({
        where: { userId },
        select: { currentStreak: true, lastActivity: true },
      }),
    ]);
    const averageWordsPerDay = wordsLast30d / 30;
    const activityAnchorDate = streak?.lastActivity || recentSession?.lastUsedAt || null;

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
      activity: {
        words_learned_last_30d: wordsLast30d,
        words_learned_last_7d: wordsLast7d,
        sessions_last_30d: sessionsLast30d,
        sessions_last_7d: sessionsLast7d,
        last_active_at: toIso(activityAnchorDate),
        streak_days: streak?.currentStreak || 0,
        average_words_per_day: Math.round(averageWordsPerDay * 100) / 100,
        most_active_day_of_week: activityAnchorDate
          ? activityAnchorDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
          : null,
      },
    });
  } catch (err) {
    console.error('[admin/user detail]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.patch('/users/:userId', requireAdminScope('admin:write'), async (req, res) => {
  try {
    const { userId } = req.params;
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid_email' });
    }

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!existing) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const duplicate = await prisma.user.findFirst({
      where: { email, id: { not: userId } },
      select: { id: true },
    });
    if (duplicate) {
      return res.status(409).json({ error: 'email_already_exists' });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { email },
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
      'update_user_email',
      'user',
      userId,
      { old_email: existing.email, new_email: email },
      'success',
    );

    res.json(mapUser(updated));
  } catch (err) {
    await writeAdminAudit(req, 'update_user_email', 'user', req.params?.userId, {
      error: err?.message || 'unknown_error',
    }, 'error');
    console.error('[admin/update user]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.patch('/users/:userId/subscription', requireAdminScope('admin:write'), async (req, res) => {
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

router.post('/users/:userId/reset-weekly-limit', requireAdminScope('admin:write'), async (req, res) => {
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

router.get('/users/:userId/words', async (req, res) => {
  try {
    const { userId } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const search = String(req.query.search || '').trim();
    const skip = (page - 1) * pageSize;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const where = { userId };
    if (search) {
      where.OR = [
        { original: { contains: search, mode: 'insensitive' } },
        { translation: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, words] = await Promise.all([
      prisma.word.count({ where }),
      prisma.word.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          original: true,
          translation: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
      words: words.map((w) => ({
        id: w.id,
        word: w.original,
        translation: w.translation,
        created_at: toIso(w.createdAt),
      })),
    });
  } catch (err) {
    console.error('[admin/user words]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/users/:userId/groups', async (req, res) => {
  try {
    const { userId } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const search = String(req.query.search || '').trim();
    const skip = (page - 1) * pageSize;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const where = { userId };
    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    const [total, groups] = await Promise.all([
      prisma.wordGroup.count({ where }),
      prisma.wordGroup.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          name: true,
          createdAt: true,
          _count: { select: { words: true } },
        },
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        words_count: g._count.words,
        created_at: toIso(g.createdAt),
      })),
    });
  } catch (err) {
    console.error('[admin/user groups]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/users/:userId/payments', async (req, res) => {
  try {
    const { userId } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const [total, payments] = await Promise.all([
      prisma.payment.count({ where: { userId } }),
      prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          yookassaPaymentId: true,
          planId: true,
          amount: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
      payments: payments.map((p) => ({
        id: p.id,
        payment_id: p.yookassaPaymentId,
        plan_id: p.planId,
        amount: p.amount,
        status: p.status,
        created_at: toIso(p.createdAt),
      })),
    });
  } catch (err) {
    console.error('[admin/user payments]', err);
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

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const period = String(req.query.period || '30d');
    const search = String(req.query.search || '').trim();
    const action = req.query.action;
    const outcome = req.query.outcome;
    const skip = (page - 1) * pageSize;
    const { periodStart } = getPeriodParams(period);

    const where = {};
    if (periodStart) where.createdAt = { gte: periodStart };
    if (search) {
      where.OR = [
        { adminEmail: { contains: search, mode: 'insensitive' } },
        { adminUserId: { contains: search, mode: 'insensitive' } },
        { targetId: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (action) where.action = action;
    if (outcome) where.outcome = outcome;

    const [total, audit] = await Promise.all([
      prisma.adminAuditLog.count({ where }),
      prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
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
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
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
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const period = String(req.query.period || '30d');
    const search = String(req.query.search || '').trim();
    const status = req.query.status;
    const skip = (page - 1) * pageSize;
    const { periodStart } = getPeriodParams(period);

    const where = {};
    if (periodStart) where.createdAt = { gte: periodStart };
    if (search) {
      where.OR = [
        { userId: { contains: search, mode: 'insensitive' } },
        { yookassaPaymentId: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status) where.status = status;

    const [total, payments] = await Promise.all([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          userId: true,
          yookassaPaymentId: true,
          planId: true,
          amount: true,
          status: true,
          createdAt: true,
          user: { select: { email: true } },
        },
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
      payments: payments.map((payment) => ({
        id: payment.id,
        user_id: payment.userId,
        user_email: payment.user?.email || null,
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
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const period = String(req.query.period || '30d');
    const search = String(req.query.search || '').trim();
    const consentType = req.query.consentType;
    const granted = req.query.granted;
    const skip = (page - 1) * pageSize;
    const { periodStart } = getPeriodParams(period);

    const where = {};
    if (periodStart) where.createdAt = { gte: periodStart };
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { userId: { contains: search, mode: 'insensitive' } },
        { ipAddress: { contains: search } },
      ];
    }
    if (consentType) where.consentType = consentType;
    if (granted !== undefined) where.granted = granted === 'true';

    const [total, consents] = await Promise.all([
      prisma.consentLog.count({ where }),
      prisma.consentLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
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
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
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

router.get('/analytics/cohorts', async (req, res) => {
  try {
    const period = String(req.query.period || '30d');
    const { periodStart } = getPeriodParams(period);
    const endDate = new Date();
    const startDate = new Date(periodStart);

    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    const cohorts = [];
    const currentDate = new Date(startDate);
    const now = new Date();

    while (currentDate <= now) {
      const cohortDate = currentDate.toISOString().split('T')[0];
      const dayEnd = new Date(currentDate);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const [totalUsers, premiumUsers, revenueResult] = await Promise.all([
        prisma.user.count({
          where: {
            createdAt: { gte: currentDate, lt: dayEnd },
          },
        }),
        prisma.user.count({
          where: {
            createdAt: { gte: currentDate, lt: dayEnd },
            subscriptionExpiresAt: { gt: now },
          },
        }),
        prisma.payment.aggregate({
          _sum: { amount: true },
          where: {
            createdAt: { gte: currentDate, lt: dayEnd },
            status: 'succeeded',
          },
        }),
      ]);

      const usersAfter30Days = await prisma.user.count({
        where: {
          createdAt: { gte: currentDate, lt: dayEnd },
        },
      });

      const retainedAfter30 = await prisma.user.count({
        where: {
          createdAt: { gte: currentDate, lt: dayEnd },
          refreshTokens: {
            some: {
              createdAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
            },
          },
        },
      });

      const convertedCount = premiumUsers;
      const conversionRate = totalUsers > 0 ? (convertedCount / totalUsers) * 100 : 0;
      const retentionRate = totalUsers > 0 ? (retainedAfter30 / totalUsers) * 100 : 0;

      cohorts.push({
        cohort_date: cohortDate,
        total_users: totalUsers,
        retained_users: retainedAfter30,
        retention_rate: Math.round(retentionRate * 10) / 10,
        converted_to_premium: convertedCount,
        conversion_rate: Math.round(conversionRate * 10) / 10,
        revenue: revenueResult._sum.amount || 0,
      });

      currentDate.setDate(currentDate.getDate() + 1);
    }

    res.json({
      data: cohorts.slice(0, 30),
      period_start: startStr,
      period_end: endStr,
    });
  } catch (err) {
    console.error('[admin/analytics/cohorts]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/analytics/revenue', async (req, res) => {
  try {
    const period = String(req.query.period || '30d');
    const { periodStart, days } = getPeriodParams(period);
    const now = new Date();

    const totalRevenueResult = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { createdAt: { gte: periodStart }, status: 'succeeded' },
    });

    const previousPeriodStart = new Date(periodStart.getTime() - days * 24 * 60 * 60 * 1000);
    const previousRevenueResult = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: { createdAt: { gte: previousPeriodStart, lt: periodStart }, status: 'succeeded' },
    });

    const totalUsers = await prisma.user.count();
    const premiumUsers = await prisma.user.count({
      where: { subscriptionExpiresAt: { gt: now } },
    });

    const totalRevenue = totalRevenueResult._sum.amount || 0;
    const previousRevenue = previousRevenueResult._sum.amount || 0;
    const revenueChange = previousRevenue > 0 ? ((totalRevenue - previousRevenue) / previousRevenue) * 100 : null;

    const averageRevenuePerUser = totalUsers > 0 ? totalRevenue / totalUsers : 0;
    const premiumCount = premiumUsers || 1;
    const ltv = totalRevenue / premiumCount;
    const previousLtv = previousRevenue > 0 ? previousRevenue / premiumCount : 0;
    const ltvGrowth = previousLtv > 0 ? ((ltv - previousLtv) / previousLtv) * 100 : null;
    const arpuChange = previousRevenue > 0 ? revenueChange : null;

    res.json({
      total_revenue: totalRevenue,
      revenue_change: revenueChange ? Math.round(revenueChange * 10) / 10 : null,
      average_revenue_per_user: Math.round(averageRevenuePerUser * 100) / 100,
      lifetime_value: Math.round(ltv * 100) / 100,
      arpu_change: arpuChange ? Math.round(arpuChange * 10) / 10 : null,
      ltv_growth: ltvGrowth ? Math.round(ltvGrowth * 10) / 10 : null,
    });
  } catch (err) {
    console.error('[admin/analytics/revenue]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/analytics/churn', async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const [totalPremiumNow, premium30dAgo, premium60dAgo] = await Promise.all([
      prisma.user.count({ where: { subscriptionExpiresAt: { gt: now } } }),
      prisma.user.count({ where: { subscriptionExpiresAt: { gt: thirtyDaysAgo, lte: now } } }),
      prisma.user.count({ where: { subscriptionExpiresAt: { gt: sixtyDaysAgo, lte: thirtyDaysAgo } } }),
    ]);

    const churned30d = Math.max(0, premium30dAgo - totalPremiumNow);
    const churnRate30d = premium30dAgo > 0 ? (churned30d / premium30dAgo) * 100 : 0;

    const churned90d = Math.max(0, premium60dAgo - premium30dAgo);
    const churnRate90d = premium60dAgo > 0 ? (churned90d / premium60dAgo) * 100 : 0;

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const atRiskUsers = await prisma.user.count({
      where: {
        subscriptionExpiresAt: {
          gt: now,
          lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
      },
    });

    res.json({
      churn_rate_30d: Math.round(churnRate30d * 10) / 10,
      churn_rate_90d: Math.round(churnRate90d * 10) / 10,
      churned_users_30d: churned30d,
      churned_users_90d: churned90d,
      at_risk_users: atRiskUsers,
    });
  } catch (err) {
    console.error('[admin/analytics/churn]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/overview/chart/revenue', async (req, res) => {
  try {
    const period = String(req.query.period || '30d');
    const config = PERIODS[period] || PERIODS['30d'];
    const now = new Date();
    const days = config.days;
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const dailyData = new Map();
    for (let i = 0; i < days; i++) {
      const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      const key = date.toISOString().split('T')[0];
      dailyData.set(key, { date: key, revenue: 0 });
    }

    const payments = await prisma.payment.groupBy({
      by: ['createdAt'],
      _sum: { amount: true },
      where: { createdAt: { gte: startDate }, status: 'succeeded' },
      orderBy: { createdAt: 'asc' },
    });

    for (const p of payments) {
      const key = p.createdAt.toISOString().split('T')[0];
      if (dailyData.has(key)) {
        dailyData.get(key).revenue += p._sum.amount || 0;
      }
    }

    const chartData = Array.from(dailyData.values());
    res.json({ data: chartData });
  } catch (err) {
    console.error('[admin/overview/chart/revenue]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/overview/chart/payments', async (req, res) => {
  try {
    const period = String(req.query.period || '30d');
    const config = PERIODS[period] || PERIODS['30d'];
    const now = new Date();
    const days = config.days;
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const dailyData = new Map();
    for (let i = 0; i < days; i++) {
      const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      const key = date.toISOString().split('T')[0];
      dailyData.set(key, { date: key, payments: 0 });
    }

    const payments = await prisma.payment.groupBy({
      by: ['createdAt'],
      _count: { id: true },
      where: { createdAt: { gte: startDate }, status: 'succeeded' },
      orderBy: { createdAt: 'asc' },
    });

    for (const p of payments) {
      const key = p.createdAt.toISOString().split('T')[0];
      if (dailyData.has(key)) {
        dailyData.get(key).payments += p._count.id;
      }
    }

    const chartData = Array.from(dailyData.values());
    res.json({ data: chartData });
  } catch (err) {
    console.error('[admin/overview/chart/payments]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/tickets', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const period = String(req.query.period || '30d');
    const search = String(req.query.search || '').trim();
    const status = req.query.status;
    const priority = req.query.priority;
    const skip = (page - 1) * pageSize;
    const { periodStart } = getPeriodParams(period);

    const where = {};
    if (periodStart) where.createdAt = { gte: periodStart };
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { subject: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
        { id: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) where.status = status;
    if (priority) where.priority = priority;

    const [total, tickets] = await Promise.all([
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.findMany({
        where,
        orderBy: [
          { priority: 'desc' },
          { createdAt: 'desc' },
        ],
        skip,
        take: pageSize,
        select: {
          id: true,
          userId: true,
          email: true,
          subject: true,
          message: true,
          status: true,
          priority: true,
          assignedTo: true,
          adminNotes: true,
          createdAt: true,
          updatedAt: true,
          resolvedAt: true,
        },
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
      tickets: tickets.map((t) => ({
        id: t.id,
        user_id: t.userId,
        email: t.email,
        subject: t.subject,
        message: t.message,
        status: t.status,
        priority: t.priority,
        assigned_to: t.assignedTo,
        admin_notes: t.adminNotes,
        created_at: toIso(t.createdAt),
        updated_at: toIso(t.updatedAt),
        resolved_at: toIso(t.resolvedAt),
      })),
    });
  } catch (err) {
    console.error('[admin/tickets]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/tickets/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        user: {
          select: { id: true, email: true },
        },
      },
    });

    if (!ticket) {
      return res.status(404).json({ error: 'ticket_not_found' });
    }

    res.json({
      id: ticket.id,
      user_id: ticket.userId,
      user_email: ticket.user?.email,
      email: ticket.email,
      subject: ticket.subject,
      message: ticket.message,
      status: ticket.status,
      priority: ticket.priority,
      assigned_to: ticket.assignedTo,
      admin_notes: ticket.adminNotes,
      created_at: toIso(ticket.createdAt),
      updated_at: toIso(ticket.updatedAt),
      resolved_at: toIso(ticket.resolvedAt),
    });
  } catch (err) {
    console.error('[admin/tickets/detail]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.patch('/tickets/:ticketId', requireAdminScope('admin:write'), async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status, priority, assignedTo, adminNotes } = req.body;

    const existing = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true },
    });

    if (!existing) {
      return res.status(404).json({ error: 'ticket_not_found' });
    }

    const updateData = {};
    if (status !== undefined) {
      updateData.status = status;
      if (status === 'resolved') {
        updateData.resolvedAt = new Date();
      }
    }
    if (priority !== undefined) updateData.priority = priority;
    if (assignedTo !== undefined) updateData.assignedTo = assignedTo;
    if (adminNotes !== undefined) updateData.adminNotes = adminNotes;

    const updated = await prisma.supportTicket.update({
      where: { id: ticketId },
      data: updateData,
      select: {
        id: true,
        status: true,
        priority: true,
        assignedTo: true,
        adminNotes: true,
        updatedAt: true,
        resolvedAt: true,
      },
    });

    await writeAdminAudit(
      req,
      'update_ticket',
      'ticket',
      ticketId,
      { status: updated.status, priority: updated.priority },
      'success',
    );

    res.json({
      id: updated.id,
      status: updated.status,
      priority: updated.priority,
      assigned_to: updated.assignedTo,
      admin_notes: updated.adminNotes,
      updated_at: toIso(updated.updatedAt),
      resolved_at: toIso(updated.resolvedAt),
    });
  } catch (err) {
    await writeAdminAudit(req, 'update_ticket', 'ticket', req.params?.ticketId, {
      error: err?.message || 'unknown_error',
    }, 'error');
    console.error('[admin/tickets/update]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/error-logs', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const period = String(req.query.period || '30d');
    const search = String(req.query.search || '').trim();
    const errorType = req.query.errorType;
    const resolved = req.query.resolved;
    const userId = req.query.userId;
    const skip = (page - 1) * pageSize;
    const { periodStart } = getPeriodParams(period);

    const where = {};
    if (periodStart) where.createdAt = { gte: periodStart };
    if (search) {
      where.OR = [
        { message: { contains: search, mode: 'insensitive' } },
        { errorType: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (errorType) where.errorType = errorType;
    if (resolved !== undefined) where.resolved = resolved === 'true';
    if (userId) where.userId = userId;

    const [total, logs] = await Promise.all([
      prisma.userErrorLog.count({ where }),
      prisma.userErrorLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          userId: true,
          errorType: true,
          message: true,
          stack: true,
          url: true,
          userAgent: true,
          metadata: true,
          resolved: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({
      page,
      page_size: pageSize,
      total,
      logs: logs.map((l) => ({
        id: l.id,
        user_id: l.userId,
        error_type: l.errorType,
        message: l.message,
        stack: l.stack,
        url: l.url,
        user_agent: l.userAgent,
        metadata: l.metadata,
        resolved: l.resolved,
        created_at: toIso(l.createdAt),
      })),
    });
  } catch (err) {
    console.error('[admin/error-logs]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.patch('/error-logs/:logId/resolve', requireAdminScope('admin:write'), async (req, res) => {
  try {
    const { logId } = req.params;
    const { resolved } = req.body;

    const existing = await prisma.userErrorLog.findUnique({
      where: { id: logId },
      select: { id: true },
    });

    if (!existing) {
      return res.status(404).json({ error: 'log_not_found' });
    }

    const updated = await prisma.userErrorLog.update({
      where: { id: logId },
      data: { resolved: resolved ?? true },
      select: {
        id: true,
        resolved: true,
        updatedAt: true,
      },
    });

    await writeAdminAudit(
      req,
      'resolve_error_log',
      'error_log',
      logId,
      { resolved: updated.resolved },
      'success',
    );

    res.json({
      id: updated.id,
      resolved: updated.resolved,
      updated_at: toIso(updated.updatedAt),
    });
  } catch (err) {
    await writeAdminAudit(req, 'resolve_error_log', 'error_log', req.params?.logId, {
      error: err?.message || 'unknown_error',
    }, 'error');
    console.error('[admin/error-logs/resolve]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.post('/users/bulk/grant-subscription', requireAdminScope('admin:write'), async (req, res) => {
  try {
    const userIds = Array.isArray(req.body?.user_ids)
      ? req.body.user_ids.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];
    const durationDays = Number(req.body?.duration_days);
    const planId = String(req.body?.plan_id || '').trim();

    if (userIds.length === 0) {
      return res.status(400).json({ error: 'invalid_user_ids' });
    }
    if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 3650) {
      return res.status(400).json({ error: 'invalid_duration_days' });
    }
    if (!planId) {
      return res.status(400).json({ error: 'invalid_plan_id' });
    }

    const uniqueUserIds = [...new Set(userIds)];
    const nowMs = Date.now();
    const users = await prisma.user.findMany({
      where: { id: { in: uniqueUserIds } },
      select: { id: true, subscriptionExpiresAt: true },
    });
    const usersById = new Map(users.map((user) => [user.id, user]));
    const results = [];

    await prisma.$transaction(async (tx) => {
      for (const userId of uniqueUserIds) {
        const existing = usersById.get(userId);
        if (!existing) {
          results.push({ user_id: userId, success: false, error: 'user_not_found' });
          continue;
        }
        const baseMs = existing.subscriptionExpiresAt && existing.subscriptionExpiresAt.getTime() > nowMs
          ? existing.subscriptionExpiresAt.getTime()
          : nowMs;
        const expiresAt = new Date(baseMs + durationDays * 24 * 60 * 60 * 1000);
        await tx.user.update({
          where: { id: userId },
          data: {
            subscriptionType: planId,
            subscriptionExpiresAt: expiresAt,
            isPremium: true,
          },
        });
        results.push({ user_id: userId, success: true });
      }
    });

    const succeeded = results.filter((item) => item.success).length;
    const failed = results.length - succeeded;
    await writeAdminAudit(
      req,
      'bulk_grant_subscription',
      'users',
      null,
      { total: results.length, succeeded, failed, duration_days: durationDays, plan_id: planId },
      failed === 0 ? 'success' : 'partial_success',
    );

    res.json({
      results,
      total: results.length,
      succeeded,
      failed,
    });
  } catch (err) {
    await writeAdminAudit(req, 'bulk_grant_subscription', 'users', null, {
      error: err?.message || 'unknown_error',
    }, 'error');
    console.error('[admin/users/bulk/grant-subscription]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/search/global', async (req, res) => {
  try {
    const rawQuery = String(req.query.q || '').trim();
    const query = rawQuery.slice(0, 120);
    const type = String(req.query.type || 'all');
    const now = Date.now();
    if (query.length < 2) {
      return res.json({ results: [] });
    }

    const [users, payments, words] = await Promise.all([
      type === 'all' || type === 'user'
        ? prisma.user.findMany({
          where: {
            OR: [
              { email: { contains: query, mode: 'insensitive' } },
              { id: { contains: query, mode: 'insensitive' } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            email: true,
            createdAt: true,
            subscriptionExpiresAt: true,
          },
        })
        : Promise.resolve([]),
      type === 'all' || type === 'payment'
        ? prisma.payment.findMany({
          where: {
            OR: [
              { yookassaPaymentId: { contains: query, mode: 'insensitive' } },
              { userId: { contains: query, mode: 'insensitive' } },
              { user: { email: { contains: query, mode: 'insensitive' } } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            userId: true,
            yookassaPaymentId: true,
            amount: true,
            status: true,
            createdAt: true,
            user: { select: { email: true } },
          },
        })
        : Promise.resolve([]),
      type === 'all' || type === 'word'
        ? prisma.word.findMany({
          where: {
            OR: [
              { original: { contains: query, mode: 'insensitive' } },
              { translation: { contains: query, mode: 'insensitive' } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            userId: true,
            original: true,
            translation: true,
            createdAt: true,
          },
        })
        : Promise.resolve([]),
    ]);

    const results = [
      ...users.map((item) => ({
        type: 'user',
        id: item.id,
        user_id: item.id,
        email: item.email,
        created_at: toIso(item.createdAt),
        is_premium_active: Boolean(item.subscriptionExpiresAt && item.subscriptionExpiresAt.getTime() > now),
      })),
      ...payments.map((item) => ({
        type: 'payment',
        id: item.id,
        payment_id: item.yookassaPaymentId,
        user_id: item.userId,
        email: item.user?.email || undefined,
        amount: item.amount,
        status: item.status,
        created_at: toIso(item.createdAt),
      })),
      ...words.map((item) => ({
        type: 'word',
        id: item.id,
        word_id: item.id,
        user_id: item.userId,
        word: item.original,
        translation: item.translation,
        created_at: toIso(item.createdAt),
      })),
    ]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, 30);

    res.json({ results });
  } catch (err) {
    console.error('[admin/search/global]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

module.exports = router;
