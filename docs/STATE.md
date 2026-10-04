# Project state ledger

The single source of truth for **what is true right now**. Read this before
starting work; update it before ending any session (rules: `AGENTS.md` §7).
Newest information first. If this file contradicts another doc, this file wins.

---

## Current state

_Last updated: 2026-10-04 — by the call-recordings follow-up session below._

### Health dashboard

| Item | Status | Detail |
| --- | --- | --- |
| `main` HEAD | `2a29f04` (2026-10-04) | "Add policy … (#275)". Re-check: this row goes stale within hours. |
| CI: typecheck + test | Green | |
| CI: `pnpm audit (moderate)` | Green at `4911b43` | `braces` advisory `GHSA-vfj7-8cjw-p6xm` is suppressed (landed in #272); see the exceptions register below. |
| CI: migration journal | Green | |
| Production deploy (GCP Cloud Run) | **Green** at `2a29f04` (run 37230136675) and `4911b43` (run 37229595531) | Red 2026-10-02 → 2026-10-04 because Secret Manager secrets `mediflow-twilio-api-key-secret` and `mediflow-statement-ingest-google-credentials` did not exist (the bootstrap was not re-run after they were added to the deploy script). Fixed 2026-10-04 by creating both as `unset` placeholders with the bootstrap's IAM bindings (run SA: secretAccessor; deploy SA: secretVersionAdder), with the owner's approval. The run SA was also granted Token Creator on itself (needed to sign recording upload links). |
| Production verified live? | **Partly** | A deploy succeeded and the post-deploy page check passed. Not confirmed: real-user login, Clerk production keys, BAAs. ADR 0004 still "Proposed". |
| Real PHI allowed? | **No** | Not until production is verified and BAAs confirmed. |
| Open PRs | Query GitHub live | At 2026-10-04 ~19:45 UTC: #273 (platform revenue overview), #274 (this docs PR), #275 (add-policy form), #276 (audit exception + ADR 0007 — now redundant with #272). #272 merged. #273/#275 came from other sessions after the audit began and were not reviewed here. |
| Migration high-water mark | `0067_kb_library_policies_guide` on main; `0068_call_recordings_cleanup` in open PR #277 | Two files share `0064`. Check `origin/main` and open PRs before numbering a new one. |
| Remote branches | 156 (excl. main), snapshot | 72 fully merged + 21 tree-neutral (safe to delete), 62 landed-then-evolved, 1 open PR. 72+21+62+1 = 156 at snapshot (two of the 72 were then reused for open PRs #273/#275 — never delete a head of an open PR). See branch audit and its `.tsv`. |

### Owner-only actions

1. Confirm the e-sign signing secrets hold real production PEMs. (How the deploy was fixed is now recorded in the health table.) The two placeholder secrets hold `unset`: put the real Twilio API key secret and statement-ingest Google credentials in Secret Manager when those features go live.
2. **Promote ADR 0004** to Accepted if you consider the production deploy proven; otherwise say what is still missing.
3. **Confirm BAAs** (Google Cloud, AWS Bedrock, HighLevel, EnrollHere, DocuSign; check Twilio/Resend/Stripe) and record the outcome here.
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

### 2026-10-04 — Call recordings: fix review findings left open at #272 merge — Claude Code — branch `claude/agencybridge-compliance-review-s3nc6l`
- **Outcome:** partial (PR #277 open, awaiting CI and merge)
- **Changed:** PR #277. Confirm at the daily limit can no longer delete audio a concurrent confirm already accepted; unused audio (refused, oversized, abandoned) is deleted durably after its upload link expires, with backoff retries (`purge_after`, `purge_attempts`); the daily cap counts from confirm (`committed_at`); a duplicate recording rescores when the call's newest score is under another checklist, one job at a time per call (`call_score_claims`), and a job whose claim was taken over cannot save. Migration `0068_call_recordings_cleanup`. Earlier the same day: created the two missing Secret Manager secrets and the Token Creator grant (production deploys green since).
- **Verified:** `pnpm run typecheck`; `npx vitest run` (225 files, 2480 tests); `check:migration-journal` OK (70 entries). Deploy runs 37229595531 and 37230136675 green.
- **Left undone / broken:** #277 not merged. Live-transcription Chrome extension (private Chrome Web Store listing) not started.
- **Decisions made:** no unique index on `call_scores(transcript_id, rubric_id)` — rescore history must be kept; concurrency is handled by the claim row plus an in-transaction ownership check.
- **Next agent should:** get #277 green and merged, then build the live-transcription extension.
- **Needs a human:** merge #277; optional Speech-to-Text billing alert amount; real values for the two placeholder secrets when Twilio API-key auth / statement ingest from Drive go live.

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
