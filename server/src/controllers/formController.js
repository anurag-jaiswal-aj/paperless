import mongoose from 'mongoose';
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

    const { title, description, status, version } = req.body;

    const updateFields = { updatedAt: Date.now() };
    if (title !== undefined) updateFields.title = title;
    if (description !== undefined) updateFields.description = description;
    if (status !== undefined) updateFields.status = status;

    const query = {
      _id: req.params.id,
      ownerId: req.user.id
    };

    if (version !== undefined && version !== null) {
      const parsedVersion = Number(version);
      if (parsedVersion === 0) {
        query.$or = [{ version: 0 }, { version: { $exists: false } }];
      } else {
        query.version = parsedVersion;
      }
    }

    const updateDoc = {
      $set: updateFields,
      $inc: { version: 1 }
    };

    const updatedForm = await Form.findOneAndUpdate(
      query,
      updateDoc,
      { new: true, runValidators: true }
    );

    if (!updatedForm) {
      const existingForm = await Form.findOne({
        _id: req.params.id,
        ownerId: req.user.id
      });

      if (!existingForm) {
        return res.status(404).json({
          success: false,
          message: 'Form not found'
        });
      }

      return res.status(409).json({
        success: false,
        message: 'Conflict: Form has been modified by another update',
        data: existingForm
      });
    }

    res.status(200).json({
      success: true,
      message: 'Form updated successfully',
      data: updatedForm
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

    const { type, label, required, options, order, validation, visibilityRule, version } = req.body;

    const updateFields = {};
    if (type !== undefined) updateFields.type = type;
    if (label !== undefined) updateFields.label = label;
    if (required !== undefined) updateFields.required = required;
    if (options !== undefined) updateFields.options = options;
    if (order !== undefined) updateFields.order = order;
    if (validation !== undefined) updateFields.validation = validation;
    if (visibilityRule !== undefined) updateFields.visibilityRule = visibilityRule;

    const query = {
      _id: req.params.questionId,
      formId: req.params.formId
    };

    if (version !== undefined && version !== null) {
      const parsedVersion = Number(version);
      if (parsedVersion === 0) {
        query.$or = [{ version: 0 }, { version: { $exists: false } }];
      } else {
        query.version = parsedVersion;
      }
    }

    const updateDoc = {
      $set: updateFields,
      $inc: { version: 1 }
    };

    const updatedQuestion = await Question.findOneAndUpdate(
      query,
      updateDoc,
      { new: true, runValidators: true }
    );

    if (!updatedQuestion) {
      const existingQuestion = await Question.findOne({
        _id: req.params.questionId,
        formId: req.params.formId
      });

      if (!existingQuestion) {
        return res.status(404).json({
          success: false,
          message: 'Question not found'
        });
      }

      return res.status(409).json({
        success: false,
        message: 'Conflict: Question has been modified by another update',
        data: existingQuestion
      });
    }

    res.status(200).json({
      success: true,
      message: 'Question updated successfully',
      data: updatedQuestion
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
  let session = null;
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

    const targetIdStr = question._id.toString();
    const targetIdObj = mongoose.Types.ObjectId.isValid(targetIdStr)
      ? new mongoose.Types.ObjectId(targetIdStr)
      : question._id;

    const cleanupFilter = {
      formId: req.params.formId,
      $or: [
        { 'visibilityRule.targetQuestionId': targetIdObj },
        { 'visibilityRule.targetQuestionId': targetIdStr }
      ]
    };

    const topologyType = mongoose.connection.client?.topology?.description?.type;
    const canUseTransaction =
      topologyType === 'ReplicaSetWithPrimary' || topologyType === 'Sharded';

    if (canUseTransaction) {
      try {
        session = await mongoose.startSession();
        session.startTransaction();
      } catch {
        session = null;
      }
    }

    let previousRules = null;
    if (!session) {
      // In standalone Mongo environments without replica sets / transactions,
      // record previous rules so we can compensate if question deletion fails
      previousRules = await Question.find(cleanupFilter).select('_id visibilityRule');
    }

    try {
      // 1. Remove orphaned visibility rules referencing the deleted question in this form
      await Question.updateMany(
        cleanupFilter,
        { $set: { visibilityRule: null } },
        session ? { session } : {}
      );

      // 2. Delete the question itself
      await Question.deleteOne({ _id: question._id }, session ? { session } : {});

      if (session) {
        await session.commitTransaction();
      }
    } catch (dbErr) {
      if (session) {
        await session.abortTransaction();
      } else if (previousRules && previousRules.length > 0) {
        // Compensating rollback for standalone MongoDB
        for (const pr of previousRules) {
          await Question.updateOne(
            { _id: pr._id },
            { $set: { visibilityRule: pr.visibilityRule } }
          ).catch(() => {});
        }
      }
      throw dbErr;
    } finally {
      if (session) {
        session.endSession();
      }
    }

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

    // Update each question's order scoped strictly to this form
    await Promise.all(
      questionOrders
        .filter((item) => item && mongoose.Types.ObjectId.isValid(item.questionId) && typeof item.order === 'number' && Number.isFinite(item.order))
        .map(({ questionId, order }) =>
          Question.findOneAndUpdate(
            { _id: questionId, formId: req.params.formId },
            { order }
          )
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
