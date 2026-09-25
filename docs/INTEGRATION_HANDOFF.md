# Integration Handoff — Inbound Lead Queue (GHL ⇄ Atlas ⇄ agencyBRIDGE)

**Audience:** the next Claude (or engineer) session picking this up.
**Companion doc:** [`inbound-lead-queue.md`](./inbound-lead-queue.md) (design + RTS definition).

> **UPDATE — §§2–5 below are now IMPLEMENTED.** The auth blocker, carrier-name
> resolution, Phase-2 presence, and the Atlas proxy have all landed. This doc
> is retained for the design rationale; the "remaining work" framing is
> historical. What's actually left is operational: set `LEAD_QUEUE_WEBHOOK_SECRET`
> (same value on agencyBRIDGE + Atlas), point GHL at the Atlas/agencyBRIDGE URL, and
> have the web app call `POST /api/queue/presence/heartbeat`. See the
> "Status / Notes for operators" section of the companion doc.

This document is the bridge between "the endpoints exist and are tested" and
"an inbound GoHighLevel call actually reaches a ready-to-sell agent in
production."

---

## 1. What already exists (don't rebuild it)

| Thing                                          | Location                                                | State                                      |
| ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| RTS eligibility + load-balanced ranking        | `artifacts/api-server/src/lib/leadQueue/readyToSell.ts` | ✅ done, unit-tested                       |
| `GET /api/queue/ready-to-sell`                 | `artifacts/api-server/src/routes/queue.ts`              | ✅ done                                    |
| `POST /api/queue/route-inbound`                | same                                                    | ✅ done, returns GHL-shaped `target_phone` |
| Presence injection point (`availableAgentIds`) | `findReadyToSellAgents()` arg                           | ✅ wired, currently unused                 |
| Integration tests                              | `__tests__/integration/lead-queue.test.ts`              | ✅ 13 passing                              |

The selection logic is **complete and correct**. The remaining work is
_plumbing_: authentication, carrier-id mapping, presence, and the GHL config.

---

## 2. ⚠️ THE BLOCKER: the endpoints are Clerk-authed

`routes/queue.ts` guards both endpoints with `requireAuth` +
`requirePermission("lead", "read")`. `requireAuth`
(`middlewares/requireAuth.ts`) expects a **Clerk session** (a logged-in
human in the web app). GoHighLevel — and a thin Atlas proxy — have **no Clerk
session** and cannot get one. As written, an external `POST /route-inbound`
from GHL gets a 401.

**Do not "fix" this by loosening `requireAuth` or removing the permission
gate.** That endpoint reveals agent phone numbers and is a routing decision —
it must stay authenticated.

### Recommended solution: a service-to-service auth path (mirror the dialer)

This codebase already solved exactly this problem for the masterBRIDGE
dialer. Copy that pattern rather than inventing a new one:

- The dialer receiver is mounted **outside** the Clerk-guarded `/api` router
  (see `app.ts`: `app.use(dialerEventsRouter)` is registered _before_
  `app.use("/api", router)`), and trust is established by an **HMAC
  signature** instead of a Clerk session — see
  `routes/dialerEvents.ts`, `lib/dialer/signature.ts`
  (`verifyWebhookSignature` / `resolveWebhookSecret`), and the per-tenant
  secret keyed by `orgId`.
- There is also an **RS256 service JWT** helper for outbound calls
  (`lib/dialer/serviceJwt.ts`, audience `mediflow:dialer:control`) if you
  prefer bearer tokens over HMAC.

**Concrete task:**

1. Add a sibling route, e.g. `routes/queuePublic.ts`, mounting
   `POST /api/queue/v1/route-inbound` **outside** `/api`'s Clerk guard
   (register it next to `dialerEventsRouter` in `app.ts`).
2. Authenticate it with the same HMAC scheme: caller sends
   `X-MB-Signature: t=<ts>,v1=<hmac>` over `${t}.${rawBody}`; resolve the
   per-org secret from a field in the body (`orgId`) exactly like
   `resolveWebhookSecret`. Reuse `verifyWebhookSignature` verbatim.
3. The body carries `orgId` explicitly (no session to derive it from), then
   `carrierId` (or `carrierName` — see §3), `contactState`/`contactId`.
4. Call the **same** `routeInboundLead()` — the logic is shared, only the
   auth wrapper differs.

The existing Clerk-authed `route-inbound` stays as-is for in-app/agent-desk
use (e.g. a "find me an agent" button). The new public one is for GHL/Atlas.

> If you'd rather not expose agencyBRIDGE publicly at all, the alternative is to
> keep Atlas as the **only** public surface and have Atlas hold the HMAC
> secret + call agencyBRIDGE's public endpoint. Same auth mechanism, one more hop.
> Decide with the requester; both are documented in `inbound-lead-queue.md`.

