# Nairobi Computer Shop storefront - Build & Security Report

Date: 2026-09-22
System: storefront for https://nairobicomputershop.co.ke (frontend + backend + mock source API)
Runtime: Node.js v24.18.0, Express, SQLite, static ES-module frontend
Suite status at time of writing: **57 passed / 0 failed** (`docs/e2e-results.txt`)

---

## 1. Summary

The storefront was built to the full requirement list (see README section 2) and
then tested as a running system: live API checks, a real Chromium walkthrough of
the purchase and admin flows, and a 57-check automated suite.

Two real defects were found and fixed during testing:

| ID | Severity | Area | Status |
| --- | --- | --- | --- |
| F-01 | Medium | Order lookup: length-dependent crash in the token comparison (500 + token-length oracle) | Fixed, regression-tested |
| F-02 | High (availability of admin) | `admin.js` imported two symbols that `api.js` does not export -> admin dashboard rendered blank | Fixed, regression-tested |
| F-03 | Low | Quantity stepper concatenated strings (1 + 1 = 11) | Fixed, browser-verified |
| F-04 | Info (operational) | Static JS/CSS cached for 1 hour, causing stale-code debugging | Fixed (HTML no-cache, assets 300s + revalidate) |
| F-05 | Info (test harness) | Suite crashed instead of reporting when order creation failed; rate-limit assertion assumed the production limit | Fixed |

No authentication bypass, no price-tampering path, and no credential exposure
was found in the delivered code.

---

## 2. Scope and assets

In scope (built and tested here):

* `backend/` - Express API, sync/pricing services, order + payment + admin logic.
* `frontend/` - all pages and ES modules.
* `mock-source-api/` - stand-in for the authorized upstream product API.
* `tools/e2e_flow_test.mjs` - the test harness itself.

Out of scope / not tested: the public production site
`nairobicomputershop.co.ke` itself, its servers, and any real third-party API,
payment provider or hosting infrastructure. No production systems were touched.

---

## 3. Method

1. **Static review** of every hand-written backend file and frontend module after
   implementation: secret handling, comparators, validation, authorization,
   output escaping, cache headers.
2. **Live end-to-end testing** against the running stack (backend on
   `127.0.0.1:8080`, mock source on `127.0.0.1:9099`): 57 automated checks.
3. **Browser verification** (headless Chromium) of the flows that automated
   checks cannot see: JavaScript module loading, cart persistence, checkout
   rendering of server totals, admin login and a CSRF-protected status change.
4. **Negative controls** - intentionally re-introducing a defect to prove the new
   check actually detects it (see section 6).
5. **Evidence preserved** - raw suite output (`docs/e2e-results.txt`), the
   pre-fix crash trace (`docs/evidence/`), screenshots (`docs/screenshots/`),
   and the order numbers created during testing.

Claims in this report distinguish what was **observed** (HTTP status codes,
browser DOM text, log traces) from what was **inferred** (for example the exact
pre-fix code line, which is established from the preserved stack trace rather
than from re-running the vulnerable build).

---

## 4. Findings

### F-01 - Medium - Length-dependent crash in the order view-token comparison (fixed)

**Where:** `backend/services/orderService.js`, `assertOrderAccess()`
**Type:** improper error handling / observable-behaviour differential (CWE-203,
CWE-248)

**Observed before the fix** (preserved trace,
`docs/evidence/f-01-timing-safe-equal-trace.txt`):

```
[2026-09-22T15:03:16.176Z] GET /api/orders/NCS-260922-DB910?token=WRONG -> 500 INTERNAL_ERROR: Input buffers must have the same byte length
RangeError: Input buffers must have the same byte length
    at assertOrderAccess (/home/user/storefront/backend/services/orderService.js:298:25)
```

The comparison called `crypto.timingSafeEqual(Buffer.from(token), Buffer.from(order.view_token))`
directly. `timingSafeEqual` throws `RangeError` when the two buffers differ in
byte length, so any token whose length differs from the stored 64-hex-character
token produced an unhandled exception instead of the intended 404.

**Impact demonstrated:**

* A malformed or truncated token crashed the request path (HTTP 500) rather than
  returning a uniform "not found", and flooded the error log with stack traces.
* A status-code differential existed between "wrong token, same length" (404)
  and "wrong token, different length" (500). That is a **token-length oracle**:
  an attacker could walk token lengths until the response changes, learning the
  exact length of the view token. It does not reveal the token value itself, and
  the endpoint still refuses access, which is why this is rated Medium rather
  than High.

**Fix:** tokens are compared as fixed-width SHA-256 digests, so the comparison is
constant-time and length-agnostic:

```js
function safeTokenEquals(a, b) {
  const da  = crypto.createHash('sha256').update(String(a)).digest();
  const dbb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, dbb);
}
```

**Verified after the fix:** `token=WRONG` -> 404, empty token -> 400, `token=x`
(authorization-shape token) -> 404, very long token -> 404, valid token -> 200,
unknown order -> 404. The suite now asserts the short-token and oversized-token
cases permanently ("short token returns 404 (constant-time compare, no 500)",
"oversized token returns 404 ...").

