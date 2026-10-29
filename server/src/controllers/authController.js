import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/user.js';
import EmailService from '../services/EmailService.js';

const emailService = new EmailService();

/**
 * Generate JWT Token
 */
const generateToken = (id, sessionId) => {
  const payload = sessionId ? { id, sessionId } : { id };
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '15m'
  });
};

/**
 * Generate Refresh Token
 */
const generateRefreshToken = (id, sessionId) => {
  const payload = sessionId
    ? { id, sessionId, jti: crypto.randomUUID() }
    : { id, jti: crypto.randomUUID() };
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d'
  });
};

const escapeRegex = (str) => {
  return typeof str === 'string' ? str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
};

const isValidSessionId = (id) => {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
};

const getLegacySessionId = (tokenHash) => {
  return 'legacy-' + tokenHash;
};

const buildSessionEntry = (sessionId, tokenHash) => {
  return sessionId ? `${sessionId}:${tokenHash}` : tokenHash;
};

/**
 * Helper: Get token from model, create cookie and send response
 */
const sendTokenResponse = async (user, statusCode, res, message, existingSessionId) => {
  const sessionId = existingSessionId || crypto.randomUUID();
  const token = generateToken(user._id, sessionId);
  const refreshToken = generateRefreshToken(user._id, sessionId);

  // Store refresh token hash in DB atomically with session prefix
  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const sessionEntry = buildSessionEntry(sessionId, tokenHash);

  const updatedUser = await User.findByIdAndUpdate(
    user._id,
    {
      $push: {
        refreshTokens: {
          $each: [sessionEntry],
          $slice: -5
        }
      }
    },
    { new: true, select: '-password' }
  );

  const finalUser = updatedUser || user;

  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/'
  };

  const tokenOptions = {
    ...options,
    expires: new Date(Date.now() + 15 * 60 * 1000) // 15 mins
  };

  const refreshOptions = {
    ...options,
    expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
  };

  res
    .status(statusCode)
    .cookie('token', token, tokenOptions)
    .cookie('refreshToken', refreshToken, refreshOptions)
    .json({
      success: true,
      message,
      data: {
        user: {
          id: finalUser._id,
          name: finalUser.name,
          email: finalUser.email
        }
      }
    });
};

/**
 * @route   POST /api/auth/register
 * @desc    Register new user
 * @access  Public
 */
export const register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide name, email, and password' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User already exists with this email' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      name,
      email,
      password: hashedPassword
    });

    await sendTokenResponse(user, 201, res, 'User registered successfully');
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/auth/login
 * @desc    Login user
 * @access  Public
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    await sendTokenResponse(user, 200, res, 'Login successful');
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/auth/logout
 * @desc    Log user out / clear cookie
 * @access  Private
 */
export const logout = async (req, res) => {
  try {
    let rawToken = req.cookies.refreshToken;

    if (!rawToken) {
      if (req.cookies.token) {
        rawToken = req.cookies.token;
      } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        rawToken = req.headers.authorization.split(' ')[1];
      }
    }

    if (rawToken && typeof rawToken === 'string') {
      try {
        let decoded = null;
        let tokenType = null; // 'refresh' | 'access'

        // Cryptographically verify signatures ignoring expiration so legitimately expired
        // client tokens can complete logout, while rejecting any forged/tampered tokens.
        try {
          decoded = jwt.verify(rawToken, process.env.JWT_REFRESH_SECRET, { ignoreExpiration: true });
          tokenType = 'refresh';
        } catch (e1) {
          try {
            decoded = jwt.verify(rawToken, process.env.JWT_SECRET, { ignoreExpiration: true });
            tokenType = 'access';
          } catch (e2) {
            // Neither signature verified: token is forged, corrupted, or signed with wrong secret.
            // Never trust unverified claims: do not decode and do not touch database state.
            decoded = null;
            tokenType = null;
          }
        }

        if (decoded && decoded.id) {
          const now = new Date();

          if (decoded.sessionId && isValidSessionId(decoded.sessionId)) {
            // Both modern access tokens and refresh tokens share the same sessionId.
            // Atomically revoke ANY token belonging to this session in MongoDB.
            const safePattern = '^' + escapeRegex(decoded.sessionId) + ':';
            await User.findByIdAndUpdate(decoded.id, {
              $set: { lastLogoutAt: now },
              $pull: { refreshTokens: { $regex: safePattern } }
            });
          } else {
            // Legacy token without sessionId:
            if (tokenType === 'refresh') {
              // Only refresh tokens are stored in user.refreshTokens.
              // Revoke bare tokenHash AND deterministically derived legacy session family.
              const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
              const legacySessionId = getLegacySessionId(tokenHash);
              const safeLegacyPattern = '^(' + escapeRegex(tokenHash) + '$|' + escapeRegex(legacySessionId) + ':)';
              await User.findByIdAndUpdate(decoded.id, {
                $set: { lastLogoutAt: now },
                $pull: { refreshTokens: { $regex: safeLegacyPattern } }
              });
            } else if (tokenType === 'access') {
              // Legacy access token without sessionId:
              // Cannot be cryptographically tied to a specific refresh token.
              // Revoke via user.lastLogoutAt timestamp without pulling unrelated refresh tokens.
              await User.findByIdAndUpdate(decoded.id, {
                $set: { lastLogoutAt: now }
              });
            }
          }
        }
      } catch (err) {
        // ignore jwt verify error on logout
      }
    }
  } catch (err) {
    // ignore
  }

  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/',
    expires: new Date(Date.now())
  };

  res
    .status(200)
    .cookie('token', 'none', options)
    .cookie('refreshToken', 'none', options)
    .json({
      success: true,
      message: 'Logged out successfully'
    });
};

