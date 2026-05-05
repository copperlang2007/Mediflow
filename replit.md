# MediFlow — Medicare Sales Agency Platform

## Overview

Production-grade Medicare agency management platform replacing Monday.com (agent lifecycle) and GoHighLevel (CRM). Supports 25-100 agents with HIPAA/SOC 2 compliance, AI integrations, automations, two-way SMS/email, and retention tools.

## Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **TypeScript**: 5.9
- **API**: Express 5 + PostgreSQL + Drizzle ORM
- **Auth**: Clerk (Clerk proxy at `/api/__clerk`)
- **Validation**: Zod v4 + drizzle-zod
- **API codegen**: Orval (from `lib/api-spec/openapi.yaml`)
- **Frontend**: React 19 + Vite + Tailwind v4 + shadcn/ui + wouter + React Query v5
- **Storage**: Replit Object Storage
- **Background jobs**: pg-boss (PostgreSQL-backed job queue)
- **Email**: Resend (RESEND_API_KEY env secret)
- **SMS**: Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER env secrets)
- **Build**: esbuild (CJS bundle for API)

## Project Structure

```
artifacts/
  api-server/         Express 5 API, Clerk auth, all routes
    src/
      lib/
        permissions.ts    Centralized RBAC matrix (resource × action → roles)
        jobs.ts           pg-boss job queue singleton + startWorkers()
        email.ts          Resend email client (typed, never-throw)
        sms.ts            Twilio SMS client (typed, never-throw)
        logger.ts         Pino logger
        objectStorage.ts  Replit Object Storage client
      middlewares/
        requireAuth.ts      Clerk auth + DB user lookup; exposes requireRole(resource, action)
        auditMiddleware.ts  Auto PHI audit logging (wraps res.on("finish"))
        clerkProxyMiddleware.ts
      routes/             REST API route handlers
      workers/
        licenseExpiryCheck.ts   Daily license expiry alerts
        ahipReminderCheck.ts    Monthly AHIP reminder alerts
        taskAutoAssign.ts       On-agent-create task instantiation
  web-app/            React+Vite frontend
    src/
      components/
        ErrorBoundary.tsx   Global React error boundary
        layout/AppShell.tsx Sidebar navigation shell
      pages/              Route-level lazy-loaded pages
      App.tsx             ClerkProvider + wouter router + lazy routes
  mockup-sandbox/     Component design preview server
lib/
  db/                 Drizzle ORM schema + client
  api-spec/           OpenAPI spec (source of truth) + orval codegen
  api-client-react/   Generated React Query hooks
  api-zod/            Generated Zod validation schemas
```

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
  - **ALWAYS** fix `lib/api-zod/src/index.ts` afterward to only contain `export * from "./generated/api"`
- `pnpm --filter @workspace/db run push` — push DB schema to PostgreSQL (dev only)
- `pnpm --filter @workspace/db run generate` — generate migration SQL files
- `pnpm --filter @workspace/db run migrate` — run pending migrations
- `pnpm --filter @workspace/db exec tsc --build` — rebuild DB package `.d.ts` files (required after schema changes for api-server to pick up new types via project references)
- `pnpm --filter @workspace/api-server run dev` — run API server
- `pnpm --filter @workspace/web-app run dev` — run frontend

## Database Schema (lib/db/src/schema/)

- `core.ts` — organizations, users (roles: super_admin, agency_admin, compliance_manager, agent_support, viewer, agent), audit_log
- `agents.ts` — agents (status: onboarding, active, suspended, offboarding, offboarded), state_licenses, carrier_certifications, ahip_records, agent_documents
- `tasks.ts` — task_templates (with triggerEvent, dueDaysFromTrigger, isActive), task_instances, checklist_runs, checklist_items
- `documents.ts` — documents
- `crm.ts` — contacts, leads, pipelines, pipeline_stages, deals, deal_stage_history, activities
- `communications.ts` — message_threads, messages, email_templates, sms_templates, opt_outs
- `automations.ts` — sequences, sequence_steps, sequence_enrollments, automation_rules, automation_rule_logs
- `notifications.ts` — notifications (with priority, resourceType, resourceId)
- `retention.ts` — retention_flags, import_jobs
- `settings.ts` — org_settings (sessionTimeoutMinutes)
- `analytics.ts` — login_events, data_export_log, data_retention_policies
- `conversations.ts` — conversations (AI chat sessions)
- `messages.ts` — messages (AI chat messages)

## API Routes (all prefixed /api)

