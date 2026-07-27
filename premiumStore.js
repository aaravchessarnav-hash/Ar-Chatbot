// ---------------------------------------------------------------------
// 👑 Premium status store — the server-side source of truth.
//
// There are no user accounts in this app, so "who has premium" is keyed
// by an opaque device token (a random 48-hex-char string the server
// hands out, stored client-side in localStorage). That token is NOT a
// secret the client gets to set or influence — the server generates it,
// and every premium check/grant is looked up (and, for level1, expiry-
// checked) here, on the server, every time. That's the fix for the
// classic version of this bug: a client that can just set
// localStorage.premium = "true" and get free access forever. With this
// store, the client only ever holds a pointer; the actual tier and
// expiry live here and are recomputed on every /api/premium/status call.
//
// Persistence is a single JSON file — plenty for this app's scale, and
// keeps the "no accounts system yet" footprint small. If this app later
// gets real accounts (see README roadmap, V.10), swap this file for a
// real DB and key by user id instead of device token; nothing above
// this module needs to change.
// ---------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'premium-store.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) return { devices: {}, processedPayments: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed.devices) parsed.devices = {};
    if (!parsed.processedPayments) parsed.processedPayments = {};
    return parsed;
  } catch (err) {
    console.error('premiumStore: failed to parse store file, starting fresh:', err.message);
    return { devices: {}, processedPayments: {} };
  }
}

let store = loadStore();
let saveTimer = null;

function persist() {
  ensureDataDir();
  // Debounce writes slightly so a burst of calls doesn't hammer disk.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
      console.error('premiumStore: failed to persist store:', err.message);
    }
  }, 50);
}

function newDeviceToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars
}

function createDevice() {
  const token = newDeviceToken();
  store.devices[token] = { tier: 'free', expiresAt: null, createdAt: Date.now() };
  persist();
  return token;
}

function isValidToken(token) {
  return typeof token === 'string' && /^[a-f0-9]{48}$/.test(token) && !!store.devices[token];
}

// Live, server-computed status — never trust a cached client value.
// A level1 (60-day) grant that has passed its expiresAt is downgraded
// back to free right here, so a stale/cached "premium" flag on the
// client can never outlive what the server actually thinks is true.
function getStatus(token) {
  const rec = store.devices[token];
  if (!rec) return { tier: 'free', expiresAt: null, daysLeft: 0 };
  if (rec.tier === 'level1' && rec.expiresAt && rec.expiresAt <= Date.now()) {
    rec.tier = 'free';
    rec.expiresAt = null;
    persist();
  }
  const daysLeft = (rec.tier === 'level1' && rec.expiresAt)
    ? Math.max(0, Math.ceil((rec.expiresAt - Date.now()) / 86400000))
    : null;
  return { tier: rec.tier, expiresAt: rec.expiresAt, daysLeft };
}

// paymentId must be a real, provider-issued id for one specific completed
// payment (Razorpay payment id / PayPal order id). Reusing one that's
// already been consumed here is rejected — this stops a single real
// payment confirmation from being replayed to grant premium repeatedly,
// or copy-pasted from someone else's successful checkout.
function grantPremium(token, tier, paymentId, provider) {
  if (!store.devices[token]) return false;
  if (store.processedPayments[paymentId]) return false;
  store.processedPayments[paymentId] = { token, tier, provider, grantedAt: Date.now() };

  const rec = store.devices[token];
  if (tier === 'level2') {
    rec.tier = 'level2';
    rec.expiresAt = null; // forever — no expiry to check
  } else if (tier === 'level1') {
    // Stacks on top of remaining time if they already had an active
    // level1 pass, instead of wasting the days they already paid for.
    const base = (rec.tier === 'level1' && rec.expiresAt && rec.expiresAt > Date.now())
      ? rec.expiresAt
      : Date.now();
    rec.tier = 'level1';
    rec.expiresAt = base + 60 * 24 * 60 * 60 * 1000;
  }
  persist();
  return true;
}

function isPaymentProcessed(paymentId) {
  return !!store.processedPayments[paymentId];
}

module.exports = { createDevice, isValidToken, getStatus, grantPremium, isPaymentProcessed };
