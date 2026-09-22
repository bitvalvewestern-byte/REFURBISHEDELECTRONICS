'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const dbx = require('../db');
const { unauthorized, forbidden, tooMany } = require('../utils/errors');

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt, no external dependency)                   */
/* ------------------------------------------------------------------ */
function hashPassword(password) {
  const { N, r, p, keylen } = config.admin.scrypt;
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(password, salt, expected.length, {
      N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10)
    });
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Admin account bootstrap                                             */
/* ------------------------------------------------------------------ */
function ensureAdminUser() {
  const existing = dbx.get('SELECT id FROM admin_users WHERE username = ?', [config.admin.username]);
  if (existing) return existing.id;

  let hash = config.admin.passwordHash;
  if (!hash && config.admin.plainPassword && config.env !== 'production') {
    hash = hashPassword(config.admin.plainPassword);   // dev convenience only
  }
  if (!hash) {
    // No credentials configured: do NOT create a guessable account.
    return null;
  }
  const ts = dbx.nowIso();
  const res = dbx.run(
    'INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?,?,?,?)',
    [config.admin.username, hash, ts, ts]
  );
  return Number(res.lastInsertRowid);
}

/* ------------------------------------------------------------------ */
/* In-memory login throttle (per username+IP)                          */
/* ------------------------------------------------------------------ */
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

function throttleKey(username, ip) { return `${username}|${ip}`; }

function checkThrottle(username, ip) {
  const key = throttleKey(username, ip);
  const rec = attempts.get(key);
  if (!rec) return;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return; }
  if (rec.count >= MAX_ATTEMPTS) {
    throw tooMany('TOO_MANY_LOGIN_ATTEMPTS', 'Too many failed login attempts. Try again in 15 minutes.');
  }
}
function recordFailure(username, ip) {
  const key = throttleKey(username, ip);
  const rec = attempts.get(key) || { count: 0, first: Date.now() };
  rec.count += 1;
  attempts.set(key, rec);
}
function clearFailures(username, ip) { attempts.delete(throttleKey(username, ip)); }

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function login({ username, password, ip, userAgent }) {
  const user = dbx.get('SELECT * FROM admin_users WHERE username = ?', [String(username || '')]);
  checkThrottle(String(username || ''), ip);

  // Constant-ish time: always run a scrypt verification.
  const stored = user ? user.password_hash : hashPassword('--dummy-password--');
  const ok = verifyPassword(password, stored) && !!user;

  if (!ok) {
    recordFailure(String(username || ''), ip);
    throw unauthorized('INVALID_CREDENTIALS', 'Invalid username or password.');
  }
  clearFailures(username, ip);

  const sid = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const ts = dbx.nowIso();
  const expires = new Date(Date.now() + config.admin.sessionTtlSeconds * 1000).toISOString();

  dbx.run(`INSERT INTO admin_sessions (id, admin_id, csrf_token, ip, user_agent, created_at, expires_at)
           VALUES (?,?,?,?,?,?,?)`,
    [sha256(sid), user.id, csrf, ip || null, String(userAgent || '').slice(0, 200), ts, expires]);

  dbx.run('INSERT INTO admin_audit_log (admin_id, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?)',
    [user.id, 'login', username, null, ip || null, ts]);

  return { sid, csrf, expires, username: user.username };
}

function logout(sid, adminId, ip) {
  if (!sid) return;
  dbx.run('DELETE FROM admin_sessions WHERE id = ?', [sha256(sid)]);
  dbx.run('INSERT INTO admin_audit_log (admin_id, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?)',
    [adminId || null, 'logout', null, null, ip || null, dbx.nowIso()]);
}

function getSession(sid) {
  if (!sid) return null;
  const row = dbx.get(`
    SELECT s.*, u.username FROM admin_sessions s
    JOIN admin_users u ON u.id = s.admin_id
    WHERE s.id = ?`, [sha256(sid)]);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    dbx.run('DELETE FROM admin_sessions WHERE id = ?', [row.id]);
    return null;
  }
  return row;
}

function audit(adminId, action, target, detail, ip) {
  dbx.run('INSERT INTO admin_audit_log (admin_id, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?)',
    [adminId || null, action, target || null, detail ? String(detail).slice(0, 500) : null, ip || null, dbx.nowIso()]);
}

module.exports = {
  hashPassword, verifyPassword, ensureAdminUser,
  login, logout, getSession, audit
};
