const express = require('express');
const { prisma } = require('../../db/prisma');
const { authMiddleware } = require('../../middleware/auth');
const { strictLimiter } = require('../../middleware/rateLimiter');
const { env } = require('../../config/env');
const { validateAndNormalizeErrorLogPayload } = require('./errorLogValidation');

const router = express.Router();

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

router.post('/ticket', authMiddleware, async (req, res) => {
  try {
    const { subject, message } = req.body;

    if (!subject || typeof subject !== 'string' || subject.trim().length < 3) {
      return res.status(400).json({ error: 'invalid_subject', message: 'Тема должна содержать минимум 3 символа' });
    }

    if (!message || typeof message !== 'string' || message.trim().length < 10) {
      return res.status(400).json({ error: 'invalid_message', message: 'Сообщение должно содержать минимум 10 символов' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true },
    });

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.id,
        email: user?.email || req.user.email || 'unknown',
        subject: subject.trim().slice(0, 200),
        message: message.trim().slice(0, 5000),
        status: 'open',
        priority: 'normal',
      },
    });

    res.status(201).json({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      created_at: toIso(ticket.createdAt),
    });
  } catch (err) {
    console.error('[support/ticket]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.get('/my-tickets', authMiddleware, async (req, res) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        subject: true,
        status: true,
        priority: true,
        createdAt: true,
        resolvedAt: true,
      },
    });

    res.json({
      tickets: tickets.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        created_at: toIso(t.createdAt),
        resolved_at: toIso(t.resolvedAt),
      })),
    });
  } catch (err) {
    console.error('[support/my-tickets]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

router.post('/error-log', strictLimiter, async (req, res) => {
  try {
    const ingestToken = String(req.headers['x-error-log-token'] || '');
    const configuredToken = env.supportErrorLogToken;
    if (!configuredToken || ingestToken !== configuredToken) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const validation = validateAndNormalizeErrorLogPayload(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const userId = req.user?.id || null;
    const userAgent = req.headers['user-agent'] || null;

    await prisma.userErrorLog.create({
      data: {
        userId,
        errorType: validation.data.errorType,
        message: validation.data.message,
        stack: validation.data.stack,
        url: validation.data.url,
        userAgent,
        metadata: validation.data.metadata,
        resolved: false,
      },
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[support/error-log]', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

module.exports = router;