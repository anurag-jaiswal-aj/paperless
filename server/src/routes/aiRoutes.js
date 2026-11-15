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
import { validateObjectId } from '../middleware/validateObjectId.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const router = express.Router();

export const getAiRateLimitKey = (req) =>
  req?.user?._id?.toString() || (req?.ip ? ipKeyGenerator(req.ip) : 'unknown');

export const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.AI_RATE_LIMIT, 10) || 20, // 20 requests per 15 minutes by default
  keyGenerator: getAiRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'AI rate limit exceeded. Please try again later.' }
});

// All AI routes require authentication and rate limiting
router.use(protect, aiLimiter);

router.post('/questions/generate', generateQuestionsHandler);
router.post('/writing/improve', improveWritingHandler);
router.post('/consultant/:formId', validateObjectId('formId'), consultantHandler);

// Phase 7: Response Intelligence
router.post('/responses/summary/:formId', validateObjectId('formId'), responseSummaryHandler);
router.post('/responses/themes/:formId', validateObjectId('formId'), responseThemesHandler);
router.post('/responses/categorize/:formId', validateObjectId('formId'), responseCategorizeHandler);

// Phase 5 legacy for regression tests
router.post('/summary/:formId', validateObjectId('formId'), summaryHandler);
// Map legacy paths if frontend still uses them during transition
router.post('/suggest', generateQuestionsHandler);
router.post('/improve', improveWritingHandler);

export default router;
