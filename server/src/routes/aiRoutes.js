import express from 'express';
import {
  generateQuestionsHandler,
  improveWritingHandler,
  consultantHandler,
  summaryHandler,
  responseSummaryHandler,
  responseThemesHandler,
  responseCategorizeHandler
} from '../controllers/aiController.js';
import { protect } from '../middleware/authMiddleware.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.AI_RATE_LIMIT, 10) || 20, // 20 requests per 15 minutes by default
  message: { success: false, message: 'AI rate limit exceeded. Please try again later.' }
});

// All AI routes require authentication and rate limiting
router.use(protect, aiLimiter);

router.post('/questions/generate', generateQuestionsHandler);
router.post('/writing/improve', improveWritingHandler);
router.post('/consultant/:formId', consultantHandler);

// Phase 7: Response Intelligence
router.post('/responses/summary/:formId', responseSummaryHandler);
router.post('/responses/themes/:formId', responseThemesHandler);
router.post('/responses/categorize/:formId', responseCategorizeHandler);

// Phase 5 legacy for regression tests
router.post('/summary/:formId', summaryHandler);
// Map legacy paths if frontend still uses them during transition
router.post('/suggest', generateQuestionsHandler);
router.post('/improve', improveWritingHandler);

export default router;
