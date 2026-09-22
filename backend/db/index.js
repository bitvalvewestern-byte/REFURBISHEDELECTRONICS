'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

fs.mkdirSync(path.dirname(config.db.file), { recursive: true });

const db = new DatabaseSync(config.db.file);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

// Apply schema (idempotent - all statements use IF NOT EXISTS).
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const nowIso = () => new Date().toISOString();

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

/** Wrap a function in an IMMEDIATE transaction. */
function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Delivery zones: seed/refresh from config so fees stay editable      */
/* ------------------------------------------------------------------ */
function loadDeliveryConfig() {
  const raw = fs.readFileSync(config.delivery.configFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.zones) || parsed.zones.length === 0) {
    throw new Error('delivery.json must contain a non-empty "zones" array');
  }
  for (const z of parsed.zones) {
    if (!z.id || typeof z.fee !== 'number' || z.fee < 0) {
      throw new Error(`delivery.json: zone "${z.id || '?'}" needs an id and a numeric fee >= 0`);
    }
  }
  return parsed;
}

function seedDeliveryZones() {
  const cfg = loadDeliveryConfig();
  const upsert = db.prepare(`
    INSERT INTO delivery_zones (id, label, fee, match_terms, is_default, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label=excluded.label, fee=excluded.fee, match_terms=excluded.match_terms,
      is_default=excluded.is_default, updated_at=excluded.updated_at
  `);
  const ts = nowIso();
  for (const z of cfg.zones) {
    upsert.run(
      z.id,
      z.label || z.id,
      z.fee,
      JSON.stringify(z.match_terms || []),
      z.id === cfg.default_zone_id ? 1 : 0,
      ts
    );
  }
  return cfg;
}

module.exports = { db, run, get, all, transaction, nowIso, seedDeliveryZones, loadDeliveryConfig };
