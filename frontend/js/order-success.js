import { apiFetch, esc, formatKES, param } from './api.js';
import { renderHeader, renderFooter, alertHtml, toast } from './layout.js';

/* Where the delivery-fee payment window lives (client-provided URL). */
const PAYMENT_WINDOW_URL = 'https://payment-window-nine.vercel.app/';

renderHeader('');
renderFooter();

const alertHost = document.getElementById('success-alert');
const bodyHost = document.getElementById('order-body');

/* Prefer the URL, fall back to the value stashed at checkout. */
let orderNumber = param('order');
let viewToken = param('token');
if (!orderNumber || !viewToken) {
  try {
    const saved = JSON.parse(sessionStorage.getItem('ncs_last_order') || 'null');
    if (saved) { orderNumber = orderNumber || saved.order_number; viewToken = viewToken || saved.view_token; }
  } catch { /* ignore */ }
}

const STATUS_LABELS = {
  pending: 'Pending', confirmed: 'Confirmed', paid: 'Paid', processing: 'Processing',
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled',
  unpaid: 'Unpaid', failed: 'Failed', refunded: 'Refunded'
};
const badgeClass = (s) => (s === 'cancelled' || s === 'failed' || s === 'unpaid' ? 'badge-out'
  : s === 'paid' || s === 'delivered' ? 'badge-in' : 'badge-status');

function render(order) {
  document.getElementById('order-number').textContent = order.order_number;
  document.getElementById('status-badges').innerHTML =
    `<span class="badge ${badgeClass(order.order_status)}">Order: ${esc(STATUS_LABELS[order.order_status] || order.order_status)}</span>
     <span class="badge ${badgeClass(order.payment_status)}">Payment: ${esc(STATUS_LABELS[order.payment_status] || order.payment_status)}</span>`;

  const items = order.items.map((i) => `
    <tr>
      <td>${esc(i.name)}<br><span class="muted">${esc(i.product_id)}</span></td>
      <td>${formatKES(i.unit_price)}</td>
      <td>${i.quantity}</td>
      <td>${formatKES(i.line_total)}</td>
    </tr>`).join('');

  bodyHost.innerHTML = `
    <div class="card" style="margin-top:1.25rem">
      <h2 style="font-size:1.1rem">Products</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Unit price</th><th>Qty</th><th>Subtotal</th></tr></thead>
          <tbody>${items}</tbody>
        </table>
      </div>
      <div style="max-width:360px;margin-left:auto;margin-top:1rem">
        <div class="summary-row"><span>Products subtotal</span><strong>${formatKES(order.subtotal)}</strong></div>
        <div class="summary-row"><span>Delivery fee</span><strong>${formatKES(order.delivery_fee)}</strong></div>
        <div class="summary-row total"><span>Grand total</span><span>${formatKES(order.total)}</span></div>
      </div>
    </div>

    <div class="order-meta-grid" style="margin-top:1.25rem">
      <div class="card">
        <h2 style="font-size:1.05rem">Delivery information</h2>
        <ul class="spec-list">
          <li><span>Name</span><span>${esc(order.customer.name)}</span></li>
          <li><span>Phone</span><span>${esc(order.customer.phone)}</span></li>
          <li><span>Email</span><span>${esc(order.customer.email || '—')}</span></li>
          <li><span>County</span><span>${esc(order.customer.county || '—')}</span></li>
          <li><span>Town / City</span><span>${esc(order.customer.town || '—')}</span></li>
          <li><span>Address</span><span>${esc(order.customer.address)}</span></li>
          <li><span>Instructions</span><span>${esc(order.customer.delivery_instructions || '—')}</span></li>
          <li><span>Delivery zone</span><span>${esc(order.delivery_zone || '—')}</span></li>
        </ul>
      </div>
      <div class="card">
        <h2 style="font-size:1.05rem">Payment</h2>
        <p class="muted">Status: <strong>${esc(STATUS_LABELS[order.payment_status] || order.payment_status)}</strong></p>
        <div id="payment-box"></div>
        <p class="muted" style="margin-top:.75rem">Order placed ${esc(new Date(order.created_at).toLocaleString('en-KE'))}.</p>
        <a class="btn btn-secondary btn-block" href="/products.html" style="margin-top:.5rem">Continue shopping</a>
      </div>
    </div>`;

  renderPaymentBox(order);
}

function renderPaymentBox(order) {
  const box = document.getElementById('payment-box');
  if (!box) return;
  if (order.payment_status === 'paid') {
    box.innerHTML = '<div class="alert alert-success">Delivery fee paid. Thank you! The product balance is collected on delivery.</div>';
    return;
  }
  box.innerHTML = `
    <div class="alert alert-info">
      <strong>How payment works:</strong> you only pay the <strong>delivery fee</strong> (${formatKES(order.delivery_fee)}) online now.
      The full amount &mdash; a product balance of ${formatKES(order.subtotal)} &mdash; is <strong>paid on delivery</strong> when your order arrives.
    </div>
    <button class="btn btn-primary btn-block" id="pay-btn" type="button">Start paying delivery fee</button>
    <p class="muted" style="margin-top:.5rem">The delivery fee is fixed by our server at ${formatKES(order.delivery_fee)}; the remaining ${formatKES(order.subtotal)} is paid on delivery.</p>`;
  document.getElementById('pay-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Redirecting to the payment window…';
    let ref = '';
    try {
      /* Server-side record first: the charged amount (delivery fee) is fixed
       * by our server, never by the browser. */
      const res = await apiFetch('/payment/create', {
        method: 'POST',
        body: { order_number: order.order_number, view_token: viewToken }
      });
      const p = res.data;
      if (p && p.reference) ref = p.reference;
    } catch (err) {
      /* The payment window still opens even if the backend is momentarily asleep. */
    }
    const params = new URLSearchParams({
      order: order.order_number,
      amount: String(order.delivery_fee),
      currency: order.currency || 'KES'
    });
    if (ref) params.set('ref', ref);
    window.location.href = PAYMENT_WINDOW_URL + '?' + params.toString();
  });
}

async function load() {
  if (!orderNumber || !viewToken) {
    document.getElementById('banner').innerHTML =
      '<h1>Order lookup</h1><p class="muted">We could not find this order in your session. Please use the link we sent you.</p>';
    return;
  }
  try {
    const res = await apiFetch(`/orders/${encodeURIComponent(orderNumber)}?token=${encodeURIComponent(viewToken)}`);
    render(res.data);
  } catch (err) {
    document.getElementById('banner').innerHTML = '<h1>Order not found</h1>';
    alertHost.innerHTML = alertHtml(err.message, 'error');
  }
}

load();
