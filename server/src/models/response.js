import mongoose from 'mongoose';

/**
 * Answer Subdocument Schema
 * Embedded in Response without generating redundant _id fields
 */
const answerSchema = new mongoose.Schema(
  {
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: true
    },
    value: {
      type: mongoose.Schema.Types.Mixed, // Can be string, array, or number
      required: true
    }
  },
  { _id: false }
);

/**
 * Response Model
 * Stores user submissions for a form
 */
const responseSchema = new mongoose.Schema({
  formId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Form',
    required: true
  },
  answers: [answerSchema],
  submittedBy: {
    type: String, // IP or identifier (optional for anonymous)
    default: 'anonymous'
  },
  idempotencyKey: {
    type: String
  },
  payloadHash: {
    type: String,
    default: null
  },
  reservationLeaseId: {
    type: String,
    default: null
  },
  publicationAttemptId: {
    type: String,
    default: null
  },
  commitStatus: {
    type: String,
    enum: ['committed', 'pending'],
    default: 'committed'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for form responses with stable pagination
responseSchema.index({ formId: 1, createdAt: -1, _id: -1 });
responseSchema.index(
  { formId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
// Multikey index for fast per-key lookup during tombstone sweep and reconciliation
responseSchema.index({ formId: 1, 'answers.value.key': 1 });

export default mongoose.model('Response', responseSchema);
