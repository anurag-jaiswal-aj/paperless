import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'crypto';
import Form from '../models/form.js';
import {
  submitResponse,
  getResponses,
  getAnalytics,
  exportResponses,
  deleteResponse,
  downloadResponseFile
} from '../controllers/responseController.js';
import { withMutationScope } from '../middleware/quiescenceGate.js';
import { protect } from '../middleware/authMiddleware.js';
import { validateObjectId } from '../middleware/validateObjectId.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

export const getSubmissionRateLimitKey = (req) => {
  const rawFormId = req.params?.formId;
  const isValidFormId = typeof rawFormId === 'string' && /^[0-9a-fA-F]{24}$/.test(rawFormId);
  const formKey = isValidFormId ? rawFormId : 'invalid';
  const ipKey = req.ip ? ipKeyGenerator(req.ip) : 'unknown';
  return `${formKey}:${ipKey}`;
};

export const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'test' ? 1000 : 50, // Limit each IP to 50 submissions per hour per form
  keyGenerator: getSubmissionRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many submissions from this IP, please try again later.' }
});

export const getAuthenticatedFormRateLimitKey = (req) => {
  const userKey = req.user?._id?.toString() || req.user?.id || 'anon';
  const rawFormId = req.params?.formId;
  const isValidFormId = typeof rawFormId === 'string' && /^[0-9a-fA-F]{24}$/.test(rawFormId);
  const formKey = isValidFormId ? rawFormId : 'invalid';
  const ipKey = req.ip ? ipKeyGenerator(req.ip) : 'unknown';
  return `${userKey}:${formKey}:${ipKey}`;
};

export const getUserRateLimitKey = (req) =>
  req.user?._id?.toString() || req.user?.id || (req.ip ? ipKeyGenerator(req.ip) : 'anon');

export const userAnalyticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.USER_ANALYTICS_RATE_LIMIT, 10) || 120,
  keyGenerator: getUserRateLimitKey,
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
      message: 'Too many analytics requests across account, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const analyticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test' ? 10000 : parseInt(process.env.ANALYTICS_RATE_LIMIT, 10) || 60,
  keyGenerator: getAuthenticatedFormRateLimitKey,
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
      message: 'Too many analytics requests, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const userExportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.USER_EXPORT_RATE_LIMIT, 10) || 60,
  keyGenerator: getUserRateLimitKey,
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
      message: 'Too many export requests across account, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 10000 : parseInt(process.env.EXPORT_RATE_LIMIT, 10) || 30,
  keyGenerator: getAuthenticatedFormRateLimitKey,
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
      message: 'Too many export requests, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const responseDeletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.RESPONSE_DELETION_RATE_LIMIT, 10) || 100,
  keyGenerator: getUserRateLimitKey,
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
      message: 'Too many response deletions, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const userResponseReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.RESPONSE_READ_RATE_LIMIT, 10) || 120,
  keyGenerator: getUserRateLimitKey,
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
      message: 'Too many response read requests, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

export const userFileDownloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max:
    process.env.NODE_ENV === 'test'
      ? 10000
      : parseInt(process.env.FILE_DOWNLOAD_RATE_LIMIT, 10) || 60,
  keyGenerator: getUserRateLimitKey,
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
      message: 'Too many file download requests, please try again later.',
      retryAfter,
      ...(requestId ? { requestId } : {})
    });
  }
});

import multer from 'multer';
import os from 'os';
import path from 'path';
import { cleanupRequestTempFiles } from '../utils/fileCleanup.js';

export { cleanupRequestTempFiles };

export const maxUploadFileSize = process.env.MAX_FILE_SIZE
  ? parseInt(process.env.MAX_FILE_SIZE, 10)
  : 5 * 1024 * 1024; // 5MB default
export const maxUploadFiles = process.env.MAX_UPLOAD_FILES
  ? parseInt(process.env.MAX_UPLOAD_FILES, 10)
  : 10;
export const maxUploadFields = process.env.MAX_UPLOAD_FIELDS
  ? parseInt(process.env.MAX_UPLOAD_FIELDS, 10)
  : 50;
export const maxUploadParts = process.env.MAX_UPLOAD_PARTS
  ? parseInt(process.env.MAX_UPLOAD_PARTS, 10)
  : 60;

/**
 * Format byte count accurately without misleading down-rounding.
 */
