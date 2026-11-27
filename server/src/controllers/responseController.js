import mongoose from 'mongoose';
import Response from '../models/response.js';
import Form from '../models/form.js';
import Question from '../models/question.js';
import SubmissionReservation from '../models/submissionReservation.js';
import User from '../models/user.js';
import storageService from '../services/StorageService.js';
import EmailService from '../services/EmailService.js';
import crypto from 'crypto';
import fs from 'fs';
import { fileTypeFromFile } from 'file-type';
import { pipeline } from 'stream';
import path from 'path';
import contentDisposition from 'content-disposition';
import { validateDocxZip } from '../utils/docxValidator.js';
import { cleanupRequestTempFiles } from '../utils/fileCleanup.js';
import { escapeHtml } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { withRequiredTransaction, isUnknownTransactionCommitResult } from '../utils/dbTransaction.js';
import { trackMutationOperation } from '../middleware/quiescenceGate.js';
import { classifyStorageKey, trackDeletionTask } from './formController.js';
import {
  SubmissionReservationManager,
  HEARTBEAT_INTERVAL_MS
} from '../utils/submissionReservationManager.js';
import StorageJournal, {
  STORAGE_JOURNAL_STATUS,
  STORAGE_OPERATION_TYPE
} from '../models/storageJournal.js';
import {
  uploadAdmissionService,
  AdmissionError
} from '../services/uploadAdmissionService.js';

const verifyCommittedIdempotentResponse = async (existingResponse) => {
  if (!existingResponse || existingResponse.commitStatus === 'pending') {
    return false;
  }
  if (existingResponse.reservationLeaseId) {
    const linkedReservation = await SubmissionReservation.findOne({
      leaseId: existingResponse.reservationLeaseId
    })
      .select('status')
      .lean();
    if (linkedReservation && linkedReservation.status !== 'finalized') {
      return false;
    }
  }
  return true;
};

