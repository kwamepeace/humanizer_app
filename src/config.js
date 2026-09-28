const path = require('node:path');

function loadConfig(env = process.env) {
  const priceGhs = Number(env.PRICE_GHS || 20);
  const smtpUser = env.SMTP_USER || '';

  return {
    port: Number(env.PORT || 3000),
    brandName: env.BRAND_NAME || 'Thesis Humanizer',
    supportEmail: env.SUPPORT_EMAIL || smtpUser,
    turnaround: env.TURNAROUND || '24 hours',
    priceGhs,
    // Paystack amounts are in the smallest unit (pesewas for GHS).
    amountPesewas: Math.round(priceGhs * 100),
    currency: 'GHS',
    maxFileMb: Number(env.MAX_FILE_MB || 15),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),

    paystackSecretKey: env.PAYSTACK_SECRET_KEY || '',
    paystackApiBase: env.PAYSTACK_API_BASE || 'https://api.paystack.co',

    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    telegramApiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org',

    smtpHost: env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: Number(env.SMTP_PORT || 465),
    smtpUser,
    smtpPass: env.SMTP_PASS || '',
    notifyEmail: env.NOTIFY_EMAIL || smtpUser,
  };
}

module.exports = { loadConfig };
