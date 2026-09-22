'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const config = require('./config');
const dbx = require('./db');
const productService = require('./services/productService');
const adminService = require('./services/adminService');
const { cors, enforceSameOrigin, globalLimiter, jsonBody } = require('./middleware/security');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

function createApp() {
  const app = express();

  if (config.security.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /* ---------- Security headers ---------- */
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],                 // no inline scripts in this build
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'], // product images come from the source
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.env === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false
  }));

  app.use(cors);
  app.use(cookieParser());
  app.use(globalLimiter);
  app.use(enforceSameOrigin);

  /* ---------- API ---------- */
  // Raw body for webhook signature verification MUST come before json parsing.
  app.use('/api/payment/webhook', express.raw({ type: '*/*', limit: '64kb' }));
  app.use('/api', jsonBody, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/admin', adminRoutes);
  app.use('/api', apiRoutes);

  /* ---------- Frontend ---------- */
  const frontendDir = config.paths.frontend;
  app.use(express.static(frontendDir, {
    index: 'index.html',
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    }
  }));

  app.get('/admin', (req, res) => res.sendFile(path.join(frontendDir, 'admin.html')));

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      'User-agent: *\nDisallow: /admin\nDisallow: /api/\n'
    );
  });

  /* ---------- 404 + errors ---------- */
  app.use('/api', notFoundHandler);
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html')) {
      return res.status(404).sendFile(path.join(frontendDir, '404.html'));
    }
    return next();
  });
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function bootstrap() {
  /* Config validation */
  const configErrors = config.assertRuntimeConfig();
  if (configErrors.length) {
    for (const e of configErrors) console.error(`[config] ${e}`);
    if (config.env === 'production') {
      console.error('[fatal] Refusing to start with an invalid production configuration.');
      process.exit(1);
    }
  }

  /* Seed editable delivery zones + admin account */
  dbx.seedDeliveryZones();
  const adminId = adminService.ensureAdminUser();
  if (!adminId) {
    console.warn('[admin] No admin credentials configured. Set ADMIN_USERNAME + ADMIN_PASSWORD_HASH ' +
      '(generate one with: npm run hash-password -- "StrongPassword") to enable /admin.');
  }

  /* Initial catalogue sync (non-fatal on failure - the cache keeps serving) */
  if (config.cache.syncOnBoot) {
    try {
      const result = await productService.syncProducts({ force: true });
      console.log(`[sync] catalogue loaded: ${result.count} product(s)` +
        (result.skipped ? `, ${result.skipped} record(s) skipped as unusable` : ''));
    } catch (err) {
      console.warn(`[sync] initial sync failed (${err.code || err.message}); serving cached catalogue.`);
    }
  }
  productService.startRefreshLoop();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`\nNairobi Computer Shop storefront backend`);
    console.log(`  env            : ${config.env}`);
    console.log(`  listening      : http://localhost:${config.port}`);
    console.log(`  frontend       : http://localhost:${config.port}/`);
    console.log(`  admin          : http://localhost:${config.port}/admin`);
    console.log(`  source driver  : ${config.source.driver}${config.source.driver === 'http' ? ` -> ${config.source.baseUrl}${config.source.productsPath}` : ''}`);
    console.log(`  price factor   : selling = source * ${config.pricing.factor}`);
    console.log(`  cors origins   : ${config.security.corsOrigins.length ? config.security.corsOrigins.join(', ') : '(same-origin only)'}\n`);
  });

  const shutdown = () => {
    console.log('\n[shutdown] closing server...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { app, server };
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('[fatal]', err);
    process.exit(1);
  });
}

module.exports = { createApp, bootstrap };
