const nodemailer = require('nodemailer');
const { env } = require('../config/env');

let cachedTestTransporter = null;

function getTransporter() {
  if (env.smtpHost && env.smtpUser) {
    return nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass,
      },
    });
  }
  return null;
}

/** Для разработки: если SMTP не настроен, создаём тестовый ящик Ethereal (бесплатно, без регистрации). */
async function getTransporterOrTest() {
  const real = getTransporter();
  if (real) return real;
  if (cachedTestTransporter) return cachedTestTransporter.transport;
  const testAccount = await nodemailer.createTestAccount();
  cachedTestTransporter = {
    transport: nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    }),
    user: testAccount.user,
  };
  console.log('[email] SMTP не настроен — используем тестовый ящик Ethereal. Письма не уйдут на реальную почту, ссылку на просмотр смотри в логах после отправки.');
  return cachedTestTransporter.transport;
}

module.exports = { getTransporter, getTransporterOrTest };
