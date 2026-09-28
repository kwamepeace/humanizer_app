const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createPaystack } = require('../src/paystack');

const SECRET = 'sk_test_secret';

let server, baseUrl, ctx, transactions, delivered, deliveryWorks, dataDir;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanizer-test-'));
  transactions = new Map();
  delivered = [];
  deliveryWorks = true;

  const paystack = {
    ...createPaystack({ secretKey: SECRET, apiBase: 'http://unused' }),
    async initialize(params) {
      transactions.set(params.reference, { ...params, status: 'abandoned' });
      return { access_code: `ac_${params.reference}`, reference: params.reference };
    },
    async verify(reference) {
      const tx = transactions.get(reference);
      return { reference, status: tx.status, amount: Number(tx.paidAmount ?? tx.amount), currency: tx.currency };
    },
  };
  const notifier = {
    async notifyOwner(order, filePath) {
      if (!deliveryWorks) return false;
      delivered.push({ reference: order.reference, content: fs.readFileSync(filePath, 'utf8'), order });
      return true;
    },
    async notifyCustomer() {
      return true;
    },
  };

  const config = loadConfig({ DATA_DIR: dataDir, PAYSTACK_SECRET_KEY: SECRET });
  ctx = createApp(config, { paystack, notifier });
  await new Promise((resolve) => {
    server = ctx.app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function orderForm(overrides = {}) {
  const fields = { name: 'Ama Mensah', email: 'ama@example.com', phone: '0240000000', ...overrides };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (k !== 'file' && v !== undefined) form.append(k, v);
  const file = overrides.file ?? { name: 'thesis.docx', content: 'my thesis text' };
  if (file) form.append('file', new Blob([file.content]), file.name);
  return form;
}

async function createOrder(overrides) {
  const res = await fetch(`${baseUrl}/api/orders`, { method: 'POST', body: orderForm(overrides) });
  return { res, body: await res.json() };
}

function confirm(reference) {
  return fetch(`${baseUrl}/api/orders/${reference}/confirm`, { method: 'POST' });
}

function signedWebhook(payload, secret = SECRET) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', secret).update(body).digest('hex');
  return fetch(`${baseUrl}/api/paystack/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
    body,
  });
}

test('serves the landing page with brand and price filled in', async () => {
  const html = await (await fetch(baseUrl)).text();
  assert.match(html, /Thesis Humanizer/);
  assert.match(html, /GHS 20/);
  assert.doesNotMatch(html, /\{\{/);
});

test('creates a GHS 20 Paystack transaction for a valid upload', async () => {
  const { res, body } = await createOrder();
  assert.equal(res.status, 200);
  assert.ok(body.reference);
  assert.equal(body.accessCode, `ac_${body.reference}`);
  const tx = transactions.get(body.reference);
  assert.equal(tx.amount, 2000);
  assert.equal(tx.currency, 'GHS');
  assert.equal(tx.email, 'ama@example.com');
});

test('rejects invalid uploads before any payment starts', async () => {
  assert.equal((await createOrder({ email: 'not-an-email' })).res.status, 400);
  assert.equal((await createOrder({ name: '' })).res.status, 400);
  assert.equal((await createOrder({ file: null })).res.status, 400);
  assert.equal((await createOrder({ file: { name: 'virus.exe', content: 'x' } })).res.status, 400);
  assert.equal(transactions.size, 0);
});

test('delivers the file to the owner only after Paystack confirms payment, exactly once', async () => {
  const { body } = await createOrder();

  assert.equal((await confirm(body.reference)).status, 402);
  assert.equal(delivered.length, 0);

  transactions.get(body.reference).status = 'success';
  const [a, b] = await Promise.all([confirm(body.reference), confirm(body.reference)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await confirm(body.reference)).status, 200);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].content, 'my thesis text');
  assert.equal(delivered[0].order.customer.name, 'Ama Mensah');
  assert.equal(ctx.store.get(body.reference).status, 'delivered');
});

test('keeps non-ASCII file names intact', async () => {
  const { body } = await createOrder({ file: { name: 'Thèse_Kwabena’s final.docx', content: 'x' } });
  assert.equal(ctx.store.get(body.reference).file.originalName, 'Thèse_Kwabena’s final.docx');
});

test('does not deliver when the customer paid less than the price', async () => {
  const { body } = await createOrder();
  Object.assign(transactions.get(body.reference), { status: 'success', paidAmount: 100 });
  assert.equal((await confirm(body.reference)).status, 402);
  assert.equal(delivered.length, 0);
});

test('returns 404 for unknown references', async () => {
  assert.equal((await confirm('TH-NOPE')).status, 404);
});

test('webhook with a valid signature delivers the order', async () => {
  const { body } = await createOrder();
  transactions.get(body.reference).status = 'success';

  const res = await signedWebhook({ event: 'charge.success', data: { reference: body.reference } });
  assert.equal(res.status, 200);
  await ctx.processOrder(body.reference);
  assert.equal(delivered.length, 1);
});

test('webhook with a bad signature is rejected', async () => {
  const { body } = await createOrder();
  transactions.get(body.reference).status = 'success';

  const res = await signedWebhook({ event: 'charge.success', data: { reference: body.reference } }, 'wrong');
  assert.equal(res.status, 401);
  assert.equal(delivered.length, 0);
});

test('keeps paid orders whose delivery failed and retries them on sweep', async () => {
  const { body } = await createOrder();
  transactions.get(body.reference).status = 'success';
  deliveryWorks = false;

  assert.equal((await confirm(body.reference)).status, 200);
  assert.equal(ctx.store.get(body.reference).status, 'paid');
  assert.equal(delivered.length, 0);

  deliveryWorks = true;
  await ctx.sweep();
  assert.equal(delivered.length, 1);
  assert.equal(ctx.store.get(body.reference).status, 'delivered');
});

test('sweep removes old unpaid orders', async () => {
  const { body } = await createOrder();
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  ctx.store.update(body.reference, { createdAt: old });

  await ctx.sweep();
  assert.equal(ctx.store.get(body.reference), undefined);
  assert.equal(fs.existsSync(path.join(dataDir, 'orders', body.reference)), false);
});
