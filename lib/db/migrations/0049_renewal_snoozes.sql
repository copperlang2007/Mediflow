-- renewal_snoozes backfill. The table has been declared in
-- lib/db/src/schema/agents.ts (and captured in the 0039–0041 snapshots) since
-- the renewals feature landed, but no SQL migration ever created it — dev and
-- prod databases got it from `drizzle-kit push`. A database built only from
-- `migrate` (e.g. the render.yaml demo DB) therefore failed every
-- GET /api/renewals with `relation "renewal_snoozes" does not exist`.
--
-- Mirrors the schema exactly (no extra indexes). Fully idempotent so it is a
-- no-op on databases that already have the table from `db push`.
CREATE TABLE IF NOT EXISTS "renewal_snoozes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"snoozed_until" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Guard on the FK's shape, not just its name: a pushed DB could carry an
-- equivalent org_id -> organizations(id) FK under a different name, and a
-- name-only guard would then add a duplicate.
DO $$ BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.conrelid = 'public.renewal_snoozes'::regclass
    AND c.confrelid = 'public.organizations'::regclass
    AND c.conkey = ARRAY[(
      SELECT a.attnum FROM pg_attribute a
      WHERE a.attrelid = 'public.renewal_snoozes'::regclass AND a.attname = 'org_id'
    )]::smallint[]
 ) THEN
  ALTER TABLE "renewal_snoozes" ADD CONSTRAINT "renewal_snoozes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
 END IF;
END $$;
