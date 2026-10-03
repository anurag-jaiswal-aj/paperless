import mongoose from 'mongoose';

/**
 * Response Model
 * Stores user submissions for a form
 */
const responseSchema = new mongoose.Schema({
  formId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Form',
    required: true,
    index: true
  },
  answers: [
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
    }
  ],
  submittedBy: {
    type: String, // IP or identifier (optional for anonymous)
    default: 'anonymous'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for form responses with timestamp
responseSchema.index({ formId: 1, createdAt: -1 });

export default mongoose.model('Response', responseSchema);
