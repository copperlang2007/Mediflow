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
- **Build**: esbuild (CJS bundle for API)

## Project Structure

```
artifacts/
  api-server/         Express 5 API, Clerk auth, all routes
  web-app/            React+Vite frontend
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
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec (ALWAYS fix `lib/api-zod/src/index.ts` to only have `export * from "./generated/api"` before running)
- `pnpm --filter @workspace/db run push` — push DB schema to PostgreSQL (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server

## Database Schema (8 files in lib/db/src/schema/)

- `core.ts` — organizations, users (roles: super_admin, agency_admin, compliance_manager, agent_support, viewer)
- `agents.ts` — agents, state_licenses, carrier_certifications, ahip_records, agent_documents
- `tasks.ts` — task_templates, task_instances
- `documents.ts` — documents
- `crm.ts` — contacts, leads, deals, activities
- `communications.ts` — conversations, messages
- `automations.ts` — automation_rules, automation_executions
- `notifications.ts` — notifications, audit_log
- `retention.ts` — retention_alerts

## API Routes (all prefixed /api)

- `GET /healthz` — health check
- `POST /auth/provision` — first-login user+org provisioning
- `GET/PATCH /users/me` — profile management
- `GET/PATCH /users/:id/role` — role management (admin)
- `GET/PATCH /organizations/me` — org management
- `GET /dashboard/stats` — aggregate dashboard stats
- `GET /dashboard/activity` — recent activity feed
- `GET/POST /agents` — agent roster
- `GET/PATCH/DELETE /agents/:id` — agent CRUD
- `GET /agents/:id/compliance-score` — calculated compliance score
- `GET /notifications` — user notifications
- `GET /notifications/count` — unread count
- `POST /notifications/read-all` — bulk mark read
- `PATCH /notifications/:id/read` — mark single read
- `GET /audit-log` — HIPAA audit trail (admin only)
- `POST/GET /storage/...` — object storage

## Frontend Pages

- `/` — Landing (public) / redirect to dashboard (signed-in)
- `/sign-in`, `/sign-up` — Clerk auth pages
- `/dashboard` — Agency overview with stats, charts, alerts
- `/agents` — Agent roster with search/filter
- `/licensing` — State license tracking (Task #2)
- `/certifications` — AHIP + carrier certs (Task #2)
- `/crm` — Contacts, leads, deals (Task #3)
- `/tasks` — Task management (Task #2)
- `/documents` — Document storage (Task #2)
- `/compliance` — Audit log + compliance
- `/settings` — Profile + organization settings

## Color Scheme (Tailwind v4 CSS vars)

- Background: `210 20% 98%` (off-white)
- Foreground: `222 47% 11%` (near-black navy)
- Sidebar: `221 50% 18%` (deep navy)
- Primary: `221 83% 43%` (Medicare blue)
- Accent: `199 89% 48%` (cyan)
- Charts: blue, cyan, green, amber, red

## Important Notes

- **Never** use `console.log` in server code — use `req.log` (pino-http) or `logger` from `src/lib/logger.ts`
- Clerk proxy path is `/api/__clerk`; set `VITE_CLERK_PROXY_URL` in env
- After any schema changes, run `pnpm --filter @workspace/db run push`
- After any OpenAPI spec changes, run `pnpm --filter @workspace/api-spec run codegen` then fix `lib/api-zod/src/index.ts`
- The `api-zod/src/index.ts` file must ONLY have `export * from "./generated/api"` — codegen doesn't regenerate it but the clean step may delete `./generated/types`, so the old line must be removed manually

## Environment Variables

Set via Replit Secrets:
- `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` — Clerk backend auth
- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk frontend auth
- `VITE_CLERK_PROXY_URL` — Clerk proxy URL for frontend
- `DATABASE_URL` — PostgreSQL connection string
- `DEFAULT_OBJECT_STORAGE_BUCKET_ID` — Replit object storage
- `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS` — storage paths
