-- Automatic carrier-statement ingestion (watched folder -> parse -> reconcile).
--
--   statement_ingest_sources  one watched location per org (Google Drive folder
--                             today). `mode` is 'hold' (parse, then wait for a
--                             one-click approve before reconciling) or 'auto'
--                             (reconcile straight away when every check passes).
--   statement_ingest_files    one row per (source, file, content checksum). The
--                             unique key makes a re-listed file a no-op, while a
--                             file replaced in place (new checksum) is a new row
--                             that is held for review, never silently re-applied.
--
-- Statement files carry PHI (member ids, names, DOB). Nothing here stores file
-- content: the bytes go to the private object bucket and only the key is kept.
CREATE TABLE IF NOT EXISTS "statement_ingest_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"kind" text DEFAULT 'drive' NOT NULL,
	"folder_id" text NOT NULL,
	"mode" text DEFAULT 'hold' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"carrier_folder_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_ingest_sources_mode_check" CHECK ("mode" IN ('hold', 'auto')),
	CONSTRAINT "statement_ingest_sources_org_folder_key" UNIQUE ("org_id", "kind", "folder_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "statement_ingest_files" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL REFERENCES "organizations"("id"),
	"source_id" text NOT NULL REFERENCES "statement_ingest_sources"("id") ON DELETE CASCADE,
	"external_id" text NOT NULL,
	"checksum" text NOT NULL,
	"file_name" text NOT NULL,
	"folder_name" text,
	"status" text NOT NULL,
	"reason" text,
	"statement_id" text REFERENCES "commission_statements"("id") ON DELETE SET NULL,
	"line_count" integer,
	"matched_count" integer,
	"unmatched_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_ingest_files_status_check" CHECK ("status" IN ('processing', 'held', 'ingested', 'needs_review', 'failed', 'approved', 'dismissed')),
	CONSTRAINT "statement_ingest_files_source_file_key" UNIQUE ("source_id", "external_id", "checksum")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "statement_ingest_files_org_status_idx" ON "statement_ingest_files" ("org_id", "status", "created_at");
