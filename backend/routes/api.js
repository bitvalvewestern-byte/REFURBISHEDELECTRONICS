'use strict';
const express = require('express');
const asyncH = require('../utils/asyncH');
const productController = require('../controllers/productController');
const orderController = require('../controllers/orderController');
const paymentController = require('../controllers/paymentController');
const { orderLimiter, paymentLimiter } = require('../middleware/security');

const router = express.Router();

/* Catalogue --------------------------------------------------------- */
router.get('/products', asyncH(productController.list));
router.get('/products/categories', asyncH(productController.categories));
router.get('/products/:id', asyncH(productController.detail));
router.get('/delivery-zones', asyncH(productController.deliveryZones));
router.get('/health', asyncH(productController.health));

/* Orders ------------------------------------------------------------ */
router.post('/orders', orderLimiter, asyncH(orderController.create));
router.post('/orders/quote', orderLimiter, asyncH(orderController.quote));
router.get('/orders/:orderNumber', asyncH(orderController.show));

/* Payment ----------------------------------------------------------- */
router.post('/payment/create', paymentLimiter, asyncH(paymentController.create));
router.post('/payment/webhook', asyncH(paymentController.webhook));

module.exports = router;
