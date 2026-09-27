-- Knowledge Base articles: short, non-PHI reference notes an agency writes for
-- its staff (plan rules, carrier quirks, how-tos). Active articles whose
-- keywords or title match a question are handed to the AI assistant as
-- clearly delimited reference material. Never store client data here.
CREATE TABLE IF NOT EXISTS "kb_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Foreign keys in guarded statements: CREATE TABLE IF NOT EXISTS skips its
-- whole body (inline FKs included) when the table already exists.
DO $$ BEGIN
  ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_articles_org_active_idx" ON "kb_articles" USING btree ("org_id","is_active");
