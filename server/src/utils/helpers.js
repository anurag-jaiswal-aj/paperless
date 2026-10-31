/**
 * Utility helper functions
 */

/**
 * Create error response object
 */
export const createError = (message, statusCode = 500) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

/**
 * Validate email format
 */
export const isValidEmail = (email) => {
  const re = /^\S+@\S+\.\S+$/;
  return re.test(email);
};

/**
 * Sanitize user input
 */
export const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input.trim();
};

/**
 * Generate random string
 */
export const generateRandomString = (length = 32) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/**
 * Format date for display
 */
export const formatDate = (date) => {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
};

/**
 * Sanitize request URL by redacting sensitive tokens in path or query string
 */
export const sanitizeRequestUrl = (url) => {
  if (typeof url !== 'string') return '';
  return url
    .replace(/\/reset-?password\/[a-zA-Z0-9_%~.-]+/gi, (match) => {
      const prefix = match.toLowerCase().startsWith('/reset-password') ? '/reset-password' : '/resetpassword';
      return `${prefix}/[REDACTED]`;
    })
    .replace(/([?&](?:token|resettoken|reset-token)=)[^&#\s]+/gi, '$1[REDACTED]');
};
