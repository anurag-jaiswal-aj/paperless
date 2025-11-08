import express from 'express';
import {
  submitResponse,
  getResponses,
  getAnalytics,
  exportResponses,
  deleteResponse
} from '../controllers/responseController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Public route - submit response
router.post('/:formId', submitResponse);

// Protected routes - view/manage responses
router.get('/:formId', protect, getResponses);
router.get('/:formId/analytics', protect, getAnalytics);
router.get('/:formId/export', protect, exportResponses);
router.delete('/:formId/:responseId', protect, deleteResponse);

export default router;
