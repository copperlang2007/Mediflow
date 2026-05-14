-- Twilio inbound SMS hot-path index on `contacts.phone`.
--
-- artifacts/api-server/src/routes/webhooks.ts performs multiple lookups
-- against `contacts` on every inbound SMS (TCPA opt-out update, opt-out
-- log insert, opt-in update, normal-inbound row fetch). At 100k+ contacts
-- per org these were sequential scans, pushing P95 latency past Twilio's
-- 10s webhook timeout and triggering retries.
--
-- The lookups arrive as `WHERE phone = ?` with NO org filter — the
-- inbound MessageSid has no org context; the phone IS what we use to
-- resolve the contact's org. So this index is on `(phone)` alone, NOT
-- `(org_id, phone)`. A composite would be useless for these queries
-- because there is no leading `org_id` predicate.
--
-- The partial predicate (`WHERE phone IS NOT NULL`) keeps the index
-- small: many contacts in the system have no phone (email-only leads).
-- The webhook only ever queries with a concrete `From` value, so NULL
-- rows never need to be indexed.

CREATE INDEX IF NOT EXISTS "contacts_phone_idx"
  ON "contacts" ("phone")
  WHERE "phone" IS NOT NULL;
