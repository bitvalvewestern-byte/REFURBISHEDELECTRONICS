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
    const message = payload?.error?.message || `Request failed (${res.status}).`;
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

/** Placeholder tile shown when a product has no usable image. */
export function imagePlaceholder() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="225" viewBox="0 0 300 225">
    <rect width="300" height="225" fill="#eceef1"/>
    <text x="150" y="118" font-family="sans-serif" font-size="15" fill="#6b7280" text-anchor="middle">No image</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
