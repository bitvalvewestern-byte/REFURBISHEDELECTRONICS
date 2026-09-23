import { apiFetch, esc, formatKES, safeImage, imagePlaceholder, param, readCatalogue, loadSnapshot, staleNotice, snapshotNotice } from './api.js';
import { renderHeader, renderFooter, productCardHtml, bindAddButtons, alertHtml, toast } from './layout.js';
import * as cart from './cart.js';

const id = param('id');
renderHeader('');
renderFooter();

const host = document.getElementById('detail-host');
const alertHost = document.getElementById('detail-alert');
const relatedHost = document.getElementById('related');

function maxQty(p) { return Math.max(1, Math.min(p.stock || 1, 20)); }

function detailHtml(p) {
  const img = safeImage(p.image) || imagePlaceholder();
  const out = !p.in_stock;
  const max = maxQty(p);
  const stockBadge = out
    ? '<span class="badge badge-out">Out of stock</span>'
    : p.stock <= 3
      ? `<span class="badge badge-low">Low stock &mdash; only ${p.stock} left</span>`
      : `<span class="badge badge-in">In stock (${p.stock} available)</span>`;

  return `
  <div class="product-detail">
    <div class="gallery"><img src="${esc(img)}" alt="${esc(p.name)}" width="600" height="450"></div>
    <div>
      <span class="badge badge-info">${esc(p.category)}</span>
      <h1>${esc(p.name)}</h1>
      <p>${stockBadge}</p>
      <div class="price" style="margin:.5rem 0">${formatKES(p.selling_price)}<small>Price includes applicable taxes</small></div>

      <div style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap;margin:1rem 0">
        <div class="qty-picker" role="group" aria-label="Quantity">
          <button type="button" id="q-dec" aria-label="Decrease quantity">&minus;</button>
          <label class="visually-hidden" for="q-val">Quantity</label>
          <input id="q-val" type="number" inputmode="numeric" min="1" max="${max}" value="1" ${out ? 'disabled' : ''}>
          <button type="button" id="q-inc" aria-label="Increase quantity">+</button>
        </div>
        <button class="btn btn-primary" id="add-btn" type="button" ${out ? 'disabled' : ''} style="flex:1 1 220px">
          ${out ? 'Out of stock' : 'Add to cart'}
        </button>
      </div>

      <ul class="spec-list">
        <li><span>Product code</span><span>${esc(p.id)}</span></li>
        <li><span>Category</span><span>${esc(p.category)}</span></li>
        <li><span>Availability</span><span>${out ? 'Out of stock' : `${p.stock} in stock`}</span></li>
        <li><span>Currency</span><span>${esc(p.currency)}</span></li>
      </ul>

      <h2 style="margin-top:1.5rem;font-size:1.1rem">Description</h2>
      <p style="white-space:pre-line">${esc(p.description || 'No description provided for this product.')}</p>
    </div>
  </div>`;
}

/* Paint a product (from the live API or a fallback source). */
function paint(p, related) {
  document.title = `${p.name} | Nairobi Computer Shop`;
  document.getElementById('crumb-cat').innerHTML = ` / <a href="/products.html?category=${encodeURIComponent(p.category)}">${esc(p.category)}</a>`;
  host.innerHTML = detailHtml(p);

  /* quantity controls */
  const input = document.getElementById('q-val');
  const clamp = (v) => Math.max(1, Math.min(parseInt(v, 10) || 1, maxQty(p)));
  document.getElementById('q-inc').addEventListener('click', () => { input.value = clamp(Number(input.value) + 1); });
  document.getElementById('q-dec').addEventListener('click', () => { input.value = clamp(Number(input.value) - 1); });
  input.addEventListener('change', () => { input.value = clamp(input.value); });

  document.getElementById('add-btn').addEventListener('click', () => {
    const qty = clamp(input.value);
    cart.add(p, qty);
    toast(`Added ${qty} × “${p.name}” to your cart.`, 'success');
  });

  const others = (related || []).filter((x) => x.id !== p.id).slice(0, 4);
  if (others.length) {
    relatedHost.innerHTML = `<div class="product-grid">${others.map(productCardHtml).join('')}</div>`;
    bindAddButtons(relatedHost, new Map(others.map((x) => [x.id, x])));
  } else {
    relatedHost.innerHTML = '<p class="muted">No related products.</p>';
  }
}

async function load() {
  if (!id) {
    host.innerHTML = '';
    alertHost.innerHTML = alertHtml('No product was specified.', 'error');
    return;
  }
  try {
    const { data: p } = await apiFetch(`/products/${encodeURIComponent(id)}`);

    /* related products from the same category */
    let related = [];
    try {
      const rel = await apiFetch(`/products?category=${encodeURIComponent(p.category)}&per_page=5&sort=newest`);
      related = rel.data || [];
    } catch { /* related is optional */ }

    paint(p, related);
  } catch (err) {
    /* Fallback: last cached catalogue, then the bundled snapshot. */
    const cached = readCatalogue();
    const snap = cached ? null : await loadSnapshot();
    const items = cached ? cached.items : (snap ? snap.items : null);
    const notice = cached ? staleNotice(cached.at) : (snap ? snapshotNotice(snap.at) : null);
    const p = items ? items.find((x) => x.id === id) : null;

    if (p) {
      paint(p, items);
      alertHost.innerHTML = alertHtml(notice, 'warn');
      return;
    }
    host.innerHTML = '';
    alertHost.innerHTML = alertHtml(err.message, 'error');
    relatedHost.innerHTML = '';
  }
}

load();
