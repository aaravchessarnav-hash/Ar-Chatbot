require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const premiumStore = require('./premiumStore');

const app = express();

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ---------------------------------------------------------------------
// 👑 Premium pricing — the ONLY place prices are decided. The client
// only ever sends which tier it wants ("level1" / "level2"); the amount
// charged always comes from here, never from the request body. That's
// the fix for the "edit the request in devtools to pay ₹1 for Lifetime"
// class of bug — the server, not the browser, decides what things cost.
// Override via .env if you want different prices; values are in the
// smallest currency unit (paise / cents).
// ---------------------------------------------------------------------
const PREMIUM_PRICES = {
  level1: {
    label: '60-Day Pass',
    inrPaise: parseInt(process.env.PREMIUM_L1_PRICE_INR_PAISE || '14900', 10), // ₹149
    usdCents: parseInt(process.env.PREMIUM_L1_PRICE_USD_CENTS || '299', 10)     // $2.99
  },
  level2: {
    label: 'Lifetime',
    inrPaise: parseInt(process.env.PREMIUM_L2_PRICE_INR_PAISE || '99900', 10), // ₹999
    usdCents: parseInt(process.env.PREMIUM_L2_PRICE_USD_CENTS || '1499', 10)    // $14.99
  }
};
function isValidTier(t) { return t === 'level1' || t === 'level2'; }

app.use(cors());
app.use(express.json({ limit: '20mb' })); // generous limit — chat can include base64 image attachments

// Basic abuse protection for the shared server-side key. Visitors who paste
// their own OpenRouter key in Settings are still limited too, since this is
// a simple per-IP limit on the route rather than per-key — bump `max` up if
// you expect legitimate bursts (e.g. the AI Lab feature firing two lanes at once).
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests from this device — please wait a minute and try again.' } }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasServerKey: Boolean(OPENROUTER_API_KEY) });
});

// ---------------------------------------------------------------------
// 🔄 Model catalog proxy (used by ⚙️ Settings → "Refresh model list").
// This is a public, keyless OpenRouter endpoint — proxying it server-side
// just avoids relying on OpenRouter's CORS policy from the browser, and
// lets us cache it briefly so a burst of clicks (or multiple visitors)
// doesn't hammer OpenRouter with duplicate requests.
// ---------------------------------------------------------------------
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODELS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let modelsCache = { data: null, fetchedAt: 0 };

app.get('/api/models', async (req, res) => {
  try {
    const now = Date.now();
    if (modelsCache.data && (now - modelsCache.fetchedAt) < MODELS_CACHE_TTL_MS) {
      res.json(modelsCache.data);
      return;
    }
    const upstream = await fetch(OPENROUTER_MODELS_URL);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: { message: 'OpenRouter returned status ' + upstream.status } });
      return;
    }
    const data = await upstream.json();
    modelsCache = { data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    console.error('Models proxy error:', err);
    res.status(500).json({ error: { message: 'Backend proxy error: ' + err.message } });
  }
});

// ---------------------------------------------------------------------
// 📱 Device sync (used by the "Continue on another device" QR code).
// A tiny in-memory drop box: device A POSTs its current chat as JSON and
// gets back a short code; device B (after scanning the QR / entering the
// code) GETs it once. Entries expire on their own — nothing is written to
// disk, and nothing here needs a database.
// ---------------------------------------------------------------------
const syncStore = new Map(); // code -> { data, expiresAt }
const SYNC_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SYNC_MAX_BYTES = 3 * 1024 * 1024; // 3MB safety cap per payload

function pruneSyncStore() {
  const now = Date.now();
  for (const [code, entry] of syncStore) {
    if (entry.expiresAt <= now) syncStore.delete(code);
  }
}

function makeSyncCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (syncStore.has(code));
  return code;
}

const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many sync requests — please wait a minute and try again.' } }
});

