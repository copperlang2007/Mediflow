-- masterBRIDGE dialer integration (Option A, Phase 2).
--
-- Two boundary tables. MediFlow stays the system of record; these only
-- support the signed HTTP + webhook contract with the stateless dialer.
--
--  * dial_tickets   — every dial request MediFlow issues. `id` is the
--                     UUID `dialTicketId` correlation key (spec §3). Carries
--                     the transcript purge-confirmation state (§6.1). The MBI
--                     is never stored here — it never crosses the boundary.
--  * dialer_events  — inbound webhook ledger keyed on the dialer's `eventId`
--                     so duplicate / retried deliveries dedupe at the DB level
--                     (§6.2). Every event also lands in the audit log.

CREATE TABLE IF NOT EXISTS "dial_tickets" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "agent_id" text,
  "contact_ref" text,
  "campaign_id" text,
  "status" text DEFAULT 'QUEUED' NOT NULL,
  "preclearance_id" text,
  "dialer_call_id" text,
  "transcript_hash" text,
  "transcript_ready_at" timestamp with time zone,
  "transcript_purge_confirmed_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "dial_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dial_tickets_org_id_idx" ON "dial_tickets" ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dial_tickets_org_id_status_idx" ON "dial_tickets" ("org_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dialer_events" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "type" text NOT NULL,
  "dial_ticket_id" text,
  "dialer_call_id" text,
  "schema_version" text,
  "occurred_at" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "payload" jsonb,
  CONSTRAINT "dialer_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dialer_events_org_id_received_at_idx" ON "dialer_events" ("org_id", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dialer_events_dial_ticket_id_idx" ON "dialer_events" ("dial_ticket_id");
