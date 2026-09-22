/**
 * End-to-end flow + security checks for the Nairobi Computer Shop storefront.
 *
 * Usage:  node tools/e2e_flow_test.mjs [baseUrl]
 * Requires the backend (and, for the mock source, the mock API) to be running.
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8080';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
}

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers, setCookie: res.headers.getSetCookie?.() || [] };
}

const jsonPost = (path, body, headers = {}) => req(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const section = (t) => console.log(`\n=== ${t} ===`);

/* ---------------------------------------------------------------- */
section('1. Catalogue & pricing integrity');

const health = await req('/api/health');
check('health endpoint returns ok', health.status === 200 && health.json?.status === 'ok', JSON.stringify(health.json));

const list = await req('/api/products?per_page=100');
const products = list.json?.data || [];
check('catalogue returns products', products.length > 0, `count=${products.length}`);
check('public product payload hides source_price',
  products.every((p) => !('source_price' in p) && !('cost_price' in p)),
  JSON.stringify(Object.keys(products[0] || {})));

// Compare against the protected upstream via the admin API later; here we just
// assert the public price is exactly 50% of the source price we fetch directly.
const SOURCE_BASE = process.env.SOURCE_API_BASE_URL || 'http://127.0.0.1:9099';
let upstream = null;
try {
  const up = await fetch(`${SOURCE_BASE}/products?per_page=100`, {
    headers: { Authorization: `Bearer ${process.env.MOCK_SOURCE_API_KEY || 'mock-source-key-123'}` }
  });
  const j = await up.json();
  upstream = j.data || j.items || j.products || (Array.isArray(j) ? j : null);
} catch (err) { console.log('  (upstream not reachable, skipping 50% cross-check)'); }

if (upstream?.length) {
  let allMatch = true;
  const samples = [];
  for (const p of products) {
    const s = upstream.find((u) => String(u.id ?? u.sku ?? u.product_id) === String(p.id));
    if (!s) { allMatch = false; samples.push(`missing upstream ${p.id}`); continue; }
    const src = Number(String(s.price ?? s.unit_price ?? s.cost ?? '').replace(/[^0-9.]/g, ''));
    const expected = Math.round(src * 0.5);
    if (p.selling_price !== expected) { allMatch = false; samples.push(`${p.id}: got ${p.selling_price}, expected ${expected} (source ${src})`); }
    else samples.push(`${p.id}: ${src} -> ${p.selling_price}`);
  }
  check('every selling price is exactly 50% of the source price', allMatch, samples.slice(0, 3).join(' | '));
  console.log(`  sample: ${samples.slice(0, 3).join(' | ')}`);
}

/* ---------------------------------------------------------------- */
section('2. Delivery fee calculation');

const cheap = products.slice().sort((a, b) => a.selling_price - b.selling_price)[0];
const outOfStock = products.find((p) => p.stock === 0);

const qNai = await jsonPost('/api/orders/quote', { items: [{ product_id: cheap.id, quantity: 1 }], delivery_location: 'Nairobi' });
check('Nairobi quote = products + KES 500 delivery',
  qNai.status === 200 && qNai.json?.data?.delivery_fee === 500 &&
  qNai.json.data.total === qNai.json.data.subtotal + 500,
  JSON.stringify(qNai.json?.data));

const qOut = await jsonPost('/api/orders/quote', { items: [{ product_id: cheap.id, quantity: 1 }], delivery_location: 'Outside Nairobi' });
check('Outside-Nairobi quote = products + KES 1000 delivery',
  qOut.status === 200 && qOut.json?.data?.delivery_fee === 1000,
  JSON.stringify(qOut.json?.data));
check('"Outside Nairobi" is NOT mis-priced as the cheaper Nairobi zone',
  qOut.json?.data?.delivery_zone?.id === 'outside_nairobi',
  JSON.stringify(qOut.json?.data?.delivery_zone));

/* ---------------------------------------------------------------- */
section('3. Guest checkout - server-authoritative pricing');

