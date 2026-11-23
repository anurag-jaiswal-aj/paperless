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
import { withMutationScope } from '../middleware/quiescenceGate.js';
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

router.post('/questions/generate', withMutationScope(generateQuestionsHandler));
router.post('/writing/improve', withMutationScope(improveWritingHandler));
router.post('/consultant/:formId', validateObjectId('formId'), withMutationScope(consultantHandler));

// Phase 7: Response Intelligence
router.post('/responses/summary/:formId', validateObjectId('formId'), withMutationScope(responseSummaryHandler));
router.post('/responses/themes/:formId', validateObjectId('formId'), withMutationScope(responseThemesHandler));
router.post('/responses/categorize/:formId', validateObjectId('formId'), withMutationScope(responseCategorizeHandler));

// Phase 5 legacy for regression tests
router.post('/summary/:formId', validateObjectId('formId'), withMutationScope(summaryHandler));
// Map legacy paths if frontend still uses them during transition
router.post('/suggest', withMutationScope(generateQuestionsHandler));
router.post('/improve', withMutationScope(improveWritingHandler));

export default router;
