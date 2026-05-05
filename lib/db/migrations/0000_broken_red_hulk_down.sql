-- ============================================================================
-- DOWN MIGRATION: 0000_broken_red_hulk_down.sql
--
-- Reverses 0000_broken_red_hulk.sql.  Run this to roll back the entire schema
-- to a blank slate.  CASCADE handles FK dependency order automatically.
--
-- WARNING: This is destructive and irreversible.  Take a full database backup
-- before executing this in any environment.
-- ============================================================================

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

-- Drop custom enum types
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
DROP TYPE IF EXISTS "public"."plan_type";
DROP TYPE IF EXISTS "public"."contact_status";
DROP TYPE IF EXISTS "public"."notification_type";
DROP TYPE IF EXISTS "public"."notification_priority";
DROP TYPE IF EXISTS "public"."audit_action";
DROP TYPE IF EXISTS "public"."message_direction";
DROP TYPE IF EXISTS "public"."message_status";
DROP TYPE IF EXISTS "public"."message_channel";
DROP TYPE IF EXISTS "public"."automation_trigger_type";
DROP TYPE IF EXISTS "public"."automation_action_type";
DROP TYPE IF EXISTS "public"."plan_tier";

DROP TABLE IF EXISTS "__drizzle_migrations";
