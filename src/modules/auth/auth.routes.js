const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { prisma } = require('../../db/prisma');
const { env } = require('../../config/env');
const { authMiddleware } = require('../../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../../email/send');
const { authLimiter, refreshLimiter, passwordResetLimiter, strictLimiter } = require('../../middleware/rateLimiter');
const {
  getVerificationSuccessHtml,
  getVerificationPageHtml,
  getResetSuccessHtml,
  getResetPasswordFormHtml,
  BASE_URL,
} = require('../../email/templates');
const { logConsent } = require('../consent/consent.service');

const router = express.Router();
const EMAIL_VERIFY_EXPIRY_HOURS = 24;
const PASSWORD_RESET_EXPIRY_HOURS = 1;

const ACCESS_TOKEN_EXPIRY = '1h';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signAccessToken(userId) {
  return jwt.sign(
    { userId, sub: userId },
    env.jwtSecret,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

function signRefreshToken(userId, jti) {
  return jwt.sign(
    { userId, sub: userId, jti },
    env.jwtRefreshSecret,
    { expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d` }
  );
}

/**
 * POST /auth/register
 * Body: { email, password }
 * Создаёт аккаунт с emailVerified: false, отправляет письмо со ссылкой подтверждения.
 * Returns: { message, email } — войти можно только после перехода по ссылке из письма.
 */
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(`[auth/register] Attempting registration for email: ${email}`);
    
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      console.log('[auth/register] Missing email or password');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length === 0) {
      console.log('[auth/register] Invalid email format');
      return res.status(400).json({ error: 'Invalid email' });
    }
    if (password.length < 6) {
      console.log('[auth/register] Password too short');
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      console.log(`[auth/register] User already exists: ${normalizedEmail}`);
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const emailVerifyToken = crypto.randomBytes(32).toString('hex');
    const emailVerifyTokenExpiresAt = new Date(Date.now() + EMAIL_VERIFY_EXPIRY_HOURS * 60 * 60 * 1000);

    const passwordHash = await hashPassword(password);
    const newUser = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        emailVerified: false,
        emailVerifyToken,
        emailVerifyTokenExpiresAt,
      },
    });
    
    console.log(`[auth/register] User created: ${newUser.id}`);

    const emailResult = await sendVerificationEmail(normalizedEmail, emailVerifyToken);
    console.log(`[auth/register] Email send result:`, emailResult);

    if (emailResult.error) {
      console.error('[auth/register] Email send failed, but user created. User should request resend.');
    }

    // Фиксация согласия на обработку ПДн (требование 152-ФЗ, ст. 9)
    const ipAddress = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    await logConsent({
      email: normalizedEmail,
      ipAddress,
      userAgent,
      consentType: 'registration',
    }).catch(err => console.error('[auth/register] Consent logging failed:', err));

    res.status(201).json({
      message: 'На почту отправлена ссылка для подтверждения. Перейдите по ней, затем войдите в аккаунт.',
      email: normalizedEmail,
    });
  } catch (err) {
    console.error('[auth/register] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/login
 * Body: { email, password }
 * Returns: { access_token, refresh_token, expires_in, user }
 * 403 + code EMAIL_NOT_VERIFIED если почта не подтверждена.
 */
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    if (!user.emailVerified) {
      // Старые пользователи (до введения верификации): нет токена — считаем подтверждёнными
      if (!user.emailVerifyToken && !user.emailVerifyTokenExpiresAt) {
        await prisma.user.update({
          where: { id: user.id },
          data: { emailVerified: true },
        });
      } else {
        return res.status(403).json({
          error: 'Подтвердите почту по ссылке из письма, затем войдите снова.',
          code: 'EMAIL_NOT_VERIFIED',
          email: normalizedEmail,
          can_request_resend: true,
        });
      }
    }

    const jti = crypto.randomBytes(16).toString('hex');
    const deviceFingerprint = req.deviceFingerprint || null;
    await prisma.refreshToken.create({
      data: { 
        userId: user.id, 
        token: jti,
        deviceFingerprint,
      },
    });
    const refreshToken = signRefreshToken(user.id, jti);
    const accessToken = signAccessToken(user.id);

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      user: {
        id: user.id,
        email: user.email,
        is_premium: user.isPremium,
        ai_messages_used: user.aiMessagesUsed,
      },
    });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/google
 * Body: { id_token: string }
 * Валидирует Google ID Token, создаёт или находит пользователя, выдаёт JWT.
 * Auto-link: если есть пользователь с таким email без googleId — привязывает googleId.
 */
router.post('/google', async (req, res) => {
  try {
    const { id_token: idToken } = req.body;
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'id_token is required' });
    }
    if (!env.googleClientId) {
      return res.status(503).json({ error: 'Google sign-in is not configured' });
    }

    const client = new OAuth2Client(env.googleClientId);
    let ticket;
    try {
      ticket = await client.verifyIdToken({
        idToken,
        audience: env.googleClientId,
      });
    } catch (verifyErr) {
      console.error('[auth/google] verifyIdToken failed:', verifyErr.message);
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email?.trim().toLowerCase();
    const emailVerified = payload.email_verified === true;
    const picture = payload.picture || null;

    if (!email || !googleId) {
      return res.status(400).json({ error: 'Google token missing email or sub' });
    }
    if (!emailVerified) {
      return res.status(403).json({ error: 'Google email not verified' });
    }

    let user = await prisma.user.findUnique({ where: { googleId } });
    if (user) {
      // Уже есть пользователь с этим Google ID
    } else {
      const existingByEmail = await prisma.user.findUnique({ where: { email } });
      if (existingByEmail) {
        await prisma.user.update({
          where: { id: existingByEmail.id },
          data: {
            googleId,
            googleEmail: email,
            googlePicture: picture,
            emailVerified: true,
          },
        });
        user = await prisma.user.findUnique({ where: { id: existingByEmail.id } });
      } else {
        const placeholderHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
        user = await prisma.user.create({
          data: {
            email,
            passwordHash: placeholderHash,
            emailVerified: true,
            googleId,
            googleEmail: email,
            googlePicture: picture,
          },
        });
      }
    }

    const jti = crypto.randomBytes(16).toString('hex');
    const deviceFingerprint = req.deviceFingerprint || null;
    await prisma.refreshToken.create({
      data: { 
        userId: user.id, 
        token: jti,
        deviceFingerprint,
      },
    });
    const refreshToken = signRefreshToken(user.id, jti);
    const accessToken = signAccessToken(user.id);

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      user: {
        id: user.id,
        email: user.email,
        is_premium: user.isPremium,
        ai_messages_used: user.aiMessagesUsed,
      },
    });
  } catch (err) {
    console.error('[auth/google]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/refresh
 * Body: { refresh_token }
 * Returns: { access_token, refresh_token, expires_in }
 * Validates device fingerprint to detect suspicious activity.
 */
router.post('/refresh', refreshLimiter, async (req, res) => {
  try {
    const { refresh_token: refreshTokenFromBody } = req.body;
    const authHeader = req.headers.authorization;
    const refreshTokenRaw = refreshTokenFromBody || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);

    if (!refreshTokenRaw) {
      return res.status(400).json({ error: 'refresh_token is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshTokenRaw, env.jwtRefreshSecret);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const jti = decoded.jti;
    const userId = decoded.userId || decoded.sub;
    if (!jti || !userId) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const record = await prisma.refreshToken.findFirst({
      where: { userId, token: jti },
      include: { user: true },
    });
    if (!record || record.revokedAt) {
      return res.status(401).json({ error: 'Refresh token revoked or not found' });
    }
    
    // Device fingerprint validation (security monitoring)
    const currentFingerprint = req.deviceFingerprint;
    if (record.deviceFingerprint && currentFingerprint && record.deviceFingerprint !== currentFingerprint) {
      // Different device using the same refresh token - potential token theft
      console.warn('[SECURITY] Refresh token used from different device:', {
        userId,
        originalFingerprint: record.deviceFingerprint,
        currentFingerprint,
      });
      
      // Revoke the token for security
      await prisma.refreshToken.update({
        where: { id: record.id },
        data: { revokedAt: new Date() },
      });
      
      return res.status(401).json({ 
        error: 'Suspicious activity detected. Please log in again.',
        code: 'SUSPICIOUS_ACTIVITY'
      });
    }
    
    const newJti = crypto.randomBytes(16).toString('hex');
    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: record.id },
        data: { 
          revokedAt: new Date(),
          lastUsedAt: new Date(),
        },
      }),
      prisma.refreshToken.create({
        data: { 
          userId: record.userId, 
          token: newJti,
          deviceFingerprint: currentFingerprint,
        },
      }),
    ]);

    const newRefreshToken = signRefreshToken(record.userId, newJti);
    const accessToken = signAccessToken(record.userId);

    res.json({
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: 3600,
    });
  } catch (err) {
    console.error('[auth/refresh]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/logout
 * Requires: Authorization: Bearer <access_token> (or body refresh_token for revoke)
 * Body (optional): { refresh_token } — если передан, помечаем только этот refresh как revoked.
 * Без body: клиент сам удаляет токены локально; при желании можно принимать refresh_token и revoke его.
 */
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const { refresh_token: refreshTokenFromBody } = req.body;
    if (refreshTokenFromBody) {
      try {
        const decoded = jwt.verify(refreshTokenFromBody, env.jwtRefreshSecret);
        const jti = decoded.jti;
        const userId = req.user.id;
        if (jti && userId) {
          await prisma.refreshToken.updateMany({
            where: { userId, token: jti },
            data: { revokedAt: new Date() },
          });
        }
      } catch (_) {
        // ignore invalid refresh on logout
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[auth/logout]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/verify-password
 * Body: { currentPassword }
 * Проверяет текущий пароль перед сменой. Returns: { ok: true } или 401.
 */
router.post('/verify-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword } = req.body;
    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({ error: 'Введите текущий пароль' });
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { passwordHash: true },
    });
    if (!user) {
      return res.status(401).json({ error: 'Пользователь не найден' });
    }
    const valid = await comparePassword(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/verify-password]', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * PATCH /auth/password
 * Body: { currentPassword, newPassword }
 * Requires: Authorization
 */
router.patch('/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || typeof currentPassword !== 'string' || !newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { passwordHash: true },
    });
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const valid = await comparePassword(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[auth/password]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /auth/verify-email?token=xxx
 * Подтверждение почты по ссылке из письма. Возвращает HTML-страницу.
 */
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      res.status(400).type('html').send(getVerificationPageHtml('Неверная ссылка', 'Ссылка недействительна или устарела.'));
      return;
    }
    const user = await prisma.user.findFirst({
      where: { emailVerifyToken: token },
    });
    if (!user) {
      res.status(400).type('html').send(getVerificationPageHtml('Ссылка недействительна', 'Ссылка не найдена или уже использована.'));
      return;
    }
    if (user.emailVerifyTokenExpiresAt && new Date() > user.emailVerifyTokenExpiresAt) {
      res.status(400).type('html').send(getVerificationPageHtml('Ссылка устарела', 'Срок действия ссылки истёк. Запросите новое письмо в приложении.'));
      return;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerifyToken: null, emailVerifyTokenExpiresAt: null },
    });
    res.type('html').send(getVerificationSuccessHtml());
  } catch (err) {
    console.error('[auth/verify-email]', err);
    res.status(500).type('html').send(getVerificationPageHtml('Ошибка', 'Произошла ошибка. Попробуйте позже.'));
  }
});

/**
 * POST /auth/resend-verification
 * Body: { email }
 * Отправляет повторное письмо с ссылкой подтверждения.
 */
router.post('/resend-verification', strictLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email already verified' });
    }
    const emailVerifyToken = crypto.randomBytes(32).toString('hex');
    const emailVerifyTokenExpiresAt = new Date(Date.now() + EMAIL_VERIFY_EXPIRY_HOURS * 60 * 60 * 1000);
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifyToken, emailVerifyTokenExpiresAt },
    });
    await sendVerificationEmail(normalizedEmail, emailVerifyToken);
    res.json({ message: 'Письмо с ссылкой отправлено повторно.' });
  } catch (err) {
    console.error('[auth/resend-verification]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Отправляет письмо со ссылкой для сброса пароля. Всегда 200, чтобы не раскрывать наличие email.
 */
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail) {
      return res.status(400).json({ error: 'Email is required' });
    }
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000);
      await prisma.passwordResetToken.create({
        data: { userId: user.id, token, expiresAt },
      });
      await sendPasswordResetEmail(normalizedEmail, token);
    }
    res.json({ message: 'Если такой email зарегистрирован, на него отправлена ссылка для сброса пароля.' });
  } catch (err) {
    console.error('[auth/forgot-password]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /auth/reset-password?token=xxx
 * Страница с формой «Новый пароль». POST на этот же URL.
 */
router.get('/reset-password', (req, res) => {
  const token = req.query.token;
  const actionUrl = `${BASE_URL}/auth/reset-password`;
  res.type('html').send(getResetPasswordFormHtml(actionUrl, token || ''));
});

/**
 * POST /auth/reset-password
 * Body: { token, newPassword, newPasswordConfirm }
 * Устанавливает новый пароль по токену из письма.
 */
router.post('/reset-password', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { token, newPassword, newPasswordConfirm } = req.body;
    if (!token || typeof token !== 'string') {
      return res.type('html').status(400).send(getResetPasswordFormHtml(`${BASE_URL}/auth/reset-password`, token, 'Неверная ссылка.'));
    }
    if (!newPassword || newPassword.length < 6) {
      return res.type('html').status(400).send(getResetPasswordFormHtml(`${BASE_URL}/auth/reset-password`, token, 'Пароль должен быть не менее 6 символов.'));
    }
    if (newPassword !== newPasswordConfirm) {
      return res.type('html').status(400).send(getResetPasswordFormHtml(`${BASE_URL}/auth/reset-password`, token, 'Пароли не совпадают.'));
    }
    const record = await prisma.passwordResetToken.findFirst({
      where: { token },
      include: { user: true },
    });
    if (!record || new Date() > record.expiresAt) {
      return res.type('html').status(400).send(getResetPasswordFormHtml(`${BASE_URL}/auth/reset-password`, '', 'Ссылка недействительна или устарела.'));
    }
    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      }),
      prisma.passwordResetToken.delete({ where: { id: record.id } }),
    ]);
    res.type('html').send(getResetSuccessHtml());
  } catch (err) {
    console.error('[auth/reset-password]', err);
    res.type('html').status(500).send(getResetPasswordFormHtml(`${BASE_URL}/auth/reset-password`, req.body?.token, 'Ошибка. Попробуйте позже.'));
  }
});

module.exports = router;
