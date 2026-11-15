import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import User from './user.js';
import Form from './form.js';
import Question from './question.js';
import Response from './response.js';
import { connectDB } from '../server.js';

describe('Stage 4.3.1: Database Foundation, Connection Lifecycle & Critical Query Indexing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('User Schema Indexing', () => {
    it('defines a compound sparse index on resetPasswordToken and resetPasswordExpire', () => {
      const indexes = User.schema.indexes();
      const resetIndex = indexes.find((idx) => {
        const fields = idx[0];
        return fields.resetPasswordToken === 1 && fields.resetPasswordExpire === 1;
      });

      expect(resetIndex).toBeDefined();
      expect(resetIndex[1]).toEqual(expect.objectContaining({ sparse: true }));
    });
  });

  describe('Redundant Index Elimination', () => {
    it('Form schema does not define a redundant single-field index on ownerId', () => {
      // Check field-level index definition
      const ownerIdPath = Form.schema.path('ownerId');
      expect(ownerIdPath._index).toBeFalsy();

      // Verify the compound index exists with ownerId prefix
      const indexes = Form.schema.indexes();
      const hasCompound = indexes.some(
        ([fields]) => fields.ownerId === 1 && fields.createdAt === -1
      );
      expect(hasCompound).toBe(true);

      // Verify no duplicate standalone index on ownerId: 1
      const standaloneCount = indexes.filter(
        ([fields]) => Object.keys(fields).length === 1 && fields.ownerId === 1
      ).length;
      expect(standaloneCount).toBe(0);
    });

    it('Question schema does not define a redundant single-field index on formId', () => {
      // Check field-level index definition
      const formIdPath = Question.schema.path('formId');
      expect(formIdPath._index).toBeFalsy();

      // Verify the compound index exists with formId prefix
      const indexes = Question.schema.indexes();
      const hasCompound = indexes.some(([fields]) => fields.formId === 1 && fields.order === 1);
      expect(hasCompound).toBe(true);

      // Verify no duplicate standalone index on formId: 1
      const standaloneCount = indexes.filter(
        ([fields]) => Object.keys(fields).length === 1 && fields.formId === 1
      ).length;
      expect(standaloneCount).toBe(0);
    });

    it('Response schema does not define a redundant single-field index on formId', () => {
      // Check field-level index definition
      const formIdPath = Response.schema.path('formId');
      expect(formIdPath._index).toBeFalsy();

      // Verify the compound index exists with formId prefix
      const indexes = Response.schema.indexes();
      const hasCompound = indexes.some(
        ([fields]) => fields.formId === 1 && fields.createdAt === -1
      );
      expect(hasCompound).toBe(true);

      // Verify no duplicate standalone index on formId: 1
      const standaloneCount = indexes.filter(
        ([fields]) => Object.keys(fields).length === 1 && fields.formId === 1
      ).length;
      expect(standaloneCount).toBe(0);
    });
  });

  describe('Response Answer Subdocument Schema Optimization', () => {
    it('disables automatic _id generation on answer subdocuments', () => {
      const answersPath = Response.schema.path('answers');
      expect(answersPath.schema.options._id).toBe(false);

      // Instantiate a test Response document
      const sampleResponse = new Response({
        formId: new mongoose.Types.ObjectId(),
        answers: [
          {
            questionId: new mongoose.Types.ObjectId(),
            value: 'Sample text answer'
          }
        ]
      });

      const responseObj = sampleResponse.toObject();
      expect(responseObj.answers).toHaveLength(1);
      expect(responseObj.answers[0].value).toBe('Sample text answer');
      expect(responseObj.answers[0]._id).toBeUndefined();
    });
  });

  describe('MongoDB Connection Configuration (connectDB)', () => {
    it('applies production-grade connection defaults when called without explicit options', async () => {
      const origEnv = { ...process.env };
      delete process.env.MONGODB_MAX_POOL_SIZE;
      delete process.env.MONGODB_MIN_POOL_SIZE;
      delete process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS;
      delete process.env.MONGODB_SOCKET_TIMEOUT_MS;
      delete process.env.MONGODB_CONNECT_TIMEOUT_MS;

      const connectSpy = vi.spyOn(mongoose, 'connect').mockResolvedValueOnce({
        connection: {
          host: 'mongodb.internal:27017',
          client: { topology: { description: { type: 'ReplicaSetWithPrimary' } } },
          db: {
            admin: () => ({
              command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true, setName: 'rs0' })
            })
          }
        }
      });

      const uri = 'mongodb://mongodb.internal:27017/paperless';
      await connectDB(uri, false);

      expect(connectSpy).toHaveBeenCalledWith(
        uri,
        expect.objectContaining({
          maxPoolSize: 100,
          minPoolSize: 0,
          serverSelectionTimeoutMS: 5000,
          connectTimeoutMS: 10000
        })
      );

      // Verify socketTimeoutMS is omitted by default to protect long-running exports/analytics
      const passedOptions = connectSpy.mock.calls[0][1];
      expect(passedOptions.socketTimeoutMS).toBeUndefined();

      process.env = origEnv;
    });

    it('allows overriding default connection options via options argument and environment variables', async () => {
      const origEnv = { ...process.env };
      process.env.MONGODB_MAX_POOL_SIZE = '50';
      process.env.MONGODB_MIN_POOL_SIZE = '10';
      process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS = '3000';
      process.env.MONGODB_SOCKET_TIMEOUT_MS = '30000';
      process.env.MONGODB_CONNECT_TIMEOUT_MS = '8000';

      const connectSpy = vi.spyOn(mongoose, 'connect').mockResolvedValueOnce({
        connection: {
          host: 'mongodb.custom:27017',
          client: { topology: { description: { type: 'ReplicaSetWithPrimary' } } },
          db: {
            admin: () => ({
              command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true, setName: 'rs0' })
            })
          }
        }
      });

      const uri = 'mongodb://mongodb.custom:27017/paperless';
      await connectDB(uri, false, { maxPoolSize: 75, extraOption: true });

      expect(connectSpy).toHaveBeenCalledWith(
        uri,
        expect.objectContaining({
          maxPoolSize: 75,
          minPoolSize: 10,
          serverSelectionTimeoutMS: 3000,
          socketTimeoutMS: 30000,
          connectTimeoutMS: 8000,
          extraOption: true
        })
      );

      process.env = origEnv;
    });

    it('rejects standalone topology in connectDB, closes connection cleanly, and throws REPLICA_SET_REQUIRED', async () => {
      const closeSpy = vi.fn().mockResolvedValue();
      vi.spyOn(mongoose, 'connect').mockResolvedValueOnce({
        connection: {
          host: 'standalone-db:27017',
          client: { topology: { description: { type: 'Single' } } },
          close: closeSpy
        }
      });

      await expect(connectDB('mongodb://standalone-db:27017/paperless', false)).rejects.toThrow(
        /replica-set/i
      );
      expect(closeSpy).toHaveBeenCalledWith(false);
    });
  });

  describe('Atomic Password-Reset Updates (forgotPassword)', () => {
    it('uses findByIdAndUpdate with atomic $set rather than full-document user.save()', async () => {
      const { forgotPassword } = await import('../controllers/authController.js');

      const mockUser = {
        _id: new mongoose.Types.ObjectId(),
        email: 'atomic-test@example.com',
        getResetPasswordToken: vi.fn().mockReturnValue('raw-reset-token-hex-12345'),
        resetPasswordToken: 'sha256-hashed-token-value-67890',
        resetPasswordExpire: new Date(Date.now() + 600000),
        save: vi.fn().mockResolvedValue({})
      };

      vi.spyOn(User, 'findOne').mockResolvedValueOnce(mockUser);
      const findByIdAndUpdateSpy = vi
        .spyOn(User, 'findByIdAndUpdate')
        .mockResolvedValueOnce(mockUser);

      const jsonMock = vi.fn();
      const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
      const req = {
        body: { email: 'atomic-test@example.com' },
        headers: {},
        ip: '127.0.0.1'
      };
      const res = { status: statusMock };
      const next = vi.fn();

      await forgotPassword(req, res, next);

      // Verify findByIdAndUpdate was called with atomic $set
      expect(findByIdAndUpdateSpy).toHaveBeenCalledWith(
        mockUser._id,
        {
          $set: {
            resetPasswordToken: mockUser.resetPasswordToken,
            resetPasswordExpire: mockUser.resetPasswordExpire
          }
        },
        { new: true }
      );

      // Verify user.save() was NEVER called, eliminating full document overwrite risk
      expect(mockUser.save).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(200);
    });
  });
});
