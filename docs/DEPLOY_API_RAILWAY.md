# Deploying the MediFlow API on Railway (production)

The `api-server` is a **long-running process**, not a serverless function: it
runs pg-boss cron jobs in-process (`startWorkers()` — license/cert/AHIP expiry,
automation sweep, retention, weekly compliance, the dialer reconcile sweep),
holds SSE streams, and keeps a persistent Postgres pool. It must run on a
process host (Railway, Render, Fly) — **not** Vercel serverless. (That mismatch
is why the `mediflow-api-server` Vercel project errors on every PR; see step 5.)

`railway.json` at the repo root encodes the build/migrate/start contract:

> **This manifest is shared by every Railway service built from this repo,
> including this production one.** Its `preDeployCommand` ends in
> `predeploy:seed`, which runs the demo seeder — a script that plants a
> hardcoded `super_admin` (`sarah@insureitall.example`), a fixed demo org,
> users, agents, carriers, and contacts carrying fake `999-XX-XXXX` SSNs.
>
> That step is gated: `scripts/src/predeploy-seed.ts` runs the seed only when
> `DEMO_MODE=true`, and `seed-demo.ts` itself refuses to run under
> `NODE_ENV=production` or with an explicit `PHI_ENCRYPTION_KEY` unless
> `DEMO_MODE=true`. Following this doc (`NODE_ENV=production`, no `DEMO_MODE`)
> therefore skips the seed entirely.
>
> Do **not** set `DEMO_MODE=true` on a service holding real data. `seedAll()`
> is not transactional, so a partially-completed seed leaves rows behind that
> the resume branch will finish on the next deploy rather than flag.


| Field | Value | Why |
| --- | --- | --- |
| build | `pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server build` | esbuild bundle → `artifacts/api-server/dist/index.mjs` |
| preDeployCommand | `pnpm --filter @workspace/db run migrate && pnpm --filter @workspace/scripts run predeploy:seed` | apply drizzle migrations before the new version goes live, then seed demo data **only on a demo service** (see the warning below) |
| startCommand | `pnpm --filter @workspace/api-server run start` | `node --enable-source-maps dist/index.mjs` |
| healthcheckPath | `/api/healthz` | liveness probe (200 `{status:"ok"}`, no DB dependency) |
| numReplicas | `1` | **important** — see the singleton caveat below |

## Steps

1. **Create the service** — Railway → New Project → Deploy from GitHub →
   `copperlang2007/mediflow`. Leave **Root Directory** empty (`/`): the repo is
   a pnpm workspace and `railway.json` + the build run from the root.
2. **Add Postgres** — Railway → New → Database → PostgreSQL. It exposes
   `DATABASE_URL`.
3. **Set environment variables** (Service → Variables). `PORT` is injected by
   Railway automatically — do **not** set it. The server throws on boot if
   `PORT` is missing, so let Railway provide it.

   Required:
   - `NODE_ENV=production`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}` (reference the Postgres service)
   - `CLERK_SECRET_KEY=…` (server-side Clerk key; required when not in demo mode)
   - `LEAD_QUEUE_WEBHOOK_SECRET` (or per-org `LEAD_QUEUE_WEBHOOK_SECRET_<ORGID>`)
     — auth for the public inbound-route endpoint (see `INTEGRATION_RUNBOOK.md`)

   Conditional (set the ones your deployment uses):
   - Dialer integration: `DIALER_WEBHOOK_SECRET` + the masterBRIDGE service-JWT /
     JWKS settings the dialer client reads.
   - AI transcript parsing: the MediFlow AI provider key(s).
   - Observability / storage: `SENTRY_DSN`, GCS storage credentials, etc.
   - `NIXPACKS_NODE_VERSION=24` if Nixpacks doesn't pick Node 24 from the root
     `package.json` `engines` (the repo targets Node 24.x).

   Do **not** set `WEB_STATIC_DIR`: keep the web-app on Vercel (static SPA) and
   run this service API-only. (Set it only if you intend one service to serve
   both the API and the built SPA.)
4. **Deploy.** Railway runs build → `preDeployCommand` (migrate, then the demo-seed gate) → start, then
   probes `/api/healthz`. A green healthcheck means the process booted; readiness
   (`/api/readyz`, which also verifies pg-boss workers are live + a DB `SELECT 1`)
   is available if you wire a load-balancer readiness gate.
5. **Stop the Vercel API deploys.** In Vercel, project `mediflow-api-server` →
   Settings → Git → Disconnect (or set Ignored Build Step to `exit 0`). The API
   does not belong on Vercel; this clears the recurring red ✗ on every PR. Leave
   `mediflow-web-app` and `mediflow-mockup-sandbox` on Vercel — those are static
   builds and deploy correctly there.

## Singleton caveat (read before scaling)

The cron schedules and workers run **inside the web process** via
`startWorkers()`. Keep `numReplicas: 1`. pg-boss guards singleton/cron jobs via
the database, but every replica that calls `startWorkers()` adds scheduling
pressure and risks double-fires. If you need to scale the HTTP tier, split a
**dedicated worker service** (one replica) that runs `startWorkers()` and run
the web tier without it, rather than scaling the combined process.

## Verifying after deploy

```bash
# Liveness (should be 200 {"status":"ok"}):
curl -sS https://<railway-app-host>/api/healthz

# Readiness (200 once workers booted + DB reachable; 503 during startup):
curl -sS -o /dev/null -w '%{http_code}\n' https://<railway-app-host>/api/readyz

# Full contract smoke (see INTEGRATION_RUNBOOK.md Phase 4):
LEAD_QUEUE_WEBHOOK_SECRET="$LQ_SECRET" \
pnpm --filter @workspace/scripts lq:sign -- \
  --org "$ORG_ID" --carrier-name "Acme Health" --state FL \
  --url "https://<railway-app-host>/api/queue/v1/route-inbound" --send
```
