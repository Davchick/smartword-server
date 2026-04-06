# SmartWord Server - Setup Guide

## 🚀 Быстрый старт (Разработка)

### 1. Установка зависимостей
```bash
cd server
npm install
```

### 2. Настройка окружения
```bash
# Создайте локальный конфиг для разработки
cp .env.example .env.development
```

### 3. Генерация секретов
```bash
# Сгенерируйте JWT секреты (минимум 32 символа)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Отредактируйте `.env.development` и вставьте сгенерированные секреты:
```env
JWT_SECRET=ваш_секрет_минимум_32_символа
JWT_REFRESH_SECRET=ваш_секрет_минимум_32_символа
```

### 4. Настройка базы данных
```bash
# Создайте PostgreSQL базу данных
# Обновите DATABASE_URL в .env.development

# Примените миграции
npx prisma migrate dev

# (Опционально) Откройте Prisma Studio
npx prisma studio
```

### 5. Запуск сервера
```bash
# Development режим (автоматическая перезагрузка)
npm run dev

# Для Windows
npm run dev:windows
```

Сервер запустится на **http://localhost:3000**

---

## 📱 Тестирование с мобильным приложением

### Вариант 1: Локально на компьютере (эмулятор)
В `client/.env`:
```env
EXPO_PUBLIC_API_URL=http://localhost:3000
```

### Вариант 2: На телефоне через Expo Go
1. Узнайте ваш локальный IP:
   ```bash
   ip addr show  # Linux
   ifconfig      # macOS
   ipconfig      # Windows
   ```

2. В `client/.env`:
   ```env
   EXPO_PUBLIC_API_URL=http://192.168.1.100:3000
   ```

3. Убедитесь, что телефон и компьютер в **одной Wi-Fi сети**

4. Отключите VPN на время разработки (или настройте исключения)

---

## 🔒 Production настройка

### 1. Создайте production конфиг
```bash
cp .env.example .env
```

### 2. Обязательные настройки для production

#### JWT Секреты
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### SMTP (обязательно для email)
```env
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=noreply@smartword.app
SMTP_PASS=your_password
```

#### Google OAuth
```env
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
```

#### YooKassa
```env
YOOKASSA_SHOP_ID=your_shop_id
YOOKASSA_SECRET_KEY=your_secret_key
```

### 3. Запуск production сервера
```bash
npm start
```

---

## 📁 Структура .env файлов

| Файл | Описание | Git |
|------|----------|-----|
| `.env.example` | Шаблон со всеми настройками | ✅ Коммитится |
| `.env.development` | Локальный конфиг для разработки | ❌ Игнорируется |
| `.env` | Production конфиг | ❌ Игнорируется |

### Приоритет загрузки

```
# Development (npm run dev)
.env.development > .env

# Production (npm start)
.env
```

---

## 🔍 Диагностика проблем

### JWT секрет слишком слабый
```
JWT_SECRET must be at least 32 characters long
```
**Решение:** Сгенерируйте новый секрет командой выше

### База данных не подключается
```
DATABASE_URL is required
```
**Решение:** Проверьте PostgreSQL и обновите URL подключения

---

## 🛡️ Security Checklist для Production

- [ ] JWT секреты сгенерированы (32+ символа)
- [ ] HTTPS настроен для API
- [ ] SMTP настроен для email
- [ ] Google OAuth настроен
- [ ] YooKassa настроен
- [ ] `.env` не содержит dev значений
- [ ] Брандмауэр настроен (порт 3000)
- [ ] Rate limiting активен
- [ ] Логи не содержат чувствительных данных

---

## 📝 Команды

| Команда | Описание |
|---------|----------|
| `npm run dev` | Запуск в dev режиме (nodemon) |
| `npm run dev:windows` | Запуск в dev режиме (Windows) |
| `npm start` | Запуск в production режиме |
| `npx prisma migrate dev` | Применить миграции |
| `npx prisma studio` | Открыть Prisma Studio |
| `npm test` | Запустить тесты |

---

## ⚠️ Важные заметки

### VPN и прокси
При разработке с Expo Go:
- Отключите VPN или настройте исключения для локальной сети
- Добавьте `no_proxy` для `192.168.*.*`

### Порты
- Сервер: **3000** (по умолчанию)
- Expo Dev Server: **19006** / **8081**
- Убедитесь, что порты не заняты

### Email в development
Без SMTP email будут логироваться в консоль (test mode).
