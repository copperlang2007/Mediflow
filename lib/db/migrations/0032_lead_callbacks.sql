-- Callback SLA queue — capture dropped inbounds as SLA-tracked callbacks.
--
-- When an inbound route ends in 'no_agent_available' (even the eligible-offline
-- overflow fallback found nobody), the lead used to be dropped. This table
-- turns that miss into a tracked work item: one 'open' row per dropped inbound,
-- with an SLA deadline (createdAt + LEAD_QUEUE_CALLBACK_SLA_MINUTES). A
-- scheduled sweep re-checks routability and flips the row to 'resolved' (with
-- the agent it would route to) once a ready-to-sell + available agent exists,
-- or 'expired' if the SLA passes with still nobody. Auto-dialing the resolved
-- callback is deferred (needs dial-ticket issuance + calling-hours decisions).
CREATE TABLE IF NOT EXISTS "lead_callbacks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" text,
	"carrier_id" text NOT NULL,
	"state_code" text NOT NULL,
	"certification_year" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"sla_due_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_callbacks" ADD CONSTRAINT "lead_callbacks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_callbacks" ADD CONSTRAINT "lead_callbacks_resolved_agent_id_agents_id_fk" FOREIGN KEY ("resolved_agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_callbacks_org_status_sla_idx" ON "lead_callbacks" ("org_id","status","sla_due_at");
