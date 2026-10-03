import Response from '../models/response.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import User from '../models/user.js';
import storageService from '../services/StorageService.js';
import EmailService from '../services/EmailService.js';
import crypto from 'crypto';

// Helper to evaluate visibility rule
const isQuestionVisible = (question, answers) => {
  if (!question.visibilityRule || !question.visibilityRule.targetQuestionId) {
    return true;
  }
  const { targetQuestionId, operator, value } = question.visibilityRule;
  const targetAnswer = answers.find(a => String(a.questionId) === String(targetQuestionId));

  if (!targetAnswer || targetAnswer.value === undefined || targetAnswer.value === null) {
    return false;
  }

  const ansVal = targetAnswer.value;
  switch (operator) {
    case 'equals':
      return String(ansVal) === String(value);
    case 'not_equals':
      return String(ansVal) !== String(value);
    case 'contains':
      if (Array.isArray(ansVal)) return ansVal.includes(value);
      return String(ansVal).includes(String(value));
    default:
      return true;
  }
};

/**
 * @route   POST /api/responses/:formId
 * @desc    Submit response to a form
 * @access  Public
 */
export const submitResponse = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);

    if (!form) {
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    if (form.status !== 'published') {
      return res.status(403).json({ success: false, message: 'This form is not accepting responses' });
    }

    let rawAnswers = req.body.answers;

    if (typeof rawAnswers === 'string') {
      try {
        rawAnswers = JSON.parse(rawAnswers);
      } catch (e) {
        return res.status(400).json({ success: false, message: 'Invalid answers format' });
      }
    }

    if (!rawAnswers || !Array.isArray(rawAnswers)) {
      return res.status(400).json({ success: false, message: 'Answers array is required' });
    }

    const questions = await Question.find({ formId: req.params.formId });

    const validAnswersToSave = [];
    const filesToUpload = []; // { file, question, key }

    // First pass: Validation
    for (const question of questions) {
      const isVisible = isQuestionVisible(question, rawAnswers);

      let val;
      let hasValue = false;
      let file = null;

      if (question.type === 'file') {
        file = req.files && req.files.find(f => f.fieldname === `file_${question._id.toString()}`);
        if (file) {
          hasValue = true;
          val = file;
        }
      } else {
        const providedAnswer = rawAnswers.find(a => a.questionId === question._id.toString());
        val = providedAnswer ? providedAnswer.value : undefined;
        hasValue = val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0);
      }

      if (isVisible && question.required && !hasValue) {
        return res.status(400).json({ success: false, message: `Question "${question.label}" is required` });
      }

      if (isVisible && hasValue) {
        // Type validation
        if (question.type === 'email') {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(String(val))) {
            return res.status(400).json({ success: false, message: `Question "${question.label}" must be a valid email` });
          }
        } else if (question.type === 'number') {
          if (isNaN(Number(val))) {
            return res.status(400).json({ success: false, message: `Question "${question.label}" must be a number` });
          }
        } else if (['single_choice', 'dropdown'].includes(question.type)) {
          if (!question.options.includes(String(val))) {
            return res.status(400).json({ success: false, message: `Question "${question.label}" has an invalid choice` });
          }
        } else if (question.type === 'multiple_choice') {
          if (!Array.isArray(val) || !val.every(v => question.options.includes(String(v)))) {
            return res.status(400).json({ success: false, message: `Question "${question.label}" has invalid choices` });
          }
        } else if (question.type === 'file') {
          // File validation
          const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
          if (!allowedTypes.includes(file.mimetype)) {
            return res.status(400).json({ success: false, message: `Question "${question.label}" has an unsupported file type` });
          }

          const maxSizeBytes = process.env.MAX_FILE_SIZE ? parseInt(process.env.MAX_FILE_SIZE, 10) : 5 * 1024 * 1024;
          if (file.size > maxSizeBytes) {
            return res.status(400).json({ success: false, message: `Question "${question.label}" file exceeds maximum size` });
          }

          const fileExt = file.originalname.split('.').pop().replace(/[^a-zA-Z0-9]/g, '');
          const fileId = crypto.randomUUID();
          const storageKey = `forms/${form._id}/responses/${fileId}.${fileExt}`;
          filesToUpload.push({ file, question, key: storageKey });
        }

        if (question.type !== 'file') {
          validAnswersToSave.push({
            questionId: question._id,
            value: val
          });
        }
      }
    }

    // Upload files
    for (const item of filesToUpload) {
      await storageService.uploadFile(item.file.buffer, item.key, item.file.mimetype);
      validAnswersToSave.push({
        questionId: item.question._id,
        value: {
          key: item.key,
          originalName: item.file.originalname,
          mimeType: item.file.mimetype,
          size: item.file.size
        }
      });
    }

    const submittedBy = req.ip || 'anonymous';

    const response = await Response.create({
      formId: req.params.formId,
      answers: validAnswersToSave,
      submittedBy
    });

    // Send email notification asynchronously
    try {
      const owner = await User.findById(form.ownerId);
      if (owner) {
        const emailService = new EmailService();
        await emailService.sendEmail({
          to: owner.email,
          subject: `New submission for form: ${form.title}`,
          html: `<p>You have received a new submission for your form <strong>${form.title}</strong>.</p><p><a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard">View Responses</a></p>`
        });
      }
    } catch (emailErr) {
      console.error('Failed to send notification email:', emailErr);
      // Do not fail the submission
    }

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

    const { page = 1, limit = 50, startDate, endDate } = req.query;

    // Validate pagination limits
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const query = { formId: req.params.formId };

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        const start = new Date(startDate);
        if (!isNaN(start.getTime())) query.createdAt.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        if (!isNaN(end.getTime())) query.createdAt.$lte = end;
      }
      if (Object.keys(query.createdAt).length === 0) {
        delete query.createdAt;
      }
    }

    const [responses, total] = await Promise.all([
      Response.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('answers.questionId', 'label type'),
      Response.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data: responses,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
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
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    if (form.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to view analytics' });
    }

    const { startDate, endDate } = req.query;

    // Build match criteria with optional date filtering
    const matchCriteria = { formId: form._id };

    if (startDate || endDate) {
      matchCriteria.createdAt = {};
      if (startDate) {
        const start = new Date(startDate);
        if (!isNaN(start.getTime())) matchCriteria.createdAt.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        if (!isNaN(end.getTime())) matchCriteria.createdAt.$lte = end;
      }
      // Clean up if dates were invalid
      if (Object.keys(matchCriteria.createdAt).length === 0) {
        delete matchCriteria.createdAt;
      }
    }

    // 1. Total Responses and Completion
    const totalResponses = await Response.countDocuments(matchCriteria);
    const completedResponses = await Response.countDocuments({
      ...matchCriteria,
      'answers.0': { $exists: true }
    });

    const completionRate = totalResponses > 0
      ? Math.round((completedResponses / totalResponses) * 100)
      : 0;

    // 2. Timeline Aggregation
    const timeline = await Response.aggregate([
      { $match: matchCriteria },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // 3. Question Analytics Aggregation
    const questions = await Question.find({ formId: form._id }).sort({ order: 1 });

    const questionAnalytics = await Response.aggregate([
      { $match: matchCriteria },
      { $unwind: '$answers' },
      {
        $group: {
          _id: '$answers.questionId',
          totalAnswers: { $sum: 1 },
          values: { $push: '$answers.value' }
        }
      }
    ]);

    // Map aggregated results back to question definitions
    const analyticsMap = questionAnalytics.reduce((acc, curr) => {
      acc[curr._id.toString()] = curr;
      return acc;
    }, {});

    const analytics = questions.map(question => {
      const qIdStr = question._id.toString();
      const qData = analyticsMap[qIdStr] || { totalAnswers: 0, values: [] };
      const { type } = question;

      let data = {};

      if (['single_choice', 'multiple_choice', 'dropdown'].includes(type)) {
        const optionCounts = {};
        let selectionCount = 0;

        qData.values.forEach(val => {
          if (Array.isArray(val)) {
            val.forEach(v => {
              optionCounts[v] = (optionCounts[v] || 0) + 1;
              selectionCount++;
            });
          } else if (val) {
            optionCounts[val] = (optionCounts[val] || 0) + 1;
            selectionCount++;
          }
        });

        // Calculate percentages based on authoritative options where possible
        const distribution = question.options.map(opt => ({
          option: opt,
          count: optionCounts[opt] || 0,
          percentage: qData.totalAnswers > 0 ? Math.round(((optionCounts[opt] || 0) / qData.totalAnswers) * 100) : 0
        }));

        data = { type: 'options', distribution, totalSelections: selectionCount };
      } else if (type === 'number') {
        const nums = qData.values
          .map(v => Number(v))
          .filter(v => !isNaN(v));

        if (nums.length > 0) {
          const sum = nums.reduce((a, b) => a + b, 0);
          data = {
            type: 'number',
            min: Math.min(...nums),
            max: Math.max(...nums),
            average: Number((sum / nums.length).toFixed(2))
          };
        } else {
          data = { type: 'number', min: null, max: null, average: null };
        }
      } else if (type === 'file') {
        data = { type: 'file', count: qData.totalAnswers };
      } else {
        // Text / Email types
        data = { type: 'text', count: qData.totalAnswers };
      }

      return {
        questionId: question._id,
        label: question.label,
        type: question.type,
        totalAnswers: qData.totalAnswers,
        data
      };
    });

    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalResponses,
          completedResponses,
          completionRate
        },
        timeline: timeline.map(t => ({ date: t._id, count: t.count })),
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

    const { format = 'json', startDate, endDate } = req.query; // json or csv
    const questions = await Question.find({ formId: req.params.formId }).sort({ order: 1 });

    const query = { formId: req.params.formId };
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        const start = new Date(startDate);
        if (!isNaN(start.getTime())) query.createdAt.$gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        if (!isNaN(end.getTime())) query.createdAt.$lte = end;
      }
      if (Object.keys(query.createdAt).length === 0) {
        delete query.createdAt;
      }
    }

    const responses = await Response.find(query).sort({ createdAt: 1 });

    if (format === 'csv') {
      // Generate CSV
      const headers = ['Timestamp', ...questions.map((q) => q.label)];
      const rows = responses.map((response) => {
        const row = [new Date(response.createdAt).toISOString()];
        questions.forEach((question) => {
          const answer = response.answers.find(
            (a) => a.questionId.toString() === question._id.toString()
          );
          const value = answer
            ? Array.isArray(answer.value)
              ? answer.value.join('; ')
              : answer.value
            : '';
          row.push(value);
        });
        return row;
      });

      const csv = [headers, ...rows]
        .map((row) => row.map((cell) => `"${cell}"`).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="responses-${req.params.formId}.csv"`
      );
      res.send(csv);
    } else {
      // Return JSON
      const exportData = {
        form: {
          id: form._id,
          title: form.title,
          description: form.description
        },
        questions: questions.map((q) => ({
          id: q._id,
          label: q.label,
          type: q.type
        })),
        responses: responses.map((r) => ({
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

    // Delete any attached files in S3
    for (const answer of response.answers) {
      if (answer.value && answer.value.key) {
        try {
          await storageService.deleteFile(answer.value.key);
        } catch (err) {
          console.error(`Failed to delete file from storage: ${answer.value.key}`, err);
          // Continue deleting the response even if file deletion fails
        }
      }
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

/**
 * @route   GET /api/responses/:formId/:responseId/file/:questionId
 * @desc    Download a file attached to a response
 * @access  Private (owner only)
 */
export const downloadResponseFile = async (req, res, next) => {
  try {
    const form = await Form.findById(req.params.formId);

    if (!form) {
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    // Check ownership
    if (form.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to view responses' });
    }

    const response = await Response.findOne({
      _id: req.params.responseId,
      formId: req.params.formId
    });

    if (!response) {
      return res.status(404).json({ success: false, message: 'Response not found' });
    }

    const answer = response.answers.find(a => a.questionId.toString() === req.params.questionId);

    if (!answer || !answer.value || !answer.value.key) {
      return res.status(404).json({ success: false, message: 'File not found in response' });
    }

    const presignedUrl = await storageService.getPresignedUrl(answer.value.key);

    // Redirect the user directly to the presigned S3 URL
    res.redirect(presignedUrl);
  } catch (error) {
    next(error);
  }
};
