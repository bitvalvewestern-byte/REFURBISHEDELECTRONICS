import { apiFetch, esc } from './api.js';
import { renderHeader, renderFooter, productCardHtml, bindAddButtons, alertHtml, skeletonGrid, toast } from './layout.js';

renderHeader('');
renderFooter();

const featured = document.getElementById('featured');
const alertHost = document.getElementById('home-alert');
featured.innerHTML = skeletonGrid(12);

async function loadHome() {
  try {
    const [productsRes, catsRes] = await Promise.all([
      apiFetch('/products?per_page=12&sort=newest'),
      apiFetch('/products/categories')
    ]);

    const products = productsRes.data || [];
    const byId = new Map(products.map((p) => [p.id, p]));

    featured.innerHTML = products.length
      ? `<div class="product-grid">${products.map(productCardHtml).join('')}</div>`
      : '<div class="empty-state">No products are available right now. Please check back shortly.</div>';
    if (products.length) bindAddButtons(featured, byId);

    const tiles = document.getElementById('category-tiles');
    const cats = (catsRes.data || []).slice(0, 12);
    tiles.innerHTML = cats.map((c) => `
      <article class="product-card">
        <div class="body" style="gap:.75rem">
          <h3><a href="/products.html?category=${encodeURIComponent(c.name)}">${esc(c.name)}</a></h3>
          <p class="desc">${c.count} product${c.count === 1 ? '' : 's'} available</p>
          <div class="actions"><a class="btn btn-secondary btn-block" href="/products.html?category=${encodeURIComponent(c.name)}">Browse</a></div>
        </div>
      </article>`).join('') || '<div class="empty-state">Categories will appear once the catalogue syncs.</div>';
  } catch (err) {
    featured.innerHTML = '';
    alertHost.innerHTML = alertHtml(err.message || 'Could not load products.', 'error');
    toast('Could not load products.', 'error');
  }
}

loadHome();
