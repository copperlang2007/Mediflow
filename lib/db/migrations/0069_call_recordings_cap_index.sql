-- The daily recording cap counts an agency's recordings by when they were
-- committed (falling back to created_at). Without this index that count reads
-- the agency's whole recording history.
--
-- NOTE ON CONCURRENCY: as in 0051 and 0061, the production runner
-- (lib/db/src/migrate-locked.ts, CONCURRENT_PREBUILDS) builds this index
-- CONCURRENTLY before migrations run, so the statement below is a no-op on a
-- live database and never blocks writes to call_recordings. Keep the
-- definition in sync with CONCURRENT_PREBUILDS.
CREATE INDEX IF NOT EXISTS "call_recordings_org_committed_idx" ON "call_recordings" ("org_id", (coalesce("committed_at", "created_at")));
