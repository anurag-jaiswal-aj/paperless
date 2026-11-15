/**
 * Route parameter validation middleware for MongoDB ObjectIds.
 * Ensures route parameters are valid 24-character hexadecimal strings
 * before requests reach controllers or database operations.
 */

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * Checks whether a given value is a valid 24-character hexadecimal ObjectId string.
 *
 * @param {*} id - Value to test
 * @returns {boolean} True if id is a valid 24-hex string
 */
export const isValidObjectId = (id) => {
  return typeof id === 'string' && OBJECT_ID_REGEX.test(id);
};

/**
 * Express middleware factory to validate one or more route parameters as 24-hex ObjectIds.
 * Rejects malformed IDs with HTTP 400 Bad Request and the canonical error envelope.
 *
 * @param {...string} paramNames - Parameter name(s) to validate (e.g., 'id', 'formId', 'questionId')
 * @returns {import('express').RequestHandler}
 */
export const validateObjectId = (...paramNames) => {
  const names = paramNames.flat();
  return (req, res, next) => {
    for (const name of names) {
      const val = req.params?.[name];
      if (!isValidObjectId(val)) {
        const requestId = req.id || req.requestId;
        return res.status(400).json({
          success: false,
          message: 'Invalid resource ID',
          ...(requestId ? { requestId } : {})
        });
      }
    }
    next();
  };
};
