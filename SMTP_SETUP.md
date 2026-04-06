# Настройка SMTP для SmartWord

## Проблема

Без настроенного SMTP письма с подтверждением email не отправляются, и пользователи не могут войти после регистрации.

## Варианты настройки SMTP

### Вариант 1: Gmail (рекомендуется для начала)

1. Зайдите в аккаунт Google
2. Включите двухфакторную аутентификацию
3. Создайте пароль приложения:
   - https://myaccount.google.com/apppasswords
   - Выберите "Mail" и ваше устройство
   - Скопируйте сгенерированный пароль

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=app-password-from-google
MAIL_FROM=noreply@smart-word.ru
```

### Вариант 2: Yandex Mail

```env
SMTP_HOST=smtp.yandex.ru
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@yandex.ru
SMTP_PASS=your-password-or-app-password
MAIL_FROM=noreply@smart-word.ru
```

### Вариант 3: Mailtrap (для тестирования)

Бесплатный сервис для тестирования писем:

1. Зарегистрируйтесь на https://mailtrap.io
2. Создайте inbox
3. Скопируйте SMTP настройки

```env
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-mailtrap-username
SMTP_PASS=your-mailtrap-password
MAIL_FROM=noreply@smart-word.ru
```

### Вариант 4: Ethereal (автоматически, без регистрации)

Если SMTP не настроен, сервер автоматически использует Ethereal Email:

- Письма не отправляются на реальную почту
- Ссылка для просмотра письма появляется в логах сервера
- Удобно для локальной разработки

**В логах сервера ищите:**
```
[email] === ETHEREAL LINK FOR user@example.com: https://ethereal.email/message/xxx ===
```

## Проверка работы

После настройки SMTP:

1. Перезапустите сервер:
   ```bash
   cd server
   npm run dev
   ```

2. Зарегистрируйтесь в приложении

3. Проверьте логи сервера:
   ```
   [email] Sending email to user@example.com with subject: Подтвердите почту — SmartWord
   [email] Message sent to user@example.com: <message-id>
   ```

4. Если видите ссылку Ethereal — откройте её в браузере и кликните по ссылке подтверждения

## Для продакшена

Обязательно используйте реальный SMTP (Gmail, Yandex, SendGrid, Mailgun и т.д.)

### Рекомендуемые сервисы для production:

| Сервис | Бесплатный лимит | Ссылка |
|--------|-----------------|--------|
| Gmail | 500 писем/день | built-in |
| Yandex | 1000 писем/день | yandex.ru |
| SendGrid | 100 писем/день | sendgrid.com |
| Mailgun | 5000 писем/месяц | mailgun.com |
| Resend | 3000 писем/месяц | resend.com |

## Troubleshooting

### Ошибка "SMTP not configured"

- Проверьте, что все SMTP переменные установлены в `.env`
- Перезапустите сервер после изменения `.env`

### Письма не приходят

1. Проверьте логи сервера на наличие ошибок
2. Убедитесь, что порт 587 открыт
3. Для Gmail/Yandex убедитесь, что используете пароль приложения (не основной пароль)

### Ошибка аутентификации SMTP

- Для Gmail используйте пароль приложения, не основной пароль
- Проверьте, что включена двухфакторная аутентификация
- Убедитесь, что SMTP_USER это полный email
