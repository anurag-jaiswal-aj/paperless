import express from 'express';
import {
  validateBackupToken,
  quiescenceRateLimiter,
  acquireLeaseHandler,
  heartbeatLeaseHandler,
  releaseLeaseHandler,
  getStatusHandler,
  drainInFlightHandler,
  markQuiescedHandler
} from '../controllers/quiescenceController.js';

const router = express.Router();

// Apply administrative rate limiting (protects unauthenticated guessing, permits legitimate heartbeats)
router.use(quiescenceRateLimiter);

// Apply administrative token authentication to all quiescence routes
router.use(validateBackupToken);

// Support both relative routing (when mounted at /api/admin/quiescence)
// and absolute routing (when mounted at / or /api/admin)
router.post(['/acquire', '/api/admin/quiescence/acquire'], acquireLeaseHandler);
router.post(['/heartbeat', '/api/admin/quiescence/heartbeat'], heartbeatLeaseHandler);
router.post(['/drain', '/api/admin/quiescence/drain'], drainInFlightHandler);
router.post(['/release', '/api/admin/quiescence/release'], releaseLeaseHandler);
router.get(['/status', '/api/admin/quiescence/status'], getStatusHandler);
router.post(
  ['/quiesce', '/quiesced', '/api/admin/quiescence/quiesce', '/api/admin/quiescence/quiesced'],
  markQuiescedHandler
);

export default router;
