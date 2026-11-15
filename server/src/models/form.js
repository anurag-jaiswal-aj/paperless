import mongoose from 'mongoose';

/**
 * Form Model
 * Stores form metadata created by users
 */
const formSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    required: [true, 'Form title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [1000, 'Description cannot exceed 1000 characters'],
    default: ''
  },
  status: {
    type: String,
    enum: ['draft', 'published', 'closed', 'deleting', 'delete_failed'],
    default: 'draft'
  },
  nextQuestionOrder: {
    type: Number,
    default: 0
  },
  deletionProgress: {
    stage: {
      type: String,
      enum: [
        'pending',
        's3_cleanup',
        'mongo_cleanup',
        'mongo_responses',
        'mongo_questions',
        'mongo_form',
        'completed',
        'failed'
      ],
      default: 'pending'
    },
    totalFiles: { type: Number, default: 0 },
    deletedFiles: { type: Number, default: 0 },
    failedKeys: { type: [String], default: [] },
    unresolvedKeys: { type: [String], default: [] },
    leaseId: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    epoch: { type: Number, default: 0 },
    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null }
  },
  reorderState: {
    inProgress: { type: Boolean, default: false },
    previousOrders: [
      {
        questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
        order: { type: Number }
      }
    ],
    targetOrders: [
      {
        questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Question' },
        order: { type: Number }
      }
    ],
    updatedAt: { type: Date, default: null }
  },
  activeSubmissions: {
    type: Number,
    default: 0,
    min: 0
  },
  activeSubmissionsExpiresAt: {
    type: Date,
    default: null
  },
  version: {
    type: Number,
    default: 0
  },
  lifecycleVersion: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt timestamp on save
formSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// Index for owner queries and deterministic pagination
formSchema.index({ ownerId: 1, createdAt: -1, _id: -1 });

// Compound index for deletion recovery, lease expiration, and startup sweep
formSchema.index({ status: 1, 'deletionProgress.leaseExpiresAt': 1 });

// Index for active submission concurrency checks
formSchema.index({ status: 1, activeSubmissions: 1 });

export default mongoose.model('Form', formSchema);
