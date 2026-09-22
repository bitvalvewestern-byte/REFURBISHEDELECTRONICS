'use strict';
const config = require('../config');
const { AppError, notFound } = require('../utils/errors');

function notFoundHandler(req, res, next) {
  next(notFound('NOT_FOUND', 'The requested resource was not found.'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isApp = err instanceof AppError;
  const status = isApp ? err.httpStatus : 500;

  // Log the real detail server-side; never send it to the browser.
  const logLine = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${status} ` +
    `${isApp ? err.code : 'INTERNAL_ERROR'}: ${err.message}` +
    (isApp && err.detail ? ` | detail=${err.detail}` : '') +
    (isApp ? '' : `\n${err.stack}`);
  console.error(logLine);

  const body = {
    error: {
      code: isApp ? err.code : 'INTERNAL_ERROR',
      message: isApp ? err.publicMessage : 'Something went wrong. Please try again.'
    }
  };
  if (config.env !== 'production' && !isApp) body.error.debug = err.message;
  if (isApp && err.detail && config.env !== 'production') body.error.detail = err.detail;

  res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
