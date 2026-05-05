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
- `crm.ts` — contacts, leads, deals, activities
- `communications.ts` — conversations, messages
- `automations.ts` — automation_rules, automation_executions
- `notifications.ts` — notifications (with priority, resourceType, resourceId)
- `retention.ts` — retention_alerts

## API Routes (all prefixed /api)

- `GET /healthz` — health check (no auth)
- `POST /auth/provision` — first-login user+org provisioning
- `GET/PATCH /users/me` — profile management
- `GET /users` — list org users (compliance_manager+ only)
- `PATCH /users/:userId/role` — role management (agency_admin+ only)
- `GET/PATCH /organizations/me` — org management
- `GET /dashboard/stats` — aggregate dashboard stats
- `GET /dashboard/activity` — recent activity feed
- `GET/POST /agents` — agent roster (requireAuth + per-method RBAC)
- `GET /agents/:id` — agent detail with compliance summary
- `PATCH /agents/:id` — update agent (compliance_manager+, audit-logged)
- `DELETE /agents/:id` — delete agent (agency_admin+, audit-logged)
- `GET /agents/:id/compliance-score` — calculated score
- `GET /notifications` — user notifications
- `GET /notifications/count` — unread badge count
- `GET /notifications/stream` — SSE real-time push stream
- `POST /notifications/read-all` — bulk mark read
- `PATCH /notifications/:id/read` — mark single read
- `GET /audit-log` — HIPAA audit trail (compliance_manager+ only)
- `POST /storage/uploads/request-url` — presigned upload URL (auth required)
- `GET /storage/public-objects/*` — public assets (no auth)
- `GET /storage/objects/*` — private files (auth + ACL required)

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

## Frontend Architecture

- **Lazy loading**: All page components use `React.lazy` + `Suspense` with skeleton fallback
- **Error boundary**: `ErrorBoundary` component wraps each page; global boundary wraps the router
- **Auth**: Clerk `ClerkProvider` → signs in/out users; `Show` components gate authenticated routes
- **Theme**: Navy sidebar (`221 50% 18%`), Medicare blue primary (`221 83% 43%`), cyan accent (`199 89% 48%`)

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
