-- Close the TRUNCATE hole in audit_log immutability.
--
-- Migration 0002 installed BEFORE UPDATE / BEFORE DELETE row-level triggers.
-- Row-level triggers do NOT fire on TRUNCATE: Postgres removes the rows via a
-- table-level operation that never visits them individually. So
-- `TRUNCATE audit_log` -- or a `TRUNCATE ... CASCADE` reaching it through a
-- foreign key -- silently erased the entire audit trail while every test of
-- migration 0002 still passed.
--
-- TRUNCATE triggers must be STATEMENT-level (FOR EACH STATEMENT); declaring
-- one FOR EACH ROW is a syntax error. That is why this needs its own trigger
-- rather than an extra event on the 0002 pair.
--
-- This reuses the audit_log_immutable() function created by 0002, so the
-- rejection message stays identical across all three tamper paths.

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
