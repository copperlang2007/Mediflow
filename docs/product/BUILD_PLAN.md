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

## Phase 0. Go-live on AWS + Neon (weeks 1 to 3)

The existing go-live plan: both apps on AWS and Neon, one sign-in with MFA,
myCALL off SQLite, Deepgram and the direct Anthropic API, INSUREitALL loaded.

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
- No evaluation case contains real data (checked by a script).

## Phase 2. Assistant: chat and documents (weeks 3 to 4)

- Assistant panel in agencyBRIDGE. Upload, ask, draft.
- Per-tenant retrieval in Neon (pgvector). Per-tenant memory (stage 1).

Done when:
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

Done when:
- A new INSUREitALL recording is graded with quoted, timestamped evidence and
  no person touches it, shown on five real calls.
- Cost per graded call is measured.

## Phase 5. Ready to sell (weeks 6 to 8)

- Per-user plan in Stripe, seat counting, fair-use limit on call minutes.
- Row-level security in Postgres before the second tenant.
- Onboarding checklist and import tooling; customer BAA signed.
- Dry run: onboard a fake second agency end to end.

Done when:
- The dry-run agency cannot see INSUREitALL data by any route tried.
- The first outside agency has signed the BAA, is onboarded and has paid an invoice.

## After version 1

- Customer-facing builder (conditions in `DESIGN.md` section 5).
- Pooled fine-tuning, only after ADR 0009's three conditions are met.
- Own GPU servers, only past roughly 300 typical users.
