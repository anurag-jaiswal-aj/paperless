import { suggestQuestions, improveWording, summarizeResponses } from '../services/openaiService.js';
import Form from '../models/form.js';

/**
 * @route   POST /api/ai/suggest
 * @desc    Suggest questions based on topic
 * @access  Private
 */
export const suggestQuestionsHandler = async (req, res, next) => {
  try {
    const { topic } = req.body;

    if (!topic) {
      return res.status(400).json({
        success: false,
        message: 'Topic is required'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message: 'AI service not configured'
      });
    }

    const questions = await suggestQuestions(topic);

    res.status(200).json({
      success: true,
      data: questions
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/ai/improve
 * @desc    Improve question wording
 * @access  Private
 */
export const improveWordingHandler = async (req, res, next) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({
        success: false,
        message: 'Question text is required'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message: 'AI service not configured'
      });
    }

    const improvements = await improveWording(question);

    res.status(200).json({
      success: true,
      data: improvements
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/ai/summary/:formId
 * @desc    Generate AI summary of form responses
 * @access  Private (owner only)
 */
export const summaryHandler = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check ownership
    if (form.ownerId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this form'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message: 'AI service not configured'
      });
    }

    const summary = await summarizeResponses(req.params.formId);

    res.status(200).json({
      success: true,
      data: { summary }
    });
  } catch (error) {
    next(error);
  }
};
