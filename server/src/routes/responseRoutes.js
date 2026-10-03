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
  max: 50, // Limit each IP to 50 submissions per hour
  message: { success: false, message: 'Too many submissions from this IP, please try again later.' }
});

import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: process.env.MAX_FILE_SIZE ? parseInt(process.env.MAX_FILE_SIZE, 10) : 5 * 1024 * 1024, // 5MB default
  }
});

// Public route - submit response
router.post('/:formId', submissionLimiter, upload.any(), submitResponse);

// Protected routes - view/manage responses
router.get('/:formId', protect, getResponses);
router.get('/:formId/analytics', protect, getAnalytics);
router.get('/:formId/export', protect, exportResponses);
router.get('/:formId/:responseId/file/:questionId', protect, downloadResponseFile);
router.delete('/:formId/:responseId', protect, deleteResponse);

export default router;
