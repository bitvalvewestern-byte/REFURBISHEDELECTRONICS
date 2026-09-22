'use strict';
/**
 * Payment layer.
 *
 * The provider is NOT yet configured, so this is a clean placeholder that
 * already has the right shape for a real integration (e.g. M-Pesa Daraja /
 * Pesapal / Flutterwave / Stripe):
 *
 *   browser --(order_number + view_token)--> POST /api/payment/create
 *                                             |
 *                                    server reads orders.total  <-- amount
 *                                             |
 *                                   provider.createIntent()
 *                                             |
 *              <-- { reference, status, redirect_url } (no amount chosen by client)
 *
 * A real provider only needs to implement createIntent() and verifyWebhook().
 * Secret keys stay in backend/.env - they are never sent to the browser.
 */
const crypto = require('node:crypto');
const config = require('../config');
const dbx = require('../db');
const { notFound, badRequest, conflict, serverError } = require('../utils/errors');
const orderService = require('./orderService');
const v = require('../utils/validation');

const PROVIDER = (process.env.PAYMENT_PROVIDER || 'placeholder').toLowerCase();

/* ------------------------------------------------------------------ */
/* Provider implementations                                            */
/* ------------------------------------------------------------------ */
const providers = {
  /** No-op placeholder. Records a pending payment against the real total. */
  async placeholder(order) {
    return {
      provider: 'placeholder',
      reference: `PLACEHOLDER-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      status: 'pending',
      amount: order.total,
      currency: order.currency,
      // Front-end redirects here; a real provider returns its hosted checkout URL.
      redirect_url: `/order-success.html?order=${encodeURIComponent(order.order_number)}&token=${encodeURIComponent(order.view_token)}&payment=pending`,
      message: 'Payment provider not configured yet. Order recorded with an outstanding balance.'
    };
  },

  /**
   * Skeleton for a real provider. Fill in the API call using env credentials.
   * IMPORTANT: `order.total` is the server-calculated amount - never take an
   * amount from the request body.
   */
  async mpesa(order) {
    if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET) {
      throw serverError('PAYMENT_NOT_CONFIGURED', 'Payment is not configured yet.');
    }
    // TODO: obtain an OAuth token, then POST STK Push with:
    //   Amount: order.total, AccountReference: order.order_number, PhoneNumber: order.customer_phone
    throw serverError('PAYMENT_NOT_CONFIGURED', 'M-Pesa integration not implemented in this build.');
  }
};

function activeProvider() {
  return providers[PROVIDER] || providers.placeholder;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */
async function createPayment({ order_number, view_token }) {
  const order = orderService.assertOrderAccess(order_number, view_token);

  if (order.order_status === 'cancelled') {
    throw conflict('ORDER_CANCELLED', 'This order has been cancelled.');
  }
  if (order.payment_status === 'paid') {
    return { already_paid: true, order_number: order.order_number, status: 'paid', amount: order.total, currency: order.currency };
  }

  const quote = activeProvider();
  const result = await quote(order);

  // Guard: the provider must never be able to change the authoritative amount.
  if (Number(result.amount) !== Number(order.total)) {
    throw serverError('PAYMENT_AMOUNT_MISMATCH', 'Payment could not be initialised.');
  }

  const ts = dbx.nowIso();
  dbx.run(`
    INSERT INTO payments (order_id, provider, provider_ref, amount, currency, status, payload, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `, [order.id, result.provider, result.reference, order.total, order.currency, result.status,
      JSON.stringify({ message: result.message || null }), ts, ts]);

  if (order.payment_status === 'unpaid') {
    dbx.run("UPDATE orders SET payment_status='pending', updated_at=? WHERE id=?", [ts, order.id]);
  }

  return {
    order_number: order.order_number,
    provider: result.provider,
    reference: result.reference,
    status: result.status,
    amount: order.total,
    currency: order.currency,
    redirect_url: result.redirect_url,
    message: result.message
  };
}

/**
 * Webhook receiver placeholder. A real integration MUST verify the provider
 * signature before trusting the payload, and must re-read the stored amount
 * instead of the amount supplied by the callback.
 */
function handleWebhook({ body, headers }) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body || {});
  const signature = headers['x-payment-signature'] || '';
  const secret = process.env.PAYMENT_WEBHOOK_SECRET || '';
  if (!secret) {
    throw serverError('PAYMENT_NOT_CONFIGURED', 'Payment webhooks are not configured.');
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const ok = signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) throw badRequest('INVALID_SIGNATURE', 'Invalid webhook signature.');

  const payload = typeof body === 'string' ? JSON.parse(body) : (body || {});
  const orderNumber = v.cleanString(payload.order_number, { max: 60 });
  const status = v.cleanString(payload.status, { max: 20 }).toLowerCase();
  const order = dbx.get('SELECT * FROM orders WHERE order_number = ?', [orderNumber]);
  if (!order) throw notFound('ORDER_NOT_FOUND', 'Unknown order in webhook.');

  const ts = dbx.nowIso();
  const paid = ['paid', 'success', 'completed', 'succeeded'].includes(status);
  const failed = ['failed', 'cancelled', 'canceled', 'rejected'].includes(status);

  dbx.run('UPDATE payments SET status=?, provider_ref=?, updated_at=? WHERE order_id=?',
    [paid ? 'paid' : failed ? 'failed' : 'pending', v.cleanString(payload.reference, { max: 120 }) || null, ts, order.id]);
  dbx.run('UPDATE orders SET payment_status=?, order_status=?, updated_at=? WHERE id=?', [
    paid ? 'paid' : failed ? 'failed' : 'pending',
    paid && order.order_status === 'pending' ? 'paid' : order.order_status,
    ts, order.id
  ]);
  return { ok: true, order_number: orderNumber, status: paid ? 'paid' : failed ? 'failed' : 'pending' };
}

module.exports = { createPayment, handleWebhook, activeProvider };
