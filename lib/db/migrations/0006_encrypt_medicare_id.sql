-- HIPAA-2: column-level encryption for `contacts.medicare_id`.
--
-- Schema-only step. The actual ciphertext + HMAC values are computed in
-- application code (lib/db/src/encryption/medicareId.ts) because the
-- encryption + hash keys live in app env (PHI_ENCRYPTION_KEY /
-- PHI_HMAC_KEY), not in Postgres. We do NOT use pgcrypto's pgp_sym_encrypt
-- — keeping the keys out of the database is the whole point of the
-- defense-in-depth.
--
-- Deployment order (documented in the PR body):
--   1. Apply this migration (adds nullable columns + index).
--   2. Deploy app code that dual-writes plaintext + encrypted on every
--      INSERT/UPDATE.
--   3. Run `pnpm --filter @workspace/scripts run backfill:medicare-id`
--      to populate medicare_id_encrypted/_hash for every existing row.
--   4. Flip MEDICARE_ID_ENCRYPTION_ENABLED=true so reads use the hash
--      column for exact-match lookup. Drop the plaintext column in a
--      follow-up migration once verified.
--
-- We still `CREATE EXTENSION IF NOT EXISTS pgcrypto` because (a) it's
-- harmless when present and (b) other PHI-adjacent tooling (random_bytes
-- in fixtures, etc.) may rely on it. The CREATE is wrapped in a DO block
-- so the migration succeeds on environments where pgcrypto is unavailable
-- (e.g. pglite in the test harness).
--
-- Idempotent: re-running this migration is safe.

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  EXCEPTION WHEN OTHERS THEN
    -- pglite / restricted environments don't ship pgcrypto. Continue —
    -- application-side encryption does not depend on it.
    NULL;
  END;
END $$;
--> statement-breakpoint

ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "medicare_id_encrypted" bytea;
--> statement-breakpoint

ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "medicare_id_hash" bytea;
--> statement-breakpoint

-- Partial index on the deterministic HMAC for exact-match lookup
-- (commission reconcile + contact search). NULL rows are excluded since
-- most contacts don't have an MBI on file yet.
CREATE INDEX IF NOT EXISTS "contacts_medicare_id_hash_idx"
  ON "contacts" ("medicare_id_hash")
  WHERE "medicare_id_hash" IS NOT NULL;
