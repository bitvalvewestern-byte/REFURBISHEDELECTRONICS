import { esc, formatKES, debounce } from './api.js';
import { alertHtml, toast } from './layout.js';

/* Admin uses its own fetch wrapper because it must attach the CSRF token
 * (readable cookie) to every state-changing request. */
function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)ncs_admin_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function adminFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = csrfToken();

  const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const text = await res.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = null; } }
  if (!res.ok) {
    const err = new Error(payload?.error?.message
      || (payload ? `Request failed (${res.status}).`
                  : `The storefront service is unavailable (HTTP ${res.status}).`));
    err.code = payload?.error?.code || 'REQUEST_FAILED';
    err.status = res.status;
    throw err;
  }
  return payload;
}

/* ------------------------------- views ----------------------------- */
const loginView = document.getElementById('login-view');
const dashView = document.getElementById('dash-view');
const loginForm = document.getElementById('login-form');
const loginAlert = document.getElementById('login-alert');
const dashAlert = document.getElementById('dash-alert');
const who = document.getElementById('who');
const logoutBtn = document.getElementById('logout-btn');

let orderState = { page: 1, filters: {} };
let productState = { page: 1, q: '' };

function showLogin(message) {
  loginView.hidden = false;
  dashView.hidden = true;
  logoutBtn.hidden = true;
  who.textContent = '';
  if (message) loginAlert.innerHTML = alertHtml(message, 'error');
}

function showDash(username) {
  loginView.hidden = true;
  dashView.hidden = false;
  logoutBtn.hidden = false;
  who.textContent = `Signed in as ${username}`;
}

