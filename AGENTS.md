# AGENTS.md — operating manual for AI agents

Applies to every automated contributor (Claude Code, Copilot, Codex, Cursor,
and any other). Humans may read it too. If this file and another doc disagree,
**this file and `docs/STATE.md` win; fix the other doc.**

## 0. The one rule that is never optional

> **Before you end any session — finished, blocked, or interrupted — you MUST
> add a dated entry to `docs/STATE.md` and update its "Current state" block if
> anything it says changed. Commit and push it. A session with code changes but
> no state entry is incomplete.**

Why: this repo had 150+ branches from parallel agent sessions that could not see
each other, duplicate migration numbers, and docs describing infrastructure that
had since changed. The state ledger is how the next agent (or the human owner,
who is non-technical) learns the truth in two minutes instead of two hours.
Details of the required entry are in §7.

## 1. What this project is

agencyBRIDGE (internal name **Mediflow**) is a multi-tenant Medicare agency
platform: CRM, agent onboarding/licensing, compliance, commissions, call queue
and softphone, AI assistance. It handles **PHI** (Medicare IDs, DOBs, health
data, call recordings). That makes compliance a first-class constraint, not a
nice-to-have. Read `README.md` for the overview and `docs/STATE.md` for what is
true *right now*.

Monorepo: `artifacts/api-server` (Express 5), `artifacts/web-app` (React 19),
`lib/db` (Drizzle + SQL migrations), `lib/api-spec` (OpenAPI → generated
clients). Node 24, pnpm 10 only.

## 2. Direction (where the project is headed)

In priority order. If your task conflicts with this list, stop and ask.

1. **Get production green and proven.** Merge PR #272, fix the GCP deploy IAM
   gap, run one successful deploy, then promote ADR 0004 to Accepted.
2. **Be HIPAA-defensible before adding features.** Confirm BAAs, keep PHI out of
   logs/Sentry/AI prompts, never weaken a boot guard.
3. **Harden the tenant boundary.** Row-level security is the planned follow-up
   to ADR 0002.
4. **Finish what is half-built** (Beta e-sign, real carrier paperwork templates,
   client portal logins) before starting new surfaces.
