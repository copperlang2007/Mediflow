-- Every value an integration sends, kept in Mediflow (the system of record).
--
-- EnrollHere call events used to keep only the contact and a call-log line;
-- the rest of each delivery was dropped and integration_events kept only the
-- field NAMES for 90 days. This table keeps the whole delivery, encrypted with
-- the same PHI key as contact data, for at least the CMS 10-year record
-- retention. One row per (org, source, external id): a redelivery adds
-- nothing. A hard-deleted contact takes its payloads with it.
CREATE TABLE IF NOT EXISTS "integration_payloads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"event_type" text,
	"contact_id" text REFERENCES "contacts"("id") ON DELETE CASCADE,
	"activity_id" text REFERENCES "activities"("id") ON DELETE SET NULL,
	"payload_encrypted" bytea NOT NULL,
	"payload_hmac" bytea NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "integration_payloads_org_source_external_key" UNIQUE ("org_id", "source", "external_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_payloads_contact_idx" ON "integration_payloads" ("contact_id");
