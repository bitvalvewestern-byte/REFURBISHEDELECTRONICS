'use strict';
/**
 * Source API adapter.
 *
 * This is the ONLY place that talks to the upstream (authorized) product
 * source. Credentials live in backend/.env and are read here; they are never
 * serialised into any API response.
 *
 * Two drivers:
 *   - 'http' -> real authorized REST API (base URL + auth + pagination)
 *   - 'mock' -> bundled local JSON file, used to exercise the full pipeline
 *               before the real endpoint details are supplied.
 */
const fs = require('node:fs');
const config = require('../config');
const { upstream } = require('../utils/errors');
const { pick } = require('../utils/validation');

const mapping = JSON.parse(
  fs.readFileSync(require('node:path').join(__dirname, '..', 'config', 'source-mapping.json'), 'utf8')
);

/* ------------------------------------------------------------------ */
/* Auth / request construction                                         */
/* ------------------------------------------------------------------ */
function buildHeaders() {
  const s = config.source;
  const headers = { Accept: 'application/json', 'User-Agent': 'StorefrontSync/1.0' };
  switch (s.authType) {
    case 'bearer':
      if (s.token) headers['Authorization'] = `Bearer ${s.token}`;
      break;
    case 'header':
      if (s.apiKey || s.token) headers[s.authHeader] = s.apiKey || s.token;
      break;
    case 'basic': {
      const creds = Buffer.from(`${s.basicUser}:${s.basicPass}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
      break;
    }
    case 'query':
    case 'none':
    default:
      break;
  }
  return headers;
}

function buildQuery(page, cursor) {
  const s = config.source;
  const q = new URLSearchParams();
  if (s.authType === 'query' && (s.apiKey || s.token)) {
    q.set(s.authQueryParam, s.apiKey || s.token);
  }
  switch (s.pagination) {
    case 'page':
      q.set(s.perPageParam, String(s.perPage));
      q.set(s.pageParam, String(page));
      break;
    case 'offset':
      q.set(s.perPageParam, String(s.perPage));
      q.set(s.offsetParam, String((page - s.startPage) * s.perPage));
      break;
    case 'cursor':
      q.set(s.perPageParam, String(s.perPage));
      if (cursor) q.set(s.cursorParam, cursor);
      break;
    default:
      break;
  }
  return q.toString();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.source.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: buildHeaders(),
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!res.ok) {
      // Never surface upstream auth/rate-limit detail to the browser.
      const snippet = (await res.text().catch(() => '')).slice(0, 300);
      throw upstream(
        'SOURCE_API_ERROR',
        'The product source is temporarily unavailable.',
        `upstream ${res.status} for ${redact(url)} :: ${snippet}`
      );
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AppError') throw err;
    if (err.name === 'AbortError') {
      throw upstream('SOURCE_API_TIMEOUT', 'The product source timed out.', String(err.message));
    }
    throw upstream('SOURCE_API_UNREACHABLE', 'The product source is unreachable.', String(err.message));
  } finally {
    clearTimeout(timer);
  }
}

/** Strip credentials from URLs before logging. */
function redact(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has(config.source.authQueryParam)) {
      u.searchParams.set(config.source.authQueryParam, '***');
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Locate the product array inside an arbitrary JSON envelope. */
function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  const p = config.source.itemsPath;
  if (p) {
    const candidate = pick(payload, p);
    if (Array.isArray(candidate)) return candidate;
  }
  // Common envelopes
  for (const key of ['data', 'items', 'products', 'results', 'records', 'rows']) {
    const v = pick(payload, key);
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.items)) return v.items;
    if (v && Array.isArray(v.data)) return v.data;
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Pull every raw product record from the source. */
async function fetchAllRawProducts() {
  if (config.source.driver === 'mock') return readMockSource();

  if (!config.source.baseUrl) {
    throw upstream('SOURCE_API_NOT_CONFIGURED', 'The product source is not configured.');
  }

  const base = config.source.baseUrl + config.source.productsPath;
  const collected = [];
  let page = config.source.startPage;
  let cursor = '';

  for (let i = 0; i < config.source.maxPages; i += 1) {
    const qs = buildQuery(page, cursor);
    const payload = await fetchJson(qs ? `${base}?${qs}` : base);
    const items = extractItems(payload);
    collected.push(...items);

    if (config.source.pagination === 'none' || config.source.pagination === '') break;
    if (items.length === 0) break;
    if (config.source.pagination === 'cursor') {
      const next = config.source.nextCursorPath ? pick(payload, config.source.nextCursorPath) : null;
      if (!next) break;
      cursor = String(next);
    } else {
      if (items.length < config.source.perPage) break;
      page += 1;
    }
  }
  return collected;
}

/** Local test double - reads the bundled mock source JSON. */
function readMockSource() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.source.mockFile, 'utf8'));
    return extractItems(raw);
  } catch (err) {
    throw upstream(
      'SOURCE_API_UNREADABLE',
      'The product source is unavailable.',
      `cannot read mock source ${config.source.mockFile}: ${err.message}`
    );
  }
}

/** First non-empty mapped value for a normalised field. */
function mapField(record, field) {
  const candidates = mapping[field] || [];
  for (const path of candidates) {
    const v = pick(record, path);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * Normalise a raw source record into the storefront model.
 * Returns null when the record is unusable (no id / no price).
 */
function normalize(record) {
  if (!record || typeof record !== 'object') return null;
  const rawId = mapField(record, 'id');
  if (rawId === undefined) return null;

  const id = String(rawId).trim();
  if (!id) return null;

  const priceRaw = mapField(record, 'source_price');
  const sourcePrice = require('../utils/validation').parsePrice(priceRaw);
  if (!Number.isFinite(sourcePrice) || sourcePrice < 0) return null;

  const stockRaw = mapField(record, 'stock');
  let stock = 0;
  if (stockRaw !== undefined) {
    const n = parseInt(String(stockRaw), 10);
    stock = Number.isFinite(n) && n > 0 ? n : 0;
  }

  const name = String(mapField(record, 'name') || `Product ${id}`).trim();
  const currency = String(mapField(record, 'currency') || config.pricing.currency)
    .trim()
    .toUpperCase()
    .slice(0, 8);

  return {
    id,
    name,
    description: String(mapField(record, 'description') || '').trim(),
    image: String(mapField(record, 'image') || '').trim(),
    source_price: sourcePrice,
    currency: currency || config.pricing.currency,
    stock,
    category: String(mapField(record, 'category') || 'Uncategorised').trim() || 'Uncategorised',
    updated_at: mapField(record, 'updated_at') || null,
    raw: record
  };
}

module.exports = { fetchAllRawProducts, normalize, readMockSource, mapping, redact };
