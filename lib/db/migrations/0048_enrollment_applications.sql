-- Full enrollment applications from EnrollHere/Sunfire, stored encrypted and
-- versioned. One application per (org, source, application_key) where the key
-- is the Sunfire confirmation code (or the EnrollHere policy id when absent).
-- The payload is AES-GCM encrypted: it holds health answers and possibly
-- race/ethnicity, which are never promoted to plain columns and never feed
-- routing, scoring or AI. Only the audited "Full application" view decrypts it.
CREATE TABLE IF NOT EXISTS enrollment_applications (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id),
  source text NOT NULL,
  application_key text NOT NULL,
  confirmation_code text,
  external_policy_id text,
  -- Cascade: purging a contact purges their applications (PHI) with them.
  contact_id text REFERENCES contacts(id) ON DELETE CASCADE,
  enrollment_id text REFERENCES enrollments(id) ON DELETE SET NULL,
  current_version integer NOT NULL DEFAULT 1,
  last_event_type text,
  carrier_name text,
  plan_id text,
  plan_name text,
  plan_type text,
  snp_type text,
  policy_status text,
  effective_date date,
  signature_date date,
  submitted_at timestamp with time zone,
  agent_email text,
  agent_npn text,
  medicare_id_encrypted bytea,
  medicare_id_hash bytea,
  medicaid_number_encrypted bytea,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_applications_org_source_key UNIQUE (org_id, source, application_key)
);
CREATE INDEX IF NOT EXISTS enrollment_applications_org_contact_idx ON enrollment_applications (org_id, contact_id);

CREATE TABLE IF NOT EXISTS enrollment_application_versions (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES enrollment_applications(id) ON DELETE CASCADE,
  version integer NOT NULL,
  event_type text,
  payload_encrypted bytea NOT NULL,
  payload_hmac bytea NOT NULL,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_application_versions_app_version_key UNIQUE (application_id, version),
  CONSTRAINT enrollment_application_versions_app_hmac_key UNIQUE (application_id, payload_hmac)
);
