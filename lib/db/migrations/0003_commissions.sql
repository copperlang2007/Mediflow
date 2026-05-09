-- Commissions module: AgencyBloc parity feature.
-- Six tables form the data model for rate cards, hierarchy splits,
-- statement uploads, parsed line items, per-agent payouts, and the
-- expected-vs-actual missed-payment alert backfill.

-- Rate cards: how much carrier X pays for plan_type Y in cert year Z
CREATE TABLE IF NOT EXISTS "commission_schedules" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "carrier_id" text NOT NULL REFERENCES "carriers"("id"),
  "plan_type" text NOT NULL,
  "contract_year" integer NOT NULL,
  "initial_pct" numeric(6,3),
  "renewal_pct" numeric(6,3),
  "flat_amount" numeric(10,2),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "commission_schedules_plan_type_check" CHECK ("plan_type" IN ('MA','PDP','MAPD','supp','other')),
  CONSTRAINT "commission_schedules_status_check" CHECK ("status" IN ('active','archived'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_schedules_org_carrier_idx"
  ON "commission_schedules" ("org_id", "carrier_id", "contract_year");
--> statement-breakpoint

-- Splits: writing agent → upline % grid
CREATE TABLE IF NOT EXISTS "commission_hierarchies" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "writing_agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "upline_agent_id" text REFERENCES "agents"("id") ON DELETE SET NULL,
  "split_pct" numeric(5,2) NOT NULL,
  "effective_from" date NOT NULL,
  "effective_to" date,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "commission_hierarchies_split_pct_check" CHECK ("split_pct" >= 0 AND "split_pct" <= 100),
  CONSTRAINT "commission_hierarchies_unique" UNIQUE ("org_id", "writing_agent_id", "upline_agent_id", "effective_from")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_hierarchies_writing_agent_idx"
  ON "commission_hierarchies" ("org_id", "writing_agent_id");
--> statement-breakpoint

-- A statement file from a carrier
CREATE TABLE IF NOT EXISTS "commission_statements" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "carrier_id" text NOT NULL REFERENCES "carriers"("id"),
  "statement_date" date NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "total_amount" numeric(12,2),
  "currency" text NOT NULL DEFAULT 'USD',
  "source" text NOT NULL,
  "storage_key" text,
  "status" text NOT NULL,
  "uploaded_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "commission_statements_source_check" CHECK ("source" IN ('csv_upload','manual','api')),
  CONSTRAINT "commission_statements_status_check" CHECK ("status" IN ('pending','parsed','reconciled','disputed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_statements_org_idx"
  ON "commission_statements" ("org_id", "statement_date" DESC);
--> statement-breakpoint

-- One row per (contact, period) on the statement
CREATE TABLE IF NOT EXISTS "commission_line_items" (
  "id" text PRIMARY KEY NOT NULL,
  "statement_id" text NOT NULL REFERENCES "commission_statements"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "contact_id" text REFERENCES "contacts"("id"),
  "member_id" text,
  "policy_number" text,
  "plan_type" text,
  "plan_year" integer,
  "period_start" date,
  "period_end" date,
  "premium" numeric(10,2),
  "commission_amount" numeric(10,2) NOT NULL,
  "type" text NOT NULL,
  "writing_agent_id" text REFERENCES "agents"("id") ON DELETE SET NULL,
  "match_status" text NOT NULL DEFAULT 'unmatched',
  "raw" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "commission_line_items_type_check" CHECK ("type" IN ('initial','renewal','bonus','chargeback')),
  CONSTRAINT "commission_line_items_match_status_check" CHECK ("match_status" IN ('matched','unmatched','manual'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_line_items_statement_idx"
  ON "commission_line_items" ("statement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commission_line_items_writing_agent_idx"
  ON "commission_line_items" ("org_id", "writing_agent_id");
--> statement-breakpoint

-- Per-agent payouts (computed from line items × hierarchies)
CREATE TABLE IF NOT EXISTS "agent_commission_payouts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "agent_id" text NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "earned" numeric(12,2) NOT NULL DEFAULT 0,
  "paid" numeric(12,2) NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'open',
  "paid_at" timestamp with time zone,
  "paid_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_commission_payouts_status_check" CHECK ("status" IN ('open','approved','paid','held')),
  CONSTRAINT "agent_commission_payouts_unique" UNIQUE ("org_id", "agent_id", "period_start", "period_end")
);
--> statement-breakpoint

-- Expected-vs-actual gaps
CREATE TABLE IF NOT EXISTS "missed_payment_alerts" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "organizations"("id"),
  "contact_id" text NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "policy_number" text,
  "expected_amount" numeric(10,2),
  "expected_period" date,
  "detected_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "resolution_note" text,
  CONSTRAINT "missed_payment_alerts_unique" UNIQUE ("org_id", "contact_id", "policy_number", "expected_period")
);
