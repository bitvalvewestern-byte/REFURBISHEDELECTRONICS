'use strict';
/**
 * Central configuration. EVERYTHING private is read from environment
 * variables (.env) and never leaves the server process.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const toBool = (v, d = false) => {
  if (v === undefined || v === null || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
};
const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const toFloat = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
/** Accepts "https://a.com,https://b.com" */
const toList = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const BACKEND_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 8080),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:8080').replace(/\/+$/, ''),

  /* ------------------------------------------------------------------ *
   * Authorized source API (SERVER-SIDE ONLY - never sent to browser)
   * ------------------------------------------------------------------ */
  source: {
    // 'http' -> call the real authorized source API over HTTP
    // 'mock' -> read the bundled local mock source (testing only)
    driver: (process.env.SOURCE_DRIVER || 'mock').toLowerCase(),
    baseUrl: (process.env.SOURCE_API_BASE_URL || '').replace(/\/+$/, ''),
    productsPath: process.env.SOURCE_API_PRODUCTS_PATH || '/products',
    timeoutMs: toInt(process.env.SOURCE_API_TIMEOUT_MS, 15000),
    verifyTLS: toBool(process.env.SOURCE_API_VERIFY_TLS, true),

    // Authentication method against the source API
    authType: (process.env.SOURCE_API_AUTH_TYPE || 'bearer').toLowerCase(),
    authHeader: process.env.SOURCE_API_AUTH_HEADER || 'Authorization',
    authQueryParam: process.env.SOURCE_API_AUTH_QUERY_PARAM || 'api_key',
    token: process.env.SOURCE_API_TOKEN || '',
    apiKey: process.env.SOURCE_API_KEY || '',
    basicUser: process.env.SOURCE_API_BASIC_USER || '',
    basicPass: process.env.SOURCE_API_BASIC_PASS || '',

    // Pagination strategy for walking the source catalogue
    pagination: (process.env.SOURCE_API_PAGINATION || 'none').toLowerCase(),
    pageParam: process.env.SOURCE_API_PAGE_PARAM || 'page',
    perPageParam: process.env.SOURCE_API_PER_PAGE_PARAM || 'per_page',
    offsetParam: process.env.SOURCE_API_OFFSET_PARAM || 'offset',
    cursorParam: process.env.SOURCE_API_CURSOR_PARAM || 'cursor',
    perPage: toInt(process.env.SOURCE_API_PER_PAGE, 100),
    maxPages: toInt(process.env.SOURCE_API_MAX_PAGES, 50),
    startPage: toInt(process.env.SOURCE_API_START_PAGE, 1),

    // Where the product array lives inside the JSON response ('' = root)
    itemsPath: process.env.SOURCE_API_ITEMS_PATH || '',
    // Optional dotted paths used for pagination bookkeeping
    totalPath: process.env.SOURCE_API_TOTAL_PATH || '',
    nextCursorPath: process.env.SOURCE_API_NEXT_CURSOR_PATH || '',
    // Absolute path to a local JSON file used by the 'mock' driver
    mockFile:
      process.env.SOURCE_MOCK_FILE || path.join(PROJECT_ROOT, 'mock-source-api', 'products.json')
  },

  /* ------------------------------------------------------------------ *
   * Pricing
   * ------------------------------------------------------------------ */
  pricing: {
    // selling_price = source_price * factor  (client asked for 50%)
    factor: toFloat(process.env.SELLING_PRICE_FACTOR, 0.5),
    currency: process.env.CURRENCY || 'KES',
    // Rounding: 'none' | 'integer' | 'nearest50' | 'nearest100'
    rounding: (process.env.PRICE_ROUNDING || 'integer').toLowerCase(),
    // Expose source_price to the browser? Kept OFF so customers cannot see cost.
    exposeSourcePrice: toBool(process.env.EXPOSE_SOURCE_PRICE, false)
  },

  /* ------------------------------------------------------------------ *
   * Catalogue cache / refresh
   * ------------------------------------------------------------------ */
  cache: {
    ttlSeconds: toInt(process.env.PRODUCT_CACHE_TTL_SECONDS, 300),
    refreshIntervalSeconds: toInt(process.env.PRODUCT_REFRESH_INTERVAL_SECONDS, 900),
    syncOnBoot: toBool(process.env.SYNC_ON_BOOT, true)
  },

  delivery: {
    configFile: process.env.DELIVERY_CONFIG_FILE || path.join(__dirname, 'delivery.json')
  },

  /* ------------------------------------------------------------------ *
   * Database
   * ------------------------------------------------------------------ */
  db: {
    file: process.env.DB_FILE || path.join(BACKEND_ROOT, 'data', 'storefront.sqlite')
  },

  /* ------------------------------------------------------------------ *
   * Admin area
   * ------------------------------------------------------------------ */
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    // scrypt hash produced by: npm run hash-password -- "your-password"
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    // Development-only fallback. Ignored in production.
    plainPassword: process.env.ADMIN_PASSWORD || '',
    sessionTtlSeconds: toInt(process.env.ADMIN_SESSION_TTL_SECONDS, 3600 * 8),
    // Argon-ish scrypt parameters
    scrypt: { N: 16384, r: 8, p: 1, keylen: 64 }
  },

  security: {
    // Browser origins allowed to call this API. Empty -> same-origin only.
    corsOrigins: toList(process.env.CORS_ORIGINS),
    trustProxy: toBool(process.env.TRUST_PROXY, false),
    cookieSecure: toBool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),
    rateLimits: {
      global: { windowMs: 60_000, max: toInt(process.env.RATE_LIMIT_GLOBAL_MAX, 300) },
      orders: { windowMs: 60_000, max: toInt(process.env.RATE_LIMIT_ORDERS_MAX, 10) },
      payment: { windowMs: 60_000, max: toInt(process.env.RATE_LIMIT_PAYMENT_MAX, 20) },
      login: { windowMs: 15 * 60_000, max: toInt(process.env.RATE_LIMIT_LOGIN_MAX, 10) }
    }
  },

  orders: {
    maxQuantityPerItem: toInt(process.env.MAX_QUANTITY_PER_ITEM, 20),
    maxDistinctItems: toInt(process.env.MAX_DISTINCT_ITEMS, 30),
    // Reject an identical guest order (same phone + same items) created within
    // this window unless an explicit idempotency key is supplied.
    duplicateWindowSeconds: toInt(process.env.DUPLICATE_ORDER_WINDOW_SECONDS, 120),
    // Fallback fee if the zone cannot be resolved (must exist in delivery.json)
    requireStock: toBool(process.env.REQUIRE_STOCK, true)
  },

  paths: {
    backendRoot: BACKEND_ROOT,
    projectRoot: PROJECT_ROOT,
    frontend: path.join(PROJECT_ROOT, 'frontend')
  }
};

/** Fail fast when a required secret is missing. */
function assertRuntimeConfig() {
  const errors = [];
  if (config.source.driver === 'http') {
    if (!config.source.baseUrl) errors.push('SOURCE_API_BASE_URL is required when SOURCE_DRIVER=http');
    if (config.source.authType !== 'none' && !config.source.token && !config.source.apiKey &&
        !(config.source.basicUser && config.source.basicPass)) {
      errors.push('No source API credential configured (SOURCE_API_TOKEN / SOURCE_API_KEY / basic)');
    }
  }
  if (!(config.pricing.factor > 0 && config.pricing.factor <= 1)) {
    errors.push('SELLING_PRICE_FACTOR must be > 0 and <= 1');
  }
  if (config.env === 'production') {
    if (!config.admin.passwordHash)
      errors.push('ADMIN_PASSWORD_HASH must be set in production (plain ADMIN_PASSWORD is dev-only)');
    if (!config.security.cookieSecure)
      errors.push('COOKIE_SECURE must be true in production');
  }
  return errors;
}

module.exports = config;
module.exports.assertRuntimeConfig = assertRuntimeConfig;