/* ------------------------------- login ----------------------------- */
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginAlert.innerHTML = '';
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await adminFetch('/api/admin/login', {
      method: 'POST',
      body: {
        username: loginForm.elements.username.value.trim(),
        password: loginForm.elements.password.value
      }
    });
    loginForm.reset();
    showDash(res.data.username);
    await refreshAll();
  } catch (err) {
    loginAlert.innerHTML = alertHtml(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

logoutBtn.addEventListener('click', async () => {
  try { await adminFetch('/api/admin/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.reload();
});

/* ------------------------------- stats ----------------------------- */
async function loadStats() {
  const host = document.getElementById('stats');
  try {
    const { data } = await adminFetch('/api/admin/stats');
    const card = (label, value) => `
      <div class="stat-card"><span class="stat-label">${esc(label)}</span><strong class="stat-value">${esc(value)}</strong></div>`;
    host.innerHTML = [
      card('Orders', data.orders),
      card('Pending', data.pending),
      card('Delivered', data.delivered),
      card('Paid orders', data.paid_orders),
      card('Revenue (paid)', formatKES(data.revenue)),
      card('Active products', data.active_products),
      card('Units in stock', data.units_in_stock)
    ].join('');
    const s = data.catalogue_sync || {};
    document.getElementById('sync-state').textContent =
      `Last sync: ${s.last_sync_at ? new Date(s.last_sync_at).toLocaleString('en-KE') : 'never'} · ` +
      `status: ${s.last_status || 'unknown'} · items: ${s.items ?? '—'}`;
  } catch (err) {
    if (err.status === 401) return showLogin('Your session expired. Please sign in again.');
    host.innerHTML = alertHtml(err.message, 'error');
  }
}

document.getElementById('sync-btn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Syncing…';
  try {
    const { data } = await adminFetch('/api/admin/catalogue/sync', { method: 'POST' });
    toast(`Sync complete: ${data.created || 0} new, ${data.updated || 0} updated, ${data.deactivated || 0} deactivated.`, 'success');
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Sync now';
  }
});

/* ------------------------------ orders ----------------------------- */
const ORDER_STATUSES = ['pending', 'confirmed', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'];
const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'failed', 'refunded'];

async function loadOrders() {
  const host = document.getElementById('orders-host');
  const qs = new URLSearchParams({ page: orderState.page, per_page: 25, ...orderState.filters });
  try {
    const res = await adminFetch(`/api/admin/orders?${qs}`);
    if (!res.data.length) { host.innerHTML = '<p class="muted">No orders yet.</p>'; }
    else {
      host.innerHTML = `
        <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Order</th><th>Customer</th><th>Location</th><th>Items</th>
            <th>Total</th><th>Payment</th><th>Status</th><th>Placed</th>
          </tr></thead>
          <tbody>
          ${res.data.map((o) => `
            <tr>
              <td><button class="link-btn" data-detail="${esc(o.order_number)}">${esc(o.order_number)}</button></td>
              <td>${esc(o.customer_name)}<br><span class="muted">${esc(o.customer_phone)}</span></td>
              <td>${esc(o.town || '')}<br><span class="muted">${esc(o.county || '')}</span></td>
              <td>${o.item_count}</td>
              <td>${formatKES(o.total)}<br><span class="muted">+ ${formatKES(o.delivery_fee)} delivery</span></td>
              <td>
                <select class="mini-select" data-payment="${esc(o.order_number)}">
                  ${PAYMENT_STATUSES.map((s) => `<option ${s === o.payment_status ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
              </td>
              <td>
                <select class="mini-select" data-status="${esc(o.order_number)}">
                  ${ORDER_STATUSES.map((s) => `<option ${s === o.order_status ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
              </td>
              <td>${esc(new Date(o.created_at).toLocaleString('en-KE'))}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
        <div id="order-detail"></div>`;
    }
    document.getElementById('orders-pager').innerHTML =
      `<button class="btn btn-secondary btn-sm" id="op-prev" ${orderState.page <= 1 ? 'disabled' : ''}>Previous</button>
       <span class="muted">Page ${orderState.page}</span>
       <button class="btn btn-secondary btn-sm" id="op-next" ${res.data.length < 25 ? 'disabled' : ''}>Next</button>`;
    document.getElementById('op-prev')?.addEventListener('click', () => { orderState.page--; loadOrders(); });
    document.getElementById('op-next')?.addEventListener('click', () => { orderState.page++; loadOrders(); });

    host.querySelectorAll('[data-status]').forEach((sel) => sel.addEventListener('change', async () => {
      sel.disabled = true;
      try {
        await adminFetch(`/api/admin/orders/${encodeURIComponent(sel.dataset.status)}/status`, {
          method: 'PATCH', body: { order_status: sel.value }
        });
        toast(`${sel.dataset.status} → ${sel.value}`, 'success');
        loadStats();
      } catch (err) { toast(err.message, 'error'); sel.value = sel.dataset.prev || sel.value; }
      finally { sel.disabled = false; }
    }));

    host.querySelectorAll('[data-payment]').forEach((sel) => sel.addEventListener('change', async () => {
      sel.disabled = true;
      try {
        await adminFetch(`/api/admin/orders/${encodeURIComponent(sel.dataset.payment)}/payment-status`, {
          method: 'PATCH', body: { payment_status: sel.value }
        });
        toast(`${sel.dataset.payment} payment → ${sel.value}`, 'success');
        loadStats();
      } catch (err) { toast(err.message, 'error'); }
      finally { sel.disabled = false; }
    }));

    host.querySelectorAll('[data-detail]').forEach((btn) => btn.addEventListener('click', () => showOrder(btn.dataset.detail)));
  } catch (err) {
    if (err.status === 401) return showLogin('Your session expired. Please sign in again.');
    host.innerHTML = alertHtml(err.message, 'error');
  }
}

async function showOrder(orderNumber) {
  const host = document.getElementById('order-detail');
  host.innerHTML = '<p class="muted">Loading order…</p>';
  try {
    const { data } = await adminFetch(`/api/admin/orders/${encodeURIComponent(orderNumber)}`);
    host.innerHTML = `
      <div class="detail-panel">
        <h3>${esc(data.order_number)}</h3>
        <p class="muted">${esc(data.customer.name)} · ${esc(data.customer.phone)} · ${esc(data.customer.email || 'no email')}</p>
        <p class="muted">${esc(data.customer.address)}, ${esc(data.customer.town || '')}, ${esc(data.customer.county || '')}</p>
        ${data.customer.delivery_instructions ? `<p class="muted">Notes: ${esc(data.customer.delivery_instructions)}</p>` : ''}
        <table><tbody>
          ${data.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${formatKES(i.unit_price)}</td><td>× ${i.quantity}</td><td>${formatKES(i.line_total)}</td></tr>`).join('')}
        </tbody></table>
        <p>Subtotal ${formatKES(data.subtotal)} · Delivery ${formatKES(data.delivery_fee)} (<em>${esc(data.delivery_zone || '—')}</em>) · <strong>Total ${formatKES(data.total)}</strong></p>
        ${data.payments.length ? `<h4 style="font-size:.95rem">Payment attempts</h4>
          <table><tbody>${data.payments.map((p) => `<tr><td>${esc(p.provider)}</td><td>${esc(p.provider_ref)}</td><td>${formatKES(p.amount)}</td><td>${esc(p.status)}</td><td>${esc(new Date(p.created_at).toLocaleString('en-KE'))}</td></tr>`).join('')}</tbody></table>` : ''}
        <button class="btn btn-secondary btn-sm" id="close-detail" type="button">Close</button>
      </div>`;
    document.getElementById('close-detail').addEventListener('click', () => { host.innerHTML = ''; });
  } catch (err) {
    host.innerHTML = alertHtml(err.message, 'error');
  }
}

/* ----------------------------- products ---------------------------- */
async function loadProducts() {
  const host = document.getElementById('products-host');
  const qs = new URLSearchParams({ page: productState.page, per_page: 25 });
  if (productState.q) qs.set('q', productState.q);
  try {
    const res = await adminFetch(`/api/admin/products?${qs}`);
    host.innerHTML = `
      <div class="table-wrap">
      <table>
        <thead><tr><th>Product</th><th>Source price</th><th>Selling price</th><th>Stock</th><th>Category</th><th>Synced</th></tr></thead>
        <tbody>
        ${res.data.map((p) => `<tr>
          <td><div class="cell-product">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ''}<span>${esc(p.name)}<br><span class="muted">${esc(p.id)}</span></span></div></td>
          <td class="muted">${formatKES(p.source_price)}</td>
          <td><strong>${formatKES(p.selling_price)}</strong></td>
          <td>${p.stock}${p.stock === 0 ? ' <span class="badge badge-out">out</span>' : ''}</td>
          <td>${esc(p.category || '—')}</td>
          <td class="muted">${p.synced_at ? esc(new Date(p.synced_at).toLocaleDateString('en-KE')) : '—'}</td>
        </tr>`).join('')}
        </tbody>
      </table></div>`;
    document.getElementById('products-pager').innerHTML =
      `<button class="btn btn-secondary btn-sm" id="pp-prev" ${productState.page <= 1 ? 'disabled' : ''}>Previous</button>
       <span class="muted">Page ${productState.page} · ${res.pagination.total} products</span>
       <button class="btn btn-secondary btn-sm" id="pp-next" ${res.data.length < 25 ? 'disabled' : ''}>Next</button>`;
    document.getElementById('pp-prev')?.addEventListener('click', () => { productState.page--; loadProducts(); });
    document.getElementById('pp-next')?.addEventListener('click', () => { productState.page++; loadProducts(); });
  } catch (err) {
    if (err.status === 401) return showLogin('Your session expired. Please sign in again.');
    host.innerHTML = alertHtml(err.message, 'error');
  }
}

/* ------------------------------ audit ------------------------------ */
async function loadAudit() {
  const host = document.getElementById('audit-host');
  try {
    const { data } = await adminFetch('/api/admin/audit');
    host.innerHTML = !data.length ? '<p class="muted">No activity recorded yet.</p>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead>
        <tbody>${data.map((r) => `<tr>
          <td class="muted">${esc(new Date(r.created_at).toLocaleString('en-KE'))}</td>
          <td>${esc(r.admin_username || r.admin_id || '—')}</td>
          <td>${esc(r.action)}</td>
          <td>${esc(r.target || '—')}</td>
          <td class="muted">${esc((r.detail || '').slice(0, 90))}</td>
          <td class="muted">${esc(r.ip || '—')}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  } catch { host.innerHTML = '<p class="muted">Activity log unavailable.</p>'; }
}

/* ------------------------------ wiring ------------------------------ */
document.getElementById('f-status').addEventListener('change', (e) => {
  orderState.page = 1; orderState.filters.status = e.target.value; loadOrders();
});
document.getElementById('f-payment').addEventListener('change', (e) => {
  orderState.page = 1; orderState.filters.payment_status = e.target.value; loadOrders();
});
document.getElementById('f-q').addEventListener('input', debounce((e) => {
  orderState.page = 1; orderState.filters.q = e.target.value.trim(); loadOrders();
}, 350));
document.getElementById('refresh-orders').addEventListener('click', () => { loadOrders(); loadStats(); });
document.getElementById('p-q').addEventListener('input', debounce((e) => {
  productState.page = 1; productState.q = e.target.value.trim(); loadProducts();
}, 350));

async function refreshAll() {
  await Promise.all([loadStats(), loadOrders(), loadProducts(), loadAudit()]);
}

/* ------------------------------- init ------------------------------- */
(async function init() {
  try {
    const me = await adminFetch('/api/admin/me');
    showDash(me.data.username);
    await refreshAll();
  } catch {
    showLogin();
  }
})();
