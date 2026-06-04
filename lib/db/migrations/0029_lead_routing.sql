-- Inbound lead queue — routing claims (audit + load-balancing + idempotency).
--
-- Records every route-inbound decision so the read-only "suggestion" becomes a
-- durable claim. Recent 'routed' rows count as in-flight load alongside open
-- leads (so bursts spread across agents), the row is the compliance trail for
-- "this call went to a ready-to-sell agent", and a retried route for the same
-- (org_id, contact_id) inside a short window replays the original decision.
-- 'no_agent_available' decisions are recorded too — coverage/staffing signal.
CREATE TABLE IF NOT EXISTS "lead_routing" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" text,
	"carrier_id" text NOT NULL,
	"state_code" text NOT NULL,
	"certification_year" integer,
	"agent_id" text,
	"status" text NOT NULL,
	"candidate_pool" integer DEFAULT 0 NOT NULL,
	"source" text,
	"presence_filtered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_routing" ADD CONSTRAINT "lead_routing_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_routing" ADD CONSTRAINT "lead_routing_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_routing_org_agent_created_idx" ON "lead_routing" ("org_id","agent_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_routing_org_contact_created_idx" ON "lead_routing" ("org_id","contact_id","created_at");
