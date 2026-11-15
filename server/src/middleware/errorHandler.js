import { cleanupRequestTempFiles } from '../utils/fileCleanup.js';
import { sanitizeRequestUrl } from '../utils/redactionPolicy.js';
import { logger } from '../utils/logger.js';
import { getRequestId } from './requestCorrelation.js';

/**
 * Resolves the HTTP status code for an error based on explicit property or error category.
 *
 * @param {Error} err - Error object
 * @param {Object} res - Express response object
 * @returns {number} HTTP status code
 */
function resolveErrorStatusCode(err, res) {
  if (err?.statusCode && typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  if (err?.status && typeof err.status === 'number') {
    return err.status;
  }
  if (
    err?.name === 'ValidationError' ||
    err?.name === 'CastError' ||
    err?.name === 'MulterError' ||
    err?.code === 11000
  ) {
    return 400;
  }
  if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
    return 401;
  }
  if (err?.message === 'AI_RATE_LIMIT_EXCEEDED') {
    return 429;
  }
  if (
    [
      'AI_INPUT_TOO_LARGE',
      'AI_SCHEMA_VALIDATION_FAILED',
      'AI_PROVIDER_REFUSAL',
      'AI_INCOMPLETE_RESPONSE'
    ].includes(err?.message)
  ) {
    return 400;
  }
  if (err?.message === 'AI_AUTH_FAILED') {
    return 502;
  }
  if (
    ['AI_PROVIDER_NOT_CONFIGURED', 'AI_PROVIDER_UNAVAILABLE', 'AI_TIMEOUT'].includes(err?.message)
  ) {
    return 503;
  }
  if (res?.statusCode && res.statusCode >= 400) {
    return res.statusCode;
  }
  return 500;
}

/**
 * Global Error Handler Middleware
 * Catches and formats errors consistently
 */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const requestId =
    req?.id || req?.requestId || (typeof getRequestId === 'function' ? getRequestId() : undefined);
  const statusCode = resolveErrorStatusCode(err, res);

  // Structured logging of application error
  if (statusCode >= 500) {
    logger.error(err, {
      requestId,
      method: req?.method,
      path: req?.originalUrl ? sanitizeRequestUrl(req.originalUrl) : undefined,
      statusCode
    });
  } else {
    logger.warn(err.message || 'Client error', {
      requestId,
      method: req?.method,
      path: req?.originalUrl ? sanitizeRequestUrl(req.originalUrl) : undefined,
      statusCode,
      errorName: err.name
    });
  }

  // Clean up any pending temporary files from aborted uploads
  cleanupRequestTempFiles(req);

  // Multer errors (file upload limits, invalid multipart)
  if (err.name === 'MulterError') {
    const maxFileSize = process.env.MAX_FILE_SIZE
      ? parseInt(process.env.MAX_FILE_SIZE, 10)
      : 5 * 1024 * 1024;
    const maxFiles = process.env.MAX_UPLOAD_FILES ? parseInt(process.env.MAX_UPLOAD_FILES, 10) : 10;
    const maxFields = process.env.MAX_UPLOAD_FIELDS
      ? parseInt(process.env.MAX_UPLOAD_FIELDS, 10)
      : 50;
    const maxParts = process.env.MAX_UPLOAD_PARTS ? parseInt(process.env.MAX_UPLOAD_PARTS, 10) : 60;

    const formattedSize =
      maxFileSize % (1024 * 1024) === 0
        ? `${maxFileSize / (1024 * 1024)}MB`
        : maxFileSize >= 1024 * 1024
          ? `${Number((maxFileSize / (1024 * 1024)).toFixed(2))}MB`
          : maxFileSize % 1024 === 0
            ? `${maxFileSize / 1024}KB`
            : `${maxFileSize} bytes`;

    let message = 'File upload error';
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = `File size exceeds maximum limit of ${formattedSize}`;
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      message = `Too many files uploaded (maximum ${maxFiles} allowed)`;
    } else if (err.code === 'LIMIT_FIELD_COUNT') {
      message = `Too many form fields (maximum ${maxFields} allowed)`;
    } else if (err.code === 'LIMIT_PART_COUNT') {
      message = `Too many multipart parts (maximum ${maxParts} allowed)`;
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Unexpected file field';
    }
    return res.status(400).json({
      success: false,
      message,
      ...(requestId ? { requestId } : {})
    });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      message: 'Validation Error',
      errors: messages,
      ...(requestId ? { requestId } : {})
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(400).json({
      success: false,
      message: `${field} already exists`,
      ...(requestId ? { requestId } : {})
    });
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: 'Invalid resource ID',
      ...(requestId ? { requestId } : {})
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
      ...(requestId ? { requestId } : {})
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired',
      ...(requestId ? { requestId } : {})
    });
  }

  // AI Provider Errors
  if (err.message) {
    if (err.message === 'AI_RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({
        success: false,
        message: 'AI rate limit exceeded',
        ...(requestId ? { requestId } : {})
      });
    }
    if (
      ['AI_PROVIDER_NOT_CONFIGURED', 'AI_PROVIDER_UNAVAILABLE', 'AI_TIMEOUT'].includes(err.message)
    ) {
      return res.status(503).json({
        success: false,
        message: 'AI service temporarily unavailable',
        ...(requestId ? { requestId } : {})
      });
    }
    if (
      [
        'AI_INPUT_TOO_LARGE',
        'AI_SCHEMA_VALIDATION_FAILED',
        'AI_PROVIDER_REFUSAL',
        'AI_INCOMPLETE_RESPONSE'
      ].includes(err.message)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid AI request or response',
        ...(requestId ? { requestId } : {})
      });
    }
    if (err.message === 'AI_AUTH_FAILED') {
      return res.status(502).json({
        success: false,
        message: 'AI provider authentication failed',
        ...(requestId ? { requestId } : {})
      });
    }
  }

  // Default error
  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
  const message =
    isProduction && statusCode === 500 ? 'Internal Server Error' : err.message || 'Server Error';

  res.status(statusCode).json({
    success: false,
    message,
    ...(requestId ? { requestId } : {}),
    ...(!isProduction && { stack: err.stack })
  });
};

/**
 * 404 Not Found Handler
 * Strips query parameters and hash fragments to prevent credential reflection (NBN-425-01 / API-06)
 * while preserving sanitized route path segments.
 */
export const notFound = (req, res, next) => {
  const rawPath = (req?.originalUrl || req?.url || '').split(/[?#]/)[0];
  const safePath = sanitizeRequestUrl(rawPath);
  const error = new Error(`Not Found - ${safePath}`);
  error.statusCode = 404;
  res.status(404);
  next(error);
};
