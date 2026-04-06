const nodemailer = require('nodemailer');
const { getTransporter, getTransporterOrTest } = require('./transporter');
const {
  getVerificationEmailHtml,
  getPasswordResetEmailHtml,
  BASE_URL,
} = require('./templates');
const { env } = require('../config/env');

async function sendMail({ to, subject, html }) {
  let transport = getTransporter();
  if (!transport) transport = await getTransporterOrTest();
  if (!transport) {
    console.warn('[email] SMTP not configured. Skipping send.');
    return { skipped: true };
  }
  
  console.log(`[email] Sending email to ${to} with subject: ${subject}`);
  
  try {
    const info = await transport.sendMail({
      from: env.mailFrom || 'noreply@smartword.app',
      to,
      subject,
      html,
    });
    
    console.log(`[email] Message sent to ${to}: ${info.messageId}`);
    
    if (nodemailer.getTestMessageUrl) {
      const url = nodemailer.getTestMessageUrl(info);
      if (url) {
        console.log(`[email] Ethereal test message URL: ${url}`);
        console.log(`[email] === ETHereal LINK FOR ${to}: ${url} ===`);
      }
    }
    
    return { sent: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[email] Failed to send email to ${to}:`, error.message);
    return { error: error.message };
  }
}

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${BASE_URL}/auth/verify-email?token=${encodeURIComponent(token)}`;
  const html = getVerificationEmailHtml(verifyUrl);
  return sendMail({
    to: email,
    subject: 'Подтвердите почту — SmartWord',
    html,
  });
}

async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${BASE_URL}/auth/reset-password?token=${encodeURIComponent(token)}`;
  const html = getPasswordResetEmailHtml(resetUrl);
  return sendMail({
    to: email,
    subject: 'Сброс пароля — SmartWord',
    html,
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendMail,
};
