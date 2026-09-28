const crypto = require('node:crypto');

function createPaystack({ secretKey, apiBase }) {
  async function call(method, pathname, body) {
    const res = await fetch(`${apiBase}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.status) {
      throw new Error(`Paystack ${method} ${pathname} failed (${res.status}): ${json.message || 'no message'}`);
    }
    return json.data;
  }

  return {
    // Returns { authorization_url, access_code, reference }.
    initialize({ email, amount, currency, reference, metadata }) {
      return call('POST', '/transaction/initialize', {
        email,
        amount: String(amount),
        currency,
        reference,
        channels: ['mobile_money', 'card'],
        metadata,
      });
    },

    // Returns the transaction; `status` is "success" once paid.
    verify(reference) {
      return call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    },

    isValidWebhook(rawBody, signature) {
      if (!signature || !Buffer.isBuffer(rawBody)) return false;
      const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(String(signature));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

module.exports = { createPaystack };
