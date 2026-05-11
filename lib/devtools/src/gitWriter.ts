/**
 * Git writer for the AI Feature Builder.
 *
 * Wraps the small set of git operations the Feature Builder needs to take
 * a generated plan + file contents and turn it into a pull request on
 * GitHub for human review:
 *
 *   1. Branch off `main` into `claude-dev/<branchSlug>`.
 *   2. Write each generated file to its target path (creating parent
 *      directories as needed, refusing any path that resolves outside
 *      the repo working tree).
 *   3. Run `pnpm run typecheck` in the working tree. If typecheck fails,
 *      hand the errors back to the caller; the caller is responsible for
 *      asking the AI for a repair pass and then re-invoking us.
 *   4. On success, commit and (if mode=== 'pr') push + open a PR via
 *      GitHub's REST API.
 *
 * Implementation note (tradeoff): the spec asks for `simple-git`, but
 * the workspace `minimumReleaseAge: 1440` policy in pnpm-workspace.yaml
 * gates new deps for 24h and a deterministic offline install for tests
 * is preferable anyway. simple-git is a thin wrapper around shelling
 * out to the `git` binary; doing the same via `child_process.spawnSync`
 * keeps us dependency-free and is exactly the same set of side effects.
 * If a future caller wants the higher-level API, swapping in simple-git
 * is a drop-in change behind this module's boundary.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { FeaturePlan } from "./planSchema";

export interface ApplyOptions {
  /**
   * Absolute path to the working tree to apply the plan in. Tests use a
   * scratch tmpdir; in production this is the repo root.
   */
  cwd: string;
  /** "pr" pushes and opens a draft PR; "commit-only" leaves the branch local. */
  mode: "pr" | "commit-only";
  /**
   * GitHub repo, e.g. "copperlang2007/Mediflow". Required when mode==='pr'.
   */
  repo?: string;
  /**
   * Base branch for the PR. Defaults to "main".
   */
  base?: string;
  /**
   * Hook for tests: override the GitHub API call. Returns the PR URL.
   * If unset, the real GitHub REST endpoint is used.
   */
  githubApiOverride?: (args: {
    repo: string;
    base: string;
    head: string;
    title: string;
    body: string;
    token: string;
  }) => Promise<string>;
  /**
   * Hook for tests: override the typecheck step. Returns the stderr
   * output (empty on success). If unset, runs `pnpm run typecheck`.
   */
  typecheckOverride?: (cwd: string) => {
    ok: boolean;
    output: string;
  };
}

export interface ApplyResult {
  branch: string;
  filesWritten: string[];
  typecheckOk: boolean;
  typecheckOutput?: string;
  committed: boolean;
  pushed: boolean;
  prUrl?: string;
}

const MAX_FILES = 50;

/**
 * Refuses any path that climbs out of `root` via `..` segments, has an
 * absolute root of its own, or otherwise normalizes to a location
 * outside the working tree. This is the only thing standing between a
 * misbehaving LLM and the rest of the filesystem.
 */
function safePath(root: string, rel: string): string {
  if (path.isAbsolute(rel)) {
    throw new Error(`Refusing absolute path: ${rel}`);
  }
  const resolved = path.resolve(root, rel);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (
    resolved !== path.resolve(root) &&
    !resolved.startsWith(normalizedRoot)
  ) {
    throw new Error(`Refusing path outside repo: ${rel}`);
  }
  return resolved;
}

function runGit(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function runTypecheck(cwd: string): { ok: boolean; output: string } {
  const r = spawnSync("pnpm", ["run", "typecheck"], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    ok: r.status === 0,
    output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
  };
}

async function openPullRequest(args: {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  token: string;
}): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${args.repo}/pulls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: args.title,
        head: args.head,
        base: args.base,
        body: args.body,
        draft: true,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `GitHub PR creation failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  const json = (await res.json()) as { html_url?: string };
  if (!json.html_url) throw new Error("GitHub PR response missing html_url");
  return json.html_url;
}

/**
 * Apply a plan + a map of full file contents to a git working tree.
 *
 * The map keys are the same `path` values used in the plan's files
 * array; the values are the complete textual content to write.
 */
export async function applyPlan(
  plan: FeaturePlan,
  fileContents: Record<string, string>,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const branch = `claude-dev/${plan.branchSlug}`;
  const { cwd, mode } = opts;

  if (plan.files.length > MAX_FILES) {
    throw new Error(
      `Plan exceeds ${MAX_FILES} files (${plan.files.length}); refusing to apply.`,
    );
  }

  // 1. Create + checkout branch (best-effort: if it exists, switch to it).
  const checkout = runGit(cwd, ["checkout", "-b", branch]);
  if (checkout.status !== 0) {
    const fallback = runGit(cwd, ["checkout", branch]);
    if (fallback.status !== 0) {
      throw new Error(
        `git checkout failed: ${checkout.stderr ?? checkout.stdout ?? "unknown"}`,
      );
    }
  }

  // 2. Write files.
  const filesWritten: string[] = [];
  for (const f of plan.files) {
    const body = fileContents[f.path];
    if (body === undefined) {
      throw new Error(`Missing generated content for ${f.path}`);
    }
    const dest = safePath(cwd, f.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, body, "utf8");
    filesWritten.push(f.path);
  }

  // 3. Typecheck.
  const typecheck = opts.typecheckOverride
    ? opts.typecheckOverride(cwd)
    : runTypecheck(cwd);

  if (!typecheck.ok) {
    return {
      branch,
      filesWritten,
      typecheckOk: false,
      typecheckOutput: typecheck.output,
      committed: false,
      pushed: false,
    };
  }

  // 4. Stage + commit.
  const add = runGit(cwd, ["add", "-A"]);
  if (add.status !== 0) {
    throw new Error(`git add failed: ${add.stderr ?? add.stdout}`);
  }
  const commit = runGit(cwd, [
    "commit",
    "-m",
    `Feat: ${plan.summary}\n\n(Generated by AI Feature Builder — review before merging.)`,
  ]);
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr ?? commit.stdout}`);
  }

  // 5. Push + PR (if requested).
  if (mode === "commit-only") {
    return {
      branch,
      filesWritten,
      typecheckOk: true,
      committed: true,
      pushed: false,
    };
  }

  const push = runGit(cwd, ["push", "-u", "origin", branch]);
  if (push.status !== 0) {
    throw new Error(`git push failed: ${push.stderr ?? push.stdout}`);
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN must be set to open a pull request — push succeeded but PR not created.",
    );
  }
  const repo = opts.repo;
  if (!repo) {
    throw new Error("ApplyOptions.repo is required when mode === 'pr'.");
  }

  const prUrl = await (opts.githubApiOverride ?? openPullRequest)({
    repo,
    base: opts.base ?? "main",
    head: branch,
    title: plan.summary.slice(0, 70),
    body: [
      `## AI-drafted change`,
      ``,
      plan.summary,
      ``,
      `### Files changed`,
      ...plan.files.map((f) => `- \`${f.path}\` (${f.action}) — ${f.reason}`),
      ``,
      `### Risks`,
      ...(plan.risks.length > 0
        ? plan.risks.map((r) => `- ${r}`)
        : ["- (none flagged by the planner)"]),
      ``,
      `Generated by the dev console AI Feature Builder. Please review before merging.`,
    ].join("\n"),
    token,
  });

  return {
    branch,
    filesWritten,
    typecheckOk: true,
    committed: true,
    pushed: true,
    prUrl,
  };
}