5. **Possibly migrate auth** Clerk → GCP Identity Platform (ADR 0006, proposed;
   do not start without the owner's go-ahead).

Direction already **decided** — do not reopen without an ADR:
GCP Cloud Run is production; Render is forbidden for PHI (no BAA); Railway is
demo only; Claude on Bedrock is the AI provider (Anthropic Messages API, not
OpenAI-shaped); MFA is mandatory for everyone; tenant isolation is application
enforced with a static guard.

## 3. Start-of-session checklist (5 minutes, every time)

```bash
git fetch --all --prune
git rev-parse --is-shallow-repository      # must print false; else: git fetch --unshallow
git log origin/main --oneline -15          # what landed since the last STATE.md entry?
```

1. Read `docs/STATE.md` — the "Current state" block and the last three log entries.
2. Check open PRs and whether someone else is touching your area. Do not start
   duplicate work; extend the existing branch/PR instead.
3. Check CI status of `main`. If it is red, say so in your first message and do
   not treat that as caused by you.
4. Work on the branch your task assigns. Never push to `main` directly.

**Never audit or reason about history from a shallow clone** — merge-bases are
wrong and "commits ahead" counts are wildly inflated.

## 4. Commands

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test                                    # vitest; PGlite in-memory DB
node --test tests/*.test.mjs
pnpm audit --audit-level moderate
pnpm --filter @workspace/api-spec run codegen   # after editing openapi.yaml
pnpm --filter @workspace/db run migrate
```

Run typecheck + the tests for the packages you touched **before every push**.
CI also runs `pnpm audit`; a new advisory fails the build.

There is no root `dev` script. API: `PORT=8080 DATABASE_URL=… pnpm --filter
@workspace/api-server run dev`. Web: `pnpm --filter @workspace/web-app run dev`.
Demo with no accounts: `docker compose up --build`.

## 5. Hard rules (violating any of these is a defect)

**Security and PHI**
- Never log, return, or send to Sentry/AI/analytics a Medicare ID, SSN, DOB,
  diagnosis, or recording content. Use the existing masking
  (`serializeContact`, `lib/phiAccess.ts`) and `sentryPhiScrubber`.
- Every org-scoped query/handler must filter by the caller's `orgId`. The static
  guard `tenant-isolation.test.ts` must stay green; do not add an allow-list
  entry to silence it without explaining why in the PR.
- Do not weaken, bypass, or add env switches around boot guards
  (`prodEnvGuard`, AI/storage/e-sign guards) or MFA enforcement.
- Never send real or realistic PHI to a provider without a confirmed BAA.
  Never use direct OpenAI, Render, or Railway for anything PHI.
- Never commit secrets, keys, tokens, or `.env` files. Reference env var
  **names** only. If you find a secret, report where it is; do not copy it.
- Do not disable or bypass `pnpm audit`. A suppression (`ignoreGhsas`) needs a
  written reason: why unreachable, and when to remove.
- Keep the 1-day `minimumReleaseAge` in `pnpm-workspace.yaml` (supply-chain defense).

**Code and data**
- **Migrations:** numbers collide when parallel sessions race (two `0064`s
  already exist). Immediately before generating one, `git fetch` and check the
  highest number on `origin/main` and in open PRs. Keep the Drizzle journal
  contiguous (`pnpm --filter @workspace/scripts run check:migration-journal`).
  Migrations must be idempotent and never drop a PHI column without an ADR.
- **API contract:** change `lib/api-spec/openapi.yaml`, then run codegen.
  Never hand-edit `generated/`. `lib/api-zod/src/index.ts` must remain exactly
  `export * from "./generated/api"`.
- **Authorization lives on the server.** Hiding a nav item is not access control.
  New routes need `requirePermission` and, for PHI, audit logging.
- Match surrounding style. No drive-by refactors in a feature PR.
- Tests: bug fix → a test that fails before the fix. New route → integration
  test including a cross-org denial case.

**Process**
- Never skip, delete, or `.skip` a test to get green. Never `--no-verify`.
- Never force-push or rewrite history on a shared branch.
- Never delete branches you did not create unless the owner asked (see §8).
- Never claim "done", "fixed" or "deployed" without evidence (command output,
  CI link). Say "unverified" when it is.
- Do not reopen decided direction (§2) by sneaking a different choice into a PR.

## 6. Naming and docs hygiene

- User-facing brand: **agencyBRIDGE**. Internal identifiers still using
  "Mediflow" (`mediflow-prod`, `X-MediFlow-*` headers, `mediflow:*` storage
  keys, `noreply@mediflow.app`, e-sign provider `mediflow`) are **load-bearing —
  do not rename without a migration plan.**
- GitHub repo slug is `copperlang2007/Mediflow` (capital M). Anything that
  compares it (Workload Identity Federation) is case-sensitive.
- When you change behavior, update the doc that describes it in the same PR.
  Known-stale: `docs/ARCHITECTURE.md` (says Azure OpenAI in prod; it is Bedrock),
  `PRODUCTION_READINESS.md` (dated 2026-06). Do not add new root-level
  markdown files; put docs in `docs/`. Record new architectural decisions as
  `docs/decisions/NNNN-title.md` (next free number — two files already share 0006).
- Write for a non-technical owner in summaries: plain words, what changed, what
  it means for her, what she must do (if anything).

## 7. End-of-session state note (MANDATORY)

Add the entry **at the top** of the "Session log" in `docs/STATE.md`, using this
exact template. Be factual; cite commit SHAs, PR numbers, run URLs.

```markdown
### YYYY-MM-DD — <short title> — <agent/tool> — branch `<name>`
- **Outcome:** done | partial | blocked | investigation-only
- **Changed:** <what, in plain words; PR/commit links>
- **Verified:** <exact commands/CI runs that prove it, or "NOT verified: why">
- **Left undone / broken:** <anything incomplete, red CI, known bugs>
- **Decisions made:** <and ADR link, or "none">
- **Next agent should:** <the single most valuable next step>
- **Needs a human:** <owner-only actions: secrets, IAM, BAAs, approvals; or "nothing">
```

Then, in the same commit, update the **Current state** block in `docs/STATE.md`
if any of these changed: main CI status, deploy status, open PRs, active
branches, decided direction, known gaps, migration high-water mark.

If you are about to run out of time or context, write the entry **first**, then
continue. An interrupted session with a state note beats a perfect one without.

## 8. Branch and PR hygiene

- One branch per task, named for the task. Open the PR (ready for review) as
  soon as you push; link related PRs.
- This repo **squash-merges**, so a merged branch still looks "ahead" of main.
  Do not treat that as unmerged work; see `docs/BRANCH_AUDIT_2026-10-04.md` for
  how to check properly (`git cherry`, `git merge-tree`, PR number in main's log).
- After your PR merges, delete your branch. (Owner action pending: enable
  GitHub's "Automatically delete head branches".) Existing cleanup scripts:
  `.github/scripts/delete-stale-branches.sh`, `nuke-branches.sh` — read them and
  get the owner's explicit approval before running either; `nuke-branches.sh`
  is destructive.
- Merge conflicts: merge `main` into your branch; do not rewrite shared history.
- Keep commits meaningful; the PR description says what and why, and states
  what was verified.

## 9. When to stop and ask the owner

Stop and ask (do not guess) if the task involves: real client data; a new data
vendor or AI provider; anything touching BAAs, MFA, boot guards or tenant
isolation; deleting data, columns or branches in bulk; infrastructure or IAM
changes; spending money; or reopening a decision in §2. The owner is
non-technical: state the question, the options, your recommendation, and the
cost of waiting.

## 10. Pointers

| Need | Read |
| --- | --- |
| What is true right now | `docs/STATE.md` |
| Overview, architecture, setup | `README.md` |
| Why decisions were made | `docs/decisions/` |
| Deploying to GCP | `docs/DEPLOY_GCP_PRODUCTION.md` |
| Integrations (GHL, Twilio, Drive, dialer) | `docs/integration/`, `docs/twilio-voice-setup.md`, `docs/call-scoring.md` |
| Branch history and why drift happened | `docs/BRANCH_AUDIT_2026-10-04.md` |
