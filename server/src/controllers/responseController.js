import Response from '../models/response.js';
import Form from '../models/form.js';
import Question from '../models/question.js';

/**
 * @route   POST /api/responses/:formId
 * @desc    Submit response to a form
 * @access  Public
 */
export const submitResponse = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    if (!form.isPublic) {
      return res.status(403).json({
        success: false,
        message: 'This form is not accepting responses'
      });
    }

    const { answers } = req.body;

    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        message: 'Answers array is required'
      });
    }

    // Validate required questions
    const questions = await Question.find({ formId: req.params.formId });
    const requiredQuestions = questions.filter(q => q.required);
    
    for (const reqQuestion of requiredQuestions) {
      const answer = answers.find(a => a.questionId === reqQuestion._id.toString());
      if (!answer || !answer.value || answer.value === '') {
        return res.status(400).json({
          success: false,
          message: `Question "${reqQuestion.label}" is required`
        });
      }
    }

    // Get submitter info (IP address or anonymous)
    const submittedBy = req.ip || 'anonymous';

    const response = await Response.create({
      formId: req.params.formId,
      answers,
      submittedBy
    });

    res.status(201).json({
      success: true,
      message: 'Response submitted successfully',
      data: response
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/responses/:formId
 * @desc    Get all responses for a form
 * @access  Private (owner only)
 */
export const getResponses = async (req, res, next) => {
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
        message: 'Not authorized to view responses'
      });
    }

    const responses = await Response.find({ formId: req.params.formId })
      .sort({ createdAt: -1 })
      .populate('answers.questionId', 'label type');

    res.status(200).json({
      success: true,
      count: responses.length,
      data: responses
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/responses/:formId/analytics
 * @desc    Get analytics for form responses
 * @access  Private (owner only)
 */
export const getAnalytics = async (req, res, next) => {
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
        message: 'Not authorized to view analytics'
      });
    }

    const questions = await Question.find({ formId: req.params.formId }).sort({ order: 1 });
    const responses = await Response.find({ formId: req.params.formId });

    // Calculate analytics per question
    const analytics = questions.map(question => {
      const questionAnswers = responses
        .map(r => r.answers.find(a => a.questionId.toString() === question._id.toString()))
        .filter(Boolean);

      const totalAnswers = questionAnswers.length;
      
      let data = {};

      if (['multiple_choice', 'dropdown', 'checkbox'].includes(question.type)) {
        // Count occurrences of each option
        const optionCounts = {};
        questionAnswers.forEach(answer => {
          if (Array.isArray(answer.value)) {
            // For checkboxes
            answer.value.forEach(val => {
              optionCounts[val] = (optionCounts[val] || 0) + 1;
            });
          } else {
            optionCounts[answer.value] = (optionCounts[answer.value] || 0) + 1;
          }
        });
        data = { type: 'options', counts: optionCounts };
      } else if (question.type === 'rating') {
        // Calculate rating statistics
        const ratings = questionAnswers.map(a => Number(a.value)).filter(r => !isNaN(r));
        const average = ratings.length > 0 
          ? (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(2)
          : 0;
        const distribution = {};
        for (let i = 1; i <= 5; i++) {
          distribution[i] = ratings.filter(r => r === i).length;
        }
        data = { type: 'rating', average, distribution };
      } else {
        // Text responses - just count
        data = { type: 'text', count: totalAnswers };
      }

      return {
        questionId: question._id,
        label: question.label,
        type: question.type,
        totalAnswers,
        data
      };
    });

    res.status(200).json({
      success: true,
      data: {
        totalResponses: responses.length,
        analytics
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/responses/:formId/export
 * @desc    Export responses as JSON or CSV
 * @access  Private (owner only)
 */
export const exportResponses = async (req, res, next) => {
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
        message: 'Not authorized to export responses'
      });
    }

    const format = req.query.format || 'json'; // json or csv
    const questions = await Question.find({ formId: req.params.formId }).sort({ order: 1 });
    const responses = await Response.find({ formId: req.params.formId }).sort({ createdAt: 1 });

    if (format === 'csv') {
      // Generate CSV
      const headers = ['Timestamp', ...questions.map(q => q.label)];
      const rows = responses.map(response => {
        const row = [new Date(response.createdAt).toISOString()];
        questions.forEach(question => {
          const answer = response.answers.find(a => a.questionId.toString() === question._id.toString());
          const value = answer ? (Array.isArray(answer.value) ? answer.value.join('; ') : answer.value) : '';
          row.push(value);
        });
        return row;
      });

      const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="responses-${req.params.formId}.csv"`);
      res.send(csv);
    } else {
      // Return JSON
      const exportData = {
        form: {
          id: form._id,
          title: form.title,
          description: form.description
        },
        questions: questions.map(q => ({
          id: q._id,
          label: q.label,
          type: q.type
        })),
        responses: responses.map(r => ({
          id: r._id,
          submittedAt: r.createdAt,
          answers: r.answers
        }))
      };

      res.status(200).json({
        success: true,
        data: exportData
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @route   DELETE /api/responses/:formId/:responseId
 * @desc    Delete a single response
 * @access  Private (owner only)
 */
export const deleteResponse = async (req, res, next) => {
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
        message: 'Not authorized to delete responses'
      });
    }

    const response = await Response.findById(req.params.responseId);

    if (!response || response.formId.toString() !== req.params.formId) {
      return res.status(404).json({
        success: false,
        message: 'Response not found'
      });
    }

    await response.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Response deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
