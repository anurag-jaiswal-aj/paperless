# Historical StorageJournal Retention Migration Runbook (F-04)

> **IMPORTANT:** Production execution requires separate explicit operational authorization. Do **not** run `--apply` against production without completing all preflight checks below.

---

## 1. Purpose
Historical `COMMITTED` records in `storage_operations` created prior to K.14.1.7 may carry a finite `vacuumAt` `Date` timestamp. MongoDB's `TTLMonitor` (`idx_storage_journal_ttl_vacuum`, `expireAfterSeconds: 0`) will delete those records once `vacuumAt <= now`, destroying recovery evidence required by `recoveryVerifier.js`.

This migration:
1. Preserves each affected record's original `previousVacuumAt`, `originalStatus`, `operationId`, and `journalId` in `storage_journal_migration_ledger` (which has **no TTL index**).
2. Atomically sets `vacuumAt: null` on `{ status: 'COMMITTED', vacuumAt: { $type: 'date' } }` inside `withRequiredTransaction`.
3. Verifies postconditions per batch and marks ledger entries `VERIFIED`.

---

## 2. Preflight Checklist
1. **Application & Worker Version:** Confirm all `server` and worker instances are upgraded to **K.14.1.7+** (so no old instance writes `COMMITTED` with finite `vacuumAt`).
2. **Database Topology:** Confirm MongoDB is a healthy **replica set** (`rs.status()`).
3. **Target Identity:**
   - Collection: `storage_operations`
   - TTL Index: `idx_storage_journal_ttl_vacuum` (`{ vacuumAt: 1 }`, `expireAfterSeconds: 0`)
4. **Dry-Run Inspection:** Run dry-run first to inspect `eligibleCount`, `expiredEligibleCount`, `futureEligibleCount`, and `malformedCount`.

---

## 3. Execution Commands

### Step 1: Dry-Run (Default, Zero Writes)
```bash
MONGO_URI="<target-mongo-uri>" node scripts/migrateHistoricalStorageJournalRetention.js --dry-run
```

### Step 2: Apply Mode (Requires Separate Explicit Authorization)
```bash
MONGO_URI="<target-mongo-uri>" node scripts/migrateHistoricalStorageJournalRetention.js \
  --apply \
  --database "<db-name>" \
  --migration-id "f04-retention-$(date +%Y%m%d-%H%M%S)" \
  --target-collection "storage_operations" \
  --batch-size 500
```
*(Add `--allow-production` only when explicitly authorized for a production database.)*

### Stop Conditions
- `MigrationSafeguardError` (database/collection/index mismatch)
- `MigrationLeaseError` (another migration worker holds the lease)
- Unexpected replication lag or WiredTiger cache pressure

---

## 4. Verification & Post-Migration
1. Confirm `remainingEligibleCount === 0` in the JSON output.
2. Confirm `db.storage_operations.countDocuments({ status: 'COMMITTED', vacuumAt: { $type: 'date' } }) === 0`.
3. Confirm `idx_storage_journal_ttl_vacuum` remains intact for `COMPENSATED` (24h), `ABANDONED` (24h), and `CONFIRMED` deletion (7d) records.
4. **Rollback Note:** Original `previousVacuumAt` timestamps are preserved in `storage_journal_migration_ledger`. Records already deleted by `TTLMonitor` prior to migration cannot be restored by this migration.
