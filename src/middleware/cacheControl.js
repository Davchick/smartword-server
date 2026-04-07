/**
 * Cache-Control middleware для API endpoint'ов.
 * React Query обрабатывает клиентский кэш — сервер говорит браузеру не кэшировать.
 * Предотвращает случайное кэширование CDN/proxy.
 */
function cacheControl(req, res, next) {
  // Health check можно кэшировать на 30 сек
  if (req.path === '/health') {
    res.setHeader('Cache-Control', 'public, max-age=30');
    return next();
  }

  // Для всех API ответов — не кэшировать на уровне HTTP.
  // Кэширование handled by React Query на клиенте.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  next();
}

module.exports = { cacheControl };
