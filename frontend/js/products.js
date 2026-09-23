import { apiFetch, esc, param, debounce } from './api.js';
import { renderHeader, renderFooter, productCardHtml, bindAddButtons, alertHtml, skeletonGrid } from './layout.js';

const state = {
  q: param('q') || '',
  category: param('category') || '',
  sort: param('sort') || 'name_asc',
  perPage: parseInt(param('per_page'), 10) || 36,
  inStock: param('in_stock') === '1' ? '1' : '',
  page: parseInt(param('page'), 10) || 1
};

renderHeader(state.category);
renderFooter();

const host = document.getElementById('products-host');
const alertHost = document.getElementById('listing-alert');
const countEl = document.getElementById('result-count');
const titleEl = document.getElementById('listing-title');
const catList = document.getElementById('cat-list');

/* Prefill controls from the URL */
document.getElementById('f-q').value = state.q;
document.getElementById('f-sort').value = state.sort;
document.getElementById('f-per').value = String(state.perPage);
document.getElementById('f-stock').value = state.inStock;

function syncUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (state.sort !== 'name_asc') p.set('sort', state.sort);
  if (state.perPage !== 36) p.set('per_page', String(state.perPage));
  if (state.inStock) p.set('in_stock', state.inStock);
  if (state.page > 1) p.set('page', String(state.page));
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
}

function paginationHtml(pg) {
  if (!pg || pg.total_pages <= 1) return '';
  const btns = [];
  btns.push(`<button type="button" data-page="${pg.page - 1}" ${pg.has_prev ? '' : 'disabled'} aria-label="Previous page">&laquo; Prev</button>`);
  const from = Math.max(1, pg.page - 2);
  const to = Math.min(pg.total_pages, from + 4);
  for (let i = from; i <= to; i += 1) {
    btns.push(`<button type="button" data-page="${i}" ${i === pg.page ? 'aria-current="true"' : ''}>${i}</button>`);
  }
  btns.push(`<button type="button" data-page="${pg.page + 1}" ${pg.has_next ? '' : 'disabled'} aria-label="Next page">Next &raquo;</button>`);
  return `<nav class="pagination" aria-label="Pagination">${btns.join('')}</nav>`;
}

async function loadCategories() {
  try {
    const res = await apiFetch('/products/categories');
    const cats = res.data || [];
    const all = `<li><a href="#" data-cat="" ${state.category ? '' : 'aria-current="true"'}>All products <span class="count">${cats.reduce((n, c) => n + c.count, 0)}</span></a></li>`;
    catList.innerHTML = all + cats.map((c) => `
      <li><a href="#" data-cat="${esc(c.name)}" ${state.category === c.name ? 'aria-current="true"' : ''}>
        ${esc(c.name)} <span class="count">${c.count}</span></a></li>`).join('');
  } catch {
    catList.innerHTML = '<li class="muted">Categories unavailable</li>';
  }
}

async function loadProducts() {
  host.innerHTML = skeletonGrid(Math.min(state.perPage, 12));
  countEl.textContent = 'Loading…';
  titleEl.textContent = state.category ? state.category : (state.q ? `Search: “${state.q}”` : 'All products');

  const p = new URLSearchParams({
    page: String(state.page),
    per_page: String(state.perPage),
    sort: state.sort
  });
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (state.inStock) p.set('in_stock', state.inStock);

  try {
    const res = await apiFetch(`/products?${p.toString()}`);
    const items = res.data || [];
    const byId = new Map(items.map((x) => [x.id, x]));

    if (!items.length) {
      host.innerHTML = '<div class="empty-state"><h2>No products found</h2><p>Try a different search term or clear the filters.</p></div>';
      countEl.textContent = '0 products';
      return;
    }

    host.innerHTML = `<div class="product-grid" id="grid">${items.map(productCardHtml).join('')}</div>${paginationHtml(res.pagination)}`;
    bindAddButtons(document.getElementById('grid'), byId);
    countEl.textContent = `${res.pagination.total} product${res.pagination.total === 1 ? '' : 's'} · page ${res.pagination.page} of ${res.pagination.total_pages}`;

    host.querySelectorAll('.pagination button[data-page]').forEach((b) => {
      b.addEventListener('click', () => {
        state.page = parseInt(b.dataset.page, 10);
        syncUrl(); loadProducts(); window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  } catch (err) {
    host.innerHTML = '';
    countEl.textContent = '';
    alertHost.innerHTML = alertHtml(err.message, 'error');
  }
}

/* ------------------------------ events ---------------------------- */
catList.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-cat]');
  if (!a) return;
  e.preventDefault();
  state.category = a.dataset.cat;
  state.page = 1;
  syncUrl(); loadCategories(); loadProducts();
});

document.getElementById('f-q').addEventListener('input', debounce((e) => {
  state.q = e.target.value.trim(); state.page = 1; syncUrl(); loadProducts();
}, 350));

document.getElementById('f-sort').addEventListener('change', (e) => {
  state.sort = e.target.value; state.page = 1; syncUrl(); loadProducts();
});
document.getElementById('f-per').addEventListener('change', (e) => {
  state.perPage = parseInt(e.target.value, 10) || 36; state.page = 1; syncUrl(); loadProducts();
});
document.getElementById('f-stock').addEventListener('change', (e) => {
  state.inStock = e.target.value; state.page = 1; syncUrl(); loadProducts();
});
document.getElementById('f-reset').addEventListener('click', () => {
  state.q = ''; state.category = ''; state.sort = 'name_asc'; state.perPage = 36; state.inStock = ''; state.page = 1;
  document.getElementById('f-q').value = '';
  document.getElementById('f-sort').value = 'name_asc';
  document.getElementById('f-per').value = '36';
  document.getElementById('f-stock').value = '';
  syncUrl(); loadCategories(); loadProducts();
});

loadCategories();
loadProducts();
