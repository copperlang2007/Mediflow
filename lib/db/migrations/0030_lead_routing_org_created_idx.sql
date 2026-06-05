-- Inbound lead queue — index the audit-trail read.
--
-- The admin Live Queue ("recent routing decisions") filters lead_routing by
-- org_id and orders by created_at DESC. The existing indexes lead with
-- (org_id, agent_id, ...) / (org_id, contact_id, ...), so that query was a
-- filter-then-sort. Add (org_id, created_at) so it is served index-ordered as
-- the audit trail grows.
CREATE INDEX IF NOT EXISTS "lead_routing_org_created_idx" ON "lead_routing" ("org_id","created_at");