const idem = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const orderBody = {
  customer: {
    name: 'E2E Test Customer', phone: '0712345678', email: 'e2e@example.test',
    county: 'Nairobi', town: 'Nairobi', address: 'Test Street 1', delivery_instructions: 'Ring the bell'
  },
  items: [{ product_id: cheap.id, quantity: 2 }],
  delivery_location: 'Nairobi',
  idempotency_key: idem
};

// Price tampering: the client tries to dictate a 1-shilling unit price and a
// 1-shilling total. Both MUST be ignored.
const tampered = JSON.parse(JSON.stringify(orderBody));
tampered.idempotency_key = `${idem}-tamper`;
tampered.items[0].unit_price = 1;
tampered.items[0].price = 1;
tampered.items[0].line_total = 1;
tampered.subtotal = 1;
tampered.total = 1;
tampered.delivery_fee = 0;
tampered.payment_status = 'paid';
tampered.order_status = 'delivered';

const created = await jsonPost('/api/orders', tampered);
// Never assume success: fall back to an empty object so a failed order is
// reported as a failed check instead of crashing the whole suite.
const order = created.json?.data || {};
check('order created (HTTP 201)', created.status === 201, `status=${created.status} ${created.text.slice(0, 200)}`);
check('client-supplied prices ignored',
  order.items?.[0]?.unit_price === cheap.selling_price &&
  order.subtotal === cheap.selling_price * 2 &&
  order.total === cheap.selling_price * 2 + 500,
  JSON.stringify({ unit: order.items?.[0]?.unit_price, sub: order.subtotal, fee: order.delivery_fee, total: order.total, expected: cheap.selling_price }));
check('client-supplied statuses ignored (still unpaid/pending)',
  order?.payment_status === 'unpaid' && order?.order_status === 'pending',
  `${order?.payment_status}/${order?.order_status}`);
check('order carries a high-entropy view token', typeof order?.view_token === 'string' && order.view_token.length >= 24);

const orderRef = order.order_number || 'NCS-000000-00000';
const fetched = await req(`/api/orders/${encodeURIComponent(orderRef)}?token=${encodeURIComponent(order.view_token || '')}`);
check('customer can read own order with token', fetched.status === 200 && fetched.json?.data?.order_number === order.order_number);

const noToken = await req(`/api/orders/${encodeURIComponent(orderRef)}`);
check('order lookup without token is rejected', noToken.status === 400 || noToken.status === 404, `status=${noToken.status}`);

const badToken = await req(`/api/orders/${encodeURIComponent(order.order_number)}?token=${'a'.repeat(32)}`);
check('order lookup with a wrong token returns 404 (no enumeration oracle)', badToken.status === 404, `status=${badToken.status}`);

// Regression: the token comparison must never leak a 500 (length-dependent
// RangeError from crypto.timingSafeEqual) for short/oversized token input.
const shortToken = await req(`/api/orders/${encodeURIComponent(order.order_number)}?token=x`);
check('short token returns 404 (constant-time compare, no 500)', shortToken.status === 404, `status=${shortToken.status}`);
const longToken = await req(`/api/orders/${encodeURIComponent(order.order_number)}?token=${'a'.repeat(400)}`);
check('oversized token returns 404 (constant-time compare, no 500)', longToken.status === 404, `status=${longToken.status}`);
check('404 body does not leak order data', !JSON.stringify(badToken.json || {}).includes(order.customer.phone));

/* ---------------------------------------------------------------- */
section('4. Duplicate-order protection');

const replay = await jsonPost('/api/orders', tampered);
check('replaying the same idempotency key returns the SAME order',
  replay.status === 200 && replay.json?.data?.order_number === order.order_number,
  `status=${replay.status} number=${replay.json?.data?.order_number} original=${order.order_number}`);

const dupeNoKey = JSON.parse(JSON.stringify(orderBody));
delete dupeNoKey.idempotency_key;
const dupe = await jsonPost('/api/orders', dupeNoKey);
check('fingerprint window blocks an accidental double-submit',
  dupe.status === 409 && dupe.json?.error?.code === 'DUPLICATE_ORDER',
  `status=${dupe.status} ${dupe.text.slice(0, 160)}`);

