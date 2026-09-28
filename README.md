# Thesis Humanizer

A small, fast website where customers:

1. fill in their name, email, and (optionally) WhatsApp number, then attach their thesis
2. pay a flat **GHS 20** through Paystack (Mobile Money or card)
3. see a confirmation, and get a receipt by email

As soon as Paystack confirms the payment, **you** get the document on Telegram, by email, or both, along with the customer's details. Customers only ever see your **brand name**. Your personal name, phone number, and email never appear on the site or in any message they get.

## How it works

```
Customer                         This server                     You
────────                         ───────────                     ───
Fill form + attach file ──────►  Save file, create Paystack
                                 transaction (GHS 20)
Paystack popup (MoMo/card) ◄──── access code
Pays ─────────────────────────►  Verify with Paystack API ─────► Telegram message with the file
                                 (also via webhook)              and/or email with the file attached
"Got it!" + email receipt  ◄────
                                                                 Reply to the order email with the
                                                                 finished doc → customer gets it
                                                                 from your brand address
```

- The file is uploaded **before** payment, so a failed upload never costs the customer money.
- Payment is always verified server-side with your secret key, and the amount and currency are checked. Nobody can fake a payment from the browser.
- If the customer closes the tab right after paying, the Paystack **webhook** still delivers the order.
- If Telegram or email is down, paid orders are kept and retried every 5 minutes.
- Files are deleted from the server 48 hours after delivery. Unpaid uploads are deleted after 6 hours.

## Setup

### 1. Paystack
1. Create an account at paystack.com and activate it for Ghana.
2. **Stay anonymous:** under *Settings → Business*, set a **trading name** (your brand) and use your brand's support email and phone. That trading name is what customers see on the checkout and on their receipts.
3. Copy your **secret key** from *Settings → API Keys & Webhooks*. Start with `sk_test_…`.
4. Once the site is deployed, set the **Webhook URL** on the same page to
   `https://YOUR-SITE/api/paystack/webhook`

### 2. Choose how you receive files (one or both)

**Telegram (instant, on your phone). Recommended.**
1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token.
2. Send your new bot any message.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id": …}`.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

**Email (best for sending the finished work back).**
1. Create a **separate Gmail for the brand** (e.g. `yourbrand.help@gmail.com`). Don't use your personal one.
2. Turn on 2-Step Verification, then create an **App Password**.
3. Set `SMTP_USER` (the brand Gmail) and `SMTP_PASS` (the app password).

With email configured, customers also get a branded receipt, and each new order lands in the brand inbox with the thesis attached. Hitting **Reply** addresses it to the customer, so you attach the finished document and send it from your brand address.

### 3. Run locally
```bash
cp .env.example .env     # fill in your values
npm install
npm run dev              # http://localhost:3000
```
Test payments with Paystack's test cards and test mobile money numbers (see the Paystack docs, "Test Payments").

### 4. Deploy (about 5 minutes on Render)
1. Push this repo to GitHub, then on render.com choose **New → Web Service** and pick the repo.
2. Build command `npm install`, start command `npm start`.
3. Add the variables from `.env.example` under **Environment**.
4. Put the Render URL into Paystack's webhook setting (step 1.4), then switch to your `sk_live_…` key.

> Render's free plan sleeps when idle, so the first visit can take about 30 seconds. For a site that always loads instantly, use the $7/month Starter plan, or Railway or Fly.io. Point your own domain (e.g. `yourbrand.com`) at it, with WHOIS privacy turned on so your name isn't public.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRAND_NAME` | Thesis Humanizer | Name shown on the site and in customer emails |
| `SUPPORT_EMAIL` | `SMTP_USER` | Contact shown in the footer. Leave it empty to hide it |
| `PRICE_GHS` | 20 | Flat price |
| `TURNAROUND` | 24 hours | Promised delivery time shown to customers |
| `MAX_FILE_MB` | 15 | Upload limit. Keep it at 18 or below if you use Gmail |
| `PAYSTACK_SECRET_KEY` | (none) | **Required** |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | (none) | Receive orders on Telegram |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Gmail, 465 | Receive orders and send receipts by email |
| `NOTIFY_EMAIL` | `SMTP_USER` | Inbox that receives new orders |
| `DATA_DIR` | `./data` | Where uploads are kept until delivered |

## Tips
- When Paystack reviews your business during activation, describe what you sell accurately (e.g. editing and rewriting of documents). An account flagged later can have its payouts held.
- Only promise what you can deliver ("natural, human-sounding writing"). Guarantees like "100% undetectable" lead to refund requests and chargebacks.

## Development
```bash
npm test
```
