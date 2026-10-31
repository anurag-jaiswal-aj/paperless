import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateDocxZip } from './docxValidator.js';

const crc32 = (buf) => {
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    table[i] = c;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ (-1)) >>> 0;
};

const createZipBuffer = (files) => {
  const localHeaders = [];
  const cdHeaders = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.from(file.data || '', 'utf8');
    const crc = crc32(dataBuf);

    // Local Header
    const lh = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBuf.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);
    dataBuf.copy(lh, 30 + nameBuf.length);
    localHeaders.push(lh);

    // Central Directory Header
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    cdHeaders.push(cd);

    offset += lh.length;
  }

  const cdBuf = Buffer.concat(cdHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
};

describe('validateDocxZip', () => {
  it('rejects non-existent file', () => {
    const res = validateDocxZip('/tmp/non_existent_file_test.docx');
    expect(res.valid).toBe(false);
  });

  it('rejects files smaller than 22 bytes', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-small.docx`);
    fs.writeFileSync(tmp, Buffer.from('too short'));
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('too small');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects files without ZIP EOCD signature', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-notzip.docx`);
    fs.writeFileSync(tmp, Buffer.alloc(100, 0x41));
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('End of Central Directory');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects ZIP archives missing [Content_Types].xml', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-nocontenttypes.docx`);
    const zipBuf = createZipBuffer([
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'notes.txt', data: 'hello world' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('[Content_Types].xml');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects ZIP archives missing word/document.xml', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-noworddoc.docx`);
    const zipBuf = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'random.xml', data: '<root/>' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('word/document.xml');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects archives containing prohibited executable or script extensions', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-badext.docx`);
    const zipBuf = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'payload.exe', data: 'MZ...' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Archive contains prohibited file type');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects archives containing files under word/ directory when word/document.xml itself is missing', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-wordnotes.docx`);
    const zipBuf = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/notes.txt', data: 'not the main document' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('word/document.xml');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects archives with path traversal entries', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-traversal.docx`);
    const zipBuf = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: '../../etc/passwd', data: 'root:x:0:0' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Path traversal');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects archives with duplicate entries', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-duplicate.docx`);
    const zipBuf = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'word/document.xml', data: '<w:document duplicate/>' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Duplicate archive entry');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects archives attempting EOCD signature spoofing in comment', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-spoofed-comment.docx`);
    const validZip = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document/>' }
    ]);
    const eocdPos = validZip.length - 22;
    const truncatedZip = validZip.subarray(0, eocdPos);
    const fakeEocdWithComment = Buffer.alloc(22 + 26);
    fakeEocdWithComment.writeUInt32LE(0x06054b50, 0); // EOCD signature
    fakeEocdWithComment.writeUInt16LE(2, 8); // total entries
    fakeEocdWithComment.writeUInt16LE(2, 10);
    fakeEocdWithComment.writeUInt16LE(26, 20); // comment length = 26
    fakeEocdWithComment.writeUInt32LE(0x06054b50, 22 + 2); // Embedded fake EOCD signature inside comment
    const corruptedZip = Buffer.concat([truncatedZip, fakeEocdWithComment, Buffer.from('extra_trailing_bytes')]);
    fs.writeFileSync(tmp, corruptedZip);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('malformed comment');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects archives containing ZIP64 locator signature', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-zip64.docx`);
    const validZip = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document/>' }
    ]);
    // Inject ZIP64 locator signature 0x07064b50
    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50, 0);
    const zip64Zip = Buffer.concat([validZip.subarray(0, validZip.length - 22), zip64Locator, validZip.subarray(validZip.length - 22)]);
    fs.writeFileSync(tmp, zip64Zip);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('ZIP64 format is not permitted');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects archives containing script extensions (.py, .vbe, .wsf)', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-script.docx`);
    const zipBuf = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'word/macro.py', data: 'print("evil")' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Archive contains prohibited file type');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('rejects archives containing NTFS Alternate Data Streams or colon in entry name', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-ntfs.docx`);
    const zipBuf = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'word/document.xml:hidden_stream', data: 'malicious payload' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Path traversal or invalid characters');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  it('accepts genuine OpenXML DOCX archive structure', () => {
    const tmp = path.join(os.tmpdir(), `test-${Date.now()}-valid.docx`);
    const zipBuf = createZipBuffer([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document><w:body><w:p/></w:body></w:document>' },
      { name: 'word/styles.xml', data: '<w:styles/>' }
    ]);
    fs.writeFileSync(tmp, zipBuf);
    try {
      const res = validateDocxZip(tmp);
      expect(res.valid).toBe(true);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });
});