/* ---------------------------------------------------------------- */
section('5. Input validation');

const tooMany = await jsonPost('/api/orders/quote', { items: [{ product_id: cheap.id, quantity: 9999 }], delivery_location: 'Nairobi' });
check('quantity above the per-item cap is rejected', tooMany.status === 400, `status=${tooMany.status} ${tooMany.text.slice(0, 140)}`);

const zero = await jsonPost('/api/orders/quote', { items: [{ product_id: cheap.id, quantity: 0 }], delivery_location: 'Nairobi' });
check('zero quantity is rejected', zero.status === 400, `status=${zero.status}`);

const negative = await jsonPost('/api/orders/quote', { items: [{ product_id: cheap.id, quantity: -5 }], delivery_location: 'Nairobi' });
check('negative quantity is rejected', negative.status === 400, `status=${negative.status}`);

const badProduct = await jsonPost('/api/orders/quote', { items: [{ product_id: '__does_not_exist__', quantity: 1 }], delivery_location: 'Nairobi' });
check('unknown product id is rejected', badProduct.status === 404, `status=${badProduct.status}`);

if (outOfStock) {
  const oos = await jsonPost('/api/orders/quote', { items: [{ product_id: outOfStock.id, quantity: 1 }], delivery_location: 'Nairobi' });
  check(`out-of-stock product (${outOfStock.id}) cannot be ordered`,
    oos.status === 409 && oos.json?.error?.code === 'OUT_OF_STOCK',
    `status=${oos.status} ${oos.text.slice(0, 140)}`);
} else {
  console.log('  (no zero-stock product in the catalogue - skipping)');
}

const badPhone = JSON.parse(JSON.stringify(orderBody));
badPhone.idempotency_key = `${idem}-phone`;
badPhone.customer.phone = 'not-a-phone';
const phoneRes = await jsonPost('/api/orders', badPhone);
check('invalid Kenyan phone number is rejected', phoneRes.status === 400, `status=${phoneRes.status} ${phoneRes.text.slice(0, 140)}`);

/* ---------------------------------------------------------------- */
section('6. Payment (placeholder provider)');

const pay = await jsonPost('/api/payment/create', { order_number: order.order_number, view_token: order.view_token });
check('payment reference created', [200, 201].includes(pay.status) && typeof pay.json?.data?.reference === 'string', JSON.stringify(pay.json?.data));
check('payment amount is server-derived, not client-supplied', pay.json?.data?.amount === order.total, `amount=${pay.json?.data?.amount} expected=${order.total}`);

const payNoToken = await jsonPost('/api/payment/create', { order_number: order.order_number, view_token: 'x'.repeat(32) });
check('payment creation requires the order token', payNoToken.status === 404 || payNoToken.status === 403, `status=${payNoToken.status}`);

const payTampered = await jsonPost('/api/payment/create', { order_number: order.order_number, view_token: order.view_token, amount: 1 });
check('client-supplied payment amount is ignored', payTampered.json?.data?.amount === order.total, `got=${payTampered.json?.data?.amount}`);

/* ---------------------------------------------------------------- */
section('7. Admin area - authentication & CSRF');

const anonOrders = await req('/api/admin/orders');
check('admin orders require authentication', anonOrders.status === 401, `status=${anonOrders.status}`);

const anonStats = await req('/api/admin/stats');
check('admin stats require authentication', anonStats.status === 401, `status=${anonStats.status}`);

const anonSync = await jsonPost('/api/admin/catalogue/sync', {});
check('admin sync requires authentication', anonSync.status === 401, `status=${anonSync.status}`);

const badLogin = await jsonPost('/api/admin/login', { username: 'admin', password: 'wrong-password' });
check('wrong admin password is rejected', badLogin.status === 401, `status=${badLogin.status}`);

