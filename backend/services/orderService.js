'use strict';
/**
 * Order service.
 *
 * SECURITY INVARIANT: the browser only ever sends {product_id, quantity}.
 * Every price, fee and total below is derived on the server from the cached
 * catalogue. Any price/amount present in the request body is ignored.
 */
const crypto = require('node:crypto');
const config = require('../config');
const dbx = require('../db');
const { badRequest, conflict, notFound, serverError } = require('../utils/errors');
const v = require('../utils/validation');

/* ------------------------------------------------------------------ */
/* Delivery fee resolution (backend config -> DB)                      */
/* ------------------------------------------------------------------ */
function listDeliveryZones() {
  return dbx.all('SELECT * FROM delivery_zones ORDER BY fee ASC');
}

function resolveDeliveryZone(location) {
  const zones = listDeliveryZones();
  if (!zones.length) throw serverError('DELIVERY_NOT_CONFIGURED', 'Delivery is not configured.');

  const needle = v.cleanString(location, { max: 120 }).toLowerCase().replace(/\s+/g, ' ').trim();

  if (needle) {
    // Pass 1 - exact match on the zone label or a match term. This is what the
    // checkout UI sends ("Nairobi" / "Outside Nairobi"), so it must win before
    // any substring heuristic can run.
    for (const z of zones) {
      const terms = JSON.parse(z.match_terms || '[]').map((t) => String(t).toLowerCase());
      const labels = [String(z.label || '').toLowerCase(), String(z.id || '').toLowerCase().replace(/[_-]+/g, ' ')];
      if (labels.includes(needle) || terms.includes(needle)) return z;
    }

    // Pass 2 - substring match, but word-bounded and suppressed for negated
    // phrasing so that "outside nairobi" can never resolve to the Nairobi zone
    // (which contains "nairobi" as a term and is cheaper).
    const negated = /^(outside|not in|beyond|upcountry|rest of)\b/.test(needle) || /\bnot in\b/.test(needle);
    if (!negated) {
      for (const z of zones) {
        const terms = JSON.parse(z.match_terms || '[]').map((t) => String(t).toLowerCase());
        if (terms.some((t) => matchesTerm(needle, t))) return z;
      }
    }
  }
  const def = zones.find((z) => z.is_default === 1) || zones[zones.length - 1];
  return def;
}

