import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import User from '../models/user.js';

/**
 * Auth Middleware
 * Protects routes by verifying JWT tokens from HttpOnly cookies
 */
export const protect = async (req, res, next) => {
  try {
    let token = req.cookies.token;

    // Fallback for backwards compatibility or programmatic access
    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized, no token provided'
      });
    }

    let decoded;
    try {
      // Verify token
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized, token invalid or expired'
      });
    }

    // Attach user to request
    req.user = await User.findById(decoded.id).select('-password');

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    // If token is session-bound, verify the session has not been revoked
    if (decoded.sessionId) {
      if (typeof decoded.sessionId !== 'string' || decoded.sessionId.trim() === '') {
        return res.status(401).json({
          success: false,
          message: 'Not authorized, invalid session identifier'
        });
      }
      const isSessionActive = req.user.refreshTokens?.some((entry) =>
        typeof entry === 'string' && entry.startsWith(decoded.sessionId + ':')
      );
      if (!isSessionActive) {
        return res.status(401).json({
          success: false,
          message: 'Not authorized, session has been revoked'
        });
      }
    } else {
      // Legacy access token without sessionId:
      // 1. If refreshToken cookie is present, perform exact session-specific verification
      if (req.cookies?.refreshToken) {
        const refreshHash = crypto.createHash('sha256').update(req.cookies.refreshToken).digest('hex');
        const legacyFamilyPrefix = 'legacy-' + refreshHash;
        const isSessionActive = req.user.refreshTokens?.some((entry) =>
          entry === refreshHash || (typeof entry === 'string' && entry.startsWith(legacyFamilyPrefix + ':'))
        );
        if (!isSessionActive) {
          return res.status(401).json({
            success: false,
            message: 'Not authorized, session has been revoked'
          });
        }
      } else if (req.user.lastLogoutAt && decoded.iat) {
        // 2. Standalone Bearer token without cookies: reject if issued at or before the logout second
        const tokenIssuedAtSec = decoded.iat;
        const logoutAtSec = Math.floor(req.user.lastLogoutAt.getTime() / 1000);
        if (tokenIssuedAtSec <= logoutAtSec) {
          return res.status(401).json({
            success: false,
            message: 'Not authorized, session has been revoked'
          });
        }
      }
    }

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error in authentication'
    });
  }
};

/**
 * Optional Auth Middleware
 * Adds user to request if token exists, but doesn't block
 */
export const optionalAuth = async (req, res, next) => {
  try {
    let token = req.cookies.token;

    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select('-password');
        if (decoded.sessionId) {
          const isSessionActive =
            typeof decoded.sessionId === 'string' &&
            decoded.sessionId.trim() !== '' &&
            user?.refreshTokens?.some((entry) =>
              typeof entry === 'string' && entry.startsWith(decoded.sessionId + ':')
            );
          req.user = isSessionActive ? user : null;
        } else if (user) {
          if (req.cookies?.refreshToken) {
            const refreshHash = crypto.createHash('sha256').update(req.cookies.refreshToken).digest('hex');
            const legacyFamilyPrefix = 'legacy-' + refreshHash;
            const isSessionActive = user.refreshTokens?.some((entry) =>
              entry === refreshHash || (typeof entry === 'string' && entry.startsWith(legacyFamilyPrefix + ':'))
            );
            req.user = isSessionActive ? user : null;
          } else if (user.lastLogoutAt && decoded.iat) {
            const tokenIssuedAtSec = decoded.iat;
            const logoutAtSec = Math.floor(user.lastLogoutAt.getTime() / 1000);
            req.user = tokenIssuedAtSec <= logoutAtSec ? null : user;
          } else {
            req.user = user;
          }
        } else {
          req.user = null;
        }
      } catch (error) {
        // Token invalid but continue anyway
        req.user = null;
      }
    }

    next();
  } catch (error) {
    next();
  }
};
