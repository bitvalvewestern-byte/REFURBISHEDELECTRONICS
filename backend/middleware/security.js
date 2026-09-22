'use strict';
const rateLimit = require('express-rate-limit');
const config = require('../config');

/* ------------------------------------------------------------------ */
/* CORS - explicit allow-list only. No wildcard, no credentials by      */
/* default (we use SameSite cookies for admin rather than cross-origin).*/
/* ------------------------------------------------------------------ */
function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowed = config.security.corsOrigins;

  if (origin) {
    const isSameOrigin = origin === config.publicBaseUrl ||
      allowed.includes(origin) ||
      (config.env !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));

    if (isSameOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '600');
    } else if (req.method === 'OPTIONS') {
      return res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' } });
    }
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

/**
 * Defence-in-depth against CSRF for state-changing requests: if a browser
 * sends an Origin/Referer it must match our own origin. SameSite=Strict on the
 * admin session cookie is the primary control; this backs it up.
 */
function enforceSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next(); // non-browser client (curl, server-to-server)
  let host;
  try { host = new URL(origin).origin; } catch { return deny(res); }
  const ok = host === config.publicBaseUrl ||
    config.security.corsOrigins.includes(host) ||
    (config.env !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(host));
  if (!ok) return deny(res);
  return next();
}

function deny(res) {
  return res.status(403).json({ error: { code: 'CSRF_ORIGIN_MISMATCH', message: 'Request blocked.' } });
}

/* ------------------------------------------------------------------ */
/* Rate limiters                                                       */
/* ------------------------------------------------------------------ */
const limiter = (name, opts) => rateLimit({
  windowMs: opts.windowMs,
  max: opts.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } },
  // keyGenerator default (IP) is correct; trust proxy is opt-in via env.
  validate: { xForwardedForHeader: false }
});

const globalLimiter = limiter('global', config.security.rateLimits.global);
const orderLimiter = limiter('orders', config.security.rateLimits.orders);
const paymentLimiter = limiter('payment', config.security.rateLimits.payment);
const loginLimiter = limiter('login', config.security.rateLimits.login);

/** JSON body parser with a strict size cap. */
const jsonBody = require('express').json({ limit: '64kb', strict: true });

module.exports = { cors, enforceSameOrigin, globalLimiter, orderLimiter, paymentLimiter, loginLimiter, jsonBody };
