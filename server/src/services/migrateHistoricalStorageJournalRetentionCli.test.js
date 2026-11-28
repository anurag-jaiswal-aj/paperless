import { describe, it, expect } from 'vitest';
import {
  parseCliArgs,
  CliArgumentError
} from '../../../scripts/migrateHistoricalStorageJournalRetention.js';

describe('migrateHistoricalStorageJournalRetention CLI strict parser (F-05)', () => {
  it('accepts valid default dry-run invocation', () => {
    const res = parseCliArgs([]);
    expect(res.apply).toBe(false);
    expect(res.mode).toBe('DRY_RUN');
    expect(res.targetCollection).toBe('storage_operations');
    expect(res.allowProduction).toBe(false);
  });

  it('accepts valid --dry-run invocation', () => {
    const res = parseCliArgs(['--dry-run', '--batch-size', '250']);
    expect(res.mode).toBe('DRY_RUN');
    expect(res.batchSize).toBe(250);
  });

  it('accepts valid explicitly authorized --apply argument parsing without executing migration', () => {
    const res = parseCliArgs([
      '--apply',
      '--database',
      'paperless_staging',
      '--migration-id',
      'mig-2026',
      '--target-collection',
      'storage_operations',
      '--batch-size',
      '500',
      '--allow-production'
    ]);
    expect(res.apply).toBe(true);
    expect(res.mode).toBe('APPLY');
    expect(res.databaseName).toBe('paperless_staging');
    expect(res.migrationId).toBe('mig-2026');
    expect(res.allowProduction).toBe(true);
  });

  it('rejects unknown, misspelled, and malformed flags', () => {
    for (const badArgv of [
      ['--unknown'],
      ['--dryrun'],
      ['--allow-prod'],
      ['-d'],
      ['--batch-size=100'],
      ['positional-arg']
    ]) {
      expect(() => parseCliArgs(badArgv)).toThrow(CliArgumentError);
    }
  });

  it('rejects missing, empty, or duplicate flag values', () => {
    for (const badArgv of [
      ['--database'],
      ['--database', '--apply'],
      ['--database', '   '],
      ['--migration-id', ''],
      ['--batch-size', '100', '--batch-size', '200'],
      ['--apply', '--apply']
    ]) {
      expect(() => parseCliArgs(badArgv)).toThrow(CliArgumentError);
    }
  });

  it('rejects conflicting flags, invalid batch sizes, invalid target collection, and missing apply confirmations', () => {
    for (const badArgv of [
      ['--apply', '--dry-run', '--database', 'db', '--migration-id', 'm1'],
      ['--allow-production'],
      ['--target-collection', 'users'],
      ['--batch-size', '0'],
      ['--batch-size', '1001'],
      ['--batch-size', '12.5'],
      ['--batch-size', 'abc'],
      ['--apply', '--migration-id', 'm1'],
      ['--apply', '--database', 'db1']
    ]) {
      expect(() => parseCliArgs(badArgv)).toThrow(CliArgumentError);
    }
  });
});
