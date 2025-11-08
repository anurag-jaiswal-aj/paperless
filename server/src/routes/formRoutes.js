import express from 'express';
import {
  getForms,
  getForm,
  createForm,
  updateForm,
  deleteForm,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  reorderQuestions
} from '../controllers/formController.js';
import { protect, optionalAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

// Form routes
router.get('/', protect, getForms);
router.post('/', protect, createForm);
router.get('/:id', optionalAuth, getForm);
router.put('/:id', protect, updateForm);
router.delete('/:id', protect, deleteForm);

// Question routes
router.post('/:id/questions', protect, addQuestion);
router.put('/:formId/questions/:questionId', protect, updateQuestion);
router.delete('/:formId/questions/:questionId', protect, deleteQuestion);
router.put('/:formId/questions/reorder', protect, reorderQuestions);

export default router;
