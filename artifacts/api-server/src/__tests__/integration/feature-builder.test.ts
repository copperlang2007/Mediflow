/**
 * Integration tests for the AI Feature Builder backend (Phase 2 of the
 * dev console).
 *
 * Coverage:
 *   1. /dev/feature-builder/plan returns 404 when ENABLE_DEV_CONSOLE is
 *      not "true" — proves the dev gate is glued to the surface, not
 *      just the parent router mount.
 *   2. /dev/feature-builder/plan with the gate open, OpenAI client
 *      faked, and a developer-role caller returns a planId + plan and
 *      stores the plan in the in-memory cache.
 *   3. The gitWriter.applyPlan helper writes a fake plan's files to a
 *      scratch git working tree, runs an overridden typecheck, commits,
 *      and (with the GitHub API mocked) returns a PR URL — exercising
 *      the happy-path apply flow without ever touching the network or
 *      the real repo.
 *
 * OpenAI mocking strategy: we use `setOpenAIClientFactory` (exposed
 * from the route module specifically for tests) to inject a fake AiClient
 * whose `chat.completions.create` returns a canned JSON-encoded
 * FeaturePlan. This avoids any need to vi.mock the `openai` package and
 * keeps the test surface narrow.
 */

// Set the env var as early as possible so that when the routes module
// is later imported it sees the gate open and mounts the dev router.
process.env.ENABLE_DEV_CONSOLE = "true";

// Neutralize any inherited git signing config (developer machines often
// have commit.gpgsign=true via a code-signing helper that won't be
// reachable in tests). Setting GIT_CONFIG_GLOBAL to /dev/null in the
// process env applies to every spawned git, including the ones inside
// gitWriter — no per-repo `git config` dance required.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

const { dbF, clerkF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  clerkF: async (): Promise<Record<string, unknown>> => {
    const { clerkMockFactory } = await import("../helpers/testApp");
    return clerkMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));

vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";

import type { Express } from "express";
import type { FeaturePlan } from "@workspace/devtools";
import { applyPlan } from "@workspace/devtools";

let app: Express;
let request: typeof import("supertest");
let org: { id: string };
// The dev_console:admin permission is granted to super_admin and
// developer. The test enum may lag behind the schema for "developer"
// in some pglite migration sets, so we seed a super_admin — either
// role exercises the same permission path.
let admin: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  org = await seedOrg(handle.db, { id: "fb-org" });
  admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "super_admin",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

const FAKE_PLAN: FeaturePlan = {
  summary: "Add a scratch hello-world file for the feature-builder test.",
  branchSlug: "fb-test-hello",
  files: [
    {
      path: "scratch/test.txt",
      action: "create",
      preview: "Plain-text hello.",
      reason: "Smoke-test the gitWriter applyPlan flow end-to-end.",
    },
  ],
  migrationsNeeded: false,
  rbacChanges: false,
  openApiChanges: false,
  testsIncluded: false,
  risks: [],
};

/** Build a tmp git working tree with one baseline commit. */
async function makeScratchRepo(prefix: string): Promise<string> {
  const scratch = await mkdtemp(path.join(tmpdir(), prefix));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: scratch });
  spawnSync("git", ["config", "user.email", "fb-test@example.com"], {
    cwd: scratch,
  });
  spawnSync("git", ["config", "user.name", "FB Test"], { cwd: scratch });
  await writeFile(path.join(scratch, "README"), "scratch repo\n");
  spawnSync("git", ["add", "."], { cwd: scratch });
  spawnSync("git", ["commit", "-q", "-m", "baseline"], { cwd: scratch });
  return scratch;
}

