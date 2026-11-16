import crypto from 'crypto';
import mongoose from 'mongoose';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import SubmissionReservation from '../models/submissionReservation.js';
import DeletionCleanupJob from '../models/deletionCleanupJob.js';
import storageService from '../services/StorageService.js';
import { logger } from '../utils/logger.js';
import { isValidObjectId } from '../middleware/validateObjectId.js';
import { withRequiredTransaction } from '../utils/dbTransaction.js';
import { SubmissionReservationManager } from '../utils/submissionReservationManager.js';

export const DELETION_LEASE_TTL_MS = parseInt(process.env.DELETION_LEASE_TTL_MS, 10) || 30000;
export const DELETION_CLEANUP_GRACE_MS =
  parseInt(process.env.DELETION_CLEANUP_GRACE_MS, 10) || 15 * 60 * 1000;

export const DELETION_RECONCILE_BACKOFF_SCHEDULE_MS = [
  60 * 1000, // Pass 0: 1 minute
  5 * 60 * 1000, // Pass 1: 5 minutes
  15 * 60 * 1000, // Pass 2: 15 minutes
  30 * 60 * 1000, // Pass 3: 30 minutes
  60 * 60 * 1000, // Pass 4: 1 hour
  6 * 60 * 60 * 1000, // Pass 5: 6 hours
  24 * 60 * 60 * 1000 // Pass 6+: 24 hours (cap)
];

export const calculateNextSweepDelay = (passes = 0) => {
  const index = Math.min(Math.max(0, passes), DELETION_RECONCILE_BACKOFF_SCHEDULE_MS.length - 1);
  return DELETION_RECONCILE_BACKOFF_SCHEDULE_MS[index];
};

const activeDeletionTasks = new Set();

export const trackDeletionTask = (promise) => {
  activeDeletionTasks.add(promise);
  promise
    .finally(() => {
      activeDeletionTasks.delete(promise);
    })
    .catch(() => {});
  return promise;
};

/**
 * Wait up to timeoutMs for active deletion or recovery tasks to finish and settle
 * timers/transactions before closing DB connections during graceful shutdown.
 *
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<boolean>}
 */
