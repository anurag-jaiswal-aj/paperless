import fs from 'fs';

/**
 * Global Error Handler Middleware
 * Catches and formats errors consistently
 */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);

  // Clean up any pending temporary files from aborted uploads
  const filesToClean = req && (Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []));
  if (filesToClean && filesToClean.length > 0) {
    for (const f of filesToClean) {
      if (f.path && fs.existsSync(f.path)) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          // Ignore unlink errors during cleanup
        }
      }
    }
  }

  // Multer errors (file upload limits, invalid multipart)
  if (err.name === 'MulterError') {
    const maxFileSize = process.env.MAX_FILE_SIZE ? parseInt(process.env.MAX_FILE_SIZE, 10) : 5 * 1024 * 1024;
    const maxFiles = process.env.MAX_UPLOAD_FILES ? parseInt(process.env.MAX_UPLOAD_FILES, 10) : 10;
    const maxFields = process.env.MAX_UPLOAD_FIELDS ? parseInt(process.env.MAX_UPLOAD_FIELDS, 10) : 50;
    const maxParts = process.env.MAX_UPLOAD_PARTS ? parseInt(process.env.MAX_UPLOAD_PARTS, 10) : 60;

    const formattedSize = maxFileSize % (1024 * 1024) === 0
      ? `${maxFileSize / (1024 * 1024)}MB`
      : (maxFileSize >= 1024 * 1024
        ? `${Number((maxFileSize / (1024 * 1024)).toFixed(2))}MB`
        : (maxFileSize % 1024 === 0 ? `${maxFileSize / 1024}KB` : `${maxFileSize} bytes`));

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
      message
    });
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      message: 'Validation Error',
      errors: messages
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(400).json({
      success: false,
      message: `${field} already exists`
    });
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: 'Invalid resource ID'
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired'
    });
  }

  // AI Provider Errors
  if (err.message) {
    if (err.message === 'AI_RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ success: false, message: 'AI rate limit exceeded' });
    }
    if (['AI_PROVIDER_NOT_CONFIGURED', 'AI_PROVIDER_UNAVAILABLE', 'AI_TIMEOUT'].includes(err.message)) {
      return res.status(503).json({ success: false, message: 'AI service temporarily unavailable' });
    }
    if (['AI_INPUT_TOO_LARGE', 'AI_SCHEMA_VALIDATION_FAILED', 'AI_PROVIDER_REFUSAL', 'AI_INCOMPLETE_RESPONSE'].includes(err.message)) {
      return res.status(400).json({ success: false, message: 'Invalid AI request or response' });
    }
    if (err.message === 'AI_AUTH_FAILED') {
      return res.status(502).json({ success: false, message: 'AI provider authentication failed' });
    }
  }

  // Default error
  const statusCode = err.statusCode || (res.statusCode && res.statusCode >= 400 ? res.statusCode : 500);
  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
  const message = (isProduction && statusCode === 500) ? 'Internal Server Error' : (err.message || 'Server Error');

  res.status(statusCode).json({
    success: false,
    message,
    ...(!isProduction && { stack: err.stack })
  });
};

/**
 * 404 Not Found Handler
 */
export const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  error.statusCode = 404;
  res.status(404);
  next(error);
};
