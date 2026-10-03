import AIService from '../services/AIService.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';

// Helper to apply Paperless domain rules to generated questions
const sanitizeQuestions = (questions, existingLabels = []) => {
  const sanitized = [];
  const normalizedExisting = new Set(existingLabels.map(l => l.toLowerCase().trim()));
  const seenLabels = new Set();

  for (const q of questions) {
    if (sanitized.length >= 20) break; // Hard limit

    const label = q.label?.trim();
    if (!label) continue;
    if (label.length > 500) continue; // enforce question label limits

    const normLabel = label.toLowerCase();
    if (normalizedExisting.has(normLabel) || seenLabels.has(normLabel)) continue;

    seenLabels.add(normLabel);

    // Apply type rules
    let options = [];
    if (['single_choice', 'multiple_choice', 'dropdown'].includes(q.type)) {
      if (q.options && Array.isArray(q.options)) {
        options = [...new Set(q.options.map(o => o.trim()).filter(o => o.length > 0))];
      }
      if (options.length < 2) continue; // Invalid choice question
    }

    sanitized.push({
      type: q.type,
      label,
      description: q.description || '',
      required: !!q.required,
      options
    });
  }

  return sanitized;
};

/**
 * @route   POST /api/ai/questions/generate
 * @desc    Generate questions for a form
 * @access  Private
 */