const USERNAME = process.env.ADMIN_USERNAME || 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const login = await jsonPost('/api/admin/login', { username: USERNAME, password: PASSWORD });
const cookies = login.setCookie.map((c) => c.split(';')[0]).join('; ');
const csrf = login.json?.data?.csrf_token;
check('valid admin login succeeds', login.status === 200 && !!csrf, `status=${login.status}`);
check('session cookie is HttpOnly', login.setCookie.some((c) => /ncs_admin_session=/.test(c) && /HttpOnly/i.test(c)));
check('session cookie is SameSite=Strict', login.setCookie.some((c) => /ncs_admin_session=/.test(c) && /SameSite=Strict/i.test(c)));

const authed = await req('/api/admin/orders', { headers: { Cookie: cookies } });
check('authenticated admin can list orders', authed.status === 200 && Array.isArray(authed.json?.data), `status=${authed.status}`);
check('order list exposes source price to staff only (expected)',
  (await req('/api/admin/products', { headers: { Cookie: cookies } })).json?.data?.[0]?.source_price !== undefined);

const noCsrf = await req(`/api/admin/orders/${encodeURIComponent(order.order_number)}/status`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: cookies },
  body: JSON.stringify({ order_status: 'delivered' })
});
check('state-changing admin call without CSRF token is rejected (403)', noCsrf.status === 403, `status=${noCsrf.status} ${noCsrf.text.slice(0, 140)}`);

const wrongCsrf = await req(`/api/admin/orders/${encodeURIComponent(order.order_number)}/status`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: cookies, 'X-CSRF-Token': 'deadbeef' },
  body: JSON.stringify({ order_status: 'delivered' })
});
check('state-changing admin call with a wrong CSRF token is rejected (403)', wrongCsrf.status === 403, `status=${wrongCsrf.status}`);

const okCsrf = await req(`/api/admin/orders/${encodeURIComponent(order.order_number)}/status`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: cookies, 'X-CSRF-Token': csrf },
  body: JSON.stringify({ order_status: 'confirmed' })
});
check('admin can update order status with a valid CSRF token', okCsrf.status === 200 && okCsrf.json?.data?.order_status === 'confirmed', `status=${okCsrf.status}`);

const invalidStatus = await req(`/api/admin/orders/${encodeURIComponent(order.order_number)}/status`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: cookies, 'X-CSRF-Token': csrf },
  body: JSON.stringify({ order_status: 'not-a-status' })
});
check('unknown order status is rejected', invalidStatus.status === 400, `status=${invalidStatus.status}`);

/* ---------------------------------------------------------------- */
section('8. Front-end pages served');

for (const p of ['/', '/index.html', '/products.html', '/product.html?id=' + encodeURIComponent(cheap.id), '/cart.html', '/checkout.html', '/order-success.html', '/admin', '/admin.html', '/nonexistent-page-xyz']) {
  const r = await req(p);
  const html = (r.headers.get('content-type') || '').includes('html');
  const expected = p === '/nonexistent-page-xyz' ? r.status === 404 : (r.status === 200 && html);
  check(`GET ${p} -> ${r.status}`, expected, `content-type=${r.headers.get('content-type')}`);
}

/* ---------------------------------------------------------------- */
section('9. Order cancellation restocks inventory');

const before = (await req(`/api/products/${encodeURIComponent(cheap.id)}`)).json?.data?.stock;
const cancelOrder = await jsonPost('/api/orders', {
  customer: { name: 'Restock Tester', phone: `07${String(Date.now()).slice(-8)}`, county: 'Nairobi', town: 'Nairobi', address: 'Restock Rd 5' },
  items: [{ product_id: cheap.id, quantity: 3 }],
  delivery_location: 'Nairobi',
  idempotency_key: `restock-${Date.now()}`
});
const cancelNo = cancelOrder.json?.data?.order_number;
const during = (await req(`/api/products/${encodeURIComponent(cheap.id)}`)).json?.data?.stock;
const cancelRes = await req(`/api/admin/orders/${encodeURIComponent(cancelNo)}/status`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', Cookie: cookies, 'X-CSRF-Token': csrf },
  body: JSON.stringify({ order_status: 'cancelled' })
});
const after = (await req(`/api/products/${encodeURIComponent(cheap.id)}`)).json?.data?.stock;
check(`checkout decrements stock (${before} -> ${during})`, during === before - 3, `${before} -> ${during}`);
check(`cancelling restocks (${during} -> ${after})`, cancelRes.status === 200 && after === before, `${during} -> ${after}`);

