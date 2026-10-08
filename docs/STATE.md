# Project state ledger

The single source of truth for **what is true right now**. Read this before
starting work; update it before ending any session (rules: `AGENTS.md` §7).
Newest information first. If this file contradicts another doc, this file wins.

---

## Current state

_Last updated: 2026-10-05 — by the call-recordings follow-up session below._

### Health dashboard

| Item | Status | Detail |
| --- | --- | --- |
| `main` HEAD | `44b3739` (2026-10-05) | "Call recordings: fix review findings left open at #272 merge (#277)". Re-check: this row goes stale within hours. |
| CI: typecheck + test | Green | |
| CI: `pnpm audit (moderate)` | Green at `4911b43` | `braces` advisory `GHSA-vfj7-8cjw-p6xm` is suppressed (landed in #272); see the exceptions register below. |
| CI: migration journal | Green | |
| Production deploy (GCP Cloud Run) | **Green** at `2a29f04` (run 37230136675) and `4911b43` (run 37229595531) | Red 2026-10-02 → 2026-10-04 because Secret Manager secrets `mediflow-twilio-api-key-secret` and `mediflow-statement-ingest-google-credentials` did not exist (the bootstrap was not re-run after they were added to the deploy script). Fixed 2026-10-04 by creating both as `unset` placeholders with the bootstrap's IAM bindings (run SA: secretAccessor; deploy SA: secretVersionAdder), with the owner's approval. The run SA was also granted Token Creator on itself (needed to sign recording upload links). |
| Production verified live? | **Partly** | A deploy succeeded and the post-deploy page check passed. Not confirmed: real-user login, Clerk production keys, the Google Cloud and AWS BAAs. ADR 0004 still "Proposed". |
| Real PHI allowed? | **No** | Not until production is verified and BAAs confirmed. |
| Open PRs | Query GitHub live | At 2026-10-05 ~02:15 UTC: #278 (docs: which vendors need a BAA) and the #277 follow-up (waiting duplicates skip Speech-to-Text; migration 0069). #277 merged as 44b3739 at head 1a36e2b. |
| Migration high-water mark | `0068_call_recordings_cleanup` on main; `0069_call_recordings_cap_index` (main); `0070_move_artificialbridge_clients_to_insureitall` in the move-clients PR | Two files share `0064`. Check `origin/main` and open PRs before numbering a new one. |
| Remote branches | 156 (excl. main), snapshot | 72 fully merged + 21 tree-neutral (safe to delete), 62 landed-then-evolved, 1 open PR. 72+21+62+1 = 156 at snapshot (two of the 72 were then reused for open PRs #273/#275 — never delete a head of an open PR). See branch audit and its `.tsv`. |

### Owner-only actions

1. Confirm the e-sign signing secrets hold real production PEMs. (How the deploy was fixed is now recorded in the health table.) The two placeholder secrets hold `unset`: put the real Twilio API key secret and statement-ingest Google credentials in Secret Manager when those features go live.
2. **Promote ADR 0004** to Accepted if you consider the production deploy proven; otherwise say what is still missing.
3. **Confirm the BAAs that are actually needed:** Google Cloud and AWS Bedrock (both receive PHI as built), and **Twilio for client calls** (live call audio, and recordings if enabled, carry health details; texts can be kept PHI-free but calls cannot). Not needed for Stripe, and probably not DocuSign (agent paperwork only). HighLevel/EnrollHere are the agency's own existing relationships. Resend depends on whether email bodies contain PHI. Decide with a compliance advisor and record the outcome here.
4. **Verify Clerk is on production keys**, not a development-mode key, before any PHI.
5. **Turn on** GitHub setting "Automatically delete head branches".
6. Approve a branch cleanup (see audit: delete the 93 in buckets A+B, excluding any head of an open PR; spot-check the 62 in C). Existing `.github/scripts/nuke-branches.sh` embeds escaped quotes in its branch list and was not tested; do not run it as-is.
7. Close #276 (its audit suppression and ADR 0007 duplicate #272; keep ADR 0007 if the reachability write-up is wanted).

### Security audit exceptions (`pnpm.auditConfig.ignoreGhsas` in `package.json`)

| Advisory | Package path | Why not reachable | Remove when |
| --- | --- | --- | --- |
| `GHSA-86w9-cpqp-85rv` | `node-forge` | E-sign CMS signature verification now uses `node:crypto`, not the node-forge RSA verifier (PR #258; commit "Verify e-sign CMS signatures with node:crypto"). | node-forge is upgraded or dropped. |
| `GHSA-vfj7-8cjw-p6xm` (`braces` ReDoS-style DoS, no patched release) | `api-server > http-proxy-middleware > micromatch > braces` | `braces` expands glob *patterns*, never request data. The only proxy (`middlewares/clerkProxyMiddleware.ts`, the sole `createProxyMiddleware` call) passes no `pathFilter`, so `micromatch` is never invoked. Verified in code 2026-10-04; fuller analysis in PR #276 / ADR 0007. | A patched `braces` ships (re-run `pnpm audit` with the ignore removed), **or** any `pathFilter` is added to a proxy. |

### Decided direction (do not reopen without an ADR)

GCP Cloud Run + Cloud SQL is production · Render forbidden for PHI · Railway is
demo only · Claude on Bedrock via Anthropic Messages API · MFA mandatory for all
· tenant isolation in app code with static guard (RLS is a later follow-up) ·
Scope of Appointment captured on call recording (no 48-hour wait enforced).

### Open questions

- Is the GCP project actually provisioned, and has any deploy ever succeeded?
- Clerk → Identity Platform: go or no-go? (ADR 0006, proposed). Production
  currently reportedly uses a Clerk **development-mode** key — verify before PHI.
- #276 duplicates the suppression now on main and adds ADR 0007 (reachability analysis). Keep the ADR, close or rebase the PR.

### Known gaps

**Compliance:** contact reads that decrypt PHI (`GET /contacts`, `GET /contacts/:id` via `serializeContact`) are not audit-logged (`routes/contacts.ts` sets `includeReads: false`). Decide: audit them, or document the exception. Do this before PHI launch.

**Deploy:** the earlier worry that unset `ESIGN_SIGNING_*` placeholders could abort boot did not materialise — the deploy and live-page check passed at `4911b43`. Still confirm the PEMs are real production credentials (a dev sentinel is refused only by the boot guard, and a passing smoke test does not prove e-sign signing works).

**Platform overview (super admin):** revenue figures are an estimate (active plans at list price from the local `subscriptions` mirror; no seat overage, discounts or proration; Stripe is the source of truth). The 12-month client history is derived from live `contacts` rows (soft-deletes handled via `deleted_at`); a permanent retention purge (`routes/admin.ts` hard-delete) shrinks past months. Fixing that needs a separate store of aggregate lifecycle events (new table, backfill) — a design decision, not done. `commission_line_items` has no index serving the platform-wide GROUP BYs; fine until the table is large, then add a migration or a monthly rollup.

**Other:** E-sign provider is Beta · contracting POA PDF is a placeholder · per-carrier
paperwork templates pending · client portal is staff-preview only · no
Postgres RLS · dialer Phase 4+ TODOs and auto-dial deferred · some Billing and
Reconciliation panels "Coming soon" · Dropbox Sign endpoints are dead 501 stubs
· `docs/ARCHITECTURE.md` stale (says Azure OpenAI in prod).

### Stale and orphaned files

Not deleted by the audit (owner decision). Safe-to-remove candidates are the
ones with no inbound references.

| Path | What it is | Recommendation |
| --- | --- | --- |
| `DEPLOYMENT_GUIDE.md`, `PRIORITY_ORDERED_AUTONOMOUS_LOOP.md`, `SOLO_FOUNDER_RIE_EGE_MEDI_FLOW_INTEGRATION.md` | Empty one-line stubs | Delete |
| `BRIDGET_AI_WORKFORCE_SPEC_SHEET.md`, `HARDENING_PHASE0_IMPLEMENTATION.md` | Self-declared placeholders; "must not be cited as evidence" | Delete |
| `PRODUCTION_READINESS.md` | June 2026 report, partly stale | Fold into this file, then delete |
| `PROVISION_TEST_ACCOUNTS.md`, `DEMO_VIDEO_QUICKSTART.md` | Demo-video evidence tooling docs; mixes IntelBRIDGE/agencyBRIDGE | Keep; move under `docs/` |
| `.autoclaw/` (173 JSON files), `.a5c/` | Stale agent-tool run history/cache | Delete |
| `deck-kit/` | Pitch-deck template configured for another product ("openOPS") | Move out of this repo |
| `docs/DEPLOY_RENDER_PRODUCTION.md`, `render.prod.yaml` | Marked DO NOT USE (no BAA) | Keep as warning or delete |
| `.github/workflows/stale.yml` | Unconfigured bot template ("Stale issue message") | Configure or delete |

---

## Session log

Newest first. Template in `AGENTS.md` §7.

### 2026-10-08 — Move artificialBRIDGE clients to INSUREitALL — Claude Code — branch `move-artificialbridge-clients-to-insureitall`
- **Outcome:** partial (migration written and tested; not yet run on production)
- **Changed:** New migration `0070_move_artificialbridge_clients_to_insureitall.sql` (+ journal entry, + test `migration-0070-move-clients.test.ts`). It moves every contact in the artificialBRIDGE org, and all rows hanging off those contacts, into the INSUREitALL org. It clears each moved contact's assigned agent (those agents belong to the old org). Nothing is deleted; the artificialBRIDGE org stays.
- **Verified:** `pnpm exec vitest run artifacts/api-server/src/__tests__/integration/migration-0070-move-clients.test.ts` (2 pass: move + idempotency + other-org untouched; ambiguous/missing org = no-op). `check:migration-journal` OK. Full `pnpm test` and CI NOT run here; api-server `typecheck` has 719 pre-existing errors on this machine, unchanged by this change.
- **Left undone / broken:** The migration finds the two orgs by slug/name (artificialbridge / insureitall, case-insensitive). If prod uses other names it logs a notice and does nothing. Not confirmed against the real prod org rows.
- **Decisions made:** Contacts only move with their child rows; agents/users are not moved; assigned agent is cleared rather than crossing tenants.
- **Next agent should:** Confirm the real org slugs in prod, then let CI run and merge; check the migration notices for the moved row counts.
- **Needs a human:** Approve the PR; after deploy, re-assign the moved clients to INSUREitALL agents.

### 2026-10-05 — Call recordings: commit missed by the #277 merge — Claude Code — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** partial (follow-up PR open)
- **Changed:** #277 merged at `1a36e2b`, one commit before its last push. The missing change is re-applied on a fresh branch: a duplicate recording waiting for another to finish scoring the same call no longer polls Speech-to-Text every 30 s, and new migration `0069_call_recordings_cap_index` indexes the daily-cap count by `(org_id, coalesce(committed_at, created_at))` (0068 is already merged, so the index moved to its own migration).
- **Verified:** `pnpm run typecheck`; `npx vitest run` (225 files, 2482 tests); `check:migration-journal` OK (71 entries).
- **Left undone / broken:** Production deploy of 44b3739 (#277) was in progress when this entry was written. Live-transcription Chrome extension not started.
- **Decisions made:** a person's explicit Rescore is intentionally not blocked by `call_score_claims` (claims serialize recording jobs only).
- **Next agent should:** confirm the deploy of #277 went green, merge this follow-up, then build the live-transcription extension.
- **Needs a human:** merge the follow-up PR.

### 2026-10-05 — Merge-conflict follow-up — Copilot — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** investigation-only
- **Changed:** Recorded that the requested merge-conflict resolution was already completed by the repository owner; no conflict fix was needed in this session.
- **Verified:** `git status --short --branch` was clean and the branch includes merge commit `43e4c6e` from `main`. **NOT independently verified:** CI; the owner reports typecheck and targeted tests pass.
- **Left undone / broken:** Nothing related to merge conflicts.
- **Decisions made:** none.
- **Next agent should:** Continue the open PR work; no further merge-conflict resolution is needed unless new conflicts arise.
- **Needs a human:** nothing.

### 2026-10-04 — Call recordings: fix review findings left open at #272 merge — Claude Code — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** partial (PR #277 open, awaiting CI and merge)
- **Changed:** PR #277. Confirm at the daily limit can no longer delete audio a concurrent confirm already accepted; unused audio (refused, oversized, abandoned) is deleted durably after its upload link expires, with backoff retries (`purge_after`, `purge_attempts`); the daily cap counts from confirm (`committed_at`); a duplicate recording rescores when the call's newest score is under another checklist, one job at a time per call (`call_score_claims`), and a job whose claim was taken over cannot save. Migration `0068_call_recordings_cleanup`. Earlier the same day: created the two missing Secret Manager secrets and the Token Creator grant (production deploys green since).
- **Verified:** `pnpm run typecheck`; `npx vitest run` (225 files, 2480 tests); `check:migration-journal` OK (70 entries). Deploy runs 37229595531 and 37230136675 green.
- **Left undone / broken:** #277 not merged. Live-transcription Chrome extension (private Chrome Web Store listing) not started.
- **Decisions made:** no unique index on `call_scores(transcript_id, rubric_id)` — rescore history must be kept; concurrency is handled by the claim row plus an in-transaction ownership check.
- **Next agent should:** get #277 green and merged, then build the live-transcription extension.
- **Needs a human:** merge #277; optional Speech-to-Text billing alert amount; real values for the two placeholder secrets when Twilio API-key auth / statement ingest from Drive go live.

### 2026-10-04 — Correct the BAA list (owner feedback) — Claude Code — branch `claudemoogs/focused-feynman-01k79k`
- **Outcome:** done (documentation only).
- **Changed:** README vendor table and the STATE owner action now say which vendors actually need a BAA: Google Cloud and AWS Bedrock (they receive PHI as built). Stripe: no. DocuSign: probably not (agent paperwork). HighLevel/EnrollHere: the agency's own existing relationships. Twilio: likely yes for client calls (live and recorded audio); Resend: depends on email content. Earlier text over-listed all of them.
- **Verified:** NOT verified: this is a reading of what the code sends where, not legal advice or a contract review. Based on code behaviour (AI prompts include live client data; DocuSign is used for agent contracting) and the owner's correction.
- **Left undone / broken:** The code's DocuSign boot guard still demands a HIPAA-eligible plan; it may be stricter than needed. Not changed.
- **Decisions made:** none. (Merged `main` into this branch twice to resolve `docs/STATE.md` conflicts with other sessions' entries; kept every entry and took the other session's more accurate deploy row.)
- **Next agent should:** keep email bodies and texts free of PHI; calls cannot be kept PHI-free, so Twilio voice needs a BAA or a different approach; revisit the DocuSign guard only if the owner asks.
- **Needs a human:** confirm the Google Cloud, AWS and Twilio (voice) BAAs; decide the Resend email content policy with a compliance advisor.

### 2026-10-04 — Super admin platform dashboard, revenue/commissions/growth — Claude Code — branch `claudemoogs/practical-thompson-09n6cr`
- **Outcome:** done (PRs #270 and #273 merged; follow-up #279 open, awaiting owner approval).
- **Changed:** #270: a `super_admin` now lands on a platform overview (counts per agency, plan mix, "needs a nudge") with a platform-only sidebar; agency pages, search, notifications, AI assistant, branding and stats polling are off in that view, agency URLs redirect to `/dashboard`, the signed-in area waits for the user's role (`RoleGate`), and viewing your own agency is never offered. #273: new `GET /api/admin/platform/metrics` (super_admin + MFA; OpenAPI + generated clients updated) and dashboard money tiles, two charts with a table view, per-agency revenue and commissions columns. #279: the endpoint's nine snapshot reads now run sequentially inside the repeatable-read transaction (no `Promise.all` on one connection; avoids the node-postgres pg@9 deprecation) plus Prettier formatting of the touched files.
- **Verified:** `pnpm run typecheck` and `pnpm exec vitest run` (225 files, 2,475 tests) pass on the #279 branch; new integration tests in `artifacts/api-server/src/__tests__/integration/platform-metrics.test.ts` (auth, list-price revenue, commissions window incl. future periods and statement-period fallback, deleted-client history, agencies with no subscription) and UI tests in `artifacts/web-app/src/__tests__/super-admin-dashboard.test.tsx`; the page was rendered with sample data in a browser (light, dark, phone width). CI on #273's head: all green. #279: CI pending at time of writing. **NOT verified:** the deployed app (no live sign-in as a super admin was done).
- **Left undone / broken:** After a permanent retention purge, past months of the client chart show only surviving clients (needs an aggregate-events store; see Known gaps). No index for the platform-wide commission aggregations (declined as premature). My earlier note in the PR thread that the `braces` audit failure "went away on its own" was wrong: it was suppressed by #272/#276 (see exceptions register).
- **Decisions made:** none needing an ADR. Revenue is explicitly an estimate from list prices, not Stripe payments; commissions are agencies' carrier commissions, not platform revenue.
- **Next agent should:** confirm #279 CI is green and the owner approved it; if exact revenue is wanted, scope reading real payments from Stripe.
- **Needs a human:** approve #279; after it deploys, sign in as the super admin and check the Platform overview (not verified live); decide whether permanent client history is worth building.

### 2026-10-04 — Branch audit, README, AGENTS.md, state ledger — Claude Code — branch `claudemoogs/focused-feynman-01k79k`
- **Outcome:** done (documentation only; no application code changed).
- **Changed:** Ported the one-line `GHSA-vfj7-8cjw-p6xm` audit suppression from PR #272 into `package.json` (identical lines) so this PR's audit job passes; `pnpm audit` locally: 2 high, 2 ignored. Added `docs/BRANCH_AUDIT_2026-10-04.md`; rewrote `README.md` to
  reflect verified state; added `AGENTS.md`, `CLAUDE.md` and this file. Restored
  the dropped repo-name casing fix (`copperlang2007/Mediflow`) in
  `docs/DEPLOY_GCP_PRODUCTION.md` and `scripts/deploy/gcp-bootstrap.sh` (from
  unmerged commit `4536d8c`).
- **Verified:** Branch findings from full-history git analysis (`git fetch
  --unshallow`, `git cherry`, `git merge-tree`, PR-number cross-check against
  main's log) — 156 branches classified; corrected after review (#211 was merged and its help text is on main). CI and deploy failure causes read from
  the GitHub Actions job logs of runs `37174335043` and `37174335059`. Codebase
  facts from a read-only inventory of the repo at `f0195e0`; spot-checked
  migration count (69, duplicate `0064`) and script names. Shell syntax of
  `gcp-bootstrap.sh` checked with `bash -n`. **NOT verified:** that the app
  builds/tests pass on this branch (no code changed); BAA statuses (claims in
  docs only); whether the live GCP project exists.
- **Left undone / broken:** At the time of writing `main` CI and the GCP deploy were red; both turned green later the same day (#272 merged; deploy fixed out of band) and the ledger above was refreshed in follow-up commits. No branches were deleted.
- **Decisions made:** none new.
- **Next agent should:** help the owner close the "Owner-only actions" list above (Clerk production keys, BAAs, ADR 0004 promotion), then clean up branches per the audit.
- **Needs a human:** the owner-only actions listed under "Current state".
