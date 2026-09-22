'use strict';
const config = require('../config');
const dbx = require('../db');
const sourceApi = require('./sourceApi');
const { notFound, serverError } = require('../utils/errors');
const { cleanString, safeUrl } = require('../utils/validation');

/* ------------------------------------------------------------------ */
/* Pricing - the single source of truth for the selling price          */
/* ------------------------------------------------------------------ */
function roundPrice(value) {
  switch (config.pricing.rounding) {
    case 'none': return Math.round(value * 100) / 100;
    case 'nearest50': return Math.round(value / 50) * 50;
    case 'nearest100': return Math.round(value / 100) * 100;
    case 'integer':
    default: return Math.round(value);
  }
}

/** selling_price = source_price * factor   (factor defaults to 0.50) */
function computeSellingPrice(sourcePrice) {
  const sp = Number(sourcePrice);
  if (!Number.isFinite(sp) || sp < 0) {
    throw serverError('PRICE_ERROR', 'A product has an invalid source price.');
  }
  return roundPrice(sp * config.pricing.factor);
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */
/**
 * Public (browser-facing) representation.
 * NOTE: source_price is deliberately withheld so customers cannot see the
 * wholesale cost / margin. Flip EXPOSE_SOURCE_PRICE=true only if required.
 */
function toPublicProduct(row) {
  const product = {
    id: row.id,
    name: row.name,
    description: row.description || '',
    image: safeUrl(row.image || ''),
    selling_price: row.selling_price,
    currency: row.currency,
    stock: row.stock,
    in_stock: row.stock > 0,
    category: row.category,
    updated_at: row.synced_at
  };
  if (config.pricing.exposeSourcePrice) product.source_price = row.source_price;
  return product;
}

/* ------------------------------------------------------------------ */
/* Sync: SOURCE API -> backend DB (cache)                              */
/* ------------------------------------------------------------------ */
let syncInFlight = null;

function getSyncState() {
  return dbx.get('SELECT * FROM sync_state WHERE id = 1') || {
    last_sync_at: null, last_status: 'never_synced', last_error: null, item_count: 0
  };
}

async function syncProducts({ force = false } = {}) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const { nowIso } = dbx;
    const ts = nowIso();
    try {
      const rawProducts = await sourceApi.fetchAllRawProducts();
      const normalised = rawProducts.map(sourceApi.normalize).filter(Boolean);

      const seen = new Set();
      for (const p of normalised) seen.add(p.id);

      const upsert = dbx.db.prepare(`
        INSERT INTO products
          (id, source_id, name, description, image, source_price, selling_price,
           currency, stock, category, active, source_updated_at, synced_at, raw)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, description=excluded.description, image=excluded.image,
          source_price=excluded.source_price, selling_price=excluded.selling_price,
          currency=excluded.currency, stock=excluded.stock, category=excluded.category,
          active=1, source_updated_at=excluded.source_updated_at,
          synced_at=excluded.synced_at, raw=excluded.raw
      `);

      const applySync = dbx.transaction(() => {
        for (const p of normalised) {
          upsert.run(
            p.id, p.id, cleanString(p.name, { max: 300 }) || `Product ${p.id}`,
            cleanString(p.description, { max: 5000 }),
            safeUrl(p.image), p.source_price, computeSellingPrice(p.source_price),
            p.currency, p.stock, cleanString(p.category, { max: 120 }) || 'Uncategorised',
            p.updated_at, ts,
            JSON.stringify(p.raw).slice(0, 20000)
          );
        }
        // Products that vanished from the source become inactive (never deleted -
        // historical orders must keep resolving).
        const rows = dbx.all('SELECT id FROM products');
        const deactivate = dbx.db.prepare('UPDATE products SET active = 0, stock = 0 WHERE id = ?');
        for (const r of rows) if (!seen.has(r.id)) deactivate.run(r.id);

        dbx.run(`
          INSERT INTO sync_state (id, last_sync_at, last_status, last_error, item_count, updated_at)
          VALUES (1, ?, 'ok', NULL, ?, ?)
          ON CONFLICT(id) DO UPDATE SET last_sync_at=excluded.last_sync_at,
            last_status='ok', last_error=NULL, item_count=excluded.item_count, updated_at=excluded.updated_at
        `, [ts, normalised.length, ts]);
      });
      applySync();

      return { ok: true, count: normalised.length, at: ts, skipped: rawProducts.length - normalised.length };
    } catch (err) {
      // Cache survives upstream outages - record the failure but never throw away data.
      dbx.run(`
        INSERT INTO sync_state (id, last_sync_at, last_status, last_error, item_count, updated_at)
        VALUES (1, ?, 'error', ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET last_status='error', last_error=excluded.last_error,
          updated_at=excluded.updated_at
      `, [nowIso(), String(err.detail || err.message).slice(0, 500), nowIso()]);
      throw err;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

/** Trigger a background refresh when the cache is older than the TTL. */
function maybeRefreshInBackground() {
  const state = getSyncState();
  const ageMs = state.last_sync_at ? Date.now() - Date.parse(state.last_sync_at) : Infinity;
  if (ageMs > config.cache.ttlSeconds * 1000) {
    syncProducts({ force: true }).catch(() => { /* logged via sync_state */ });
  }
}

function startRefreshLoop() {
  const interval = Math.max(60, config.cache.refreshIntervalSeconds) * 1000;
  const t = setInterval(() => {
    syncProducts({ force: true }).catch(() => { /* failure recorded in sync_state */ });
  }, interval);
  t.unref();
  return t;
}

/* ------------------------------------------------------------------ */
/* Reads (served from the local cache, never straight from upstream)   */
/* ------------------------------------------------------------------ */
const SORTS = {
  newest: 'synced_at DESC',
  name_asc: 'name COLLATE NOCASE ASC',
  name_desc: 'name COLLATE NOCASE DESC',
  price_asc: 'selling_price ASC',
  price_desc: 'selling_price DESC',
  stock_desc: 'stock DESC'
};

function listProducts({ search = '', category = '', sort = 'name_asc', page = 1, perPage = 12, inStockOnly = false } = {}) {
  const clauses = ['active = 1'];
  const params = [];

  const s = cleanString(search, { max: 100 });
  if (s) {
    clauses.push('(name LIKE ? OR description LIKE ? OR category LIKE ?)');
    const like = `%${s}%`;
    params.push(like, like, like);
  }
  const c = cleanString(category, { max: 120 });
  if (c) { clauses.push('category = ?'); params.push(c); }

  if (inStockOnly) clauses.push('stock > 0');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = SORTS[sort] || SORTS.name_asc;

  const total = dbx.get(`SELECT COUNT(*) AS n FROM products ${where}`, params).n;
  const safePerPage = Math.min(Math.max(parseInt(perPage, 10) || 12, 1), 60);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safePerPage;

  const rows = dbx.all(
    `SELECT * FROM products ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, safePerPage, offset]
  );

  return {
    items: rows.map(toPublicProduct),
    pagination: {
      page: safePage,
      per_page: safePerPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / safePerPage)),
      has_next: offset + rows.length < total,
      has_prev: safePage > 1
    }
  };
}

function getProductById(id) {
  const row = dbx.get('SELECT * FROM products WHERE id = ?', [cleanString(id, { max: 200 })]);
  if (!row || !row.active) {
    throw notFound('PRODUCT_NOT_FOUND', 'That product could not be found.');
  }
  return row;
}

function getPublicProduct(id) {
  return toPublicProduct(getProductById(id));
}

function listCategories() {
  return dbx
    .all(`SELECT category AS name, COUNT(*) AS count FROM products
          WHERE active = 1 AND category IS NOT NULL AND category <> ''
          GROUP BY category ORDER BY name COLLATE NOCASE ASC`)
    .map((r) => ({ name: r.name, count: r.n ?? r.count }));
}

module.exports = {
  computeSellingPrice, roundPrice, toPublicProduct,
  syncProducts, getSyncState, maybeRefreshInBackground, startRefreshLoop,
  listProducts, getProductById, getPublicProduct, listCategories
};
