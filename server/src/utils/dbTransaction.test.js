import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  supportsTransactions,
  withOptionalTransaction,
  withRequiredTransaction,
  assertTransactionsSupported,
  verifyReplicaSetTopology,
  ReplicaSetRequiredError,
  PartitionKeyRequiredError,
  isUnknownTransactionCommitResult,
  getTopologyType
} from './dbTransaction.js';

describe('dbTransaction utility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('supportsTransactions', () => {
    it('returns true when topology is ReplicaSetWithPrimary', () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: {
          description: {
            type: 'ReplicaSetWithPrimary'
          }
        }
      };

      expect(supportsTransactions()).toBe(true);

      mongoose.connection.client = originalClient;
    });

    it('returns true when topology is Sharded', () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: {
          description: {
            type: 'Sharded'
          }
        }
      };

      expect(supportsTransactions()).toBe(true);

      mongoose.connection.client = originalClient;
    });

    it('returns false when topology is Single (standalone)', () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: {
          description: {
            type: 'Single'
          }
        }
      };

      expect(supportsTransactions()).toBe(false);

      mongoose.connection.client = originalClient;
    });

    it('returns false when client or topology is undefined', () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = null;

      expect(supportsTransactions()).toBe(false);

      mongoose.connection.client = originalClient;
    });
  });

  describe('withOptionalTransaction', () => {
    it('executes operation with null session when transactions are unsupported', async () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: {
          description: {
            type: 'Single'
          }
        }
      };

      const operation = vi.fn().mockResolvedValue('standalone-result');
      const result = await withOptionalTransaction(operation);

      expect(result).toBe('standalone-result');
      expect(operation).toHaveBeenCalledWith(null);

      mongoose.connection.client = originalClient;
    });

    it('executes operation inside withTransaction when topology is ReplicaSetWithPrimary', async () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: {
          description: {
            type: 'ReplicaSetWithPrimary'
          }
        }
      };

      const mockSession = {
        withTransaction: vi.fn().mockImplementation(async (cb) => {
          await cb();
        }),
        endSession: vi.fn().mockResolvedValue()
      };

      vi.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession);

      const operation = vi.fn().mockResolvedValue('transaction-result');
      const result = await withOptionalTransaction(operation);

      expect(result).toBe('transaction-result');
      expect(mongoose.startSession).toHaveBeenCalledTimes(1);
      expect(mockSession.withTransaction).toHaveBeenCalledTimes(1);
      expect(mockSession.endSession).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledWith(mockSession);

      mongoose.connection.client = originalClient;
    });

    it('falls back to standalone execution if startSession throws', async () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: {
          description: {
            type: 'ReplicaSetWithPrimary'
          }
        }
      };

      vi.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('Session error'));

      const operation = vi.fn().mockResolvedValue('fallback-result');
      const result = await withOptionalTransaction(operation);

      expect(result).toBe('fallback-result');
      expect(operation).toHaveBeenCalledWith(null);

      mongoose.connection.client = originalClient;
    });

    it('propagates errors thrown within transaction and ensures session ends', async () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: {
          description: {
            type: 'ReplicaSetWithPrimary'
          }
        }
      };

      const mockSession = {
        withTransaction: vi.fn().mockImplementation(async (cb) => {
          await cb();
        }),
        endSession: vi.fn().mockResolvedValue()
      };

      vi.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession);

      const operation = vi.fn().mockRejectedValue(new Error('Transaction aborted'));

      await expect(withOptionalTransaction(operation)).rejects.toThrow('Transaction aborted');
      expect(mockSession.endSession).toHaveBeenCalledTimes(1);

      mongoose.connection.client = originalClient;
    });
  });

  describe('verifyReplicaSetTopology and assertTransactionsSupported', () => {
    it('throws ReplicaSetRequiredError when topology is Single or null', () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = { topology: { description: { type: 'Single' } } };

      expect(getTopologyType()).toBe('Single');
      expect(() => assertTransactionsSupported()).toThrow(ReplicaSetRequiredError);

      mongoose.connection.client = null;
      expect(() => assertTransactionsSupported()).toThrow(ReplicaSetRequiredError);

      mongoose.connection.client = originalClient;
    });

    it('throws ReplicaSetRequiredError when topology is ReplicaSetNoPrimary', () => {
      const mockConn = {
        client: { topology: { description: { type: 'ReplicaSetNoPrimary' } } }
      };
      expect(() => assertTransactionsSupported(mockConn)).toThrow(ReplicaSetRequiredError);
    });

    it('verifyReplicaSetTopology accepts ReplicaSetWithPrimary when hello returns setName and isWritablePrimary', async () => {
      const mockConn = {
        client: { topology: { description: { type: 'ReplicaSetWithPrimary' } } },
        db: {
          admin: () => ({
            command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true, setName: 'rs0' })
          })
        }
      };

      const res = await verifyReplicaSetTopology(mockConn);
      expect(res).toEqual({
        topologyType: 'ReplicaSetWithPrimary',
        setName: 'rs0',
        isWritablePrimary: true
      });
    });

    it('verifyReplicaSetTopology rejects standalone hello payload lacking setName', async () => {
      const mockConn = {
        client: { topology: { description: { type: 'ReplicaSetWithPrimary' } } },
        db: {
          admin: () => ({
            command: vi.fn().mockResolvedValue({ ok: 1, isWritablePrimary: true })
          })
        }
      };

      await expect(verifyReplicaSetTopology(mockConn)).rejects.toThrow(ReplicaSetRequiredError);
    });
  });

  describe('withRequiredTransaction', () => {
    it('fails closed on standalone topology and never calls operation with null session', async () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = { topology: { description: { type: 'Single' } } };

      const operation = vi.fn();
      await expect(withRequiredTransaction(operation)).rejects.toThrow(ReplicaSetRequiredError);
      expect(operation).not.toHaveBeenCalled();

      mongoose.connection.client = originalClient;
    });

    it('fails closed when startSession throws and never falls back to null session', async () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: { description: { type: 'ReplicaSetWithPrimary' } }
      };

      vi.spyOn(mongoose, 'startSession').mockRejectedValue(new Error('Session pool exhausted'));
      const operation = vi.fn();

      await expect(
        withRequiredTransaction(operation, { partitionKey: 'test-partition' })
      ).rejects.toThrow(
        /Failed to start required MongoDB transaction session/
      );
      expect(operation).not.toHaveBeenCalled();

      mongoose.connection.client = originalClient;
    });

    it('fails closed when partitionKey is missing or invalid', async () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: { description: { type: 'ReplicaSetWithPrimary' } }
      };

      const operation = vi.fn();
      await expect(withRequiredTransaction(operation)).rejects.toThrow(PartitionKeyRequiredError);
      await expect(withRequiredTransaction(operation, { partitionKey: '' })).rejects.toThrow(
        PartitionKeyRequiredError
      );
      await expect(withRequiredTransaction(operation, { partitionKey: '   ' })).rejects.toThrow(
        PartitionKeyRequiredError
      );
      await expect(withRequiredTransaction(operation, { partitionKey: NaN })).rejects.toThrow(
        PartitionKeyRequiredError
      );
      expect(operation).not.toHaveBeenCalled();

      mongoose.connection.client = originalClient;
    });

    it('executes operation inside snapshot/majority withTransaction and ends session cleanly', async () => {
      const originalClient = mongoose.connection.client;
      mongoose.connection.client = {
        topology: { description: { type: 'ReplicaSetWithPrimary' } }
      };

      const mockSession = {
        withTransaction: vi.fn().mockImplementation(async (cb, opts) => {
          expect(opts).toEqual(
            expect.objectContaining({
              readConcern: { level: 'snapshot' },
              writeConcern: { w: 'majority' },
              readPreference: 'primary'
            })
          );
          await cb();
        }),
        endSession: vi.fn().mockResolvedValue()
      };

      vi.spyOn(mongoose, 'startSession').mockResolvedValue(mockSession);
      const operation = vi.fn().mockResolvedValue('strict-tx-result');

      const result = await withRequiredTransaction(operation, { partitionKey: 'valid-partition' });
      expect(result).toBe('strict-tx-result');
      expect(operation).toHaveBeenCalledWith(mockSession);
      expect(mockSession.endSession).toHaveBeenCalledTimes(1);

      mongoose.connection.client = originalClient;
    });

    it('isUnknownTransactionCommitResult correctly identifies ambiguous commit outcomes', () => {
      expect(isUnknownTransactionCommitResult(null)).toBe(false);
      expect(isUnknownTransactionCommitResult(new Error('Validation failed'))).toBe(false);

      const errWithLabel = new Error('Unknown error');
      errWithLabel.hasErrorLabel = (label) => label === 'UnknownTransactionCommitResult';
      expect(isUnknownTransactionCommitResult(errWithLabel)).toBe(true);

      const netTimeoutErr = new Error('Socket timed out');
      netTimeoutErr.name = 'MongoNetworkTimeoutError';
      expect(isUnknownTransactionCommitResult(netTimeoutErr)).toBe(true);

      const writeConcernErr = new Error('Write concern timeout');
      writeConcernErr.code = 64;
      expect(isUnknownTransactionCommitResult(writeConcernErr)).toBe(true);

      const socketResetErr = new Error('read ECONNRESET');
      socketResetErr.code = 'ECONNRESET';
      expect(isUnknownTransactionCommitResult(socketResetErr)).toBe(true);
    });
  });
});
