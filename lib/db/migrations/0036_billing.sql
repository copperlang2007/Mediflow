-- Billing — Stripe subscription state + webhook idempotency ledger.
--
-- `subscriptions` is one row per org (org_id UNIQUE) and is written only from
-- verified Stripe webhooks or authenticated server-side syncs; it is the table
-- entitlement checks read. `billing_events` keys on Stripe's own event id so a
-- redelivered webhook collides on the primary key and is discarded before any
-- side effect runs.
--
-- `organizations.plan_tier` stays `text` (it predates this migration and is
-- read in existing code paths) but gains a CHECK constraint so it can never
-- drift from the plan vocabulary the enum defines.
CREATE TYPE "plan_tier" AS ENUM('starter', 'growth', 'agency');--> statement-breakpoint
CREATE TYPE "subscription_status" AS ENUM('none', 'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'paused');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_price_id" text,
	"plan_tier" "plan_tier" DEFAULT 'starter' NOT NULL,
	"status" "subscription_status" DEFAULT 'none' NOT NULL,
	"seats" integer DEFAULT 3 NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_org_id_unique" UNIQUE("org_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"event_type" text NOT NULL,
	"stripe_customer_id" text,
	"payload" jsonb,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "subscriptions_stripe_customer_idx" ON "subscriptions" ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_stripe_subscription_idx" ON "subscriptions" ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_events_org_processed_idx" ON "billing_events" ("org_id","processed_at");--> statement-breakpoint

-- Backfill: every existing org gets a subscription row on the free starter
-- tier so entitlement lookups never have to special-case a missing row.
INSERT INTO "subscriptions" ("id", "org_id", "plan_tier", "status", "seats")
SELECT 'sub_seed_' || "id", "id", 'starter', 'none', 3
FROM "organizations"
ON CONFLICT ("org_id") DO NOTHING;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "organizations" ADD CONSTRAINT "organizations_plan_tier_check" CHECK ("plan_tier" IN ('starter', 'growth', 'agency'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
