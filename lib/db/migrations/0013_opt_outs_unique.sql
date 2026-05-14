-- TCPA / compliance audit-log dedup: a single opt-out event must produce
-- exactly one row in `opt_outs` regardless of how many times the
-- regulator-visible STOP message is delivered (Twilio retries duplicate
-- inbound webhooks on any non-2xx response, and concurrent STOPs from
-- the same number can race past the application's `SELECT` check).
--
-- Before this migration, the inbound SMS handler called
-- `INSERT INTO opt_outs(...) ON CONFLICT DO NOTHING`, but the only
-- conflict target was the primary key (`id = randomUUID()`) — which
-- never conflicts. Two concurrent STOPs therefore inserted TWO audit
-- rows for what is a single regulatory event, polluting the trail.
--
-- The schema has no `revoked_at` / `is_active` column on `opt_outs`
-- today, so the index is unconditional on (org_id, phone, channel).
-- If we later add a revocation-tracking column the index should be
-- narrowed to `WHERE revoked_at IS NULL` so the same number can opt
-- out again after a START in between. That is a separate compliance
-- design call and out of scope here.
--
-- Note: `phone` is nullable in `opt_outs` (the email channel uses
-- `email` instead). Postgres unique indexes treat NULL as distinct by
-- default, so this index only enforces uniqueness for SMS-style rows
-- with a non-null phone. Email-channel rows are unaffected; if a
-- comparable email-dedup constraint is needed, add a sibling index on
-- (org_id, email, channel).

CREATE UNIQUE INDEX IF NOT EXISTS "opt_outs_org_phone_channel_unique"
  ON "opt_outs" ("org_id", "phone", "channel");
