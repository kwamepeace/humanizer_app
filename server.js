const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');
const { createNotifier } = require('./src/notify');

const config = loadConfig();

if (!config.paystackSecretKey) {
  console.error('PAYSTACK_SECRET_KEY is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const notifier = createNotifier(config);
const channels = notifier.channels();
if (channels.length === 0) {
  console.warn('WARNING: no delivery channel configured (Telegram or SMTP). Paid files will stay in', config.dataDir);
}

const { app, sweep } = createApp(config, { notifier });

setInterval(() => sweep().catch((err) => console.error('[sweep]', err)), 5 * 60 * 1000).unref();

app.listen(config.port, () => {
  console.log(`${config.brandName} running on http://localhost:${config.port}`);
  console.log(`Price: GHS ${config.priceGhs} | delivery: ${channels.join(' + ') || 'none'}`);
});
