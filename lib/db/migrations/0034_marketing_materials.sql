-- Marketing-material approval workflow.
--
-- CMS rules require Medicare Advantage / Part D agencies to use only marketing
-- materials that have been reviewed and, where applicable, filed/approved.
-- Each row is one piece moving through review: classified by material_type,
-- moved submitted → in_review → approved | rejected | changes_requested (and
-- approved pieces can later be retired). Approved pieces carry an effective
-- window (effective_date / expires_at) and optional CMS material id so the
-- agency can prove on audit that everything in use was approved and current.
-- No PHI — these are marketing assets, not beneficiary records.
CREATE TYPE "marketing_material_type" AS ENUM('flyer', 'social_post', 'email', 'mailer', 'tv', 'radio', 'web', 'business_card', 'presentation', 'script', 'other');--> statement-breakpoint
CREATE TYPE "marketing_material_status" AS ENUM('draft', 'submitted', 'in_review', 'approved', 'rejected', 'changes_requested', 'retired');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketing_materials" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"material_type" "marketing_material_type" DEFAULT 'other' NOT NULL,
	"status" "marketing_material_status" DEFAULT 'submitted' NOT NULL,
	"description" text,
	"file_url" text,
	"carrier_name" text,
	"cms_material_id" text,
	"effective_date" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"submitted_by_user_id" text,
	"submitted_at" timestamp with time zone,
	"reviewed_by_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketing_materials" ADD CONSTRAINT "marketing_materials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_materials" ADD CONSTRAINT "marketing_materials_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_materials" ADD CONSTRAINT "marketing_materials_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_materials_org_status_idx" ON "marketing_materials" ("org_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketing_materials_org_expires_idx" ON "marketing_materials" ("org_id","expires_at");
