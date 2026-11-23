import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  getForms,
  getForm,
  createForm,
  updateForm,
  deleteForm,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  reorderQuestions
} from '../controllers/formController.js';
import { withMutationScope } from '../middleware/quiescenceGate.js';
import { protect, optionalAuth } from '../middleware/authMiddleware.js';
import { validateObjectId } from '../middleware/validateObjectId.js';

const router = express.Router();

export const getFormRateLimitKey = (req) =>
  req?.user?._id?.toString() || req?.user?.id || (req?.ip ? ipKeyGenerator(req.ip) : 'unknown');

export const formCreationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.FORM_CREATION_RATE_LIMIT, 10) || 50,
  keyGenerator: getFormRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    const retryAfterHeader = res.getHeader('Retry-After');
    const retryAfter = retryAfterHeader
      ? parseInt(retryAfterHeader, 10)
      : Math.ceil(options.windowMs / 1000);
    const requestId = req?.id || req?.requestId;
    res.status(429).json({
      success: false,
      message: 'Too many forms created, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const formDeletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.FORM_DELETION_RATE_LIMIT, 10) || 30,
  keyGenerator: getFormRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    const retryAfterHeader = res.getHeader('Retry-After');
    const retryAfter = retryAfterHeader
      ? parseInt(retryAfterHeader, 10)
      : Math.ceil(options.windowMs / 1000);
    const requestId = req?.id || req?.requestId;
    res.status(429).json({
      success: false,
      message: 'Too many form deletion requests, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const formMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.FORM_MUTATION_RATE_LIMIT, 10) || 300,
  keyGenerator: getFormRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    const retryAfterHeader = res.getHeader('Retry-After');
    const retryAfter = retryAfterHeader
      ? parseInt(retryAfterHeader, 10)
      : Math.ceil(options.windowMs / 1000);
    const requestId = req?.id || req?.requestId;
    res.status(429).json({
      success: false,
      message: 'Too many form update operations, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const publicFormFetchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.PUBLIC_FORM_FETCH_RATE_LIMIT, 10) || 120,
  keyGenerator: (req) => (req?.ip ? ipKeyGenerator(req.ip) : 'unknown'),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    const retryAfterHeader = res.getHeader('Retry-After');
    const retryAfter = retryAfterHeader
      ? parseInt(retryAfterHeader, 10)
      : Math.ceil(options.windowMs / 1000);
    const requestId = req?.id || req?.requestId;
    res.status(429).json({
      success: false,
      message: 'Too many form view requests, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const userFormReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.USER_FORM_READ_RATE_LIMIT, 10) || 120,
  keyGenerator: getFormRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    const retryAfterHeader = res.getHeader('Retry-After');
    const retryAfter = retryAfterHeader
      ? parseInt(retryAfterHeader, 10)
      : Math.ceil(options.windowMs / 1000);
    const requestId = req?.id || req?.requestId;
    res.status(429).json({
      success: false,
      message: 'Too many form listing requests, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

// Form routes
router.get('/', protect, userFormReadLimiter, getForms);
router.post('/', protect, formCreationLimiter, withMutationScope(createForm));
router.get('/:id', validateObjectId('id'), publicFormFetchLimiter, optionalAuth, getForm);
router.put('/:id', protect, validateObjectId('id'), formMutationLimiter, withMutationScope(updateForm));
router.delete('/:id', protect, validateObjectId('id'), formDeletionLimiter, withMutationScope(deleteForm));

// Question routes
router.post('/:id/questions', protect, validateObjectId('id'), formMutationLimiter, withMutationScope(addQuestion));
router.put(
  '/:formId/questions/reorder',
  protect,
  validateObjectId('formId'),
  formMutationLimiter,
  withMutationScope(reorderQuestions)
);
router.put(
  '/:formId/questions/:questionId',
  protect,
  validateObjectId('formId', 'questionId'),
  formMutationLimiter,
  withMutationScope(updateQuestion)
);
router.delete(
  '/:formId/questions/:questionId',
  protect,
  validateObjectId('formId', 'questionId'),
  formMutationLimiter,
  withMutationScope(deleteQuestion)
);

export default router;