export const waitForActiveDeletionTasks = async (timeoutMs = 5000) => {
  if (activeDeletionTasks.size === 0) {
    return true;
  }
  let timer = null;
  try {
    const drainPromise = Promise.allSettled(Array.from(activeDeletionTasks)).then(() => true);
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      if (timer.unref) timer.unref();
    });
    return await Promise.race([drainPromise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/**
 * @route   GET /api/forms
 * @desc    Get all forms for authenticated user
 * @access  Private
 */
export const getForms = async (req, res, next) => {
  try {
    const MAX_PAGE = 100;
    const MAX_LIMIT = 100;
    const DEFAULT_LIMIT = 50;

    const parsedPage = parseInt(req.query.page, 10);
    const parsedLimit = parseInt(req.query.limit, 10);

    const pageNum =
      Number.isInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, MAX_PAGE) : 1;
    const limitNum =
      Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;
    const skip = (pageNum - 1) * limitNum;

    const filter = { ownerId: req.user.id };

    // Bounded fetch with pagination and count executed in parallel
    const [forms, totalCount] = await Promise.all([
      Form.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limitNum).lean(),
      Form.countDocuments(filter)
    ]);

    // Eliminate N+1 query: single aggregation batch for response counts
    let formsWithCounts = [];
    if (forms.length > 0) {
      const formIds = forms.map((f) => f._id);
      const counts = await Response.aggregate([
        { $match: { formId: { $in: formIds } } },
        { $group: { _id: '$formId', count: { $sum: 1 } } }
      ]);

      const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));
      formsWithCounts = forms.map((form) => ({
        ...form,
        responseCount: countMap.get(form._id.toString()) || 0
      }));
    }

    const totalPages = Math.ceil(totalCount / limitNum) || 0;

    res.status(200).json({
      success: true,
      count: formsWithCounts.length,
      total: totalCount,
      page: pageNum,
      totalPages,
      limit: limitNum,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        pages: totalPages
      },
      data: formsWithCounts
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   GET /api/forms/:id
 * @desc    Get single form with questions
 * @access  Private (owner) or Public (if form.status === 'published')
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

    const isOwner = Boolean(req.user && form.ownerId && form.ownerId.toString() === req.user.id);

    // Check authorization: non-owners accessing non-published forms receive uniform 404
    // to eliminate draft/closed form existence enumeration (API-05 / API-08).
    if (!isOwner && form.status !== 'published') {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Get questions for this form
    const questions = await Question.find({ formId: req.params.id }).sort({ order: 1 });

    // Authenticated owner receives full form document for builder/editor/responses
    if (isOwner) {
      return res.status(200).json({
        success: true,
        data: {
          form,
          questions
        }
      });
    }

    // Public visitor receives sanitized payload stripping ownerId, version, __v, and timestamps
    const sanitizedForm = {
      _id: form._id,
      id: form._id,
      title: form.title,
      description: form.description
    };

    const sanitizedQuestions = questions.map((q) => ({
      _id: q._id,
      id: q._id,
      type: q.type,
      label: q.label,
      required: Boolean(q.required),
      options: Array.isArray(q.options) ? q.options : [],
      visibilityRule: q.visibilityRule || null
    }));

    res.status(200).json({
      success: true,
      data: {
        form: sanitizedForm,
        questions: sanitizedQuestions
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

    const ALLOWED_USER_STATUSES = ['draft', 'published', 'closed'];
    if (status !== undefined && !ALLOWED_USER_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid form status'
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
 * Validates visibility rule object against form questions and permitted operators.
 *
 * @param {object|null} rule - The visibility rule object { targetQuestionId, operator, value } or null.
 * @param {string|mongoose.Types.ObjectId} formId - Target form ID.
 * @param {string|mongoose.Types.ObjectId|null} [currentQuestionId=null] - Current question ID to prevent self-reference.
 * @returns {Promise<{ valid: boolean, message?: string, value?: object|null }>}
 */
export const validateVisibilityRule = async (
  rule,
  formId,
  currentQuestionId = null,
  session = null
) => {
  if (rule === null || rule === undefined) {
    return { valid: true, value: null };
  }

  if (typeof rule !== 'object' || Array.isArray(rule)) {
    return { valid: false, message: 'visibilityRule must be an object or null' };
  }

  const { targetQuestionId, operator, value } = rule;

  if (!targetQuestionId || !isValidObjectId(targetQuestionId)) {
    return { valid: false, message: 'visibilityRule.targetQuestionId must be a valid question ID' };
  }

  if (currentQuestionId && String(targetQuestionId) === String(currentQuestionId)) {
    return { valid: false, message: 'A question cannot depend on its own answer' };
  }

  const targetExistsQuery = Question.exists({ _id: targetQuestionId, formId });
  const targetExists = session ? await targetExistsQuery.session(session) : await targetExistsQuery;
  if (!targetExists) {
    return { valid: false, message: 'Referenced targetQuestion does not belong to this form' };
  }

  const ALLOWED_OPERATORS = ['equals', 'not_equals', 'contains'];
  if (!operator || !ALLOWED_OPERATORS.includes(operator)) {
    return {
      valid: false,
      message: `visibilityRule.operator must be one of: ${ALLOWED_OPERATORS.join(', ')}`
    };
  }

  if (value === undefined) {
    return { valid: false, message: 'visibilityRule.value is required' };
  }

  if (
    value === null ||
    (typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      !Array.isArray(value))
  ) {
    return {
      valid: false,
      message: 'visibilityRule.value must be a string, number, boolean, or array'
    };
  }

  if (typeof value === 'string' && value.length > 500) {
    return {
      valid: false,
      message: 'visibilityRule.value cannot exceed 500 characters'
    };
  }

  if (Array.isArray(value)) {
    if (value.length > 100) {
      return {
        valid: false,
        message: 'visibilityRule.value array exceeds maximum limit of 100 items'
      };
    }
    for (const item of value) {
      if (typeof item === 'string' && item.length > 500) {
        return {
          valid: false,
          message: 'visibilityRule.value array string items cannot exceed 500 characters'
        };
      }
      if (item !== null && typeof item === 'object') {
        return {
          valid: false,
          message: 'visibilityRule.value array items must be strings, numbers, or booleans'
        };
      }
    }
  }

  return {
    valid: true,
    value: {
      targetQuestionId: new mongoose.Types.ObjectId(targetQuestionId),
      operator,
      value
    }
  };
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

    if (['deleting', 'delete_failed'].includes(form.status)) {
      return res.status(409).json({
        success: false,
        message:
          form.status === 'deleting'
            ? 'Form is currently being deleted'
            : 'Form deletion previously failed'
      });
    }

    const { title, description, status, version } = req.body;

    const ALLOWED_USER_STATUSES = ['draft', 'published', 'closed'];
    if (status !== undefined && !ALLOWED_USER_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid form status'
      });
    }

    const updateFields = { updatedAt: Date.now() };
    if (title !== undefined) updateFields.title = title;
    if (description !== undefined) updateFields.description = description;
    if (status !== undefined) updateFields.status = status;

    const query = {
      _id: req.params.id,
      ownerId: req.user.id,
      status: { $nin: ['deleting', 'delete_failed'] }
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

    const updatedForm = await Form.findOneAndUpdate(query, updateDoc, {
      new: true,
      runValidators: true
    });

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

      if (['deleting', 'delete_failed'].includes(existingForm.status)) {
        return res.status(409).json({
          success: false,
          message:
            existingForm.status === 'deleting'
              ? 'Form is currently being deleted'
              : 'Form deletion previously failed',
          data: existingForm
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
 * Evaluates and classifies a storage key candidate for a form.
 * Category A: Confirmed valid form-owned key (starts with forms/${formId}/ with valid subpath).
 * Category B: Confirmed malicious or foreign key (path traversal, backslashes, control characters,
 *             external URI schemes, root paths, or foreign form namespace forms/${otherFormId}/).
 * Category C: Unrecognized or unresolved legacy key (e.g. uploads/..., flat filename, etc.).
 *
 * @param {string} rawKey - Candidate key to classify
 * @param {string} formIdStr - Target form ObjectId as a string
 * @returns {{ category: 'A' | 'B' | 'C', key: string, reason?: string }}
 */
export const classifyStorageKey = (rawKey, formIdStr) => {
  if (typeof rawKey !== 'string') {
    return { category: 'B', key: String(rawKey), reason: 'Non-string key value' };
  }

  const key = rawKey.trim();
  if (key.length === 0) {
    return { category: 'B', key, reason: 'Empty key value' };
  }

  // Category B check 1: Path traversal, backslashes, or control characters
  if (key.includes('..') || key.includes('\\') || /[\r\n\0]/.test(key)) {
    return { category: 'B', key, reason: 'Path traversal or control character detected' };
  }

  // Category B check 2: Absolute or external URI scheme (e.g. http://, https://, s3://, file://)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(key) || key.startsWith('//')) {
    return { category: 'B', key, reason: 'Absolute or external URI scheme detected' };
  }

  // Category B check 3: Root-relative path
  if (key.startsWith('/')) {
    return { category: 'B', key, reason: 'Root-relative path forbidden' };
  }

  // Category B check 4: Foreign form namespace (forms/<otherFormId>/... or staging/forms/<otherFormId>/...)
  const foreignFormMatch = key.match(/^(?:forms|staging\/forms)\/([^/]+)\//);
  if (foreignFormMatch) {
    const extractedFormId = foreignFormMatch[1];
    if (extractedFormId !== formIdStr) {
      return { category: 'B', key, reason: `Belongs to foreign form: ${extractedFormId}` };
    }
  }

  // Category A check: Confirmed valid form-owned key (permanent forms/... or staging/forms/... namespace)
  const permanentPrefix = `forms/${formIdStr}/`;
  const stagingPrefix = `staging/forms/${formIdStr}/`;
  let subpath = null;
  if (key.startsWith(permanentPrefix)) {
    subpath = key.slice(permanentPrefix.length);
  } else if (key.startsWith(stagingPrefix)) {
    subpath = key.slice(stagingPrefix.length);
  }

  if (subpath !== null) {
    if (
      subpath.length > 0 &&
      !subpath.startsWith('/') &&
      !subpath.includes('//') &&
      /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/.test(subpath)
    ) {
      return { category: 'A', key };
    }
    return { category: 'B', key, reason: 'Malformed path within form namespace' };
  }

  // Category C: Unrecognized or unresolved legacy key (safe from traversal and foreign attacks, but outside current prefix)
  return { category: 'C', key, reason: 'Legacy or non-standard key outside form namespace' };
};

const collectFormStorageKeys = (
  formIdStr,
  responses = [],
  formQuestions = [],
  extraCandidates = []
) => {
  const validKeySet = new Set();
  const unresolvedKeySet = new Set();
  const blockedKeySet = new Set();

  const processCandidate = (candidate, responseId = null) => {
    if (!candidate || typeof candidate !== 'string') return;
    const classification = classifyStorageKey(candidate, formIdStr);
    if (classification.category === 'A') {
      validKeySet.add(classification.key);
    } else if (classification.category === 'C') {
      unresolvedKeySet.add(classification.key);
    } else {
      blockedKeySet.add(classification.key);
      logger.warn('storage.malicious_or_foreign_key_blocked', {
        formId: formIdStr,
        responseId,
        key: classification.key,
        reason: classification.reason
      });
    }
  };

  for (const candidate of extraCandidates) {
    processCandidate(candidate);
  }

  const fileQuestionIds = new Set(
    formQuestions.filter((q) => q.type === 'file').map((q) => q._id.toString())
  );
  const nonFileQuestionIds = new Set(
    formQuestions.filter((q) => q.type !== 'file').map((q) => q._id.toString())
  );

  for (const r of responses) {
    if (!Array.isArray(r?.answers)) continue;
    for (const answer of r.answers) {
      if (!answer?.value) continue;
      const qIdStr = answer.questionId ? answer.questionId.toString() : '';
      const isKnownNonFile = nonFileQuestionIds.has(qIdStr);
      const isKnownFile = fileQuestionIds.has(qIdStr);

      if (typeof answer.value === 'object' && !Array.isArray(answer.value)) {
        if (typeof answer.value.key === 'string') {
          processCandidate(answer.value.key, r._id);
        }
      } else if (Array.isArray(answer.value)) {
        for (const item of answer.value) {
          if (item && typeof item === 'object' && typeof item.key === 'string') {
            processCandidate(item.key, r._id);
          } else if (
            typeof item === 'string' &&
            (isKnownFile ||
              (!isKnownNonFile &&
                (item.startsWith('forms/') ||
                  item.startsWith('uploads/') ||
                  item.startsWith('attachments/'))))
          ) {
            processCandidate(item, r._id);
          }
        }
      } else if (
        typeof answer.value === 'string' &&
        (isKnownFile ||
          (!isKnownNonFile &&
            (answer.value.startsWith('forms/') ||
              answer.value.startsWith('uploads/') ||
              answer.value.startsWith('attachments/'))))
      ) {
        processCandidate(answer.value, r._id);
      }
    }
  }

  return { validKeySet, unresolvedKeySet, blockedKeySet };
};

/**
 * Ownership-verified CAS lease release helper.
 * Once a Form has entered 'deleting', it may ONLY transition to 'delete_failed' (never back to live statuses).
 *
 * @param {string|mongoose.Types.ObjectId} formId
 * @param {string} leaseId
 * @param {number} epoch
 * @param {'delete_failed'} [nextStatus='delete_failed']
 * @param {string|null} [errorMessage=null]
 * @returns {Promise<{ released: boolean }>}
 */
export const releaseDeletionLease = async (
  formId,
  leaseId,
  epoch,
  nextStatus = 'delete_failed',
  errorMessage = null
) => {
  if (nextStatus !== 'delete_failed') {
    throw new Error(`Invalid post-claim deletion transition target: ${nextStatus}`);
  }
  const updateSet = {
    status: 'delete_failed',
    'deletionProgress.stage': 'failed',
    'deletionProgress.leaseId': null,
    'deletionProgress.leaseExpiresAt': null,
    'deletionProgress.updatedAt': new Date()
  };
  if (errorMessage) {
    updateSet['deletionProgress.error'] = errorMessage;
  }
  const res = await Form.updateOne(
    {
      _id: formId,
      status: 'deleting',
      'deletionProgress.leaseId': leaseId,
      'deletionProgress.epoch': epoch
    },
    { $set: updateSet }
  );
  return { released: res.matchedCount > 0 };
};

/**
 * Core deletion saga engine.
 * Claims Form inside a mandatory replica-set transaction (T_claim), executes bounded S3
 * cleanup outside transactions, and performs atomic MongoDB cascade deletion (T_del).
 *
 * @param {string|mongoose.Types.ObjectId} formId
 * @param {object} options
 * @param {string} [options.userId] - Required for owner authorization; omitted for system recovery
 * @param {boolean} [options.isSystemRecovery=false]
 * @param {number} [options.drainWaitMs=0]
 * @returns {Promise<{ success: boolean, statusCode: number, message: string, retryAfter?: number, data?: any }>}
 */
export const executeFormDeletion = async (formId, options = {}) =>
  trackDeletionTask(
    (async () => {
      const { userId, isSystemRecovery = false, drainWaitMs = 0 } = options;

      // 1. Optional polite drain window BEFORE transactional claim if requested
      if (drainWaitMs > 0) {
        const preliminaryForm = await Form.findById(formId).lean();
        if (!preliminaryForm) {
          return { success: false, statusCode: 404, message: 'Form not found' };
        }
        if (!isSystemRecovery && userId && preliminaryForm.ownerId.toString() !== userId) {
          return {
            success: false,
            statusCode: 403,
            message: 'Not authorized to delete this form'
          };
        }
        const preNow = new Date();
        const hasPreLease =
          preliminaryForm.status === 'deleting' &&
          preliminaryForm.deletionProgress?.leaseId &&
          preliminaryForm.deletionProgress?.leaseExpiresAt &&
          new Date(preliminaryForm.deletionProgress.leaseExpiresAt) > preNow;
        if (!hasPreLease) {
          await SubmissionReservationManager.drainActive(formId, drainWaitMs);
        }
      }

      // 2. Transactional Claim (T_claim) inside mandatory replica-set transaction
      const claimResult = await withRequiredTransaction(async (session) => {
        const txNow = new Date();
        const existingForm = await Form.findById(formId).session(session);
        if (!existingForm) {
          return { claimed: false, statusCode: 404, message: 'Form not found' };
        }

        if (!isSystemRecovery && userId && existingForm.ownerId.toString() !== userId) {
          return {
            claimed: false,
            statusCode: 403,
            message: 'Not authorized to delete this form'
          };
        }

        const hasActiveLease =
          existingForm.status === 'deleting' &&
          existingForm.deletionProgress?.leaseId &&
          existingForm.deletionProgress?.leaseExpiresAt &&
          new Date(existingForm.deletionProgress.leaseExpiresAt) > txNow;

        if (hasActiveLease) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil(
              (new Date(existingForm.deletionProgress.leaseExpiresAt).getTime() - txNow.getTime()) /
                1000
            )
          );
          return {
            claimed: false,
            statusCode: 409,
            message: 'Form is currently being deleted',
            retryAfter: retryAfterSeconds,
            data: {
              stage: existingForm.deletionProgress?.stage || 'pending',
              retryAfter: retryAfterSeconds
            }
          };
        }

        // Expire any timed-out active/committing reservations inside same transaction (preserve stagedKeys)
        await SubmissionReservation.updateMany(
          {
            formId: existingForm._id,
            status: { $in: ['active', 'committing'] },
            expiresAt: { $lte: txNow }
          },
          {
            $set: {
              status: 'abandoned',
              counterReleased: true,
              vacuumAt: null,
              updatedAt: txNow
            }
          },
          { session }
        );

        const activeRecords = await SubmissionReservation.find({
          formId: existingForm._id,
          status: { $in: ['active', 'committing'] },
          expiresAt: { $gt: txNow }
        })
          .select('expiresAt')
          .session(session)
          .lean();

        const legacyActive =
          existingForm.status !== 'deleting' &&
          (existingForm.activeSubmissions || 0) > 0 &&
          (!existingForm.activeSubmissionsExpiresAt ||
            new Date(existingForm.activeSubmissionsExpiresAt) > txNow);

        if (activeRecords.length > 0 || legacyActive) {
          const maxExpiry =
            activeRecords.length > 0
              ? Math.max(...activeRecords.map((r) => new Date(r.expiresAt).getTime()))
              : txNow.getTime() + 5000;
          const retryAfter = Math.min(5, Math.max(1, Math.ceil((maxExpiry - Date.now()) / 1000)));
          return {
            claimed: false,
            statusCode: 409,
            message: 'Form has submissions in flight. Please retry shortly.',
            retryAfter,
            data: {
              activeSubmissions: activeRecords.length || existingForm.activeSubmissions,
              retryAfter
            }
          };
        }

        const leaseId = crypto.randomUUID();
        const leaseExpiresAt = new Date(txNow.getTime() + DELETION_LEASE_TTL_MS);
        const nextStage =
          existingForm.deletionProgress?.stage &&
          !['failed', 'completed'].includes(existingForm.deletionProgress.stage)
            ? existingForm.deletionProgress.stage
            : 's3_cleanup';

        const claimFilter = {
          _id: existingForm._id,
          ...(!isSystemRecovery && userId ? { ownerId: userId } : {}),
          $or: [
            { status: { $in: ['draft', 'published', 'closed', 'delete_failed'] } },
            {
              status: 'deleting',
              $or: [
                { 'deletionProgress.leaseExpiresAt': { $lte: txNow } },
                { 'deletionProgress.leaseExpiresAt': null },
                { 'deletionProgress.leaseId': null }
              ]
            }
          ]
        };

        if (existingForm.status !== 'deleting') {
          claimFilter.$and = [
            {
              $or: [
                { activeSubmissions: { $lte: 0 } },
                { activeSubmissions: null },
                {
                  activeSubmissions: { $gt: 0 },
                  activeSubmissionsExpiresAt: { $ne: null, $lte: txNow }
                }
              ]
            }
          ];
        }

        const claimedForm = await Form.findOneAndUpdate(
          claimFilter,
          {
            $set: {
              status: 'deleting',
              activeSubmissions: 0,
              activeSubmissionsExpiresAt: null,
              'deletionProgress.leaseId': leaseId,
              'deletionProgress.leaseExpiresAt': leaseExpiresAt,
              'deletionProgress.stage': nextStage,
              'deletionProgress.startedAt': existingForm.deletionProgress?.startedAt || txNow,
              'deletionProgress.updatedAt': txNow,
              'deletionProgress.error': null
            },
            $inc: {
              lifecycleVersion: 1,
              'deletionProgress.epoch': 1
            }
          },
          { session, new: true }
        );

        if (!claimedForm) {
          return {
            claimed: false,
            statusCode: 409,
            message: 'Form is currently being deleted'
          };
        }

        return {
          claimed: true,
          claimedForm,
          leaseId,
          epoch: claimedForm.deletionProgress?.epoch || 1
        };
      });

      if (!claimResult.claimed) {
        const resObj = {
          success: false,
          statusCode: claimResult.statusCode,
          message: claimResult.message
        };
        if (claimResult.retryAfter !== undefined) resObj.retryAfter = claimResult.retryAfter;
        if (claimResult.data !== undefined) resObj.data = claimResult.data;
        return resObj;
      }

      const { claimedForm, leaseId, epoch } = claimResult;

      // Set up periodic lease heartbeat renewal with overlap prevention & epoch fencing
      let heartbeatTimer = null;
      let heartbeatInFlight = null;
      let leaseLost = false;

      const startHeartbeat = () => {
        const intervalMs = Math.max(1000, Math.floor(DELETION_LEASE_TTL_MS / 3));
        heartbeatTimer = setInterval(() => {
          if (heartbeatInFlight || leaseLost) {
            return;
          }
          heartbeatInFlight = (async () => {
            try {
              const res = await Form.updateOne(
                {
                  _id: claimedForm._id,
                  status: 'deleting',
                  'deletionProgress.leaseId': leaseId,
                  'deletionProgress.epoch': epoch
                },
                {
                  $set: {
                    'deletionProgress.leaseExpiresAt': new Date(Date.now() + DELETION_LEASE_TTL_MS),
                    'deletionProgress.updatedAt': new Date()
                  }
                }
              );
              if (res.matchedCount === 0) {
                leaseLost = true;
                if (heartbeatTimer) {
                  clearInterval(heartbeatTimer);
                  heartbeatTimer = null;
                }
                logger.warn('form.deletion_lease_heartbeat_lost', {
                  formId: claimedForm._id,
                  leaseId,
                  epoch
                });
              }
            } catch (err) {
              logger.warn('form.deletion_lease_heartbeat_error', {
                formId: claimedForm._id,
                leaseId,
                epoch,
                error: err.message
              });
            } finally {
              heartbeatInFlight = null;
            }
          })();
        }, intervalMs);
        if (heartbeatTimer.unref) heartbeatTimer.unref();
      };

      try {
        startHeartbeat();

        const isS3Stage =
          claimedForm.deletionProgress?.stage === 's3_cleanup' ||
          claimedForm.deletionProgress?.stage === 'pending';

        if (isS3Stage) {
          const formIdStr = claimedForm._id.toString();
          const responses = await Response.find({ formId: claimedForm._id }, 'answers').lean();
          const reservations = await SubmissionReservation.find(
            { formId: claimedForm._id },
            'stagedKeys promotedKeys'
          ).lean();
          const formQuestions = await Question.find({ formId: claimedForm._id }, '_id type').lean();

          const extraCandidates = [];
          if (Array.isArray(claimedForm.deletionProgress?.failedKeys)) {
            extraCandidates.push(...claimedForm.deletionProgress.failedKeys);
          }
          if (Array.isArray(claimedForm.deletionProgress?.unresolvedKeys)) {
            extraCandidates.push(...claimedForm.deletionProgress.unresolvedKeys);
          }
          for (const resItem of reservations) {
            if (Array.isArray(resItem.stagedKeys)) {
              extraCandidates.push(...resItem.stagedKeys);
            }
            if (Array.isArray(resItem.promotedKeys)) {
              extraCandidates.push(...resItem.promotedKeys);
            }
          }

          const { validKeySet, unresolvedKeySet } = collectFormStorageKeys(
            formIdStr,
            responses,
            formQuestions,
            extraCandidates
          );

          // Halt before S3 deletion if unresolved legacy keys (Category C) exist
          if (unresolvedKeySet.size > 0) {
            const unresolvedList = Array.from(unresolvedKeySet);
            logger.warn('form.deletion_halted_unresolved_keys', {
              formId: claimedForm._id,
              unresolvedCount: unresolvedList.length,
              unresolvedKeys: unresolvedList
            });

            const unresolvedUpdate = await Form.updateOne(
              {
                _id: claimedForm._id,
                status: 'deleting',
                'deletionProgress.leaseId': leaseId,
                'deletionProgress.epoch': epoch
              },
              {
                $set: {
                  status: 'delete_failed',
                  'deletionProgress.stage': 'failed',
                  'deletionProgress.unresolvedKeys': unresolvedList,
                  'deletionProgress.error':
                    'Unresolved legacy storage keys detected; MongoDB cascade blocked to prevent orphaned files',
                  'deletionProgress.leaseId': null,
                  'deletionProgress.leaseExpiresAt': null,
                  'deletionProgress.updatedAt': new Date()
                }
              }
            );

            if (unresolvedUpdate.matchedCount === 0) {
              return {
                success: false,
                statusCode: 409,
                message: 'Deletion lease expired or was reclaimed by another worker'
              };
            }

            return {
              success: false,
              statusCode: 502,
              message:
                'Form contains unresolved legacy storage files. Deletion halted to prevent orphaned files.',
              data: { unresolvedKeys: unresolvedList }
            };
          }

          const s3KeysToDelete = Array.from(validKeySet);

          if (s3KeysToDelete.length > 0) {
            if (leaseLost) {
              logger.warn('form.deletion_lease_lost_before_s3', {
                formId: claimedForm._id,
                leaseId,
                epoch
              });
              return {
                success: false,
                statusCode: 409,
                message: 'Deletion lease expired or was reclaimed by another worker'
              };
            }

            const stillOwned = await Form.exists({
              _id: claimedForm._id,
              status: 'deleting',
              'deletionProgress.leaseId': leaseId,
              'deletionProgress.epoch': epoch,
              'deletionProgress.leaseExpiresAt': { $gt: new Date() }
            });

            if (!stillOwned) {
              logger.warn('form.deletion_lease_lost_before_s3', {
                formId: claimedForm._id,
                leaseId,
                epoch
              });
              return {
                success: false,
                statusCode: 409,
                message: 'Deletion lease expired or was reclaimed by another worker'
              };
            }

            let batchResult;
            try {
              batchResult = await storageService.deleteFiles(s3KeysToDelete);
            } catch (s3Err) {
              batchResult = {
                success: false,
                failedKeys: s3KeysToDelete,
                deletedKeys: [],
                error: s3Err.message
              };
            }

            if (leaseLost) {
              logger.warn('form.deletion_lease_lost_during_s3_batch', {
                formId: claimedForm._id,
                leaseId,
                epoch
              });
              return {
                success: false,
                statusCode: 409,
                message: 'Deletion lease expired or was reclaimed by another worker'
              };
            }

            if (
              !batchResult?.success &&
              Array.isArray(batchResult?.failedKeys) &&
              batchResult.failedKeys.length > 0
            ) {
              const failedKeyList = batchResult.failedKeys
                .map((f) => (typeof f === 'string' ? f : f?.key))
                .filter((k) => classifyStorageKey(k, formIdStr).category === 'A');

              const failUpdate = await Form.updateOne(
                {
                  _id: claimedForm._id,
                  status: 'deleting',
                  'deletionProgress.leaseId': leaseId,
                  'deletionProgress.epoch': epoch
                },
                {
                  $set: {
                    status: 'delete_failed',
                    'deletionProgress.stage': 'failed',
                    'deletionProgress.failedKeys': failedKeyList,
                    'deletionProgress.deletedFiles': (batchResult.deletedKeys || []).length,
                    'deletionProgress.error': 'Failed to delete some storage files',
                    'deletionProgress.leaseId': null,
                    'deletionProgress.leaseExpiresAt': null,
                    'deletionProgress.updatedAt': new Date()
                  }
                }
              );

              if (failUpdate.matchedCount === 0) {
                return {
                  success: false,
                  statusCode: 409,
                  message: 'Deletion lease expired or was reclaimed by another worker'
                };
              }

              logger.warn('form.s3_delete_batch_failed', {
                formId: claimedForm._id,
                failedCount: failedKeyList.length,
                failedKeys: failedKeyList
              });

              return {
                success: false,
                statusCode: 502,
                message: 'Failed to delete some attached storage files. Deletion can be retried.',
                data: { failedKeys: batchResult.failedKeys }
              };
            }
          }

          if (leaseLost) {
            logger.warn('form.deletion_lease_lost_before_mongo_cleanup', {
              formId: claimedForm._id,
              leaseId,
              epoch
            });
            return {
              success: false,
              statusCode: 409,
              message: 'Deletion lease expired or was reclaimed by another worker'
            };
          }

          const advanceResult = await Form.updateOne(
            {
              _id: claimedForm._id,
              status: 'deleting',
              'deletionProgress.leaseId': leaseId,
              'deletionProgress.epoch': epoch,
              'deletionProgress.leaseExpiresAt': { $gt: new Date() }
            },
            {
              $set: {
                'deletionProgress.stage': 'mongo_cleanup',
                'deletionProgress.failedKeys': [],
                'deletionProgress.leaseExpiresAt': new Date(Date.now() + DELETION_LEASE_TTL_MS),
                'deletionProgress.updatedAt': new Date()
              }
            }
          );

          if (advanceResult.matchedCount === 0) {
            logger.warn('form.deletion_lease_lost_before_mongo_cleanup', {
              formId: claimedForm._id,
              leaseId,
              epoch
            });
            return {
              success: false,
              statusCode: 409,
              message: 'Deletion lease expired or was reclaimed by another worker'
            };
          }
        }

        // 3. Atomic MongoDB cascade deletion (T_del) inside mandatory replica-set transaction
        await withRequiredTransaction(async (session) => {
          if (leaseLost) {
            const leaseLostErr = new Error('DELETION_LEASE_LOST');
            leaseLostErr.code = 'LEASE_LOST';
            throw leaseLostErr;
          }

          const ownedForm = await Form.findOneAndUpdate(
            {
              _id: claimedForm._id,
              status: 'deleting',
              'deletionProgress.leaseId': leaseId,
              'deletionProgress.epoch': epoch,
              'deletionProgress.leaseExpiresAt': { $gt: new Date() }
            },
            {
              $inc: { lifecycleVersion: 1 },
              $set: {
                'deletionProgress.stage': 'mongo_form',
                'deletionProgress.updatedAt': new Date()
              }
            },
            { session, new: true }
          );

          if (!ownedForm) {
            const leaseLostErr = new Error('DELETION_LEASE_LOST');
            leaseLostErr.code = 'LEASE_LOST';
            throw leaseLostErr;
          }

          await Response.deleteMany({ formId: claimedForm._id }, { session });
          await Question.deleteMany({ formId: claimedForm._id }, { session });
          await SubmissionReservation.deleteMany({ formId: claimedForm._id }, { session });

          // Atomically persist durable S3 cleanup job before dropping Form
          const defaultGraceMs = DELETION_CLEANUP_GRACE_MS;
          const cleanupGraceMs =
            options.cleanupGraceMs !== undefined ? options.cleanupGraceMs : defaultGraceMs;
          const eligibleUntil = new Date(Date.now() + cleanupGraceMs);

          await DeletionCleanupJob.findOneAndUpdate(
            { formId: claimedForm._id },
            {
              $setOnInsert: {
                formId: claimedForm._id,
                stagingPrefix: `staging/forms/${claimedForm._id}/`,
                finalPrefix: `forms/${claimedForm._id}/`,
                eligibleUntil,
                createdAt: new Date()
              },
              $set: {
                status: 'pending',
                nextSweepAt: new Date(),
                leaseId: null,
                leaseExpiresAt: null,
                vacuumAt: null,
                updatedAt: new Date()
              }
            },
            { session, upsert: true }
          );

          const delResult = await Form.deleteOne(
            {
              _id: claimedForm._id,
              status: 'deleting',
              'deletionProgress.leaseId': leaseId,
              'deletionProgress.epoch': epoch
            },
            { session }
          );

          if (delResult.deletedCount === 0) {
            const leaseLostErr = new Error('DELETION_LEASE_LOST');
            leaseLostErr.code = 'LEASE_LOST';
            throw leaseLostErr;
          }
        });

        // Trigger immediate non-blocking sweep of the DeletionCleanupJob outside transaction
        if (options.awaitCleanup) {
          await processDeletionCleanupJob(claimedForm._id);
        } else if (!options.skipImmediateCleanup) {
          processDeletionCleanupJob(claimedForm._id).catch((err) => {
            logger.warn('form.post_del_cleanup_job_sweep_failed', {
              formId: claimedForm._id,
              error: err.message
            });
          });
        }

        return {
          success: true,
          statusCode: 200,
          message: 'Form deleted successfully'
        };
      } catch (cascadeError) {
        if (cascadeError.code === 'LEASE_LOST' || cascadeError.message === 'DELETION_LEASE_LOST') {
          logger.warn('form.deletion_lease_lost_during_cascade', {
            formId: claimedForm._id,
            leaseId,
            epoch
          });
          return {
            success: false,
            statusCode: 409,
            message: 'Deletion lease expired or was reclaimed by another worker'
          };
        }

        await releaseDeletionLease(
          claimedForm._id,
          leaseId,
          epoch,
          'delete_failed',
          cascadeError.message
        ).catch(() => {});

        throw cascadeError;
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        if (heartbeatInFlight) {
          await heartbeatInFlight.catch(() => {});
        }
      }
    })()
  );

/**
 * @route   DELETE /api/forms/:id
 * @desc    Delete form and all associated questions/responses with atomic lease recovery
 * @access  Private (owner only)
 */
export const deleteForm = async (req, res, next) => {
  try {
    const result = await executeFormDeletion(req.params.id, { userId: req.user.id });
    if (result.retryAfter) {
      res.set('Retry-After', String(result.retryAfter));
    }
    const responsePayload = {
      success: result.success,
      message: result.message
    };
    if (result.data) {
      responsePayload.data = result.data;
    }
    return res.status(result.statusCode).json(responsePayload);
  } catch (error) {
    next(error);
  }
};

/**
 * Background heartbeat helper for DeletionCleanupJob workers.
 * Recursively schedules CAS lease renewals during prolonged storage operations
 * (both single-page and multi-page prefix scans), tracks in-flight renewal promises,
 * detects wall-clock expiration, and provides fail-closed ownership barriers.
 */
export class CleanupLeaseHeartbeat {
  constructor({ jobId, leaseId, epoch, leaseDurationMs, intervalMs }) {
    this.jobId = jobId;
    this.leaseId = leaseId;
    this.epoch = epoch;
    this.leaseDurationMs = leaseDurationMs;
    this.intervalMs = intervalMs || Math.max(50, Math.floor(leaseDurationMs / 3));
    this.timer = null;
    this.stopped = false;
    this.inFlightPromise = null;
    this.leaseLost = false;
    this.hasError = false;
    this.lastError = null;
    // Authoritative local timestamp of confirmed lease expiration
    this.confirmedExpiresAtMs = Date.now() + this.leaseDurationMs;
  }

  start() {
    this.scheduleNext();
  }

  isExpired(clockToleranceMs = 0) {
    return Date.now() >= this.confirmedExpiresAtMs - clockToleranceMs;
  }

  scheduleNext() {
    if (this.stopped || this.leaseLost || this.hasError) return;
    this.timer = setTimeout(async () => {
      if (this.stopped || this.leaseLost || this.hasError) return;
      await this.renew();
      if (!this.stopped && !this.leaseLost && !this.hasError) {
        this.scheduleNext();
      }
    }, this.intervalMs);
  }

  async waitForInFlight() {
    if (this.inFlightPromise) {
      await this.inFlightPromise.catch(() => {});
    }
  }

  renew() {
    if (this.stopped || this.leaseLost) {
      return Promise.resolve(false);
    }
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const now = Date.now();
        const updateResult = await DeletionCleanupJob.updateOne(
          {
            _id: this.jobId,
            status: 'cleaning',
            leaseId: this.leaseId,
            epoch: this.epoch
          },
          {
            $set: {
              leaseExpiresAt: new Date(now + this.leaseDurationMs),
              updatedAt: new Date(now)
            }
          }
        );
        if (updateResult.matchedCount === 0) {
          // Ownership fencing: lease was reclaimed by another worker, epoch bumped, or status changed
          this.leaseLost = true;
          return false;
        }
        // Only advance locally recorded expiry when MongoDB confirms the update
        this.confirmedExpiresAtMs = now + this.leaseDurationMs;
        this.hasError = false;
        this.lastError = null;
        return true;
      } catch (err) {
        // Fail closed: record error state so worker cannot assume valid ownership
        this.hasError = true;
        this.lastError = err;
        logger.warn('storage.cleanup_heartbeat_error', {
          jobId: this.jobId,
          error: err.message
        });
        return false;
      } finally {
        this.inFlightPromise = null;
      }
    })();

    // Suppress unhandled rejection if background caller does not await
    this.inFlightPromise.catch(() => {});

    return this.inFlightPromise;
  }

  async assertOwnershipOrRenew() {
    if (this.stopped || this.leaseLost) {
      return false;
    }

    // 1. Await any renewal operation already in progress
    await this.waitForInFlight();

    // 2. Fail closed if ownership lost, DB error occurred, or locally confirmed lease expired
    if (this.leaseLost || this.hasError || this.isExpired()) {
      return false;
    }

    // 3. Perform a fresh atomic ownership confirmation/renewal
    const renewed = await this.renew();
    if (!renewed || this.leaseLost || this.hasError || this.isExpired()) {
      return false;
    }

    return true;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.waitForInFlight();
  }
}

/**
 * Processes a single DeletionCleanupJob tombstone.
 * Fenced by CAS lease (leaseId, epoch, leaseExpiresAt).
 *
 * @param {string|mongoose.Types.ObjectId|object} jobOrFormId
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.leaseTtlMs=30000]
 * @returns {Promise<{ processed: boolean, status: string, deletedCount: number, error?: string }>}
 */
export const processDeletionCleanupJob = async (jobOrFormId, options = {}) => {
  const { signal, leaseTtlMs = 30000, leaseDurationMs = leaseTtlMs } = options;
  const now = new Date();
  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  let jobFilter;
  if (jobOrFormId && typeof jobOrFormId === 'object') {
    if (jobOrFormId.stagingPrefix || jobOrFormId.finalPrefix) {
      // It's a DeletionCleanupJob document or plain object
      jobFilter = { _id: jobOrFormId._id };
    } else if (jobOrFormId._id && !(jobOrFormId instanceof mongoose.Types.ObjectId)) {
      // It's a Form document
      jobFilter = { formId: jobOrFormId._id };
    } else {
      // It's a mongoose.Types.ObjectId
      jobFilter = { formId: jobOrFormId };
    }
  } else if (typeof jobOrFormId === 'string' && isValidObjectId(jobOrFormId)) {
    jobFilter = { formId: jobOrFormId };
  } else {
    return { processed: false, status: 'invalid_argument' };
  }

  const existingJob = await DeletionCleanupJob.findOne(jobFilter).lean();
  if (existingJob && existingJob.status === 'completed') {
    return { processed: false, status: 'completed', alreadyCompleted: true, deletedCount: 0 };
  }
  if (
    existingJob &&
    existingJob.status === 'reconciled' &&
    existingJob.nextSweepAt &&
    new Date(existingJob.nextSweepAt).getTime() > now.getTime() &&
    !options.forceImmediate
  ) {
    return { processed: false, status: 'reconciled', alreadyReconciled: true, deletedCount: 0 };
  }

  const query = {
    ...jobFilter,
    $or: [
      { status: { $in: ['pending', 'failed'] } },
      {
        status: 'reconciled',
        ...(options.forceImmediate
          ? {}
          : {
              $or: [
                { nextSweepAt: null },
                { nextSweepAt: { $exists: false } },
                { nextSweepAt: { $lte: now } }
              ]
            })
      },
      { status: 'cleaning', leaseExpiresAt: { $lt: now } }
    ],
    $and: [{ $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: now } }] }]
  };

  const claimed = await DeletionCleanupJob.findOneAndUpdate(
    query,
    {
      $set: {
        status: 'cleaning',
        leaseId,
        leaseExpiresAt,
        updatedAt: now
      },
      $inc: { epoch: 1, attempts: 1 }
    },
    { new: true }
  );

  if (!claimed) {
    return { processed: false, status: 'unclaimed' };
  }

  const epoch = claimed.epoch;
  let totalDeleted = 0;

  const heartbeat = new CleanupLeaseHeartbeat({
    jobId: claimed._id,
    leaseId,
    epoch,
    leaseDurationMs,
    intervalMs: options.heartbeatIntervalMs
  });
  heartbeat.start();

  try {
    if (signal?.aborted) {
      await DeletionCleanupJob.updateOne(
        { _id: claimed._id, leaseId, epoch },
        { $set: { status: 'pending', leaseId: null, leaseExpiresAt: null, updatedAt: new Date() } }
      );
      return { processed: false, status: 'aborted' };
    }

    // List all objects across staging and final namespaces
    const prefixes = [claimed.stagingPrefix, claimed.finalPrefix].filter(Boolean);
    const discoveredKeys = [];

    for (const prefix of prefixes) {
      let continuationToken = undefined;
      let pageCount = 0;
      do {
        if (signal?.aborted || heartbeat.leaseLost || heartbeat.hasError || heartbeat.isExpired())
          break;
        pageCount++;
        if (pageCount > 1) {
          // Additional immediate heartbeat renewal during pagination transitions
          await heartbeat.renew();
        }
        const listResult = await storageService.listObjectsByPrefix(prefix, {
          continuationToken,
          signal
        });
        if (Array.isArray(listResult?.keys) && listResult.keys.length > 0) {
          discoveredKeys.push(...listResult.keys);
        }
        continuationToken = listResult?.isTruncated ? listResult.nextContinuationToken : undefined;
      } while (continuationToken);
    }

    // Pre-deletion ownership barrier:
    // Awaits any in-flight renewal, verifies fail-closed state & local expiry,
    // and executes a fresh atomic CAS renewal against MongoDB before invoking deleteFiles.
    const ownershipConfirmed = await heartbeat.assertOwnershipOrRenew();
    if (!ownershipConfirmed) {
      logger.warn('storage.cleanup_lease_lost_during_listing', {
        jobId: claimed._id,
        formId: claimed.formId,
        epoch,
        reason: heartbeat.leaseLost
          ? 'lease_lost'
          : heartbeat.hasError
            ? 'db_error'
            : heartbeat.isExpired()
              ? 'expired'
              : 'unconfirmed'
      });
      return { processed: false, status: 'lease_lost' };
    }

    // Deduplicate and delete discovered keys
    const uniqueKeys = Array.from(new Set(discoveredKeys));
    let hasFailedKeys = false;
    let deleteErrorMsg = null;

    if (uniqueKeys.length > 0) {
      const deleteResult = await storageService.deleteFiles(uniqueKeys, { signal });
      totalDeleted = (deleteResult?.deletedKeys || []).length;
      if (!deleteResult?.success || (deleteResult?.failedKeys || []).length > 0) {
        hasFailedKeys = true;
        deleteErrorMsg = deleteResult?.error || 'Failed to delete some storage files';
      }
    }

    if (heartbeat.leaseLost || heartbeat.hasError) {
      logger.warn('storage.cleanup_lease_lost_after_deletion', {
        jobId: claimed._id,
        formId: claimed.formId,
        epoch
      });
      return { processed: false, status: 'lease_lost' };
    }

    const checkNow = new Date();
    const isPastGrace = checkNow.getTime() >= new Date(claimed.eligibleUntil).getTime();

    if (hasFailedKeys) {
      const nextStatus = claimed.attempts >= (claimed.maxAttempts || 10) ? 'failed' : 'pending';
      await DeletionCleanupJob.updateOne(
        { _id: claimed._id, leaseId, epoch },
        {
          $set: {
            status: nextStatus,
            leaseId: null,
            leaseExpiresAt: null,
            lastError: deleteErrorMsg,
            'stats.objectsDeleted': (claimed.stats?.objectsDeleted || 0) + totalDeleted,
            'stats.lastSweepAt': checkNow,
            updatedAt: checkNow
          }
        }
      );
      return {
        processed: true,
        status: nextStatus,
        deletedCount: totalDeleted,
        error: deleteErrorMsg
      };
    }

    // Verify remaining objects across prefixes
    let remainingCount = 0;
    for (const prefix of prefixes) {
      const verifyList = await storageService.listObjectsByPrefix(prefix, { maxKeys: 1, signal });
      if ((verifyList?.keys || []).length > 0) {
        remainingCount += verifyList.keys.length;
      }
    }

    // If grace period has passed and 0 objects remain:
    // Mark as 'reconciled' (never retire to completed or vacuumAt TTL).
    // The tombstone continues perpetually reconciling with bounded exponential backoff.
    if (isPastGrace && remainingCount === 0) {
      const currentPasses = claimed.reconciliationPasses || 0;
      const sweepDelayMs =
        options.reconcileIntervalMs !== undefined
          ? options.reconcileIntervalMs
          : calculateNextSweepDelay(currentPasses);
      const nextSweepAt = new Date(checkNow.getTime() + sweepDelayMs);

      await DeletionCleanupJob.updateOne(
        { _id: claimed._id, leaseId, epoch },
        {
          $set: {
            status: 'reconciled',
            reconciliationPasses: currentPasses + 1,
            lastReconciledAt: checkNow,
            nextSweepAt,
            vacuumAt: null, // Perpetual TTL immunity
            leaseId: null,
            leaseExpiresAt: null,
            lastError: null,
            'stats.objectsDeleted': (claimed.stats?.objectsDeleted || 0) + totalDeleted,
            'stats.lastSweepAt': checkNow,
            updatedAt: checkNow
          }
        }
      );
      return { processed: true, status: 'reconciled', deletedCount: totalDeleted };
    }

    // Still within grace period, or remaining objects found: release lease to allow future sweep
    await DeletionCleanupJob.updateOne(
      { _id: claimed._id, leaseId, epoch },
      {
        $set: {
          status: 'pending',
          nextSweepAt: new Date(checkNow.getTime() + 1000),
          leaseId: null,
          leaseExpiresAt: null,
          lastError: null,
          'stats.objectsDeleted': (claimed.stats?.objectsDeleted || 0) + totalDeleted,
          'stats.lastSweepAt': checkNow,
          updatedAt: checkNow
        }
      }
    );

    return { processed: true, status: 'pending', deletedCount: totalDeleted };
  } catch (err) {
    logger.warn('deletion.cleanup_job_processing_error', {
      jobId: claimed._id,
      formId: claimed.formId,
      error: err.message
    });

    const nextStatus = claimed.attempts >= (claimed.maxAttempts || 10) ? 'failed' : 'pending';
    await DeletionCleanupJob.updateOne(
      { _id: claimed._id, leaseId, epoch },
      {
        $set: {
          status: nextStatus,
          nextSweepAt: new Date(Date.now() + 5000),
          leaseId: null,
          leaseExpiresAt: null,
          lastError: err.message,
          updatedAt: new Date()
        }
      }
    ).catch(() => {});

    return {
      processed: false,
      status: nextStatus,
      deletedCount: totalDeleted,
      error: err.message
    };
  } finally {
    await heartbeat.stop();
  }
};

/**
 * Startup & background recovery hook: sweeps abandoned deletions, orphaned responses
 * (cleaning S3 files first), orphaned reservations (preserving failed keys),
 * expired submission leases on live forms, and orphaned questions.
 *
 * @param {object} [options]
 * @param {number} [options.batchSize=20]
 * @param {number} [options.reservationGraceMs=5000]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ recoveredCount: number, failedCount: number, sweptOrphanResponses: number, sweptOrphanReservations: number, sweptOrphanQuestions: number }>}
 */
export const recoverAbandonedFormDeletions = async (options = {}) =>
  trackDeletionTask(
    (async () => {
      const resultSummary = {
        recoveredCount: 0,
        failedCount: 0,
        sweptOrphanResponses: 0,
        sweptOrphanReservations: 0,
        sweptOrphanQuestions: 0,
        completedCleanupJobs: 0,
        purgedStorageFiles: 0
      };

      if (!mongoose.connection || mongoose.connection.readyState !== 1) {
        return resultSummary;
      }

      const { signal } = options;
      if (signal?.aborted) {
        return resultSummary;
      }

      const batchSize = options.batchSize || 20;
      const now = new Date();

      // 1. Recover abandoned deleting forms
      try {
        const abandonedForms = await Form.find({
          status: 'deleting',
          $or: [
            { 'deletionProgress.leaseExpiresAt': { $lt: now } },
            { 'deletionProgress.leaseExpiresAt': null },
            { 'deletionProgress.leaseId': null }
          ]
        })
          .limit(batchSize)
          .lean();

        if (abandonedForms.length > 0) {
          logger.info(`Found ${abandonedForms.length} abandoned form deletion(s) to recover.`, {
            event: 'deletion.recovery_started',
            count: abandonedForms.length
          });
        }

        for (const form of abandonedForms) {
          if (signal?.aborted) break;
          try {
            const result = await executeFormDeletion(form._id, { isSystemRecovery: true });
            if (result.success) {
              resultSummary.recoveredCount++;
              logger.info(`Recovered abandoned form deletion: ${form._id}`, {
                event: 'deletion.recovery_success',
                formId: form._id
              });
            } else {
              resultSummary.failedCount++;
              logger.warn(`Could not recover abandoned form ${form._id}: ${result.message}`, {
                event: 'deletion.recovery_unresolved',
                formId: form._id,
                reason: result.message
              });
            }
          } catch (err) {
            resultSummary.failedCount++;
            logger.error(`Error recovering abandoned form ${form._id}: ${err.message}`, err, {
              event: 'deletion.recovery_error',
              formId: form._id
            });
          }
        }
      } catch (abandonedErr) {
        resultSummary.failedCount++;
        logger.warn('Failed to query abandoned deleting forms', { error: abandonedErr.message });
      }

      if (signal?.aborted) {
        return resultSummary;
      }

      // 2. Sweep orphaned responses whose Form no longer exists (S3 keys purged BEFORE DB delete)
      try {
        const orphanedFormIds = await Response.distinct('formId');
        if (orphanedFormIds.length > 0) {
          const existingForms = await Form.find({ _id: { $in: orphanedFormIds } }, '_id').lean();
          const existingSet = new Set(existingForms.map((f) => f._id.toString()));
          const deadFormIds = orphanedFormIds.filter((id) => id && !existingSet.has(id.toString()));

          for (const deadId of deadFormIds) {
            if (signal?.aborted) break;
            try {
              const deadIdStr = deadId.toString();
              const orphanResponses = await Response.find({ formId: deadId }, 'answers').lean();
              const orphanQuestions = await Question.find({ formId: deadId }, '_id type').lean();

              const { validKeySet, unresolvedKeySet } = collectFormStorageKeys(
                deadIdStr,
                orphanResponses,
                orphanQuestions
              );

              if (unresolvedKeySet.size > 0) {
                resultSummary.failedCount++;
                logger.warn('deletion.orphan_responses_unresolved_keys_halted', {
                  formId: deadIdStr,
                  unresolvedKeys: Array.from(unresolvedKeySet)
                });
                continue;
              }

              const keysToDelete = Array.from(validKeySet);
              if (keysToDelete.length > 0) {
                const s3Result = await storageService.deleteFiles(keysToDelete);
                if (
                  !s3Result?.success &&
                  Array.isArray(s3Result?.failedKeys) &&
                  s3Result.failedKeys.length > 0
                ) {
                  resultSummary.failedCount++;
                  logger.warn('deletion.orphan_responses_s3_failed_halted', {
                    formId: deadIdStr,
                    failedKeys: s3Result.failedKeys
                  });
                  continue;
                }
              }

              await Response.deleteMany({ formId: deadId });
              resultSummary.sweptOrphanResponses += 1;
              logger.info(`Swept orphaned response collection for missing form ${deadIdStr}.`, {
                event: 'deletion.orphan_responses_swept',
                formId: deadIdStr
              });
            } catch (deadErr) {
              resultSummary.failedCount++;
              logger.warn('Failed to sweep orphaned responses for dead form', {
                formId: deadId,
                error: deadErr.message
              });
            }
          }
        }
      } catch (orphanErr) {
        logger.warn('Failed to sweep orphaned responses', { error: orphanErr.message });
      }

      if (signal?.aborted) {
        return resultSummary;
      }

      // 3. Sweep orphaned SubmissionReservations whose Form is missing (preserve failed S3 keys)
      try {
        const orphanedResFormIds = await SubmissionReservation.distinct('formId');
        if (orphanedResFormIds.length > 0) {
          const existingForms = await Form.find({ _id: { $in: orphanedResFormIds } }, '_id').lean();
          const existingSet = new Set(existingForms.map((f) => f._id.toString()));
          const deadFormIds = orphanedResFormIds.filter(
            (id) => id && !existingSet.has(id.toString())
          );

          for (const deadId of deadFormIds) {
            if (signal?.aborted) break;
            const deadIdStr = deadId.toString();
            const deadReservations = await SubmissionReservation.find({ formId: deadId }).lean();
            for (const resItem of deadReservations) {
              if (signal?.aborted) break;
              try {
                const failedStagedKeys = [];
                const failedPromotedKeys = [];
                if (Array.isArray(resItem.stagedKeys)) {
                  for (const key of resItem.stagedKeys) {
                    const classification = classifyStorageKey(key, deadIdStr);
                    if (classification.category !== 'A') {
                      if (classification.category === 'C') {
                        failedStagedKeys.push(classification.key);
                      }
                      continue;
                    }
                    try {
                      await storageService.deleteFile(classification.key);
                    } catch (s3Err) {
                      failedStagedKeys.push(classification.key);
                      logger.warn('deletion.orphan_reservation_s3_failed', {
                        formId: deadIdStr,
                        leaseId: resItem.leaseId,
                        key: classification.key,
                        error: s3Err.message
                      });
                    }
                  }
                }

                if (Array.isArray(resItem.promotedKeys)) {
                  for (const key of resItem.promotedKeys) {
                    const classification = classifyStorageKey(key, deadIdStr);
                    if (classification.category !== 'A') {
                      if (classification.category === 'C') {
                        failedPromotedKeys.push(classification.key);
                      }
                      continue;
                    }
                    try {
                      await storageService.deleteFile(classification.key);
                    } catch (s3Err) {
                      failedPromotedKeys.push(classification.key);
                      logger.warn('deletion.orphan_reservation_promoted_s3_failed', {
                        formId: deadIdStr,
                        leaseId: resItem.leaseId,
                        key: classification.key,
                        error: s3Err.message
                      });
                    }
                  }
                }

                // Durably hand off namespace cleanup ownership to DeletionCleanupJob
                // before removing or updating the orphaned reservation record
                await DeletionCleanupJob.findOneAndUpdate(
                  { formId: deadId },
                  {
                    $setOnInsert: {
                      formId: deadId,
                      stagingPrefix: `staging/forms/${deadIdStr}/`,
                      finalPrefix: `forms/${deadIdStr}/`,
                      eligibleUntil: new Date(),
                      createdAt: new Date()
                    },
                    $set: {
                      status: 'pending',
                      nextSweepAt: new Date(),
                      leaseId: null,
                      leaseExpiresAt: null,
                      vacuumAt: null,
                      updatedAt: new Date()
                    }
                  },
                  { upsert: true }
                );

                if (failedStagedKeys.length === 0 && failedPromotedKeys.length === 0) {
                  await SubmissionReservation.deleteOne({ _id: resItem._id });
                  resultSummary.sweptOrphanReservations += 1;
                } else {
                  resultSummary.failedCount++;
                  await SubmissionReservation.updateOne(
                    { _id: resItem._id },
                    {
                      $set: {
                        status: 'abandoned',
                        stagedKeys: failedStagedKeys,
                        promotedKeys: failedPromotedKeys,
                        vacuumAt: null,
                        counterReleased: true,
                        updatedAt: new Date()
                      }
                    }
                  );
                }
              } catch (resItemErr) {
                resultSummary.failedCount++;
                logger.warn('Failed to sweep orphaned reservation record', {
                  formId: deadIdStr,
                  reservationId: resItem._id,
                  error: resItemErr.message
                });
              }
            }
          }
        }
      } catch (resErr) {
        logger.warn('Failed to sweep orphaned reservations', { error: resErr.message });
      }

      if (signal?.aborted) {
        return resultSummary;
      }

      // 4. Sweep expired active/committing and abandoned reservations on live forms
      try {
        await SubmissionReservationManager.sweepAbandonedReservations({
          batchSize,
          graceMs: options.reservationGraceMs !== undefined ? options.reservationGraceMs : 5000,
          quarantineMs: options.quarantineMs,
          signal
        });
      } catch (sweepErr) {
        logger.warn('Failed to sweep abandoned submission reservations', {
          error: sweepErr.message
        });
      }

      if (signal?.aborted) {
        return resultSummary;
      }

      // 4b. Sweep finalized reservations with pending/failed staging cleanups on live forms
      try {
        const stagingSweepSummary =
          await SubmissionReservationManager.sweepFinalizedStagingCleanups({
            batchSize,
            signal
          });
        resultSummary.completedStagingCleanups = stagingSweepSummary.completedCount;
        resultSummary.purgedStorageFiles =
          (resultSummary.purgedStorageFiles || 0) + stagingSweepSummary.purgedCount;
      } catch (sweepStagingErr) {
        logger.warn('Failed to sweep finalized staging cleanups', {
          error: sweepStagingErr.message
        });
      }

      if (signal?.aborted) {
        return resultSummary;
      }

      // 5. Sweep orphaned Questions whose Form is missing (skip if orphan Responses still await S3 purge)
      try {
        const orphanedQFormIds = await Question.distinct('formId');
        if (orphanedQFormIds.length > 0) {
          const existingForms = await Form.find({ _id: { $in: orphanedQFormIds } }, '_id').lean();
          const existingSet = new Set(existingForms.map((f) => f._id.toString()));
          const deadQFormIds = orphanedQFormIds.filter(
            (id) => id && !existingSet.has(id.toString())
          );

          for (const deadId of deadQFormIds) {
            if (signal?.aborted) break;
            try {
              const hasPendingResponses = await Response.exists({ formId: deadId });
              if (hasPendingResponses) {
                continue;
              }
              await Question.deleteMany({ formId: deadId });
              resultSummary.sweptOrphanQuestions += 1;
            } catch (qItemErr) {
              resultSummary.failedCount++;
              logger.warn('Failed to sweep orphaned questions for dead form', {
                formId: deadId,
                error: qItemErr.message
              });
            }
          }
        }
      } catch (qErr) {
        logger.warn('Failed to sweep orphaned questions', { error: qErr.message });
      }

      // 6. Sweep durable DeletionCleanupJobs across S3 staging and final namespaces
      try {
        const sweepNow = new Date();
        const pendingJobs = await DeletionCleanupJob.find({
          $or: [
            {
              status: { $in: ['pending', 'failed', 'reconciled'] },
              $or: [
                { nextSweepAt: null },
                { nextSweepAt: { $exists: false } },
                { nextSweepAt: { $lte: sweepNow } }
              ],
              $and: [{ $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lt: sweepNow } }] }]
            },
            {
              status: 'cleaning',
              leaseExpiresAt: { $lt: sweepNow }
            }
          ]
        })
          .sort({ nextSweepAt: 1, createdAt: 1 })
          .limit(batchSize)
          .lean();

        for (const job of pendingJobs) {
          if (signal?.aborted) break;
          const procResult = await processDeletionCleanupJob(job, { signal });
          if (procResult?.status === 'completed' || procResult?.status === 'reconciled') {
            resultSummary.completedCleanupJobs = (resultSummary.completedCleanupJobs || 0) + 1;
          }
          if (procResult?.deletedCount) {
            resultSummary.purgedStorageFiles =
              (resultSummary.purgedStorageFiles || 0) + procResult.deletedCount;
          }
        }
      } catch (jobSweepErr) {
        logger.warn('Failed to sweep deletion cleanup jobs', { error: jobSweepErr.message });
      }

      return resultSummary;
    })()
  );

