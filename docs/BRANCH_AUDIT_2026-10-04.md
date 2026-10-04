# Branch audit — 2026-10-04

**Question answered:** which commits are not on `main`, and why?

**Short answer:** almost nothing of value. Of 156 remote branches, 93 add
nothing to `main` at all, and 62 more are already-landed work whose branch was
never deleted (this repo squash-merges, so Git still shows their original
commits as "not on main"). One branch carries genuinely unlanded work: the
open PR #272.

Snapshot: `origin/main` @ `f0195e0` (#271), taken 2026-10-04 ~15:00 UTC.
**It goes stale fast** — parallel agent sessions keep opening PRs and even
reuse merged branch names (during this audit `practical-thompson-09n6cr` and
`dreamy-ptolemy-2ho4s0`, classed "landed" below, received new commits and
became #273 and #275). Re-measure before acting. The per-branch list is in
[`BRANCH_AUDIT_2026-10-04.branches.tsv`](BRANCH_AUDIT_2026-10-04.branches.tsv).

## Result (buckets add up to 156)

| Bucket | Branches | Meaning | Safe to delete? |
| --- | ---: | --- | --- |
| A. Fully merged | 72 | 0 commits ahead of main. | **Yes.** |
| B. Content already on main | 21 | Has commits main lacks by hash, but a merge changes nothing (`git merge-tree` result equals main's tree). | **Yes.** |
| C. Reviewed, landed, then evolved | 62 | Work landed through a squash-merged PR; main has since changed those files, so a merge would conflict or re-add old lines. Each was checked by counting its added lines missing from main (almost always a few dozen of thousands) and, for the unusual ones, by hand. | **Very likely, but not proven per branch.** Verify the branch tip has no commits newer than its PR before deleting (see rule below), or get owner sign-off. |
| D. — (none) | 0 | No branch was found whose only copy of real work is unmerged and abandoned. | — |
| E. Open PR, unlanded | 1 | `claude/agencybridge-compliance-review-s3nc6l` = PR #272. | **No. Review and merge.** |

### Safe deletion rule

Delete a branch only if **either**:
1. `git rev-list --count origin/main..origin/<branch>` is `0`; **or**
2. `git merge-tree --write-tree origin/main origin/<branch>` prints exactly
   main's tree hash (`git rev-parse origin/main^{tree}`) — i.e. tree-neutral.

For bucket C, additionally confirm every commit ahead of main belongs to a PR
that landed (compare against `git log origin/main`, `git cherry -v`) — a PR
number appearing in main's log does **not** prove commits pushed after that
merge were also landed. Always run `git fetch --unshallow` first; a shallow
clone makes every result wrong.

## How this was measured (repeatable)

1. `git fetch --unshallow` — shallow clones inflate "ahead" counts to 400+.
2. `git rev-list --count origin/main..origin/<b>` — raw commits not on main.
3. `git cherry origin/main origin/<b>` — commits whose *patch* is not on main
   (over-reports under squash-merge).
4. `git merge-tree --write-tree` — does a merge change main's tree?
5. Count of the branch's added lines absent from main's current files.
6. Cross-check against the PR list. **Caveat:** the PR-list tool used here
   reported `merged: false` for every PR, and main's log only contains `(#N)`
   for some merges (e.g. #211 landed as commit `00e5ed9` with no number). Use
   GitHub's per-PR `merged_at` for authority, not these shortcuts.

## Work genuinely not on main

### PR #272 — `claude/agencybridge-compliance-review-s3nc6l` (open, merges cleanly)

Three commits, 7 files, +282/−31: call-recording hardening (bounded crash
retries, one rescore per checklist, refused audio deleted) with a 152-line
integration test; the `GHSA-vfj7-8cjw-p6xm` audit suppression; a small
`scripts/deploy/gcp-bootstrap.sh` change.

Why it matters: the `pnpm audit (moderate)` CI job is red on `main` solely
because of that advisory (`braces`, no patch, not reachable). Typecheck and
tests are green. Note the same suppression is also carried by #274 and #276
(identical lines; they merge cleanly together).

## Branches that look unlanded but are not

| Branch | Appears to be | Reality |
| --- | --- | --- |
| `fix/lead-contact-picker-help` (#211) | Unlanded lead-form help | **Merged** (GitHub: merged 2026-09-24, commit `00e5ed9`). Contact picker and `FieldHelp` tooltips are on main in `crm/LeadsTab.tsx`. An earlier draft of this audit wrongly called it closed-unmerged — that came from diffing against a bad merge base while the clone was shallow. |
| `claude/mediflow-audit-growth-vujlxd` (26 commits, PRs #191–#207) | Large unlanded Bedrock/audit/Cloud SQL batch | Every commit is patch-equivalent to something on main. Bedrock adapter, advisory fixes and Cloud SQL edition pin are on main. |
| `claude/mediflow-could-not-start-error`, `claude/medi-flow-could-not-start-error`, `claude/add-new-feature` | Stale-asset auto-reload fix missing | Present on main (`web-app/public/boot-diagnostics.js`, `App.tsx`, `ErrorBoundary.tsx`; 404 for missing hashed assets in `api-server/src/app.ts`). |
| `claudemoogs/agencybridge-reskin` (100 commits, 231 files) | Huge unlanded reskin | Landed as #235; ~131 of 30,677 added lines differ because main kept evolving. |
| June 2026 feature branches (`aep-cockpit`, `churn-risk-scoring`, `clawback-exposure`, `ctm-complaint-tracker`, `marketing-approval`, `agent-readiness-board`, `admin-live-queue`, `queue-wallboard`, `agent-leaderboard`, …) | Dozens of features missing | Every page and route exists on main; differences are later edits. |
| `claude/google-cloud-deployment-ml41c2` (#201) | Unlanded GCP path | GCP path is on main (ADR 0004, `scripts/deploy/gcp-*.sh`, `deploy-mediflow-gcp.yml`). One docs commit (`4536d8c`, repo-name casing for Workload Identity Federation) had been dropped; main still told operators to use the lowercase name. **Restored in this change.** |

## Obsolete by decision

- `copilot/copperlang2007mediflow` — one commit fixing the **Render** bootstrap.
  Render production deploy was deliberately disabled (#261: no BAA). Do not revive.

## Why the drift happened

1. **Squash-merge + never deleting branches.** The main cause of the scary numbers.
2. **Many parallel agent sessions** (`claude/*`, `claudemoogs/*`, `codex/*`,
   `copilot/*`, `cursor/*`) opening PRs from auto-named branches with no shared
   record of each other's work. Migration numbers collided repeatedly
   (renumbered to 0050/0051, 0061–0063; two `0064`s still exist).
3. **Intentional direction changes that left old docs behind:** OpenAI/Azure →
   Bedrock (ADR 0005); Railway/Render → GCP Cloud Run (ADR 0003/0004, #261);
   Clerk → Identity Platform (ADR 0006, proposed); "Mediflow" → "agencyBRIDGE" (#216/#235).
4. **Shallow clones** hid real history.
5. **Status docs written once and never refreshed** (`PRODUCTION_READINESS.md`
   was already corrected once for over-claiming).

## Recommended cleanup (owner decision — nothing was deleted)

1. Merge PR #272 (or #276, which carries the same suppression plus ADR 0007).
2. Delete buckets A and B (93 branches) using the rule above.
3. For bucket C, spot-check with the rule, then delete; or approve in bulk.
4. Turn on GitHub's **Automatically delete head branches**.
5. The existing `.github/scripts/nuke-branches.sh` has escaped quotes in its
   list and is untested — do not run it as-is.
