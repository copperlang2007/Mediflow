# Project state ledger

The single source of truth for **what is true right now**. Read this before
starting work; update it before ending any session (rules: `AGENTS.md` §7).
Newest information first. If this file contradicts another doc, this file wins.

---

## Current state

_Last updated: 2026-10-14 — Plan data readable in Quoting page (see session log)._

### Health dashboard

| Item | Status | Detail |
| --- | --- | --- |
| `main` HEAD | `00c3a40` (2026-10-09) | "STATE: CMS 2027 plan data loaded into production (#286)". Re-check: this row goes stale within hours. |
| CI: typecheck + test | Green | Run 37867735833 on `f821a54` (2026-10-09) |
| CI: `pnpm audit (moderate)` | **Green** — run 37867735833 on `f821a54` passed. Was red on main from 2026-10-08 when four advisories (proxy-addr critical, source-map-js high, fast-copy and postcss-selector-parser moderate) were published | `braces` advisory `GHSA-vfj7-8cjw-p6xm` is suppressed (landed in #272); see the exceptions register below. |
| CI: migration journal | Green | Run 37867735833 on `f821a54` |
| Production deploy (GCP Cloud Run) | **Green** at `f821a54` (run 37867735824), `d9ba459` (run 37861974648, 2026-10-08), `2a29f04` (run 37230136675) and `4911b43` (run 37229595531) | Red 2026-10-02 → 2026-10-04 because Secret Manager secrets `mediflow-twilio-api-key-secret` and `mediflow-statement-ingest-google-credentials` did not exist (the bootstrap was not re-run after they were added to the deploy script). Fixed 2026-10-04 by creating both as `unset` placeholders with the bootstrap's IAM bindings (run SA: secretAccessor; deploy SA: secretVersionAdder), with the owner's approval. The run SA was also granted Token Creator on itself (needed to sign recording upload links). |
| Production verified live? | **Partly** | A deploy succeeded and the post-deploy page check passed. Not confirmed: real-user login, Clerk production keys, the Google Cloud and AWS BAAs. ADR 0004 still "Proposed". |
| Real PHI allowed? | **No** | Not until production is verified and BAAs confirmed. Owner stated 2026-10-08 (not independently verified): Google Cloud and AWS BAAs are signed. Still open: Clerk production keys and real-user login check, and the Twilio live-call-audio position (owner: conduit, nothing stored or processed; needs compliance-advisor confirmation, recording must stay off). |
| Open PRs | Query GitHub live | As of 2026-10-13: #291 (agency invitation fixes, branch `claudemoogs/fix-agency-invite-clean`); also the EnrollHere call-log import PR (branch `claude/agencybridge-compliance-review-s3nc6l`; #287 and #288 merged). No other open PRs. |
| Migration high-water mark | `0072_integration_payloads` on main (#288); `0073_call_recordings_fetching` on branch `claude/agencybridge-compliance-review-s3nc6l` | Two files share `0064`. Check `origin/main` and open PRs before numbering a new one. |
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

**CMS plan data:** read-only routes `GET /quoting/plan-areas/*` and `/quoting/plans*` serve county-based plans to the Quoting page (branch `claudemoogs/quirky-babbage-2e4cjj`, not yet merged). PDP/regional plans, ZIP lookup, and decoded premiums/out-of-pocket are not built.

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

### 2026-10-14 — Plan cards on the Quoting page (decoded premium, costs, extras, compare) — Claude Code — branch `claude/admiring-allen-b6wum5`
- **Outcome:** done (code); not yet seen by real users until merged and deployed
- **Changed:** `GET /quoting/plans` now returns a decoded `card` per plan (and `/quoting/plans/:bidId` returns one) from new `lib/planCard.ts`; the Quoting page shows plans as cards with filters (premium, drugs, dental, vision, hearing, OTC, fitness, Part B giveback), sort, plan-type filter, "lowest here" badges and a side-by-side compare of up to 4 (`components/quoting/*`). Also fixes the special-needs type showing as a CMS code ("3") instead of words ("Dual-Eligible").
- **Verified:** `pnpm run typecheck` clean; new tests `planCard.test.ts` (real 2027 plans, hand-checked), `quoting-plans.test.ts`, `plan-cards.test.tsx`; rendered in the demo build at 375/768/1440 px with real 2027 plan data, no horizontal overflow, compare dialog checked. Full `pnpm test`: 237 files / 2,659 tests passed. **NOT verified:** against the production database (the card query runs on PGlite in tests and on local PostgreSQL 16 data, not on Cloud SQL).
- **Left undone / broken:** The CMS plan benefit file has no Part D premium, star ratings, provider networks or formularies, so cards show the health plan premium only and say so. PDP and Medigap plans are not covered. ZIP search still needs a ZIP→county lookup. Medical deductible shows only when CMS states it (most plans leave it blank).
- **Decisions made:** conservative decoding: anything unreadable shows "See details" instead of a guessed number (see `docs/cms-plan-data.md`, "Plan cards").
- **Next agent should:** load the CMS Landscape and Star Ratings files (Part D premium, stars) so cards can show a true total premium and star rating; then ZIP→county search.
- **Needs a human:** review the card wording for CMS marketing-rule compliance before agents show it to beneficiaries.

### 2026-10-14 — Plan data readable in Quoting page (state/county plan browser) — Claude Code — branch `claudemoogs/quirky-babbage-2e4cjj`
- **Outcome:** partial
- **Changed:** The CMS 2027 plan tables (`cms_plan_*`) are now readable. New routes in `routes/quotingPlans.ts` (needs `contact:read`, 120/min per user for search and for details): `GET /quoting/plan-areas/states`, `/quoting/plan-areas/counties?state=`, `/quoting/plans?state=&countyCode=&q=&snp=`, `/quoting/plans/:bidId`. Employer-group plans are hidden. The Quoting page "Plan Comparison" tab has state and county pickers, name search, SNP filter, and expandable raw CMS fields per plan (CMS codes, not decoded). The four tables are in `GLOBAL_TABLES` in `tenant-isolation.test.ts`. Errors log only a Postgres code or error class, never search text. ZIP and Plan type controls are labelled "coming soon". Docs: `docs/cms-plan-data.md`. Not committed or pushed by the agent.
- **Verified:** `pnpm run typecheck`; vitest on `quoting-plans.test.ts` (11 tests), `tenant-isolation.test.ts`, `portal-dialer.test.ts` and web `portal-dialer-pages.test.tsx` (pnpm run typecheck passed (4 projects); pnpm test passed (235 test files, 2,621 tests) on this branch; the four touched test files (quoting-plans, tenant-isolation, portal-dialer, web portal-dialer-pages) passed 51/51; no lint script exists; UI not rendered in a browser). No lint script exists.
- **Left undone / broken:** PDP/regional plans and ZIP lookup need a ZIP-to-county source (owner decision; no new vendor without asking). Premiums and out-of-pocket costs are not shown because the real CMS column names are unverified (need the CMS data dictionary). UI not rendered in a browser. Production not checked.
- **Decisions made:** none (no ADR).
- **Next agent should:** Decode premium and out-of-pocket columns from `PBP_Benefits_2027_dictionary.xlsx` and add ZIP lookup.
- **Needs a human:** Confirm the screen on the live site after deploy, and decide the ZIP data source.

### 2026-10-13 — Call scoring: "Which voice is the agent?" button for one-track recordings — Claude Code — branch `claudemoogs/gracious-brown-0kq356`
- **Outcome:** done
- **Changed:** New reviewer button on the call page: on a one-track recording the reviewer picks which voice ("Speaker 1"/"Speaker 2") is the agent; the other voice becomes the client, the choice is saved sealed with the transcript, and the call is scored again (old score kept as history). New route `POST /api/call-scoring/transcripts/:id/agent-speaker` (`routes/callScoring.ts`), `lib/callScoring/speakerRoles.ts` (pure logic), `speakerAssign.ts` (save + rescore + audit counts only), `components/call-scoring/SpeakerRoleControls.tsx`. Call detail now returns `transcript.speakers` and `speakerAssignedAt`. Also: roles that came with the file are never overridden; a rules-only call stays rules-only when re-scored; and a do-not-contact flag dismissed while the speaker was unknown is shown again once the app knows the client said it (client turns of a reviewer-assigned call get a `:client` fingerprint suffix; existing fingerprints and opt-outs are untouched). Each choice has its own random id, and the save and the score are guarded by a row lock plus that id, so two reviewers at once cannot leave a score that disagrees with the saved roles. If scoring again fails, the choice stays saved and the reviewer is told plainly (502 `rescore_failed`) to press the button again. No migration, no OpenAPI change. Doc: `docs/call-scoring.md`.
- **Verified:** `pnpm run typecheck` clean; `pnpm test` on the final code: 234 files / 2610 tests passed, including the new `call-speaker-roles` (unit), `call-scoring-agent-speaker` (integration: cross-org 404, viewer 403, audit has no words, concurrent choices, failed re-score, stale do-not-contact list) and `call-scoring-speaker-roles` (web) files. The first unit test was run and seen failing before the code existed. (Counts change with every follow-up; re-run `pnpm test` rather than trusting a number here.) NOT verified: against a real EnrollHere recording (no production access from this session). Two reviewers choosing at once: only the latest choice may save a score (409 `superseded` for the other).
- **Left undone / broken:** The owner reports messy transcripts generally ("none of it is clean and cohesive"); this button fixes WHO is speaking, not word accuracy or turn order. Suspected but unconfirmed: (a) stereo recordings get wrong turn start times in `resultsToTurns` (`lib/callScoring/speech.ts`: a turn's start is the previous end on the same channel, so turns can interleave wrongly); (b) `diarizationConfig` min/max speaker counts with `chirp_3` were not checked against Google's limits; (c) phone audio with `en-US` only. EnrollHere cannot export two-channel audio (owner, 2026-10-13), so recordings stay one-track.
- **Decisions made:** The app still never guesses the agent; a person chooses. Roles stay keyed on the voice label, so a correction is possible. No ADR.
- **Next agent should:** Get one real bad recording's transcript (owner pastes ~20 de-identified lines from the call page) and find out whether the words, the order, or the speaker split is wrong; then fix the cause (see suspects above). Do not read production transcripts without the owner's go-ahead (PHI).
- **Needs a human:** Owner: after deploy, open a one-track recording, press the agent button, and confirm the labels and score look right.

### 2026-10-13 — Invite "Accept" says Unauthorized: retry with fresh token + safe diagnostics — Claude Code — branch `claudemoogs/fix-agency-invite-clean`
- **Outcome:** partial (root cause NOT confirmed; mitigation and diagnostics implemented in the follow-up PR (not yet deployed))
- **Changed:** After PR #291 reached production (deploy run 128 succeeded), accepting an invite still showed "Unauthorized" for a freshly created account: the server's own check found no verified Clerk session. Code review found the accept path identical to `/auth/provision`, so the cause is runtime (token/host/session state). The accept page now retries once with a brand-new Clerk token (`getToken({skipCache:true})`) after a 1.5 s pause and, if still refused, shows plain words instead of "Unauthorized" and keeps the remembered link. The API logs a non-PHI warning (booleans: bearer header present, session cookie present, host) when it refuses.
- **Verified:** web tests for accept-invite and pendingInvite 31/31; API `invitations.test.ts` 25/25; `pnpm run typecheck` clean. NOT verified: that this fixes the live case (needs the owner to retry after deploy).
- **Left undone / broken:** If the retry does not help, read Cloud Run logs for "Invitation accept refused": `hasBearer:false` means the browser never got a token (possibly an incomplete Clerk session, e.g. a pending sign-in step), `hasBearer:true` means the server rejected it (key/host mismatch between browser and API). No Google Cloud credentials in the agent session, so logs were not read.
- **Decisions made:** none.
- **Next agent should:** read the log line above after the owner retries; then continue with the call-log import access request.
- **Needs a human:** Owner: retry the invite after deploy and report the message shown; someone with Google Cloud access can search the logs for "Invitation accept refused".

### 2026-10-13 — Fix agency invitations (last-seat accept, invite lost during sign-up) — Claude Code — branch `claudemoogs/fix-agency-invite-clean`
- **Outcome:** partial (code done, PR #291 open and awaiting review/merge)
- **Changed:** Two independent bugs. (1) The server counted an invitation's own reserved seat against the invitee, so accepting the invite that took an agency's last seat failed with 402; `requireSeat`/`countSeatsUsed` now exclude that invitation. (2) The invite link lived only in the page address, so sign-up (email verification in a new tab, MFA) dropped it and the new user landed on "Create your agency"; the link is now remembered in the browser (`web-app/src/lib/pendingInvite.ts`, bounded by the invite's real expiry) and the provisioning gate sends the person back to accept it. Review follow-ups: a temporary lookup failure (rate limit, server error, offline) keeps the link; only a dead link is forgotten; a "forget this invitation" option; clearing is token-specific.
- **Verified:** `pnpm run typecheck` clean; full local suite 231 files / 2545 tests passed before the review fixes; web tests for `pendingInvite` and `accept-invite` 29/29 after them. GitHub CI "typecheck + test" for the new commit: NOT yet verified at time of writing.
- **Left undone / broken:** If Morgan already created her own agency while stuck, accept returns 409 `already_provisioned`; moving an existing account between agencies touches tenant isolation and is NOT implemented. Open security review question on PR #291: the remembered link is a bearer token in browser storage and acceptance is not bound to the invited email address; escalated to the owner as a design decision.
- **Decisions made:** none (no ADR).
- **Next agent should:** get PR #291 merged after owner decides the email-binding question; then the call-log import access for super admins (options A/B/C put to the owner, awaiting answer).
- **Needs a human:** Morgan: (a) the exact error text she saw and whether she already created her own agency; (b) go-ahead on option A for super-admin call-log import and the size of the backlog. Owner answers recorded 2026-10-13: Google Cloud/AWS BAAs in place; no PHI ever in texts/emails; move to production ASAP; branch cleanup approved for today; audit-log reads of contact PHI approved (not yet built).

### 2026-10-12 — EnrollHere call-log CSV import into call scoring — Claude Code — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** done (pending PR review and deploy)
- **Changed:** #288 (every EnrollHere webhook value kept, encrypted) merged at `19be9a3`; production deploy run 38293119970 succeeded. New: **Call scoring > Add calls > Import an EnrollHere call log** takes the call-log CSV the owner exports from EnrollHere. Every column of every row is stored encrypted for 10 years (`integration_payloads`, source `enrollhere_call_log`). Calls with a recording and at least 60 s in call get a `call_recordings` row in new status `fetching` (migration `0073_call_recordings_fetching`); the transcription job downloads the audio from EnrollHere's signed Cloud Storage link (host/bucket allow-list, no redirects, 500 MB cap), then transcribes and scores it on IIA 2026 by default. Re-import is safe and retries expired links. Route `POST /api/call-scoring/enrollhere-call-log`. Docs: `docs/call-scoring.md`.
- **Verified:** `pnpm run typecheck` clean; `pnpm test` 230 files / 2529 tests passed; `node --test tests/*.test.mjs` 3 passed; `check:migration-journal` OK (75/75). New tests: API (13, incl. cross-org, agent 403, expired link and re-import, retry/give-up, daily cap, sweep) and web (3). The owner's example export parsed locally: 1 row, 133 columns, link accepted, 500 s, time converted. NOT verified: a real download from EnrollHere's bucket and a real transcription (needs production).
- **Left undone / broken:** No automatic twice-daily pull: a person exports and uploads the CSV. Mono transcription is assumed for EnrollHere recordings (not confirmed whether they are dual-channel). The webhook still stores `recordingUrl` unencrypted in activity metadata (pre-existing). Rejected (422) webhook deliveries still not stored.
- **Decisions made:** IIA 2026 is the default checklist for this import; calls under 60 s are stored but not scored; "Created At" read as America/Chicago. No ADR.
- **Next agent should:** Find out whether EnrollHere can schedule or email the call-log export (or has an API), then automate the twice-daily pull on top of `importCallLog`.
- **Needs a human:** Export and import the call log (same day, links expire). Confirm the export's time zone is Central. Raise `CALL_RECORDINGS_DAILY_LIMIT` if two exports exceed 300 scored calls a day.

### 2026-10-12 — Keep every EnrollHere call value in Mediflow — Claude Code — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** done (pending PR review and deploy)
- **Changed:** Owner asked that Mediflow be the home for all EnrollHere data (owner states BAAs are in place). Each accepted call webhook is now stored whole, encrypted, in new table `integration_payloads` (migration `0072_integration_payloads`), kept 10 years (`retain_until`). Admins/compliance can open it from the contact timeline ("Full EnrollHere record"); every view is audited (`view_integration_payload`) and not cached. New route `GET /api/integration-payloads/:id`. Docs: `docs/integration/enrollhere-webhook.md`. IIA scorecard PR #287 merged at `862f66f`, deploy run 38287471984 succeeded.
- **Verified:** `pnpm run typecheck` clean; `pnpm test` 228 files / 2513 tests passed; `node --test tests/*.test.mjs` 3 passed; `check:migration-journal` OK (74/74). New integration tests: encrypted storage of all fields incl. unmapped, dedupe on redelivery, audited admin view, agent 403, other-org 404.
- **Left undone / broken:** Rejected (422) deliveries are still not stored. Twice-daily EnrollHere CSV pull into call scoring not built yet (waiting on owner: CSV headers, whether recording links open without an EnrollHere login, pull times). Webhooks still go to GoHighLevel until Mediflow is added as a destination in EnrollHere.
- **Decisions made:** Full payloads use the existing PII key and CMS 10-year retention constant; viewing limited to `PHI_PRIVILEGED_ROLES`. No ADR.
- **Next agent should:** Build the CSV pull (Drive folder → recording download → transcription → IIA 2026 scoring), storing every CSV column in `integration_payloads` with `source = 'enrollhere_csv'`.
- **Needs a human:** Add Mediflow's webhook URL in EnrollHere; send the CSV headers (no real client rows); confirm pull times.

Newest first. Template in `AGENTS.md` §7.

### 2026-10-12 — Call scoring: IIA 2026 QA Compliance Scorecard (150 pts) — Claude Code — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** partial (PR open, awaiting CI and merge)
- **Changed:** New built-in checklist `iia-2026-qa`: the owner's IIA 2026 QA Compliance Scorecard (19 sections, 47 items, 150 points, pass at 120). Engine extensions, all opt-in per rubric: N/A earns full points (`naCredit: "full"`); auto-fail items are all-or-nothing (`allOrNothing`, partial grades refused by the API and hidden in the UI); conditional critical items (SNP, enrollment-only, TPV) are flagged to the AI, but a critical N/A always needs a person to confirm (`conditional`); each auto-fail item carries the scorecard's disposition wording (`autoFailNote`); the rubric's own outcome labels (PASS / FAIL – BELOW THRESHOLD / AUTOMATIC FAIL – NON-COMPLIANT). Totals now carry points earned/possible, and "meets standard" compares points rather than the rounded score (affects every rubric at the boundary: 79.6% no longer rounds up to a pass). Call view shows points, groups findings by section, and shows the auto-fail wording. Shared Medicare phrase patterns moved to `rubrics/patterns.ts` (Medicare rubric verified byte-identical). No migration.
- **Verified:** `pnpm run typecheck`; `npx vitest run` (228 files, 2512 tests), including new `iia2026.test.ts` (section subtotals match the scorecard, auto-fail set exact, N/A credit, points-based pass mark, all-or-nothing, conditional N/A), an API test (scorecard wording, partial refused on auto-fail items) and a web test.
- **Left undone / broken:** Most scorecard items need the AI reviewer or a person; with AI review off they read "Needs review". Script-specific phrase lists (e.g. the exact IIA red-text wording) can be tightened once real call transcripts are available.
- **Decisions made:** Kept the scorecard's call-order numbering as criterion ids (`1-2-recorded-line` …). A critical N/A always needs a person (review finding: a verbatim quote does not prove non-applicability); cost is a manual N/A confirmation on non-SNP / non-enrollment calls.
- **Next agent should:** get the PR merged, then score a few real IIA calls and tune phrase patterns against them.
- **Needs a human:** merge the PR; have compliance confirm the scorecard mapping (it reflects CMS guidance as of August 2026, per the scorecard).

### 2026-10-09 — CMS 2027 plan data loaded into production — Claude Code (via Desktop Commander on the owner's PC) — branch `claude/admiring-allen-b6wum5`
- **Outcome:** done
- **Changed:** Loaded the CMS 2027 plan benefit data into the production database (`mediflow-prod-db`) using a temporary Cloud Run job built from the live image (`mediflow-prod`, commit `410a7b4`), with the extract staged in a temporary private bucket. Executions: dry run `cms-pbp-import-9x2qs`, then real load `cms-pbp-import-t5vcj` (log line `LOADED — plan year 2027`). The job and bucket were deleted afterwards; the app's service, secrets and the existing buckets were not touched. Only the four `cms_plan_*` tables were written (public CMS data, no PHI).
- **Verified:** Dry run and real load both reported 6,300 plans, 125,383 county rows, 364 region rows (identical to the local PostgreSQL 16 test); the dry run also proved migration `0071` was live in production. Buckets after cleanup: `agencyportal-501523-mediflow-phi`, `run-sources-agencyportal-501523-us-south1` only. **NOT verified:** a direct row-count query against production (no query path from here); the job's own log is the evidence.
- **Left undone / broken:** Superseded 2026-10-14: the Quoting page now reads these tables (routes in `quotingPlans.ts`). `county_code` is CMS/SSA, not FIPS. The unzipped extract (`C:\Users\lang2\Downloads\pbp-2027-extract`) and a few `pbp-*.log` files remain on the owner's PC.
- **Decisions made:** none needing an ADR. Production DB stays private-IP only; no public access was opened. The production image already contains the importer, so future loads can reuse the same temporary-job method.
- **Next agent should:** build the read-only plans-by-county route (OpenAPI + `requirePermission`, add the tables to `GLOBAL_TABLES`), with an SSA-to-FIPS county crosswalk.
- **Needs a human:** nothing.

### 2026-10-09 — Resolve merge conflicts for CMS plan data — Copilot — branch `claude/admiring-allen-b6wum5`
- **Outcome:** done (current `main` merged into PR #283)
- **Changed:** Merged `main` at `f821a54` into #283, retained both branches' `docs/STATE.md` history, kept the CMS migration numbered `0071` after main's `0070`, and preserved the concurrent PR updates through `625b331`.
- **Verified:** Before preserving the concurrent importer follow-up, `corepack pnpm install --frozen-lockfile`; `pnpm --filter @workspace/scripts run check:migration-journal` (73 entries); `pnpm exec vitest run lib/db/src/cmsPlans artifacts/api-server/src/__tests__/guards/tenant-isolation.test.ts` (15 tests); and `pnpm run typecheck` passed. Node 22.23.3 was used although the repository targets Node 24. Main deploy run 37867735824 and CI run 37867735833 succeeded.
- **Left undone / broken:** CI has not yet run on the final combined PR head; CMS data remains unloaded to a real database.
- **Decisions made:** none
- **Next agent should:** verify PR #283 CI and mergeability after this commit is published.
- **Needs a human:** nothing

### 2026-10-09 — CMS 2027 plan benefit data: tables + importer — Claude Code — branch `claude/admiring-allen-b6wum5`
- **Outcome:** partial (code ready; data NOT yet loaded into any real database)
- **Changed:** New migration `0071_cms_plan_benefits` (4 global tables: plans, per-plan benefit JSON, plan-to-county, plan-to-region), loader `lib/db/src/cmsPlans/pbpImport.ts`, command `pnpm --filter @workspace/scripts import:pbp`, how-to in `docs/cms-plan-data.md`. The uploaded zip is CMS tab-delimited text, not JSON, and is not committed (252 MB). Employer-only plans (1,673) are skipped by default.
- **Verified:** loaded the real 2027 extract twice into a throwaway PostgreSQL 16 database: 6,300 plans, 377,453 section rows, 125,383 county rows, 364 region rows, ~320 MB, under a minute; dry run saves nothing. `npx vitest run lib/db/src/cmsPlans` (11 tests) and the tenant guard pass; `pnpm run typecheck` and `check:migration-journal` (72 entries) OK. Full `pnpm test`: 227 files, 2,496 tests passed locally after merging main.
- **Left undone / broken:** Superseded 2026-10-14: the Quoting page now reads these tables. `county_code` is CMS/SSA, not FIPS (needs a crosswalk to match client counties).
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
