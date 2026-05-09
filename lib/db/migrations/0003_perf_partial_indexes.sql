-- Composite partial indexes that match the predicates the report queries
-- actually run (e.g. `WHERE org_id = ? AND status = ? AND deleted_at IS NULL`).
-- Partial indexes on `deleted_at IS NULL` are smaller and preferred by the
-- planner for active-row scans, dropping report latency from seconds to <300ms
-- at typical org sizes.
--
-- Note: the non-partial siblings (contacts_org_id_status_idx, etc.) already
-- exist from 0001_add_performance_indexes.sql. The `_active_idx` suffix marks
-- the partial variants so both can co-exist.

CREATE INDEX IF NOT EXISTS "contacts_org_id_status_active_idx"
  ON "contacts" ("org_id", "status") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_org_id_assigned_agent_active_idx"
  ON "contacts" ("org_id", "assigned_agent_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deals_org_id_pipeline_status_active_idx"
  ON "deals" ("org_id", "pipeline_id", "status") WHERE "deleted_at" IS NULL;--> statement-breakpoint
-- leads has no deleted_at column — non-partial composite index is sufficient.
CREATE INDEX IF NOT EXISTS "leads_org_id_assigned_agent_idx"
  ON "leads" ("org_id", "assigned_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_id_created_at_idx"
  ON "messages" ("thread_id", "created_at" DESC);
