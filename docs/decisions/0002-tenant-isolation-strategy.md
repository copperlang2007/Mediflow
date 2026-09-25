# 2. Tenant isolation: application enforcement with a static guard, not RLS (yet)

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

agencyBRIDGE is multi-tenant and stores PHI-adjacent data — Medicare IDs
(encrypted, with an HMAC blind index), dates of birth, health conditions,
complaint records.

Tenant separation is enforced in application code. Every route that touches an
org-scoped table either filters on `authReq.orgId` directly or validates
ownership first through a helper it passes `authReq.orgId` to. A review of all
48 route modules found this correct in every handler, and a cross-org write
guard test covers the representative case.

But it is a convention. Across 36 migrations there is no `ENABLE ROW LEVEL
SECURITY` and no `CREATE POLICY`. One forgotten `WHERE org_id` in one future
route is a cross-tenant PHI disclosure with no database backstop. For
HIPAA-adjacent data this is the highest-severity architectural finding in the
codebase.

## Decision

Ship a **static tenant-isolation guard** now
(`src/__tests__/guards/tenant-isolation.test.ts`), and treat Postgres RLS as a
sequenced follow-up rather than a same-change fix.

The guard parses every route module, slices it into route handlers, resolves
table identifiers against each file's actual `@workspace/db` imports, and fails
any handler that touches an org-scoped table without establishing tenancy.
Tables are org-scoped **by default** — only an explicit allowlist of genuinely
global tables is exempt — so a newly added tenant table is guarded without
anyone remembering to opt in. A genuinely org-agnostic handler must carry an
inline `// tenant-isolation-exempt: <reason>` annotation, which lands in the
diff and gets reviewed like any other security decision.

The guard was validated by mutation: removing the org filter from
`routes/templates.ts` makes it fail with that exact file and line; restoring
the filter makes it pass.

## Why not RLS in this change

RLS here is not a migration file, it is a data-access refactor:

- The application connects as the table owner, which **bypasses RLS** unless
  `FORCE ROW LEVEL SECURITY` is set on every table.
- Policies must key on a session variable (`app.current_org_id`) set per
  request. The app uses a single module-level Drizzle instance over a shared
  `pg.Pool`; there is no per-request connection or transaction scope to set
  that variable on. Introducing one touches every one of the ~48 route modules
  and all 22 background workers.
- A policy that reads an unset session variable and falls back to permissive is
  not a backstop at all — it is the appearance of one, which is worse than
  none because it stops people looking.

Doing that refactor properly is a multi-day change with real regression risk
across a suite of 991 tests. Shipping a guard that demonstrably catches the
failure mode today is worth more than a policy that no-ops.

## Alternatives considered

- **RLS with a permissive fallback when the GUC is unset.** Rejected as
  security theater — see above.
- **A separate low-privilege application role plus `FORCE RLS`.** This is the
  correct end state and is what the follow-up should build. It still requires
  the per-request session-variable plumbing, so it does not shorten the work.
- **Runtime assertion in a Drizzle query hook.** Attractive, but Drizzle offers
  no stable pre-execute hook to inspect a built `WHERE` clause, and pattern
  matching compiled SQL at runtime costs latency on every query.

## Tradeoffs

- The guard is static analysis over source text. It proves an org identifier is
  referenced in the handler; it does not prove the reference is *correct*. It
  catches omission, not misuse — which is the failure mode that actually
  occurs.
- Handler granularity means a file with two routes, where one is scoped and one
  is not, is caught, but a single handler doing two queries where only one is
  scoped is not. Statement granularity was tried first and produced ~90 false
  positives against correct code; a guard that noisy gets disabled, and a
  disabled guard protects nothing.

## Reversibility

Trivially reversible — it is one test file. Adding RLS later does not require
removing it; the two are complementary, and the guard keeps catching
application-layer mistakes that RLS would turn into a silent empty result set
rather than a visible bug.

## Follow-up

Sequenced, in order:

1. Introduce a request-scoped DB handle that runs each request's queries inside
   a transaction with `SET LOCAL app.current_org_id`.
2. Migrate workers to the same handle, passing the org explicitly.
3. Add a dedicated non-owner application role.
4. `ENABLE` + `FORCE ROW LEVEL SECURITY` and `CREATE POLICY` on every org-scoped
   table, with the policy keyed on `current_setting('app.current_org_id')`.
5. Keep this guard.
