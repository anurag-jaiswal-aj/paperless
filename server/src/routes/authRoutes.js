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
import { withMutationScope } from '../middleware/quiescenceGate.js';
import { protect } from '../middleware/authMiddleware.js';

// Rate Limiting (we'll implement this properly later, but importing express-rate-limit if needed)
// Actually the instructions say "Add rate limiting using an established Express-compatible solution".
import rateLimit from 'express-rate-limit';

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 100, // Limit each IP to 100 requests per windowMs (elevated in test suite)
  message: { success: false, message: 'Too many requests from this IP, please try again later.' }
});

export const passwordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { success: false, message: 'Too many password reset attempts, please try again later.' }
});

const router = express.Router();

router.use(authLimiter);

// Public routes
router.post('/register', withMutationScope(register));
// Progressive login protection is strictly encapsulated inside login controller (scoped exclusively to POST /login)
router.post('/login', withMutationScope(login));
router.post('/refresh', withMutationScope(refreshToken));
router.post('/logout', withMutationScope(logout));

// Password reset routes
router.post('/forgotpassword', passwordLimiter, withMutationScope(forgotPassword));
router.post('/resetpassword', passwordLimiter, withMutationScope(resetPassword));
router.put('/resetpassword', passwordLimiter, withMutationScope(resetPassword));
router.put('/resetpassword/:resettoken', passwordLimiter, withMutationScope(resetPassword));

// Protected routes
router.get('/me', protect, getMe);

export default router;
