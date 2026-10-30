import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

// Load environment variables
dotenv.config();

// Require minimum environment variables in production
if (process.env.NODE_ENV === 'production') {
  const requiredEnvs = ['MONGO_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'FRONTEND_URL', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  for (const env of requiredEnvs) {
    if (!process.env[env]) {
      console.error(`FATAL ERROR: Missing required production environment variable: ${env}`);
      process.exit(1);
    }
  }
}

// Import routes
import authRoutes from './routes/authRoutes.js';
import formRoutes from './routes/formRoutes.js';
import responseRoutes from './routes/responseRoutes.js';
import aiRoutes from './routes/aiRoutes.js';

// Import middleware
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { csrfProtection } from './middleware/csrfProtection.js';

// Initialize Express app
const app = express();

// Database connection
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

// Middleware
app.use(helmet()); // Security headers
app.use(morgan('dev')); // HTTP request logging
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);
app.use(express.json({ limit: '100kb' })); // Explicit JSON limit
app.use(express.urlencoded({ extended: true, limit: '100kb' })); // Explicit URL-encoded limit
app.use(cookieParser()); // Parse cookies
app.use(csrfProtection); // Validate origin on mutating requests

// Health check routes
// Liveness probe
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'live',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Database readiness probe
const readinessHandler = (req, res) => {
  const isDbReady = mongoose.connection.readyState === 1;
  const statusCode = isDbReady ? 200 : 503;
  res.status(statusCode).json({
    success: isDbReady,
    status: isDbReady ? 'ready' : 'not_ready',
    database: isDbReady ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
};

app.get('/health/ready', readinessHandler);
app.get('/ready', readinessHandler);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/responses', responseRoutes);
app.use('/api/ai', aiRoutes);

// Root route
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Welcome to Paperless API',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      forms: '/api/forms',
      responses: '/api/responses',
      ai: '/api/ai'
    }
  });
});

// 404 handler
app.use(notFound);

// Error handler (must be last)
app.use(errorHandler);

/**
 * Creates a bounded, duplicate-safe graceful shutdown handler.
 * Drains active HTTP connections, safely closes the database connection,
 * and exits cleanly within the bounded timeout period.
 */
export const createGracefulShutdown = (
  serverInstance,
  mongooseInstance,
  exitFn = process.exit,
  timeoutMs = 10000
) => {
  let isShuttingDown = false;
  return async (signal, customExitCode) => {
    if (isShuttingDown) {
      console.log(`⚠️ Shutdown already in progress. Ignoring duplicate ${signal}.`);
      return;
    }
    isShuttingDown = true;
    console.log(`🛑 Received ${signal}. Starting graceful shutdown...`);

    let isTimedOut = false;

    const forceExitTimeout = setTimeout(() => {
      isTimedOut = true;
      console.error(`❌ Graceful shutdown timed out after ${timeoutMs}ms. Forcing exit.`);
      exitFn(1);
    }, timeoutMs);

    try {
      if (serverInstance && typeof serverInstance.close === 'function') {
        await new Promise((resolve, reject) => {
          serverInstance.close((err) => {
            if (err) return reject(err);
            resolve();
          });
        });
        console.log('✅ HTTP server closed. In-flight requests drained.');
      }

      if (mongooseInstance && mongooseInstance.connection && mongooseInstance.connection.readyState !== 0) {
        await mongooseInstance.connection.close(false);
        console.log('✅ MongoDB connection closed safely.');
      }

      clearTimeout(forceExitTimeout);
      if (isTimedOut) {
        return;
      }

      const isFailureSignal = signal === 'unhandledRejection' || signal === 'uncaughtException';
      const defaultExitCode = isFailureSignal ? 1 : 0;
      const targetExitCode = typeof customExitCode === 'number' ? customExitCode : defaultExitCode;
      console.log(`👋 Graceful shutdown complete with exit code ${targetExitCode}. Exiting process.`);
      exitFn(targetExitCode);
    } catch (error) {
      clearTimeout(forceExitTimeout);
      if (isTimedOut) {
        return;
      }
      console.error('❌ Error during graceful shutdown:', error.message);
      exitFn(1);
    }
  };
};

// Start server when run directly (skip auto-listen during automated testing)
let server;

if (process.env.NODE_ENV !== 'test') {
  connectDB();

  const PORT = process.env.PORT || 5001;
  server = app.listen(PORT, () => {
    console.log(`🚀 Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
    console.log(`📍 API: http://localhost:${PORT}`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`🏥 Ready: http://localhost:${PORT}/health/ready`);
  });

  const handleShutdown = createGracefulShutdown(server, mongoose, process.exit);
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : '';
    console.error('❌ Unhandled Promise Rejection:', message);
    if (stack) console.error(stack);
    handleShutdown('unhandledRejection', 1);
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err.message);
    if (err.stack) console.error(err.stack);
    handleShutdown('uncaughtException', 1);
  });
}

export { app, connectDB, server };