**Other comparators reviewed:** `paymentService.js` (webhook HMAC) and
`adminService.js` (scrypt password verification) both guard length before
calling `timingSafeEqual`, so they were not affected.

### F-02 - High (functional availability) - Admin dashboard never rendered (fixed)

**Where:** `frontend/js/admin.js` (line 1-2)
**Type:** broken module import (browser ES-module instantiation error)

**Observed:** `/admin` loaded, the login view appeared, but after a successful
sign-in the dashboard stayed blank - both views hidden and **zero calls to
`/api/admin/*`** were made. The page produced no visible error.

**Cause:** `admin.js` imported `alertHtml` and `toast` from `./api.js`, which
does not export them (they live in `./layout.js`). A named import that the target
module does not export is a module *instantiation* error: the whole script fails
before executing a single statement, so nothing renders and nothing is fetched.

**Fix:**

```js
import { esc, formatKES, debounce } from './api.js';
import { alertHtml, toast } from './layout.js';
```

**Verified after the fix in a real browser:** login view renders; after sign-in,
"Signed in as admin" with stats (orders 7, pending 2, active products 30, units
in stock 734), 7 order rows, 25 product rows, 9 audit rows, and a status change
performed through the UI produced the toast "NCS-260922-61EEA -> confirmed".
See `docs/screenshots/08-admin-dashboard.png`.

**Why it is rated High:** the entire administrative function was unavailable, and
the failure was silent (no error surfaced to the operator or to a normal health
check). It is not an authorization weakness - the API correctly returned 401 to
unauthenticated callers throughout.

### F-03 - Low - Quantity stepper concatenated strings (fixed)

**Where:** `frontend/js/product.js`
**Observed:** clicking "+" once jumped the quantity from 1 to the maximum (20),
because `input.value` (a string) was added to a number: `"1" + 1 === "11"`.
**Fix:** `input.value = clamp(Number(input.value) + 1, 1, maxQuantity)`.
**Verified in the browser:** 1 -> 2 -> 3 on increment, back to 2 on decrement.
No server-side impact: the API rejects quantities above `MAX_QUANTITY_PER_ITEM`.

### F-04 - Info - Over-eager static asset caching (fixed)

**Where:** `backend/server.js` `setHeaders`
**Observed:** every static asset, including `js/*.js`, was served with
`Cache-Control: public, max-age=3600`. During testing this served stale
`product.js` / `admin.js` after edits and buried the real bug (F-02) behind
cached broken code.
**Fix:** HTML responses are `no-cache`; other assets are
`public, max-age=300, must-revalidate`. This is a debuggability/operational
improvement, not a vulnerability.

### F-05 - Info - Test-harness robustness (fixed)

* The suite assumed order creation always succeeded and crashed
  (`TypeError: Cannot read properties of undefined`) instead of reporting a
  failed check. It now falls back to an empty object and reports failures
  cleanly, so a real regression is reported rather than hidden behind a crash.
* The rate-limit check originally sent a fixed 14 requests, but the development
  `.env` raises `RATE_LIMIT_ORDERS_MAX` to 60 so the suite's own traffic fits -
  the check therefore never tripped and reported a false failure. It now reads
  the configured ceiling and bursts one over it.

---

## 5. Verified security properties

All checks below ran against the live stack; the raw output is
`docs/e2e-results.txt` (57 passed / 0 failed).

| # | Property | How it was verified | Result |
| --- | --- | --- | --- |
| 1 | Selling price is exactly 50% of the source price | Every public product compared against the upstream API's own price | Pass |
| 2 | `source_price` / cost never reaches the browser | Public payload key inspection (staff view keeps it deliberately) | Pass |
| 3 | Client-supplied prices, totals, fees and statuses are ignored | Order submitted with `unit_price=1, total=1, payment_status=paid, order_status=delivered`; server returned its own numbers, still `unpaid/pending` | Pass |
| 4 | Delivery fee is server-side and zone-correct | Nairobi = subtotal + 500, outside Nairobi = subtotal + 1000, "Outside Nairobi" not mis-priced as Nairobi | Pass |
| 5 | Payment amount cannot be chosen by the client | `POST /api/payment/create` ignores `amount`; charges `orders.total` | Pass |
| 6 | Order lookup needs the view token | Missing / wrong / short / oversized token all -> 404, valid -> 200, no data leaked in the 404 body | Pass |
| 7 | Duplicate-order protection | Same idempotency key returns the same order; phone+items fingerprint window blocks double submits | Pass |
| 8 | Input validation | Over-max, zero and negative quantity, unknown product, out-of-stock product, invalid Kenyan phone all rejected (400/404) | Pass |
| 9 | Admin authentication | Anonymous `/api/admin/orders`, `/stats`, `/catalogue/sync` -> 401; wrong password -> 401 | Pass |
| 10 | Session cookie hardening | `ncs_admin_session` is `HttpOnly` and `SameSite=Strict` | Pass |
| 11 | CSRF protection | Status change without `X-CSRF-Token` -> 403; with a wrong token -> 403; with the session-bound token -> 200 | Pass |
| 12 | Rate limiting | 64-request burst on `/api/orders/quote` (limit 60/min) returned 429; the 429 body is a clean JSON error, no stack trace | Pass |
| 13 | Stock integrity | Checkout decrements stock, cancellation restocks it | Pass |
| 14 | No stack traces or secrets in error responses | Error bodies inspected (rate-limit path, validation path, 404 path) | Pass |
| 15 | Frontend modules load (no blank-page failure mode) | All named imports resolved against real exports | Pass |