export const formatFileSize = (bytes) => {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes <= 0) return '5MB';
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)}MB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Number((bytes / (1024 * 1024)).toFixed(2))}MB`;
  }
  if (bytes % 1024 === 0) {
    return `${bytes / 1024}KB`;
  }
  if (bytes >= 1024) {
    return `${Number((bytes / 1024).toFixed(2))}KB`;
  }
  return `${bytes} bytes`;
};

/**
 * Generate client-facing Multer error messages consistent with effective limits.
 */
export const getMulterErrorMessage = (err, limits = {}) => {
  const fileSize = limits.fileSize ?? upload.limits?.fileSize ?? maxUploadFileSize;
  const files = limits.files ?? upload.limits?.files ?? maxUploadFiles;
  const fields = limits.fields ?? upload.limits?.fields ?? maxUploadFields;
  const parts = limits.parts ?? upload.limits?.parts ?? maxUploadParts;

  if (err.code === 'LIMIT_FILE_SIZE') {
    return `File size exceeds maximum limit of ${formatFileSize(fileSize)}`;
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return `Too many files uploaded (maximum ${files} allowed)`;
  }
  if (err.code === 'LIMIT_FIELD_COUNT') {
    return `Too many form fields (maximum ${fields} allowed)`;
  }
  if (err.code === 'LIMIT_PART_COUNT') {
    return `Too many multipart parts (maximum ${parts} allowed)`;
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return 'Unexpected file field';
  }
  return 'File upload error';
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, os.tmpdir());
  },
  filename: (req, file, cb) => {
    // Generate opaque unique filename to prevent path traversal via user-supplied fieldname
    const randomId = crypto.randomUUID();
    const filename = `upload-${randomId}.tmp`;
    if (!req._trackedTempFiles) {
      req._trackedTempFiles = new Set();
    }
    const fullPath = path.join(os.tmpdir(), filename);
    req._trackedTempFiles.add(fullPath);
    cb(null, filename);
  }
});

export const upload = multer({
  storage,
  limits: {
    fileSize: maxUploadFileSize,
    files: maxUploadFiles,
    fields: maxUploadFields,
    parts: maxUploadParts
  }
});

/**
 * Factory to create a middleware wrapper for Multer to enforce multipart boundaries,
 * clean up temporary files immediately upon rejection, client abort, or connection close,
 * and return clear, sanitized HTTP 400 responses without leaking internal paths.
 */
export const createMultipartUploadHandler =
  (uploadInstance = upload) =>
  (req, res, next) => {
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      cleanupRequestTempFiles(req);
    };

    // Register abort and close listeners to clean up temporary files if client disconnects
    const onAbort = () => {
      cleanup();
    };
    const onClose = () => {
      if (!req.complete) {
        cleanup();
      }
    };

    req.on('aborted', onAbort);
    req.on('close', onClose);

    uploadInstance.any()(req, res, (err) => {
      req.removeListener('aborted', onAbort);
      req.removeListener('close', onClose);

      if (err) {
        cleanup();

        if (err instanceof multer.MulterError || err.name === 'MulterError') {
          const message = getMulterErrorMessage(err, uploadInstance.limits);
          return res.status(400).json({
            success: false,
            message
          });
        }

        // Distinguish invalid client uploads from unexpected internal failures
        const isClientError =
          (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) ||
          (err.status && err.status >= 400 && err.status < 500) ||
          /boundary|malformed|unexpected end|bad request/i.test(err.message || '');

        if (isClientError) {
          logger.warn('upload.multipart_client_error', { reason: err.message, requestId: req.id });
          return res.status(400).json({
            success: false,
            message: 'Invalid upload request'
          });
        }

        // Unexpected internal failure: preserve centralized logging and sanitization
        return next(err);
      }
      next();
    });
  };

export const handleMultipartUpload = createMultipartUploadHandler(upload);

/**
 * Pre-validation middleware for response submission.
 * Validates form identifier syntax, verifies form existence, and confirms
 * published status prior to expensive multipart stream ingestion and disk writing.
 */
export const preValidateSubmissionForm = async (req, res, next) => {
  const formId = req.params?.formId;
  const requestId = req.id || req.requestId;
  if (!formId || typeof formId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(formId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid resource ID',
      ...(requestId ? { requestId } : {})
    });
  }

  try {
    const form = await Form.findById(formId);
    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found',
        ...(requestId ? { requestId } : {})
      });
    }
    if (['deleting', 'delete_failed'].includes(form.status)) {
      return res.status(409).json({
        success: false,
        message: 'Form is currently being deleted',
        ...(requestId ? { requestId } : {})
      });
    }
    if (form.status !== 'published') {
      return res.status(403).json({
        success: false,
        message: 'This form is not accepting responses',
        ...(requestId ? { requestId } : {})
      });
    }
    req.targetForm = form;
    next();
  } catch (err) {
    next(err);
  }
};

// Public route - submit response
router.post(
  '/:formId',
  validateObjectId('formId'),
  submissionLimiter,
  preValidateSubmissionForm,
  handleMultipartUpload,
  withMutationScope(submitResponse)
);

// Protected routes - view/manage responses
router.get('/:formId', protect, validateObjectId('formId'), userResponseReadLimiter, getResponses);
router.get(
  '/:formId/analytics',
  protect,
  validateObjectId('formId'),
  userAnalyticsLimiter,
  analyticsLimiter,
  getAnalytics
);
router.get(
  '/:formId/export',
  protect,
  validateObjectId('formId'),
  userExportLimiter,
  exportLimiter,
  exportResponses
);
router.get(
  '/:formId/:responseId/file/:questionId',
  protect,
  validateObjectId('formId', 'responseId', 'questionId'),
  userFileDownloadLimiter,
  downloadResponseFile
);
router.delete(
  '/:formId/:responseId',
  protect,
  validateObjectId('formId', 'responseId'),
  responseDeletionLimiter,
  withMutationScope(deleteResponse)
);

export default router;
