-- Contacts CSV import: street address + city. Additive and nullable, so it is
-- safe on a live table and needs no backfill.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address1 text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city text;
-- Imported rows that carry a warning (e.g. a Medicare ID conflict), counted
-- separately from error_count (rows NOT imported).
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS warning_count integer NOT NULL DEFAULT 0;
-- Touched by the import worker as it makes progress, so cleanup can tell a
-- long-running import from one whose worker died.
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
