-- HIPAA-2 FINAL CUTOVER: drop the plaintext `contacts.medicare_id` column.
--
-- ⚠️  DO NOT APPLY THIS MIGRATION UNTIL THE PRODUCTION CUTOVER IS CONFIRMED.
--
-- `medicare_id` is a Medicare Beneficiary Identifier (MBI) — direct PHI.
-- Migration 0006 added the encrypted columns (`medicare_id_encrypted`,
-- `medicare_id_hash`) and the app has been dual-writing plaintext +
-- encrypted ever since. This migration removes the plaintext column so
-- the MBI is ONLY ever stored as AES-256-GCM ciphertext, completing the
-- column-level-encryption defense-in-depth (no plaintext PHI in pg_dump,
-- backups, or via DBA snooping).
--
-- Required production sequence (see PR body runbook — DO NOT skip):
--   1. MEDICARE_ID_ENCRYPTION_ENABLED=true confirmed in prod for a
--      sustained period.
--   2. `pnpm backfill:medicare-id` confirmed run — every row that has a
--      plaintext `medicare_id` also has a non-null `medicare_id_encrypted`.
--   3. Reads confirmed working off the encrypted columns.
--   4. ONLY THEN apply this migration.
--
-- Once this migration is applied the plaintext PHI is GONE. Rollback is
-- no longer a column flip — it requires a database restore from backup.
--
-- Safety guard: the DO block below fails LOUDLY if any row still has a
-- plaintext `medicare_id` without a corresponding `medicare_id_encrypted`
-- (i.e. the backfill has not been completed). This is the last line of
-- defense against an accidental data-loss merge before backfill.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "contacts"
    WHERE "medicare_id" IS NOT NULL
      AND "medicare_id_encrypted" IS NULL
  ) THEN
    RAISE EXCEPTION
      'ABORT: % contact row(s) still have a plaintext medicare_id with no medicare_id_encrypted. Run `pnpm backfill:medicare-id` and verify it reports 0 remaining rows BEFORE applying this migration. Dropping the column now would permanently lose PHI.',
      (SELECT count(*) FROM "contacts"
        WHERE "medicare_id" IS NOT NULL AND "medicare_id_encrypted" IS NULL);
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "contacts" DROP COLUMN IF EXISTS "medicare_id";
