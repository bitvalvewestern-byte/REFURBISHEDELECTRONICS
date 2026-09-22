'use strict';
const productService = require('../services/productService');
const orderService = require('../services/orderService');

/** GET /api/products */
async function list(req, res) {
  productService.maybeRefreshInBackground();
  const result = productService.listProducts({
    search: req.query.q || req.query.search,
    category: req.query.category,
    sort: req.query.sort,
    page: req.query.page,
    perPage: req.query.per_page || req.query.perPage,
    inStockOnly: ['1', 'true'].includes(String(req.query.in_stock || '').toLowerCase())
  });
  res.json({
    data: result.items,
    pagination: result.pagination,
    meta: { currency: require('../config').pricing.currency, selling_price_factor: undefined }
  });
}

/** GET /api/products/categories */
async function categories(req, res) {
  res.json({ data: productService.listCategories() });
}

/** GET /api/products/:id */
async function detail(req, res) {
  productService.maybeRefreshInBackground();
  res.json({ data: productService.getPublicProduct(req.params.id) });
}

/** GET /api/delivery-zones - lets the checkout form show the correct fee. */
async function deliveryZones(req, res) {
  res.json({
    data: orderService.listDeliveryZones().map((z) => ({
      id: z.id, label: z.label, fee: z.fee, is_default: !!z.is_default
    })),
    meta: { currency: require('../config').pricing.currency }
  });
}

/** GET /api/health */
async function health(req, res) {
  const state = productService.getSyncState();
  res.json({
    status: 'ok',
    catalogue: {
      last_sync_at: state.last_sync_at,
      last_status: state.last_status,
      items: state.item_count
    }
  });
}

module.exports = { list, categories, detail, deliveryZones, health };
