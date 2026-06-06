# Inbound Lead Queue — smart routing by "ready to sell" carrier × state

## Why this lives in MediFlow (and not in `atlas-call-router`)

The `atlas-call-router` repo was evaluated as a foundation for the inbound
lead queue. It is a ~40-line FastAPI scaffold whose "router" returns a
hard-coded phone number:

```python
# atlas-call-router/backend/app/services/router.py
async def route_call(self, from_number, ghl_contact_state=None, carrier_id=None):
    return {"status": "routed", "target_phone": "+15551234567", "target_user_id": "test-user"}
```

It has no agent data, no database tables, no queue, and no notion of who is
allowed to sell. The only genuinely reusable parts were the _shape_ of the
GHL integration (`{contact_state, carrier_id} -> {target_phone}`) and the
Railway deploy skeleton.

Every piece of data needed to answer _"is this agent ready to sell this
carrier in this state, right now?"_ already lives in MediFlow:

| Question                             | Source of truth (Postgres) |
| ------------------------------------ | -------------------------- |
| Is the agent employable?             | `agents.status`            |
| Licensed in the lead's state?        | `state_licenses`           |
| AHIP-current?                        | `ahip_records`             |
| Certified with the carrier?          | `carrier_certifications`   |
| What's the agent's current workload? | `leads.assigned_agent_id`  |

Replicating those tables into Atlas and keeping them in sync would create a
stale-data hazard on the single most compliance-sensitive decision in the
business (letting an unlicensed/uncertified agent take a call). So the queue
is built **in MediFlow**, where the data is authoritative, and Atlas is
reduced to (optionally) a thin proxy — or retired entirely, with GoHighLevel
pointed straight at the MediFlow endpoint below.

## "Ready to sell" (RTS) definition

An agent is RTS for a `(carrier, state)` pair when **all** hold:

1. `agents.status = 'active'`.
2. A `state_licenses` row for the state with `status = 'active'` and a
   non-expired `expiry_date` (NULL expiry = none on file = treated valid).
3. _(Medicare path, default on)_ An `ahip_records` row for the certification
   year with status `passed`/`waived`. Disable via `requireAhip=false` for
   non-MA products.
4. A `carrier_certifications` row for the carrier + certification year with
   status `passed`/`waived` and a non-expired `expiry_date`.

Each gate is a correlated `EXISTS` subquery against the agent row, so the
result is one row per eligible agent (no join fan-out).

Implementation: [`lib/leadQueue/readyToSell.ts`](../artifacts/api-server/src/lib/leadQueue/readyToSell.ts).

## "Smart" ordering

Among eligible agents, the queue ranks by **current open-lead load
ascending** (`leads` in status `new`/`contacted`/`qualified`), tie-broken on
`lastName`. The lightest-loaded eligible agent is offered the next inbound —
a self-balancing distribution rather than always hitting whoever sorts first.

## Routing claims — audit, load balancing, and idempotency

`route-inbound` is **not** a read-only suggestion: every decision writes a
`lead_routing` row (`lib/db/src/schema/leadRouting.ts`). That row does three
jobs:

- **Audit trail** — who was routed where, for which carrier × state, the
  candidate-pool size, and which channel (`in_app` / `public`) asked. This is
  the compliance record that an inbound went to a ready-to-sell agent.
  `no_agent_available` decisions are recorded too (coverage/staffing signal).
- **In-flight load** — recent `routed` claims count toward an agent's load
  alongside open leads (window `LEAD_QUEUE_INFLIGHT_SECONDS`, default 120s), so
  a burst of inbounds that haven't yet produced assigned-lead rows still
  spreads across the pool instead of stacking on whoever sorts first.
- **Idempotency** — a repeat route for the same `(orgId, contactId, carrier)`
  inside `LEAD_QUEUE_IDEMPOTENCY_SECONDS` (default 60s) replays the original
  decision and writes no second row, so GoHighLevel's at-least-once webhook
  retries don't route one contact to two agents. The response carries
  `routingId` and `idempotent: true` on a replay.

Note: this balances and dedupes via committed claims; two *exactly*-simultaneous
routes can still tie on load (no row locks, by design). The idempotency key and
the in-flight window keep that window small and self-correcting.

## API

Both endpoints require auth and `lead:read`.

### `GET /api/queue/ready-to-sell`

Query: `stateCode`, `carrierId`, `certificationYear?`, `requireAhip?`.
Returns the ranked eligible pool:

```json
{
  "data": [
    {
      "agentId": "...",
      "firstName": "...",
      "lastName": "...",
      "phone": "+1...",
      "npn": "...",
      "openLeadCount": 0
    }
  ],
  "total": 1,
  "stateCode": "FL",
  "carrierId": "...",
  "certificationYear": 2026
}
```

### `POST /api/queue/route-inbound`

Body: `{ carrierId, contactState?, contactId?, certificationYear?, requireAhip? }`.
Picks the single best agent. Returns the camelCase decision **plus** the flat
`target_phone` / `target_user_id` fields the old Atlas service produced, so
the GHL "Connect Call" step can consume it unchanged:

```json
{
  "status": "routed",
  "stateCode": "FL",
  "carrierId": "...",
  "candidatePool": 3,
  "agent": { "agentId": "...", "phone": "+1..." },
  "target_phone": "+1...",
  "target_user_id": "agent_..."
}
```

`status` is `no_agent_available` (and `target_phone: null`) when the pool is
empty — the workflow branches on it (voicemail, callback, overflow team).