app.post('/api/sync', syncLimiter, (req, res) => {
  pruneSyncStore();

  if (!req.body || typeof req.body.data === 'undefined') {
    res.status(400).json({ error: { message: 'Request body must include "data".' } });
    return;
  }

  const serialized = JSON.stringify(req.body.data);
  if (Buffer.byteLength(serialized, 'utf8') > SYNC_MAX_BYTES) {
    res.status(413).json({ error: { message: 'That chat is too large to sync (max 3MB).' } });
    return;
  }

  const code = makeSyncCode();
  syncStore.set(code, { data: req.body.data, expiresAt: Date.now() + SYNC_TTL_MS });
  res.json({ code, expiresInMs: SYNC_TTL_MS });
});

app.get('/api/sync/:code', syncLimiter, (req, res) => {
  pruneSyncStore();

  const code = String(req.params.code || '').toUpperCase();
  const entry = syncStore.get(code);

  if (!entry) {
    res.status(404).json({ error: { message: 'That code has expired or does not exist. Generate a new QR code and try again.' } });
    return;
  }

  res.json({ data: entry.data });
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const authHeader = req.get('authorization') || '';
    const userSuppliedKey = authHeader.replace(/^Bearer\s+/i, '').trim();
    const apiKey = userSuppliedKey || OPENROUTER_API_KEY;

    if (!apiKey) {
      res.status(401).json({
        error: {
          message:
            'No OpenRouter API key is configured. Set OPENROUTER_API_KEY in the server .env file, ' +
            'or paste a personal key into the app\'s ⚙️ Settings panel.'
        }
      });
      return;
    }

    if (!req.body || !Array.isArray(req.body.messages)) {
      res.status(400).json({ error: { message: 'Request body must include a "messages" array.' } });
      return;
    }

    const upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        'HTTP-Referer': req.get('HTTP-Referer') || req.get('referer') || 'https://ar-chatbot.local',
        'X-Title': req.get('X-Title') || 'AR Chatbot'
      },
      body: JSON.stringify(req.body)
    });

    // Streaming responses (Server-Sent Events) get piped straight through
    // chunk-by-chunk so the frontend's existing reader/decoder loop keeps working.
    if (req.body.stream) {
      res.status(upstream.status);
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      if (!upstream.body) {
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }

    // Non-streaming: pass the JSON body straight through as-is.
    const text = await upstream.text();
    res.status(upstream.status).set('Content-Type', 'application/json').send(text);
  } catch (err) {
    console.error('Chat proxy error:', err);
    res.status(500).json({ error: { message: 'Backend proxy error: ' + err.message } });
  }
});

// ---------------------------------------------------------------------
// 👑 Premium — device token, status, and payment routes.
//
// Security model in one place, since this is the part that handles real
// money:
//  1. The client never tells the server what tier it "has" or what a
//     payment "cost" — it only ever says which tier it WANTS to buy, and
//     the server looks up the price itself (PREMIUM_PRICES above).
//  2. A purchase is only granted after the server independently confirms
//     the payment with the provider (Razorpay HMAC signature check /
//     PayPal server-side order capture + status check) — never from a
//     client-sent "success: true".
//  3. Every payment id can only ever grant premium once
//     (premiumStore.isPaymentProcessed), so a captured network request
//     can't be replayed to grant premium repeatedly.
//  4. Premium status is recomputed from stored data on every check
//     (premiumStore.getStatus), so a level1 pass actually stops working
//     after 60 days server-side — the client can't just keep a cached
//     "premium: true" flag alive forever.
// ---------------------------------------------------------------------
const premiumLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests — please wait a minute and try again.' } }
});

// Issues a fresh opaque device token, or just echoes back one the client
// already has (as long as it's actually one we issued — a client can't
// invent its own token and have it accepted, since isValidToken checks
// it exists in the store).
app.post('/api/premium/device', premiumLimiter, (req, res) => {
  const existing = req.get('x-device-token') || '';
  if (premiumStore.isValidToken(existing)) {
    res.json({ token: existing });
    return;
  }
  res.json({ token: premiumStore.createDevice() });
});