const buildNoActiveDeletionLeaseFilter = (now) => ({
  $or: [
    { 'deletionProgress.leaseId': null },
    { 'deletionProgress.leaseExpiresAt': null },
    { 'deletionProgress.leaseExpiresAt': { $lt: now } }
  ]
});

/**
 * @route   POST /api/forms/:id/questions
 * @desc    Add question to form
 * @access  Private (owner only)
 */
export const addQuestion = async (req, res, next) => {
  try {
    const { type, label, required, options, validation, visibilityRule } = req.body;

    if (!type || !label) {
      return res.status(400).json({
        success: false,
        message: 'Question type and label are required'
      });
    }

    const result = await withRequiredTransaction(async (session) => {
      const txNow = new Date();
      const form = await Form.findById(req.params.id).session(session);

      if (!form) {
        return { statusCode: 404, message: 'Form not found' };
      }

      if (form.ownerId.toString() !== req.user.id) {
        return { statusCode: 403, message: 'Not authorized to modify this form' };
      }

      const hasActiveDeletionLease = Boolean(
        form.deletionProgress?.leaseId &&
        form.deletionProgress?.leaseExpiresAt &&
        new Date(form.deletionProgress.leaseExpiresAt) >= txNow
      );
      if (['deleting', 'delete_failed'].includes(form.status) || hasActiveDeletionLease) {
        return {
          statusCode: 409,
          message:
            form.status === 'deleting' || hasActiveDeletionLease
              ? 'Form is currently being deleted'
              : 'Form deletion previously failed'
        };
      }

      let parsedVisibilityRule = null;
      if (visibilityRule !== undefined && visibilityRule !== null) {
        const ruleValidation = await validateVisibilityRule(
          visibilityRule,
          form._id,
          null,
          session
        );
        if (!ruleValidation.valid) {
          return { statusCode: 400, message: ruleValidation.message };
        }
        parsedVisibilityRule = ruleValidation.value;
      }

      const maxOrderQuestion = await Question.findOne({ formId: form._id })
        .sort({ order: -1 })
        .select('order')
        .session(session);
      const minNextOrder =
        maxOrderQuestion && typeof maxOrderQuestion.order === 'number'
          ? maxOrderQuestion.order + 1
          : 0;
      const assignedOrder = Math.max(form.nextQuestionOrder || 0, minNextOrder);

      const lockedForm = await Form.findOneAndUpdate(
        {
          _id: form._id,
          ownerId: req.user.id,
          status: { $nin: ['deleting', 'delete_failed'] },
          ...buildNoActiveDeletionLeaseFilter(txNow)
        },
        {
          $set: {
            nextQuestionOrder: assignedOrder + 1,
            updatedAt: txNow
          },
          $inc: { lifecycleVersion: 1 }
        },
        { session, new: true }
      );

      if (!lockedForm) {
        return { statusCode: 409, message: 'Form is currently being deleted' };
      }

      const [question] = await Question.create(
        [
          {
            formId: req.params.id,
            type,
            label,
            required: required || false,
            order: assignedOrder,
            options: options || [],
            validation: validation || {},
            visibilityRule: parsedVisibilityRule
          }
        ],
        { session }
      );

      return { statusCode: 201, question };
    });

    if (result.statusCode !== 201) {
      return res.status(result.statusCode).json({
        success: false,
        message: result.message
      });
    }

    res.status(201).json({
      success: true,
      message: 'Question added successfully',
      data: result.question
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
    const { type, label, required, options, order, validation, visibilityRule, version } = req.body;

    const result = await withRequiredTransaction(async (session) => {
      const txNow = new Date();
      const form = await Form.findById(req.params.formId).session(session);

      if (!form) {
        return { statusCode: 404, message: 'Form not found' };
      }

      if (form.ownerId.toString() !== req.user.id) {
        return { statusCode: 403, message: 'Not authorized to modify this form' };
      }

      const hasActiveDeletionLease = Boolean(
        form.deletionProgress?.leaseId &&
        form.deletionProgress?.leaseExpiresAt &&
        new Date(form.deletionProgress.leaseExpiresAt) >= txNow
      );
      if (['deleting', 'delete_failed'].includes(form.status) || hasActiveDeletionLease) {
        return {
          statusCode: 409,
          message:
            form.status === 'deleting' || hasActiveDeletionLease
              ? 'Form is currently being deleted'
              : 'Form deletion previously failed'
        };
      }

      const updateFields = {};
      if (type !== undefined) updateFields.type = type;
      if (label !== undefined) updateFields.label = label;
      if (required !== undefined) updateFields.required = required;
      if (options !== undefined) updateFields.options = options;
      if (order !== undefined) updateFields.order = order;
      if (validation !== undefined) updateFields.validation = validation;

      if (visibilityRule !== undefined) {
        if (visibilityRule === null) {
          updateFields.visibilityRule = null;
        } else {
          const ruleValidation = await validateVisibilityRule(
            visibilityRule,
            form._id,
            req.params.questionId,
            session
          );
          if (!ruleValidation.valid) {
            return { statusCode: 400, message: ruleValidation.message };
          }
          updateFields.visibilityRule = ruleValidation.value;
        }
      }

      const lockedForm = await Form.findOneAndUpdate(
        {
          _id: form._id,
          ownerId: req.user.id,
          status: { $nin: ['deleting', 'delete_failed'] },
          ...buildNoActiveDeletionLeaseFilter(txNow)
        },
        {
          $inc: { lifecycleVersion: 1 },
          $set: { updatedAt: txNow }
        },
        { session, new: true }
      );

      if (!lockedForm) {
        return { statusCode: 409, message: 'Form is currently being deleted' };
      }

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

      const updatedQuestion = await Question.findOneAndUpdate(
        query,
        {
          $set: updateFields,
          $inc: { version: 1 }
        },
        {
          new: true,
          runValidators: true,
          session
        }
      );

      if (!updatedQuestion) {
        const existingQuestion = await Question.findOne({
          _id: req.params.questionId,
          formId: req.params.formId
        }).session(session);

        if (!existingQuestion) {
          return { statusCode: 404, message: 'Question not found' };
        }

        return {
          statusCode: 409,
          message: 'Conflict: Question has been modified by another update',
          data: existingQuestion
        };
      }

      return { statusCode: 200, updatedQuestion };
    });

    if (result.statusCode !== 200) {
      const payload = {
        success: false,
        message: result.message
      };
      if (result.data !== undefined) payload.data = result.data;
      return res.status(result.statusCode).json(payload);
    }

    res.status(200).json({
      success: true,
      message: 'Question updated successfully',
      data: result.updatedQuestion
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
    const result = await withRequiredTransaction(async (session) => {
      const txNow = new Date();
      const form = await Form.findById(req.params.formId).session(session);

      if (!form) {
        return { statusCode: 404, message: 'Form not found' };
      }

      if (form.ownerId.toString() !== req.user.id) {
        return { statusCode: 403, message: 'Not authorized to modify this form' };
      }

      const hasActiveDeletionLease = Boolean(
        form.deletionProgress?.leaseId &&
        form.deletionProgress?.leaseExpiresAt &&
        new Date(form.deletionProgress.leaseExpiresAt) >= txNow
      );
      if (['deleting', 'delete_failed'].includes(form.status) || hasActiveDeletionLease) {
        return {
          statusCode: 409,
          message:
            form.status === 'deleting' || hasActiveDeletionLease
              ? 'Form is currently being deleted'
              : 'Form deletion previously failed'
        };
      }

      const question = await Question.findById(req.params.questionId).session(session);
      if (!question || question.formId.toString() !== req.params.formId) {
        return { statusCode: 404, message: 'Question not found' };
      }

      const lockedForm = await Form.findOneAndUpdate(
        {
          _id: form._id,
          ownerId: req.user.id,
          status: { $nin: ['deleting', 'delete_failed'] },
          ...buildNoActiveDeletionLeaseFilter(txNow)
        },
        {
          $inc: { lifecycleVersion: 1 },
          $set: { updatedAt: txNow }
        },
        { session, new: true }
      );

      if (!lockedForm) {
        return { statusCode: 409, message: 'Form is currently being deleted' };
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

      await Question.updateMany(cleanupFilter, { $set: { visibilityRule: null } }, { session });
      await Question.deleteOne({ _id: question._id }, { session });

      return { statusCode: 200 };
    });

    if (result.statusCode !== 200) {
      return res.status(result.statusCode).json({
        success: false,
        message: result.message
      });
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
    const { questionOrders, version } = req.body;

    if (!Array.isArray(questionOrders)) {
      return res.status(400).json({
        success: false,
        message: 'questionOrders must be an array'
      });
    }

    if (questionOrders.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'questionOrders cannot be empty'
      });
    }

    if (questionOrders.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'questionOrders exceeds maximum limit of 500 items'
      });
    }

    const seenIds = new Set();
    for (const item of questionOrders) {
      if (
        !item ||
        typeof item !== 'object' ||
        !isValidObjectId(item.questionId) ||
        typeof item.order !== 'number' ||
        !Number.isInteger(item.order) ||
        item.order < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Each question order item must include a valid questionId and non-negative integer order'
        });
      }

      if (seenIds.has(item.questionId)) {
        return res.status(400).json({
          success: false,
          message: 'Duplicate question IDs in questionOrders'
        });
      }
      seenIds.add(item.questionId);
    }

    const questionIds = Array.from(seenIds);
    const maxOrder = Math.max(...questionOrders.map((q) => q.order));
    const REORDER_LOCK_TIMEOUT_MS = 30000;

    const result = await withRequiredTransaction(async (session) => {
      const txNow = new Date();
      const lockExpiry = new Date(txNow.getTime() - REORDER_LOCK_TIMEOUT_MS);

      const form = await Form.findById(req.params.formId).session(session);
      if (!form) {
        return { statusCode: 404, message: 'Form not found' };
      }

      if (form.ownerId.toString() !== req.user.id) {
        return { statusCode: 403, message: 'Not authorized to modify this form' };
      }

      const hasActiveDeletionLease = Boolean(
        form.deletionProgress?.leaseId &&
        form.deletionProgress?.leaseExpiresAt &&
        new Date(form.deletionProgress.leaseExpiresAt) >= txNow
      );
      if (['deleting', 'delete_failed'].includes(form.status) || hasActiveDeletionLease) {
        return {
          statusCode: 409,
          message:
            form.status === 'deleting' || hasActiveDeletionLease
              ? 'Form is currently being deleted'
              : 'Form deletion has failed. Please retry deletion.'
        };
      }

      const existingQuestions = await Question.find(
        {
          formId: form._id,
          _id: { $in: questionIds }
        },
        '_id order'
      ).session(session);

      if (existingQuestions.length !== questionIds.length) {
        return {
          statusCode: 400,
          message: 'One or more questions do not belong to this form'
        };
      }

      const reorderLockQuery = {
        _id: form._id,
        ownerId: req.user.id,
        status: { $nin: ['deleting', 'delete_failed'] },
        $and: [
          buildNoActiveDeletionLeaseFilter(txNow),
          {
            $or: [
              { 'reorderState.inProgress': false },
              { 'reorderState.inProgress': { $exists: false } },
              { 'reorderState.updatedAt': { $lt: lockExpiry } },
              { 'reorderState.updatedAt': null }
            ]
          }
        ]
      };

      if (version !== undefined && version !== null) {
        const parsedVersion = Number(version);
        if (parsedVersion === 0) {
          reorderLockQuery.$and.push({
            $or: [{ version: 0 }, { version: { $exists: false } }]
          });
        } else {
          reorderLockQuery.version = parsedVersion;
        }
      }

      const lockedForm = await Form.findOneAndUpdate(
        reorderLockQuery,
        {
          $set: {
            nextQuestionOrder: Math.max(form.nextQuestionOrder || 0, maxOrder + 1),
            'reorderState.inProgress': false,
            'reorderState.previousOrders': [],
            'reorderState.targetOrders': [],
            'reorderState.updatedAt': txNow,
            updatedAt: txNow
          },
          $inc: { version: 1, lifecycleVersion: 1 }
        },
        { session, new: true }
      );

      if (!lockedForm) {
        const currentForm = await Form.findOne({
          _id: form._id,
          ownerId: req.user.id
        }).session(session);

        if (!currentForm) {
          return { statusCode: 404, message: 'Form not found' };
        }
        if (['deleting', 'delete_failed'].includes(currentForm.status)) {
          return {
            statusCode: 409,
            message:
              currentForm.status === 'deleting'
                ? 'Form is currently being deleted'
                : 'Form deletion has failed. Please retry deletion.'
          };
        }
        if (
          currentForm.reorderState?.inProgress &&
          currentForm.reorderState?.updatedAt &&
          new Date(currentForm.reorderState.updatedAt) > lockExpiry
        ) {
          return {
            statusCode: 409,
            message: 'A question reorder operation is already in progress'
          };
        }
        return {
          statusCode: 409,
          message: 'Conflict: Form has been modified by another update',
          data: currentForm
        };
      }

      const bulkOps = questionOrders.map(({ questionId, order }) => ({
        updateOne: {
          filter: { _id: questionId, formId: form._id },
          update: { $set: { order } }
        }
      }));

      await Question.bulkWrite(bulkOps, { session, ordered: true });
      return { statusCode: 200 };
    });

    if (result.statusCode !== 200) {
      const payload = {
        success: false,
        message: result.message
      };
      if (result.data !== undefined) payload.data = result.data;
      return res.status(result.statusCode).json(payload);
    }

    res.status(200).json({
      success: true,
      message: 'Questions reordered successfully'
    });
  } catch (error) {
    logger.error('reorder.execution_failed', {
      formId: req.params.formId,
      error: error.message
    });
    next(error);
  }
};
