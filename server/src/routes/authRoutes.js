import express from 'express';
import {
  register,
  login,
  getMe,
  refreshToken,
  logout,
  forgotPassword,
  resetPassword
} from '../controllers/authController.js';
import { protect } from '../middleware/authMiddleware.js';

// Rate Limiting (we'll implement this properly later, but importing express-rate-limit if needed)
// Actually the instructions say "Add rate limiting using an established Express-compatible solution".
import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { success: false, message: 'Too many requests from this IP, please try again later.' }
});

const passwordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { success: false, message: 'Too many password reset attempts, please try again later.' }
});

const router = express.Router();

router.use(authLimiter);

// Public routes
router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refreshToken);
router.post('/logout', logout); // using POST for logout is safer
router.get('/logout', logout); // but allow GET for simplicity if accessed directly

// Password reset routes
router.post('/forgotpassword', passwordLimiter, forgotPassword);
router.put('/resetpassword/:resettoken', passwordLimiter, resetPassword);

// Protected routes
router.get('/me', protect, getMe);

export default router;
