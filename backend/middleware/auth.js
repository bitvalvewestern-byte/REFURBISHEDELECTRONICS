'use strict';
const config = require('../config');
const adminService = require('../services/adminService');
const { unauthorized, forbidden } = require('../utils/errors');

const SESSION_COOKIE = 'ncs_admin_session';
const CSRF_COOKIE = 'ncs_admin_csrf';

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.security.cookieSecure,
    sameSite: 'strict',
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {})
  };
}

/** Verifies the admin session cookie; attaches req.admin. */
function requireAdmin(req, res, next) {
  const sid = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  const session = adminService.getSession(sid);
  if (!session) {
    return next(unauthorized('NOT_AUTHENTICATED', 'Please sign in to access the admin area.'));
  }
  req.admin = { id: session.admin_id, username: session.username, sessionHash: session.id };
  return next();
}

/**
 * CSRF double-submit: the value in the (readable) csrf cookie must equal the
 * value echoed in the X-CSRF-Token header AND the value bound to the session.
 */
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const header = req.headers['x-csrf-token'];
  const cookie = req.cookies ? req.cookies[CSRF_COOKIE] : null;
  const sid = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  const session = adminService.getSession(sid);

  if (!session) return next(unauthorized('NOT_AUTHENTICATED', 'Please sign in.'));
  if (!header || !cookie || header !== cookie || header !== session.csrf_token) {
    return next(forbidden('CSRF_FAILED', 'Invalid or missing CSRF token.'));
  }
  req.admin = { id: session.admin_id, username: session.username, sessionHash: session.id };
  return next();
}

module.exports = { requireAdmin, requireCsrf, SESSION_COOKIE, CSRF_COOKIE, cookieOptions };
