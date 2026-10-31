import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  submitResponse,
  getResponses,
  getAnalytics,
  exportResponses,
  deleteResponse,
  downloadResponseFile
} from '../controllers/responseController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'test' ? 1000 : 50, // Limit each IP to 50 submissions per hour (elevated in test suite)
  message: { success: false, message: 'Too many submissions from this IP, please try again later.' }
});

import multer from 'multer';
import os from 'os';
import fs from 'fs';

export const maxUploadFileSize = process.env.MAX_FILE_SIZE ? parseInt(process.env.MAX_FILE_SIZE, 10) : 5 * 1024 * 1024; // 5MB default
export const maxUploadFiles = process.env.MAX_UPLOAD_FILES ? parseInt(process.env.MAX_UPLOAD_FILES, 10) : 10;
export const maxUploadFields = process.env.MAX_UPLOAD_FIELDS ? parseInt(process.env.MAX_UPLOAD_FIELDS, 10) : 50;
export const maxUploadParts = process.env.MAX_UPLOAD_PARTS ? parseInt(process.env.MAX_UPLOAD_PARTS, 10) : 60;

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

export const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: maxUploadFileSize,
    files: maxUploadFiles,
    fields: maxUploadFields,
    parts: maxUploadParts
  }
});

/**
 * Factory to create a middleware wrapper for Multer to enforce multipart boundaries,
 * clean up temporary files immediately upon rejection,
 * and return clear, sanitized HTTP 400 responses without leaking internal paths.
 */
export const createMultipartUploadHandler = (uploadInstance = upload) => (req, res, next) => {
  uploadInstance.any()(req, res, (err) => {
    if (err) {
      // Clean up temporary files written before the limit error was encountered
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
        console.error('Multipart upload client error:', err.message);
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

// Public route - submit response
router.post('/:formId', submissionLimiter, handleMultipartUpload, submitResponse);

// Protected routes - view/manage responses
router.get('/:formId', protect, getResponses);
router.get('/:formId/analytics', protect, getAnalytics);
router.get('/:formId/export', protect, exportResponses);
router.get('/:formId/:responseId/file/:questionId', protect, downloadResponseFile);
router.delete('/:formId/:responseId', protect, deleteResponse);

export default router;
