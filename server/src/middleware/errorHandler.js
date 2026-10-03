/**
 * Global Error Handler Middleware
 * Catches and formats errors consistently
 */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);

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
  const statusCode = err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';
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
  res.status(404);
  next(error);
};
