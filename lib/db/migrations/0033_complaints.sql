-- CTM complaint tracking — beneficiary complaint log with resolution SLA.
--
-- CMS requires Medicare Advantage / Part D agencies to log, investigate, and
-- resolve beneficiary complaints within defined turnaround windows and produce
-- that record on audit. Each row is the agency's system-of-record entry for one
-- complaint: triaged by category + severity (severity drives the dueAt SLA),
-- moved through open → investigating → resolved → closed, optionally linked to
-- the beneficiary (contact_id), the agent in question (agent_id), and an
-- external CMS CTM case number (ctm_case_id). subject/description are a short,
-- non-PHI summary — the MBI is never stored here.
CREATE TYPE "complaint_source" AS ENUM('cms_ctm', 'beneficiary_direct', 'carrier', 'internal', 'other');--> statement-breakpoint
CREATE TYPE "complaint_category" AS ENUM('marketing', 'enrollment', 'benefits', 'access', 'privacy', 'agent_conduct', 'billing', 'other');--> statement-breakpoint
CREATE TYPE "complaint_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "complaint_status" AS ENUM('open', 'investigating', 'resolved', 'closed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "complaints" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" text,
	"agent_id" text,
	"source" "complaint_source" DEFAULT 'beneficiary_direct' NOT NULL,
	"category" "complaint_category" DEFAULT 'other' NOT NULL,
	"severity" "complaint_severity" DEFAULT 'medium' NOT NULL,
	"status" "complaint_status" DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"description" text,
	"ctm_case_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_notes" text,
	"assigned_to_user_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "complaints_org_status_due_idx" ON "complaints" ("org_id","status","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "complaints_org_contact_idx" ON "complaints" ("org_id","contact_id");
