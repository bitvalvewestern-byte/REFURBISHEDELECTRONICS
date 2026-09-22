'use strict';
const config = require('../config');
const dbx = require('../db');
const adminService = require('../services/adminService');
const productService = require('../services/productService');
const { badRequest, notFound } = require('../utils/errors');

const ORDER_STATUSES = ['pending', 'confirmed', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'];
const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'failed', 'refunded'];

/* ---------------------------- auth --------------------------------- */
async function login(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) throw badRequest('MISSING_CREDENTIALS', 'Username and password are required.');

  const result = adminService.login({
    username, password, ip: req.ip, userAgent: req.headers['user-agent']
  });

  res.cookie('ncs_admin_session', result.sid, {
    httpOnly: true, secure: config.security.cookieSecure, sameSite: 'strict', path: '/',
    maxAge: config.admin.sessionTtlSeconds * 1000
  });
  res.cookie('ncs_admin_csrf', result.csrf, {
    httpOnly: false, secure: config.security.cookieSecure, sameSite: 'strict', path: '/',
    maxAge: config.admin.sessionTtlSeconds * 1000
  });
  res.json({ data: { username: result.username, csrf_token: result.csrf, expires_at: result.expires } });
}

async function logout(req, res) {
  adminService.logout(req.cookies?.ncs_admin_session, req.admin?.id, req.ip);
  res.clearCookie('ncs_admin_session', { path: '/' });
  res.clearCookie('ncs_admin_csrf', { path: '/' });
  res.json({ data: { ok: true } });
}

async function me(req, res) {
  res.json({ data: { username: req.admin.username } });
}

/* ---------------------------- stats -------------------------------- */
async function stats(req, res) {
  const totals = dbx.get(`
    SELECT
      COUNT(*) AS orders,
      SUM(CASE WHEN order_status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN order_status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total ELSE 0 END), 0) AS revenue
    FROM orders
  `);
  const products = dbx.get('SELECT COUNT(*) AS n, COALESCE(SUM(stock),0) AS units FROM products WHERE active = 1');
  res.json({
    data: {
      orders: Number(totals.orders || 0),
      pending: Number(totals.pending || 0),
      delivered: Number(totals.delivered || 0),
      paid_orders: Number(totals.paid_orders || 0),
      revenue: Number(totals.revenue || 0),
      active_products: Number(products.n || 0),
      units_in_stock: Number(products.units || 0),
      currency: config.pricing.currency,
      catalogue_sync: productService.getSyncState()
    }
  });
}

/* ---------------------------- products ----------------------------- */
async function listProducts(req, res) {
  const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 25, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const search = String(req.query.q || '').trim();
  const where = search ? 'WHERE name LIKE ? OR id LIKE ? OR category LIKE ?' : '';
  const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

  const total = dbx.get(`SELECT COUNT(*) AS n FROM products ${where}`, params).n;
  const rows = dbx.all(
    `SELECT id, name, image, source_price, selling_price, currency, stock, category, active, synced_at
     FROM products ${where} ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?`,
    [...params, perPage, (page - 1) * perPage]
  );
  res.json({ data: rows, pagination: { page, per_page: perPage, total } });
}

async function triggerSync(req, res) {
  try {
    const result = await productService.syncProducts({ force: true });
    adminService.audit(req.admin.id, 'catalogue_sync', 'source_api', JSON.stringify(result), req.ip);
    res.json({ data: result });
  } catch (err) {
    adminService.audit(req.admin.id, 'catalogue_sync_failed', 'source_api', err.code || err.message, req.ip);
    res.status(err.httpStatus || 502).json({
      error: { code: err.code || 'SYNC_FAILED', message: err.publicMessage || 'Catalogue sync failed.' }
    });
  }
}

