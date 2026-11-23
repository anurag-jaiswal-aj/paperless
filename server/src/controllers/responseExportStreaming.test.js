import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { EventEmitter } from 'events';
import Form from '../models/form.js';
import Question from '../models/question.js';
import Response from '../models/response.js';
import { exportResponses } from './responseController.js';
import { logger } from '../utils/logger.js';

describe('PERF-01: JSON & CSV Export Streaming Regression Suite', () => {
  class MockResponse extends EventEmitter {
    constructor() {
      super();
      this.headers = {};
      this.headersSent = false;
      this.writableEnded = false;
      this.destroyed = false;
      this.destroyError = null;
      this.chunks = [];
      this.statusCode = 200;
      this.writeReturns = true;
      this.writeFn = null;
      this.jsonData = null;
    }

    get writable() {
      return !this.destroyed && !this.writableEnded;
    }

    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      this.headersSent = true;
      return this;
    }

    getHeader(name) {
      return this.headers[name.toLowerCase()];
    }

    write(chunk) {
      if (this.destroyed || this.writableEnded) {
        return false;
      }
      this.chunks.push(chunk);
      if (typeof this.writeFn === 'function') {
        return this.writeFn(chunk);
      }
      return this.writeReturns;
    }

    end(chunk) {
      if (chunk) {
        this.write(chunk);
      }
      this.writableEnded = true;
      this.emit('finish');
      return this;
    }

    destroy(err) {
      this.destroyed = true;
      if (err) {
        this.destroyError = err;
      }
      this.emit('close');
      return this;
    }

    status(code) {
      this.statusCode = code;
      return this;
    }

    json(data) {
      this.jsonData = data;
      this.end();
      return this;
    }
  }

  function createMockCursor(items = [], options = {}) {
    const cursor = {
      items: [...items],
      destroyed: false,
      destroyCalled: false,
      destroyCalls: 0,
      destroy: vi.fn(() => {
        cursor.destroyed = true;
        cursor.destroyCalled = true;
        cursor.destroyCalls++;
        if (options.throwOnDestroy) {
          throw new Error(options.throwOnDestroy);
        }
        if (options.rejectOnDestroy) {
          return Promise.reject(new Error(options.rejectOnDestroy));
        }
        return Promise.resolve();
      }),
      on: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < cursor.items.length; i++) {
          if (cursor.destroyed) {
            break;
          }
          if (typeof options.onBeforeYield === 'function') {
            await options.onBeforeYield(cursor.items[i], i);
          }
          if (cursor.destroyed) {
            break;
          }
          if (options.errorOnIndex === i) {
            throw new Error(`Cursor read error at index ${i}`);
          }
          yield cursor.items[i];
        }
      }
    };
    return cursor;
  }

  const setupMockCursorFind = (mockCursor) => {
    const query = {
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      cursor: vi.fn().mockReturnValue(mockCursor)
    };
    vi.spyOn(Response, 'find').mockReturnValue(query);
    return query;
  };

  let formId;
  let ownerId;
  let q1Id;
  let q2Id;
  let mockForm;
  let mockQuestions;
  let mockResponsesData;
  let req;
  let next;

  beforeEach(() => {
    formId = new mongoose.Types.ObjectId();
    ownerId = new mongoose.Types.ObjectId();
    q1Id = new mongoose.Types.ObjectId();
    q2Id = new mongoose.Types.ObjectId();

    mockForm = {
      _id: formId,
      ownerId: ownerId,
      status: 'published',
      title: 'Streaming Test Form',
      description: 'Form Description for Export'
    };

    mockQuestions = [
      { _id: q1Id, label: 'Full Name', type: 'short_text', order: 1 },
      { _id: q2Id, label: 'Email', type: 'email', order: 2 }
    ];

    mockResponsesData = [
      {
        _id: new mongoose.Types.ObjectId(),
        formId,
        createdAt: new Date('2026-01-01T10:00:00.000Z'),
        answers: [
          { questionId: q1Id, value: 'Alice' },
          { questionId: q2Id, value: 'alice@example.com' }
        ]
      },
      {
        _id: new mongoose.Types.ObjectId(),
        formId,
        createdAt: new Date('2026-01-02T10:00:00.000Z'),
        answers: [
          { questionId: q1Id, value: 'Bob' },
          { questionId: q2Id, value: 'bob@example.com' }
        ]
      },
      {
        _id: new mongoose.Types.ObjectId(),
        formId,
        createdAt: new Date('2026-01-03T10:00:00.000Z'),
        answers: [
          { questionId: q1Id, value: 'Charlie' },
          { questionId: q2Id, value: 'charlie@example.com' }
        ]
      }
    ];

    req = {
      params: { formId: formId.toString() },
      user: { id: ownerId.toString() },
      query: { format: 'json' }
    };

    next = vi.fn();

    vi.spyOn(Form, 'findById').mockResolvedValue(mockForm);
    vi.spyOn(Question, 'find').mockReturnValue({
      sort: vi.fn().mockResolvedValue(mockQuestions)
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Empty export produces valid []
  it('Requirement 1: Empty export produces valid empty responses array in JSON envelope', async () => {
    const mockCursor = createMockCursor([]);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    expect(res.getHeader('content-type')).toContain('application/json');
    expect(res.writableEnded).toBe(true);
    expect(mockCursor.destroyCalled).toBe(true);

    const fullPayload = JSON.parse(res.chunks.join(''));
    expect(fullPayload.success).toBe(true);
    expect(fullPayload.data.form.id).toBe(formId.toString());
    expect(fullPayload.data.form.title).toBe('Streaming Test Form');
    expect(fullPayload.data.questions).toHaveLength(2);
    expect(fullPayload.data.responses).toEqual([]);
  });

  // 2. Single-document export produces valid JSON
  it('Requirement 2: Single-document export produces valid JSON envelope', async () => {
    const mockCursor = createMockCursor([mockResponsesData[0]]);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    expect(res.writableEnded).toBe(true);
    expect(mockCursor.destroyCalled).toBe(true);

    const fullPayload = JSON.parse(res.chunks.join(''));
    expect(fullPayload.success).toBe(true);
    expect(fullPayload.data.responses).toHaveLength(1);
    expect(fullPayload.data.responses[0].id).toBe(mockResponsesData[0]._id.toString());
    expect(new Date(fullPayload.data.responses[0].submittedAt).toISOString()).toBe(
      mockResponsesData[0].createdAt.toISOString()
    );
    expect(fullPayload.data.responses[0].answers).toHaveLength(2);
  });

  // 3. Multi-document export produces valid JSON
  it('Requirement 3: Multi-document export produces valid JSON with correct delimiters', async () => {
    const mockCursor = createMockCursor(mockResponsesData);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    expect(res.writableEnded).toBe(true);
    expect(mockCursor.destroyCalled).toBe(true);

    const fullPayload = JSON.parse(res.chunks.join(''));
    expect(fullPayload.success).toBe(true);
    expect(fullPayload.data.responses).toHaveLength(3);
    expect(fullPayload.data.responses[0].id).toBe(mockResponsesData[0]._id.toString());
    expect(fullPayload.data.responses[1].id).toBe(mockResponsesData[1]._id.toString());
    expect(fullPayload.data.responses[2].id).toBe(mockResponsesData[2]._id.toString());
  });

  // 4. Serialized values preserve existing API semantics
  it('Requirement 4: Serialized values preserve existing API semantics (rich types, form, questions)', async () => {
    const richAnswers = [
      { questionId: q1Id, value: { key: 's3/upload.pdf', originalName: 'report.pdf' } },
      { questionId: q2Id, value: ['tag1', 'tag2', 'tag3'] }
    ];
    const complexResponse = {
      _id: new mongoose.Types.ObjectId(),
      formId,
      createdAt: new Date('2026-05-15T12:00:00.000Z'),
      answers: richAnswers
    };

    const mockCursor = createMockCursor([complexResponse]);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    const parsed = JSON.parse(res.chunks.join(''));
    expect(parsed.data.form).toEqual({
      id: formId.toString(),
      title: 'Streaming Test Form',
      description: 'Form Description for Export'
    });
    expect(parsed.data.questions).toEqual([
      { id: q1Id.toString(), label: 'Full Name', type: 'short_text' },
      { id: q2Id.toString(), label: 'Email', type: 'email' }
    ]);
    expect(parsed.data.responses[0].answers[0].value).toEqual({
      key: 's3/upload.pdf',
      originalName: 'report.pdf'
    });
    expect(parsed.data.responses[0].answers[1].value).toEqual(['tag1', 'tag2', 'tag3']);
  });

  // 5. Large export streams without materializing all documents
  it('Requirement 5: Streams large exports incrementally without accumulating all documents in memory', async () => {
    const largeDataset = Array.from({ length: 50 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      formId,
      createdAt: new Date(Date.now() + i * 1000),
      answers: [{ questionId: q1Id, value: `Respondent ${i}` }]
    }));

    let yieldsCount = 0;
    const mockCursor = createMockCursor(largeDataset, {
      onBeforeYield: async (item, index) => {
        yieldsCount++;
        // Verify incremental streaming: chunks are already written to res as items are yielded
        if (index === 25) {
          expect(res.chunks.length).toBeGreaterThan(0);
        }
      }
    });

    const queryMock = setupMockCursorFind(mockCursor);
    const res = new MockResponse();

    await exportResponses(req, res, next);

    expect(queryMock.cursor).toHaveBeenCalledWith(expect.objectContaining({ batchSize: 500 }));
    expect(yieldsCount).toBe(50);
    expect(res.writableEnded).toBe(true);

    const parsed = JSON.parse(res.chunks.join(''));
    expect(parsed.data.responses).toHaveLength(50);
  });

  // 6. Backpressure prevents uncontrolled cursor consumption
  it('Requirement 6: Backpressure pauses cursor iteration and resumes on drain', async () => {
    const mockCursor = createMockCursor(mockResponsesData);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    let writeCount = 0;
    let simulateBackpressure = true;

    res.writeFn = () => {
      writeCount++;
      // Write 1: Prefix -> ok; Write 2: Record 1 -> triggers backpressure
      if (writeCount === 2 && simulateBackpressure) {
        return false;
      }
      return true;
    };

    let settled = false;
    const exportPromise = exportResponses(req, res, next).then(() => {
      settled = true;
    });

    await new Promise((r) => setImmediate(r));

    // Paused waiting for backpressure
    expect(settled).toBe(false);
    expect(writeCount).toBe(2);
    expect(res.listenerCount('drain')).toBe(1);

    // Relieve backpressure
    simulateBackpressure = false;
    res.emit('drain');

    await exportPromise;
    expect(settled).toBe(true);

    // All chunks written: Prefix + 3 records + Suffix
    expect(res.writableEnded).toBe(true);
    expect(mockCursor.destroyCalled).toBe(true);
    expect(res.listenerCount('drain')).toBe(0);

    const parsed = JSON.parse(res.chunks.join(''));
    expect(parsed.data.responses).toHaveLength(3);
  });

  // 7. Client disconnect aborts cursor iteration
  it('Requirement 7a: Disconnect during cursor iteration halts loop and destroys cursor', async () => {
    let yieldedCount = 0;
    const mockCursor = createMockCursor(mockResponsesData, {
      onBeforeYield: async (item, index) => {
        yieldedCount++;
        if (index === 1) {
          res.emit('close');
        }
      }
    });
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    expect(yieldedCount).toBe(2); // Record 3 never yielded
    expect(mockCursor.destroyCalled).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it('Requirement 7b: Disconnect during drain wait halts export and cleans up cursor', async () => {
    const mockCursor = createMockCursor(mockResponsesData);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    let writeCount = 0;
    res.writeFn = () => {
      writeCount++;
      if (writeCount === 2) return false;
      return true;
    };

    let settled = false;
    const exportPromise = exportResponses(req, res, next).then(() => {
      settled = true;
    });

    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(writeCount).toBe(2);

    res.emit('close');

    await exportPromise;
    expect(settled).toBe(true);
    expect(mockCursor.destroyCalled).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  // 8. Cursor is closed after successful completion
  it('Requirement 8: Cursor is closed after successful completion', async () => {
    const mockCursor = createMockCursor(mockResponsesData);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    expect(mockCursor.destroyCalled).toBe(true);
    expect(mockCursor.destroyed).toBe(true);
    expect(res.writableEnded).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  // 9. Cursor is closed after database errors
  it('Requirement 9: Cursor is closed after database errors', async () => {
    const mockCursor = createMockCursor(mockResponsesData, { errorOnIndex: 1 });
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    expect(mockCursor.destroyCalled).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(res.destroyError).toBeDefined();
    expect(res.writableEnded).toBe(false);
  });

  // 10. Cursor is closed after serialization errors
  it('Requirement 10: Cursor is closed after serialization errors', async () => {
    const circularDoc = {
      _id: new mongoose.Types.ObjectId(),
      formId,
      createdAt: new Date(),
      answers: []
    };
    circularDoc.answers.push(circularDoc); // Causes TypeError: Converting circular structure to JSON

    const mockCursor = createMockCursor([circularDoc]);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    expect(mockCursor.destroyCalled).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(res.destroyError).toBeInstanceOf(TypeError);
    expect(res.writableEnded).toBe(false);
  });

  // 11. Normal response closure is not mistaken for premature disconnect
  it('Requirement 11: Normal response closure is not mistaken for premature disconnect', async () => {
    const mockCursor = createMockCursor(mockResponsesData);
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    const loggerInfoSpy = vi.spyOn(logger, 'info');

    await exportResponses(req, res, next);

    expect(res.writableEnded).toBe(true);

    // Simulate Node stream post-finish close event
    res.emit('close');

    const abortLog = loggerInfoSpy.mock.calls.find(
      (call) => call[0] === 'export.json_streaming_aborted_by_client'
    );
    expect(abortLog).toBeUndefined();
  });

  // 12. Partial output is never reported as successful
  it('Requirement 12: Partial output is never reported as successful', async () => {
    const mockCursor = createMockCursor(mockResponsesData, { errorOnIndex: 1 });
    setupMockCursorFind(mockCursor);

    const res = new MockResponse();
    await exportResponses(req, res, next);

    expect(res.writableEnded).toBe(false);
    const partialRaw = res.chunks.join('');
    expect(partialRaw.endsWith(']}}')).toBe(false);
    expect(() => JSON.parse(partialRaw)).toThrow(SyntaxError);
  });

  // 13. Existing authorization and ownership behavior remains intact
  describe('Requirement 13: Authorization, ownership and form lifecycle guards', () => {
    it('returns 404 when form does not exist', async () => {
      vi.spyOn(Form, 'findById').mockResolvedValue(null);
      const res = new MockResponse();

      await exportResponses(req, res, next);

      expect(res.statusCode).toBe(404);
      expect(res.jsonData).toEqual({ success: false, message: 'Form not found' });
    });

    it('returns 403 when user is not form owner', async () => {
      mockForm.ownerId = new mongoose.Types.ObjectId();
      const res = new MockResponse();

      await exportResponses(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(res.jsonData).toEqual({
        success: false,
        message: 'Not authorized to export responses'
      });
    });

    it('returns 409 when form status is deleting or delete_failed', async () => {
      mockForm.status = 'deleting';
      const res = new MockResponse();

      await exportResponses(req, res, next);

      expect(res.statusCode).toBe(409);
      expect(res.jsonData.message).toBe('Form is currently being deleted');
    });

    it('applies startDate and endDate date filters to Response query', async () => {
      req.query.startDate = '2026-01-01T00:00:00.000Z';
      req.query.endDate = '2026-01-02T00:00:00.000Z';

      const mockCursor = createMockCursor([]);
      setupMockCursorFind(mockCursor);
      const res = new MockResponse();

      await exportResponses(req, res, next);

      expect(Response.find).toHaveBeenCalledWith(
        expect.objectContaining({
          formId: formId.toString(),
          createdAt: {
            $gte: new Date('2026-01-01T00:00:00.000Z'),
            $lte: new Date('2026-01-02T00:00:00.000Z')
          }
        })
      );
    });
  });

  // 14. Existing CSV export behavior remains unchanged
  describe('Requirement 14: Existing CSV export behavior remains unchanged', () => {
    it('returns CSV headers and formatted rows when format=csv', async () => {
      req.query.format = 'csv';
      const mockCursor = createMockCursor(mockResponsesData);
      setupMockCursorFind(mockCursor);

      const res = new MockResponse();
      await exportResponses(req, res, next);

      expect(res.getHeader('content-type')).toContain('text/csv');
      expect(res.getHeader('content-disposition')).toContain(`responses-${formId.toString()}.csv`);
      expect(res.getHeader('x-content-type-options')).toBe('nosniff');

      const fullCsv = res.chunks.join('');
      expect(fullCsv).toContain('"Timestamp","Full Name","Email"');
      expect(fullCsv).toContain('"Alice"');
      expect(fullCsv).toContain('"Bob"');
      expect(fullCsv).toContain('"Charlie"');
      expect(res.writableEnded).toBe(true);
      expect(mockCursor.destroyCalled).toBe(true);
    });
  });
});
