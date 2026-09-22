# Nairobi Computer Shop - Storefront (frontend + backend + mock source API)

A working e-commerce storefront for **Nairobi Computer Shop** (modeled on
https://nairobicomputershop.co.ke) that imports products from an authorized
source API, resells them at **50% of the source price**, and completes a full
guest checkout with **server-authoritative pricing**.

This is not a mockup: the whole pipeline runs end to end and is covered by a
57-check automated suite (`tools/e2e_flow_test.mjs`, currently **57 passed / 0 failed**).

```
SOURCE API  ->  BACKEND (sync + 50% price + cache/DB)  ->  STOREFRONT
                                                            |
   product list -> product details -> cart -> delivery fee -> grand total
                                                            |
                        guest checkout -> SERVER VALIDATION -> order created
                                                            |
                                            payment (placeholder) -> confirmation
```

---

## 1. Quick start

Prerequisites: Node.js >= 22.5 (tested on v24.18.0).

```bash
# 1) mock source API (stand-in for your authorized product API)
node mock-source-api/server.js          # http://127.0.0.1:9099/products  (Bearer auth)

# 2) backend
cd backend
cp .env.example .env                    # then edit values (see section 4)
npm install
npm start                               # http://127.0.0.1:8080

# 3) run the whole flow + security suite (backend must be running)
cd ..
node tools/e2e_flow_test.mjs http://127.0.0.1:8080
```

The storefront is served by the same backend process: `http://127.0.0.1:8080/`.

| Page | URL |
| --- | --- |
| Home | `/` |
| Product listing (search / category / sort / pagination) | `/products.html` |
| Product details | `/product.html?id=NCS-LP-001` |
| Cart | `/cart.html` |
| Checkout (guest) | `/checkout.html` |
| Order confirmation | `/order-success.html?order=...&token=...` |
| Admin (login + dashboard) | `/admin` |

Admin demo credentials come from `backend/.env` (`ADMIN_USERNAME`,
`ADMIN_PASSWORD` for development only). Generate a production hash with:

```bash
cd backend && npm run hash-password -- "YourStrongPassword"   # -> ADMIN_PASSWORD_HASH
```

---

## 2. Requirement coverage

| Requirement | Status | Where |
| --- | --- | --- |
| Import/sync products from the authorized source API | Done | `backend/services/sourceApi.js`, `productService.js` |
| Display imported products on the storefront | Done | `frontend/*.html` + `frontend/js/*.js` |
| Selling price = 50% of source price | Done | `SELLING_PRICE_FACTOR=0.50` in `backend/config/index.js` |
| Never expose credentials in the frontend | Done | Only `backend/.env`; browser calls `/api/*` only |
| Add to cart (guest, no account) | Done | `frontend/js/cart.js`, cart in `localStorage` |
| Guest checkout without login | Done | `POST /api/orders` (no auth required) |
| Subtotal + delivery fee + grand total | Done | `orderService.priceBasket()` |
| Send the order to the backend | Done | `POST /api/orders` |
| Server-side price authoritative (no dev-tools tampering) | Done, tested | Server re-prices from product IDs; see section 6 |
| Responsive design (desktop + mobile) | Done | `frontend/css/styles.css` |
| Product listing: search / category / sort / pagination | Done | `frontend/js/products.js` |
| Product details page with quantity selector | Done | `frontend/js/product.js` |
| Cart: images, unit price, qty +/-, remove, line totals | Done | `frontend/js/cart-page.js` |
| Configurable delivery fees (backend config, not hard-coded) | Done | `backend/config/delivery.json` |
| Guest checkout form (name, phone, county, town, address, notes) | Done | `frontend/checkout.html` |
| Order confirmation (number, items, totals, status, delivery info) | Done | `frontend/js/order-success.js` |
| Payment hook with server-set amount | Placeholder | `POST /api/payment/create` (`paymentService.js`) |
| Admin area with auth + order management | Done | `/admin`, `backend/routes/admin.js` |
| DB with indexed tables/relationships | Done | `backend/db/schema.sql` (SQLite) |
| API caching (no upstream call per visitor) | Done | DB-backed product cache, TTL + periodic refresh |
| Error handling without stack traces | Done | `backend/middleware/errorHandler.js`, `utils/errors.js` |
| Rate limiting, CSRF, secure cookies, CORS, env secrets | Done, tested | `backend/middleware/security.js`, `auth.js` |

---

## 3. Architecture

```
mock-source-api/            stand-in upstream (Bearer-protected, 30 products, SKU ids)
backend/
  server.js                 express app: helmet + CSP, CORS allow-list, static frontend
  config/index.js           all config/secrets from env
  config/delivery.json      delivery zones + fees (edit here to change fees)
  config/source-mapping.json  source field -> internal field mapping
  services/sourceApi.js     upstream adapter: auth, pagination, mapping, cache TTL
  services/productService.js  sync into SQLite, 50% price rule, public/staff views
  services/orderService.js  pricing, stock, order creation, view tokens, quotes
  services/paymentService.js  placeholder provider (amount always server-derived)
  services/adminService.js  admin sessions (scrypt hash), stats, audit log
  routes/api.js             public API
  routes/admin.js           admin API (auth + CSRF on writes)
  middleware/security.js    CORS, same-origin guard, rate limits, body limit
  middleware/auth.js        session cookie, CSRF double-submit
  db/schema.sql             products, orders, order_items, customers, payments,
                            delivery_zones, sync_state, admin_users,
                            admin_sessions, admin_audit_log (+ indexes)
frontend/                   static pages + ES modules + CSS (no build step)
tools/e2e_flow_test.mjs     57-check end-to-end + security suite
docs/                       screenshots + security report
```

Data flow for a purchase:

1. `GET /api/products` reads the local cache/DB (upstream is called only on sync).
2. The browser stores `{product_id, quantity}` in `localStorage` - never a price it trusts.
3. `POST /api/orders/quote` (or checkout) sends **only IDs and quantities**.
4. The server loads current prices, checks stock, resolves the delivery zone,
   computes subtotal + fee + total, and only then writes the order.

---

## 4. Configuration for your real source API

Everything private lives in `backend/.env` (git-ignored; never served to the
browser). Minimum changes to point at your authorized API:

```ini
SOURCE_DRIVER=http
SOURCE_API_BASE_URL=https://api.example.com
SOURCE_API_PRODUCTS_PATH=/products
SOURCE_API_AUTH_TYPE=bearer         # bearer | header | query | basic | none
SOURCE_API_TOKEN=...                # or SOURCE_API_KEY / basic user+pass
SOURCE_API_PAGINATION=none          # none | page | offset | cursor
SOURCE_API_ITEMS_PATH=data           # where the product array sits in the JSON
```

If your payload uses different field names, edit
`backend/config/source-mapping.json` (SKU/id, title, price, qty, images,
category, description). Nothing else needs to change.

Storefront settings (all optional, sane defaults):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SELLING_PRICE_FACTOR` | `0.50` | selling = source price x factor |
| `PRICE_ROUNDING` | `integer` | `none` / `integer` / `nearest50` / `nearest100` |
| `EXPOSE_SOURCE_PRICE` | `false` | keep `false` so customers never see cost |
| `PRODUCT_CACHE_TTL_SECONDS` | `300` | how long upstream data stays fresh |
| `PRODUCT_REFRESH_INTERVAL_SECONDS` | `900` | background refresh cadence |
| `RATE_LIMIT_*` | see `.env.example` | global / orders / payment / login limits |
| `PAYMENT_PROVIDER` | `placeholder` | switch when a provider is wired up |

### Delivery fees

`backend/config/delivery.json` is the single source of truth:

```json
{ "id": "nairobi",         "label": "Nairobi",         "fee": 500  }
{ "id": "outside_nairobi", "label": "Outside Nairobi", "fee": 1000 }
```

Change the `fee` values (or add zones with `match_terms`) and restart - the
frontend reads them from `GET /api/delivery-zones`, so nothing is hard-coded in
the browser. The zone is re-resolved **server-side** at checkout.

---

## 5. API reference

Public:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | liveness + upstream cache state |
| GET | `/api/products` | list (`q`, `category`, `sort`, `page`, `per_page`) |
| GET | `/api/products/categories` | categories with counts |
| GET | `/api/products/:id` | product detail (no `source_price`) |
| GET | `/api/delivery-zones` | zones + fees from `delivery.json` |
| POST | `/api/orders/quote` | price a basket without creating an order |
| POST | `/api/orders` | create a guest order (server-priced) |
| GET | `/api/orders/:orderNumber?token=` | order lookup, requires the view token |
| POST | `/api/payment/create` | create a payment for the server-calculated amount |

Admin (session cookie + `X-CSRF-Token` on writes):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/admin/login` | scrypt-verified login, sets HttpOnly/SameSite=Strict cookie |
| GET | `/api/admin/me`, `/stats` | session info, dashboard counters |
| GET | `/api/admin/products` | staff view (includes `source_price`) |
| POST | `/api/admin/catalogue/sync` | force an upstream sync |
| GET | `/api/admin/orders`, `/orders/:no` | order management list/detail |
| PATCH | `/api/admin/orders/:no/status` | `pending,confirmed,paid,processing,shipped,delivered,cancelled` |
| PATCH | `/api/admin/orders/:no/payment-status` | `unpaid,paid,refunded,failed` |
| GET | `/api/admin/audit` | admin audit log |

---

## 6. Why price tampering does not work

* The browser cart stores `{product_id, quantity}` only.
* `POST /api/orders` ignores every price-like field. It re-reads the current
  `selling_price` from the database, re-resolves the delivery zone, and computes
  `subtotal`, `delivery_fee` and `total` itself.
* `POST /api/payment/create` takes `{order_number, view_token}` and charges
  `orders.total` - a client-supplied `amount` is discarded. The service even
  refuses to record a provider result whose amount differs from the stored total.
* Orders can only be read back with the 64-hex-character `view_token` returned
  at creation; a wrong or missing token returns **404**, so the endpoint cannot
  be used to enumerate orders.

Demonstrated in a real browser: tampering the `localStorage` cart price to
KES 1 and placing the order still produced the server total
(`NCS-260922-DB910`, 2 x KES 800 + KES 500 delivery = **KES 2,100**).

---

## 7. Security controls in place

* Server-side pricing, stock and delivery-fee validation (nothing trusted from the client).
* Input validation: quantity caps, distinct-item cap, Kenyan phone regex, field
  length/control-character cleaning, scalar-type checks, http(s)-only image URLs.
* Output escaping: HTML shipped from the API is escaped in the frontend (`esc()`).
* Secrets only in `backend/.env`; `EXPOSE_SOURCE_PRICE` defaults to false.
* Admin auth with scrypt password hashing, DB-backed sessions, HttpOnly +
  SameSite=Strict cookies (Secure in production), session expiry.
* CSRF: double-submit cookie (`ncs_admin_csrf`) bound to the session; all
  state-changing admin routes require `X-CSRF-Token`.
* Same-origin enforcement on state-changing requests (Origin/Referer check).
* Rate limiting: global, orders, payment and login limiters (login: 10 per 15 min).
* CORS: explicit allow-list only, no wildcard; JSON body cap of 64 KB.
* Helmet with a strict CSP (no inline scripts, `img-src` https + data only).
* Idempotency keys + a phone/items fingerprint window block duplicate orders.
* Stock is decremented on checkout and restored on cancellation.
* Errors never leak stack traces (see `docs/SECURITY_REPORT.md` for the one bug
  that was found and fixed).

---

## 8. Testing

```bash
cd /home/user/storefront
node tools/e2e_flow_test.mjs            # expects the backend on 127.0.0.1:8080
```

57 checks across 11 sections, including price-tampering resistance, delivery
math, order-token handling (wrong/empty/oversized token), duplicate-order
protection, input validation, payment amount tampering, admin auth + CSRF,
page serving, restocking, frontend module-import integrity and rate limiting.

The suite is safe to re-run, with two caveats:

* It consumes the login limiter (10 per 15 min). Running it more than a few
  times back to back will return `429` on admin login and fail 10 checks - that
  is the limiter working, not a regression. Restart the backend (in-memory
  limiter state) or raise `RATE_LIMIT_LOGIN_MAX` to re-run.
* `backend/.env` sets `RATE_LIMIT_ORDERS_MAX=60` so the suite's own order traffic
  fits; the production default in `.env.example` is `10`.

---

## 9. Known limitations / next steps

1. **Payment is a placeholder.** `paymentService.js` records a pending payment
   against the server total and exposes a signature-verifying webhook stub.
   Wire a real provider (for example M-Pesa Daraja) in the `providers` map - the
   amount must keep coming from `orders.total`.
2. **The bundled source is a mock** (`mock-source-api/`) with 30 products; point
   `SOURCE_DRIVER=http` at your authorized API and adjust the mapping file.
3. **SQLite** is fine for a single node; move to Postgres/MySQL before horizontal
   scaling (schema is portable).
4. **Delivery fees / zones** are flat-rate config; add per-weight or per-distance
   rules in `delivery.json` plus `orderService.resolveDeliveryZone()` if needed.
5. **No customer accounts** by design (guest checkout only).
6. **Production checklist**: set `NODE_ENV=production`, `ADMIN_PASSWORD_HASH`,
   `COOKIE_SECURE=true`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, real
   `SOURCE_API_*` credentials and a real `PAYMENT_PROVIDER`.

---

## 10. Screenshots

`docs/screenshots/` - home, product detail, checkout, order confirmation, admin
dashboard (captured from the running stack).

`docs/e2e-results.txt` - raw output of the last full suite run.
`docs/SECURITY_REPORT.md` - build report + security findings and evidence.
