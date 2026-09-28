const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { createPaystack } = require('./paystack');
const { createOrderStore } = require('./orders');
const { createNotifier } = require('./notify');

const ALLOWED_EXTENSIONS = ['.doc', '.docx', '.pdf', '.odt', '.rtf', '.txt'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUR = 60 * 60 * 1000;
const UNPAID_TTL = 6 * HOUR;
const DELIVERED_TTL = 48 * HOUR;
const UPLOADS_PER_IP_PER_HOUR = 10;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

function createApp(config, overrides = {}) {
  const paystack =
    overrides.paystack ||
    createPaystack({ secretKey: config.paystackSecretKey, apiBase: config.paystackApiBase });
  const notifier = overrides.notifier || createNotifier(config);
  const store = createOrderStore(config.dataDir);

  const upload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8', // browsers send UTF-8 file names
    limits: { fileSize: config.maxFileMb * 1024 * 1024, files: 1 },
    fileFilter(req, file, cb) {
      const ok = ALLOWED_EXTENSIONS.includes(path.extname(file.originalname).toLowerCase());
      cb(ok ? null : Object.assign(new Error('Please upload a Word, PDF, ODT, RTF or TXT file.'), { status: 400 }), ok);
    },
  });

  // Simple in-memory limiter so nobody can fill the disk with unpaid uploads.
  const uploadsByIp = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const recent = (uploadsByIp.get(ip) || []).filter((t) => now - t < HOUR);
    recent.push(now);
    uploadsByIp.set(ip, recent);
    return recent.length > UPLOADS_PER_IP_PER_HOUR;
  }

  // Verifies payment with Paystack and hands the file to the owner. Safe to call
  // many times (browser confirm, webhook, retry loop) — work runs once per order.
  const inFlight = new Map();
  function processOrder(reference) {
    if (!inFlight.has(reference)) {
      const job = doProcessOrder(reference).finally(() => inFlight.delete(reference));
      inFlight.set(reference, job);
    }
    return inFlight.get(reference);
  }

  async function doProcessOrder(reference) {
    let order = store.get(reference);
    if (!order) return { found: false };

    if (order.status === 'pending') {
      const tx = await paystack.verify(reference);
      const paid =
        tx.status === 'success' &&
        tx.reference === reference &&
        tx.currency === order.currency &&
        Number(tx.amount) >= order.amountPesewas;
      if (!paid) return { found: true, paid: false };
      order = store.update(reference, { status: 'paid', paidAt: new Date().toISOString() });
    }

    if (order.status === 'paid') {
      const delivered = await notifier.notifyOwner(order, store.filePath(order));
      if (!delivered) {
        console.error(`[order] ${reference} is paid but could not be delivered; will retry.`);
        return { found: true, paid: true };
      }
      order = store.update(reference, { status: 'delivered', deliveredAt: new Date().toISOString() });
      console.log(`[order] ${reference} delivered.`);
      notifier.notifyCustomer(order).catch((err) => console.error(`[order] ${reference} receipt email failed:`, err.message));
    }

    return { found: true, paid: true };
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Paystack needs the raw body to check the signature, so this route comes
  // before any JSON parsing.
  app.post('/api/paystack/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!paystack.isValidWebhook(req.body, req.get('x-paystack-signature'))) {
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return;
    }
    if (event.event === 'charge.success' && event.data?.reference) {
      processOrder(event.data.reference).catch((err) => console.error('[webhook]', err.message));
    }
  });

  const indexTemplate = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const indexHtml = indexTemplate
    .replaceAll('{{BRAND}}', escapeHtml(config.brandName))
    .replaceAll('{{PRICE}}', escapeHtml(config.priceGhs))
    .replaceAll('{{TURNAROUND}}', escapeHtml(config.turnaround))
    .replaceAll('{{MAX_MB}}', escapeHtml(config.maxFileMb))
    .replaceAll('{{SUPPORT_EMAIL}}', escapeHtml(config.supportEmail));
  app.get('/', (req, res) => res.type('html').send(indexHtml));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Step 1: save the upload and open a Paystack transaction for it.
  app.post('/api/orders', (req, res, next) => {
    if (rateLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many uploads. Please try again later.' });
    }
    next();
  }, upload.single('file'), async (req, res) => {
    const customer = {
      name: clean(req.body.name, 100),
      email: clean(req.body.email, 200).toLowerCase(),
      phone: clean(req.body.phone, 30),
      notes: clean(req.body.notes, 1000),
    };
    if (!customer.name) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL_RE.test(customer.email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!req.file || req.file.size === 0) return res.status(400).json({ error: 'Please attach your document.' });

    const reference = store.newReference();
    store.create({
      reference,
      customer,
      file: { originalName: path.basename(req.file.originalname), buffer: req.file.buffer },
      amountPesewas: config.amountPesewas,
      currency: config.currency,
    });

    try {
      const tx = await paystack.initialize({
        email: customer.email,
        amount: config.amountPesewas,
        currency: config.currency,
        reference,
        metadata: {
          custom_fields: [
            { display_name: 'Customer name', variable_name: 'customer_name', value: customer.name },
            { display_name: 'Document', variable_name: 'document', value: req.file.originalname },
          ],
        },
      });
      res.json({ reference, accessCode: tx.access_code });
    } catch (err) {
      console.error('[orders] Paystack initialize failed:', err.message);
      store.remove(reference);
      res.status(502).json({ error: 'Could not start the payment. Please try again in a moment.' });
    }
  });

  // Step 2: the browser calls this after the Paystack popup reports success.
  app.post('/api/orders/:reference/confirm', async (req, res) => {
    try {
      const result = await processOrder(req.params.reference);
      if (!result.found) return res.status(404).json({ error: 'Order not found.' });
      if (!result.paid) return res.status(402).json({ status: 'pending' });
      res.json({ status: 'received', reference: req.params.reference });
    } catch (err) {
      console.error('[confirm]', err.message);
      res.status(502).json({ error: 'Could not confirm the payment yet. Please try again.' });
    }
  });

  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File is too large. Maximum size is ${config.maxFileMb} MB.` });
    }
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error('[server]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  // Housekeeping: retry stuck deliveries and delete old files.
  async function sweep() {
    const now = Date.now();
    for (const order of store.all()) {
      const age = now - Date.parse(order.createdAt);
      if (order.status === 'paid') {
        await processOrder(order.reference).catch((err) => console.error('[sweep]', err.message));
      } else if (order.status === 'pending' && age > UNPAID_TTL) {
        // Last check in case both the browser confirm and the webhook were missed.
        const result = await processOrder(order.reference).catch((err) => {
          console.error('[sweep]', err.message);
          // Paystack unreachable: keep the order for the next sweep, but not forever.
          return { paid: age < 24 * HOUR };
        });
        if (!result.paid) store.remove(order.reference);
      } else if (order.status === 'delivered' && now - Date.parse(order.deliveredAt) > DELIVERED_TTL) {
        store.remove(order.reference);
      }
    }
    for (const [ip, times] of uploadsByIp) {
      if (times.every((t) => now - t > HOUR)) uploadsByIp.delete(ip);
    }
  }

  return { app, store, processOrder, sweep };
}

module.exports = { createApp };
