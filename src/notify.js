const fs = require('node:fs');
const nodemailer = require('nodemailer');

function formatGhs(pesewas) {
  return `GHS ${(pesewas / 100).toFixed(2)}`;
}

function orderSummary(order) {
  const c = order.customer;
  return [
    `New paid order ${order.reference}`,
    `Name: ${c.name}`,
    `Email: ${c.email}`,
    c.phone ? `Phone/WhatsApp: ${c.phone}` : null,
    `Paid: ${formatGhs(order.amountPesewas)}`,
    `File: ${order.file.originalName} (${(order.file.size / 1024 / 1024).toFixed(2)} MB)`,
    c.notes ? `Notes: ${c.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// Sends paid orders to the owner (Telegram and/or email) and a receipt to the
// customer. Customer-facing messages only ever carry the brand name.
function createNotifier(config) {
  const telegramEnabled = Boolean(config.telegramBotToken && config.telegramChatId);
  const mailer =
    config.smtpUser && config.smtpPass
      ? nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.smtpPort === 465,
          auth: { user: config.smtpUser, pass: config.smtpPass },
        })
      : null;
  const from = `"${config.brandName}" <${config.smtpUser}>`;

  async function sendTelegram(order, filePath) {
    const form = new FormData();
    form.append('chat_id', config.telegramChatId);
    form.append('caption', orderSummary(order).slice(0, 1024));
    form.append('document', new Blob([fs.readFileSync(filePath)]), order.file.originalName);
    const res = await fetch(`${config.telegramApiBase}/bot${config.telegramBotToken}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error(`Telegram sendDocument failed (${res.status}): ${await res.text()}`);
  }

  async function sendOwnerEmail(order, filePath) {
    await mailer.sendMail({
      from,
      to: config.notifyEmail,
      // Hitting "Reply" goes straight to the customer, from the brand address.
      replyTo: order.customer.email,
      subject: `[${order.reference}] New order from ${order.customer.name}`,
      text: `${orderSummary(order)}\n\nReply to this email and attach the finished document to send it to the customer.`,
      attachments: [{ filename: order.file.originalName, path: filePath }],
    });
  }

  return {
    channels() {
      return [telegramEnabled && 'telegram', mailer && 'email'].filter(Boolean);
    },

    // Resolves true if at least one owner channel received the file.
    async notifyOwner(order, filePath) {
      const jobs = [];
      if (telegramEnabled) jobs.push(sendTelegram(order, filePath));
      if (mailer && config.notifyEmail) jobs.push(sendOwnerEmail(order, filePath));
      const results = await Promise.allSettled(jobs);
      for (const r of results) {
        if (r.status === 'rejected') console.error(`[notify] ${order.reference}:`, r.reason.message);
      }
      return results.some((r) => r.status === 'fulfilled');
    },

    async notifyCustomer(order) {
      if (!mailer) return false;
      await mailer.sendMail({
        from,
        to: order.customer.email,
        replyTo: config.supportEmail || undefined,
        subject: `We've received your document (${order.reference})`,
        text: [
          `Hi ${order.customer.name},`,
          '',
          `Thanks for your payment of ${formatGhs(order.amountPesewas)}. We've received "${order.file.originalName}".`,
          `Your humanized document will be sent to this email within ${config.turnaround}.`,
          '',
          `Order reference: ${order.reference}`,
          '',
          `— ${config.brandName}`,
        ].join('\n'),
      });
      return true;
    },
  };
}

module.exports = { createNotifier, orderSummary };
