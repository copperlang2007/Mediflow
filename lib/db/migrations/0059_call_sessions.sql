-- Native browser calling (Twilio Voice): one row per call attempt, including
-- attempts refused by preclearance (status 'blocked') as an audit trail.
-- twilio_call_sid is unique when present (NULLs are distinct in Postgres).
CREATE TABLE IF NOT EXISTS "call_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"contact_id" text REFERENCES "contacts"("id") ON DELETE set null,
	"agent_id" text REFERENCES "agents"("id") ON DELETE set null,
	"user_id" text REFERENCES "users"("id") ON DELETE set null,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"to_number" text NOT NULL,
	"from_number" text,
	"status" text DEFAULT 'initiated' NOT NULL,
	"twilio_call_sid" text,
	"started_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"disposition_code" text,
	"notes" text,
	"preclearance_result" jsonb,
	"blocked_reason" text,
	"recording_enabled" boolean DEFAULT false NOT NULL,
	"activity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_sessions_status_check" CHECK ("status" IN ('initiated','ringing','in_progress','completed','busy','no_answer','failed','canceled','blocked'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_sessions_org_id_created_at_idx" ON "call_sessions" ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "call_sessions_twilio_call_sid_key" ON "call_sessions" ("twilio_call_sid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_sessions_contact_id_idx" ON "call_sessions" ("contact_id");
