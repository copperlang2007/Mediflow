# Branch audit — 2026-10-04

**Question answered:** which commits are not on `main`, and why?

**Short answer:** almost nothing of value. Of 156 remote branches, 72 are fully
merged and 69 are *already-landed* work whose branch tip was never cleaned up
(this repo squash-merges, so Git still shows their original commits as "not on
main"). Only **one open pull request** and **one closed-unmerged UI polish PR**
carry real, unlanded work.

Audit base: `origin/main` @ `f0195e0` ("Statement ingest: fix four post-merge
review findings (#271)"). 666 commits on main, 272 pull requests ever opened
(PR numbers 19–272 are visible; #1–#18 predate the available history).

## How this was measured (so it can be repeated)

1. `git fetch --unshallow` first. A shallow clone makes every merge-base wrong
   and inflated the raw "ahead" counts to 400+ — do not audit from a shallow clone.
2. `git rev-list --count origin/main..origin/<branch>` — raw commits "not on main".
3. `git cherry origin/main origin/<branch>` — commits whose *patch* is not on
   main. Squash merges defeat this, so it over-reports.
4. `git merge-tree --write-tree origin/main origin/<branch>` — a merge that
   leaves main's tree unchanged means the branch adds nothing.
5. Per-branch count of added lines absent from main's current files, to tell
   "never landed" apart from "landed, then evolved".
6. Cross-check against the PR list: a PR whose number appears as `(#N)` or
   `Merge pull request #N` in main's log landed.

## Result

| Bucket | Branches | What it means | Action |
| --- | ---: | --- | --- |
| Fully merged (0 commits ahead) | 72 | Nothing unique. | Delete the branch. |
| Landed via PR, tip never deleted | 69 | Work is on main (often evolved since). Git shows old commits only because of squash-merge. | Delete the branch. |
| Content already on main, PR closed or merged by another route | 6 | A merge adds nothing to main. | Delete the branch. |
| **Open PR with unlanded work** | **1** | See below. | **Review and merge.** |
| **Closed unmerged, genuinely not on main** | **1** | See below. | Decide: revive or drop. |
| Obsolete by decision | 2 | Superseded by a later deliberate choice. | Delete the branch. |

## Work that is genuinely not on main

### 1. PR #272 — `claude/agencybridge-compliance-review-s3nc6l` (OPEN, merges cleanly)

Three commits, 7 files, +282/−31:

- Call-recording hardening: bounded crash retries, one rescore per checklist,
  refused audio is deleted (`lib/callScoring/recordings.ts`,
  `routes/callScoring.ts`, `workers/recordingsSweep.ts`) plus a 152-line
  integration test.
- **CI unblocker:** ignores advisory `GHSA-vfj7-8cjw-p6xm` (`braces` DoS, no
  patch published, not reachable) in `package.json`.
- `scripts/deploy/gcp-bootstrap.sh` change (+4).

**Why it matters now:** the `pnpm audit (moderate)` CI job is red on `main`
(last two commits) solely because of that advisory. Typecheck and tests are
green. Merging #272 should turn CI green.

### 2. PR #211 — `fix/lead-contact-picker-help` (CLOSED, never merged)

Five commits: contact picker on lead creation plus "what is this field?" help
tooltips in `crm/LeadsTab.tsx`, with tests. Main later gained a separate
`crm/CreateLeadDialog.tsx` (via #212) that does contact search but has no
field-help tooltips. Low-risk UX polish; revive only if wanted.

## Branches that look unlanded but are not

These raised false alarms and were checked individually.

| Branch | Appears to be | Reality |
| --- | --- | --- |
| `claude/mediflow-audit-growth-vujlxd` (26 commits, PRs #191–#207) | Large unlanded Bedrock/audit/Cloud SQL batch | Every commit is patch-equivalent to something on main. Bedrock adapter, advisory fixes and Cloud SQL edition pin are all on main. |
| `claude/mediflow-could-not-start-error`, `claude/medi-flow-could-not-start-error`, `claude/add-new-feature` | Stale-asset auto-reload fix missing | Present on main (`web-app/public/boot-diagnostics.js`, `App.tsx`, `ErrorBoundary.tsx`, and the 404-for-missing-hashed-asset behaviour in `api-server/src/app.ts`). |
| `claudemoogs/agencybridge-reskin` (100 commits, 231 files) | Huge unlanded reskin | Landed as #235. Only ~131 of 30,677 added lines differ, because main kept evolving (Dialer, softphone). |
| June 2026 feature branches (`aep-cockpit`, `churn-risk-scoring`, `clawback-exposure`, `ctm-complaint-tracker`, `marketing-approval`, `agent-readiness-board`, `admin-live-queue`, `queue-wallboard`, `agent-leaderboard`, …) | Dozens of features missing | Every page and route exists on main. Differences are later edits. |
| `claude/google-cloud-deployment-ml41c2` (#201) | Unlanded GCP path | GCP path is on main (ADR 0004, `scripts/deploy/gcp-*.sh`, `deploy-mediflow-gcp.yml`). One leftover docs commit (`4536d8c`, repo-name casing for Workload Identity Federation) had been dropped and main still told operators to use the wrong, lowercase name. **Restored in this change**; the branch can now be deleted. |

## Obsolete by decision

- `copilot/copperlang2007mediflow` — one commit that fixes the **Render**
  bootstrap. Render production deploy was deliberately disabled (#261: no BAA
  with Render). Do not revive.
- `claude/live-docker-instance-zykrpa` / demo-mode branches — local/demo
  tooling; landed.

## Why the drift happened (root causes)

1. **Squash-merge + never deleting branches.** The main cause of the scary
   numbers. 140+ branches survived their own merge.
2. **Many parallel agent sessions** (`claude/*`, `claudemoogs/*`, `codex/*`,
   `copilot/*`, `cursor/*`) each opening PRs from auto-named branches, with no
   shared record of what the others were doing. Migration numbers collided
   repeatedly (renumbered to 0050/0051, 0061/0062/0063 — visible in main's
   history).
3. **Intentional direction changes that left old docs behind:** Replit-era
   OpenAI/Azure assumptions → Bedrock (ADR 0005); Railway/Render → GCP Cloud
   Run (ADR 0003/0004, #261); Clerk → Identity Platform (ADR 0006, proposed);
   "Mediflow" → "agencyBRIDGE" naming (#235).
4. **Shallow clones.** The checked-out repo was shallow, hiding real history.
5. **Status docs written once and never refreshed** (see root-level markdown
   files; `PRODUCTION_READINESS.md` was already corrected once for over-claiming).

## Recommended cleanup (needs the repo owner — not done in this change)

1. Merge PR #272 (turns CI green).
2. Delete the 72 fully-merged branches and the ~75 landed/obsolete ones. Rule:
   delete when `git rev-list --count origin/main..origin/<b>` is 0, or when its
   PR number appears in main's log and the branch has no newer PR. The existing
   `.github/scripts/nuke-branches.sh` has escaped quotes in its list and is
   untested — do not run it as-is.
3. Turn on GitHub's **Automatically delete head branches** repo setting so this
   cannot recur.
4. Decide on #211 (revive or close for good).
