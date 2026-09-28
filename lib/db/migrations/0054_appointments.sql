-- stage2/calendar-branding: appointments calendar.
-- Free-text notes are stored only as AES-256-GCM ciphertext (notes_encrypted);
-- there is deliberately no plaintext notes column.
DO $$ BEGIN
  CREATE TYPE "appointment_type" AS ENUM ('enrollment', 'review', 'renewal', 'consultation', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "appointment_status" AS ENUM ('confirmed', 'pending', 'completed', 'cancelled', 'no_show');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "appointment_location_type" AS ENUM ('office', 'phone', 'video', 'home');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appointments" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "contact_id" text REFERENCES "contacts"("id") ON DELETE CASCADE,
  "agent_id" text REFERENCES "agents"("id") ON DELETE SET NULL,
  "type" "appointment_type" NOT NULL DEFAULT 'consultation',
  "title" text NOT NULL,
  "notes_encrypted" bytea,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "status" "appointment_status" NOT NULL DEFAULT 'pending',
  "location_type" "appointment_location_type" NOT NULL DEFAULT 'office',
  "location_detail" text,
  "meeting_url" text,
  "reminder_sent_at" timestamp with time zone,
  "created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "appointments_ends_after_starts" CHECK ("ends_at" > "starts_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_org_starts_idx" ON "appointments" ("org_id", "starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_agent_starts_idx" ON "appointments" ("agent_id", "starts_at");