---

## 3. Carrier-id resolution (GHL won't know agencyBRIDGE's UUIDs)

`carriersTable.id` is an opaque per-org id. GHL knows a carrier as a **name**
("Aetna") or its own custom-field value, not agencyBRIDGE's id. Two options:

- **Map in the workflow:** hard-code the agencyBRIDGE `carrierId` per GHL
  pipeline/campaign (simplest if a campaign = one carrier).
- **Resolve server-side (recommended):** let the public endpoint accept
  `carrierName` and look it up: `carriers WHERE org_id = $org AND
lower(name) = lower($name) AND is_active`. Add this to the schema in
  `routes/queue.ts` (`carrierName` XOR `carrierId`). Note `carriersTable` has
  no unique index on `(org_id, name)` today — handle multiple/zero matches
  explicitly (400 with a clear message) rather than silently picking one.

`contactState` already handles the state side (GHL sends `{{contact.state}}`);
the route upper-cases and validates it to a 2-letter code.

---

## 4. Phase 2 — real-time presence (so it routes only to reachable agents)

Fully specified in `inbound-lead-queue.md` §Presence. Build order:

1. **Schema:** add `agent_presence` table in a new
   `lib/db/src/schema/presence.ts`, export from `schema/index.ts`, then
   `pnpm --filter @workspace/db run generate` to emit a migration into
   `lib/db/migrations`. **The CI has a "migration journal consistency" check
   — generate the migration with the toolchain, don't hand-write the SQL, or
   the journal hash won't match.** (Phase 1 added no migration on purpose.)
2. **Authoritative updates:** in `lib/dialer/handlers.ts`, on
   `call.in_progress` set the agent `on_call`; on `call.completed`/`failed`
   set `wrap`→`available`. The dial ticket carries `agentId`
   (`dialTicketsTable.agentId`).
3. **Heartbeat endpoint** for the web app (agent toggles Available/Away +
   periodic ping); each ping bumps `expires_at`.
4. **TTL sweep:** lean on the existing `dialer-reconcile` cron (every 15 min,
   `workers/dialerReconcile.ts`) or add a tiny sweeper to mark expired rows
   `offline`.
5. **Wire it in:** in the route, `SELECT agent_id FROM agent_presence WHERE
org_id=$org AND status IN ('available') AND expires_at > now()` and pass
   that array as `availableAgentIds` to `routeInboundLead()`. It already
   intersects + short-circuits on empty.

Acceptance: an agent on a live call is never returned by `route-inbound`.

---

## 5. The `atlas-call-router` repo

It is a stub (`backend/app/services/router.py` returns a hard-coded number).
Decide one of:

- **Retire it:** point GHL's HTTP-Request step directly at agencyBRIDGE's public
  endpoint (§2). Archive the repo. Least moving parts.
- **Keep as proxy:** replace the stub `route_call` with an HTTP call to
  agencyBRIDGE's public endpoint, signing with the shared HMAC secret. Useful
  only if you want a separate public surface / Railway edge.

Its README's GHL wiring block is the template; just swap the URL/body to
match §2 of [`inbound-lead-queue.md`](./inbound-lead-queue.md).

---

## 6. End-to-end verification checklist

1. Seed an org with: 1 active agent, FL license (active), current AHIP,
   passed cert for carrier "Acme". Seed a 2nd agent missing the cert.
2. `curl` the public `route-inbound` with a valid HMAC, `orgId`,
   `carrierName: "Acme"`, `contactState: "FL"` → returns agent #1's phone;
   agent #2 never appears.
3. Bad/absent signature → 401/403 (not 200).
4. Unknown carrier name → 400 with a clear message.
5. (Phase 2) Mark agent #1 `on_call` via a simulated `call.in_progress`
   event → `route-inbound` returns `no_agent_available` (or the next agent).
6. `pnpm run typecheck && pnpm test` green; new public-route + presence tests
   added alongside `lead-queue.test.ts`.

---

## 7. Pointers (files you'll touch)

- Endpoints / schemas: `artifacts/api-server/src/routes/queue.ts`
- Core logic (shared, don't fork): `artifacts/api-server/src/lib/leadQueue/readyToSell.ts`
- Auth to copy: `routes/dialerEvents.ts`, `lib/dialer/signature.ts`, `lib/dialer/serviceJwt.ts`
- App wiring (mount outside `/api`): `artifacts/api-server/src/app.ts`
- Carriers / agents / licenses / certs schema: `lib/db/src/schema/agents.ts`
- Dialer presence source: `lib/dialer/handlers.ts`, `lib/db/src/schema/dialer.ts`
- Test harness: `artifacts/api-server/src/__tests__/helpers/{testApp,testDb}.ts`
