/**
 * Request logging middleware.
 * Логирует каждый запрос: метод, путь, статус-код, время выполнения.
 * 
 * Критично для продакшена — без логов невозможно диагностировать проблемы
 * при 250K пользователей.
 */

function requestLogger(req, res, next) {
  const start = Date.now();
  const method = req.method;
  const url = req.originalUrl || req.url;

  // Логируем после завершения ответа
  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    
    // Цветовой код для консоли (только если NODE_ENV !== 'production')
    const isDev = process.env.NODE_ENV !== 'production';
    let statusColor = '';
    if (isDev) {
      if (status >= 500) statusColor = '\x1b[31m'; // red
      else if (status >= 400) statusColor = '\x1b[33m'; // yellow
      else statusColor = '\x1b[32m'; // green
    }
    
    const reset = isDev ? '\x1b[0m' : '';
    
    // Формат: [REQUEST] POST /api/words 200 45ms
    console.log(
      `[REQUEST] ${method} ${url} ${statusColor}${status}${reset} ${duration}ms`
    );

    // Логируем медленные запросы (>1s) отдельно
    if (duration > 1000) {
      console.warn(
        `[SLOW REQUEST] ${method} ${url} ${status} ${duration}ms`
      );
    }
  });

  next();
}

module.exports = { requestLogger };
