/* Shared front-end helpers.
 * The browser only ever talks to OUR backend (/api/...). No third-party API
 * keys, tokens or source URLs exist anywhere in this file or any other JS. */

export const CURRENCY = 'KES';

/** Format a number as KES, e.g. 50000 -> "KES 50,000" */
export function formatKES(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${CURRENCY} 0`;
  return `${CURRENCY} ${n.toLocaleString('en-KE', { maximumFractionDigits: 0 })}`;
}

/** Fetch JSON from our own API, throwing a friendly Error on failure. */
export async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
      body: options.body && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body
    });
  } catch (networkErr) {
    throw new Error('Network error - please check your connection and try again.');
  }

  let payload = null;
  const text = await res.text();
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }

  if (!res.ok) {
    // Our API always answers with a JSON error envelope. If a failing response
    // has no JSON at all, something else answered - typically a static host
    // with the backend not connected (see HOSTING.md).
    const message = payload?.error?.message
      || (payload ? `Request failed (${res.status}).`
                  : `The storefront service is unavailable (HTTP ${res.status}).`);
    const err = new Error(message);
    err.code = payload?.error?.code || 'REQUEST_FAILED';
    err.status = res.status;
    throw err;
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* Escaping - every dynamic value rendered into HTML goes through this */
/* ------------------------------------------------------------------ */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow http(s) image URLs through to an <img src>. */
export function safeImage(url) {
  if (!url) return '';
  try {
    const u = new URL(url, window.location.origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch { return ''; }
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function param(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/* ------------------------------------------------------------------ */
/* Resilience: remember the last good catalogue.                       */
/*                                                                     */
/* If the backend is briefly unreachable (restart, cold start, deploy) */
/* the listing/home pages still render the products we saw last time   */
/* instead of showing an empty page. These cached prices are DISPLAY   */
/* ONLY - checkout always re-prices on the server, so a stale cached   */
/* price can never be used to place an order.                          */
/* ------------------------------------------------------------------ */
const CATALOGUE_KEY = 'ncs_catalogue_v1';
const CATEGORIES_KEY = 'ncs_categories_v1';

function cacheWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
}

function cacheRead(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/** Persist the full, unfiltered catalogue for offline/fallback rendering. */
export function saveCatalogue(items) {
  if (Array.isArray(items) && items.length) {
    cacheWrite(CATALOGUE_KEY, { at: Date.now(), items });
  }
}

/** Return { at, items } from the last successful catalogue fetch, or null. */
export function readCatalogue() {
  const c = cacheRead(CATALOGUE_KEY);
  return c && Array.isArray(c.items) && c.items.length ? c : null;
}

export function saveCategories(cats) {
  if (Array.isArray(cats) && cats.length) cacheWrite(CATEGORIES_KEY, { at: Date.now(), cats });
}

export function readCategories() {
  const c = cacheRead(CATEGORIES_KEY);
  return c && Array.isArray(c.cats) ? c.cats : null;
}

/** Human-readable notice shown when we had to fall back to cached data. */
export function staleNotice(at) {
  const when = at ? new Date(at).toLocaleString('en-KE') : 'earlier';
  return `Live catalogue temporarily unavailable. Showing the last items we loaded (${when}). ` +
    'Prices are refreshed on the server when you check out.';
}

/* ------------------------------------------------------------------ */
/* Resilience layer 2: a static snapshot shipped with the site itself. */
/*                                                                     */
/* frontend/data/catalogue.json is built at deploy time (see           */
/* scripts/build-catalogue-snapshot.py) and served straight from the   */
/* static host. It works even for a first-time visitor whose browser   */
/* has no localStorage cache yet, so the product listing survives a    */
/* backend restart or cold start. Display only - checkout re-prices.   */
/* ------------------------------------------------------------------ */
const SNAPSHOT_URL = '/data/catalogue.json';
let snapshotPromise = null;

/**
 * Load the bundled catalogue snapshot. Cached in memory for the page life
 * and in localStorage so later visits are instant. Returns { at, items,
 * categories } or null when even the snapshot is unavailable.
 */
export function loadSnapshot() {
  if (snapshotPromise) return snapshotPromise;
  snapshotPromise = (async () => {
    try {
      const res = await fetch(`${SNAPSHOT_URL}?v=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const snap = await res.json();
      const items = Array.isArray(snap.items) ? snap.items : [];
      const categories = Array.isArray(snap.categories) ? snap.categories : [];
      if (!items.length) return null;
      if (categories.length) cacheWrite(CATEGORIES_KEY, { at: Date.now(), cats: categories });
      cacheWrite(CATALOGUE_KEY, { at: Date.now(), items });
      const at = snap.generated_at ? Date.parse(snap.generated_at) : Date.now();
      return { at, items, categories };
    } catch {
      return null;
    }
  })();
  return snapshotPromise;
}

/** Notice shown when the bundled snapshot had to stand in for the live API. */
export function snapshotNotice(at) {
  const when = at ? new Date(at).toLocaleDateString('en-KE') : 'recently';
  return `Showing our catalogue snapshot from ${when}. The live store service is ` +
    'catching up - prices are confirmed on the server when you check out.';
}

/** Placeholder tile shown when a product has no usable image. */
export function imagePlaceholder() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="225" viewBox="0 0 300 225">
    <rect width="300" height="225" fill="#eceef1"/>
    <text x="150" y="118" font-family="sans-serif" font-size="15" fill="#6b7280" text-anchor="middle">No image</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
