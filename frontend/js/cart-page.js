import { apiFetch, esc, formatKES, safeImage, imagePlaceholder } from './api.js';
import { renderHeader, renderFooter, alertHtml, toast, updateCartCount } from './layout.js';
import * as cart from './cart.js';

renderHeader('');
renderFooter();

const itemsHost = document.getElementById('cart-items');
const alertHost = document.getElementById('cart-alert');
const checkoutBtn = document.getElementById('checkout-btn');

/* Live catalogue price map, fetched fresh - localStorage prices are ignored. */
let live = new Map();

function renderRows() {
  const lines = cart.getLines();
  if (!lines.length) {
    itemsHost.innerHTML = `<div class="empty-state">
      <h2>Your cart is empty</h2>
      <p>Browse our catalogue and add products to get started.</p>
      <a class="btn btn-primary" href="/products.html">Shop products</a></div>`;
    applyTotals(0);
    checkoutBtn.setAttribute('aria-disabled', 'true');
    checkoutBtn.style.pointerEvents = 'none';
    checkoutBtn.style.opacity = '.55';
    return;
  }
  checkoutBtn.removeAttribute('aria-disabled');
  checkoutBtn.style.pointerEvents = '';
  checkoutBtn.style.opacity = '1';

  let subtotal = 0;
  let blocked = false;

  const rows = lines.map((line) => {
    const p = live.get(line.product_id);
    if (!p) {
      blocked = true;
      return `<div class="cart-item">
        <div class="skeleton" style="width:90px;height:72px"></div>
        <div>
          <strong>${esc(line.snapshot?.name || line.product_id)}</strong>
          <p class="field-error">This product is no longer available and will be removed at checkout.</p>
          <button class="btn btn-danger btn-sm js-remove" data-id="${esc(line.product_id)}" type="button">Remove</button>
        </div>
        <div class="line-total">&mdash;</div>
      </div>`;
    }

    const unit = p.selling_price;
    const lineTotal = unit * line.quantity;
    subtotal += lineTotal;
    const img = safeImage(p.image) || imagePlaceholder();
    const stockNote = p.stock < line.quantity
      ? `<span class="badge badge-out">Only ${p.stock} in stock</span>`
      : p.stock <= 3
        ? `<span class="badge badge-low">Only ${p.stock} left</span>`
        : `<span class="badge badge-in">In stock</span>`;
    if (p.stock < line.quantity) blocked = true;

    return `<div class="cart-item" data-id="${esc(p.id)}">
      <img src="${esc(img)}" alt="${esc(p.name)}" loading="lazy">
      <div>
        <strong><a href="/product.html?id=${encodeURIComponent(p.id)}">${esc(p.name)}</a></strong>
        <div class="muted">${formatKES(unit)} each &middot; ${esc(p.category)}</div>
        <div class="item-controls">
          <div class="qty-picker" role="group" aria-label="Quantity for ${esc(p.name)}">
            <button type="button" class="js-dec" data-id="${esc(p.id)}" aria-label="Decrease quantity">&minus;</button>
            <input type="number" inputmode="numeric" min="1" max="99" value="${line.quantity}" class="js-qty" data-id="${esc(p.id)}" aria-label="Quantity for ${esc(p.name)}">
            <button type="button" class="js-inc" data-id="${esc(p.id)}" aria-label="Increase quantity">+</button>
          </div>
          ${stockNote}
          <button class="btn btn-danger btn-sm js-remove" data-id="${esc(p.id)}" type="button">Remove</button>
        </div>
      </div>
      <div class="line-total">${formatKES(lineTotal)}</div>
    </div>`;
  }).join('');

  itemsHost.innerHTML = rows || '<p class="muted">No items.</p>';
  applyTotals(subtotal);

  if (blocked) {
    checkoutBtn.style.pointerEvents = 'none';
    checkoutBtn.style.opacity = '.55';
    alertHost.innerHTML = alertHtml(
      'Some items in your cart are unavailable or exceed available stock. Please adjust your cart before checking out.',
      'warn'
    );
  } else {
    alertHost.innerHTML = '';
  }
}

function applyTotals(subtotal) {
  document.getElementById('s-subtotal').textContent = formatKES(subtotal);
  document.getElementById('s-total').textContent = formatKES(subtotal);
}

/* ------------------------------ events ---------------------------- */
itemsHost.addEventListener('click', (e) => {
  const dec = e.target.closest('.js-dec');
  const inc = e.target.closest('.js-inc');
  const rem = e.target.closest('.js-remove');
  if (dec) { cart.setQuantity(dec.dataset.id, cart.getLines().find(l => l.product_id === dec.dataset.id).quantity - 1); renderRows(); updateCartCount(); }
  if (inc) { cart.setQuantity(inc.dataset.id, cart.getLines().find(l => l.product_id === inc.dataset.id).quantity + 1); renderRows(); updateCartCount(); }
  if (rem) { cart.remove(rem.dataset.id); toast('Item removed from your cart.', 'info'); renderRows(); updateCartCount(); }
});

itemsHost.addEventListener('change', (e) => {
  const qty = e.target.closest('.js-qty');
  if (!qty) return;
  cart.setQuantity(qty.dataset.id, qty.value);
  renderRows(); updateCartCount();
});

async function loadLivePrices() {
  const lines = cart.getLines();
  if (!lines.length) { renderRows(); return; }
  try {
    const results = await Promise.all(lines.map(async (l) => {
      try { const r = await apiFetch(`/products/${encodeURIComponent(l.product_id)}`); return r.data; }
      catch { return null; }
    }));
    live = new Map(results.filter(Boolean).map((p) => [p.id, p]));
    renderRows();
  } catch (err) {
    alertHost.innerHTML = alertHtml('We could not refresh prices right now. ' + err.message, 'error');
    renderRows();
  }
}

/* Always re-fetch on show (handles back/forward and bfcache) */
window.addEventListener('pageshow', loadLivePrices);
loadLivePrices();
