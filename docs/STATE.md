# Project state ledger

The single source of truth for **what is true right now**. Read this before
starting work; update it before ending any session (rules: `AGENTS.md` §7).
Newest information first. If this file contradicts another doc, this file wins.

---

## Current state

_Last updated: 2026-11-20 — dashboard rows for main, CI and open PRs refreshed; AI workspace design proposed in PR #306 (docs only). Rows not listed as refreshed are unchanged since 2026-10-14 and were not re-checked._

### Health dashboard

| Item | Status | Detail |
| --- | --- | --- |
| `main` HEAD | `8e26ea6` (2026-11-09) | "Plan cards: fix review findings from #296 (#300)". Checked 2026-11-20. Re-check: this row goes stale within hours. |
| CI: typecheck + test | **Not running (2026-11-20)** | GitHub Actions refuses to start jobs: "The job was not started because your account is locked due to a billing issue." Seen on PR #306 (all four checks ended in under three seconds with no steps) and on scheduled runs on main since 2026-11-17. Owner must resolve billing in GitHub. The audit, migration-journal and deploy rows below were not re-checked and cannot run until then. |
| CI: `pnpm audit (moderate)` | **Green** — run 37867735833 on `f821a54` passed. Was red on main from 2026-10-08 when four advisories (proxy-addr critical, source-map-js high, fast-copy and postcss-selector-parser moderate) were published | `braces` advisory `GHSA-vfj7-8cjw-p6xm` is suppressed (landed in #272); see the exceptions register below. |
| CI: migration journal | Green | Run 37867735833 on `f821a54` |
| Production deploy (GCP Cloud Run) | **Green** at `f821a54` (run 37867735824), `d9ba459` (run 37861974648, 2026-10-08), `2a29f04` (run 37230136675) and `4911b43` (run 37229595531) | Red 2026-10-02 → 2026-10-04 because Secret Manager secrets `mediflow-twilio-api-key-secret` and `mediflow-statement-ingest-google-credentials` did not exist (the bootstrap was not re-run after they were added to the deploy script). Fixed 2026-10-04 by creating both as `unset` placeholders with the bootstrap's IAM bindings (run SA: secretAccessor; deploy SA: secretVersionAdder), with the owner's approval. The run SA was also granted Token Creator on itself (needed to sign recording upload links). |
| Production verified live? | **Partly** | A deploy succeeded and the post-deploy page check passed. Not confirmed: real-user login, Clerk production keys, the Google Cloud and AWS BAAs. ADR 0004 still "Proposed". |
| Real PHI allowed? | **No** | Not until production is verified and BAAs confirmed. Owner stated 2026-10-08 (not independently verified): Google Cloud and AWS BAAs are signed. Still open: Clerk production keys and real-user login check, and the Twilio live-call-audio position (owner: conduit, nothing stored or processed; needs compliance-advisor confirmation, recording must stay off). |
| Open PRs | Query GitHub live | As of 2026-11-20: #306 (AI workspace design, docs only) and Dependabot PRs #301 to #305. |
| Migration high-water mark | `0073_call_recordings_fetching` on main (landed with #289); `0074_user_identities` landed with #295 (main high-water mark is now 0074) | Two files share `0064`. Check `origin/main` and open PRs before numbering a new one. |
| Remote branches | 156 (excl. main), snapshot | 72 fully merged + 21 tree-neutral (safe to delete), 62 landed-then-evolved, 1 open PR. 72+21+62+1 = 156 at snapshot (two of the 72 were then reused for open PRs #273/#275 — never delete a head of an open PR). See branch audit and its `.tsv`. |

### Owner-only actions

1. Confirm the e-sign signing secrets hold real production PEMs. (How the deploy was fixed is now recorded in the health table.) The two placeholder secrets hold `unset`: put the real Twilio API key secret and statement-ingest Google credentials in Secret Manager when those features go live.
2. **Promote ADR 0004** to Accepted if you consider the production deploy proven; otherwise say what is still missing.
3. **Confirm the BAAs that are actually needed:** Google Cloud and AWS Bedrock (both receive PHI as built), and **Twilio for client calls** (live call audio, and recordings if enabled, carry health details; texts can be kept PHI-free but calls cannot). Not needed for Stripe, and probably not DocuSign (agent paperwork only). HighLevel/EnrollHere are the agency's own existing relationships. Resend depends on whether email bodies contain PHI. Decide with a compliance advisor and record the outcome here. **2026-10-08 (owner, unverified here):** Google Cloud and AWS BAAs signed long ago; owner says Twilio needs none because calls are not recorded and Twilio only carries the call (owner's conduit reasoning, unverified). Owner also states call recording and transcription do not go through Twilio. The code has two paths: (1) Twilio-side recording (`record="record-from-answer-dual"` in `lib/voice/twiml.ts`), OFF by default and would store PHI at Twilio if switched on; (2) uploaded recordings stored in Google Cloud with Google Speech-to-Text (`call_recordings`, `SPEECH_TO_TEXT_PROVIDER=google`), which falls under the Google BAA. Owner's statement matches path (2) only; path (1) must stay off. Open point for the compliance advisor: confirm the conduit position for live call audio, and keep recording off for INSUREitALL unless a Twilio BAA is in place.
4. **Finish the sign-in switch to Google Cloud Identity Platform** (ADR 0006, accepted): follow [`docs/AUTH_IDENTITY_PLATFORM.md`](AUTH_IDENTITY_PLATFORM.md) (re-run bootstrap, enable Identity Platform + email/password + TOTP, authorized domains, add GitHub secret `IDENTITY_PLATFORM_API_KEY`). The next deploy then switches; everyone creates a login with their same email. Afterwards delete the Clerk secrets and cancel Clerk.
5. **Turn on** GitHub setting "Automatically delete head branches".
6. Approve a branch cleanup (see audit: delete the 93 in buckets A+B, excluding any head of an open PR; spot-check the 62 in C). Existing `.github/scripts/nuke-branches.sh` embeds escaped quotes in its branch list and was not tested; do not run it as-is.
7. ~~Close #276~~ — already merged (CI: documented audit exception for braces); nothing to do.

### Security audit exceptions (`pnpm.auditConfig.ignoreGhsas` in `package.json`)

| Advisory | Package path | Why not reachable | Remove when |
| --- | --- | --- | --- |
| `GHSA-86w9-cpqp-85rv` | `node-forge` | E-sign CMS signature verification now uses `node:crypto`, not the node-forge RSA verifier (PR #258; commit "Verify e-sign CMS signatures with node:crypto"). | node-forge is upgraded or dropped. |
| `GHSA-vfj7-8cjw-p6xm` (`braces` ReDoS-style DoS, no patched release) | `mockup-sandbox > fast-glob > micromatch > braces` (development only; the API path via `http-proxy-middleware` was removed with Clerk on 2026-10-14) | `braces` expands glob *patterns*, never request data; the sandbox's patterns are fixed in code. ADR 0007. | A patched `braces` ships, or the mockup sandbox stops using `fast-glob`. |

### Decided direction (do not reopen without an ADR)

GCP Cloud Run + Cloud SQL is production · Render forbidden for PHI · Railway is
demo only · Claude on Bedrock via Anthropic Messages API · MFA mandatory for all
· tenant isolation in app code with static guard (RLS is a later follow-up) ·
Scope of Appointment captured on call recording (no 48-hour wait enforced).

**Pending owner decisions, not yet accepted in this repo (see the 2026-11-20
session entry):** move production to AWS + Neon (owner stated 2026-11-19; no
ADR yet), and open-weight models on Bedrock behind a model gateway (ADR 0008,
Proposed). Until an ADR is accepted, the line above is what the code does.

### Open questions

- Is the GCP project actually provisioned, and has any deploy ever succeeded?
- Clerk → Identity Platform: **go** (owner, 2026-10-14; ADR 0006 accepted). Code done; waits on the owner setup in `docs/AUTH_IDENTITY_PLATFORM.md`.
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

### 2026-11-20 — AI workspace product design (docs only) — Claude — branch `claude/hipaa-workspace-design`
- **Outcome:** investigation-only (design and build plan proposed; no code, no cloud changes)
- **Changed:** added `docs/product/DESIGN.md`, `docs/product/BUILD_PLAN.md`, ADR 0008 (open-weight models on Bedrock behind a model gateway, Proposed) and ADR 0009 (staged learning; pooled training on customer data blocked, Proposed). Owner decisions recorded there: sell agencyBRIDGE as a HIPAA-covered AI workspace for Medicare agencies, $75 to $100 per user per month, first outside agency paying by 2027-01-19.
- **Verified:** read this repo at `8e26ea6` and myCALL at `c7a2f0b`; listed the Neon organization (HIPAA projects `agencybridge`, `mediflow-canonical`, `iia-workspace`, `iia-retention` exist, all reporting zero stored data); open PRs on GitHub are Dependabot only (#301 to #305). Unit-economics arithmetic was run by script. NOT verified: anything in AWS (no credentials in this session), the Bedrock open-weight catalog in the owner's account, per-model HIPAA eligibility, and no model evaluations were run. Prices are from public listings read 2026-11-20.
- **Left undone / broken:** the move to AWS + Neon that the owner decided on 2026-11-19 has not started in this repo (no ledger, no AWS deploy script, no ADR); `AGENTS.md` section 2 and "Decided direction" above still say Google Cloud and Claude-only. They were left unchanged because ADRs 0008 and 0009 are only Proposed, and merging PR #306 does not accept them: acceptance is a separate change that sets the ADR status to Accepted and updates `AGENTS.md` section 2 and "Decided direction" together.
- **Review follow-up (same day):** the design first described the prompt rule as "no more PHI than the task needs"; that is weaker than `AGENTS.md` section 5. Corrected: the structural exclusion stands, and the conflict with call grading (transcripts are recording content) is now an open owner decision (A6), not a silent change. A second automated review raised ten points, all applied: model BAA confirmation and audit checks added to the phase gates, Phase 0 deliverables spelled out, retention and risk-assessment gates added, ADR 0008 and 0009 tightened, and a pending-decision note added under "Decided direction". A third pass added five more: the redaction option for call grading is marked unproven, the fifth AI call site (`lib/callScoring/aiReviewer.ts`) is in the gateway inventory, de-identification must be tested per data type, the ADRs state that merging does not accept them, and the dashboard rows above were refreshed. A fourth pass (Sourcery, 15 points; three already fixed) added: Phase 0 waits for an accepted hosting ADR and lists its PHI gates, existing myCALL data must be migrated and reconciled, job workers must run independently of a scale-to-zero API, row-level security needs a non-bypassing database role and per-request organization context, myCALL's do-not-contact findings must reach the existing queue, myCALL calls models through the gateway, and two more owner decisions (A7 sign-in system, A8 priority order against `AGENTS.md` section 2). A fifth pass added: agencyBRIDGE's own Google Cloud data must be migrated and reconciled before cutover, and background jobs must carry their agency and run under the same restricted database role. A sixth pass added a write freeze (or snapshot plus replayed changes) to the data migration and made the executed AWS and Neon BAAs a precondition for copying any data. CI on PR #306 did not run: GitHub reports the account is locked for a billing issue (all jobs ended in under three seconds with no steps).
- **Decisions made:** none accepted; ADR 0008 and ADR 0009 proposed.
- **Next agent should:** write the AWS + Neon hosting ADR and get the owner to accept it. No migration work before that; no workspace features before the Phase 0 PHI gates pass.
- **Needs a human:** review and merge or correct this PR; engage a HIPAA attorney; confirm with AWS which open-weight Bedrock models the BAA covers; decide per-user pricing and whether myCALL becomes the only call grader (assumptions A2 and A3 in the design).

### 2026-11-09 — Plan cards: review follow-ups (wrong prices, stale compare, labels) — Claude Code — branch `claude/admiring-allen-b6wum5`
- **Outcome:** done (pending CI/review)
- **Changed:** Follow-up to merged PR #296, fixing what its reviewers found. Cards now show "See details" instead of a partial price when copay and coinsurance both apply but only one is readable, when a min–max range is missing a bound, when a hospital interval is half-filled, or when copay and coinsurance both apply to a hospital stay. Any $0- or 0%-leading cost (copay, range, coinsurance, hospital) is no longer shown for a plan that has, or is flagged as having, a medical deductible (the per-service deductible flags are not read). Page: picked plans that a search removes are forgotten (bar, 4-plan limit and Compare agree); the Plan type menu stays while a type is chosen; giveback sort puts plans with no data last; picks and the dialog are also cleared when a search returns no plans or fails. Premium wording now says "health plan premium" on the filter, sort, badge and compare note.
- **Verified:** `pnpm run typecheck` clean; `planCard.test.ts`, `quoting-plans.test.ts`, `plan-cards.test.tsx` 59 tests pass; the two new page-flow tests fail on the old page code and pass on the new. NOT verified: against the production database; full `pnpm test` (CI will run it).
- **Left undone / broken:** (1) SNP code map (1 Institutional, 3 Dual-Eligible, 4 Chronic) was checked against the CMS dictionary in the earlier session but NOT re-checked now (raw CMS files are not on this machine): re-check before relying on the Medicaid note. (2) The `/quoting/plans` routes were never in `lib/api-spec/openapi.yaml` (web uses hand-written types); bringing them under the contract is a separate change. (3) A blank/missing plan deductible flag is treated as "no deductible"; whether that is right needs the CMS dictionary. Per-service deductible flags and more than 3 hospital day intervals are not read. (4) Part D premium, stars, networks, formularies still not loaded.
- **Decisions made:** relabel premium wording as "health plan premium" instead of hiding drug-coverage plans; none (no ADR).
- **Next agent should:** load CMS Landscape + Star Ratings for the Part D premium and stars, then compute a true combined premium.
- **Needs a human:** compliance sign-off on card wording (CMS marketing rules) before agents show cards to beneficiaries; confirm the SNP code map against the dictionary.

### 2026-10-14 — Sign-in follow-up: invitation email must match, no duplicate sign-ups — Claude Code — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** done (in review)
- **Changed:** #295 merged (`99ca2e9`) about 20 minutes before the third round of review fixes was pushed, so they are in this follow-up PR. (1) Accepting an invitation now requires the signed-in, verified email to be the invited address (403 `email_mismatch`). This was not checked under Clerk either: a forwarded or leaked link alone took the seat. (2) Create-your-agency takes a per-email lock and re-checks under it, so two simultaneous sign-ups with one email cannot create two agencies. (3) The Clerk-era account match uses a literal `user_` prefix (`starts_with`); in `LIKE`, `_` matched any character. Runbook: invitees must sign up with the invited address.
- **Verified:** `pnpm run typecheck` clean; `pnpm test` 2714 passed; `pnpm audit --audit-level moderate` (2 ignored); braces guard passed. New tests: wrong-email accept refused, then the right one accepted; simultaneous sign-ups give one 201 and one 409; `userX…` not linked (this one fails on the old `LIKE`). The race test runs on single-connection PGlite, so it checks the outcome, not a true interleaving.
- **Left undone / broken:** a real Identity Platform sign-in is still unverified (owner setup pending). No in-app tool to reconnect a login to an existing account (support SQL procedure in the runbook).
- **Decisions made:** an invitation is bound to its address, not just its link.
- **Next agent should:** after the owner switches, follow the runbook's post-switch 15-minute check.
- **Needs a human:** the owner setup in `docs/AUTH_IDENTITY_PLATFORM.md`. Decide whether agency staff should get an in-app "reconnect login" tool.

### 2026-10-14 — Sign-in moved from Clerk to Google Cloud Identity Platform — Claude Code — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** done in code; production switch waits on owner setup.
- **Changed:** Owner said "complete the crossover to google auth and eliminate clerk". ADR 0006 → Accepted, implemented:
  - **API:** `lib/auth/identity.ts` verifies Identity Platform ID tokens (Bearer or `__session` cookie) with `jose` against Google's keys, issuer and audience. `lib/auth/users.ts` maps sign-ins to users via new table `user_identities` (migration `0074`). Clerk-era accounts link once by **verified** email. Create-your-agency and invitation accept now require a verified email, taken from the token. MFA comes from the token's second-factor claim. Admin session list/revoke/force-logout now use `session_activity`, plus Identity Platform refresh-token revocation. Boot refuses production without a project id. Clerk middleware, proxy, CSP hosts, `@clerk/*` and `http-proxy-middleware` removed.
  - **Web:** `@firebase/app` + `@firebase/auth` (not the `firebase` bundle, which pulls a vulnerable gRPC). New screens: sign-in (password, then authenticator code), create login + email verification, password reset, authenticator setup with QR, account security (replace authenticator, change password). Same-origin `__session` cookie kept fresh. `@clerk/*` and demo shims removed.
  - **Deploy:** workflow and `gcp-deploy.sh` take `IDENTITY_PLATFORM_API_KEY` (+ optional auth domain) instead of Clerk keys; bootstrap enables the Identity Toolkit API and grants the run SA *Firebase Authentication Admin*. The deploy gate skips (green) until that secret exists, so production keeps the last Clerk build until then.
  - **Review fixes (PR review round 1):** an ended session can no longer come back. The session-activity write is conditional (another server's revoke or timeout is never overwritten). Revoked rows are kept for the full 30 days. Sign-ins older than 30 days are refused. A stale `__session` cookie next to the current one is skipped. The browser SDK no longer loads the popup iframe the CSP blocks on Safari. Replacing the authenticator now sets up the new one before removing the old. Create-your-agency now refuses (409 `account_exists`) when the email already belongs to an account the sign-in could not be linked to, instead of silently making a second agency. The browser renews its sign-in token every 10 minutes (and before each export download), so exports and deletions no longer fail the 15-minute security re-check for most of each hour.
  - **Review fixes (round 2):** the revoke guard compares against the database clock. A busy session is re-read once a minute again, instead of on every request. Token age is timed by the page itself, so a wrong computer clock no longer matters. A failed removal of the old authenticator is now reported instead of claimed as done. The login-history export renews the sign-in first. The "account already exists" message now points to support, and the runbook has the support procedure for connecting a login to an existing account. Merged `main` (CSP conflict; two new tests moved to the identity mock).
  - **Docs:** new `docs/AUTH_IDENTITY_PLATFORM.md` (owner runbook); README, ARCHITECTURE, DEPLOY_GCP_PRODUCTION, AGENTS direction, ADR 0006/0007, e2e and load-test READMEs updated.
- **Verified:** `pnpm run typecheck` clean; `pnpm test`; `node --test tests/*.test.mjs`; `check:migration-journal` (76/76 with the duplicate 0064); `pnpm audit --audit-level moderate` (2 ignored, 0 open). New tests: API token verification with real RS256 keys (issuer/audience/expiry/forgery), cookie vs header, verified-email linking rules, provisioning/accept require verified email, admin revoke/force-logout incl. cross-org; web sign-in with TOTP step, redirect safety, AuthProvider cookie, MFA gate hand-off, invite verify-email step. Production web build succeeded. NOT verified: a real sign-in against Identity Platform (not configured yet; no GCP access in this session).
- **Left undone / broken:** Render (`render.prod.yaml`, `scripts/deploy/render-deploy.mjs`; Render is forbidden for PHI) and `scripts/src/seed-demo.ts` still name Clerk keys; the two boot guards (`prodEnvGuard`, seed-demo) still flag live Clerk keys on purpose (not weakened). Clerk password hashes are not imported: users create a login again with the same email.
- **Decisions made:** ADR 0006 accepted and implemented (see its Implementation section); verified-email one-time link for Clerk-era accounts; TOTP only (no SMS); session id = identity + sign-in time.
- **Next agent should:** after the owner's setup and the first deploy, sign in end to end (create login → verify → authenticator → sign in again) and run the e2e auth test with a test login; then delete Clerk secrets.
- **Needs a human:** the steps in `docs/AUTH_IDENTITY_PLATFORM.md` (Identity Platform setup, TOTP switch, authorized domains, `IDENTITY_PLATFORM_API_KEY` secret, re-run bootstrap, confirm Identity Platform under the Google BAA).
### 2026-10-14 — Recording player: honest message when playback fails — Claude Code — branch `claudemoogs/recording-player-message` (PR #298)
- **Outcome:** done
- **Changed:** follow-up to #297 (merged as `c37dadb` just before this fix was pushed). `RecordingPlayer.tsx` no longer guesses whether a playback error is an unsupported format: browsers raise the same `MediaError` code 4 for a bad format and for a 403/404/expired link, and a MIME alias list can never be complete (four review rounds each found more types). Every playback error now shows one honest message: it could not be loaded, usually because the ten-minute link ended, but it can also be an audio format the browser cannot decode; press Listen again, and if it fails again ask the agency admin. A signing or CSP mistake is therefore never mislabelled as a bad file.
- **Also changed (server):** a storage failure while opening a recording now writes one fixed warning to the server log ("call recording storage unavailable" with the recording id and step only; never the error, object key or URL), so outages are visible. The log-capture test asserts that line is captured and that the object key is absent. Both steps (`metadata` and `sign`) have a test that captures the log and asserts the line is present and the object key absent. The same tests count error-level/fatal log calls (what the global error handler writes): 0 for both storage-failure steps, and at least 1 for the audit-insert failure (positive control, proving the counter sees handler output when a failure does reach it).
- **Verified:** on the simplified player at `d775e5e` (the code in this PR; later commits touch only `docs/STATE.md`): player tests 8/8, `pnpm --filter @workspace/web-app run typecheck` clean, full `pnpm test` 240 files / 2683 tests passed. Earlier commits on this branch (`f5d19bd` with 10 player tests, `abf86c9`/`d244bc5` storage-failure log line with 15 playback tests) were verified separately at the time but are superseded by this run for the player; the server-side playback tests (15/15) are included in the 2683. Nothing was tried against a real recording.
- **Also changed (UI, after `d775e5e`):** a new Listen press now clears the old "press Listen again" notice (`onMutate: setLinkEnded(false)`), so a refused retry no longer shows two conflicting alerts. Verified at the commit after `07e4f3a`: player tests 9/9, web typecheck clean, full suite run before pushing.
- **Left undone / broken:** same follow-ups as the #297 entry below (no-store on recording objects, index on `call_recordings`, link refresh on long calls, OpenAPI, agent access to EnrollHere recordings). Still not tried on a real recording.
- **Decisions made:** none
- **Next agent should:** see the #297 entry below.
- **Needs a human:** Michael to review, merge and deploy; Morgan to press Listen on a real call.

### 2026-10-14 — Resolve plan-card branch merge conflict — GitHub Copilot — branch `claude/admiring-allen-b6wum5`
- **Outcome:** done
- **Changed:** merged main `c37dadb` into PR #296 in commit `06d97d6`; the only conflict was this ledger. Preserved the plan-card and recording-playback session entries and both branches' application changes. Initial publishing was rejected by GitHub (`GH013`); the subsequent publish succeeded, verified with `git ls-remote` at `757a754`.
- **Verified:** `pnpm install --frozen-lockfile`; `pnpm run typecheck`; `pnpm test artifacts/api-server/src/__tests__/unit/planCard.test.ts artifacts/api-server/src/__tests__/integration/quoting-plans.test.ts artifacts/web-app/src/__tests__/plan-cards.test.tsx artifacts/api-server/src/__tests__/integration/call-scoring-playback.test.ts artifacts/api-server/src/__tests__/integration/csp-media-src.test.ts artifacts/web-app/src/__tests__/call-scoring-recording-player.test.tsx` (6 files, 72 tests passed); `git diff --check`. Main deploy [38630478548](https://github.com/copperlang2007/Mediflow/actions/runs/38630478548) passed; main CI [38630478682](https://github.com/copperlang2007/Mediflow/actions/runs/38630478682) is in progress.
- **Left undone / broken:** full suite and production behavior not rechecked in this merge-only session; existing review suggestions remain outside this request. Automated review unavailable; independent read-only merge review found no significant issues. CodeQL skipped the documentation-only resolution.
- **Decisions made:** none.
- **Next agent should:** review and merge PR #296 once checks pass.
- **Needs a human:** review plan-card wording for CMS marketing-rule compliance before use with beneficiaries.

### 2026-10-14 — Plan cards on the Quoting page (decoded premium, costs, extras, compare) — Claude Code — branch `claude/admiring-allen-b6wum5`
- **Outcome:** done (code); not yet seen by real users until merged and deployed
- **Changed:** `GET /quoting/plans` now returns a decoded `card` per plan (and `/quoting/plans/:bidId` returns one) from new `lib/planCard.ts`; the Quoting page shows plans as cards with filters (premium, drugs, dental, vision, hearing, OTC, fitness, Part B giveback), sort, plan-type filter, "lowest here" badges and a side-by-side compare of up to 4 (`components/quoting/*`). Also fixes the special-needs type showing as a CMS code ("3") instead of words ("Dual-Eligible").
- **Verified:** `pnpm run typecheck` clean; new tests `planCard.test.ts` (real 2027 plans, hand-checked), `quoting-plans.test.ts`, `plan-cards.test.tsx`; rendered in the demo build at 375/768/1440 px with real 2027 plan data, no horizontal overflow, compare dialog checked. Full `pnpm test`: 237 files / 2,659 tests passed. **NOT verified:** against the production database (the card query runs on PGlite in tests and on local PostgreSQL 16 data, not on Cloud SQL).
- **Left undone / broken:** The CMS plan benefit file has no Part D premium, star ratings, provider networks or formularies, so cards show the health plan premium only and say so. PDP and Medigap plans are not covered. ZIP search still needs a ZIP→county lookup. Medical deductible shows only when CMS states it (most plans leave it blank).
- **Decisions made:** conservative decoding: anything unreadable shows "See details" instead of a guessed number (see `docs/cms-plan-data.md`, "Plan cards").
- **Next agent should:** load the CMS Landscape and Star Ratings files (Part D premium, stars) so cards can show a true total premium and star rating; then ZIP→county search.
- **Needs a human:** review the card wording for CMS marketing-rule compliance before agents show it to beneficiaries.

### 2026-10-14 — Call scoring: listen to the recording — Claude Code — branch `claudemoogs/call-recording-playback-v2` (PR #297)
- **Outcome:** done (code); not tried against real audio
- **Changed:** call page has a "Listen to the recording" button (`GET /api/call-scoring/transcripts/:id/audio`): 10-minute private link, link signed first, then the listen logged, then the link returned (a signing failure leaves no audit row; a log failure gives no link), `no-store` on every answer including auth refusals, plain 503 when storage fails (error never echoed or logged), no download control. Reviewers hear any call in their agency. Agents hear only a recording whose OWN call session they placed (`ownRecordingCondition`), because identical speech makes two recordings share one transcript; so agents cannot hear EnrollHere-imported recordings (no session on the row). CSP `media-src` now allows `https://storage.googleapis.com`. Player says plainly when the browser cannot play the format (MediaError code 4). See `docs/call-scoring.md`.
- **Verified:** `pnpm run typecheck` clean; `pnpm test` 238 files / 2642 tests pass at 430b074; player tests 8/8 after 58dc336. NOT verified: any real EnrollHere recording.
- **Left undone / broken (follow-ups):** recording objects have no `Cache-Control` metadata (needs both upload paths plus a backfill); no index on `call_recordings(org_id, transcript_id, status)` (needs a migration; check the highest number first); endpoint not in `openapi.yaml` (call-scoring routes are not in it at all); links expire mid-listen on calls over 10 minutes (seeking then fails; refresh the link and restore position); `GET /call-scoring/recordings` uses the `create` permission with org-only scope, so agents may list other agents' recording metadata (unverified). A pasted sample showed a scored recording with only one speaker's words auto-failing every agent-script item instead of going to "needs review"; not yet diagnosed.
- **Decisions made:** none (no ADR).
- **Next agent should:** find why a scored recording can contain only one speaker's words and why that fails closed to auto-fail instead of "needs review".
- **Needs a human:** Michael to review, merge and deploy; Morgan to press Listen on a real call afterwards. Decide whether agents should hear their own EnrollHere recordings.

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
