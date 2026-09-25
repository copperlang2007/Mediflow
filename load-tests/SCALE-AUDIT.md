# agencyBRIDGE scale-risk audit

Static read-through of the API server (`artifacts/api-server/src`), DB schema
(`lib/db/src/schema`), and migrations (`lib/db/migrations`). The goal is to
flag what breaks at 10x / 100x current scale.

**Out of scope (already fixed in prior rounds, not re-reported):** list-endpoint
pagination, sequence bulk-enroll N+1, bulk-tag N+1, `contacts.phone` index.

Findings are ordered by severity. Each lists `file:line`, the risk at scale,
and a recommended fix. **No code is changed in this PR** — this PR delivers
load-test infra + this audit only. Items marked **[BUG]** are genuine
correctness/behaviour issues worth a separate follow-up fix PR.

---

## High severity

### H1. `message_threads.contact_id` has no index

- **Where:** schema `lib/db/src/schema/communications.ts:32` (column is a FK
  only — Postgres does **not** auto-create an index for FK columns).
- **Hot paths that filter on it:**
  - `routes/contacts.ts:515-532` — `GET /contacts/:id/threads`
    (`WHERE message_threads.contact_id = ?` + count).
  - `routes/contacts.ts:586-593` — `GET /contacts/:id/messages`
    (`innerJoin message_threads` then `WHERE message_threads.contact_id = ?`).
  - `routes/webhooks.ts:163-172` — inbound SMS thread lookup on every Twilio
    webhook (`WHERE contact_id = ? AND channel = 'sms'`).
- **Risk at scale:** every contact-detail open and every inbound SMS does a
  sequential scan of `message_threads`. At 100x (millions of threads) this is
  a multi-hundred-ms to multi-second scan. The webhook path is the dangerous
  one — it pushes p95 toward Twilio's 10s timeout, triggering retries that
  multiply the load.
- **Recommended fix:** add
  `CREATE INDEX message_threads_contact_id_channel_idx ON message_threads (contact_id, channel)`.
  The composite serves both the contact-detail queries (leading `contact_id`)
  and the webhook's `(contact_id, channel)` lookup.

### H2. Commission report has no index for the period filter

- **Where:** `routes/commissions.ts:651-672` — `GET /agents/:id/commissions`.
  The line-items query filters
  `orgId AND writingAgentId [AND type] [AND periodStart >= ? AND periodEnd <= ?]`.
- **What exists:** `commission_line_items_writing_agent_idx` on
  `(orgId, writingAgentId)` (schema `commissions.ts:200`) and
  `commission_line_items_statement_idx` on `(statementId)`.
- **Gap:** no index covers `periodStart` / `periodEnd`. With a period filter
  the planner uses `(orgId, writingAgentId)` then filters the date range in a
  heap scan. For a productive agent with thousands of line items across years,
  the per-period report degrades badly.
- **Risk at scale:** "heavy query" called out in the task brief. At 100x line
  items per agent the report blows the read SLO (p95 < 500ms).
- **Recommended fix:** extend the index to
  `(orgId, writingAgentId, periodStart)` so the date lower-bound is satisfied
  by the index. `periodEnd` stays a residual filter — acceptable since
  `periodStart`/`periodEnd` are tightly correlated.

### H3. `pg.Pool` has no `max`, no `statement_timeout`, no idle timeout

- **Where:** `lib/db/src/index.ts:13` —
  `new Pool({ connectionString: process.env.DATABASE_URL })`.
- **Problem:** `node-postgres` defaults to `max: 10` connections and **no
  statement timeout**. There is no `statement_timeout`, no
  `idleTimeoutMillis`, no `connectionTimeoutMillis`.
- **Risk at scale:**
  - A single slow/runaway query (e.g. an unindexed commission report, H2) can
    hold a pooled connection indefinitely; with the default pool of 10, a
    handful of slow requests starve the entire API. No statement timeout means
    a pathological query runs until it finishes or the client disconnects.
  - At 10x request volume the implicit `max: 10` is far too small and requests
    queue waiting for a connection; at 100x the API is connection-bound long
    before Postgres itself is.
  - pg-boss opens its **own** pool against the same database — the two are not
    coordinated, so total connections must be sized against Postgres
    `max_connections` jointly.
