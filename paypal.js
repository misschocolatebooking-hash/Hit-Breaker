// PayPal REST API client (Orders for entry fees, Payouts for winnings).
// Uses sandbox by default; set PAYPAL_MODE=live with live credentials to go live.
const BASE = () =>
  process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PayPal credentials not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  const res = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function api(path, method, body) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal API ${path} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// Create a checkout order for a tournament entry fee.
async function createOrder(amountCents, description) {
  return api('/v2/checkout/orders', 'POST', {
    intent: 'CAPTURE',
    purchase_units: [{
      description,
      amount: { currency_code: 'USD', value: (amountCents / 100).toFixed(2) },
    }],
  });
}

// Capture an approved order. Returns the captured amount in cents.
async function captureOrder(orderId) {
  const data = await api(`/v2/checkout/orders/${orderId}/capture`, 'POST', {});
  const pu = data.purchase_units && data.purchase_units[0];
  const cap = pu && pu.payments && pu.payments.captures && pu.payments.captures[0];
  if (!cap || cap.status !== 'COMPLETED') throw new Error('Order capture not completed');
  return Math.round(parseFloat(cap.amount.value) * 100);
}

// Send a batch payout. items: [{ email, cents, note }]
// NOTE: Payouts must be enabled on your PayPal business account.
// Sandbox: enabled by default. Live: request via developer.paypal.com.
async function sendPayoutBatch(items) {
  const senderBatchId = `HB-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = await api('/v1/payments/payouts', 'POST', {
    sender_batch_header: { sender_batch_id: senderBatchId, email_subject: 'You won Hit Breaker!' },
    items: items.map((it, i) => ({
      recipient_type: 'EMAIL',
      amount: { value: (it.cents / 100).toFixed(2), currency: 'USD' },
      receiver: it.email,
      note: it.note || 'Hit Breaker tournament winnings',
      sender_item_id: `item-${i}-${Date.now()}`,
    })),
  });
  return data.batch_header; // { payout_batch_id, batch_status, ... }
}

const isConfigured = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

module.exports = { createOrder, captureOrder, sendPayoutBatch, isConfigured, mode: () => process.env.PAYPAL_MODE || 'sandbox' };
