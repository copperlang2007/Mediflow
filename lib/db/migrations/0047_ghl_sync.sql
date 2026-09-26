-- GoHighLevel contact feed: external id links + per-org pull cursor/lease.
CREATE TABLE IF NOT EXISTS external_contact_links (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  source text NOT NULL,
  external_id text NOT NULL,
  -- SET NULL, not CASCADE: a hard-deleted contact leaves a tombstone link so
  -- the feed never recreates it.
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  external_updated_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT external_contact_links_org_source_external_key UNIQUE (org_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS external_contact_links_contact_idx ON external_contact_links (contact_id);

CREATE TABLE IF NOT EXISTS ghl_sync_state (
  org_id text PRIMARY KEY REFERENCES organizations(id),
  location_id text NOT NULL,
  cursor_updated_at timestamp with time zone,
  cursor_search_after jsonb,
  running_since timestamp with time zone,
  lease_token text,
  last_run_at timestamp with time zone,
  last_status text,
  last_error text,
  last_run_created integer NOT NULL DEFAULT 0,
  last_run_updated integer NOT NULL DEFAULT 0,
  last_run_skipped integer NOT NULL DEFAULT 0,
  backfill_completed_at timestamp with time zone
);
