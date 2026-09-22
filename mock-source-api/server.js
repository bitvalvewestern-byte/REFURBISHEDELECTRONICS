'use strict';
/**
 * TEST DOUBLE for the authorized source API.
 *
 * It deliberately behaves like a protected upstream:
 *   - requires Authorization: Bearer <key>
 *   - supports ?page= & ?per_page= pagination
 *   - leaks nothing about the storefront, and returns a NON-normalised shape
 *     so the mapping/normalisation layer in the backend is genuinely exercised.
 *
 * Run:  node mock-source-api/server.js
 * Key:  controlled by MOCK_SOURCE_API_KEY (default: mock-source-key-123)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = parseInt(process.env.MOCK_SOURCE_PORT || '9099', 10);
const API_KEY = process.env.MOCK_SOURCE_API_KEY || 'mock-source-key-123';
const DATA_FILE = path.join(__dirname, 'products.json');

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/products') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== API_KEY) {
      // Realistic upstream behaviour: 401 with a terse body.
      return send(res, 401, { error: 'invalid_api_key', message: 'Authentication credentials were not provided.' });
    }

    let dataset;
    try {
      dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (err) {
      return send(res, 500, { error: 'source_unavailable', message: err.message });
    }

    const all = dataset.data || [];
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10), 1);
    const perPage = Math.min(Math.max(parseInt(url.searchParams.get('per_page') || '100', 10), 1), 100);
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));

    return send(res, 200, {
      meta: { page, per_page: perPage, total: all.length, total_pages: totalPages },
      data: slice
    });
  }

  if (url.pathname === '/health') return send(res, 200, { status: 'ok' });

  return send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`[mock-source-api] listening on http://localhost:${PORT}/products  (Bearer ${API_KEY})`);
});
