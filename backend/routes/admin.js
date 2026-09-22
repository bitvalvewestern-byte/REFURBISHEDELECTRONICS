'use strict';
const express = require('express');
const asyncH = require('../utils/asyncH');
const adminController = require('../controllers/adminController');
const { requireAdmin, requireCsrf } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/security');

const router = express.Router();

/* Public auth endpoints --------------------------------------------- */
router.post('/login', loginLimiter, asyncH(adminController.login));

/* Everything below requires an authenticated admin session ---------- */
router.use(requireAdmin);

router.get('/me', asyncH(adminController.me));
router.post('/logout', asyncH(adminController.logout));
router.get('/stats', asyncH(adminController.stats));

router.get('/products', asyncH(adminController.listProducts));
router.post('/catalogue/sync', requireCsrf, asyncH(adminController.triggerSync));

router.get('/orders', asyncH(adminController.listOrders));
router.get('/orders/:orderNumber', asyncH(adminController.getOrder));
router.patch('/orders/:orderNumber/status', requireCsrf, asyncH(adminController.updateOrderStatus));
router.patch('/orders/:orderNumber/payment-status', requireCsrf, asyncH(adminController.updatePaymentStatus));

router.get('/audit', asyncH(adminController.auditLog));

module.exports = router;
