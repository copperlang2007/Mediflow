-- Indexes for contact de-duplication lookups (lib/contactImport.ts loadMatcher).
--
-- Every imported or synced contact (CSV import, EnrollHere, the GoHighLevel
-- feed) is matched against the org's existing contacts by Medicare ID hash,
-- lower(email) and lower(last_name) before it is created. None of those
-- predicates had an index, so each incoming contact cost several sequential
-- scans of the whole contacts table (up to three matcher passes per contact
-- in the GHL sync). On a 20k+ contact backfill that made the feed crawl.
-- Phone lookups already use contacts_phone_idx (0012).
--
-- NOTE ON CONCURRENCY: as in 0051, the production runner
-- (lib/db/src/migrate-locked.ts, CONCURRENT_PREBUILDS) builds these
-- CONCURRENTLY before migrations run, so the statements below are no-ops on
-- a live database. Keep the definitions in sync with CONCURRENT_PREBUILDS.
CREATE INDEX IF NOT EXISTS contacts_org_lower_email_idx
  ON contacts (org_id, lower(email)) WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_org_lower_last_name_idx
  ON contacts (org_id, lower(last_name));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS contacts_org_medicare_id_hash_idx
  ON contacts (org_id, medicare_id_hash) WHERE medicare_id_hash IS NOT NULL;
