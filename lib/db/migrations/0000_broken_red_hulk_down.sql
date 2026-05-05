-- ============================================================================
-- DOWN MIGRATION: 0000_broken_red_hulk_down.sql
--
-- Exactly reverses 0000_broken_red_hulk.sql.  All 37 tables and 26 custom
-- enum types are dropped.  CASCADE handles FK dependency ordering.
--
-- WARNING: Irreversible — take a full backup before running in any
-- non-local environment.
-- ============================================================================

-- Drop tables (CASCADE propagates through FK constraints automatically)
DROP TABLE IF EXISTS "retention_flags"           CASCADE;
DROP TABLE IF EXISTS "import_jobs"               CASCADE;
DROP TABLE IF EXISTS "notifications"             CASCADE;
DROP TABLE IF EXISTS "sequences"                 CASCADE;
DROP TABLE IF EXISTS "sequence_steps"            CASCADE;
DROP TABLE IF EXISTS "sequence_enrollments"      CASCADE;
DROP TABLE IF EXISTS "automation_rules"          CASCADE;
DROP TABLE IF EXISTS "automation_rule_logs"      CASCADE;
DROP TABLE IF EXISTS "sms_templates"             CASCADE;
DROP TABLE IF EXISTS "opt_outs"                  CASCADE;
DROP TABLE IF EXISTS "messages"                  CASCADE;
DROP TABLE IF EXISTS "message_threads"           CASCADE;
DROP TABLE IF EXISTS "email_templates"           CASCADE;
DROP TABLE IF EXISTS "pipelines"                 CASCADE;
DROP TABLE IF EXISTS "pipeline_stages"           CASCADE;
DROP TABLE IF EXISTS "leads"                     CASCADE;
DROP TABLE IF EXISTS "deals"                     CASCADE;
DROP TABLE IF EXISTS "deal_stage_history"        CASCADE;
DROP TABLE IF EXISTS "contacts"                  CASCADE;
DROP TABLE IF EXISTS "activities"                CASCADE;
DROP TABLE IF EXISTS "documents"                 CASCADE;
DROP TABLE IF EXISTS "task_instances"            CASCADE;
DROP TABLE IF EXISTS "task_templates"            CASCADE;
DROP TABLE IF EXISTS "checklist_runs"            CASCADE;
DROP TABLE IF EXISTS "checklist_items"           CASCADE;
DROP TABLE IF EXISTS "tech_stack_accounts"       CASCADE;
DROP TABLE IF EXISTS "state_licenses"            CASCADE;
DROP TABLE IF EXISTS "platform_requirements"     CASCADE;
DROP TABLE IF EXISTS "license_renewal_alerts"    CASCADE;
DROP TABLE IF EXISTS "carriers"                  CASCADE;
DROP TABLE IF EXISTS "carrier_certifications"    CASCADE;
DROP TABLE IF EXISTS "ahip_records"              CASCADE;
DROP TABLE IF EXISTS "agents"                    CASCADE;
DROP TABLE IF EXISTS "users"                     CASCADE;
DROP TABLE IF EXISTS "sessions"                  CASCADE;
DROP TABLE IF EXISTS "organizations"             CASCADE;
DROP TABLE IF EXISTS "audit_log"                 CASCADE;

-- Drop all 26 custom enum types (exact mirror of CREATE TYPE in the up migration)
DROP TYPE IF EXISTS "public"."user_role";
DROP TYPE IF EXISTS "public"."agent_status";
DROP TYPE IF EXISTS "public"."cert_status";
DROP TYPE IF EXISTS "public"."license_status";
DROP TYPE IF EXISTS "public"."tech_account_status";
DROP TYPE IF EXISTS "public"."checklist_item_status";
DROP TYPE IF EXISTS "public"."checklist_run_status";
DROP TYPE IF EXISTS "public"."checklist_run_type";
DROP TYPE IF EXISTS "public"."task_priority";
DROP TYPE IF EXISTS "public"."task_status";
DROP TYPE IF EXISTS "public"."activity_type";
DROP TYPE IF EXISTS "public"."contact_status";
DROP TYPE IF EXISTS "public"."deal_status";
DROP TYPE IF EXISTS "public"."lead_status";
DROP TYPE IF EXISTS "public"."plan_type";
DROP TYPE IF EXISTS "public"."channel";
DROP TYPE IF EXISTS "public"."message_direction";
DROP TYPE IF EXISTS "public"."message_status";
DROP TYPE IF EXISTS "public"."automation_result";
DROP TYPE IF EXISTS "public"."sequence_enrollment_status";
DROP TYPE IF EXISTS "public"."sequence_status";
DROP TYPE IF EXISTS "public"."sequence_step_type";
DROP TYPE IF EXISTS "public"."sequence_trigger_type";
DROP TYPE IF EXISTS "public"."import_source";
DROP TYPE IF EXISTS "public"."import_status";
DROP TYPE IF EXISTS "public"."retention_flag_type";

-- Remove pg-boss migration tracking table
DROP TABLE IF EXISTS "__drizzle_migrations";
