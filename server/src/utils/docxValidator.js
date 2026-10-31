import fs from 'fs';

/**
 * List of prohibited executable and script extensions within archives.
 */
const PROHIBITED_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.sh', '.vbs', '.vbe', '.wsf', '.wsh',
  '.js', '.jse', '.bin', '.msi', '.com', '.scr', '.pif', '.hta', '.cpl',
  '.jar', '.ps1', '.psm1', '.inf', '.reg', '.lnk', '.py', '.php'
]);

const MAX_CD_SIZE = 4 * 1024 * 1024; // 4MB ceiling for Central Directory table of contents
const MAX_UNCOMPRESSED_ENTRY_SIZE = 50 * 1024 * 1024; // 50MB per-entry uncompressed limit

/**
 * Validates whether a file is a genuine Microsoft Word OpenXML (.docx) document
 * by inspecting its ZIP Central Directory table of contents without third-party dependencies.
 *
 * Requirements for a valid .docx:
 * 1. Must be a valid standard 32-bit ZIP archive containing an End of Central Directory (EOCD) record (signature 0x06054b50).
 * 2. EOCD record must terminate cleanly at the end of the file (rejecting comment-spoofed signatures).
 * 3. Must NOT contain ZIP64 extensions or structures.
 * 4. Must NOT exceed safe entry count (max 1000) or Central Directory size (max 4MB).
 * 5. Must contain '[Content_Types].xml' (case-insensitive).
 * 6. Must contain 'word/document.xml' (case-insensitive exact match).
 * 7. Must NOT contain prohibited executable or script file extensions.
 * 8. Must NOT contain directory traversal sequences (..) or null bytes.
 * 9. Must NOT contain duplicate entry names.
 *
 * @param {string} filePath - Absolute path to the file on disk.
 * @returns {{ valid: boolean, reason?: string }} Validation result.
 */
export const validateDocxZip = (filePath) => {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stats = fs.fstatSync(fd);
    const fileSize = stats.size;

    // Minimum valid ZIP file size is 22 bytes (an empty EOCD record)
    if (fileSize < 22) {
      return { valid: false, reason: 'File too small to be a valid ZIP archive' };
    }

    // Search for End of Central Directory (EOCD) signature: 0x06054b50
    // EOCD record is 22 bytes plus optional variable-length comment (up to 65,535 bytes)
    const searchSize = Math.min(fileSize, 65535 + 22);
    const searchBuf = Buffer.alloc(searchSize);
    fs.readSync(fd, searchBuf, 0, searchSize, fileSize - searchSize);

    // Check for ZIP64 EOCD Locator signature (0x07064b50) or ZIP64 EOCD record (0x06064b50)
    for (let i = 0; i <= searchSize - 4; i++) {
      const sig = searchBuf.readUInt32LE(i);
      if (sig === 0x07064b50 || sig === 0x06064b50) {
        return { valid: false, reason: 'ZIP64 format is not permitted for DOCX documents' };
      }
    }

    let eocdOffsetInSearchBuf = -1;
    for (let i = searchSize - 22; i >= 0; i--) {
      if (searchBuf.readUInt32LE(i) === 0x06054b50) {
        const commentLen = searchBuf.readUInt16LE(i + 20);
        // Verify comment length invariant: candidate EOCD plus comment must terminate exactly at searchSize (file end)
        if (i + 22 + commentLen === searchSize) {
          eocdOffsetInSearchBuf = i;
          break;
        }
      }
    }

    if (eocdOffsetInSearchBuf === -1) {
      return { valid: false, reason: 'ZIP End of Central Directory record not found or malformed comment' };
    }

    const totalEntries = searchBuf.readUInt16LE(eocdOffsetInSearchBuf + 10);
    const cdSize = searchBuf.readUInt32LE(eocdOffsetInSearchBuf + 12);
    const cdOffset = searchBuf.readUInt32LE(eocdOffsetInSearchBuf + 16);

    // Reject ZIP64 overflow field markers
    if (totalEntries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      return { valid: false, reason: 'ZIP64 archives are not permitted for DOCX documents' };
    }

    // Safety checks against malformed or zip bomb entries
    if (totalEntries === 0) {
      return { valid: false, reason: 'ZIP archive contains zero entries' };
    }
    if (totalEntries > 1000) {
      return { valid: false, reason: 'ZIP archive exceeds maximum entry limit' };
    }
    if (cdSize > MAX_CD_SIZE) {
      return { valid: false, reason: 'Central directory exceeds allowable size limit' };
    }
    if (cdOffset + cdSize > fileSize) {
      return { valid: false, reason: 'Invalid ZIP Central Directory offset or size' };
    }

    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

    let pos = 0;
    let hasContentTypes = false;
    let hasWordDocument = false;
    const seenFilenames = new Set();

    for (let i = 0; i < totalEntries && pos < cdSize; i++) {
      if (pos + 46 > cdSize) {
        return { valid: false, reason: 'Truncated Central Directory header' };
      }

      // Central Directory File Header signature is 0x02014b50
      if (cdBuf.readUInt32LE(pos) !== 0x02014b50) {
        return { valid: false, reason: 'Malformed Central Directory file header signature' };
      }

      const uncompressedSize = cdBuf.readUInt32LE(pos + 24);
      const fnLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const recordLen = 46 + fnLen + extraLen + commentLen;

      if (pos + recordLen > cdSize) {
        return { valid: false, reason: 'Truncated Central Directory record entry' };
      }

      if (uncompressedSize > MAX_UNCOMPRESSED_ENTRY_SIZE) {
        return { valid: false, reason: 'Archive entry exceeds maximum allowable uncompressed size' };
      }

      const rawFilename = cdBuf.toString('utf8', pos + 46, pos + 46 + fnLen);

      // Reject null bytes, path traversal sequences, NTFS streams, or absolute paths
      if (rawFilename.includes('\0') || rawFilename.includes('..') || rawFilename.includes(':') || rawFilename.startsWith('/') || rawFilename.startsWith('\\')) {
        return { valid: false, reason: `Path traversal or invalid characters in archive entry: ${rawFilename}` };
      }

      const normalizedFilename = rawFilename.replace(/\\/g, '/').toLowerCase();

      // Reject duplicate entries to prevent parser confusion
      if (seenFilenames.has(normalizedFilename)) {
        return { valid: false, reason: `Duplicate archive entry: ${rawFilename}` };
      }
      seenFilenames.add(normalizedFilename);

      if (normalizedFilename === '[content_types].xml') {
        hasContentTypes = true;
      }

      if (normalizedFilename === 'word/document.xml') {
        hasWordDocument = true;
      }

      // Strip trailing NTFS stream markers, spaces, or dots before checking extension
      const cleanFilename = normalizedFilename.replace(/[:$].*$/, '').replace(/[. ]+$/, '');
      for (const badExt of PROHIBITED_EXTENSIONS) {
        if (cleanFilename.endsWith(badExt)) {
          return { valid: false, reason: `Archive contains prohibited file type: ${rawFilename}` };
        }
      }

      pos += recordLen;
    }

    if (!hasContentTypes) {
      return { valid: false, reason: 'Missing required [Content_Types].xml entry' };
    }

    if (!hasWordDocument) {
      return { valid: false, reason: 'Missing required Word document stream (word/document.xml)' };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, reason: err.message };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore file close errors
      }
    }
  }
};
