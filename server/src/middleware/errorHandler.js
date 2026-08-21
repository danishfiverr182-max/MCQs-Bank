import ApiError from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import env from '../config/env.js';

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let statusCode = 500;
  let message = 'Internal server error';
  let errors = [];

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    errors = err.errors || [];
  } else if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation failed';
    errors = Object.values(err.errors).map((e) => e.message);
  } else if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for field: ${err.path}`;
  } else if (err.code === 11000) {
    statusCode = 409;
    const fieldName = Object.keys(err.keyValue || {})[0] || 'field';
    message = `Duplicate value: ${fieldName} already exists`;
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token has expired';
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    statusCode = 400;
    message = 'File too large. Maximum size is 10MB';
  } else if (err instanceof SyntaxError && err.status === 400) {
    statusCode = 400;
    message = 'Invalid JSON in request body';
  } else if (env.IS_DEVELOPMENT) {
    // Preserve real message for unrecognised errors in development
    message = err.message || message;
  }

  // ─── Logging ────────────────────────────────────────────────────
  logger.error(req.method, req.originalUrl, statusCode, message);

  if (env.IS_DEVELOPMENT) {
    logger.error(err.stack);
  } else if (statusCode === 500) {
    logger.error(err.stack);
  }

  // ─── Response ───────────────────────────────────────────────────
  const responseBody = {
    success: false,
    statusCode,
    message,
    errors,
    timestamp: new Date().toISOString(),
  };

  if (env.IS_DEVELOPMENT) {
    responseBody.stack = err.stack;
  }

  if (env.IS_PRODUCTION && statusCode === 500) {
    responseBody.message = 'Internal server error';
  }

  res.status(statusCode).json(responseBody);
};

export default errorHandler;
