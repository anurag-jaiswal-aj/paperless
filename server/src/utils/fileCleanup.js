import fs from 'fs';

/**
 * Clean up temporary files associated with an HTTP request.
 * Handles both files tracked during upload stream (req._trackedTempFiles)
 * and completed upload files attached to req.files or req.file.
 *
 * @param {import('express').Request} req - The Express request object.
 */
export const cleanupRequestTempFiles = (req) => {
  if (!req) return;

  // 1. Clean up explicitly tracked files (e.g. created during disk storage)
  if (req._trackedTempFiles && typeof req._trackedTempFiles[Symbol.iterator] === 'function') {
    for (const filePath of req._trackedTempFiles) {
      if (typeof filePath === 'string') {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // Ignore error during cleanup
        }
      }
    }
    if (typeof req._trackedTempFiles.clear === 'function') {
      req._trackedTempFiles.clear();
    }
  }

  // 2. Clean up files attached to req.files or req.file
  const filesToClean = Array.isArray(req.files)
    ? req.files
    : req.files && typeof req.files === 'object'
      ? Object.values(req.files).flat()
      : req.file
        ? [req.file]
        : [];

  for (const f of filesToClean) {
    if (f && typeof f.path === 'string') {
      try {
        if (fs.existsSync(f.path)) {
          fs.unlinkSync(f.path);
        }
      } catch {
        // Ignore error during cleanup
      }
    }
  }
};

