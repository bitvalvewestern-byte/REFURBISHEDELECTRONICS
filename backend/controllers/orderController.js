'use strict';
const orderService = require('../services/orderService');
const { badRequest } = require('../utils/errors');

/**
 * POST /api/orders
 * Body: { customer:{...}, items:[{product_id, quantity}], delivery_location, idempotency_key }
 * Any price/total in the body is ignored - the server recomputes everything.
 */
async function create(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const order = orderService.createOrder({
    customer: body.customer,
    items: body.items,
    delivery_location: body.delivery_location,
    idempotency_key: body.idempotency_key || req.headers['idempotency-key'],
    ip: req.ip
  });

  res.status(order.idempotent_replay ? 200 : 201).json({ data: order });
}

/**
 * POST /api/orders/quote - re-price a basket without creating anything.
 * Only product ids + quantities matter here; no customer details are needed
 * for a fee preview, so a partially-filled checkout form still gets a quote.
 */
async function quote(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const items = orderService.validateItems(body.items);
  const location = body.delivery_location || body.town || body.county || '';
  const priced = orderService.priceBasket({}, items, location);
  res.json({
    data: {
      items: priced.lines,
      subtotal: priced.subtotal,
      delivery_fee: priced.delivery_fee,
      delivery_zone: priced.delivery_zone,
      total: priced.total,
      currency: priced.currency
    }
  });
}

/** GET /api/orders/:orderNumber?token=... */
async function show(req, res) {
  const token = req.query.token || req.headers['x-order-token'];
  if (!token) throw badRequest('MISSING_TOKEN', 'An order token is required.');
  const order = orderService.getOrderForCustomer(req.params.orderNumber, String(token));
  res.json({ data: order });
}

module.exports = { create, quote, show };