// Helper to evaluate visibility rule
export const isQuestionVisible = (question, answers) => {
  if (!question || !question.visibilityRule || !question.visibilityRule.targetQuestionId) {
    return true;
  }
  const { targetQuestionId, operator, value } = question.visibilityRule;
  const targetAnswer = Array.isArray(answers)
    ? answers.find(
        (a) =>
          a &&
          typeof a === 'object' &&
          a.questionId &&
          String(a.questionId) === String(targetQuestionId)
      )
    : null;

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

export const STREAM_TIMEOUTS = {
  INACTIVITY_TIMEOUT_MS: parseInt(process.env.STREAM_INACTIVITY_TIMEOUT_MS, 10) || 30000,
  ACQUISITION_TIMEOUT_MS: parseInt(process.env.S3_GET_TIMEOUT_MS, 10) || 30000
};

/**
 * Computes a deterministic SHA-256 hash of canonical answer payloads
 * to verify idempotency key reuse with different answers.
 *
 * @param {Array} answers
 * @returns {string|null}
 */
export const computePayloadHash = (answers = []) => {
  if (!Array.isArray(answers)) return null;
  const canonical = [...answers]
    .map((a) => {
      if (!a || typeof a !== 'object') return null;
      let val = a.value;
      if (Array.isArray(val)) {
        val = [...val].sort();
      } else if (val && typeof val === 'object' && val.originalName) {
        val = {
          originalName: val.originalName,
          size: val.size,
          mimeType: val.mimeType
        };
      }
      return {
        questionId: a.questionId ? a.questionId.toString() : '',
        value: val
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.questionId.localeCompare(b.questionId));

  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

/**
 * Compute the verified payload size and SHA-256 hash for an uploaded file
 * to preserve immutable cryptographic provenance in StorageJournal.
 *
 * @deprecated Superseded by single-pass upload stream provenance in StorageService.uploadFile (Phase 2D.1K.14.1.7.5).
 * Retained strictly for legacy fixture compatibility; not invoked in production submitResponse pipeline.
 *
 * @param {object} file - Multer file object
 * @returns {Promise<{payloadSize: number|null, payloadHash: string|null}>}
 */
export const computeUploadedFileMeta = async (file) => {
  if (!file) return { payloadSize: null, payloadHash: null };

  if (Buffer.isBuffer(file.buffer)) {
    return {
      payloadSize: file.buffer.length,
      payloadHash: crypto.createHash('sha256').update(file.buffer).digest('hex')
    };
  }

  if (file.path && fs.existsSync(file.path)) {
    try {
      const fileData = await fs.promises.readFile(file.path);
      return {
        payloadSize: fileData.length,
        payloadHash: crypto.createHash('sha256').update(fileData).digest('hex')
      };
    } catch {
      return new Promise((resolve) => {
        const hash = crypto.createHash('sha256');
        let size = 0;
        const stream = fs.createReadStream(file.path);
        stream.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buf);
          size += buf.length;
        });
        stream.on('end', () => {
          resolve({
            payloadSize: typeof file.size === 'number' && file.size > 0 ? file.size : size,
            payloadHash: hash.digest('hex')
          });
        });
        stream.on('error', () => {
          resolve({
            payloadSize: typeof file.size === 'number' ? file.size : null,
            payloadHash: null
          });
        });
      });
    }
  }

  return {
    payloadSize: typeof file.size === 'number' ? file.size : null,
    payloadHash: null
  };
};

/**
 * @route   POST /api/responses/:formId
 * @desc    Submit response to a form
 * @access  Public
 */
export const submitResponse = async (req, res, next) => {
  let hasSubmissionReservation = false;
  let persistenceCommitted = false;
  let leaseId = null;
  let fenceToken = null;
  let heartbeatTimer = null;
  let clientDisconnectHandler = null;
  let targetFormId = req.params?.formId || req.params?.id || null;
  let localUploadPermit = null;
  const uploadedKeys = [];
  try {
    const rawIdempotencyKey =
      req.headers?.['idempotency-key'] ||
      req.headers?.['x-idempotency-key'] ||
      (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : null);
    const idempotencyKey =
      typeof rawIdempotencyKey === 'string' && rawIdempotencyKey.trim().length > 0
        ? rawIdempotencyKey.trim().slice(0, 128)
        : null;

    const form = await Form.findById(req.params.formId);

    if (!form) {
      return res.status(404).json({ success: false, message: 'Form not found' });
    }

    const hasActiveDeletionLease = Boolean(
      form.deletionProgress?.leaseId &&
      form.deletionProgress?.leaseExpiresAt &&
      new Date(form.deletionProgress.leaseExpiresAt) >= new Date()
    );
    if (['deleting', 'delete_failed'].includes(form.status) || hasActiveDeletionLease) {
      return res.status(409).json({
        success: false,
        message: 'Form is currently being deleted'
      });
    }

    if (form.status !== 'published') {
      return res
        .status(403)
        .json({ success: false, message: 'This form is not accepting responses' });
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

    if (rawAnswers.length > 500) {
      return res
        .status(400)
        .json({ success: false, message: 'Answers array exceeds maximum limit of 500 items' });
    }

    const isValidQuestionId = (id) =>
      id instanceof mongoose.Types.ObjectId ||
      (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id));

    if (
      rawAnswers.some(
        (a) =>
          !a ||
          typeof a !== 'object' ||
          Array.isArray(a) ||
          !a.questionId ||
          !isValidQuestionId(a.questionId)
      )
    ) {
      return res
        .status(400)
        .json({ success: false, message: 'Each answer item must be a valid object' });
    }

    const seenQuestionIds = new Set();
    for (const a of rawAnswers) {
      const normalizedId = a.questionId.toString();
      if (seenQuestionIds.has(normalizedId)) {
        return res.status(400).json({
          success: false,
          message: 'Duplicate answers for the same question are not allowed'
        });
      }
      seenQuestionIds.add(normalizedId);
    }

    const questions = await Question.find({ formId: req.params.formId });

    const validQuestionIds = new Set(questions.map((q) => q._id.toString()));
    for (const a of rawAnswers) {
      if (!validQuestionIds.has(a.questionId.toString())) {
        return res
          .status(400)
          .json({ success: false, message: 'Question does not belong to this form' });
      }
    }

    const validAnswersToSave = [];
    const filesToUpload = []; // { file, question, key }

    // First pass: Validation
    for (const question of questions) {
      const isVisible = isQuestionVisible(question, rawAnswers);

      let val;
      let hasValue = false;
      let file = null;

      if (question.type === 'file') {
        file =
          req.files && req.files.find((f) => f.fieldname === `file_${question._id.toString()}`);
        if (file) {
          hasValue = true;
          val = file;
        }
      } else {
        const providedAnswer = rawAnswers.find(
          (a) =>
            a &&
            typeof a === 'object' &&
            a.questionId &&
            a.questionId.toString() === question._id.toString()
        );
        val = providedAnswer ? providedAnswer.value : undefined;
        const isWhitespaceOnlyText =
          ['short_text', 'long_text'].includes(question.type) &&
          typeof val === 'string' &&
          val.trim() === '';
        hasValue =
          val !== undefined &&
          val !== null &&
          val !== '' &&
          !isWhitespaceOnlyText &&
          !(Array.isArray(val) && val.length === 0);
      }

      if (isVisible && question.required && !hasValue) {
        return res
          .status(400)
          .json({ success: false, message: `Question "${question.label}" is required` });
      }

      if (isVisible && hasValue) {
        // Type validation
        if (['short_text', 'long_text'].includes(question.type)) {
          if (typeof val !== 'string') {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" must be a text value`
            });
          }
          const maxLen = question.type === 'short_text' ? 1000 : 20000;
          if (val.length > maxLen) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" exceeds maximum length of ${maxLen} characters`
            });
          }
        } else if (question.type === 'email') {
          if (typeof val !== 'string') {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" must be a valid email`
            });
          }
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(val)) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" must be a valid email`
            });
          }
        } else if (question.type === 'number') {
          const isNumeric =
            typeof val === 'number'
              ? Number.isFinite(val)
              : typeof val === 'string' && val.trim() !== '' && Number.isFinite(Number(val));
          if (!isNumeric) {
            return res
              .status(400)
              .json({ success: false, message: `Question "${question.label}" must be a number` });
          }
        } else if (question.type === 'rating') {
          const num =
            typeof val === 'number'
              ? val
              : typeof val === 'string' && val.trim() !== ''
                ? Number(val)
                : NaN;
          if (!Number.isInteger(num) || num < 1 || num > 5) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" must be a rating between 1 and 5`
            });
          }
        } else if (question.type === 'date') {
          if (typeof val !== 'string') {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" must be a valid date`
            });
          }
          const match = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (!match) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" must be a valid date`
            });
          }
          const year = parseInt(match[1], 10);
          const month = parseInt(match[2], 10);
          const day = parseInt(match[3], 10);
          const d = new Date(Date.UTC(year, month - 1, day));
          if (
            d.getUTCFullYear() !== year ||
            d.getUTCMonth() !== month - 1 ||
            d.getUTCDate() !== day
          ) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" must be a valid date`
            });
          }
        } else if (['single_choice', 'dropdown'].includes(question.type)) {
          if (typeof val !== 'string' || !question.options.includes(val)) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" has an invalid choice`
            });
          }
        } else if (['multiple_choice', 'checkbox'].includes(question.type)) {
          if (
            !Array.isArray(val) ||
            !val.every((v) => typeof v === 'string' && question.options.includes(v))
          ) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" has invalid choices`
            });
          }
        } else if (question.type === 'file') {
          const allowedTypes = [
            'image/jpeg',
            'image/png',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ];
          if (!allowedTypes.includes(file.mimetype)) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" has an unsupported file type`
            });
          }

          const maxSizeBytes = process.env.MAX_FILE_SIZE
            ? parseInt(process.env.MAX_FILE_SIZE, 10)
            : 5 * 1024 * 1024;
          if (file.size > maxSizeBytes) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" file exceeds maximum size`
            });
          }

          // MAGIC BYTE VALIDATION
          const magic = await fileTypeFromFile(file.path);

          if (!magic) {
            // Some obscure text files might not have magic bytes, but for images/docs we expect them
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" has an unrecognized file signature`
            });
          }

          let canonicalMime = null;
          const isDocx =
            magic.mime ===
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            (magic.mime === 'application/zip' &&
              (file.mimetype ===
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                file.originalname.toLowerCase().endsWith('.docx')));

          if (magic.mime === 'image/jpeg') {
            canonicalMime = 'image/jpeg';
          } else if (magic.mime === 'image/png') {
            canonicalMime = 'image/png';
          } else if (magic.mime === 'application/pdf') {
            canonicalMime = 'application/pdf';
          } else if (
            magic.mime === 'application/msword' ||
            magic.mime === 'application/x-cfb' ||
            magic.ext === 'doc'
          ) {
            canonicalMime = 'application/msword';
          } else if (isDocx) {
            const docxResult = validateDocxZip(file.path);
            if (!docxResult.valid) {
              return res.status(400).json({
                success: false,
                message: `Question "${question.label}" content does not match allowed types`
              });
            }
            canonicalMime =
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          }

          if (!canonicalMime) {
            return res.status(400).json({
              success: false,
              message: `Question "${question.label}" content does not match allowed types`
            });
          }

          const MIME_TO_SAFE_EXT = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'application/pdf': 'pdf',
            'application/msword': 'doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
          };
          const safeExt = MIME_TO_SAFE_EXT[canonicalMime] || 'bin';
          const fileId = crypto.randomUUID();
          const storageKey = `forms/${form._id}/responses/${fileId}.${safeExt}`;
          filesToUpload.push({ file, question, key: storageKey, fileId, safeExt, canonicalMime });
        }

        if (question.type !== 'file') {
          validAnswersToSave.push({
            questionId: question._id,
            value: question.type === 'rating' || question.type === 'number' ? Number(val) : val
          });
        }
      }
    }

    // Compute canonical payload hash for idempotency validation
    const candidateAnswersForHash = [
      ...validAnswersToSave,
      ...filesToUpload.map((item) => ({
        questionId: item.question._id,
        value: {
          originalName: item.file.originalname,
          size: item.file.size,
          mimeType: item.canonicalMime
        }
      }))
    ];
    const payloadHash = computePayloadHash(candidateAnswersForHash);

    // Fast-path idempotency check: If this submission is a retry with the exact same key
    if (idempotencyKey) {
      const existingResponse = await Response.findOne({
        formId: req.params.formId,
        idempotencyKey
      });
      if (existingResponse) {
        if (existingResponse.payloadHash && existingResponse.payloadHash !== payloadHash) {
          return res.status(409).json({
            success: false,
            message: 'Idempotency key was previously used with a different submission payload'
          });
        }
        const isCommitted = await verifyCommittedIdempotentResponse(existingResponse);
        if (!isCommitted) {
          return res.status(409).json({
            success: false,
            message:
              'Previous submission with this idempotency key is incomplete or no longer active'
          });
        }
        return res.status(200).json({
          success: true,
          message: 'Response already submitted',
          data: {
            id: existingResponse._id
          }
        });
      }
    }

    // Upload admission management: acquire permit before reservation and stream creation
    if (filesToUpload.length === 0) {
      if (req.uploadPermit) {
        req.uploadPermit.release();
        req.uploadPermit = null;
      }
    } else {
      localUploadPermit = req.uploadPermit || null;
      if (!localUploadPermit) {
        localUploadPermit = await uploadAdmissionService.acquire({
          signal: req.signal,
          timeoutMs: 30000,
          metadata: { formId: req.params.formId, ip: req.ip }
        });
      }
    }

    // Acquire durable, independently tracked submission reservation
    const reservationResult = await trackMutationOperation(
      () =>
        SubmissionReservationManager.acquire(req.params.formId, {
          submittedBy: req.ip || 'anonymous'
        }),
      { req }
    );

    if (!reservationResult.success) {
      return res.status(reservationResult.statusCode || 409).json({
        success: false,
        message: reservationResult.message
      });
    }

    leaseId = reservationResult.leaseId;
    fenceToken = reservationResult.fenceToken;
    const expectedGeneration = reservationResult.barrierGeneration;
    const publicationAttemptId = crypto.randomUUID();
    const authoritativeForm = reservationResult.form;
    targetFormId = authoritativeForm?._id || targetFormId;
    hasSubmissionReservation = true;

    // Start heartbeat renewal watchdog to extend lease and detect revocation during uploads
    const uploadAbortController = new AbortController();
    clientDisconnectHandler = () => {
      if (!res.writableEnded) {
        uploadAbortController.abort();
      }
    };
    if (typeof req.on === 'function') {
      req.on('close', clientDisconnectHandler);
      req.on('aborted', clientDisconnectHandler);
    }

    heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await SubmissionReservationManager.renew(
          leaseId,
          fenceToken,
          req.params.formId
        );
        if (!renewed) {
          uploadAbortController.abort();
        }
      } catch (hbErr) {
        logger.warn('submission.heartbeat_failed', { leaseId, error: hbErr.message });
        uploadAbortController.abort();
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    // Upload files and persist response atomically
    let response;
    try {
      response = await trackMutationOperation(async () => {
        const responseId = new mongoose.Types.ObjectId();
        const stagedFiles = [];
      for (const item of filesToUpload) {
        if (uploadAbortController.signal.aborted) {
          const abortErr = new Error('Form is currently being deleted');
          abortErr.statusCode = 409;
          throw abortErr;
        }

        const stagingKey = `staging/forms/${form._id}/${leaseId}/${item.fileId}.${item.safeExt}`;
        const finalKey = item.key || `forms/${form._id}/responses/${item.fileId}.${item.safeExt}`;

        const fileStream = item.file.path && fs.existsSync(item.file.path)
          ? fs.createReadStream(item.file.path)
          : (item.file.buffer ? item.file.buffer : fs.createReadStream(item.file.path));

        uploadedKeys.push(stagingKey);
        const stagedRecorded = await SubmissionReservationManager.recordStagedKey(
          leaseId,
          fenceToken,
          stagingKey
        );
        if (!stagedRecorded) {
          const conflictErr = new Error('Form is currently being deleted');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }
        const uploadResult = await storageService.uploadFile(fileStream, stagingKey, item.canonicalMime, {
          formId: form._id,
          reservationLeaseId: leaseId,
          abortSignal: uploadAbortController.signal,
          admissionPermit: localUploadPermit,
          returnMetadata: true
        });

        // Assert lease validity immediately after upload completes
        const postUploadValid = await SubmissionReservationManager.renew(
          leaseId,
          fenceToken,
          req.params.formId
        );
        if (!postUploadValid || uploadAbortController.signal.aborted) {
          const conflictErr = new Error('Form is currently being deleted');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }

        const verifiedSize =
          typeof uploadResult === 'object' && uploadResult !== null && uploadResult.payloadSize !== undefined
            ? uploadResult.payloadSize
            : (typeof item.file.size === 'number' ? item.file.size : null);
        const verifiedHash =
          typeof uploadResult === 'object' && uploadResult !== null && uploadResult.payloadHash !== undefined
            ? uploadResult.payloadHash
            : null;

        stagedFiles.push({
          item,
          stagingKey,
          finalKey,
          payloadSize: verifiedSize,
          payloadHash: verifiedHash
        });
      }

      // Promote staged files to permanent response namespace before transactional commit
      for (const staged of stagedFiles) {
        if (uploadAbortController.signal.aborted) {
          const abortErr = new Error('Form is currently being deleted');
          abortErr.statusCode = 409;
          throw abortErr;
        }

        const finalRecorded = await SubmissionReservationManager.recordStagedKey(
          leaseId,
          fenceToken,
          staged.finalKey,
          {
            fileId: staged.finalKey,
            stagingKey: staged.stagingKey
          }
        );
        if (!finalRecorded) {
          const conflictErr = new Error('Form is currently being deleted');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }
        uploadedKeys.push(staged.finalKey);

        await storageService.copyFile(staged.stagingKey, staged.finalKey, {
          formId: form._id,
          reservationLeaseId: leaseId,
          responseId,
          payloadSize: staged.payloadSize,
          payloadHash: staged.payloadHash,
          contentType: staged.item.canonicalMime,
          abortSignal: uploadAbortController.signal
        });

        const fileRecorded = await SubmissionReservationManager.completeFilePromotion(
          leaseId,
          fenceToken,
          staged.finalKey
        );
        if (!fileRecorded) {
          const conflictErr = new Error('Form is currently being deleted');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }

        validAnswersToSave.push({
          questionId: staged.item.question._id,
          value: {
            key: staged.finalKey,
            originalName: staged.item.file.originalname,
            mimeType: staged.item.canonicalMime,
            size: typeof staged.payloadSize === 'number' ? staged.payloadSize : staged.item.file.size
          }
        });
      }

      if (stagedFiles.length > 0) {
        const batchRecorded = await SubmissionReservationManager.completeBatchPromotion(
          leaseId,
          fenceToken
        );
        if (!batchRecorded) {
          const conflictErr = new Error('Form is currently being deleted');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }
      }

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      const submittedBy = req.ip || 'anonymous';

      response = await withRequiredTransaction(async (session) => {
        const txNow = new Date();

        // Step 1: Write-lock Form coordination document inside replica-set transaction
        const lockedForm = await Form.findOneAndUpdate(
          {
            _id: req.params.formId,
            status: 'published',
            $or: [
              { 'deletionProgress.leaseId': null },
              { 'deletionProgress.leaseExpiresAt': null },
              { 'deletionProgress.leaseExpiresAt': { $lt: txNow } }
            ]
          },
          {
            $inc: { lifecycleVersion: 1 },
            $set: { updatedAt: txNow }
          },
          { session, new: true }
        );

        if (!lockedForm) {
          const existingForm = await Form.findById(req.params.formId).session(session);
          const formHasActiveDeletionLease = Boolean(
            existingForm?.deletionProgress?.leaseId &&
            existingForm?.deletionProgress?.leaseExpiresAt &&
            new Date(existingForm.deletionProgress.leaseExpiresAt) >= txNow
          );
          if (
            !existingForm ||
            ['deleting', 'delete_failed'].includes(existingForm.status) ||
            formHasActiveDeletionLease
          ) {
            const conflictErr = new Error('Form is currently being deleted');
            conflictErr.statusCode = 409;
            throw conflictErr;
          }
          const closedErr = new Error('This form is not accepting responses');
          closedErr.statusCode = 403;
          throw closedErr;
        }

        // Step 2: Pre-commit fence: transition reservation from 'active' to 'committing'
        const isCommitting = await SubmissionReservationManager.markCommitting(
          leaseId,
          fenceToken,
          session,
          undefined,
          expectedGeneration
        );
        if (!isCommitting) {
          const conflictErr = new Error('Form is currently being deleted');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }

        const docData = {
          _id: responseId,
          formId: req.params.formId,
          answers: validAnswersToSave,
          submittedBy,
          payloadHash,
          reservationLeaseId: leaseId,
          publicationAttemptId,
          commitStatus: 'committed',
          ...(idempotencyKey ? { idempotencyKey } : {})
        };

        // Step 3: Insert Response document atomically inside same transaction
        const [created] = await Response.create([docData], { session });

        // Step 4: Finalize reservation and decrement Form.activeSubmissions atomically
        const finalized = await SubmissionReservationManager.finalize(
          leaseId,
          fenceToken,
          session,
          req.params.formId,
          stagedFiles.map((s) => s.stagingKey)
        );
        if (!finalized) {
          const conflictErr = new Error('Form is currently being deleted');
          conflictErr.statusCode = 409;
          throw conflictErr;
        }

        // Step 5: Atomically transition promoted files to COMMITTED inside replica-set transaction session
        if (stagedFiles.length > 0) {
          const promotedFinalKeys = stagedFiles.map((s) => s.finalKey);
          const commitRes = await StorageJournal.commitInTransaction(promotedFinalKeys, {
            responseId: created._id,
            formId: req.params.formId,
            session
          });
          if (!commitRes || commitRes.matchedCount !== promotedFinalKeys.length) {
            const journalMismatchErr = new Error(
              `StorageJournal commit mismatch: expected ${promotedFinalKeys.length} matching operations, got ${commitRes?.matchedCount || 0}`
            );
            journalMismatchErr.statusCode = 500;
            throw journalMismatchErr;
          }
        }

        return created;
      }, { partitionKey: String(req.params.formId) });

      // Durable post-commit staging cleanup: tracked task with CAS leasing
      if (stagedFiles.length > 0) {
        try {
          await trackDeletionTask(
            SubmissionReservationManager.performStagingCleanup(leaseId, req.params.formId)
          );
        } catch (cleanupErr) {
          logger.warn('submission.staging_cleanup_immediate_failed', {
            leaseId,
            formId: req.params.formId,
            error: cleanupErr.message
          });
        }
      }

      return response;
    }, { req });

    persistenceCommitted = true;
    hasSubmissionReservation = false;
    } catch (uploadOrDbError) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      // Check if this error represents an unknown transaction commit result (commit ambiguity)
      if (isUnknownTransactionCommitResult(uploadOrDbError)) {
        logger.error('submission.transaction_commit_ambiguous', uploadOrDbError, {
          leaseId,
          formId: targetFormId,
          event: 'submission.commit_ambiguous'
        });

        // Disarm destructive compensation; preserve reservation and S3 files
        hasSubmissionReservation = false;

        try {
          await SubmissionReservationManager.armAmbiguousCommitQuarantine(
            leaseId,
            fenceToken,
            targetFormId
          );
        } catch (quarantineErr) {
          logger.warn('submission.arm_ambiguous_quarantine_failed', {
            leaseId,
            error: quarantineErr.message
          });
        }

        res.setHeader('Retry-After', '2');
        if (idempotencyKey) {
          res.setHeader('Idempotency-Key', idempotencyKey);
        }
        return res.status(503).json({
          success: false,
          code: 'TRANSACTION_COMMIT_AMBIGUOUS',
          message:
            'Submission processing timed out with an unconfirmed transaction outcome. Please retry with the same idempotency key.',
          retryable: true,
          idempotencyKey: idempotencyKey || null,
          leaseId,
          publicationAttemptId
        });
      }

      // Rollback S3 uploads & reservation ONLY if persistence did not commit
      if (!persistenceCommitted && hasSubmissionReservation) {
        hasSubmissionReservation = false;
        await trackMutationOperation(
          () =>
            SubmissionReservationManager.release(
              leaseId,
              fenceToken,
              uploadedKeys,
              targetFormId
            ),
          { req }
        ).catch(() => {});
      }

      // Check if duplicate key error occurred for idempotencyKey
      const isDuplicateKey =
        uploadOrDbError?.code === 11000 || uploadOrDbError?.cause?.code === 11000;
      if (isDuplicateKey && idempotencyKey) {
        const existingResponse = await Response.findOne({
          formId: req.params.formId,
          idempotencyKey
        });
        if (existingResponse) {
          if (existingResponse.payloadHash && existingResponse.payloadHash !== payloadHash) {
            return res.status(409).json({
              success: false,
              message: 'Idempotency key was previously used with a different submission payload'
            });
          }
          const isCommitted = await verifyCommittedIdempotentResponse(existingResponse);
          if (!isCommitted) {
            return res.status(409).json({
              success: false,
              message:
                'Previous submission with this idempotency key is incomplete or no longer active'
            });
          }
          return res.status(200).json({
            success: true,
            message: 'Response already submitted',
            data: {
              id: existingResponse._id
            }
          });
        }

        return res.status(409).json({
          success: false,
          message: 'Form is currently being deleted'
        });
      }

      if (uploadOrDbError instanceof AdmissionError) {
        if (uploadOrDbError.code === 'ERR_UPLOAD_ADMISSION_QUEUE_FULL') {
          res.setHeader('Retry-After', '5');
          return res.status(429).json({
            success: false,
            code: 'ERR_UPLOAD_ADMISSION_QUEUE_FULL',
            message: 'Upload concurrency limit reached. Please retry in a few moments.'
          });
        }
        if (uploadOrDbError.code === 'ERR_UPLOAD_ADMISSION_TIMEOUT') {
          res.setHeader('Retry-After', '5');
          return res.status(504).json({
            success: false,
            code: 'ERR_UPLOAD_ADMISSION_TIMEOUT',
            message: 'Server timed out waiting for upload capacity.'
          });
        }
        if (uploadOrDbError.code === 'ERR_UPLOAD_ADMISSION_DRAINING') {
          res.setHeader('Retry-After', '15');
          return res.status(503).json({
            success: false,
            code: 'ERR_UPLOAD_ADMISSION_DRAINING',
            message: 'Server is currently undergoing maintenance. Please retry shortly.'
          });
        }
        if (uploadOrDbError.code === 'ERR_UPLOAD_ADMISSION_ABORTED') {
          return res.status(499).json({
            success: false,
            code: 'ERR_UPLOAD_ADMISSION_ABORTED',
            message: 'Upload admission canceled by client.'
          });
        }
      }

      if (uploadOrDbError.statusCode === 409 || uploadOrDbError.statusCode === 403) {
        return res.status(uploadOrDbError.statusCode).json({
          success: false,
          message: uploadOrDbError.message || 'Form is currently being deleted'
        });
      }
      throw uploadOrDbError;
    }

    // Send email notification asynchronously via setImmediate (C4) strictly post-commit
    setImmediate(async () => {
      try {
        const owner = await User.findById(authoritativeForm.ownerId);
        if (owner) {
          const emailService = new EmailService();
          const escapedTitle = escapeHtml(authoritativeForm.title);
          await emailService.sendEmail({
            to: owner.email,
            subject: `New submission for form: ${authoritativeForm.title}`,
            html: `<p>You have received a new submission for your form <strong>${escapedTitle}</strong>.</p><p><a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard">View Responses</a></p>`
          });
        }
      } catch (emailErr) {
        logger.warn('notification.email_failed', emailErr, { formId: authoritativeForm._id });
      }
    });

    res.status(201).json({
      success: true,
      message: 'Response submitted successfully',
      data: {
        id: response._id
      }
    });
  } catch (error) {
    next(error);
  } finally {
    if (clientDisconnectHandler) {
      if (typeof req.off === 'function') {
        req.off('close', clientDisconnectHandler);
        req.off('aborted', clientDisconnectHandler);
      } else if (typeof req.removeListener === 'function') {
        req.removeListener('close', clientDisconnectHandler);
        req.removeListener('aborted', clientDisconnectHandler);
      }
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (hasSubmissionReservation && !persistenceCommitted) {
      const releasePromise = SubmissionReservationManager.release(
        leaseId,
        fenceToken,
        uploadedKeys,
        targetFormId
      ).catch(() => {});

      const track = req?.trackMutationOperation || trackMutationOperation;
      if (typeof track === 'function') {
        track(releasePromise, { req, operationType: 'storage', description: 'reservation_release_cleanup' });
      }
      await releasePromise;
    }
    if (localUploadPermit) {
      localUploadPermit.release();
      localUploadPermit = null;
    }
    // Clean up temporary files from disk
    cleanupRequestTempFiles(req);
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

    if (['deleting', 'delete_failed'].includes(form.status)) {
      return res.status(409).json({
        success: false,
        message: 'Form is currently being deleted'
      });
    }

    const { page = 1, limit = 50, startDate, endDate } = req.query;

    // Validate pagination limits safely against NaN, negative, zero, and excessively large values
    const MAX_PAGE = 100000;
    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    const pageNum =
      Number.isInteger(parsedPage) && parsedPage > 0 ? Math.min(parsedPage, MAX_PAGE) : 1;
    const limitNum =
      Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50;
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
        .select('-submittedBy')
        .sort({ createdAt: -1, _id: -1 })
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
        pages: Math.ceil(total / limitNum) || 0
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

    if (['deleting', 'delete_failed'].includes(form.status)) {
      return res.status(409).json({ success: false, message: 'Form is currently being deleted' });
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

    // 1. Parallel fetch of form responses metrics, timeline aggregation, and questions
    const [totalResponses, completedResponses, timeline, questions] = await Promise.all([
      Response.countDocuments(matchCriteria),
      Response.countDocuments({
        ...matchCriteria,
        'answers.0': { $exists: true }
      }),
      Response.aggregate([
        { $match: matchCriteria },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Question.find({ formId: form._id }).sort({ order: 1 })
    ]);

    const completionRate =
      totalResponses > 0 ? Math.round((completedResponses / totalResponses) * 100) : 0;

    const choiceTypes = ['single_choice', 'multiple_choice', 'checkbox', 'dropdown'];
    const choiceQuestionIds = questions
      .filter((q) => choiceTypes.includes(q.type))
      .map((q) => q._id);
    const numberQuestionIds = questions.filter((q) => q.type === 'number').map((q) => q._id);
    const ratingQuestionIds = questions.filter((q) => q.type === 'rating').map((q) => q._id);

    // Parallel bounded aggregations avoiding any unbounded values: { $push: '$answers.value' }
    const [totalAnswersAgg, choiceAgg, numberAgg, ratingAgg] = await Promise.all([
      // 1. Total answer count per question (pre-filtered in-memory on answers array before unwind)
      Response.aggregate([
        { $match: matchCriteria },
        {
          $project: {
            _id: 0,
            answers: {
              $filter: {
                input: {
                  $cond: {
                    if: { $isArray: '$answers' },
                    then: '$answers',
                    else: []
                  }
                },
                as: 'ans',
                cond: {
                  $and: [
                    { $ne: ['$$ans.questionId', null] },
                    { $ne: [{ $type: '$$ans.value' }, 'missing'] },
                    { $ne: ['$$ans.value', null] },
                    { $ne: ['$$ans.value', ''] },
                    { $ne: ['$$ans.value', []] },
                    {
                      $cond: {
                        if: { $eq: [{ $type: '$$ans.value' }, 'string'] },
                        then: { $gt: [{ $strLenCP: { $trim: { input: '$$ans.value' } } }, 0] },
                        else: true
                      }
                    }
                  ]
                }
              }
            }
          }
        },
        { $unwind: '$answers' },
        {
          $group: {
            _id: '$answers.questionId',
            totalAnswers: { $sum: 1 }
          }
        }
      ]),
      // 2. Top-N Option frequency counts for choice/checkbox questions directly inside MongoDB
      choiceQuestionIds.length > 0
        ? Response.aggregate(
            [
              {
                $match: {
                  ...matchCriteria,
                  'answers.questionId': { $in: choiceQuestionIds }
                }
              },
              {
                $project: {
                  _id: 0,
                  answers: {
                    $filter: {
                      input: {
                        $cond: {
                          if: { $isArray: '$answers' },
                          then: '$answers',
                          else: []
                        }
                      },
                      as: 'ans',
                      cond: {
                        $and: [
                          { $in: ['$$ans.questionId', choiceQuestionIds] },
                          { $ne: [{ $type: '$$ans.value' }, 'missing'] },
                          { $ne: ['$$ans.value', null] }
                        ]
                      }
                    }
                  }
                }
              },
              { $unwind: '$answers' },
              {
                $project: {
                  questionId: '$answers.questionId',
                  value: {
                    $cond: {
                      if: { $isArray: '$answers.value' },
                      then: '$answers.value',
                      else: ['$answers.value']
                    }
                  }
                }
              },
              { $unwind: '$value' },
              {
                $match: {
                  $expr: {
                    $and: [
                      { $in: [{ $type: '$value' }, ['string', 'int', 'long', 'double', 'decimal']] },
                      { $ne: [{ $trim: { input: { $toString: '$value' } } }, ''] }
                    ]
                  }
                }
              },
              // Stage 1: Group by questionId and exact trimmed option string
              {
                $group: {
                  _id: {
                    questionId: '$questionId',
                    option: { $trim: { input: { $toString: '$value' } } }
                  },
                  count: { $sum: 1 }
                }
              },
              // Stage 2: Rank top 20 candidates per question directly inside MongoDB
              {
                $group: {
                  _id: '$_id.questionId',
                  totalSelections: { $sum: '$count' },
                  totalCategories: { $sum: 1 },
                  topOptions: {
                    $topN: {
                      n: 20,
                      sortBy: { count: -1, '_id.option': 1 },
                      output: {
                        option: '$_id.option',
                        count: '$count'
                      }
                    }
                  }
                }
              }
            ],
            { allowDiskUse: true }
          )
        : [],
      // 3. Numeric min, max, sum, and count (computed entirely within database)
      numberQuestionIds.length > 0
        ? Response.aggregate([
            {
              $match: {
                ...matchCriteria,
                'answers.questionId': { $in: numberQuestionIds }
              }
            },
            {
              $project: {
                _id: 0,
                answers: {
                  $filter: {
                    input: {
                      $cond: {
                        if: { $isArray: '$answers' },
                        then: '$answers',
                        else: []
                      }
                    },
                    as: 'ans',
                    cond: {
                      $and: [
                        { $in: ['$$ans.questionId', numberQuestionIds] },
                        { $ne: [{ $type: '$$ans.value' }, 'missing'] },
                        { $ne: ['$$ans.value', null] }
                      ]
                    }
                  }
                }
              }
            },
            { $unwind: '$answers' },
            {
              $project: {
                questionId: '$answers.questionId',
                numVal: {
                  $convert: {
                    input: '$answers.value',
                    to: 'double',
                    onError: null,
                    onNull: null
                  }
                },
                rawVal: '$answers.value'
              }
            },
            {
              $match: {
                numVal: { $ne: null },
                $expr: {
                  $and: [{ $ne: ['$rawVal', ''] }, { $ne: [{ $type: '$rawVal' }, 'bool'] }]
                }
              }
            },
            {
              $group: {
                _id: '$questionId',
                min: { $min: '$numVal' },
                max: { $max: '$numVal' },
                sum: { $sum: '$numVal' },
                count: { $sum: 1 }
              }
            }
          ])
        : [],
      // 4. Rating star distribution (1 to 5)
      ratingQuestionIds.length > 0
        ? Response.aggregate([
            {
              $match: {
                ...matchCriteria,
                'answers.questionId': { $in: ratingQuestionIds }
              }
            },
            {
              $project: {
                _id: 0,
                answers: {
                  $filter: {
                    input: {
                      $cond: {
                        if: { $isArray: '$answers' },
                        then: '$answers',
                        else: []
                      }
                    },
                    as: 'ans',
                    cond: {
                      $and: [
                        { $in: ['$$ans.questionId', ratingQuestionIds] },
                        { $ne: [{ $type: '$$ans.value' }, 'missing'] },
                        { $ne: ['$$ans.value', null] }
                      ]
                    }
                  }
                }
              }
            },
            { $unwind: '$answers' },
            {
              $project: {
                questionId: '$answers.questionId',
                ratingVal: {
                  $convert: {
                    input: '$answers.value',
                    to: 'int',
                    onError: null,
                    onNull: null
                  }
                },
                rawVal: '$answers.value'
              }
            },
            {
              $match: {
                ratingVal: { $gte: 1, $lte: 5 },
                $expr: {
                  $and: [{ $ne: ['$rawVal', ''] }, { $ne: [{ $type: '$rawVal' }, 'bool'] }]
                }
              }
            },
            {
              $group: {
                _id: {
                  questionId: '$questionId',
                  rating: '$ratingVal'
                },
                count: { $sum: 1 }
              }
            }
          ])
        : []
    ]);

    // Fast O(1) mappings with prototype pollution protection
    const totalAnswersMap = Object.create(null);
    for (const item of totalAnswersAgg) {
      if (item && item._id != null) {
        totalAnswersMap[item._id.toString()] = item.totalAnswers;
      }
    }

    const choiceStatsMap = Object.create(null);
    for (const item of choiceAgg) {
      if (item && item._id != null) {
        choiceStatsMap[item._id.toString()] = item;
      }
    }

    const numberStatsMap = Object.create(null);
    for (const item of numberAgg) {
      if (item && item._id != null) {
        numberStatsMap[item._id.toString()] = item;
      }
    }

    const ratingDistMap = Object.create(null);
    for (const item of ratingAgg) {
      if (item && item._id?.questionId != null) {
        const qIdStr = item._id.questionId.toString();
        if (!ratingDistMap[qIdStr]) {
          ratingDistMap[qIdStr] = Object.create(null);
        }
        ratingDistMap[qIdStr][item._id.rating] = item.count;
      }
    }

    const analytics = questions.map((question) => {
      const qIdStr = question._id.toString();
      const totalAnswers = totalAnswersMap[qIdStr] || 0;
      const { type } = question;
      let data = {};

      if (choiceTypes.includes(type)) {
        const stats = choiceStatsMap[qIdStr];
        const totalSelections = stats?.totalSelections || 0;
        const totalCategories = stats?.totalCategories || 0;
        const topOptions = stats?.topOptions || [];
        const optionsList = Array.isArray(question.options) ? question.options : [];
        const TOP_CATEGORIES_LIMIT = 20;

        let distribution = [];
        let otherCount = 0;
        let isTruncated = false;

        if (totalCategories <= TOP_CATEGORIES_LIMIT) {
          const optionCounts = Object.create(null);
          for (const item of topOptions) {
            optionCounts[item.option] = item.count;
          }

          const allOptionsMap = new Map();
          for (const opt of optionsList) {
            allOptionsMap.set(opt, optionCounts[opt] || 0);
          }
          for (const item of topOptions) {
            if (!allOptionsMap.has(item.option)) {
              allOptionsMap.set(item.option, item.count);
            }
          }

          distribution = Array.from(allOptionsMap.entries()).map(([opt, count]) => ({
            option: opt,
            count,
            percentage: totalAnswers > 0 ? Math.round((count / totalAnswers) * 100) : 0
          }));
        } else {
          isTruncated = true;
          const topEntries = topOptions.slice(0, TOP_CATEGORIES_LIMIT - 1);
          let topCountsSum = 0;
          for (const item of topEntries) {
            topCountsSum += item.count;
          }
          otherCount = Math.max(0, totalSelections - topCountsSum);

          distribution = topEntries.map((item) => ({
            option: item.option,
            count: item.count,
            percentage: totalAnswers > 0 ? Math.round((item.count / totalAnswers) * 100) : 0
          }));

          if (otherCount > 0) {
            distribution.push({
              option: 'Other',
              count: otherCount,
              percentage: totalAnswers > 0 ? Math.round((otherCount / totalAnswers) * 100) : 0
            });
          }
        }

        data = {
          type: 'options',
          distribution,
          totalSelections,
          isTruncated,
          displayedCategories: distribution.length,
          totalCategories: isTruncated ? totalCategories : distribution.length,
          otherCount
        };
      } else if (type === 'number') {
        const numStats = numberStatsMap[qIdStr];
        if (numStats && numStats.count > 0) {
          data = {
            type: 'number',
            min: numStats.min,
            max: numStats.max,
            average: Number((numStats.sum / numStats.count).toFixed(2))
          };
        } else {
          data = { type: 'number', min: null, max: null, average: null };
        }
      } else if (type === 'rating') {
        const ratingCounts = ratingDistMap[qIdStr] || Object.create(null);
        const distribution = {
          1: ratingCounts[1] || 0,
          2: ratingCounts[2] || 0,
          3: ratingCounts[3] || 0,
          4: ratingCounts[4] || 0,
          5: ratingCounts[5] || 0
        };

        let sum = 0;
        let totalRatings = 0;
        for (let r = 1; r <= 5; r++) {
          const c = distribution[r];
          sum += r * c;
          totalRatings += c;
        }

        const average = totalRatings > 0 ? Number((sum / totalRatings).toFixed(1)) : 0;
        data = {
          type: 'rating',
          average,
          distribution,
          totalRatings
        };
      } else if (type === 'file') {
        data = { type: 'file', count: totalAnswers };
      } else {
        // Text / Email / Date types
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
        totalResponses,
        summary: {
          totalResponses,
          completedResponses,
          completionRate
        },
        timeline: timeline.map((t) => ({ date: t._id, count: t.count })),
        analytics
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Formats an answer value of any shape into a clean string representation for CSV export.
 * Handles strings, numbers, booleans, arrays, file upload objects, and unexpected objects
 * deterministically without crashing or producing [object Object].
 */
export const formatCsvAnswer = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => formatCsvAnswer(item))
      .filter((item) => item !== '')
      .join('; ');
  }

  if (typeof value === 'object') {
    // Check if it's a file upload answer object
    const isFile =
      Boolean(value.originalName) ||
      Boolean(value.fileName) ||
      Boolean(value.filename) ||
      Boolean(value.name) ||
      Boolean(value.key) ||
      Boolean(value.mimeType);

    if (isFile) {
      return (
        value.originalName ||
        value.fileName ||
        value.filename ||
        value.name ||
        (typeof value.key === 'string' ? value.key.split('/').pop() : null) ||
        'Attached File'
      );
    }

    // Unexpected object: serialize deterministically with JSON to avoid [object Object]
    try {
      const json = JSON.stringify(value);
      return json === '{}' ? '' : json;
    } catch {
      return '';
    }
  }

  return String(value);
};

/**
 * Sanitizes a cell value to prevent CSV / Spreadsheet Formula Injection (CWE-1236).
 * Prepends a single quote (') if the field starts with '=', '+', '-', '@', tab (\t),
 * carriage return (\r), or leading whitespace followed by a formula trigger,
 * unless the value is a valid numeric literal (e.g. -5, +42, -12.34).
 */
export const sanitizeCsvCell = (value) => {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);
  if (!str) {
    return '';
  }

  const trimmedStart = str.trimStart();
  if (!trimmedStart) {
    // String is only whitespace
    return str;
  }

  const firstChar = str[0];
  const firstTrimmedChar = trimmedStart[0];

  const startsWithTrigger =
    firstChar === '=' ||
    firstChar === '+' ||
    firstChar === '-' ||
    firstChar === '@' ||
    firstChar === '\t' ||
    firstChar === '\r' ||
    firstTrimmedChar === '=' ||
    firstTrimmedChar === '+' ||
    firstTrimmedChar === '-' ||
    firstTrimmedChar === '@';

  if (startsWithTrigger) {
    // Check if it's an ordinary numeric literal (e.g., "-5", "-12.34", "+42")
    const isNumeric = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(str.trim());
    if (isNumeric) {
      return str;
    }

    // Prepend single quote to neutralize formula execution in spreadsheet applications
    return `'${str}`;
  }

  return str;
};

/**
 * Escapes and encloses a cell value according to RFC 4180.
 * Double quotes inside the cell are escaped by doubling them (" -> "").
 * Every cell is enclosed in double quotes to reliably handle commas, newlines, and quotes.
 */
export const escapeCsvCell = (value) => {
  if (value === null || value === undefined) {
    return '""';
  }

  const str = String(value);
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
};

export { escapeHtml };

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

    if (['deleting', 'delete_failed'].includes(form.status)) {
      return res.status(409).json({
        success: false,
        message: 'Form is currently being deleted'
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

    let cursor = null;
    let clientAborted = false;

    const safeDestroyCursor = () => {
      if (cursor && !cursor.destroyed) {
        try {
          const destroyResult = cursor.destroy();
          if (destroyResult && typeof destroyResult.catch === 'function') {
            destroyResult.catch((err) => {
              logger.error('export.cursor_destroy_failed', err, {
                formId: req.params.formId
              });
            });
          }
        } catch (destroyError) {
          logger.error('export.cursor_destroy_failed', destroyError, {
            formId: req.params.formId
          });
        }
      }
    };

    const handleClientDisconnect = () => {
      if (!res.writableEnded) {
        clientAborted = true;
        safeDestroyCursor();
      }
    };

    res.on('close', handleClientDisconnect);

    const writeChunk = (chunk) => {
      if (clientAborted || res.destroyed || res.writableEnded) {
        return Promise.resolve(false);
      }
      if (res.write(chunk)) {
        return Promise.resolve(true);
      }
      if (clientAborted || res.destroyed || res.writableEnded) {
        return Promise.resolve(false);
      }
      return new Promise((resolve, reject) => {
        const cleanupListeners = () => {
          res.off('drain', onDrain);
          res.off('close', onClose);
          res.off('error', onError);
        };
        const onDrain = () => {
          cleanupListeners();
          resolve(true);
        };
        const onClose = () => {
          cleanupListeners();
          resolve(false);
        };
        const onError = (err) => {
          cleanupListeners();
          reject(err);
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
      });
    };

    try {
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="responses-${req.params.formId}.csv"`
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');

        const headers = ['Timestamp', ...questions.map((q) => q.label)];
        const headerLine = headers.map((h) => escapeCsvCell(sanitizeCsvCell(h))).join(',');

        const headerWritten = await writeChunk(headerLine);
        if (!headerWritten || clientAborted) {
          return;
        }

        const questionIdList = questions.map((q) => q._id.toString());

        cursor = Response.find(query)
          .sort({ createdAt: 1, _id: 1 })
          .lean()
          .cursor({ batchSize: 500 });

        if (cursor && typeof cursor.on === 'function') {
          cursor.on('error', (cursorErr) => {
            logger.debug(`[ResponseController] CSV cursor error: ${cursorErr.message}`);
          });
        }

        for await (const response of cursor) {
          if (clientAborted || res.destroyed || res.writableEnded) {
            break;
          }

          const timestamp = response.createdAt ? new Date(response.createdAt).toISOString() : '';
          const row = [timestamp];

          const answerMap = new Map();
          if (Array.isArray(response.answers)) {
            for (const a of response.answers) {
              if (a) {
                const aQId = (a.questionId?._id || a.questionId)?.toString();
                if (aQId) answerMap.set(aQId, a.value);
              }
            }
          }

          for (const qIdStr of questionIdList) {
            const rawValue = answerMap.has(qIdStr) ? answerMap.get(qIdStr) : '';
            row.push(formatCsvAnswer(rawValue));
          }

          const formattedRow = row.map((cell) => escapeCsvCell(sanitizeCsvCell(cell))).join(',');
          const chunkWritten = await writeChunk('\r\n' + formattedRow);
          if (!chunkWritten) {
            break;
          }
        }

        if (!clientAborted && !res.writableEnded && !res.destroyed) {
          res.end();
        } else if (clientAborted) {
          logger.info('export.csv_streaming_aborted_by_client', {
            formId: req.params.formId
          });
        }
      } else {
        // Return JSON streaming (PERF-01)
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="responses-${req.params.formId}.json"`
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');

        const prefix =
          '{"success":true,"data":{"form":' +
          JSON.stringify({
            id: form._id,
            title: form.title,
            description: form.description
          }) +
          ',"questions":' +
          JSON.stringify(
            questions.map((q) => ({
              id: q._id,
              label: q.label,
              type: q.type
            }))
          ) +
          ',"responses":[';

        const prefixWritten = await writeChunk(prefix);
        if (!prefixWritten || clientAborted) {
          return;
        }

        cursor = Response.find(query)
          .sort({ createdAt: 1, _id: 1 })
          .lean()
          .cursor({ batchSize: 500 });

        if (cursor && typeof cursor.on === 'function') {
          cursor.on('error', (cursorErr) => {
            logger.debug(`[ResponseController] JSON cursor error: ${cursorErr.message}`);
          });
        }

        let isFirst = true;
        for await (const response of cursor) {
          if (clientAborted || res.destroyed || res.writableEnded) {
            break;
          }

          const responseItem = {
            id: response._id,
            submittedAt: response.createdAt,
            answers: response.answers
          };

          const chunk = (isFirst ? '' : ',') + JSON.stringify(responseItem);
          isFirst = false;

          const chunkWritten = await writeChunk(chunk);
          if (!chunkWritten) {
            break;
          }
        }

        if (!clientAborted && !res.writableEnded && !res.destroyed) {
          await writeChunk(']}}');
          res.end();
        } else if (clientAborted) {
          logger.info('export.json_streaming_aborted_by_client', {
            formId: req.params.formId
          });
        }
      }
    } catch (streamError) {
      if (!res.headersSent) {
        return next(streamError);
      }
      const isClientAbort =
        clientAborted ||
        res.destroyed ||
        res.writableEnded ||
        streamError.message?.includes('closed cursor') ||
        streamError.name === 'MongoExpiredSessionError';
      if (isClientAbort) {
        logger.info(
          format === 'csv'
            ? 'export.csv_streaming_aborted_by_client'
            : 'export.json_streaming_aborted_by_client',
          {
            formId: req.params.formId
          }
        );
      } else {
        logger.error(
          format === 'csv'
            ? 'export.csv_streaming_failed'
            : 'export.json_streaming_failed',
          streamError,
          {
            formId: req.params.formId
          }
        );
      }
      if (!res.destroyed && typeof res.destroy === 'function') {
        res.destroy(streamError);
      }
    } finally {
      res.off('close', handleClientDisconnect);
      safeDestroyCursor();
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
    const txResult = await withRequiredTransaction(async (session) => {
      const now = new Date();
      const lockedForm = await Form.findOneAndUpdate(
        {
          _id: req.params.formId,
          ownerId: req.user.id,
          status: { $nin: ['deleting', 'delete_failed'] },
          $or: [
            { 'deletionProgress.leaseId': null },
            { 'deletionProgress.leaseExpiresAt': null },
            { 'deletionProgress.leaseExpiresAt': { $lt: now } }
          ]
        },
        {
          $inc: { lifecycleVersion: 1 },
          $set: { updatedAt: now }
        },
        { session, new: true }
      );

      if (!lockedForm) {
        const existingForm = await Form.findById(req.params.formId).session(session);
        if (!existingForm) {
          return { statusCode: 404, message: 'Form not found' };
        }
        if (existingForm.ownerId.toString() !== req.user.id) {
          return { statusCode: 403, message: 'Not authorized to delete responses' };
        }
        return { statusCode: 409, message: 'Form is currently being deleted' };
      }

      const deletedResponse = await Response.findOneAndDelete({
        _id: req.params.responseId,
        formId: req.params.formId
      })
        .session(session)
        .lean();

      if (!deletedResponse) {
        return { statusCode: 404, message: 'Response not found' };
      }

      // Filter Category A safe storage keys
      const answers = Array.isArray(deletedResponse.answers) ? deletedResponse.answers : [];
      const keysToDelete = [];
      for (const answer of answers) {
        if (answer?.value?.key) {
          const classification = classifyStorageKey(answer.value.key, req.params.formId);
          if (classification.category === 'A') {
            keysToDelete.push(classification.key);
          } else {
            logger.warn('storage.response_file_delete_skipped_unsafe_key', {
              key: answer.value.key,
              category: classification.category,
              reason: classification.reason,
              responseId: deletedResponse._id
            });
          }
        }
      }

      // Persist durable StorageJournal deletion intents inside transaction session
      const pendingDeleteOps = [];
      if (keysToDelete.length > 0) {
        const journalEntries = keysToDelete.map((key) => {
          const operationId = crypto.randomUUID();
          pendingDeleteOps.push({ operationId, key });
          return {
            operationId,
            type: STORAGE_OPERATION_TYPE.DELETE_OBJECT,
            bucket: process.env.S3_BUCKET || 'paperless',
            destinationKey: key,
            sourceKey: null,
            formId: req.params.formId,
            responseId: deletedResponse._id,
            status: STORAGE_JOURNAL_STATUS.PENDING,
            quarantinedUntil: null,
            vacuumAt: null,
            createdAt: now,
            updatedAt: now
          };
        });

        await StorageJournal.create(journalEntries, { session });
      }

      return { statusCode: 200, deletedResponse, pendingDeleteOps };
    }, { partitionKey: String(req.params.formId) });

    if (txResult.statusCode !== 200) {
      return res.status(txResult.statusCode).json({
        success: false,
        message: txResult.message
      });
    }

    // Outside transaction: dispatch remote S3 file deletions
    const pendingDeleteOps = txResult.pendingDeleteOps || [];
    for (const op of pendingDeleteOps) {
      try {
        await storageService.deleteFile(op.key, {
          operationId: op.operationId,
          formId: req.params.formId
        });
      } catch (err) {
        logger.warn('storage.response_file_delete_failed', err, {
          key: op.key,
          operationId: op.operationId,
          responseId: txResult.deletedResponse._id
        });
      }
    }

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

    if (['deleting', 'delete_failed'].includes(form.status)) {
      return res.status(409).json({ success: false, message: 'Form is currently being deleted' });
    }

    const response = await Response.findOne({
      _id: req.params.responseId,
      formId: req.params.formId
    });

    if (!response) {
      return res.status(404).json({ success: false, message: 'Response not found' });
    }

    const answer = Array.isArray(response.answers)
      ? response.answers.find(
          (a) => a && a.questionId && a.questionId.toString() === req.params.questionId
        )
      : null;

    if (!answer || !answer.value || !answer.value.key) {
      return res.status(404).json({ success: false, message: 'File not found in response' });
    }

    // P44-SEC-02: Validate storage key namespace and path integrity
    const classification = classifyStorageKey(answer.value.key, form._id.toString());
    if (classification.category !== 'A') {
      logger.warn('storage.download_unsafe_key_blocked', {
        key: answer.value.key,
        category: classification.category,
        reason: classification.reason,
        formId: form._id.toString(),
        responseId: req.params.responseId,
        questionId: req.params.questionId,
        userId: req.user.id
      });
      return res.status(404).json({ success: false, message: 'File not found in response' });
    }

    // Client disconnect detection during S3 acquisition
    const clientAbortController = new AbortController();
    const onClientClosePreStream = () => {
      if (!res.writableEnded) {
        clientAbortController.abort();
      }
    };
    res.once('close', onClientClosePreStream);

    let fileData;
    try {
      fileData = await storageService.getFileStream(classification.key, {
        timeoutMs: STREAM_TIMEOUTS.ACQUISITION_TIMEOUT_MS,
        abortSignal: clientAbortController.signal
      });
    } catch (storageErr) {
      res.removeListener('close', onClientClosePreStream);
      if (clientAbortController.signal.aborted || res.destroyed) {
        logger.info('storage.download_aborted_during_acquisition', {
          responseId: req.params.responseId,
          formId: req.params.formId
        });
        return;
      }
      if (
        storageErr.name === 'NoSuchKey' ||
        storageErr.name === 'NotFound' ||
        storageErr.$metadata?.httpStatusCode === 404
      ) {
        return res.status(404).json({ success: false, message: 'File not found in storage' });
      }
      if (storageErr.name === 'TimeoutError' || storageErr.name === 'AbortError') {
        logger.warn('storage.download_acquisition_timeout', {
          timeoutMs: STREAM_TIMEOUTS.ACQUISITION_TIMEOUT_MS,
          responseId: req.params.responseId
        });
        return res.status(504).json({ success: false, message: 'Storage request timed out' });
      }
      return next(storageErr);
    } finally {
      res.removeListener('close', onClientClosePreStream);
    }

    // Pre-stream guard: Check if client disconnected while acquiring stream
    if (res.destroyed || res.writableEnded) {
      if (fileData?.stream && typeof fileData.stream.destroy === 'function') {
        fileData.stream.destroy();
      }
      logger.info('storage.download_aborted_before_streaming', {
        responseId: req.params.responseId,
        formId: req.params.formId
      });
      return;
    }

    if (!fileData || !fileData.stream || typeof fileData.stream.pipe !== 'function') {
      return res.status(404).json({ success: false, message: 'File stream not found' });
    }

    // Determine safe content type
    const rawMimeType = answer.value.mimeType || fileData.contentType || 'application/octet-stream';
    const safeMimeType = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(rawMimeType)
      ? rawMimeType
      : 'application/octet-stream';

    // Extract base filename and sanitize to prevent path traversal, header injection, or control characters
    const suppliedFilename =
      answer.value.originalName ||
      (answer.value.key ? path.basename(answer.value.key) : 'download');
    const baseFilename = path.basename(String(suppliedFilename).replace(/\\/g, '/'));
    const sanitizedFilename = baseFilename.replace(/[\r\n\0]/g, '_').trim() || 'download';

    res.setHeader('Content-Type', safeMimeType);
    res.setHeader('Content-Disposition', contentDisposition(sanitizedFilename));
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const contentLength = fileData.contentLength || answer.value.size;
    if (typeof contentLength === 'number' && contentLength > 0) {
      res.setHeader('Content-Length', contentLength);
    }

    // Inactivity watchdog for body streaming
    const INACTIVITY_MS = STREAM_TIMEOUTS.INACTIVITY_TIMEOUT_MS;
    let inactivityTimer = null;

    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        const stallErr = new Error(`Stream stalled: no data chunk received for ${INACTIVITY_MS}ms`);
        stallErr.name = 'StreamStallTimeoutError';
        stallErr.code = 'ERR_STREAM_STALLED';
        if (typeof fileData.stream.destroy === 'function') {
          fileData.stream.destroy(stallErr);
        }
      }, INACTIVITY_MS);
      if (typeof inactivityTimer.unref === 'function') {
        inactivityTimer.unref();
      }
    };

    const clearInactivityTimer = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    };

    // Client disconnect handler during active streaming
    const onStreamClose = () => {
      if (!res.writableEnded) {
        clearInactivityTimer();
        if (typeof fileData.stream.destroy === 'function') {
          fileData.stream.destroy();
        }
      }
    };
    res.once('close', onStreamClose);

    // Watch for data chunks to reset inactivity timer
    fileData.stream.on('data', resetInactivityTimer);
    resetInactivityTimer();

    // Stream file with backpressure, client disconnect cleanup, and safe error handling
    pipeline(fileData.stream, res, (err) => {
      clearInactivityTimer();
      res.removeListener('close', onStreamClose);
      if (typeof fileData.stream.removeListener === 'function') {
        fileData.stream.removeListener('data', resetInactivityTimer);
      }

      if (err) {
        const isStall = err.code === 'ERR_STREAM_STALLED' || err.name === 'StreamStallTimeoutError';

        const isClientAbort =
          !isStall && (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.name === 'AbortError');

        if (isClientAbort) {
          logger.info('storage.download_stream_aborted_by_client', {
            responseId: req.params.responseId,
            formId: req.params.formId,
            questionId: req.params.questionId
          });
        } else if (isStall) {
          logger.warn('storage.download_stream_stalled', {
            responseId: req.params.responseId,
            formId: req.params.formId,
            questionId: req.params.questionId,
            timeoutMs: INACTIVITY_MS
          });
        } else {
          logger.error('storage.stream_transmission_failed', err, {
            responseId: req.params.responseId,
            formId: req.params.formId,
            questionId: req.params.questionId
          });
        }

        if (!res.headersSent) {
          res.removeHeader('Content-Disposition');
          res.removeHeader('Content-Type');
          res.removeHeader('Content-Length');
          return next(err);
        }

        if (!res.destroyed && typeof res.destroy === 'function') {
          res.destroy(err);
        }
      }
    });
  } catch (error) {
    next(error);
  }
};
