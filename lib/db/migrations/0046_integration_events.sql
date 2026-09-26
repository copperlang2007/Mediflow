-- Inbound integration events (EnrollHere webhooks). Idempotency ledger: the
-- unique (org_id, source, external_id) key turns a redelivery into a no-op.
-- Payloads are not stored (PHI); only the field names seen.
CREATE TABLE IF NOT EXISTS integration_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  source text NOT NULL,
  external_id text NOT NULL,
  event_type text,
  contact_id text REFERENCES contacts(id) ON DELETE SET NULL,
  activity_id text REFERENCES activities(id) ON DELETE SET NULL,
  payload_keys text[],
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT integration_events_org_source_external_key UNIQUE (org_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS integration_events_org_received_idx ON integration_events (org_id, received_at);