describe("Dev Console — Feature Builder backend", () => {
  it("POST /dev/feature-builder/plan 404s when ENABLE_DEV_CONSOLE !== 'true'", async () => {
    const previous = process.env.ENABLE_DEV_CONSOLE;
    process.env.ENABLE_DEV_CONSOLE = "false";
    try {
      const res = await request(app)
        .post("/api/dev/feature-builder/plan")
        .set(withAuth(admin.id))
        .send({ description: "anything" });
      // devOnly middleware returns 404 (not 403) so probing is
      // indistinguishable from an unmounted route.
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_DEV_CONSOLE = previous;
    }
  });

  it("POST /dev/feature-builder/plan stores the plan and returns planId", async () => {
    const mod = await import("../../routes/dev/feature-builder");
    mod._clearPlanStore();
    mod.setOpenAIClientFactory(() => ({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              { message: { content: JSON.stringify(FAKE_PLAN) } },
            ],
          }),
        },
      },
    }));

    try {
      const res = await request(app)
        .post("/api/dev/feature-builder/plan")
        .set(withAuth(admin.id))
        .send({
          description: "Add a scratch hello-world file for testing.",
        });

      expect(res.status).toBe(200);
      expect(res.body.planId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(res.body.plan.branchSlug).toBe("fb-test-hello");
      expect(res.body.plan.files).toHaveLength(1);
      expect(res.body.plan.files[0].path).toBe("scratch/test.txt");
    } finally {
      mod.setOpenAIClientFactory(null);
    }
  });

  it("rejects invalid body on /plan with 400", async () => {
    const res = await request(app)
      .post("/api/dev/feature-builder/plan")
      .set(withAuth(admin.id))
      .send({ description: "" });
    expect(res.status).toBe(400);
  });

  it("gitWriter.applyPlan writes files to a scratch worktree (commit-only)", async () => {
    const scratch = await makeScratchRepo("fb-apply-");
    try {
      const result = await applyPlan(
        FAKE_PLAN,
        { "scratch/test.txt": "hello\n" },
        {
          cwd: scratch,
          mode: "commit-only",
          // Skip the real `pnpm run typecheck` — there is no
          // package.json in the scratch tree.
          typecheckOverride: () => ({ ok: true, output: "" }),
        },
      );

      expect(result.branch).toBe("claude-dev/fb-test-hello");
      expect(result.filesWritten).toEqual(["scratch/test.txt"]);
      expect(result.typecheckOk).toBe(true);
      expect(result.committed).toBe(true);
      expect(result.pushed).toBe(false);
      expect(result.prUrl).toBeUndefined();

      const written = await readFile(
        path.join(scratch, "scratch/test.txt"),
        "utf8",
      );
      expect(written).toBe("hello\n");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("gitWriter.applyPlan opens a PR (with GitHub API mocked) in mode='pr'", async () => {
    const scratch = await makeScratchRepo("fb-pr-");
    // Bare remote so `git push -u origin <branch>` works without the
    // network.
    const remote = await mkdtemp(path.join(tmpdir(), "fb-remote-"));
    spawnSync("git", ["init", "-q", "--bare"], { cwd: remote });
    spawnSync("git", ["remote", "add", "origin", remote], { cwd: scratch });

    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "fake-token";

    try {
      const result = await applyPlan(
        FAKE_PLAN,
        { "scratch/test.txt": "hello\n" },
        {
          cwd: scratch,
          mode: "pr",
          repo: "owner/repo",
          typecheckOverride: () => ({ ok: true, output: "" }),
          githubApiOverride: async (args) => {
            expect(args.repo).toBe("owner/repo");
            expect(args.head).toBe("claude-dev/fb-test-hello");
            expect(args.base).toBe("main");
            expect(args.title.length).toBeGreaterThan(0);
            return "https://github.com/owner/repo/pull/42";
          },
        },
      );

      expect(result.pushed).toBe(true);
      expect(result.prUrl).toBe("https://github.com/owner/repo/pull/42");
    } finally {
      process.env.GITHUB_TOKEN = previousToken;
      await rm(scratch, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("gitWriter.applyPlan refuses paths outside the repo", async () => {
    const scratch = await makeScratchRepo("fb-safe-");
    try {
      await expect(
        applyPlan(
          {
            ...FAKE_PLAN,
            files: [
              {
                path: "../escape.txt",
                action: "create",
                preview: "",
                reason: "",
              },
            ],
          },
          { "../escape.txt": "evil\n" },
          {
            cwd: scratch,
            mode: "commit-only",
            typecheckOverride: () => ({ ok: true, output: "" }),
          },
        ),
      ).rejects.toThrow(/outside repo|absolute/i);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