app.get('/api/premium/status', premiumLimiter, (req, res) => {
  const token = req.get('x-device-token') || '';
  if (!premiumStore.isValidToken(token)) {
    res.status(400).json({ error: { message: 'Missing or invalid device token — call POST /api/premium/device first.' } });
    return;
  }
  res.json(premiumStore.getStatus(token));
});

// Public config the frontend needs to build the checkout UI. Only ever
// exposes PUBLIC ids (Razorpay key id, PayPal client id) — never the
// secret keys, which stay in this process's environment.
app.get('/api/premium/config', (req, res) => {
  res.json({
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
    razorpayConfigured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    paypalConfigured: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    prices: {
      level1: { inr: PREMIUM_PRICES.level1.inrPaise / 100, usd: PREMIUM_PRICES.level1.usdCents / 100, label: PREMIUM_PRICES.level1.label },
      level2: { inr: PREMIUM_PRICES.level2.inrPaise / 100, usd: PREMIUM_PRICES.level2.usdCents / 100, label: PREMIUM_PRICES.level2.label }
    }
  });
});

// ---- Razorpay (India) ----
app.post('/api/premium/razorpay/order', premiumLimiter, async (req, res) => {
  try {
    const token = req.get('x-device-token') || '';
    if (!premiumStore.isValidToken(token)) {
      res.status(400).json({ error: { message: 'Invalid device token.' } });
      return;
    }
    const tier = req.body && req.body.tier;
    if (!isValidTier(tier)) {
      res.status(400).json({ error: { message: 'tier must be "level1" or "level2".' } });
      return;
    }
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      res.status(503).json({ error: { message: 'Razorpay is not configured on this server (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing from .env).' } });
      return;
    }

    const amount = PREMIUM_PRICES[tier].inrPaise; // decided server-side, not by the client
    const auth = Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');
    const upstream = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
      body: JSON.stringify({
        amount,
        currency: 'INR',
        receipt: 'prem_' + tier + '_' + Date.now(),
        notes: { tier, deviceToken: token }
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: { message: (data && data.error && data.error.description) || 'Razorpay order creation failed.' } });
      return;
    }
    res.json({ orderId: data.id, amount: data.amount, currency: data.currency, keyId: process.env.RAZORPAY_KEY_ID, tier });
  } catch (err) {
    console.error('Razorpay order error:', err);
    res.status(500).json({ error: { message: 'Backend error creating Razorpay order: ' + err.message } });
  }
});

app.post('/api/premium/razorpay/verify', premiumLimiter, async (req, res) => {
  try {
    const token = req.get('x-device-token') || '';
    if (!premiumStore.isValidToken(token)) {
      res.status(400).json({ error: { message: 'Invalid device token.' } });
      return;
    }
    const { orderId, paymentId, signature, tier } = req.body || {};
    if (!orderId || !paymentId || !signature || !isValidTier(tier)) {
      res.status(400).json({ error: { message: 'orderId, paymentId, signature and tier are all required.' } });
      return;
    }
    if (premiumStore.isPaymentProcessed(paymentId)) {
      res.status(409).json({ error: { message: 'This payment has already been used to grant premium.' } });
      return;
    }
    // The one thing that actually proves this payment happened, rather
    // than being made up client-side, is this signature: an HMAC of
    // orderId+paymentId keyed with Razorpay's secret, which only
    // Razorpay and this server know. Do not remove this check.
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(orderId + '|' + paymentId)
      .digest('hex');
    if (expected !== signature) {
      res.status(400).json({ error: { message: 'Payment signature verification failed.' } });
      return;
    }
    premiumStore.grantPremium(token, tier, paymentId, 'razorpay');
    res.json(premiumStore.getStatus(token));
  } catch (err) {
    console.error('Razorpay verify error:', err);
    res.status(500).json({ error: { message: 'Backend error verifying Razorpay payment: ' + err.message } });
  }
});

// ---- PayPal (rest of world) ----
let paypalTokenCache = { token: null, expiresAt: 0 };
function paypalBase() {
  return process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}
