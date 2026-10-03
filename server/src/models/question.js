import mongoose from 'mongoose';

/**
 * Question Model
 * Stores individual questions for a form
 * Types: short_text, long_text, multiple_choice, checkbox, dropdown, rating, date, file
 */
const questionSchema = new mongoose.Schema({
  formId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Form',
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    enum: [
      'short_text',
      'long_text',
      'number',
      'email',
      'single_choice',
      'multiple_choice',
      'dropdown',
      'file'
    ]
  },
  label: {
    type: String,
    required: [true, 'Question label is required'],
    trim: true,
    maxlength: [500, 'Label cannot exceed 500 characters']
  },
  required: {
    type: Boolean,
    default: false
  },
  order: {
    type: Number,
    required: true,
    default: 0
  },
  options: {
    type: [String],
    default: []
  },
  validation: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  visibilityRule: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for form questions ordered by sequence
questionSchema.index({ formId: 1, order: 1 });

export default mongoose.model('Question', questionSchema);
