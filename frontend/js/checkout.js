import { apiFetch, esc, formatKES } from './api.js';
import { renderHeader, renderFooter, alertHtml, toast } from './layout.js';
import * as cart from './cart.js';

renderHeader('');
renderFooter();

const COUNTIES = ['Nairobi','Kiambu','Machakos','Kajiado','Nakuru','Mombasa','Kisumu','Uasin Gishu',
  'Nyeri','Meru','Kakamega','Bungoma','Kisii','Kericho','Laikipia','Murang\u2019a','Embu','Kilifi','Taita Taveta','Other'];

const form = document.getElementById('checkout-form');
const alertHost = document.getElementById('checkout-alert');
const submitBtn = document.getElementById('place-order');
const zoneRow = document.getElementById('zone-row');

/* One idempotency key per checkout attempt: a retried submit can never create
 * a second order - the server returns the original one instead. */
const idempotencyKey = (crypto.randomUUID && crypto.randomUUID()) ||
  `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let zones = [];
let lastQuote = null;

/* Prefill county select */
const countySel = document.getElementById('c-county');
countySel.innerHTML = '<option value="">Select county…</option>' +
  COUNTIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

/* ------------------------------- zones ---------------------------- */
async function loadZones() {
  try {
    const res = await apiFetch('/delivery-zones');
    zones = res.data || [];
    zoneRow.innerHTML = zones.map((z, i) => `
      <label class="radio-card">
        <input type="radio" name="zone" value="${esc(z.id)}" ${i === 0 || z.is_default ? '' : ''}>
        <span><strong>${esc(z.label)}</strong><span class="muted">${formatKES(z.fee)} delivery</span></span>
      </label>`).join('');
    const preferred = zones.find((z) => z.id === 'nairobi') || zones[0];
    const radio = zoneRow.querySelector(`input[value="${CSS.escape(preferred.id)}"]`);
    if (radio) radio.checked = true;
    zoneRow.querySelectorAll('input[name="zone"]').forEach((r) => r.addEventListener('change', refreshQuote));
  } catch (err) {
    zoneRow.innerHTML = alertHtml('Could not load delivery options. Please reload the page.', 'error');
  }
}

function selectedZone() {
  const id = form.querySelector('input[name="zone"]:checked')?.value;
  return zones.find((z) => z.id === id) || null;
}

/* ------------------------------ summary --------------------------- */
function renderSummaryItems(quote) {
  const host = document.getElementById('summary-items');
  if (!quote) { host.innerHTML = '<p class="muted">Loading…</p>'; return; }
  host.innerHTML = quote.items.map((l) => `
    <div class="summary-row">
      <span>${esc(l.product_name)} <span class="muted">× ${l.quantity}</span></span>
      <strong>${formatKES(l.line_total)}</strong>
    </div>`).join('') || '<p class="muted">No items.</p>';
}

async function refreshQuote() {
  const items = cart.toOrderItems();
  if (!items.length) {
    alertHost.innerHTML = alertHtml('Your cart is empty. Please add a product before checking out.', 'warn');
    submitBtn.disabled = true;
    renderSummaryItems(null);
    return;
  }
  const zone = selectedZone();
  const location = zone ? zone.label : (countySel.value || '');
  try {
    const res = await apiFetch('/orders/quote', {
      method: 'POST',
      body: { items, delivery_location: location }
    });
    lastQuote = res.data;
    renderSummaryItems(lastQuote);
    document.getElementById('s-subtotal').textContent = formatKES(lastQuote.subtotal);
    document.getElementById('s-delivery').textContent = formatKES(lastQuote.delivery_fee);
    document.getElementById('s-zone').textContent = `(${lastQuote.delivery_zone.label})`;
    document.getElementById('s-total').textContent = formatKES(lastQuote.total);
    submitBtn.disabled = false;
  } catch (err) {
    alertHost.innerHTML = alertHtml(err.message, 'error');
    submitBtn.disabled = true;
  }
}

/* ---------------------------- validation -------------------------- */
const KE_PHONE = /^(?:\+?254|0)(?:7|1)\d{8}$/;

function clearErrors() {
  form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
}

function showError(field, message) {
  const el = form.querySelector(`.field-error[data-for="${field}"]`);
  if (el) el.textContent = message;
  const input = form.querySelector(`[name="${field}"]`);
  if (input) input.setAttribute('aria-invalid', 'true');
}

function validateForm() {
  clearErrors();
  let ok = true;
  const name = form.elements.name.value.trim();
  const phone = form.elements.phone.value.replace(/[\s()-]/g, '');
  const email = form.elements.email.value.trim();
  const address = form.elements.address.value.trim();

  if (name.length < 2) { showError('name', 'Please enter your full name.'); ok = false; }
  if (!KE_PHONE.test(phone)) { showError('phone', 'Enter a valid Kenyan number, e.g. 0712345678.'); ok = false; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { showError('email', 'Enter a valid email or leave it blank.'); ok = false; }
  if (!countySel.value) { showError('county', 'Please select your county.'); ok = false; }
  if (!form.elements.town.value.trim()) { showError('town', 'Please enter your town or city.'); ok = false; }
  if (address.length < 4) { showError('address', 'Please enter a delivery address.'); ok = false; }
  if (!selectedZone()) { alertHost.innerHTML = alertHtml('Please choose a delivery zone.', 'error'); ok = false; }

  if (!ok) {
    const firstBad = form.querySelector('[aria-invalid="true"]');
    if (firstBad) firstBad.focus();
  }
  return ok;
}

/* ------------------------------ submit ---------------------------- */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertHost.innerHTML = '';
  if (!validateForm()) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Placing order…';

  const zone = selectedZone();
  const payload = {
    customer: {
      name: form.elements.name.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim() || undefined,
      county: countySel.value,
      town: form.elements.town.value.trim(),
      address: form.elements.address.value.trim(),
      delivery_instructions: document.getElementById('c-notes').value.trim() || undefined
    },
    items: cart.toOrderItems(),                    // only ids + quantities
    delivery_location: zone ? zone.label : countySel.value,
    idempotency_key: idempotencyKey
  };

  try {
    const res = await apiFetch('/orders', { method: 'POST', body: payload });
    const order = res.data;
    cart.clear();
    sessionStorage.setItem('ncs_last_order', JSON.stringify({
      order_number: order.order_number, view_token: order.view_token
    }));
    window.location.href = `/order-success.html?order=${encodeURIComponent(order.order_number)}&token=${encodeURIComponent(order.view_token)}`;
  } catch (err) {
    alertHost.innerHTML = alertHtml(err.message, 'error');
    alertHost.scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(err.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Place order';
  }
});

countySel.addEventListener('change', refreshQuote);

/* ------------------------------- init ----------------------------- */
(async function init() {
  await loadZones();
  await refreshQuote();
  if (!cart.count()) {
    submitBtn.disabled = true;
  }
})();
