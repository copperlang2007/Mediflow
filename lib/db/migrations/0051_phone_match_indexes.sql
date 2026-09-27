-- Expression indexes for format-independent phone matching (0050 follow-up).
--
-- Opt-out checks compare the last 10 digits of a phone number
-- (artifacts/api-server/src/lib/compliance/phone.ts) so "(512) 555-0100"
-- matches Twilio's "+15125550100". That expression cannot use the plain
-- btree on contacts.phone (0012), so without these indexes every inbound
-- STOP/START and every outbound SMS opt-out check is a sequential scan.
-- The indexed expression must stay byte-for-byte identical to
-- phoneMatchKeySql() or the planner will not use it.
--
-- NOTE ON CONCURRENCY: these use plain `CREATE INDEX IF NOT EXISTS`, which
-- takes a SHARE lock that blocks writes while the index builds, because the
-- migrator wraps each file in a transaction and CONCURRENTLY cannot run inside
-- one. The production runner (lib/db/src/migrate-locked.ts,
-- CONCURRENT_PREBUILDS) builds both indexes CONCURRENTLY on existing tables
-- BEFORE applying migrations, so on a live database the statements below are
-- no-ops and no write lock is taken. Only a fresh database (empty tables)
-- builds them here. Keep the definitions in sync with CONCURRENT_PREBUILDS.
--
-- Running migrations some other way (drizzle-kit migrate:cli) skips the
-- pre-build; on a large table, run these by hand first:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_phone_last10_idx
--     ON contacts ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)));
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS opt_outs_phone_last10_channel_idx
--     ON opt_outs ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)), channel);
--
-- If a concurrent build fails it leaves an INVALID index; drop it and rerun
-- (the runner does this automatically).
CREATE INDEX IF NOT EXISTS contacts_phone_last10_idx
  ON contacts ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)));
CREATE INDEX IF NOT EXISTS opt_outs_phone_last10_channel_idx
  ON opt_outs ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)), channel);
