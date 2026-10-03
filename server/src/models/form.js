import mongoose from 'mongoose';

/**
 * Form Model
 * Stores form metadata created by users
 */
const formSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
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
    enum: ['draft', 'published', 'closed'],
    default: 'draft'
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

// Index for owner queries
formSchema.index({ ownerId: 1, createdAt: -1 });

export default mongoose.model('Form', formSchema);
