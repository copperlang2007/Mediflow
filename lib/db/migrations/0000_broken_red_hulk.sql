CREATE TYPE "public"."user_role" AS ENUM('super_admin', 'agency_admin', 'compliance_manager', 'agent_support', 'viewer', 'agent');--> statement-breakpoint
CREATE TYPE "public"."agent_status" AS ENUM('onboarding', 'active', 'suspended', 'offboarding', 'offboarded');--> statement-breakpoint
CREATE TYPE "public"."cert_status" AS ENUM('not_started', 'in_progress', 'passed', 'failed', 'waived');--> statement-breakpoint
CREATE TYPE "public"."license_status" AS ENUM('active', 'pending', 'expired', 'suspended', 'not_appointed');--> statement-breakpoint
CREATE TYPE "public"."tech_account_status" AS ENUM('provisioned', 'pending', 'deprovisioned');--> statement-breakpoint
CREATE TYPE "public"."checklist_item_status" AS ENUM('pending', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."checklist_run_status" AS ENUM('in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."checklist_run_type" AS ENUM('onboarding', 'offboarding');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."activity_type" AS ENUM('note', 'call_log', 'sms', 'email', 'status_change', 'enrollment', 'task_complete', 'document_upload', 'sequence_enrolled', 'sequence_step');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('lead', 'prospect', 'enrolled', 'retained', 'lost', 'do_not_contact');--> statement-breakpoint
CREATE TYPE "public"."deal_status" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'qualified', 'disqualified', 'converted');--> statement-breakpoint
CREATE TYPE "public"."plan_type" AS ENUM('MA', 'PDP', 'MAPD', 'supp', 'other');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'failed', 'received');--> statement-breakpoint
CREATE TYPE "public"."automation_result" AS ENUM('success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sequence_enrollment_status" AS ENUM('active', 'completed', 'cancelled', 'paused');--> statement-breakpoint
CREATE TYPE "public"."sequence_status" AS ENUM('active', 'paused', 'draft');--> statement-breakpoint
CREATE TYPE "public"."sequence_step_type" AS ENUM('sms', 'email', 'task', 'wait');--> statement-breakpoint
CREATE TYPE "public"."sequence_trigger_type" AS ENUM('manual', 'lead_created', 'enrolled', 'birthday', 'plan_anniversary', 'aep_start', 'oep_start', 'custom_date');--> statement-breakpoint
CREATE TYPE "public"."import_source" AS ENUM('monday', 'ghl', 'csv');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."retention_flag_type" AS ENUM('at_risk', 'anniversary_due', 'birthday_soon', 'aep_eligible', 'oep_eligible');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"user_role" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"changes" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan_tier" text DEFAULT 'starter' NOT NULL,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role" "user_role" DEFAULT 'agent' NOT NULL,
	"avatar_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"npn" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"avatar_url" text,
	"status" "agent_status" DEFAULT 'onboarding' NOT NULL,
	"hire_date" timestamp with time zone,
	"offboard_date" timestamp with time zone,
	"manager_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ahip_records" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"certification_year" integer NOT NULL,
	"status" "cert_status" DEFAULT 'not_started' NOT NULL,
	"score" real,
	"completed_date" timestamp with time zone,
	"document_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_certifications" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"carrier_id" text NOT NULL,
	"certification_year" integer NOT NULL,
	"status" "cert_status" DEFAULT 'not_started' NOT NULL,
	"completed_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"score" real,
	"document_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carriers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"cms_contract_number" text,
	"logo_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_renewal_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"license_id" text NOT NULL,
	"alert_days_before" integer NOT NULL,
	"sent_at" timestamp with time zone,
	"notification_id" text
);
--> statement-breakpoint
CREATE TABLE "platform_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"platform_name" text NOT NULL,
	"platform_category" text,
	"is_required" boolean DEFAULT true NOT NULL,
	"onboarding_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "state_licenses" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"state_code" text NOT NULL,
	"license_type" text NOT NULL,
	"license_number" text,
	"issue_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"status" "license_status" DEFAULT 'pending' NOT NULL,
	"renewal_submitted_at" timestamp with time zone,
	"document_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tech_stack_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"platform_name" text NOT NULL,
	"platform_category" text,
	"status" "tech_account_status" DEFAULT 'pending' NOT NULL,
	"account_identifier" text,
	"provisioned_at" timestamp with time zone,
	"deprovisioned_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "checklist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"required" boolean DEFAULT true NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"status" "checklist_item_status" DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "checklist_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"type" "checklist_run_type" NOT NULL,
	"status" "checklist_run_status" DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" text
);
--> statement-breakpoint
CREATE TABLE "task_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"template_id" text,
	"agent_id" text,
	"contact_id" text,
	"title" text NOT NULL,
	"description" text,
	"due_date" timestamp with time zone,
	"assigned_to" text,
	"assigned_to_user_id" text,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"description" text,
	"type" text DEFAULT 'custom' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"trigger_event" text,
	"due_days_from_trigger" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"steps" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" text,
	"contact_id" text,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"storage_key" text NOT NULL,
	"file_size_bytes" integer,
	"mime_type" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" text,
	"agent_id" text,
	"deal_id" text,
	"task_id" text,
	"type" "activity_type" NOT NULL,
	"body" text,
	"metadata" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"assigned_agent_id" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"dob" timestamp with time zone,
	"medicare_id" text,
	"current_plan_type" "plan_type",
	"current_carrier_id" text,
	"plan_year" integer,
	"county" text,
	"state_code" text,
	"zip_code" text,
	"preferred_language" text,
	"pcp_name" text,
	"pcp_npi" text,
	"health_conditions" text[],
	"lead_source" text,
	"status" "contact_status" DEFAULT 'lead' NOT NULL,
	"opt_out_sms" boolean DEFAULT false NOT NULL,
	"opt_out_email" boolean DEFAULT false NOT NULL,
	"tags" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_stage_history" (
	"id" text PRIMARY KEY NOT NULL,
	"deal_id" text NOT NULL,
	"from_stage_id" text,
	"to_stage_id" text NOT NULL,
	"changed_by_user_id" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pipeline_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"assigned_agent_id" text,
	"title" text NOT NULL,
	"value_est" real,
	"status" "deal_status" DEFAULT 'open' NOT NULL,
	"won_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"lost_reason" text,
	"close_date_est" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"assigned_agent_id" text,
	"source" text,
	"source_detail" text,
	"score" integer DEFAULT 0 NOT NULL,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"converted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"pipeline_id" text NOT NULL,
	"name" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"color" text DEFAULT '#6366f1' NOT NULL,
	"probability_pct" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text,
	"merge_fields" text[],
	"category" text DEFAULT 'general' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"channel" "channel" NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"body" text,
	"subject" text,
	"from_address" text,
	"to_address" text,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opt_outs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"phone" text,
	"email" text,
	"channel" "channel" NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"merge_fields" text[],
	"category" text DEFAULT 'general' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rule_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"trigger_event" text,
	"matched_record_type" text,
	"matched_record_id" text,
	"actions_executed" jsonb,
	"result" "automation_result" NOT NULL,
	"error_message" text,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb,
	"conditions" jsonb,
	"actions" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"status" "sequence_enrollment_status" DEFAULT 'active' NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"next_step_index" integer DEFAULT 0 NOT NULL,
	"next_step_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"step_type" "sequence_step_type" NOT NULL,
	"delay_value" integer DEFAULT 0 NOT NULL,
	"delay_unit" text DEFAULT 'days' NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" "sequence_trigger_type" DEFAULT 'manual' NOT NULL,
	"trigger_config" jsonb,
	"status" "sequence_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"read_at" timestamp with time zone,
	"action_url" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source" "import_source" NOT NULL,
	"status" "import_status" DEFAULT 'pending' NOT NULL,
	"file_key" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"flag_type" "retention_flag_type" NOT NULL,
	"due_date" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ahip_records" ADD CONSTRAINT "ahip_records_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_certifications" ADD CONSTRAINT "carrier_certifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carrier_certifications" ADD CONSTRAINT "carrier_certifications_carrier_id_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."carriers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carriers" ADD CONSTRAINT "carriers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_renewal_alerts" ADD CONSTRAINT "license_renewal_alerts_license_id_state_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."state_licenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_requirements" ADD CONSTRAINT "platform_requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "state_licenses" ADD CONSTRAINT "state_licenses_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tech_stack_accounts" ADD CONSTRAINT "tech_stack_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_run_id_checklist_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."checklist_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD CONSTRAINT "checklist_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_instances" ADD CONSTRAINT "task_instances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_instances" ADD CONSTRAINT "task_instances_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_current_carrier_id_carriers_id_fk" FOREIGN KEY ("current_carrier_id") REFERENCES "public"."carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_message_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."message_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_outs" ADD CONSTRAINT "opt_outs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_templates" ADD CONSTRAINT "sms_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_logs" ADD CONSTRAINT "automation_rule_logs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_flags" ADD CONSTRAINT "retention_flags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_flags" ADD CONSTRAINT "retention_flags_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;