import express from 'express';
import {
  suggestQuestionsHandler,
  improveWordingHandler,
  summaryHandler
} from '../controllers/aiController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// All AI routes require authentication
router.post('/suggest', protect, suggestQuestionsHandler);
router.post('/improve', protect, improveWordingHandler);
router.post('/summary/:formId', protect, summaryHandler);

export default router;