Browser-level corroboration: tampering the `localStorage` cart snapshot to
KES 1 per unit did not change the server quote (subtotal stayed KES 1,600) and
order `NCS-260922-DB910` was created with the server total **KES 2,100**
(2 x HP Wireless Mouse 200 @ 800 + 500 Nairobi delivery). Changing the delivery
zone to outside Nairobi produced 1,000 / total 2,600.

---

## 6. Evidence quality and negative controls

Passing checks only mean something if they can fail. Two controls were run:

1. **Module-import check (new, section 10).** `toast` was deliberately renamed in
   `layout.js` (export removed, callers untouched). The check failed with the
   exact affected files:
   `admin.js imports toast but layout.js does not export it; cart-page.js ... ;
   checkout.js ...; index.js ...; order-success.js ...; product.js ...`
   (54 passed / 1 failed). The rename was then reverted and the suite returned to
   57/57. This confirms the check detects the F-02 failure mode, which is exactly
   the kind of defect that produced a silent blank page.
2. **Rate-limit check.** It was first written against the production default and
   correctly reported a failure, which is what exposed the configuration
   mismatch (F-05); after reading the configured limit it passes by actually
   receiving a 429.

Honest limitations of this testing:

* The suite runs single-threaded with small sample sizes (it asserts invariants,
  not statistical properties), so it cannot detect timing side channels. F-01 was
  found by static reading plus an error trace, not by timing measurement.
* The suite passes only because the backend is running with the development
  `.env`; results are configuration-dependent (documented in the README).
* No third-party infrastructure, TLS termination, or production payment
  provider was assessed.
* The upstream here is the bundled mock. The HTTP driver
  (`SOURCE_DRIVER=http`) is implemented and configurable but has only been
  exercised against the mock, so treat a real upstream integration as still
  needing a validation pass with the real credentials and payload mapping.

---

## 7. Residual risks and hardening backlog

| Risk | Notes / recommendation |
| --- | --- |
| Payment is a placeholder | Wire a real provider, keep the amount sourced from `orders.total`, and enforce webhook signature verification (`PAYMENT_WEBHOOK_SECRET` is required before the webhook will process anything). |
| Development admin password | `ADMIN_PASSWORD=change-me-now` must be replaced by `ADMIN_PASSWORD_HASH` in production; the config already refuses to boot with a plain password when `NODE_ENV=production`. |
| Cookies over plain HTTP in dev | Set `COOKIE_SECURE=true` and terminate TLS in front of the app in production. |
| Rate limiting is in-memory | Per-process counts do not survive a restart and are not shared between instances; move to a shared store (Redis) when scaling horizontally. |
| SQLite single writer | Fine for one node; migrate before horizontal scaling (schema is portable). |
| In-process catalogue cache | Sync failures leave the previous catalogue in place (intended), so the storefront keeps serving slightly stale prices when the upstream is down; `updated_at` is exposed in the API for monitoring. |
| No WAF / bot protection | Consider a CDN/WAF in front of `/api/orders` and `/api/admin/login`. |
| Log noise | Errors are logged with method, path and status; make sure logs remain server-side only. |

---

## 8. What the operator still needs to provide

1. Source API details: base URL, products path, auth method/credentials,
   pagination style, and the JSON path holding the product array.
2. Field mapping confirmation (`backend/config/source-mapping.json`) for SKU/title/
   price/stock/images/category.
3. Delivery fees/zones for real (`backend/config/delivery.json`).
4. Payment provider credentials and webhook secret (server-side only).
5. Production admin password hash and a hostname for `PUBLIC_BASE_URL` /
   `CORS_ORIGINS`.

---

## 9. Evidence index

| Artifact | Contents |
| --- | --- |
| `docs/e2e-results.txt` | Raw output of the last full 57-check run |
| `docs/evidence/f-01-timing-safe-equal-trace.txt` | Pre-fix backend log showing the `RangeError` and the 500 response |
| `docs/screenshots/01-home.png` | Storefront home with product images and delivery zones |
| `docs/screenshots/02-product-detail.png` | Product detail page |
| `docs/screenshots/03-checkout.png` | Guest checkout form |
| `docs/screenshots/04-order-success.png` | Order confirmation showing server-derived grand total KES 2,100 |
| `docs/screenshots/08-admin-dashboard.png` | Admin dashboard after sign-in (stats, orders, products, audit) |
| Order evidence | `NCS-260922-DB910` (server-priced total 2,100 despite tampering), `NCS-260922-61EEA` (status changed to `confirmed` through the UI with a CSRF token) |
