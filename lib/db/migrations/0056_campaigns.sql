-- Omnichannel marketing campaigns (email + SMS).
--
-- campaigns: one broadcast (channel, content, audience filter, lifecycle
-- draft -> scheduled -> sending -> sent | cancelled) plus a counts cache.
-- campaign_recipients: the per-contact fan-out ledger. UNIQUE
-- (campaign_id, contact_id) makes audience materialization idempotent;
-- claimed_at marks a recipient a worker has taken so a retried job never
-- sends the same message twice. Opted-out contacts are recorded as
-- skipped_opt_out. No provider payload bodies are stored.
DO $$ BEGIN
  CREATE TYPE "campaign_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "campaign_recipient_status" AS ENUM('queued', 'sent', 'delivered', 'bounced', 'failed', 'skipped_opt_out');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"channel" "channel" NOT NULL,
	"name" text NOT NULL,
	"email_template_id" text REFERENCES "email_templates"("id") ON DELETE set null,
	"sms_template_id" text REFERENCES "sms_templates"("id") ON DELETE set null,
	"subject" text,
	"body" text,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by" text REFERENCES "users"("id") ON DELETE set null,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"opened_count" integer DEFAULT 0 NOT NULL,
	"clicked_count" integer DEFAULT 0 NOT NULL,
	"bounced_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"unsubscribed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_org_channel_created_idx" ON "campaigns" ("org_id","channel","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_org_status_idx" ON "campaigns" ("org_id","status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"campaign_id" text NOT NULL REFERENCES "campaigns"("id") ON DELETE cascade,
	"contact_id" text NOT NULL REFERENCES "contacts"("id") ON DELETE cascade,
	"channel" "channel" NOT NULL,
	"to_address" text,
	"status" "campaign_recipient_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"message_id" text REFERENCES "messages"("id") ON DELETE set null,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_recipients_campaign_contact_key" ON "campaign_recipients" ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_recipients_campaign_status_idx" ON "campaign_recipients" ("campaign_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_recipients_org_contact_idx" ON "campaign_recipients" ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_recipients_provider_msg_idx" ON "campaign_recipients" ("provider_message_id") WHERE "provider_message_id" IS NOT NULL;
