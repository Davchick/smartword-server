const { env } = require('../config/env');

const BASE_URL = (env.appPublicUrl || '').replace(/\/$/, '');
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/**
 * Обёртка в стиле Apple: светлый фон, много воздуха, один акцент-цвет, минимализм.
 */
function appleWrapper({ title, preheader, bodyHtml, ctaText, ctaUrl, footerText }) {
  return `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(title)}</title>
  <!--[if mso]><noscript><meta http-equiv="X-UA-Compatible" content="IE=edge"></noscript><![endif]-->
  <style>
    body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
    .root { background-color: #f5f5f7; padding: 40px 20px; }
    .card { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 18px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
    .inner { padding: 48px 40px; }
    h1 { font-family: ${FONT_FAMILY}; font-size: 28px; font-weight: 600; color: #1d1d1f; margin: 0 0 8px; letter-spacing: -0.5px; line-height: 1.2; }
    .sub { font-family: ${FONT_FAMILY}; font-size: 17px; color: #86868b; margin: 0 0 32px; line-height: 1.4; }
    .body { font-family: ${FONT_FAMILY}; font-size: 17px; color: #1d1d1f; line-height: 1.5; margin: 0 0 32px; }
    .btn { display: inline-block; font-family: ${FONT_FAMILY}; font-size: 17px; font-weight: 500; color: #ffffff; background: #0071e3; text-decoration: none; padding: 14px 28px; border-radius: 12px; margin: 8px 0; }
    .footer { font-family: ${FONT_FAMILY}; font-size: 12px; color: #86868b; margin-top: 40px; padding-top: 24px; border-top: 1px solid #f0f0f2; }
    .preheader { display: none; max-height: 0; overflow: hidden; }
  </style>
</head>
<body>
  <div class="preheader">${escapeHtml(preheader)}</div>
  <div class="root">
    <div class="card">
      <div class="inner">
        <h1>${escapeHtml(title)}</h1>
        <p class="sub">${escapeHtml(preheader)}</p>
        <div class="body">${bodyHtml}</div>
        ${ctaUrl && ctaText ? `<a href="${escapeAttr(ctaUrl)}" class="btn">${escapeHtml(ctaText)}</a>` : ''}
        ${footerText ? `<p class="footer">${escapeHtml(footerText)}</p>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function getVerificationEmailHtml(verifyUrl) {
  return appleWrapper({
    title: 'Подтвердите вашу почту',
    preheader: 'Один шаг до входа в SmartWord',
    bodyHtml: `
      <p>Вы зарегистрировались в SmartWord. Нажмите кнопку ниже, чтобы подтвердить адрес электронной почты и начать пользоваться приложением.</p>
      <p>Ссылка действительна 24 часа. Если вы не создавали аккаунт, просто проигнорируйте это письмо.</p>
    `,
    ctaText: 'Подтвердить почту',
    ctaUrl: verifyUrl,
    footerText: 'SmartWord · Учите слова с умом',
  });
}

function getPasswordResetEmailHtml(resetUrl) {
  return appleWrapper({
    title: 'Сброс пароля',
    preheader: 'Запрос на восстановление пароля SmartWord',
    bodyHtml: `
      <p>Вы запросили сброс пароля. Нажмите кнопку ниже, чтобы задать новый пароль.</p>
      <p>Ссылка действительна 1 час. Если вы не запрашивали сброс, просто проигнорируйте это письмо — пароль не изменится.</p>
    `,
    ctaText: 'Задать новый пароль',
    ctaUrl: resetUrl,
    footerText: 'SmartWord · Учите слова с умом',
  });
}

function getVerificationSuccessHtml() {
  return appleWrapper({
    title: 'Почта подтверждена',
    preheader: 'Можно входить в приложение',
    bodyHtml: '<p>Ваш адрес электронной почты успешно подтверждён. Закройте эту страницу и войдите в приложение SmartWord.</p>',
    ctaText: null,
    ctaUrl: null,
    footerText: 'SmartWord',
  });
}

/** Страница верификации с произвольным заголовком и текстом (для успеха и ошибок). */
function getVerificationPageHtml(title, bodyText) {
  return appleWrapper({
    title,
    preheader: title,
    bodyHtml: `<p>${escapeHtml(bodyText)}</p>`,
    ctaText: null,
    ctaUrl: null,
    footerText: 'SmartWord',
  });
}

function getResetSuccessHtml() {
  return appleWrapper({
    title: 'Пароль изменён',
    preheader: 'Войдите с новым паролем',
    bodyHtml: '<p>Пароль успешно изменён. Закройте эту страницу и войдите в приложение с новым паролем.</p>',
    ctaText: null,
    ctaUrl: null,
    footerText: 'SmartWord',
  });
}

/**
 * Страница с формой «Новый пароль» для сброса по ссылке из письма.
 * actionUrl — куда отправлять POST (token подставится в форму).
 */
function getResetPasswordFormHtml(actionUrl, token, errorMessage = '') {
  const tokenField = token ? `<input type="hidden" name="token" value="${escapeAttr(token)}">` : '';
  const errBlock = errorMessage ? `<p style="color: #d32f2f; font-size: 15px; margin-bottom: 16px;">${escapeHtml(errorMessage)}</p>` : '';
  return `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Новый пароль — SmartWord</title>
  <style>
    body { margin: 0; padding: 0; font-family: ${FONT_FAMILY}; -webkit-text-size-adjust: 100%; background: #f5f5f7; padding: 40px 20px; }
    .card { max-width: 400px; margin: 0 auto; background: #fff; border-radius: 18px; padding: 40px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
    h1 { font-size: 24px; font-weight: 600; color: #1d1d1f; margin: 0 0 8px; }
    .sub { font-size: 15px; color: #86868b; margin: 0 0 24px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 14px 16px; font-size: 17px; border: 1px solid #d2d2d7; border-radius: 12px; margin-bottom: 16px; }
    .btn { width: 100%; padding: 14px; font-size: 17px; font-weight: 500; color: #fff; background: #0071e3; border: none; border-radius: 12px; cursor: pointer; font-family: inherit; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Новый пароль</h1>
    <p class="sub">Введите новый пароль (минимум 6 символов).</p>
    ${errBlock}
    <form method="post" action="${escapeAttr(actionUrl)}">
      ${tokenField}
      <input type="password" name="newPassword" placeholder="Новый пароль" minlength="6" required autocomplete="new-password">
      <input type="password" name="newPasswordConfirm" placeholder="Повторите пароль" minlength="6" required autocomplete="new-password">
      <button type="submit" class="btn">Сохранить пароль</button>
    </form>
  </div>
</body>
</html>`;
}

module.exports = {
  getVerificationEmailHtml,
  getPasswordResetEmailHtml,
  getVerificationSuccessHtml,
  getVerificationPageHtml,
  getResetSuccessHtml,
  getResetPasswordFormHtml,
  BASE_URL,
};
