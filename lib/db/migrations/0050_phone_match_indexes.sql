-- Expression indexes for format-independent phone matching (0049 follow-up).
--
-- Opt-out checks compare the last 10 digits of a phone number
-- (artifacts/api-server/src/lib/compliance/phone.ts) so "(512) 555-0100"
-- matches Twilio's "+15125550100". That expression cannot use the plain
-- btree on contacts.phone (0012), so without these indexes every inbound
-- STOP/START and every outbound SMS opt-out check is a sequential scan.
-- The indexed expression must stay byte-for-byte identical to
-- phoneMatchKeySql() or the planner will not use it.
--
-- NOTE ON CONCURRENCY (same as 0016_scale_indexes.sql): these use plain
-- `CREATE INDEX IF NOT EXISTS`, which takes a SHARE lock that blocks writes
-- to the table while the index builds. The migration runner wraps each file
-- in a transaction, so `CREATE INDEX CONCURRENTLY` cannot be used here. On a
-- large production `contacts` table, build both indexes by hand OUTSIDE a
-- transaction BEFORE deploying, so the statements below become no-ops and no
-- write lock is taken (a blocked write would stall the Twilio STOP webhook):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_phone_last10_idx
--     ON contacts ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)));
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS opt_outs_phone_last10_channel_idx
--     ON opt_outs ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)), channel);
--
-- If a concurrent build fails it leaves an INVALID index; drop it and rerun.
CREATE INDEX IF NOT EXISTS contacts_phone_last10_idx
  ON contacts ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)));
CREATE INDEX IF NOT EXISTS opt_outs_phone_last10_channel_idx
  ON opt_outs ((right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)), channel);
