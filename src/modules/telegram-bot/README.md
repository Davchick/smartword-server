# Telegram Bot Module (FROZEN ❄️)

## Статус

**Бот отключен** до востребования.

---

## Структура модуля

```
server/src/modules/telegram-bot/
├── index.js              # Точка входа (включает/выключает бота)
├── bot.config.js         # Конфигурация
├── bot.service.js        # Telegram API сервис
├── bot.handlers.js       # Обработчики сообщений и callback
├── bot.polling.js        # Long-polling цикл
├── ticket.db.js          # SQLite база тикетов
└── README.md             # Этот файл
```

---

## Как включить

1. **Настройте переменные окружения** в `.env`:

```env
TELEGRAM_BOT_ENABLED=true
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TELEGRAM_ADMIN_CHAT_ID=your_admin_chat_id
```

2. **Перезапустите сервер**:

```bash
cd server
npm run dev
```

3. **Проверьте логи**:

```
[Telegram Bot] Module enabled
[Telegram Bot] Starting long-polling...
```

---

## Функционал

### Для пользователей:
- `/start` — приветствие
- `/help` — справка
- Создание тикета при отправке сообщения
- Получение ответов от админа

### Для админа:
- Уведомления о новых тикетах
- Кнопки: "Ответить", "Закрыть", "История"
- Команды: `/new`, `/active`, `/closed`
- Ответ пользователю в режиме диалога

---

## База данных

SQLite база в `server/data/support_tickets.db`:

**Таблицы:**
- `tickets` — тикеты (id, user_id, status, created_at, updated_at)
- `messages` — сообщения (id, ticket_id, from_user, text, created_at)

**Индексы:**
- `idx_tickets_user` — по пользователю
- `idx_tickets_status` — по статусу
- `idx_messages_ticket` — по тику

---

## Архитектурные улучшения

### ✅ Что было исправлено:

| Red Flag | Было | Стало |
|----------|------|-------|
| **Спагетти-код** | Вся логика в `telegram.polling.js` | Разделение на сервис, хендлеры, конфиг |
| **Глобальное состояние** | `adminReplyState` в polling | В `bot.handlers.js` с четким назначением |
| **Прямые fetch запросы** | Везде в коде | Единый `bot.service.js` |
| **Хардкод значений** | Максимум update_id, таймауты | `bot.config.js` |
| **Нет модульности** | Один файл на 500+ строк | 6 модулей по 100-200 строк |

### ✅ Принципы:

1. **Single Responsibility** — каждый модуль отвечает за одно:
   - `bot.service.js` — только Telegram API
   - `bot.handlers.js` — только логика обработки
   - `bot.polling.js` — только long-polling цикл
   - `ticket.db.js` — только работа с БД

2. **Configuration** — все настройки в `bot.config.js`

3. **Error Handling** — централизованная обработка ошибок

4. **Logging** — понятные логи с контекстом

---

## Как это работает

```
┌─────────────┐
│  Telegram   │
│   API       │
└──────┬──────┘
       │ long-polling
       ▼
┌─────────────────────┐
│   bot.polling.js    │ ← Цикл получения обновлений
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│  bot.handlers.js    │ ← Обработка сообщений
└──────┬──────────────┘
       │
       ├──────► bot.service.js (отправка ответов)
       │
       └──────► ticket.db.js (сохранение тикетов)
```

---

## Команды бота

### Пользователь:
| Команда | Описание |
|---------|----------|
| `/start` | Приветствие и начало работы |
| `/help` | Справка по использованию |

### Админ:
| Команда | Описание |
|---------|----------|
| `/new` | Список новых тикетов |
| `/active` | Список активных тикетов |
| `/closed` | Список закрытых тикетов |

---

## Отключение бота

Для отключения установите в `.env`:

```env
TELEGRAM_BOT_ENABLED=false
```

Или просто не указывайте `TELEGRAM_BOT_TOKEN` и `TELEGRAM_ADMIN_CHAT_ID`.

В логах будет:
```
[Telegram Bot] Module disabled (frozen). Set TELEGRAM_BOT_ENABLED=true to enable.
```

---

## Будущие улучшения (когда разморозим)

- [ ] Webhook вместо polling (для production)
- [ ] Мульти-админ поддержка
- [ ] Экспорт тикетов в CSV
- [ ] Поиск по тикетам
- [ ] Теги для тикетов
- [ ] SLA мониторинг (время ответа)

---

## Контакты

При возникновении проблем обращайтесь к документации или в код модуля.
