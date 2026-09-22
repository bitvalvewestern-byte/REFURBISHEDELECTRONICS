'use strict';

/**
 * Application error with a stable machine code and an HTTP status.
 * `publicMessage` is safe to return to a customer; `detail` is for logs only.
 */
class AppError extends Error {
  constructor(code, publicMessage, httpStatus = 400, detail = undefined) {
    super(publicMessage);
    this.name = 'AppError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

const badRequest = (code, msg, detail) => new AppError(code, msg, 400, detail);
const notFound = (code, msg, detail) => new AppError(code, msg, 404, detail);
const conflict = (code, msg, detail) => new AppError(code, msg, 409, detail);
const unauthorized = (code, msg, detail) => new AppError(code, msg, 401, detail);
const forbidden = (code, msg, detail) => new AppError(code, msg, 403, detail);
const tooMany = (code, msg, detail) => new AppError(code, msg, 429, detail);
const upstream = (code, msg, detail) => new AppError(code, msg, 502, detail);
const serverError = (code, msg, detail) => new AppError(code, msg, 500, detail);

module.exports = {
  AppError, badRequest, notFound, conflict, unauthorized,
  forbidden, tooMany, upstream, serverError
};
