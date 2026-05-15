-- Pre-launch scale-audit indexes.
--
-- NOTE ON CONCURRENCY: these use plain `CREATE INDEX IF NOT EXISTS`, which
-- takes a SHARE lock that blocks writes on the table for the duration of the
-- build. This repo's migration runner wraps each file in a transaction, and
-- `CREATE INDEX CONCURRENTLY` is not permitted inside a transaction block.
-- On a large production `message_threads` / `commission_line_items` table the
-- DBA should instead build these by hand with `CREATE INDEX CONCURRENTLY`
-- (outside any transaction) BEFORE deploying this migration, so the
-- `IF NOT EXISTS` here becomes a no-op and no write lock is taken.

-- H1: message_threads.contact_id had a foreign key but no index.
--
-- Every contact-detail page open and EVERY Twilio inbound SMS webhook runs
-- `SELECT ... FROM message_threads WHERE contact_id = ? [AND channel = ?]
-- [AND org_id = ?]` (see routes/contacts.ts and routes/webhooks.ts). Without
-- an index this is a sequential scan; at scale the webhook path risks Twilio's
-- 10s timeout.
--
-- Column order: `contact_id` leads because it is the single predicate common
-- to ALL call sites and is highly selective (a contact has only a handful of
-- threads). The webhook path filters `(contact_id, channel)` with NO org_id
-- (the inbound SMS has no org context). The contacts routes filter
-- `(contact_id, org_id, channel)`. Leading with `contact_id` then including
-- `org_id` and `channel` serves every shape: the webhook uses the
-- contact_id+channel prefix-with-gap (channel still filterable), and the
-- contacts routes use the full key. Putting `org_id` second keeps the
-- contacts-route lookups fully index-covered.
CREATE INDEX IF NOT EXISTS "message_threads_contact_id_org_channel_idx"
  ON "message_threads" ("contact_id", "org_id", "channel");
--> statement-breakpoint

-- H2: commission_line_items per-agent report period filter was unindexed.
--
-- GET /agents/:id/commissions (routes/commissions.ts) filters
-- `org_id = ? AND writing_agent_id = ? [AND type = ?]
-- AND period_start >= ? AND period_end <= ?`. The existing
-- `commission_line_items_writing_agent_idx (org_id, writing_agent_id)` covers
-- only the two equality columns and leaves the period range as a heap filter.
--
-- Column order follows the equality-before-range rule: `org_id` and
-- `writing_agent_id` are equality predicates (present on every call), so they
-- lead; `period_start` is the range predicate and goes last so the index can
-- still range-scan it. `type` is optional and lower-selectivity, so it is left
-- out — including it after a range column would not help the range scan.
-- This index is a strict superset of the old writing_agent_idx prefix; the old
-- one is left in place to avoid an extra drop in this migration.
CREATE INDEX IF NOT EXISTS "commission_line_items_org_agent_period_idx"
  ON "commission_line_items" ("org_id", "writing_agent_id", "period_start");