export const generateQuestionsHandler = async (req, res, next) => {
  try {
    const { topic, count, audience, formId } = req.body;

    if (!topic || typeof topic !== 'string' || topic.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Topic is required' });
    }

    if (topic.length > 1000) {
      return res.status(400).json({ success: false, message: 'Topic is too long' });
    }

    let clampedCount = parseInt(count, 10);
    if (isNaN(clampedCount) || clampedCount < 1) clampedCount = 5;
    if (clampedCount > 20) clampedCount = 20;

    let formContext = null;
    let existingLabels = [];
    if (formId) {
      const form = await Form.findById(formId);
      if (form && form.ownerId.toString() === req.user.id) {
        const questions = await Question.find({ formId }).sort({ order: 1 });
        existingLabels = questions.map(q => q.label);
        formContext = {
          title: form.title,
          description: form.description,
          existingQuestionLabels: existingLabels,
          existingQuestionTypes: questions.map(q => q.type)
        };
      }
    }

    const aiQuestions = await AIService.generateQuestions({
      topic: topic.trim(),
      count: clampedCount,
      audience: audience ? String(audience).substring(0, 500) : undefined,
      formContext
    });

    const validatedQuestions = sanitizeQuestions(aiQuestions, existingLabels);

    res.status(200).json({
      success: true,
      data: validatedQuestions
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/ai/writing/improve
 * @desc    Improve text phrasing
 * @access  Private
 */
export const improveWritingHandler = async (req, res, next) => {
  try {
    const { text, contentType, context } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Text is required' });
    }

    if (text.length > 2000) {
      return res.status(400).json({ success: false, message: 'Text is too long' });
    }

    const validTypes = ['question', 'description', 'title'];
    if (!validTypes.includes(contentType)) {
      return res.status(400).json({ success: false, message: 'Invalid contentType' });
    }

    const improvement = await AIService.improveWriting({
      text: text.trim(),
      contentType,
      context: context ? String(context).substring(0, 1000) : undefined
    });

    res.status(200).json({
      success: true,
      data: improvement
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/ai/consultant/:formId
 * @desc    Form design consultant
 * @access  Private (owner only)
 */
export const consultantHandler = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);

    if (!form) {
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    // Check ownership
    if (form.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this form' });
    }

    const questions = await Question.find({ formId: form._id }).sort({ order: 1 });

    const formPayload = {
      title: form.title,
      description: form.description,
      questions: questions.map(q => ({
        id: q._id,
        type: q.type,
        label: q.label,
        required: q.required,
        options: q.options,
        validation: q.validation
      }))
    };

    const consultantResult = await AIService.consultForm(formPayload);

    // Verify recommendations to ensure questionReferences actually exist
    const validRecommendations = consultantResult.recommendations.map(rec => {
      let ref = rec.questionReference;
      if (ref) {
        // Find if this ref matches an ID or a Label in the current form
        const matched = questions.find(q => q._id.toString() === ref || q.label.includes(ref));
        if (matched) {
          ref = matched._id.toString();
        } else {
          ref = undefined;
        }
      }
      return { ...rec, questionReference: ref };
    });

    res.status(200).json({
      success: true,
      data: {
        overallAssessment: consultantResult.overallAssessment,
        recommendations: validRecommendations
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/ai/summary/:formId
 * @desc    Phase 5 Legacy - Generate AI summary of form responses
 * @access  Private (owner only)
 */
export const summaryHandler = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);

    if (!form) {
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    // Check ownership
    if (form.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this form' });
    }

    const summary = await AIService.summarizeResponses({
      formTitle: form.title,
      formId: req.params.formId
    });

    res.status(200).json({
      success: true,
      data: { summary }
    });
  } catch (error) {
    next(error);
  }
};

// --- Phase 7 Helper: Build Safe Response Dataset ---
const buildSafeResponseDataset = async (form, reqQuery) => {
  const { startDate, endDate, maxResponses = 500 } = reqQuery;

  // Build query
  const query = { formId: form._id };
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  // Fetch bounded responses
  const limit = Math.min(parseInt(maxResponses, 10) || 500, 500);
  const responses = await Response.find(query).sort({ createdAt: -1 }).limit(limit).lean();

  if (responses.length === 0) {
    return { dataset: null, total: 0 };
  }

  // Fetch questions
  const questions = await Question.find({ formId: form._id }).lean();

  // Filter questions that are semantic
  const semanticTypes = new Set(['short_text', 'long_text', 'single_choice', 'multiple_choice', 'dropdown']);
  const semanticQuestions = questions.filter(q => semanticTypes.has(q.type));
  const qMap = new Map(semanticQuestions.map(q => [q._id.toString(), q.label]));

  // Build transformed array
  const dataset = [];
  responses.forEach((r, index) => {
    const safeAnswers = [];
    r.answers.forEach(ans => {
      const qIdStr = ans.questionId.toString();
      if (qMap.has(qIdStr) && ans.value) {
        let val = ans.value;
        if (typeof val === 'string') {
          val = val.slice(0, 500); // truncate long text
        }
        if (Array.isArray(val)) {
          val = val.map(v => typeof v === 'string' ? v.slice(0, 500) : v);
        }
        safeAnswers.push({
          question: qMap.get(qIdStr),
          answer: val
        });
      }
    });

    if (safeAnswers.length > 0) {
      dataset.push({
        index,
        answers: safeAnswers
      });
    }
  });

  return { dataset: dataset.length > 0 ? dataset : null, total: responses.length };
};

/**
 * @route   POST /api/ai/responses/summary/:formId
 * @desc    Generate AI summary of form responses
 * @access  Private (owner only)
 */
export const responseSummaryHandler = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });
    if (form.ownerId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized to view this form' });

    const { dataset, total } = await buildSafeResponseDataset(form, req.body);
    if (!dataset) {
      return res.status(200).json({ success: true, data: { overview: 'Not enough valid responses to generate insights.', keyInsights: [], caveats: [] } });
    }

    const summary = await AIService.summarizeResponses({ formTitle: form.title, totalResponsesAnalyzed: total, dataset });
    res.status(200).json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/ai/responses/themes/:formId
 * @desc    Extract themes from form responses
 * @access  Private (owner only)
 */
export const responseThemesHandler = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });
    if (form.ownerId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized to view this form' });

    const { dataset } = await buildSafeResponseDataset(form, req.body);
    if (!dataset) {
      return res.status(200).json({ success: true, data: { themes: [] } });
    }

    const themesResult = await AIService.extractThemes({ dataset });
    res.status(200).json({ success: true, data: themesResult });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/ai/responses/categorize/:formId
 * @desc    Categorize form responses
 * @access  Private (owner only)
 */
export const responseCategorizeHandler = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });
    if (form.ownerId.toString() !== req.user.id) return res.status(403).json({ success: false, message: 'Not authorized to view this form' });

    const { dataset } = await buildSafeResponseDataset(form, req.body);
    if (!dataset) {
      return res.status(200).json({ success: true, data: { categories: [], uncategorizedResponseIndexes: [] } });
    }

    let { allowedCategories } = req.body;
    if (allowedCategories) {
      allowedCategories = allowedCategories.slice(0, 15).map(c => c.slice(0, 50));
    }

    const catResult = await AIService.categorizeResponses({ dataset, allowedCategories });

    // Filter invalid indexes
    const validIndexes = new Set(dataset.map(d => d.index));
    const safeCategories = catResult.categories.map(c => ({
      ...c,
      responseIndexes: c.responseIndexes.filter(idx => validIndexes.has(idx))
    }));
    const safeUncategorized = catResult.uncategorizedResponseIndexes.filter(idx => validIndexes.has(idx));

    res.status(200).json({ success: true, data: { categories: safeCategories, uncategorizedResponseIndexes: safeUncategorized } });
  } catch (error) {
    next(error);
  }
};