- `GET /healthz` — health check (no auth)
- `POST /auth/provision` — first-login user+org provisioning
- `GET/PATCH /users/me` — profile management
- `GET /users` — list org users (compliance_manager+ only)
- `PATCH /users/:userId/role` — role management (agency_admin+ only)
- `GET/PATCH /organizations/me` — org management
- `GET /dashboard/stats` — aggregate dashboard stats
- `GET /dashboard/activity` — recent activity feed
- `GET/POST /agents` — agent roster; POST auto-creates onboarding checklist
- `GET /agents/:id` — agent detail with compliance summary
- `PATCH /agents/:id` — update agent
- `DELETE /agents/:id` — delete agent (agency_admin+)
- `GET /agents/:id/compliance-score` — calculated compliance score (license/cert/ahip/onboarding)
- `POST /agents/:id/offboard` — start offboarding (sets status + creates offboarding checklist)
- `GET/POST /agents/:id/licenses` — state licenses CRUD
- `PATCH/DELETE /agents/:id/licenses/:lid` — update/delete license
- `GET/POST /agents/:id/certifications` — carrier certifications CRUD
- `PATCH/DELETE /agents/:id/certifications/:cid` — update/delete certification
- `GET/POST /agents/:id/ahip` — AHIP records CRUD
- `PATCH/DELETE /agents/:id/ahip/:aid` — update/delete AHIP record
- `GET /agents/:id/checklists` — list checklist runs
- `POST /agents/:id/checklists` — start new checklist run
- `GET /agents/:id/checklists/:runId` — get checklist run + items
- `PATCH /checklists/:runId/items/:itemId` — update checklist item status
- `GET/POST /agents/:id/techstack` — tech stack accounts CRUD
- `PATCH/DELETE /agents/:id/techstack/:aid` — update/delete tech stack account
- `GET/POST /tasks` — org-wide tasks
- `PATCH/DELETE /tasks/:id` — update/delete task
- `GET /agents/:id/tasks` — tasks for specific agent
- `GET/POST /agents/:id/documents` — agent documents
- `PATCH/DELETE /agents/:id/documents/:did` — update/delete document
- `GET /carriers` — list carriers
- `POST /carriers` — create carrier (agency_admin+)
- `PATCH /carriers/:id` — update carrier
- `POST /carriers/seed` — seed default Medicare carriers
- `GET/POST /contacts` — contact list + create; supports search, status/plan/tag filters, pagination
- `POST /contacts/bulk` — bulk assign agent, add/remove tag, set status, export CSV
- `GET/PATCH/DELETE /contacts/:id` — contact detail CRUD
- `GET /contacts/:id/activities` — activity timeline
- `POST /contacts/:id/activities` — log note/call/enrollment
- `POST /contacts/:id/sms` — send SMS (Twilio)
- `POST /contacts/:id/email` — send email (Resend)
- `GET /contacts/:id/threads` — message threads for contact
- `GET /contacts/:id/tasks` — tasks linked to contact
- `GET /contacts/:id/enrollments` — sequence enrollments for contact
- `GET/POST /leads` — leads list + create
- `GET/PATCH /leads/:id` — lead detail + update status
- `POST /leads/:id/convert` — convert lead to prospect
- `GET /leads/stats` — lead counts by status + source
- `GET/POST /pipelines` — pipeline list + create (with default stages)
- `GET/PATCH/DELETE /pipelines/:id` — pipeline detail CRUD
- `POST /pipelines/:id/stages` — add stage; PATCH/DELETE /pipelines/:id/stages/:sid
- `GET /pipelines/:id/analytics` — conversion rate, win rate, total/won deals
- `GET/POST /deals` — deals by pipeline/stage/contact; create deal
- `GET/PATCH /deals/:id` — deal detail + move stage
- `GET /threads` — message thread list (SMS + email)
- `GET /threads/:id/messages` — thread message history
- `POST /threads/:id/reply` — reply in thread
- `GET /inbox` — unread messages across all channels
- `PATCH /messages/:id/read` — mark message read
- `GET/POST /templates/sms` — SMS template library
- `GET/PATCH/DELETE /templates/sms/:id`
- `GET/POST /templates/email` — email template library
- `GET/PATCH/DELETE /templates/email/:id`
- `GET/POST /sequences` — automation sequences
- `GET/PATCH/DELETE /sequences/:id`
- `GET/POST /sequences/:id/steps` — sequence steps
- `PATCH/DELETE /sequences/:id/steps/:sid`
- `POST /sequences/:id/enroll` — enroll a contact in sequence
- `GET /sequences/:id/enrollments` — list enrollments
- `PATCH /sequences/:id/enrollments/:eid` — pause/resume/cancel enrollment
- `GET /retention/birthdays` — contacts with upcoming birthdays (?days=30)
- `GET /retention/anniversaries` — plan anniversary contacts (?days=30)
- `GET /retention/aep` — AEP-eligible enrolled contacts (Oct 15 – Dec 7 window)
- `GET /retention/at-risk` — contacts with no activity in N days (?days=60)
- `GET /retention/flags` — open retention flags
- `POST /retention/flags` — create retention flag
- `PATCH /retention/flags/:id/resolve` — resolve flag
- `GET /retention/summary` — summary counts (birthdays in 30d, at-risk count, open flags)
- `GET /renewals` — upcoming license/cert renewals (?days=90)
- `GET /ahip/dashboard` — AHIP completion stats by year
- `GET /certifications/matrix` — carrier cert matrix by year
- `GET /notifications` — user notifications
- `GET /notifications/count` — unread badge count
- `GET /notifications/stream` — SSE real-time push stream
- `POST /notifications/read-all` — bulk mark read
- `PATCH /notifications/:id/read` — mark single read
- `GET /automations/rules` — list automation rules
- `POST /automations/rules` — create rule (agency_admin+)
- `GET/PATCH/DELETE /automations/rules/:id` — rule detail CRUD
- `POST /automations/rules/:id/toggle` — enable/disable rule
- `POST /automations/rules/:id/run` — manually trigger rule
- `GET /automations/rules/:id/logs` — rule execution history
- `POST /ai/chat` — SSE streaming context-aware chat (system-prompt injected with live DB data)
- `POST /ai/draft` — draft SMS or email for a contact (contactId + type + goal)
- `POST /ai/compliance-report` — SSE streaming agency-wide compliance intelligence report
- `GET /ai/compliance-report/:documentId` — download stored compliance report PDF
- `GET /reports/agent-performance` — agent performance metrics (?startDate&endDate)
- `GET /reports/pipeline` — pipeline funnel analytics (?startDate&endDate)
- `GET /reports/leads` — lead source breakdown + trend (?startDate&endDate)
- `GET /reports/compliance-matrix` — license/cert/AHIP compliance matrix
- `GET /reports/communications` — SMS/email volume with AI-assist rate (?startDate&endDate)
- `GET /reports/retention` — member retention/at-risk/lost counts
- `GET /admin/audit-log` — paginated audit trail with CSV export (compliance_manager+)
- `GET /admin/audit-log/export` — CSV download of audit log
- `GET /admin/access-review` — all users with roles + last login (agency_admin+)
- `GET /admin/access-review/export` — CSV export of user access
- `POST /admin/users/:userId/deactivate` — deactivate user
- `POST /admin/users/:userId/reactivate` — reactivate user
- `GET /admin/login-history` — login event history with success/fail
- `GET /admin/export-log` — data export audit log
- `GET /admin/session-config` — session timeout config
- `PUT /admin/session-config` — update session timeout
- `GET /admin/data-retention` — retention policies per record type
- `PUT /admin/data-retention` — update retention policy
- `GET /admin/baa-checklist` — HIPAA/SOC2 controls checklist
- `POST /admin/soc2-evidence-pack` — generate SOC2 evidence PDF (streams PDF)
- `POST /imports/monday/upload` — parse Monday.com CSV, return headers + mapping suggestions
- `POST /imports/monday/validate` — validate field mapping, return error list
- `POST /imports/monday/confirm` — start async import job, returns jobId
- `POST /imports/ghl/upload|validate|confirm` — GoHighLevel contact import wizard
- `POST /imports/contacts/upload|confirm` — generic CSV contact import
- `GET /imports/progress/:jobId` — SSE stream of import job progress
- `GET /imports/history` — list past import jobs
- `GET /imports/:jobId/errors.csv` — download error rows for a past import
- `GET /audit-log` — HIPAA audit trail (compliance_manager+ only)
- `POST /storage/uploads/request-url` — presigned upload URL
- `GET /storage/public-objects/*` — public assets (no auth)
- `GET /storage/objects/*` — private files (auth + ACL)

