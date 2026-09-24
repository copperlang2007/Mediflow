-- Bring legacy import_jobs (0000) in line with the CSV import routes.
-- Keep the legacy columns/data for existing imports.
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS user_id text;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS import_type text NOT NULL DEFAULT 'csv_contacts';
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS created_count integer NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS updated_count integer NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS error_count integer NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS column_mapping jsonb;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS options jsonb;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS file_name text;
-- Legacy source is required but new import code identifies sources by import_type.
-- Retain the old value for historical jobs while allowing new rows without it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'import_jobs' AND column_name = 'source')
  THEN
    ALTER TABLE import_jobs ALTER COLUMN source DROP NOT NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS import_jobs_org_id_created_at_idx ON import_jobs (org_id, created_at);
CREATE INDEX IF NOT EXISTS import_jobs_org_id_status_idx ON import_jobs (org_id, status);
