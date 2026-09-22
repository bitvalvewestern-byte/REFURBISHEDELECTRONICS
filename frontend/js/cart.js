/* Guest cart.
 *
 * IMPORTANT: localStorage holds ONLY { product_id, quantity } plus a cosmetic
 * display snapshot (name/image) used for instant rendering. Prices stored here
 * are NEVER treated as authoritative - the cart page re-reads live prices from
 * the backend and checkout sends only product ids + quantities. */

const KEY = 'ncs_cart_v1';

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((l) => l && typeof l.product_id === 'string' && l.product_id)
      .map((l) => ({
        product_id: l.product_id,
        quantity: Math.max(1, Math.min(parseInt(l.quantity, 10) || 1, 99)),
        snapshot: l.snapshot && typeof l.snapshot === 'object'
          ? { name: String(l.snapshot.name || ''), image: String(l.snapshot.image || ''), price: Number(l.snapshot.price) || 0 }
          : null
      }));
  } catch { return []; }
}

function write(lines) {
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* quota / private mode */ }
  document.dispatchEvent(new CustomEvent('cart:updated', { detail: { count: count() } }));
}

export function getLines() { return read(); }

export function count() {
  return read().reduce((n, l) => n + l.quantity, 0);
}

export function add(product, quantity = 1) {
  const qty = Math.max(1, parseInt(quantity, 10) || 1);
  const lines = read();
  const existing = lines.find((l) => l.product_id === product.id);
  if (existing) {
    existing.quantity = Math.min(existing.quantity + qty, 99);
    existing.snapshot = { name: product.name, image: product.image || '', price: product.selling_price };
  } else {
    lines.push({
      product_id: product.id,
      quantity: qty,
      snapshot: { name: product.name, image: product.image || '', price: product.selling_price }
    });
  }
  write(lines);
  return count();
}

export function setQuantity(productId, quantity) {
  const qty = parseInt(quantity, 10);
  const lines = read();
  const line = lines.find((l) => l.product_id === productId);
  if (!line) return count();
  if (qty <= 0) return remove(productId);
  line.quantity = Math.min(qty, 99);
  write(lines);
  return count();
}

export function remove(productId) {
  write(read().filter((l) => l.product_id !== productId));
  return count();
}

export function clear() { write([]); }

/** The minimal, price-free payload the backend expects. */
export function toOrderItems() {
  return read().map((l) => ({ product_id: l.product_id, quantity: l.quantity }));
}
