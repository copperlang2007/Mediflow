-- Campaign sender identity + provider-event idempotency ledger.
--
-- campaign_settings: per-org agency name and physical postal address that
-- CAN-SPAM requires in every commercial email, a reply-to address, and the
-- fallback IANA time zone for TCPA SMS quiet hours.
-- campaign_events: one row per provider callback (Resend svix-id, Twilio
-- MessageSid:status). The unique key turns a redelivery into a no-op.
-- Payloads are not stored.
CREATE TABLE IF NOT EXISTS "campaign_settings" (
	"org_id" text PRIMARY KEY NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"sender_name" text,
	"physical_address" text,
	"reply_to_email" text,
	"default_time_zone" text DEFAULT 'America/New_York' NOT NULL,
	"updated_by" text REFERENCES "users"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"event_type" text NOT NULL,
	"recipient_id" text REFERENCES "campaign_recipients"("id") ON DELETE set null,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_events_provider_external_key" ON "campaign_events" ("provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_events_received_idx" ON "campaign_events" ("received_at");
