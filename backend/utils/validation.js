'use strict';
const { badRequest } = require('./errors');

/** Collapse whitespace and strip control characters. */
function cleanString(value, { max = 500 } = {}) {
  if (value === undefined || value === null) return '';
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Reject anything that is not a plain scalar (defends against object injection). */
function assertScalar(value, field) {
  if (value !== undefined && value !== null &&
      (typeof value === 'object' || typeof value === 'function')) {
    throw badRequest('VALIDATION_ERROR', `${field} must be a simple value`);
  }
  return value;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Kenyan mobile: 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX */
const KE_PHONE_RE = /^(?:\+?254|0)(?:7|1)\d{8}$/;

function normalizePhone(value) {
  const raw = cleanString(value, { max: 20 }).replace(/[\s()-]/g, '');
  if (!raw) return '';
  let digits = raw;
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('254')) return `0${digits.slice(3)}`;
  return digits;
}

function isKenyanPhone(value) {
  return KE_PHONE_RE.test(normalizePhone(value));
}

function isEmail(value) {
  return EMAIL_RE.test(cleanString(value, { max: 254 }));
}

function toPositiveInt(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  assertScalar(value, field);
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isInteger(n) || String(value).trim() === '') {
    throw badRequest('VALIDATION_ERROR', `${field} must be a whole number`);
  }
  if (n < min || n > max) {
    throw badRequest('VALIDATION_ERROR', `${field} must be between ${min} and ${max}`);
  }
  return n;
}

/** Only http(s) image URLs are allowed - blocks javascript:/data: injection. */
function safeUrl(value, fallback = '') {
  const raw = cleanString(value, { max: 2000 });
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
    return u.toString();
  } catch {
    return fallback;
  }
}

/** Escape for safe HTML interpolation on the server side. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Coerce arbitrary price representations ("KES 100,000.00") into a number. */
function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined) return NaN;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function pick(obj, dottedPath) {
  if (!obj || !dottedPath) return undefined;
  return String(dottedPath)
    .split('.')
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

module.exports = {
  cleanString, assertScalar, normalizePhone, isKenyanPhone, isEmail,
  toPositiveInt, safeUrl, escapeHtml, parsePrice, pick
};
