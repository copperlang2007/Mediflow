CREATE TYPE "public"."enrollment_status" AS ENUM('pending', 'active', 'terminated', 'cancelled', 'declined');--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"carrier_id" text,
	"agent_id" text,
	"plan_id" text,
	"plan_name" text,
	"plan_type" "plan_type" NOT NULL,
	"plan_year" integer NOT NULL,
	"policy_number" text,
	"application_date" date,
	"effective_date" date NOT NULL,
	"effectuated" boolean DEFAULT false NOT NULL,
	"disenrolled_date" date,
	"status" "enrollment_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_contact_year_type_carrier_key" UNIQUE NULLS NOT DISTINCT("contact_id","plan_year","plan_type","carrier_id")
);
--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "enrollments_org_contact_idx" ON "enrollments" USING btree ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX "enrollments_org_plan_year_idx" ON "enrollments" USING btree ("org_id","plan_year");--> statement-breakpoint
CREATE INDEX "enrollments_org_effective_idx" ON "enrollments" USING btree ("org_id","effective_date");--> statement-breakpoint
CREATE INDEX "enrollments_org_carrier_plan_idx" ON "enrollments" USING btree ("org_id","carrier_id","plan_type","plan_year");--> statement-breakpoint

-- Backfill: one enrollment per contact that already carries coverage.
--
-- `contacts.current_plan_type` / `current_carrier_id` / `plan_year` are the
-- flattened fields this table replaces. Every contact with a plan type and a
-- plan year becomes a single enrollment representing their current coverage.
--
-- Deliberate choices:
--   * Only rows with BOTH a plan type and a plan year are migrated. A contact
--     with a plan type but no year cannot be placed on a timeline, and
--     inventing a year would corrupt the reconciliation this table exists to
--     support.
--   * `effective_date` is set to 1 January of the plan year. The true date was
--     never stored, so this is a stated approximation, not a discovered fact —
--     it is the only date consistent with the plan year we do have.
--   * Status is derived from the CONTACT's own status, not assumed. Only
--     `enrolled` / `retained` contacts get `active` coverage; a contact the
--     agency has marked `lost` or `do_not_contact`, or one still a `lead` /
--     `prospect`, gets `terminated` instead. Writing `active` for all of them
--     would put written-off beneficiaries into the missed-payment cron's scope
--     on its first run after deploy and generate alerts for commission nobody
--     is owed. `effectuated` follows the same rule.
--   * `application_date` stays NULL rather than guessing.
--
-- The source columns are NOT dropped here. Readers move to this table now; the
-- old fields remain for one release so a rollback loses nothing.
INSERT INTO "enrollments" (
  "id", "org_id", "contact_id", "carrier_id", "agent_id",
  "plan_type", "plan_year", "effective_date", "effectuated", "status", "notes"
)
SELECT
  'enr_backfill_' || c."id",
  c."org_id",
  c."id",
  c."current_carrier_id",
  c."assigned_agent_id",
  c."current_plan_type",
  c."plan_year",
  make_date(c."plan_year", 1, 1),
  (c."status" IN ('enrolled', 'retained')),
  (CASE WHEN c."status" IN ('enrolled', 'retained') THEN 'active' ELSE 'terminated' END)::enrollment_status,
  'Backfilled from contacts.current_plan_type / current_carrier_id / plan_year. Effective date approximated as 1 Jan of the plan year; the true date was never recorded. Status derived from the contact status at backfill time.'
FROM "contacts" c
WHERE c."current_plan_type" IS NOT NULL
  AND c."plan_year" IS NOT NULL
ON CONFLICT DO NOTHING;
