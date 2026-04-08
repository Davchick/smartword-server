#!/bin/bash
# Pre-commit hook: проверяем, что в .env*.файлах нет реальных секретов
# Если файлы уже в gitignore — это хорошо, но hook добавляет доп. защиту

# Паттерны реальных секретов (не placeholder'ы)
SECRET_PATTERNS=(
  'DATABASE_URL=postgresql://.*:.*@'
  'JWT_SECRET=[a-f0-9]\{64\}'
  'JWT_REFRESH_SECRET=[a-f0-9]\{64\}'
  'OPENROUTER_API_KEYS=sk-or-v1-[a-f0-9]'
  'SMTP_PASS=.+'
  'GOOGLE_CLIENT_ID=[0-9].*\.apps\.googleusercontent\.com'
  'YOOKASSA_SECRET_KEY=test_[a-zA-Z0-9]'
  'TELEGRAM_BOT_TOKEN=[0-9]*:[a-zA-Z0-9_-]'
)

# Проверяем только staged файлы
FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || echo "")

if [ -z "$FILES" ]; then
  exit 0
fi

for pattern in "${SECRET_PATTERNS[@]}"; do
  MATCHES=$(echo "$FILES" | xargs grep -l "$pattern" 2>/dev/null || true)
  if [ -n "$MATCHES" ]; then
    echo "❌ POTENTIAL SECRETS DETECTED in staged files!"
    echo "   Pattern: $pattern"
    echo "   Files: $MATCHES"
    echo ""
    echo "   If these are real secrets, DO NOT commit them."
    echo "   Use placeholder values or add to .gitignore"
    exit 1
  fi
done

exit 0