- **Recommended fix:** configure the pool explicitly:
  `max` sized to the deployment (e.g. 20-30 per API instance, reconciled with
  Postgres `max_connections` and pg-boss's pool),
  `idleTimeoutMillis: 30000`,
  `connectionTimeoutMillis: 5000`, and a
  `statement_timeout` (via `options: '-c statement_timeout=10000'` on the Pool
  config, or `SET statement_timeout` per session) so no single query can run
  unbounded. Consider a separate, smaller pool or PgBouncer in front for many
  API instances.

---

## Medium severity

### M1. Weekly automation sweep runs unbounded scans with a correlated subquery

- **Where:** `workers/weeklyAutomationSweep.ts:300-313` — `scanContactNoActivity`.
- **Problem:** the query selects **every** matching contact for an org with
  **no `LIMIT`**, and the predicate is a correlated
  `NOT EXISTS (SELECT 1 FROM activities WHERE contact_id = ... AND created_at >= cutoff)`
  subquery. Sibling scans (`scanTaskOverdue` at line ~335, `scanLicenseExpiring`,
  `scanCertExpiring`) are similarly unbounded.
- **Risk at scale:** for a 100x org (hundreds of thousands of active contacts)
  this is a large unindexed-ish scan executed per org per sweep. The result
  set is then iterated row-by-row, each doing a `claimAndEnqueue` round-trip
  (`weeklyAutomationSweep.ts:319-329`) — so a big org produces a long serial
  loop of inserts + enqueues that holds the worker for minutes.
- **Recommended fix:** (1) page the scans (`LIMIT`/keyset) and process in
  batches; (2) ensure `activities (contact_id, created_at)` is indexed so the
  `NOT EXISTS` is index-only (see M2); (3) batch the `claimAndEnqueue` inserts
  instead of one round-trip per row.

### M2. `activities` lacks a `(contact_id, created_at)` composite index

- **Where:** schema `lib/db/src/schema/crm.ts:283-284` — only
  `activities_org_id_created_at_idx` and `activities_contact_id_idx` (single
  column) exist.
- **Hot paths:**
  - `routes/contacts.ts:367` — `GET /contacts/:id/activities`:
    `WHERE contact_id = ? AND org_id = ? ORDER BY created_at DESC`.
  - The `NOT EXISTS` correlated subquery in M1
    (`WHERE contact_id = ... AND created_at >= cutoff`).
- **Risk at scale:** the single-column `activities_contact_id_idx` finds the
  contact's rows but the `ORDER BY created_at DESC` then needs a sort. For a
  long-lived contact with thousands of activities this sort is per-request
  overhead, and the M1 subquery cannot be satisfied index-only.
- **Recommended fix:** add
  `CREATE INDEX activities_contact_id_created_at_idx ON activities (contact_id, created_at DESC)`
  and drop the now-redundant single-column `activities_contact_id_idx`.

### M3. Commission statement parse does synchronous bulk insert in the request handler

- **Where:** `routes/commissions.ts:477-489` —
  `POST /commissions/statements/:id/parse`. The handler parses the CSV and
  inserts line items in 200-row chunks **inline**, looping
  `await db.insert(...)` per chunk before responding.
- **Risk at scale:** a 50MB CSV (the multer limit, `commissions.ts:54`) can
  hold tens of thousands of rows. At 100s of rows the chunked insert loop is
  seconds of work inside the HTTP request — it blows the write SLO and ties up
  a connection (compounding H3). The reconcile step already has an async path
  (`?async=true`, `commissions.ts:515`); parse does not.
- **Recommended fix:** move parse to a pg-boss job (a `parse-commission-
  statement` job mirroring `reconcile-commission-statement`), have the route
  enqueue and return `202`/`{ queued: true }`, and let the client poll
  statement status. The double-upload design (file re-sent to `/parse`) should
  be revisited alongside this — see M4.

### M4. Reconcile worker is row-by-row inside one long transaction (latent N+1)

- **Where:** `workers/reconcileCommissionStatement.ts:316-505` —
  `reconcileStatement` loops every line item of a statement and, **per item**,
  issues separate queries: `matchContact` (1-2 selects, lines 84/119),
  `resolveWritingAgent` (up to 2 selects, lines 133/141), `computeSplits`
  (a hierarchy select, `commissionSplits.ts:76`), plus the per-item
  `update` and `upsertPayout`.
- **Risk at scale:** a statement with N line items issues O(N) × ~5 queries,
  all inside a **single transaction holding a `pg_advisory_xact_lock`**
  (`reconcileCommissionStatement.ts:283-284`). For a large carrier statement
  (10k+ rows) this transaction runs for many seconds-to-minutes, holding the
  advisory lock and a connection the whole time, and serializing all reconciles
  of that statement. At 100x statement size it risks long lock holds and, with
  H3's missing `statement_timeout`, an effectively unbounded transaction.
- **Recommended fix:** batch the matching — pre-load all candidate contacts /
  hierarchies for the statement's member-ids/agents in a few set-based queries
  before the loop, and resolve in memory; batch the line-item updates and
  payout upserts. If a statement is genuinely huge, chunk the reconcile across
  jobs. Correctness logic (idempotency snapshots) can stay; only the access
  pattern needs to change.

### M5. Per-create automation enqueue path is fire-and-forget but unthrottled

- **Where:** `routes/contacts.ts:201-231` — every `POST /contacts` enqueues a
  `run-automation-rules` job; `routes/contacts.ts:308` does the same on status
  change.
- **Observation (not a bug):** the enqueue is correctly `.catch()`-handled and
  non-blocking. But at scale the `run-automation-rules` worker
  (`batchSize: 5, localConcurrency: 5` per node, `jobs.ts:298-302`) becomes the
  bottleneck: each job loads all active rules for the org
  (`runAutomationRules.ts:371`) and enriches context with extra selects.
- **Risk at scale:** under a bulk-import or a contact-create spike, the
  automation queue depth grows faster than 5-wide workers can drain it,
  delaying time-sensitive automations (welcome SMS, task creation). The
  bulk-status path (`POST /contacts/bulk` `set_status`,
  `routes/contacts.ts:692`) notably does **not** enqueue per-contact
  automations — so bulk status changes silently skip `contact_status_changed`
  rules. Flagged as **[BUG]** below (B1).
- **Recommended fix:** scale `run-automation-rules` concurrency with the
  number of worker nodes, and add a queue-depth metric/alert. Consider a
  dedicated higher-concurrency worker node for automation evaluation since the
  work is cheap and CPU-bound.

---

## Low severity

### L1. `GET /contacts/:id/messages` reports a misleading `total`

- **Where:** `routes/contacts.ts:596` — returns
  `{ messages: rows, total: rows.length }`. `total` is just the page size, not
  the true message count. Also the query has a `limit` but **no `offset`**, so
  there is no way to page past the first N messages.
- **Risk at scale:** a contact with more than `limit` (default 100, cap 500)
  messages silently truncates with no pagination affordance; the client sees a
  `total` that equals the page and assumes it has everything.
- **Recommended fix:** add `offset` support and a real `count(*)` (mirroring
  `/contacts/:id/threads` which already does this correctly). Flagged
  **[BUG]** as B2 — it is a correctness issue, not just perf.

### L2. Several sub-resource list routes are unbounded (no limit)

- **Where:**
  - `routes/contacts.ts:610` — `GET /contacts/:id/tasks`: `select ... orderBy
    createdAt DESC` with **no limit**.
  - `routes/contacts.ts:625-631` — `GET /contacts/:id/enrollments`: joined
    select with **no limit**.
  - `routes/commissions.ts:674-683` — the payouts half of
    `GET /agents/:id/commissions`: `select ... orderBy periodStart DESC` with
    **no limit**.
  - `routes/dashboard.ts:47` — `db.select().from(agentsTable).where(orgId)`:
    loads **every** agent in the org with no limit.
- **Risk at scale:** these are bounded by "rows per contact/agent/org" rather
  than user input, so they are lower risk than an unbounded global list — but
  a contact with thousands of tasks, or a 100x org with thousands of agents,
  produces large unpaginated responses and the associated memory/serialization
  cost. The dashboard agents scan is the most exposed (per-org).
- **Recommended fix:** apply `safeLimit`/`safeOffset` (already used elsewhere
  in these same files) for consistency, and have the dashboard count agents
  rather than `select *` when it only needs aggregates.

### L3. List + count run as two separate full scans

- **Where:** `routes/contacts.ts:145-148` — `GET /contacts` runs the page
  query and a `count(*)` over the **same** `WHERE` (including the `ilike`
  search) as two separate statements via `Promise.all`.
- **Risk at scale:** the `count(*)` cannot use `LIMIT`, so on a large org with
  a search term it scans every matching row just to produce `total`. At 100x
  this count is often the slower of the two queries.
- **Recommended fix:** for the common case, either drop the exact total in
  favour of "has next page" (fetch `limit + 1`), or use an approximate count
  for unfiltered listings. Keep the exact count only when a filter is narrow.
  Low priority since pagination itself is already bounded.

### L4. Per-user rate limiter is in-memory (not shared across instances)

- **Where:** `app.ts:112-125` — `express-rate-limit` with the default
  in-memory store, keyed by Clerk `userId`.
- **Risk at scale:** with multiple API instances behind a load balancer the
  100 req/min limit is enforced **per instance**, so the effective limit is
  `100 × instanceCount`. Not a hot-path latency risk, but it means the rate
  limit (a load-shedding control) is weaker than it appears under horizontal
  scaling.
- **Recommended fix:** back the limiter with a shared store (Redis) so the
  limit is global. Note this is also a correctness gap for abuse protection.

---

## Genuine bugs found — for a follow-up fix PR (NOT fixed here)

- **B1.** `POST /contacts/bulk` with `action: "set_status"`
  (`routes/contacts.ts:692-695`) updates contact status in bulk but does
  **not** enqueue `run-automation-rules` for `contact_status_changed` — unlike
  the single-contact `PATCH /contacts/:id` path (`routes/contacts.ts:307`).
  Bulk status changes therefore silently skip status-change automations
  (welcome sequences, task creation, notifications). Same gap for the bulk
  `assign_agent` action vs. any assignment-triggered rules. **Behavioural bug,
  worth a fix PR.**

- **B2.** `GET /contacts/:id/messages` (`routes/contacts.ts:596`) returns
  `total: rows.length` (the page size, not the real count) and supports no
  `offset`, so a contact with more messages than the limit silently truncates
  with a `total` that misrepresents the data. Inconsistent with the adjacent
  `/threads` route which paginates correctly. **Correctness bug.**

- **B3.** (Minor) `routes/commissions.ts:370-384` — `POST /commissions/
  statements` returns the row plus a `_hint` telling the client to re-upload
  the file to `/parse` because blob storage "is out of scope." The trailing
  comment block (lines 380-384) is dead narrative and the design forces the
  client to upload the same potentially-50MB file twice. Not a runtime bug,
  but a real design wart worth resolving when M3 is addressed (wire up object
  storage so parse reads the stored blob instead of a re-upload).

---

## Summary of recommended index additions

| Index | Table | Serves |
| --- | --- | --- |
| `(contact_id, channel)` | `message_threads` | H1 — contact-detail + Twilio webhook |
| `(org_id, writing_agent_id, period_start)` | `commission_line_items` | H2 — commission report |
| `(contact_id, created_at DESC)` | `activities` | M2 — activities list + sweep subquery |

Plus pool/timeout configuration on `lib/db/src/index.ts` (H3) and pagination /
batching changes (M1, M3, M4, L2). None of these are applied in this PR.
