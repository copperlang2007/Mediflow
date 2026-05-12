-- Phase 1 of the Dev Console (PR #56) added 'developer' to the
-- userRoleEnum in lib/db/src/schema/core.ts but never added a
-- corresponding SQL migration. Production has kept the value via
-- `drizzle-kit push`, but a fresh DB built from migrations alone is
-- missing it, which the integration test suite caught.
--
-- Idempotent so it can re-run against the existing prod DB.
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'developer';