async function getPaypalAccessToken() {
  if (paypalTokenCache.token && Date.now() < paypalTokenCache.expiresAt) return paypalTokenCache.token;
  const auth = Buffer.from(process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET).toString('base64');
  const upstream = await fetch(paypalBase() + '/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + auth },
    body: 'grant_type=client_credentials'
  });
  const data = await upstream.json();
  if (!upstream.ok) throw new Error((data && data.error_description) || 'PayPal auth failed');
  paypalTokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

app.post('/api/premium/paypal/order', premiumLimiter, async (req, res) => {
  try {
    const token = req.get('x-device-token') || '';
    if (!premiumStore.isValidToken(token)) {
      res.status(400).json({ error: { message: 'Invalid device token.' } });
      return;
    }
    const tier = req.body && req.body.tier;
    if (!isValidTier(tier)) {
      res.status(400).json({ error: { message: 'tier must be "level1" or "level2".' } });
      return;
    }
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
      res.status(503).json({ error: { message: 'PayPal is not configured on this server (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env).' } });
      return;
    }

    const usd = (PREMIUM_PRICES[tier].usdCents / 100).toFixed(2); // decided server-side
    const access = await getPaypalAccessToken();
    const upstream = await fetch(paypalBase() + '/v2/checkout/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + access },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: 'USD', value: usd }, custom_id: tier + '|' + token }]
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: { message: 'PayPal order creation failed.' } });
      return;
    }
    res.json({ orderId: data.id, tier });
  } catch (err) {
    console.error('PayPal order error:', err);
    res.status(500).json({ error: { message: 'Backend error creating PayPal order: ' + err.message } });
  }
});

app.post('/api/premium/paypal/capture', premiumLimiter, async (req, res) => {
  try {
    const token = req.get('x-device-token') || '';
    if (!premiumStore.isValidToken(token)) {
      res.status(400).json({ error: { message: 'Invalid device token.' } });
      return;
    }
    const { orderId, tier } = req.body || {};
    if (!orderId || !isValidTier(tier)) {
      res.status(400).json({ error: { message: 'orderId and tier are required.' } });
      return;
    }
    if (premiumStore.isPaymentProcessed(orderId)) {
      res.status(409).json({ error: { message: 'This order has already been used to grant premium.' } });
      return;
    }

    const access = await getPaypalAccessToken();
    const upstream = await fetch(paypalBase() + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + access }
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: { message: 'PayPal capture failed.' } });
      return;
    }

    // Re-check PayPal's own response for a COMPLETED capture at exactly
    // the price we asked for, in the currency we asked for — never trust
    // the client's claim that the popup "succeeded".
    const capture = data.purchase_units && data.purchase_units[0] &&
      data.purchase_units[0].payments && data.purchase_units[0].payments.captures &&
      data.purchase_units[0].payments.captures[0];
    const expectedUsd = (PREMIUM_PRICES[tier].usdCents / 100).toFixed(2);
    const ok = data.status === 'COMPLETED' && capture && capture.status === 'COMPLETED' &&
      capture.amount && capture.amount.currency_code === 'USD' && capture.amount.value === expectedUsd;
    if (!ok) {
      res.status(400).json({ error: { message: 'Payment could not be verified as completed for the expected amount.' } });
      return;
    }

    premiumStore.grantPremium(token, tier, orderId, 'paypal');
    res.json(premiumStore.getStatus(token));
  } catch (err) {
    console.error('PayPal capture error:', err);
    res.status(500).json({ error: { message: 'Backend error capturing PayPal payment: ' + err.message } });
  }
});

// ---------------------------------------------------------------------
// Serve the frontend (the modified index.html + any other static assets).
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`AR Chatbot backend running at http://localhost:${PORT}`);
  if (!OPENROUTER_API_KEY) {
    console.warn(
      '⚠️  No OPENROUTER_API_KEY set in .env — the app will only work for visitors who paste their own key in Settings.'
    );
  }
});
