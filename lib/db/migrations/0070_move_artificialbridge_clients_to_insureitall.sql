-- Move the clients (contacts) of the artificialBRIDGE agency into the
-- INSUREitALL agency, together with every row that hangs off those contacts.
--
-- Safety properties:
--   * Idempotent. After the first run the source org has no contacts, so a
--     re-run moves nothing.
--   * Fails closed. If either org cannot be resolved to EXACTLY ONE row (by
--     slug or case-insensitive name) the migration does nothing and says why.
--     Fresh/dev/demo databases therefore see a no-op.
--   * Scoped. Only contacts whose org_id is the source org are touched, plus
--     rows that reference those contacts. Nothing is deleted. The
--     artificialBRIDGE org, its users, agents and settings are left in place.
--   * Tenant boundary. contacts.assigned_agent_id is cleared because those
--     agents belong to the source org; leaving them would cross tenants.
--     Re-assign in INSUREitALL afterwards.
--   * Contact-child tables are discovered from information_schema (every
--     table with both org_id and contact_id), so tables added later are
--     covered and none is forgotten.

DO $$
DECLARE
  src_id   text;
  dst_id   text;
  src_n    int;
  dst_n    int;
  moved    int;
  child    record;
  child_n  int;
BEGIN
  SELECT count(*), min(id) INTO src_n, src_id
    FROM organizations
   WHERE lower(slug) IN ('artificialbridge', 'artificial-bridge', 'theartificialbridge')
      OR lower(name) IN ('artificialbridge', 'artificialbridge llc', 'artificial bridge');

  SELECT count(*), min(id) INTO dst_n, dst_id
    FROM organizations
   WHERE lower(slug) IN ('insureitall', 'insureitall-llc')
      OR lower(name) IN ('insureitall', 'insureitall llc');

  IF src_n <> 1 OR dst_n <> 1 THEN
    RAISE NOTICE '0070: skipped - need exactly one artificialBRIDGE org (found %) and one INSUREitALL org (found %)', src_n, dst_n;
    RETURN;
  END IF;

  IF src_id = dst_id THEN
    RAISE NOTICE '0070: skipped - source and destination are the same org';
    RETURN;
  END IF;

  -- Children first (they are matched through the contacts still in src org).
  FOR child IN
    SELECT c1.table_name
      FROM information_schema.columns c1
      JOIN information_schema.columns c2
        ON c2.table_schema = c1.table_schema
       AND c2.table_name   = c1.table_name
       AND c2.column_name  = 'contact_id'
     WHERE c1.table_schema = current_schema()
       AND c1.column_name  = 'org_id'
       AND c1.table_name  <> 'contacts'
     ORDER BY c1.table_name
  LOOP
    EXECUTE format(
      'UPDATE %I SET org_id = $1 WHERE org_id = $2 AND contact_id IN (SELECT id FROM contacts WHERE org_id = $2)',
      child.table_name
    ) USING dst_id, src_id;
    GET DIAGNOSTICS child_n = ROW_COUNT;
    RAISE NOTICE '0070: % - % row(s) moved', child.table_name, child_n;
  END LOOP;

  UPDATE contacts
     SET org_id = dst_id,
         assigned_agent_id = NULL,
         updated_at = now()
   WHERE org_id = src_id;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE '0070: % contact(s) moved from % to %', moved, src_id, dst_id;
END
$$;