/* ---------------------------- orders ------------------------------- */
async function listOrders(req, res) {
  const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 25, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const clauses = [];
  const params = [];
  if (req.query.status && ORDER_STATUSES.includes(req.query.status)) {
    clauses.push('o.order_status = ?'); params.push(req.query.status);
  }
  if (req.query.payment_status && PAYMENT_STATUSES.includes(req.query.payment_status)) {
    clauses.push('o.payment_status = ?'); params.push(req.query.payment_status);
  }
  if (req.query.q) {
    clauses.push('(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)');
    const like = `%${String(req.query.q).trim()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const total = dbx.get(`SELECT COUNT(*) AS n FROM orders o ${where}`, params).n;
  const orders = dbx.all(`
    SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
    FROM orders o ${where}
    ORDER BY o.id DESC LIMIT ? OFFSET ?
  `, [...params, perPage, (page - 1) * perPage]);

  res.json({
    data: orders.map((o) => ({
      order_number: o.order_number,
      customer_name: o.customer_name,
      customer_phone: o.customer_phone,
      county: o.county,
      town: o.town,
      address: o.address,
      delivery_zone: o.delivery_zone_id,
      delivery_fee: o.delivery_fee,
      subtotal: o.subtotal,
      total: o.total,
      currency: o.currency,
      payment_status: o.payment_status,
      order_status: o.order_status,
      item_count: o.item_count,
      created_at: o.created_at
    })),
    pagination: { page, per_page: perPage, total }
  });
}

async function getOrder(req, res) {
  const order = dbx.get('SELECT * FROM orders WHERE order_number = ?', [String(req.params.orderNumber)]);
  if (!order) throw notFound('ORDER_NOT_FOUND', 'Order not found.');
  const items = dbx.all('SELECT product_id, product_name, unit_price, quantity, line_total FROM order_items WHERE order_id = ?', [order.id]);
  const payments = dbx.all('SELECT provider, provider_ref, amount, currency, status, created_at FROM payments WHERE order_id = ? ORDER BY id DESC', [order.id]);
  res.json({
    data: {
      order_number: order.order_number,
      created_at: order.created_at,
      customer: {
        name: order.customer_name, phone: order.customer_phone, email: order.customer_email,
        county: order.county, town: order.town, address: order.address,
        delivery_instructions: order.delivery_instructions
      },
      delivery_location: order.delivery_location,
      delivery_zone: order.delivery_zone_id,
      delivery_fee: order.delivery_fee,
      subtotal: order.subtotal,
      total: order.total,
      currency: order.currency,
      order_status: order.order_status,
      payment_status: order.payment_status,
      items: items.map((i) => ({
        product_id: i.product_id, name: i.product_name, unit_price: i.unit_price,
        quantity: i.quantity, line_total: i.line_total
      })),
      payments
    }
  });
}

async function updateOrderStatus(req, res) {
  const status = String(req.body?.order_status || '');
  if (!ORDER_STATUSES.includes(status)) throw badRequest('INVALID_STATUS', 'Unknown order status.');

  const order = dbx.get('SELECT * FROM orders WHERE order_number = ?', [String(req.params.orderNumber)]);
  if (!order) throw notFound('ORDER_NOT_FOUND', 'Order not found.');

  // Restock when an order is cancelled from a non-terminal state.
  if (status === 'cancelled' && order.order_status !== 'cancelled') {
    const items = dbx.all('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
    const restock = dbx.transaction(() => {
      for (const it of items) {
        dbx.run('UPDATE products SET stock = stock + ? WHERE id = ?', [it.quantity, it.product_id]);
      }
    });
    restock();
  }

  dbx.run('UPDATE orders SET order_status = ?, updated_at = ? WHERE id = ?', [status, dbx.nowIso(), order.id]);
  adminService.audit(req.admin.id, 'update_order_status', order.order_number, `${order.order_status} -> ${status}`, req.ip);
  res.json({ data: { order_number: order.order_number, order_status: status } });
}

async function updatePaymentStatus(req, res) {
  const status = String(req.body?.payment_status || '');
  if (!PAYMENT_STATUSES.includes(status)) throw badRequest('INVALID_STATUS', 'Unknown payment status.');

  const order = dbx.get('SELECT * FROM orders WHERE order_number = ?', [String(req.params.orderNumber)]);
  if (!order) throw notFound('ORDER_NOT_FOUND', 'Order not found.');

  const ts = dbx.nowIso();
  dbx.run('UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?', [status, ts, order.id]);
  dbx.run(`UPDATE payments SET status = ?, updated_at = ? WHERE order_id = ?`, [status, ts, order.id]);
  adminService.audit(req.admin.id, 'update_payment_status', order.order_number, `${order.payment_status} -> ${status}`, req.ip);
  res.json({ data: { order_number: order.order_number, payment_status: status } });
}

async function auditLog(req, res) {
  const rows = dbx.all('SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT 100');
  res.json({ data: rows });
}

module.exports = {
  login, logout, me, stats, listProducts, triggerSync,
  listOrders, getOrder, updateOrderStatus, updatePaymentStatus, auditLog,
  ORDER_STATUSES, PAYMENT_STATUSES
};
