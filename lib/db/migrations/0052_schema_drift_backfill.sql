-- Backfill schema objects that exist in the drizzle schema
-- (lib/db/src/schema/agents.ts) but were never given a SQL migration, so a
-- database built only from these migrations failed at request time:
--
--   * cert_renewal_alerts                     -> cert-expiry-check worker dedup table
--   * platform_requirements.required_for_role -> tech-stack requirement routes
--
-- (renewal_snoozes is created by 0049_renewal_snoozes.)
--
-- Idempotent for databases built with `drizzle-kit push`: tables use IF NOT
-- EXISTS, and the foreign key is added in its own statement guarded on its
-- shape (not its name), because CREATE TABLE IF NOT EXISTS skips the whole
-- body of an existing table and a pushed database may carry an equivalent
-- FK under a different name.
CREATE TABLE IF NOT EXISTS "cert_renewal_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"cert_id" text NOT NULL,
	"alert_days_before" integer NOT NULL,
	"sent_at" timestamp with time zone,
	"notification_id" text
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.conrelid = 'public.cert_renewal_alerts'::regclass
    AND c.confrelid = 'public.carrier_certifications'::regclass
    AND c.conkey = ARRAY[(
      SELECT a.attnum FROM pg_attribute a
      WHERE a.attrelid = 'public.cert_renewal_alerts'::regclass AND a.attname = 'cert_id'
    )]::smallint[]
 ) THEN
  ALTER TABLE "cert_renewal_alerts" ADD CONSTRAINT "cert_renewal_alerts_cert_id_carrier_certifications_id_fk"
    FOREIGN KEY ("cert_id") REFERENCES "public"."carrier_certifications"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
-- A pushed database without the unique index may hold duplicate alert rows
-- for one (cert, threshold); keep one so the index can be built.
DELETE FROM "cert_renewal_alerts" a USING "cert_renewal_alerts" b
WHERE a.ctid < b.ctid
  AND a.cert_id = b.cert_id
  AND a.alert_days_before = b.alert_days_before;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cert_renewal_alerts_cert_threshold_unique" ON "cert_renewal_alerts" USING btree ("cert_id","alert_days_before");
--> statement-breakpoint
ALTER TABLE "platform_requirements" ADD COLUMN IF NOT EXISTS "required_for_role" text;
