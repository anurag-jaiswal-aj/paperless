import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupRequestTempFiles } from './fileCleanup.js';

describe('cleanupRequestTempFiles', () => {
  const createdFiles = [];

  const createTempFile = (prefix = 'test-cleanup') => {
    const filePath = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`);
    fs.writeFileSync(filePath, 'dummy data');
    createdFiles.push(filePath);
    return filePath;
  };

  afterEach(() => {
    for (const file of createdFiles) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch {
        // Ignore test cleanup errors
      }
    }
    createdFiles.length = 0;
  });

  it('handles null or undefined request safely', () => {
    expect(() => cleanupRequestTempFiles(null)).not.toThrow();
    expect(() => cleanupRequestTempFiles(undefined)).not.toThrow();
    expect(() => cleanupRequestTempFiles({})).not.toThrow();
  });

  it('unlinks files in req._trackedTempFiles and clears the set', () => {
    const file1 = createTempFile('test-tracked-1');
    const file2 = createTempFile('test-tracked-2');

    const req = {
      _trackedTempFiles: new Set([file1, file2])
    };

    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(true);

    cleanupRequestTempFiles(req);

    expect(fs.existsSync(file1)).toBe(false);
    expect(fs.existsSync(file2)).toBe(false);
    expect(req._trackedTempFiles.size).toBe(0);
  });

  it('unlinks files in req.files (array)', () => {
    const file1 = createTempFile('test-files');

    const req = {
      files: [{ path: file1 }]
    };

    expect(fs.existsSync(file1)).toBe(true);
    cleanupRequestTempFiles(req);
    expect(fs.existsSync(file1)).toBe(false);
  });

  it('unlinks files in req.file (single object)', () => {
    const file1 = createTempFile('test-single');

    const req = {
      file: { path: file1 }
    };

    expect(fs.existsSync(file1)).toBe(true);
    cleanupRequestTempFiles(req);
    expect(fs.existsSync(file1)).toBe(false);
  });

  it('handles already deleted or non-existent files without throwing', () => {
    const nonExistent = path.join(os.tmpdir(), `test-missing-${Date.now()}.tmp`);
    const req = {
      _trackedTempFiles: new Set([nonExistent]),
      files: [{ path: nonExistent }]
    };

    expect(() => cleanupRequestTempFiles(req)).not.toThrow();
  });

  it('handles overlapping files across _trackedTempFiles and req.files idempotently', () => {
    const file1 = createTempFile('test-overlap');
    const req = {
      _trackedTempFiles: new Set([file1]),
      files: [{ path: file1 }],
      file: { path: file1 }
    };

    expect(fs.existsSync(file1)).toBe(true);
    cleanupRequestTempFiles(req);
    expect(fs.existsSync(file1)).toBe(false);
  });

  it('catches and suppresses filesystem errors when unlinking fails', () => {
    const file1 = createTempFile('test-error');
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted');
    });

    const req = {
      files: [{ path: file1 }]
    };

    expect(() => cleanupRequestTempFiles(req)).not.toThrow();
    unlinkSpy.mockRestore();
  });
});

