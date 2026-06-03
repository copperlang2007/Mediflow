-- Inbound lead queue (Phase 2) — agent presence.
--
-- Real-time "available right now" signal the queue intersects with
-- ready-to-sell eligibility before routing an inbound call. One row per agent
-- (agent_id is the PK / upsert target). Written by two sources:
--   * heartbeat  — the web app; the ONLY writer that sets 'available'.
--   * dialer     — call-state events flip on_call / wrap (fail-closed: a
--                  missed terminal event leaves the agent excluded).
-- TTL is enforced at READ time (status='available' AND expires_at > now()),
-- so a stale row stops being routable without a background sweep.
CREATE TYPE "agent_presence_status" AS ENUM('available', 'on_call', 'wrap', 'away', 'offline');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_presence" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"status" "agent_presence_status" DEFAULT 'offline' NOT NULL,
	"source" text,
	"last_event_id" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_presence" ADD CONSTRAINT "agent_presence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_presence" ADD CONSTRAINT "agent_presence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_presence_org_status_idx" ON "agent_presence" ("org_id","status");
