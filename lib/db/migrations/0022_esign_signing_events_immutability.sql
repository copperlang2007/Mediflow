-- Enforce append-only immutability on esign_signing_events (HIPAA / SOC 2 /
-- ESIGN-evidence requirement). The granular audit trail of envelope events
-- is the evidence record that justifies an electronic signature; any
-- UPDATE or DELETE on these rows must be blocked at the DB layer so
-- application code (or a compromised credential) cannot tamper with the
-- evidence after the fact.
--
-- Mirrors the pattern shipped in `0002_audit_log_immutability.sql` for the
-- top-level audit_log.

CREATE OR REPLACE FUNCTION esign_signing_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'esign_signing_events records are append-only: updates and deletes are not permitted';
END;
$$;

DROP TRIGGER IF EXISTS esign_signing_events_no_update ON esign_signing_events;
CREATE TRIGGER esign_signing_events_no_update
  BEFORE UPDATE ON esign_signing_events
  FOR EACH ROW EXECUTE FUNCTION esign_signing_events_immutable();

DROP TRIGGER IF EXISTS esign_signing_events_no_delete ON esign_signing_events;
CREATE TRIGGER esign_signing_events_no_delete
  BEFORE DELETE ON esign_signing_events
  FOR EACH ROW EXECUTE FUNCTION esign_signing_events_immutable();
