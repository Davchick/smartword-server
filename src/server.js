const express = require('express');
const cors = require('cors');
const { env } = require('./config/env');
const { securityHeaders } = require('./middleware/securityHeaders');
const { etagMiddleware } = require('./middleware/etag');
const { apiLimiter } = require('./middleware/rateLimiter');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');

const app = express();

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  app.set('trust proxy', 1);
}

// Security first: Apply security headers to ALL routes
app.use(securityHeaders);

// CORS для мобильного приложения — разрешаем все запросы
// (у мобильного приложения нет origin, CORS не проверяется)
app.use(cors());

app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString();
  }
})); // Limit body size

// Request logging — каждый запрос: метод, путь, статус, время
app.use(requestLogger);

// Cache-Control headers для API
app.use(require('./middleware/cacheControl').cacheControl);

// ETag для GET-запросов — экономия трафика через 304 Not Modified
app.use(etagMiddleware);

// Healthcheck (no rate limiting for health checks)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Apply rate limiting to API routes
app.use('/auth', require('./middleware/rateLimiter').authLimiter);
app.use(apiLimiter);

const authRouter = require('./modules/auth/auth.routes');
const profileRouter = require('./modules/profile/profile.routes');
const groupsRouter = require('./modules/groups/groups.routes');
const wordsRouter = require('./modules/words/words.routes');
const statsRouter = require('./modules/stats/stats.routes');
const chatRouter = require('./modules/chat/chat.routes');
const billingRouter = require('./modules/billing/billing.routes');
const streaksRouter = require('./modules/streaks/streaks.routes');
const consentRouter = require('./modules/consent/consent.routes');

app.use('/auth', authRouter);
app.use('/profile', profileRouter);
app.use('/groups', groupsRouter);
app.use('/words', wordsRouter);
app.use('/stats', statsRouter);
app.use('/chat', chatRouter);
app.use('/billing', billingRouter);
app.use('/streaks', streaksRouter);
app.use('/consent', consentRouter);

// 404 handler for unknown routes
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

// Telegram bot long-polling (FROZEN - disabled by default)
// To enable: set TELEGRAM_BOT_ENABLED=true in .env
const { isEnabled: isTelegramEnabled } = require('./modules/telegram-bot');
if (isTelegramEnabled) {
  console.log('[Server] Telegram bot is enabled');
}

// Initialize cron jobs
const { initCronJobs } = require('./cron');
initCronJobs();

const port = env.port;

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API server listening on port ${port}`);
});

// Graceful shutdown for Render deploys
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('[Server] Closed. Process terminated.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  server.close(() => {
    process.exit(0);
  });
});

// Prevent crashes from unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
  // Не падаем — логируем и продолжаем
});

process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught Exception:', error);
  // Логируем, но не падаем — пусть сервер работает
});

// Handle client disconnects — abort in-flight AI requests
server.on('connection', (socket) => {
  socket.on('close', () => {
    // Socket closed — any in-flight request will get req.socket.destroyed = true
    // This is checked in chat.routes.js error handlers
  });
});

module.exports = server;

