# agencyBRIDGE AI workspace: build plan

_Written 2026-11-20. Status: proposed. Design: [`DESIGN.md`](DESIGN.md)._

Goal: first outside agency paying by **2027-01-19** (60 days). Each phase ships
on its own and ends with checks that can be run. INSUREitALL gets value from
Phase 2 onward; outside sales start in Phase 5.

**Honest read of the date.** Sixty days is achievable only if Phase 0 finishes
in about three weeks and the owner tasks in week 1 happen in week 1. If Phase 0
slips, cut Phase 3 down to read-only tools before moving any PHI gate.

## Owner tasks (start in week 1; nothing below can do these for you)

1. Engage a HIPAA attorney: customer BAA template, review of the
   business-associate duties, call-recording retention period.
2. Confirm in writing with AWS which open-weight Bedrock models are covered by
   the BAA.
3. Decide A2 (per-user pricing) and A3 (one call-scoring engine) in `DESIGN.md`.
4. Name the first outside agency and a contact there.
5. Complete a HIPAA risk assessment and name a security contact.
6. Decide A6 with a compliance advisor: may call transcripts go to a
   BAA-covered model for grading? `AGENTS.md` forbids recording content in
   prompts today. Phase 4 cannot use real calls until this is decided by ADR.
7. Write a breach-notification procedure and keep workforce HIPAA training
   records (with the attorney).
8. Decide A7 (which sign-in system) and A8 (whether the assistant may start
   before the half-built work `AGENTS.md` lists is finished).
9. Put the executed AWS BAA and Neon BAA on file where an agent can cite
   them (date signed, account or organization covered). The ledger so far
   records them only as stated by the owner, not verified.

## Phase 0. Go-live on AWS + Neon (weeks 1 to 3)

This is a new migration that has not started. **No migration work begins
until the hosting ADR below is accepted**; until then the repo's decided
direction is still Google Cloud.

Scope: both apps on AWS and Neon with one sign-in and MFA. myCALL stops using
SQLite, Deepgram and the direct Anthropic API, none of which may receive real
call data: storage moves to Neon and S3, transcription to Amazon Transcribe,
and model calls to Bedrock through the gateway. INSUREitALL is loaded last.

Deliverables that do not exist yet and come first:
- An accepted ADR recording AWS + Neon as production hosting (replaces ADR 0004's direction).
- An AWS deploy path for both apps, including a job worker that runs
  independently of web traffic (see `DESIGN.md` section 2).
- `docs/GO_LIVE_LEDGER.md`, listing each PHI gate and its evidence.
- Migration of agencyBRIDGE's existing data from Google Cloud (the Cloud SQL
  database and stored files such as documents and recordings) to Neon and S3.
  Before any copy starts: the executed AWS and Neon BAAs are on file (owner
  task 9), the target Neon project has HIPAA enabled, and the PHI gates
  below have passed in the target environment. The copy itself: stop writes
  to the Google Cloud app (maintenance mode), take the export from that
  frozen state, reconcile row counts and file counts, open a sample of
  records and files in the new environment, then switch. If a freeze is not
  acceptable, copy from a snapshot and replay and reconcile every change made
  since the snapshot before switching. The Google Cloud copy stays read-only
  until the owner confirms the cutover.
- Migration of existing myCALL records and files from SQLite and local disk,
  with counts reconciled and old call reviews opened successfully before
  SQLite is retired.

The PHI gates the ledger tracks, each with evidence, per environment:
1. Sign-in with MFA works for a real user.
2. Data is encrypted in transit and at rest.
3. Every PHI read is audit-logged, including contact reads.
4. Tenant-isolation tests pass.
5. Backups are on and one restore has been tested.
6. No vendor without a BAA receives PHI (configuration review plus a check of
   outbound calls during a test run).

Done when:
- `docs/GO_LIVE_LEDGER.md` shows every PHI gate passed with evidence.
- A real INSUREitALL user signs in to both apps with MFA.
- Contact reads that decrypt PHI are audit-logged.
- A restore from backup has been tested once.

