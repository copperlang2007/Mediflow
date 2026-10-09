# Project state ledger

The single source of truth for **what is true right now**. Read this before
starting work; update it before ending any session (rules: `AGENTS.md` §7).
Newest information first. If this file contradicts another doc, this file wins.

---

## Current state

_Last updated: 2026-10-09 — CMS plan data branch refreshed against current main._

### Health dashboard

| Item | Status | Detail |
| --- | --- | --- |
| `main` HEAD | `f821a54` (2026-10-09) | "STATE: tidy duplicate rows after #284 (#285)". Re-check: this row goes stale within hours. |
| CI: typecheck + test | In progress | Run 37867735833 on `f821a54` (checked 2026-10-09) |
| CI: `pnpm audit (moderate)` | **Green** — run 37865453026 on `efe7e4c` (#284, 2026-10-09) passed. Was red on main from 2026-10-08 when four advisories (proxy-addr critical, source-map-js high, fast-copy and postcss-selector-parser moderate) were published | `braces` advisory `GHSA-vfj7-8cjw-p6xm` is suppressed (landed in #272); see the exceptions register below. |
| CI: migration journal | Green | Run 37865453026 on `efe7e4c` |
| Production deploy (GCP Cloud Run) | **Green** at `f821a54` (run 37867735824), `d9ba459` (run 37861974648, 2026-10-08), `2a29f04` (run 37230136675) and `4911b43` (run 37229595531) | Red 2026-10-02 → 2026-10-04 because Secret Manager secrets `mediflow-twilio-api-key-secret` and `mediflow-statement-ingest-google-credentials` did not exist (the bootstrap was not re-run after they were added to the deploy script). Fixed 2026-10-04 by creating both as `unset` placeholders with the bootstrap's IAM bindings (run SA: secretAccessor; deploy SA: secretVersionAdder), with the owner's approval. The run SA was also granted Token Creator on itself (needed to sign recording upload links). |
| Production verified live? | **Partly** | A deploy succeeded and the post-deploy page check passed. Not confirmed: real-user login, Clerk production keys, the Google Cloud and AWS BAAs. ADR 0004 still "Proposed". |
| Real PHI allowed? | **No** | Not until production is verified and BAAs confirmed. Owner stated 2026-10-08 (not independently verified): Google Cloud and AWS BAAs are signed. Still open: Clerk production keys and real-user login check, and the Twilio live-call-audio position (owner: conduit, nothing stored or processed; needs compliance-advisor confirmation, recording must stay off). |
| Open PRs | Query GitHub live | As of 2026-10-09, #283 (CMS 2027 plan benefit data; now includes main at `f821a54`). #285 merged as `f821a54`; #281, #282, and #284 are also merged. |
| Migration high-water mark | `0070_move_artificialbridge_clients_to_insureitall` on main (#281); `0071_cms_plan_benefits` in PR #283 | Two files share `0064`. Check `origin/main` and open PRs before numbering a new one. |
| Remote branches | 156 (excl. main), snapshot | 72 fully merged + 21 tree-neutral (safe to delete), 62 landed-then-evolved, 1 open PR. 72+21+62+1 = 156 at snapshot (two of the 72 were then reused for open PRs #273/#275 — never delete a head of an open PR). See branch audit and its `.tsv`. |

### Owner-only actions

1. Confirm the e-sign signing secrets hold real production PEMs. (How the deploy was fixed is now recorded in the health table.) The two placeholder secrets hold `unset`: put the real Twilio API key secret and statement-ingest Google credentials in Secret Manager when those features go live.
2. **Promote ADR 0004** to Accepted if you consider the production deploy proven; otherwise say what is still missing.
3. **Confirm the BAAs that are actually needed:** Google Cloud and AWS Bedrock (both receive PHI as built), and **Twilio for client calls** (live call audio, and recordings if enabled, carry health details; texts can be kept PHI-free but calls cannot). Not needed for Stripe, and probably not DocuSign (agent paperwork only). HighLevel/EnrollHere are the agency's own existing relationships. Resend depends on whether email bodies contain PHI. Decide with a compliance advisor and record the outcome here. **2026-10-08 (owner, unverified here):** Google Cloud and AWS BAAs signed long ago; owner says Twilio needs none because calls are not recorded and Twilio only carries the call (owner's conduit reasoning, unverified). Owner also states call recording and transcription do not go through Twilio. The code has two paths: (1) Twilio-side recording (`record="record-from-answer-dual"` in `lib/voice/twiml.ts`), OFF by default and would store PHI at Twilio if switched on; (2) uploaded recordings stored in Google Cloud with Google Speech-to-Text (`call_recordings`, `SPEECH_TO_TEXT_PROVIDER=google`), which falls under the Google BAA. Owner's statement matches path (2) only; path (1) must stay off. Open point for the compliance advisor: confirm the conduit position for live call audio, and keep recording off for INSUREitALL unless a Twilio BAA is in place.
4. **Verify Clerk is on production keys**, not a development-mode key, before any PHI.
5. **Turn on** GitHub setting "Automatically delete head branches".
6. Approve a branch cleanup (see audit: delete the 93 in buckets A+B, excluding any head of an open PR; spot-check the 62 in C). Existing `.github/scripts/nuke-branches.sh` embeds escaped quotes in its branch list and was not tested; do not run it as-is.
7. ~~Close #276~~ — already merged (CI: documented audit exception for braces); nothing to do.

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
- #276 is merged (the braces suppression and ADR 0007 are on main); no action needed.

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

### 2026-10-09 — Resolve merge conflicts for CMS plan data — Copilot — branch `claude/admiring-allen-b6wum5`
- **Outcome:** done (current `main` merged into PR #283)
- **Changed:** Merged `main` at `f821a54` into #283, retained both branches' `docs/STATE.md` history, kept the CMS migration numbered `0071` after main's `0070`, and preserved the concurrent PR updates through `625b331`.
- **Verified:** Before preserving the concurrent importer follow-up, `corepack pnpm install --frozen-lockfile`; `pnpm --filter @workspace/scripts run check:migration-journal` (73 entries); `pnpm exec vitest run lib/db/src/cmsPlans artifacts/api-server/src/__tests__/guards/tenant-isolation.test.ts` (15 tests); and `pnpm run typecheck` passed. Node 22.23.3 was used although the repository targets Node 24. Main deploy run 37867735824 succeeded; main CI run 37867735833 was in progress at last check.
- **Left undone / broken:** CI has not yet run on the final combined PR head; CMS data remains unloaded to a real database.
- **Decisions made:** none
- **Next agent should:** verify PR #283 CI and mergeability after this commit is published.
- **Needs a human:** nothing

### 2026-10-09 — CMS 2027 plan benefit data: tables + importer — Claude Code — branch `claude/admiring-allen-b6wum5`
- **Outcome:** partial (code ready; data NOT yet loaded into any real database)
- **Changed:** New migration `0071_cms_plan_benefits` (4 global tables: plans, per-plan benefit JSON, plan-to-county, plan-to-region), loader `lib/db/src/cmsPlans/pbpImport.ts`, command `pnpm --filter @workspace/scripts import:pbp`, how-to in `docs/cms-plan-data.md`. The uploaded zip is CMS tab-delimited text, not JSON, and is not committed (252 MB). Employer-only plans (1,673) are skipped by default.
- **Verified:** loaded the real 2027 extract twice into a throwaway PostgreSQL 16 database: 6,300 plans, 377,453 section rows, 125,383 county rows, 364 region rows, ~320 MB, under a minute; dry run saves nothing. `npx vitest run lib/db/src/cmsPlans` (11 tests) and the tenant guard pass; `pnpm run typecheck` and `check:migration-journal` (72 entries) OK. Full `pnpm test`: 227 files, 2,496 tests passed locally after merging main.
- **Left undone / broken:** Nothing reads these tables yet (no API route or screen). `county_code` is CMS/SSA, not FIPS (needs a crosswalk to match client counties).
- **Decisions made:** none needing an ADR (public reference data, global tables like the KB library).
- **Next agent should:** run the importer against the real database after merge, then add a read-only plans-by-county route (OpenAPI + `requirePermission`, add the tables to `GLOBAL_TABLES`).
- **Needs a human:** after merge, run the importer on the production database (or approve me doing so); confirm which year/refresh cadence you want.

### 2026-10-08 — Tidy STATE.md after #282/#284 — Claude Code — branch `state-tidy-after-284`
- **Outcome:** done (docs only)
- **Changed:** Removed duplicate header lines that reached `main` when #284 merged before the cleanup commit landed; made the Current state block consistent: main HEAD `efe7e4c`, single audit row, deploy row, open-PR row (#283 and #285 open; #281, #282, #284 merged today), migration high-water mark `0070` on main (#281), and owner action 7 (#276 is already merged, nothing to close). No code or migration changes. PR #285.
- **Verified:** Read the resulting file top to bottom; `git diff origin/main --stat` shows only `docs/STATE.md`. CI on `main` at `efe7e4c` (run 37865453026) succeeded, including `pnpm audit`; the audit row records it. The Cloud Run deploy for `efe7e4c` has not been checked.
- **Left undone / broken:** #283 (CMS 2027 plan benefits, another session) is open and conflicts with `main`; its migration file is numbered 0071 while its title says 0070. Not touched. The 0070 client move is deployed but not confirmed (no access to Cloud Run logs).
- **Decisions made:** none
- **Next agent should:** check Cloud Run logs for lines starting `0070:` (a "skipped" line means the org slugs or names did not match exactly one org each); then confirm `main` CI, including `pnpm audit`, is green.
- **Needs a human:** nothing new; the earlier owner actions in the Current state block still stand.

### 2026-10-08 — Clear four new audit advisories — Claude Code — branch `fix-audit-advisories-2026-10-08`
- **Outcome:** done
- **Changed:** Added four `pnpm.overrides` in `package.json` (lockfile updated): `proxy-addr` 2.0.7 to 2.0.8 (critical, via express), `source-map-js` 1.2.1 to 1.2.2 (high, mockup-sandbox build tooling), `fast-copy` 4.0.2 to 4.1.2 (moderate, via pino-pretty), and `postcss-selector-parser` 6.0.10 to 7.1.6 (moderate, only under `@tailwindcss/typography`). No suppressions added.
- **Verified:** `pnpm audit --audit-level moderate` reports only the two already-ignored advisories; `pnpm --filter @workspace/web-app run build` passes; `pnpm test` 2482 pass. Two 404 tests (metrics, release-hygiene) failed only while a local web build existed in `artifacts/web-app/dist` (SPA fallback returns 200) and pass with it removed (20/20). CI not yet seen.
- **Left undone / broken:** `typecheck` has hundreds of pre-existing errors on a local machine without built libs; CI is the check.
- **Decisions made:** overrides (the repo's existing pattern) rather than suppressions.
- **Next agent should:** remove these overrides once the parent packages ship fixed ranges.
- **Needs a human:** review the `proxy-addr` bump (security-only release; trust proxy is a hop count of 1).
### 2026-10-08 — Record owner BAA statement — Claude Code — branch `docs-record-baa-status`
- **Outcome:** done (docs only)
- **Changed:** `docs/STATE.md` only: recorded the owner's statement that Google Cloud and AWS BAAs are signed, and that Twilio is treated as a conduit (no recording). Marked unverified. PR #282.
- **Verified:** NOT verified: BAAs and the Twilio position are the owner's word; no agreement documents were seen. Recording-is-off-by-default read from `lib/voice/twiml.ts`.
- **Left undone / broken:** `pnpm audit (moderate)` red on this PR from advisories already on main (proxy-addr, source-map-js, postcss-selector-parser, fast-copy); not caused by this change.
- **Decisions made:** none
- **Next agent should:** open a dependency-bump PR to clear the audit; confirm Clerk production keys and the Twilio position before any real PHI.
- **Needs a human:** confirm the Twilio conduit position with a compliance advisor; confirm Clerk is on production keys.

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