GHL wiring (replaces the Atlas HTTP-Request step):

```
HTTP Request → POST https://<mediflow-host>/api/queue/route-inbound
  Body: {"contactState": "{{contact.state}}", "carrierId": "<carrier-id>"}
Connect Call (IVR) → Dynamic Number = {{http_response.target_phone}}
```

## Presence — the real-time "available right now" feed (recommended)

RTS answers _"may this agent sell?"_ It does **not** answer _"is the agent at
their desk this second?"_ `findReadyToSellAgents()` accepts an optional
`availableAgentIds` set; the eligible pool is intersected with it before
ranking. The remaining question is where that set comes from.

**Recommendation: derive presence from the masterBRIDGE dialer's call-state
events — the telephony system of record — backed by a Postgres presence row
with a heartbeat TTL. No Redis.** Rationale:

- The dialer already streams authoritative, signed call-lifecycle events into
  MediFlow (`call.initiated`/`in_progress`/`completed`/`failed`, see
  `lib/dialer/handlers.ts`). It _knows_ when an agent is on a call — far more
  accurate than a browser "I'm available" toggle that goes stale the moment a
  call connects. This is the most accurate real-time signal available.
- MediFlow is uniformly Postgres-backed (pg-boss jobs, SSE fan-out); there is
  no Redis in the stack. Introducing one for presence would add an operational
  dependency for data that fits a single small table.

### Proposed design (Phase 2)

1. **`agent_presence` table** (one row per agent): `status`
   (`available` | `on_call` | `wrap` | `away` | `offline`), `last_event_id`,
   `last_seen_at`, `expires_at`.
2. **Authoritative updates from dialer events** — extend the handlers so
   `call.in_progress` ⇒ `on_call`, `call.completed`/`call.failed` ⇒ `wrap`
   then `available`. This is the accurate "busy/free" truth.
3. **Heartbeat for the gap the dialer can't see** — the web app posts a
   lightweight check-in (agent toggles Available/Away + a periodic ping) so we
   know an agent is _logged in and idle_ vs. _stepped away_. Each heartbeat
   pushes `expires_at` forward.
4. **TTL safety net** — an agent whose `expires_at` has lapsed is treated as
   `offline`, so a dropped "offline"/"completed" event can't pin someone
   "available" forever. This mirrors the existing missed-webhook recovery
   pattern (`dialer-reconcile`, every 15 min).
5. The route loads currently-available agent ids and passes them as
   `availableAgentIds`; `route-inbound` then only ever routes to an agent who
   is both RTS and reachable. Queue/UI updates push over the existing SSE
   channel.

Until Phase 2 lands, omit `availableAgentIds` and the queue ranks the full
eligible pool (load-balanced by open-lead count), which is already correct —
just not presence-aware.

## Status

- **Phase 1:** RTS eligibility + load-balanced ranking + `ready-to-sell` /
  `route-inbound` endpoints + tests. ✅
- **Phase 2:** `agent_presence` table + read-time TTL, dialer-event presence
  updates (`on_call`/`wrap`), `POST /api/queue/presence/heartbeat`, and the
  `availableOnly` filter wired into routing (with a "presence not adopted ⇒
  don't filter" fallback). Plus the HMAC-authed public route
  `POST /api/queue/v1/route-inbound` for GHL/Atlas and server-side
  carrier-name resolution. ✅
- **Phase 3:** `atlas-call-router` rewired as a thin signed proxy to the
  public route. ✅ (Atlas repo PR.)

### Notes for operators

- **Secrets:** the public route is authenticated by `LEAD_QUEUE_WEBHOOK_SECRET`
  (or per-org `LEAD_QUEUE_WEBHOOK_SECRET_<ORGID>`). Set the same secret on the
  Atlas side. Fail-closed: an unset secret rejects all calls.
- **Verifying the signature contract:** the proxy and MediFlow must HMAC the
  same bytes or every call is rejected. Use the reference signer to check
  parity and smoke-test the live endpoint — it mirrors the server verifier
  (`lib/dialer/signature.ts`) exactly:

  ```bash
  # Parity: sign the EXACT body the proxy sends, with a fixed timestamp, then
  # compare the printed v1 to the proxy's for the same (t, body).
  pnpm --filter @workspace/scripts lq:sign -- \
    --secret "$LEAD_QUEUE_WEBHOOK_SECRET" --org org_123 --t 1780000000 \
    --body '{"orgId":"org_123","carrierName":"Acme Health","contactState":"FL"}'

  # Smoke: POST a correctly-signed request to the live endpoint.
  pnpm --filter @workspace/scripts lq:sign -- \
    --org org_123 --carrier-name "Acme Health" --state FL \
    --url https://<host>/api/queue/v1/route-inbound --send
  ```

  A mismatched `v1` for the same `(t, body)` means the proxy is signing
  different bytes — almost always a re-serialized body (key order / whitespace)
  rather than the exact bytes it transmits.
- **TTL tuning:** `LEAD_QUEUE_HEARTBEAT_TTL_SECONDS` (default 90) and
  `LEAD_QUEUE_DIALER_TTL_SECONDS` (default 900). TTL is enforced at read time —
  no sweeper job. A cosmetic "flip expired rows to offline" cron can be added
  later but is not required for correctness.
- **Presence semantics:** only a heartbeat sets `available`. Dialer events only
  ever remove an agent from the pool (`on_call` during a call, `wrap` after).
  This biases fail-closed — a missed terminal event leaves the agent excluded,
  not wrongly routable.
