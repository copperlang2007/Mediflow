-- The daily recording cap counts an agency's recordings by when they were
-- committed (falling back to created_at). Without this index that count reads
-- the agency's whole recording history.
CREATE INDEX IF NOT EXISTS "call_recordings_org_committed_idx" ON "call_recordings" ("org_id", (coalesce("committed_at", "created_at")));
