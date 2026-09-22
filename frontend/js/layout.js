/* Shared chrome: header, nav, footer, cart badge, toasts. */
import { esc, formatKES, safeImage, imagePlaceholder } from './api.js';
import * as cart from './cart.js';

export const CATEGORY_NAV = [
  { label: 'Laptops', slug: 'Laptops' },
  { label: 'Gaming Laptops', slug: 'Gaming Laptops' },
  { label: 'Desktops', slug: 'Desktops' },
  { label: 'Monitors', slug: 'Monitors' },
  { label: 'Storage', slug: 'Storage' },
  { label: 'Networking', slug: 'Networking' },
  { label: 'CCTV & Surveillance', slug: 'CCTV & Surveillance' },
  { label: 'Smartphones', slug: 'Smartphones' },
  { label: 'Tablets', slug: 'Tablets' },
  { label: 'Accessories', slug: '' }
];

export function renderHeader(active = '') {
  const host = document.getElementById('site-header');
  if (!host) return;
  const nav = CATEGORY_NAV.map((c) => {
    const href = c.slug ? `/products.html?category=${encodeURIComponent(c.slug)}` : '/products.html';
    const current = active === c.slug ? ' aria-current="page"' : '';
    return `<li><a href="${href}"${current}>${esc(c.label)}</a></li>`;
  }).join('');

  host.className = 'site-header';
  host.innerHTML = `
    <div class="container">
      <div class="header-top">
        <a class="brand" href="/index.html">
          <span class="brand-mark" aria-hidden="true">NC</span>
          <span class="brand-text">Nairobi Computer Shop<small>Computers &amp; accessories in Kenya</small></span>
        </a>
        <form class="search-form" role="search" id="header-search">
          <label class="visually-hidden" for="header-search-input">Search products</label>
          <input id="header-search-input" type="search" name="q" placeholder="Search laptops, monitors, accessories…" autocomplete="off">
          <button type="submit">Search</button>
        </form>
        <div class="header-actions">
          <a class="cart-link" href="/cart.html" aria-label="Shopping cart">
            <span aria-hidden="true">&#128722;</span>
            <span>Cart</span>
            <span class="cart-count" id="cart-count" aria-live="polite">0</span>
          </a>
        </div>
      </div>
    </div>
    <nav class="nav-bar" aria-label="Product categories"><div class="container"><ul>${nav}</ul></div></nav>
  `;

  const form = host.querySelector('#header-search');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = form.querySelector('input').value.trim();
    window.location.href = q ? `/products.html?q=${encodeURIComponent(q)}` : '/products.html';
  });

  updateCartCount();
  document.addEventListener('cart:updated', updateCartCount);
}

export function updateCartCount() {
  const el = document.getElementById('cart-count');
  if (!el) return;
  const n = cart.count();
  el.textContent = String(n);
  el.setAttribute('aria-label', `${n} item(s) in cart`);
}

export function renderFooter() {
  const host = document.getElementById('site-footer');
  if (!host) return;
  host.className = 'site-footer';
  host.innerHTML = `
    <div class="container">
      <div class="footer-grid">
        <div>
          <h4>Nairobi Computer Shop</h4>
          <p>Your one stop shop for computers and accessories in Kenya. Laptops, desktops, monitors, CCTV, networking and genuine accessories.</p>
        </div>
        <div>
          <h4>Shop</h4>
          <ul>
            <li><a href="/products.html?category=Laptops">Laptops</a></li>
            <li><a href="/products.html?category=Desktops">Desktops</a></li>
            <li><a href="/products.html?category=Monitors">Monitors</a></li>
            <li><a href="/products.html?category=CCTV%20%26%20Surveillance">CCTV &amp; Surveillance</a></li>
            <li><a href="/products.html">All products</a></li>
          </ul>
        </div>
        <div>
          <h4>Customer care</h4>
          <ul>
            <li><a href="/cart.html">Your cart</a></li>
            <li><a href="/checkout.html">Checkout</a></li>
            <li>Delivery: Nairobi KES 500 &middot; Outside Nairobi KES 1,000</li>
            <li>Payment on delivery or online (once enabled)</li>
          </ul>
        </div>
        <div>
          <h4>Contact</h4>
          <ul>
            <li>Nairobi, Kenya</li>
            <li>Mon&ndash;Sat, 8:30am &ndash; 6:00pm</li>
            <li><a href="/products.html">Browse catalogue</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <span>&copy; ${new Date().getFullYear()} Nairobi Computer Shop. All rights reserved.</span>
        <span>Prices in Kenyan Shillings (KES), inclusive of applicable taxes.</span>
      </div>
    </div>`;
}

/* --------------------------- product card -------------------------- */
export function productCardHtml(p) {
  const img = safeImage(p.image) || imagePlaceholder();
  const out = !p.in_stock;
  const low = !out && p.stock <= 3;
  const stockBadge = out
    ? '<span class="badge badge-out">Out of stock</span>'
    : low
      ? `<span class="badge badge-low">Only ${p.stock} left</span>`
      : `<span class="badge badge-in">In stock (${p.stock})</span>`;

  return `
  <article class="product-card" data-id="${esc(p.id)}">
    <div class="thumb"><img src="${esc(img)}" alt="${esc(p.name)}" loading="lazy" width="300" height="225"></div>
    <div class="body">
      <h3><a href="/product.html?id=${encodeURIComponent(p.id)}">${esc(p.name)}</a></h3>
      <p class="desc">${esc(p.description || '')}</p>
      <div>${stockBadge} <span class="badge badge-info">${esc(p.category)}</span></div>
      <div class="price">${formatKES(p.selling_price)}<small>incl. taxes</small></div>
      <div class="actions">
        <button class="btn btn-primary js-add" type="button" data-id="${esc(p.id)}" ${out ? 'disabled' : ''}>
          ${out ? 'Out of stock' : 'Add to cart'}
        </button>
        <a class="btn btn-secondary" href="/product.html?id=${encodeURIComponent(p.id)}">View product</a>
      </div>
    </div>
  </article>`;
}

/** Wire up "Add to cart" buttons inside a container. */
export function bindAddButtons(container, productsById) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.js-add');
    if (!btn) return;
    const product = productsById.get(btn.dataset.id);
    if (!product) return;
    const n = cart.add(product, 1);
    toast(`Added “${product.name}” to your cart (${n} item${n === 1 ? '' : 's'}).`, 'success');
    updateCartCount();
  });
}

/* ------------------------------- toast ----------------------------- */
export function toast(message, type = 'info', timeout = 4000) {
  let area = document.querySelector('.toast-area');
  if (!area) {
    area = document.createElement('div');
    area.className = 'toast-area';
    area.setAttribute('role', 'status');
    area.setAttribute('aria-live', 'polite');
    document.body.appendChild(area);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  area.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

export function alertHtml(message, type = 'error') {
  return `<div class="alert alert-${type}" role="alert">${esc(message)}</div>`;
}

export function skeletonGrid(n = 8) {
  return `<div class="product-grid">${Array.from({ length: n }).map(() => `
    <article class="product-card"><div class="thumb skeleton"></div>
      <div class="body"><div class="skeleton" style="height:14px;width:80%"></div>
      <div class="skeleton" style="height:12px;width:60%"></div>
      <div class="skeleton" style="height:20px;width:45%"></div></div></article>`).join('')}</div>`;
}