## Security Architecture

- **CORS**: Locked to `ALLOWED_ORIGIN` or `https://$REPLIT_DEV_DOMAIN` (never wildcard in prod)
- **Rate limits**: Global 500/15min → Auth endpoints 20/min → Authenticated API 100/min
- **RBAC**: Centralized matrix in `lib/permissions.ts`; use `requireRole("resource", "action")` form
- **Audit trail**: `auditMiddleware("resource", "action")` auto-logs all mutations to `audit_log`
- **Private storage**: All `/storage/objects/*` requires auth + ACL check
- **SSE notifications**: In-memory subscriber map; heartbeat every 25s

## Background Job Queue (pg-boss)

Queues must be created (`boss.createQueue()`) before scheduling or registering workers.

Scheduled jobs:
- `license-expiry-check` — daily 08:00 UTC (finds active licenses expiring ≤90 days)
- `ahip-reminder-check` — monthly 1st 09:00 UTC (finds agents without current-year AHIP)

Ad-hoc jobs (enqueue via `enqueue(JOB_NAMES.X, data)`):
- `task-auto-assign` — triggered on agent creation
- `send-email` — fire-and-forget email via Resend
- `send-sms` — fire-and-forget SMS via Twilio

## AI Integration (lib/integrations-openai-ai-server)