/**
 * @route   GET /api/auth/me
 * @desc    Get current user
 * @access  Private
 */
export const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
export const refreshToken = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Refresh token not found' });
    }

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const oldTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessionId = (decoded.sessionId && isValidSessionId(decoded.sessionId)) ? decoded.sessionId : null;

    // Retain existing sessionId; for legacy tokens without sessionId, derive a deterministic legacy family ID
    const newSessionId = sessionId || getLegacySessionId(oldTokenHash);
    const newAccessToken = generateToken(decoded.id, newSessionId);
    const newRefreshToken = generateRefreshToken(decoded.id, newSessionId);
    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const newSessionEntry = buildSessionEntry(newSessionId, newTokenHash);

    // Atomically find user matching this token/session entry and replace it
    const queryConditions = sessionId
      ? { _id: decoded.id, refreshTokens: buildSessionEntry(sessionId, oldTokenHash) }
      : { _id: decoded.id, refreshTokens: oldTokenHash };

    const user = await User.findOneAndUpdate(
      queryConditions,
      {
        $set: { 'refreshTokens.$': newSessionEntry }
      },
      {
        new: true,
        select: '-password'
      }
    );

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid or revoked refresh token' });
    }

    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/'
    };

    const tokenOptions = {
      ...options,
      expires: new Date(Date.now() + 15 * 60 * 1000) // 15 mins
    };

    const refreshOptions = {
      ...options,
      expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    };

    return res
      .status(200)
      .cookie('token', newAccessToken, tokenOptions)
      .cookie('refreshToken', newRefreshToken, refreshOptions)
      .json({
        success: true,
        message: 'Token refreshed',
        data: {
          user: {
            id: user._id,
            name: user.name,
            email: user.email
          }
        }
      });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
  }
};

/**
 * @route   POST /api/auth/forgotpassword
 * @desc    Forgot password
 * @access  Public
 */
export const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'Please provide email' });
    }

    const user = await User.findOne({ email });

    if (!user) {
      // Do not leak existence
      return res.status(200).json({
        success: true,
        message: 'If an account exists for this email, a password reset link has been sent.'
      });
    }

    // Get reset token
    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });

    try {
      const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/resetpassword/${resetToken}`;
      const message = `You requested a password reset. Please click the link to reset your password:\n\n${resetUrl}`;

      await emailService.sendEmail({
        to: user.email,
        subject: 'Paperless - Password Reset',
        text: message,
        html: `<p>You requested a password reset. Please click the link to reset your password:</p><a href="${resetUrl}">${resetUrl}</a>`
      });

      res.status(200).json({
        success: true,
        message: 'If an account exists for this email, a password reset link has been sent.'
      });
    } catch (err) {
      console.error('Email could not be sent', err);
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save({ validateBeforeSave: false });

      return res.status(500).json({
        success: false,
        message: 'Email could not be sent'
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @route   PUT /api/auth/resetpassword/:resettoken
 * @desc    Reset password
 * @access  Public
 */
export const resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Please provide a valid password (min 6 chars)' });
    }

    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(req.params.resettoken)
      .digest('hex');

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    await sendTokenResponse(user, 200, res, 'Password reset successful');
  } catch (error) {
    next(error);
  }
};
