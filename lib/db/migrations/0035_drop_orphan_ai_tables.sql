-- Remove the `conversations` / `ai_messages` tables.
--
-- These were leftovers from an AI-chat starter template. They were exported
-- from the schema barrel and created by migrations, but no route, worker, or
-- test ever read or wrote them. Critically they carried NO `org_id`, used
-- serial integer primary keys (every other table is text), and were therefore
-- outside the tenant-isolation model entirely — a table that cannot be
-- org-scoped is a standing cross-tenant hazard in a PHI-adjacent database.
--
-- Dropped rather than retrofitted: there is no data to preserve and no
-- consumer to migrate. The product's real conversation history lives in
-- `message_threads` / `messages`, which are org-scoped.
DROP TABLE IF EXISTS "ai_messages";--> statement-breakpoint
DROP TABLE IF EXISTS "conversations";
