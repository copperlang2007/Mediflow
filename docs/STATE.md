# Project state ledger

The single source of truth for **what is true right now**. Read this before
starting work; update it before ending any session (rules: `AGENTS.md` §7).
Newest information first. If this file contradicts another doc, this file wins.

---

## Current state

_Last updated: 2026-10-04 — by the audit session below._

### Health dashboard

| Item | Status | Detail |
| --- | --- | --- |
| `main` HEAD | `f0195e0` (2026-10-03) | "Statement ingest: fix four post-merge review findings (#271)". |
| CI: typecheck + test | Green | |
| CI: `pnpm audit (moderate)` | **Red** | `braces` advisory `GHSA-vfj7-8cjw-p6xm`, no patch. Suppression is in PR #272. Red on the last two `main` commits. |
| CI: migration journal | Green | |
| Production deploy (GCP Cloud Run) | **Red** since 2026-10-02 | Step "Deploy to Cloud Run": `PERMISSION_DENIED secretmanager.versions.add` on `mediflow-twilio-api-key-secret`. Image build and push succeed. |
| Production ever verified live? | **Unknown / no evidence** | ADR 0004 still "Proposed"; `PRODUCTION_READINESS.md` says not deployed. |
| Real PHI allowed? | **No** | Not until production is verified and BAAs confirmed. |
| Open PRs | #272 | Call-recording hardening + the audit suppression. Merges cleanly. |
| Migration high-water mark | `0066_kb_library_statement_upload_guide` | Two files share `0064`. 69 SQL files. |
| Remote branches | 156 (excl. main) | 72 fully merged, ~75 landed-but-undeleted, 1 open PR. See branch audit. |

### Owner-only actions blocking progress

1. **Fix the deploy.** Someone with Google Cloud admin rights re-runs
   `scripts/deploy/gcp-bootstrap.sh` (it re-applies the IAM binding that lets
   the deploy account add secret versions). Use
   `GITHUB_REPO=copperlang2007/Mediflow` — exact casing.
2. **Merge PR #272** (turns CI green). Note it also edits
   `scripts/deploy/gcp-bootstrap.sh`; a small merge conflict with the casing
   fix from the 2026-10-04 audit PR is possible — resolve by keeping both.
3. **Confirm BAAs** (Google Cloud, AWS Bedrock, HighLevel, EnrollHere,
   DocuSign; check Twilio/Resend/Stripe) and record the outcome here.
4. **Turn on** GitHub setting "Automatically delete head branches".
5. Approve a branch cleanup (see audit). Existing
   `.github/scripts/nuke-branches.sh` embeds escaped quotes in its branch list
   and was not tested; do not run it as-is.

### Decided direction (do not reopen without an ADR)

GCP Cloud Run + Cloud SQL is production · Render forbidden for PHI · Railway is
demo only · Claude on Bedrock via Anthropic Messages API · MFA mandatory for all
· tenant isolation in app code with static guard (RLS is a later follow-up) ·
Scope of Appointment captured on call recording (no 48-hour wait enforced).

### Open questions

- Is the GCP project actually provisioned, and has any deploy ever succeeded?
- Clerk → Identity Platform: go or no-go? (ADR 0006, proposed). Production
  currently reportedly uses a Clerk **development-mode** key — verify before PHI.
- Revive PR #211 (lead field-help tooltips) or drop it?

### Known gaps

E-sign provider is Beta · contracting POA PDF is a placeholder · per-carrier
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

### 2026-10-04 — Branch audit, README, AGENTS.md, state ledger — Claude Code — branch `claudemoogs/focused-feynman-01k79k`
- **Outcome:** done (documentation only; no application code changed).
- **Changed:** Added `docs/BRANCH_AUDIT_2026-10-04.md`; rewrote `README.md` to
  reflect verified state; added `AGENTS.md`, `CLAUDE.md` and this file. Restored
  the dropped repo-name casing fix (`copperlang2007/Mediflow`) in
  `docs/DEPLOY_GCP_PRODUCTION.md` and `scripts/deploy/gcp-bootstrap.sh` (from
  unmerged commit `4536d8c`).
- **Verified:** Branch findings from full-history git analysis (`git fetch
  --unshallow`, `git cherry`, `git merge-tree`, PR-number cross-check against
  main's log) — 156 branches classified. CI and deploy failure causes read from
  the GitHub Actions job logs of runs `37174335043` and `37174335059`. Codebase
  facts from a read-only inventory of the repo at `f0195e0`; spot-checked
  migration count (69, duplicate `0064`) and script names. Shell syntax of
  `gcp-bootstrap.sh` checked with `bash -n`. **NOT verified:** that the app
  builds/tests pass on this branch (no code changed); BAA statuses (claims in
  docs only); whether the live GCP project exists.
- **Left undone / broken:** `main` CI red (audit job) and GCP deploy red (IAM) —
  neither fixed here; both need the owner/PR #272. No branches were deleted.
- **Decisions made:** none new.
- **Next agent should:** after the owner merges #272 and re-runs the bootstrap,
  confirm CI and one deploy go green, then promote ADR 0004 to Accepted and
  update the dashboard above.
- **Needs a human:** the five owner-only actions listed under "Current state".