- OpenAI client via Replit AI Integrations proxy (`AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY`)
- Context builders in `api-server/src/lib/aiContext.ts`: `buildAgentContext`, `buildContactContext`, `buildDashboardContext`
- SSE streaming for chat + compliance report endpoints
- Model: `gpt-5.4` with `gpt-image-1` for image generation

## Automation Rules Engine

- `automation_rules` table: trigger (enum), conditions (JSONB array), actions (JSONB array), enabled flag
- `automation_rule_logs` table: ruleId, triggeredBy, status, result, executedAt
- Triggers: `lead_created`, `deal_stage_changed`, `contact_birthday`, `license_expiring_soon`, `certification_expiring_soon`, `ahip_incomplete`, `task_overdue`
- Actions: `create_task`, `send_notification`, `send_email`, `send_sms`, `change_contact_status`, `enroll_sequence`, `change_deal_stage`
- Event hooks: leads.ts fires `lead_created`, pipelines.ts fires `deal_stage_changed`

## Frontend Architecture

- **Lazy loading**: All page components use `React.lazy` + `Suspense` with skeleton fallback
- **Error boundary**: `ErrorBoundary` component wraps each page; global boundary wraps the router
- **Auth**: Clerk `ClerkProvider` → signs in/out users; `Show` components gate authenticated routes
- **Theme**: Navy sidebar (`221 50% 18%`), Medicare blue primary (`221 83% 43%`), cyan accent (`199 89% 48%`)
- **AI panel**: `components/ai-assistant/AiAssistantPanel.tsx` — floating Bot button + right-side SSE chat drawer; slash commands; context-aware (reads page type/agentId/contactId)
- **Automations page**: `pages/automations.tsx` — rule builder with trigger picker, condition builder, multi-action list, enable/disable toggle, execution history modal, manual run
- **CRM contact**: "Draft with AI" button in Send SMS and Send Email modals (calls POST /ai/draft)
- **Compliance page**: "AI Compliance Report" card at top with SSE streaming report generator

## Important Notes

- **Never** use `console.log` in server code — use `req.log` (pino-http) or `logger` from `src/lib/logger.ts`
- Clerk proxy path is `/api/__clerk`; `VITE_CLERK_PROXY_URL` must be set in env
- After any schema changes, run `pnpm --filter @workspace/db run push` then `pnpm --filter @workspace/db exec tsc --build` to rebuild `.d.ts` files for project references
- After any OpenAPI spec changes, run codegen then fix `lib/api-zod/src/index.ts` to only export `export * from "./generated/api"`
- TypeScript project references: api-server reads compiled `.d.ts` from `lib/db/dist/`, not source — always build lib/db before typechecking api-server after schema changes

## Environment Variables

Set via Replit Secrets:
- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` — Clerk backend auth
- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk frontend auth
- `VITE_CLERK_PROXY_URL` — Clerk proxy URL for frontend
- `DATABASE_URL` — PostgreSQL connection string
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID` — Replit object storage
- `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS` — storage paths
- `RESEND_API_KEY` — Transactional email (optional, emails silently skipped if unset)
- `EMAIL_FROM_ADDRESS` — From address for emails (default: noreply@mediflow.app)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — SMS (optional)
- `ALLOWED_ORIGIN` — Override CORS origin (optional, defaults to REPLIT_DEV_DOMAIN)
