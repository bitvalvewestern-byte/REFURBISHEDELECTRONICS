'use strict';
const paymentService = require('../services/paymentService');
const { badRequest } = require('../utils/errors');

/** POST /api/payment/create  { order_number, view_token } */
async function create(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!body.order_number || !body.view_token) {
    throw badRequest('MISSING_FIELDS', 'Order number and token are required.');
  }
  const result = await paymentService.createPayment({
    order_number: body.order_number,
    view_token: body.view_token
  });
  res.status(201).json({ data: result });
}

/** POST /api/payment/webhook - provider callback (signature verified). */
async function webhook(req, res) {
  const result = paymentService.handleWebhook({ body: req.body, headers: req.headers });
  res.json({ data: result });
}

module.exports = { create, webhook };
