-- Storefront schema (SQLite). Relationship + index definitions included.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

/* ------------------------------------------------------------------ */
/* Catalogue (populated from the authorized source API)                */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS products (
  id               TEXT PRIMARY KEY,            -- normalised source id
  source_id        TEXT,
  name             TEXT NOT NULL,
  description      TEXT,
  image            TEXT,
  source_price     REAL NOT NULL,               -- INTERNAL ONLY
  selling_price    REAL NOT NULL,               -- source_price * factor
  currency         TEXT NOT NULL DEFAULT 'KES',
  stock            INTEGER NOT NULL DEFAULT 0,
  category         TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  source_updated_at TEXT,
  synced_at        TEXT NOT NULL,
  raw              TEXT                         -- raw source record for audit
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_name     ON products(name);

CREATE TABLE IF NOT EXISTS sync_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at   TEXT,
  last_status    TEXT,          -- never_synced | ok | error
  last_error     TEXT,
  item_count     INTEGER DEFAULT 0,
  updated_at     TEXT
);

/* ------------------------------------------------------------------ */
/* Customers (guest)                                                   */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  email      TEXT,
  county     TEXT,
  town       TEXT,
  address    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

/* ------------------------------------------------------------------ */
/* Delivery zones (seeded from config/delivery.json - editable)        */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS delivery_zones (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  fee         REAL NOT NULL,
  match_terms TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number      TEXT NOT NULL UNIQUE,
  view_token        TEXT NOT NULL,               -- proves ownership of an order
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  customer_email    TEXT,
  county            TEXT,
  town              TEXT,
  address           TEXT NOT NULL,
  delivery_instructions TEXT,
  delivery_location TEXT,
  delivery_zone_id  TEXT REFERENCES delivery_zones(id) ON DELETE SET NULL,
  delivery_fee      REAL NOT NULL DEFAULT 0,
  subtotal          REAL NOT NULL,
  total             REAL NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'KES',
  payment_status    TEXT NOT NULL DEFAULT 'unpaid',   -- unpaid|pending|paid|failed|refunded
  order_status      TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|paid|processing|shipped|delivered|cancelled
  idempotency_key   TEXT,
  fingerprint       TEXT,                             -- duplicate-order detection
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(order_status);
CREATE INDEX IF NOT EXISTS idx_orders_payment   ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_fp        ON orders(fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_created   ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   TEXT NOT NULL,
  product_name TEXT NOT NULL,
  unit_price   REAL NOT NULL,     -- SERVER-AUTHORITATIVE snapshot
  quantity     INTEGER NOT NULL,
  line_total   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL DEFAULT 'placeholder',
  provider_ref TEXT,
  amount       REAL NOT NULL,     -- always the SERVER-calculated total
  currency     TEXT NOT NULL DEFAULT 'KES',
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|failed|cancelled
  payload      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order   ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments(status);

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id         TEXT PRIMARY KEY,          -- random session id (stored hashed)
  admin_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at);