/* ---------------------------------------------------------------- */
section('10. Frontend module import integrity');

// A named import that the target module does not export is a module-
// instantiation error: the importing script never runs at all, which shows up
// as a silently blank page rather than a visible error. Assert statically.
const fsMod = await import('node:fs');
const pathMod = await import('node:path');
const jsDir = pathMod.join(process.cwd(), 'frontend', 'js');
const jsFiles = fsMod.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const importProblems = [];
const importRe = new RegExp("import[ ]*[{]([^}]+)[}][ ]*from[ ]*'[.][/]([A-Za-z0-9_.-]+[.]js)'", 'g');
for (const file of jsFiles) {
  const src = fsMod.readFileSync(pathMod.join(jsDir, file), 'utf8');
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const targetName = m[2];
    const targetPath = pathMod.join(jsDir, targetName);
    if (!fsMod.existsSync(targetPath)) { importProblems.push(file + ' -> missing module ' + targetName); continue; }
    const targetSrc = fsMod.readFileSync(targetPath, 'utf8');
    for (const entry of m[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      const declared = new RegExp('export[ ]+(async[ ]+)?(function|const|let|var|class)[ ]+' + name + '\\b').test(targetSrc);
      const reExported = new RegExp('export[ ]*[{][^}]*' + name + '\\b').test(targetSrc);
      if (!declared && !reExported) importProblems.push(file + ' imports ' + name + ' but ' + targetName + ' does not export it');
    }
  }
}
check('every named import resolves to a real export (blank-page failure mode)',
  importProblems.length === 0, importProblems.join('; '));

/* ---------------------------------------------------------------- */
section('11. Rate limiting on the order endpoints');

// orderLimiter allows RATE_LIMIT_ORDERS_MAX per minute (default 10; the dev
// .env raises it so this suite can run back to back). Fire a burst one over the
// configured ceiling - quotes create nothing, so this leaves no residue - and
// require a 429 so a scripted checkout cannot hammer the pricing engine.
let ordersMax = 10;
try {
  const envTxt = (await import('node:fs')).readFileSync(
    (await import('node:path')).join(process.cwd(), 'backend', '.env'), 'utf8');
  const found = /^RATE_LIMIT_ORDERS_MAX=(\d+)/m.exec(envTxt);
  if (found) ordersMax = parseInt(found[1], 10);
} catch { /* fall back to the documented default */ }
const burst = [];
for (let i = 0; i < ordersMax + 4; i++) {
  burst.push((await jsonPost('/api/orders/quote', {
    items: [{ product_id: cheap.id, quantity: 1 }],
    delivery_location: 'Nairobi'
  })).status);
}
check(`burst of ${burst.length} quote requests (limit ${ordersMax}/min) eventually returns HTTP 429`,
  burst.includes(429), `statuses=${burst.join(',')}`);
const limitedBody = await jsonPost('/api/orders/quote', {
  items: [{ product_id: cheap.id, quantity: 1 }],
  delivery_location: 'Nairobi'
});
check('rate-limited response is a clean JSON error (no stack trace)',
  limitedBody.status === 429 && !!limitedBody.json?.error?.code && !/at\s+\w+\s*\(/.test(limitedBody.text),
  `status=${limitedBody.status} body=${limitedBody.text.slice(0, 120)}`);

/* ---------------------------------------------------------------- */
console.log(`\n================ ${pass} passed, ${fail} failed ================`);
if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(` - ${f}`)); process.exit(1); }