/** Word-boundary containment so "nairobi" matches "westlands, nairobi" but not "nairobits". */
function matchesTerm(needle, term) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(needle);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function generateOrderNumber() {
  // NCS-YYMMDD-XXXX (4 chars of base32 entropy) - not guessable enough to be a
  // bearer credential on its own, hence the separate view_token below.
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
  return `NCS-${ymd}-${rand}`;
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Detect accidental double-submits: same phone + same basket recently. */
function fingerprint(phone, items) {
  const canonical = items
    .map((i) => `${i.product_id}:${i.quantity}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(`${phone}::${canonical}`).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */
function validateCustomer(input = {}) {
  const c = input && typeof input === 'object' ? input : {};
  const name = v.cleanString(c.name, { max: 120 });
  if (name.length < 2) throw badRequest('INVALID_NAME', 'Please enter your full name.');

  const phoneRaw = v.cleanString(c.phone, { max: 20 });
  if (!v.isKenyanPhone(phoneRaw)) {
    throw badRequest('INVALID_PHONE', 'Please enter a valid Kenyan phone number, e.g. 0712345678.');
  }
  const phone = v.normalizePhone(phoneRaw);

  const emailRaw = v.cleanString(c.email, { max: 254 });
  if (emailRaw && !v.isEmail(emailRaw)) {
    throw badRequest('INVALID_EMAIL', 'Please enter a valid email address, or leave it blank.');
  }

  const county = v.cleanString(c.county, { max: 80 });
  const town = v.cleanString(c.town, { max: 80 });
  const address = v.cleanString(c.address, { max: 300 });
  if (address.length < 4) throw badRequest('INVALID_ADDRESS', 'Please enter a delivery address.');

  return {
    name, phone,
    email: emailRaw || null,
    county: county || null,
    town: town || null,
    address,
    delivery_instructions: v.cleanString(c.delivery_instructions || c.notes, { max: 500 }) || null
  };
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest('EMPTY_CART', 'Your cart is empty.');
  }
  if (items.length > config.orders.maxDistinctItems) {
    throw badRequest('TOO_MANY_ITEMS', `You can order at most ${config.orders.maxDistinctItems} distinct products.`);
  }
  const seen = new Map();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') throw badRequest('INVALID_ITEM', 'One of the cart items is invalid.');
    const pid = v.cleanString(raw.product_id ?? raw.id, { max: 200 });
    if (!pid) throw badRequest('INVALID_ITEM', 'One of the cart items is missing a product id.');
    const qty = v.toPositiveInt(raw.quantity, 'quantity', {
      min: 1, max: config.orders.maxQuantityPerItem
    });
    seen.set(pid, (seen.get(pid) || 0) + qty);           // merge duplicates
  }
  return [...seen.entries()].map(([product_id, quantity]) => ({ product_id, quantity }));
}

/* ------------------------------------------------------------------ */
/* Pricing engine (SERVER AUTHORITATIVE)                               */
/* ------------------------------------------------------------------ */
function priceBasket(customer, cartItems, deliveryLocation) {
  const lines = [];
  let subtotal = 0;

  for (const item of cartItems) {
    const row = dbx.get('SELECT * FROM products WHERE id = ?', [item.product_id]);
    if (!row) {
      throw notFound('PRODUCT_NOT_FOUND', `A product in your cart is no longer available (id ${item.product_id}).`);
    }
    if (!row.active) {
      throw conflict('PRODUCT_UNAVAILABLE', `"${row.name}" is no longer available and was removed from sale.`);
    }
    if (config.orders.requireStock && row.stock <= 0) {
      throw conflict('OUT_OF_STOCK', `"${row.name}" is out of stock.`);
    }
    if (config.orders.requireStock && item.quantity > row.stock) {
      throw conflict('INSUFFICIENT_STOCK', `Only ${row.stock} unit(s) of "${row.name}" are available.`);
    }

    // Price comes from the DB (which came from the source API), never the client.
    const unitPrice = row.selling_price;
    const lineTotal = Math.round(unitPrice * item.quantity * 100) / 100;
    subtotal += lineTotal;
    lines.push({
      product_id: row.id,
      product_name: row.name,
      unit_price: unitPrice,
      quantity: item.quantity,
      line_total: lineTotal
    });
  }

  subtotal = Math.round(subtotal * 100) / 100;

  // Resolve the delivery zone from the location string, then read its fee from
  // the DB (seeded from config/delivery.json).
  const zone = resolveDeliveryZone(deliveryLocation || customer.town || customer.county || '');
  const deliveryFee = Math.round(Number(zone.fee) * 100) / 100;
  const total = Math.round((subtotal + deliveryFee) * 100) / 100;

  return {
    lines,
    subtotal,
    delivery_fee: deliveryFee,
    delivery_zone: { id: zone.id, label: zone.label },
    total,
    currency: config.pricing.currency
  };
}

/* ------------------------------------------------------------------ */
/* Order creation                                                      */
/* ------------------------------------------------------------------ */
function createOrder({ customer, items, delivery_location, idempotency_key, ip } = {}) {
  const cust = validateCustomer(customer);
  const cartItems = validateItems(items);
  const quote = priceBasket(cust, cartItems, delivery_location);

  const idem = v.cleanString(idempotency_key, { max: 80 });

  // --- Duplicate-order protection -------------------------------------
  if (idem) {
    const existing = dbx.get('SELECT order_number, view_token FROM orders WHERE idempotency_key = ?', [idem]);
    if (existing) {
      return { ...getOrderForCustomer(existing.order_number, existing.view_token, true), idempotent_replay: true };
    }
  } else {
    const fp = fingerprint(cust.phone, cartItems);
    const since = new Date(Date.now() - config.orders.duplicateWindowSeconds * 1000).toISOString();
    const dupe = dbx.get(
      'SELECT order_number FROM orders WHERE fingerprint = ? AND created_at >= ? ORDER BY id DESC LIMIT 1',
      [fp, since]
    );
    if (dupe) {
      throw conflict(
        'DUPLICATE_ORDER',
        `We already received this order (${dupe.order_number}). Please wait a moment before trying again.`
      );
    }
  }

  const ts = dbx.nowIso();
  const orderNumber = generateOrderNumber();
  const viewToken = newToken();
  const fp = fingerprint(cust.phone, cartItems);

  const create = dbx.transaction(() => {
    // Re-check inside the transaction for the idempotency key (race safety).
    if (idem) {
      const raced = dbx.get('SELECT order_number, view_token FROM orders WHERE idempotency_key = ?', [idem]);
      if (raced) return { replay: raced };
    }

    // Upsert the guest customer by phone (never creates a login account).
    let customerId;
    const existingCustomer = dbx.get('SELECT id FROM customers WHERE phone = ?', [cust.phone]);
    if (existingCustomer) {
      customerId = existingCustomer.id;
      dbx.run(`UPDATE customers SET name=?, email=?, county=?, town=?, address=?, updated_at=? WHERE id=?`,
        [cust.name, cust.email, cust.county, cust.town, cust.address, ts, customerId]);
    } else {
      const res = dbx.run(
        `INSERT INTO customers (name, phone, email, county, town, address, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [cust.name, cust.phone, cust.email, cust.county, cust.town, cust.address, ts, ts]
      );
      customerId = Number(res.lastInsertRowid);
    }

    const res = dbx.run(`
      INSERT INTO orders (
        order_number, view_token, customer_id, customer_name, customer_phone, customer_email,
        county, town, address, delivery_instructions, delivery_location, delivery_zone_id,
        delivery_fee, subtotal, total, currency, payment_status, order_status,
        idempotency_key, fingerprint, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'unpaid','pending',?,?,?,?)
    `, [
      orderNumber, viewToken, customerId, cust.name, cust.phone, cust.email,
      cust.county, cust.town, cust.address, cust.delivery_instructions,
      v.cleanString(delivery_location, { max: 120 }) || cust.town || cust.county || '',
      quote.delivery_zone.id, quote.delivery_fee, quote.subtotal, quote.total, quote.currency,
      idem || null, fp, ts, ts
    ]);
    const orderId = Number(res.lastInsertRowid);

    const insertItem = dbx.db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
      VALUES (?,?,?,?,?,?)
    `);
    const decStock = dbx.db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?');
    for (const line of quote.lines) {
      insertItem.run(orderId, line.product_id, line.product_name, line.unit_price, line.quantity, line.line_total);
      if (config.orders.requireStock) {
        const upd = decStock.run(line.quantity, line.product_id, line.quantity);
        if (upd.changes !== 1) {
          throw conflict('INSUFFICIENT_STOCK', `"${line.product_name}" sold out while you were checking out.`);
        }
      }
    }
    return { orderId, orderNumber, viewToken };
  });

  const out = create();
  if (out.replay) {
    return { ...getOrderForCustomer(out.replay.order_number, out.replay.view_token, true), idempotent_replay: true };
  }
  dbx.run(`UPDATE sync_state SET updated_at = updated_at WHERE id = 1`); // touch (no-op, keeps WAL warm)
  return getOrderForCustomer(out.orderNumber, out.viewToken, true);
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */
/* Constant-time comparison that tolerates different lengths.
 * crypto.timingSafeEqual throws RangeError when the buffers differ in byte
 * length, which would turn an attacker-supplied short/long token into a 500
 * (and leaks the token length through the error path). Comparing fixed-width
 * digests keeps the comparison constant-time and length-agnostic. */
function safeTokenEquals(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const dbb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, dbb);
}

function assertOrderAccess(orderNumber, token) {
  const order = dbx.get('SELECT * FROM orders WHERE order_number = ?', [v.cleanString(orderNumber, { max: 60 })]);
  if (!order) throw notFound('ORDER_NOT_FOUND', 'That order could not be found.');
  if (!token || !safeTokenEquals(token, order.view_token)) {
    throw notFound('ORDER_NOT_FOUND', 'That order could not be found.');
  }
  return order;
}

function getOrderForCustomer(orderNumber, token, withToken = false) {
  const order = assertOrderAccess(orderNumber, token);
  const items = dbx.all('SELECT product_id, product_name, unit_price, quantity, line_total FROM order_items WHERE order_id = ?', [order.id]);
  const payment = dbx.get('SELECT provider, provider_ref, amount, currency, status FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [order.id]);
  return {
    order_number: order.order_number,
    created_at: order.created_at,
    currency: order.currency,
    items: items.map((i) => ({
      product_id: i.product_id,
      name: i.product_name,
      unit_price: i.unit_price,
      quantity: i.quantity,
      line_total: i.line_total
    })),
    subtotal: order.subtotal,
    delivery_fee: order.delivery_fee,
    delivery_zone: order.delivery_zone_id,
    total: order.total,
    payment_status: order.payment_status,
    order_status: order.order_status,
    customer: {
      name: order.customer_name,
      phone: order.customer_phone,
      email: order.customer_email,
      county: order.county,
      town: order.town,
      address: order.address,
      delivery_instructions: order.delivery_instructions
    },
    payment: payment
      ? { provider: payment.provider, reference: payment.provider_ref, status: payment.status }
      : null,
    ...(withToken ? { view_token: order.view_token } : {})
  };
}

module.exports = {
  createOrder, priceBasket, validateCustomer, validateItems,
  resolveDeliveryZone, listDeliveryZones, getOrderForCustomer, assertOrderAccess,
  fingerprint
};
