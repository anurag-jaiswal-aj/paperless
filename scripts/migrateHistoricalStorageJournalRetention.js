#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const TARGET_COLLECTION = 'storage_operations';
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 1000;

export class CliArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

const VALUE_FLAGS = new Set(['--database', '--migration-id', '--target-collection', '--batch-size']);
const BOOLEAN_FLAGS = new Set(['--apply', '--dry-run', '--allow-production']);

/**
 * Strictly parses and validates CLI arguments. Fails closed before any DB connection.
 */
export function parseCliArgs(argv) {
  const seen = new Set();
  let apply = false;
  let dryRun = false;
  let allowProduction = false;
  let databaseName;
  let migrationId;
  let targetCollection = TARGET_COLLECTION;
  let batchSize;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new CliArgumentError(`Unexpected positional or malformed argument: "${token}".`);
    }
    if (token.includes('=')) {
      throw new CliArgumentError(`Unsupported "=" flag syntax: "${token}". Use "--flag value" instead.`);
    }
    if (!VALUE_FLAGS.has(token) && !BOOLEAN_FLAGS.has(token)) {
      throw new CliArgumentError(`Unknown CLI flag: "${token}".`);
    }
    if (seen.has(token)) {
      throw new CliArgumentError(`Duplicate CLI flag: "${token}".`);
    }
    seen.add(token);

    if (token === '--apply') {
      apply = true;
    } else if (token === '--dry-run') {
      dryRun = true;
    } else if (token === '--allow-production') {
      allowProduction = true;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--') || next.trim() === '') {
        throw new CliArgumentError(`Flag "${token}" requires a non-empty value.`);
      }
      i += 1;
      if (token === '--database') {
        databaseName = next.trim();
      } else if (token === '--migration-id') {
        migrationId = next.trim();
      } else if (token === '--target-collection') {
        targetCollection = next.trim();
      } else if (token === '--batch-size') {
        if (!/^\d+$/.test(next.trim())) {
          throw new CliArgumentError(`Invalid --batch-size: "${next}". Expected integer in [${MIN_BATCH_SIZE}, ${MAX_BATCH_SIZE}].`);
        }
        batchSize = Number(next.trim());
        if (!Number.isInteger(batchSize) || batchSize < MIN_BATCH_SIZE || batchSize > MAX_BATCH_SIZE) {
          throw new CliArgumentError(`--batch-size (${batchSize}) must be in [${MIN_BATCH_SIZE}, ${MAX_BATCH_SIZE}].`);
        }
      }
    }
  }

  if (apply && dryRun) {
    throw new CliArgumentError('Conflicting flags: "--apply" and "--dry-run" cannot be used together.');
  }
  if (allowProduction && !apply) {
    throw new CliArgumentError('"--allow-production" can only be used with "--apply".');
  }
  if (targetCollection !== TARGET_COLLECTION) {
    throw new CliArgumentError(`Invalid --target-collection: "${targetCollection}". Must be "${TARGET_COLLECTION}".`);
  }
  if (apply) {
    if (!databaseName) {
      throw new CliArgumentError('"--database <name>" is required when "--apply" is specified.');
    }
    if (!migrationId) {
      throw new CliArgumentError('"--migration-id <id>" is required when "--apply" is specified.');
    }
  }

  return {
    apply,
    mode: apply ? 'APPLY' : 'DRY_RUN',
    databaseName,
    migrationId,
    targetCollection,
    batchSize,
    allowProduction
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI environment variable is required.');
    process.exit(1);
  }

  const { default: mongoose } = await import('mongoose');
  const { runStorageJournalRetentionMigration } = await import(
    '../server/src/services/storageJournalRetentionMigrationService.js'
  );
  await mongoose.connect(mongoUri);
  try {
    const result = await runStorageJournalRetentionMigration(options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
