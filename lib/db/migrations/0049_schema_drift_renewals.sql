-- Backfill schema objects that exist in the drizzle schema
-- (lib/db/src/schema/agents.ts) but were never given a SQL migration.
-- Production only runs these migrations, so each of these failed at request
-- time with "relation/column does not exist":
--
--   * renewal_snoozes            -> GET /api/renewals 500 (Renewals,
--                                   Licensing and Certifications pages)
--   * cert_renewal_alerts        -> cert-expiry-check worker dedup table
--   * platform_requirements.required_for_role -> tech-stack requirement routes
--
-- Idempotent (IF NOT EXISTS) because some environments were built with
-- `drizzle-kit push` and may already have these objects.
CREATE TABLE IF NOT EXISTS "renewal_snoozes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL CONSTRAINT "renewal_snoozes_org_id_organizations_id_fk" REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"snoozed_until" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cert_renewal_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"cert_id" text NOT NULL CONSTRAINT "cert_renewal_alerts_cert_id_carrier_certifications_id_fk" REFERENCES "public"."carrier_certifications"("id") ON DELETE cascade ON UPDATE no action,
	"alert_days_before" integer NOT NULL,
	"sent_at" timestamp with time zone,
	"notification_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cert_renewal_alerts_cert_threshold_unique" ON "cert_renewal_alerts" USING btree ("cert_id","alert_days_before");
--> statement-breakpoint
ALTER TABLE "platform_requirements" ADD COLUMN IF NOT EXISTS "required_for_role" text;
