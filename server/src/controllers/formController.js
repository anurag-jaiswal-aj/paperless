import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import storageService from '../services/StorageService.js';

/**
 * @route   GET /api/forms
 * @desc    Get all forms for authenticated user
 * @access  Private
 */
export const getForms = async (req, res, next) => {
  try {
    const forms = await Form.find({ ownerId: req.user.id }).sort({ createdAt: -1 }).lean();

    // Get response counts for each form
    const formsWithCounts = await Promise.all(
      forms.map(async (form) => {
        const responseCount = await Response.countDocuments({ formId: form._id });
        return { ...form, responseCount };
      })
    );

    res.status(200).json({
      success: true,
      count: formsWithCounts.length,
      data: formsWithCounts
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/forms/:id
 * @desc    Get single form with questions
 * @access  Private (owner) or Public (if form.status !== 'draft')
 */
export const getForm = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Check authorization - must be owner or form must not be draft
    if (form.status === 'draft' && (!req.user || form.ownerId.toString() !== req.user.id)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this form'
      });
    }

    // Get questions for this form
    const questions = await Question.find({ formId: req.params.id }).sort({ order: 1 });

    res.status(200).json({
      success: true,
      data: {
        form,
        questions
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/forms
 * @desc    Create new form
 * @access  Private
 */
export const createForm = async (req, res, next) => {
  try {
    const { title, description, status } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Form title is required'
      });
    }

    const form = await Form.create({
      ownerId: req.user.id,
      title,
      description: description || '',
      status: status || 'draft'
    });

    res.status(201).json({
      success: true,
      message: 'Form created successfully',
      data: form
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/forms/:id
 * @desc    Update form
 * @access  Private (owner only)
 */
export const updateForm = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.id);

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
        message: 'Not authorized to update this form'
      });
    }

    const { title, description, status } = req.body;

    if (title !== undefined) form.title = title;
    if (description !== undefined) form.description = description;
    if (status !== undefined) form.status = status;

    await form.save();

    res.status(200).json({
      success: true,
      message: 'Form updated successfully',
      data: form
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   DELETE /api/forms/:id
 * @desc    Delete form and all associated questions/responses
 * @access  Private (owner only)
 */
export const deleteForm = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.id);

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
        message: 'Not authorized to delete this form'
      });
    }

    // Delete all associated questions and responses
    await Question.deleteMany({ formId: req.params.id });

    // Delete attached files in S3
    const responses = await Response.find({ formId: req.params.id });
    for (const r of responses) {
      for (const answer of r.answers) {
        if (answer.value && answer.value.key) {
          try {
            await storageService.deleteFile(answer.value.key);
          } catch (e) {
            console.error('Failed to delete S3 file during form deletion', e);
          }
        }
      }
    }
    await Response.deleteMany({ formId: req.params.id });
    await form.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Form deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/forms/:id/questions
 * @desc    Add question to form
 * @access  Private (owner only)
 */
export const addQuestion = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.id);

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
        message: 'Not authorized to modify this form'
      });
    }

    const { type, label, required, options, validation, visibilityRule } = req.body;

    if (!type || !label) {
      return res.status(400).json({
        success: false,
        message: 'Question type and label are required'
      });
    }

    // Get current max order
    const maxOrderQuestion = await Question.findOne({ formId: req.params.id }).sort({ order: -1 });
    const nextOrder = maxOrderQuestion ? maxOrderQuestion.order + 1 : 0;

    const question = await Question.create({
      formId: req.params.id,
      type,
      label,
      required: required || false,
      order: nextOrder,
      options: options || [],
      validation: validation || {},
      visibilityRule: visibilityRule || null
    });

    res.status(201).json({
      success: true,
      message: 'Question added successfully',
      data: question
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/forms/:formId/questions/:questionId
 * @desc    Update question
 * @access  Private (owner only)
 */
export const updateQuestion = async (req, res, next) => {
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
        message: 'Not authorized to modify this form'
      });
    }

    const question = await Question.findById(req.params.questionId);

    if (!question || question.formId.toString() !== req.params.formId) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    const { type, label, required, options, order, validation, visibilityRule } = req.body;

    if (type !== undefined) question.type = type;
    if (label !== undefined) question.label = label;
    if (required !== undefined) question.required = required;
    if (options !== undefined) question.options = options;
    if (order !== undefined) question.order = order;
    if (validation !== undefined) question.validation = validation;
    if (visibilityRule !== undefined) question.visibilityRule = visibilityRule;

    await question.save();

    res.status(200).json({
      success: true,
      message: 'Question updated successfully',
      data: question
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   DELETE /api/forms/:formId/questions/:questionId
 * @desc    Delete question
 * @access  Private (owner only)
 */
export const deleteQuestion = async (req, res, next) => {
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
        message: 'Not authorized to modify this form'
      });
    }

    const question = await Question.findById(req.params.questionId);

    if (!question || question.formId.toString() !== req.params.formId) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    await question.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Question deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/forms/:formId/questions/reorder
 * @desc    Reorder questions
 * @access  Private (owner only)
 */
export const reorderQuestions = async (req, res, next) => {
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
        message: 'Not authorized to modify this form'
      });
    }

    const { questionOrders } = req.body; // Array of { questionId, order }

    if (!Array.isArray(questionOrders)) {
      return res.status(400).json({
        success: false,
        message: 'questionOrders must be an array'
      });
    }

    // Update each question's order
    await Promise.all(
      questionOrders.map(({ questionId, order }) =>
        Question.findByIdAndUpdate(questionId, { order })
      )
    );

    res.status(200).json({
      success: true,
      message: 'Questions reordered successfully'
    });
  } catch (error) {
    next(error);
  }
};