## Phase 1. Model gateway and evaluations (weeks 2 to 3, synthetic data only)

- One internal model call that can reach Claude (existing) and open-weight
  Bedrock models (new adapter, ADR 0008). The production boot guard keeps
  refusing any provider or model not on an allow-list.
- Evaluation harness and the first 40 cases per job from `DESIGN.md` section 3.

Done when:
- The open-weight catalog and prices are read from the owner's AWS account and
  recorded with the date.
- Each job has a recommended model with its pass rate and cost per 1,000 runs.
- myCALL's scoring tests have been run against at least two open models and
  the result reported to the owner.
- No evaluation case contains real data (checked by a script). Call-grading
  cases are synthetic rewrites only.
- For each recommended model, AWS's written confirmation of BAA coverage is
  recorded, or the model is marked "synthetic data only".

## Phase 2. Assistant: chat and documents (weeks 3 to 4)

Starts only after every Phase 0 PHI gate has passed and the owner has decided
A8. The week numbers are a target, not permission to begin.

- Assistant panel in agencyBRIDGE. Upload, ask, draft.
- Per-tenant retrieval in Neon (pgvector). Per-tenant memory (stage 1).
- Every document read and assistant read of PHI written to the append-only audit log.

Done when:
- Before any real data: AWS has confirmed in writing that the model in use is
  covered by the BAA, and that model is on the in-code allow-list.
- A test shows a document read and an assistant answer each produce an audit record.
- A user in tenant A cannot retrieve a document from tenant B (automated test).
- No PHI appears in logs or error tracking during a test session (checked).
- Thumbs up/down is recorded per answer.
- Cost per conversation is measured and written into `DESIGN.md` section 7.

## Phase 3. Agent tools (weeks 4 to 6)

- Read tools: find a contact, summarize a client, list expiring licenses,
  commission lookups, call-review results.
- Write tools with a confirmation click: add a note, create a task, update a
  contact field, schedule a follow-up.

Done when:
- Every tool call is in the audit log with user, tenant, tool and record.
- A user without a permission cannot get the agent to do that action (test).
- No write happens without a confirmation (test).
- Agent tool-use evaluations pass at the agreed rate.

## Phase 4. Call review in the workspace (weeks 5 to 6)

- myCALL appears as "Call review" under the same login.
- Recordings are transcribed in batch and graded automatically.
- One grading engine (if A3 is accepted).

- Per-tenant retention setting for recordings and transcripts; deletion is a
  deliberate, audited action.

Done when:
- Before any real call: AWS has confirmed in writing that the grading model is
  covered by the BAA, and assumption A6 (transcripts in prompts) is decided by ADR.
- The retention setting is stored per tenant and a test shows it is honored.
- myCALL's grading requests go through the model gateway (no model
  credentials in myCALL).
- A do-not-contact request on a myCALL-graded call appears in the existing
  review queue (test).
- A new INSUREitALL recording is graded with quoted, timestamped evidence and
  no person touches it, shown on five real calls.
- Cost per graded call is measured.

## Phase 5. Ready to sell (weeks 6 to 8)

- Per-user plan in Stripe, seat counting, fair-use limit on call minutes.
- Row-level security in Postgres before the second tenant, with the app on a
  database role that cannot bypass it and the organization set per request.
- Onboarding checklist and import tooling; customer BAA signed; per-tenant
  call-recording retention configured.
- Dry run: onboard a fake second agency end to end.

Done when:
- The dry-run agency cannot see INSUREitALL data by any route tried.
- The risk assessment, named security contact, breach-notification procedure
  and workforce training records are on file before any outside data is loaded.
- A test connects as the app's database role and fails to read another
  tenant's rows with the application filter removed. The same test passes
  for a background job running for one agency.
- The first outside agency has signed the BAA, is onboarded and has paid an invoice.

## After version 1

- Customer-facing builder (conditions in `DESIGN.md` section 5).
- Pooled fine-tuning, only after ADR 0009's three conditions are met.
- Own GPU servers, only past roughly 300 typical users.
