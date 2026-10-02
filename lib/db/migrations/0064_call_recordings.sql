ALTER TABLE "call_transcripts" DROP CONSTRAINT "call_transcripts_source_check";
--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_source_check" CHECK ("source" IN ('upload','import','enrollhere_download','dialer','other','recording'));
--> statement-breakpoint
CREATE TABLE "call_recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"status" text DEFAULT 'uploading' NOT NULL,
	"layout" text DEFAULT 'mono' NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text,
	"size_bytes" integer,
	"details_encrypted" bytea,
	"agent_id" text REFERENCES "agents"("id") ON DELETE SET NULL,
	"contact_id" text REFERENCES "contacts"("id") ON DELETE SET NULL,
	"call_session_id" text REFERENCES "call_sessions"("id") ON DELETE SET NULL,
	"call_date" timestamp with time zone,
	"rubric_id" text,
	"ai_mode" text DEFAULT 'auto' NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"operation_name" text,
	"transcript_id" text REFERENCES "call_transcripts"("id") ON DELETE SET NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"duration_seconds" integer,
	"created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_recordings_status_check" CHECK ("status" IN ('uploading','queued','transcribing','scored','failed')),
	CONSTRAINT "call_recordings_layout_check" CHECK ("layout" IN ('mono','agent_left','agent_right')),
	CONSTRAINT "call_recordings_ai_mode_check" CHECK ("ai_mode" IN ('auto','off')),
	CONSTRAINT "call_recordings_source_check" CHECK ("source" IN ('upload','import','enrollhere_download','dialer','other','recording'))
);
--> statement-breakpoint
CREATE INDEX "call_recordings_org_created_idx" ON "call_recordings" ("org_id","created_at");
--> statement-breakpoint
CREATE INDEX "call_recordings_status_idx" ON "call_recordings" ("status");
