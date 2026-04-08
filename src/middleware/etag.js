/**
 * ETag middleware для API endpoint'ов.
 * 
 * Вычисляет ETag из JSON response body и поддерживает If-None-Match / 304 Not Modified.
 * Это экономит трафик и нагрузку на БД — клиент React Query получает 304 и использует кэш.
 * 
 * Работает ТОЛЬКО для GET-запросов. Для POST/PATCH/DELETE ETag не имеет смысла.
 */
const crypto = require('crypto');

function etagMiddleware(req, res, next) {
  // ETag имеет смысл только для GET
  if (req.method !== 'GET') return next();

  // Пропускаем health check и ошибки
  if (req.path === '/health') return next();

  // Перехватываем res.json
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    // Пропускаем если ответ уже отправлен
    if (res.headersSent) return;

    // Вычисляем ETag из тела ответа
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const etag = `"${crypto.createHash('md5').update(bodyStr).digest('hex').slice(0, 16)}"`;

    // Проверяем If-None-Match от клиента
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch === etag) {
      res.set('ETag', etag);
      // Cache-Control: можно кэшировать, но с валидацией
      res.set('Cache-Control', 'private, no-cache, must-revalidate');
      return res.status(304).end();
    }

    // Устанавливаем ETag и отправляем обычный ответ
    res.set('ETag', etag);
    // Для GET-запросов с ETag меняем Cache-Control — разрешаем кэш с валидацией
    // React Query будет использовать ETag при refetch
    res.set('Cache-Control', 'private, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    return originalJson(body);
  };

  next();
}

module.exports = { etagMiddleware };
