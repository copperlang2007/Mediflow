/**
 * Dev console — AI Feature Builder backend.
 *
 * Two endpoints, both gated by `devOnly` + `requireAuth` +
 * `requirePermission("dev_console","admin")` + `auditMiddleware`:
 *
 *   POST /dev/feature-builder/plan
 *     Body: { description: string }
 *     Builds the codebase-context bundle, calls OpenAI with structured-
 *     output mode targeting the FeaturePlan schema, stores the resulting
 *     plan in an in-memory cache (30 min TTL), and returns {planId,
 *     plan} to the caller.
 *
 *   POST /dev/feature-builder/apply
 *     Body: { planId, mode: 'pr' | 'commit-only' }
 *     Looks up the plan, asks the AI for full file contents in a second
 *     pass (one prompt per file, concurrency-capped at 3 so we don't
 *     burn rate limits), then hands off to gitWriter.applyPlan() which
 *     checks out a branch, writes files, typechecks, commits, and
 *     (mode==='pr') opens a draft PR on GitHub.
 *
 * Hard constraints honored here:
 * - Dev-only: parent router applies `devOnly`. As defense-in-depth we
 *   also require `dev_console:admin` on every call.
 * - Output is a PR for human review, not a direct main commit.
 * - Codebase context never includes PHI (the bundler reads only source
 *   files, never tables).
 * - Plans are capped at 50 files. The zod schema enforces this; we also
 *   re-check it in the apply path.
 * - AI tokens never flow through the client — both endpoints are
 *   server-side and the apply endpoint never returns generated content
 *   over the wire (only typecheck status, branch name, PR URL).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import OpenAI, { AzureOpenAI } from "openai";
import {
  requireAuth,
  requirePermission,
} from "../../middlewares/requireAuth";
import { auditMiddleware } from "../../middlewares/auditMiddleware";
import {
  buildCodebaseContext,
  FeaturePlan,
  FeaturePlanJsonSchema,
  applyPlan,
} from "@workspace/devtools";

const router: IRouter = Router();

// OpenAI model is configurable so we can swap versions without a code change.
// Defaults to the model the agent was originally tested against.
const FEATURE_BUILDER_MODEL =
  process.env.FEATURE_BUILDER_MODEL ?? "gpt-5.4";

// Every route here requires the caller hold dev_console:admin. The
// parent /dev router already applies `devOnly`, so an unset env var
// 404s before we get here.
router.use(requireAuth, requirePermission("dev_console", "admin"));

// ---------------------------------------------------------------------------
// In-memory plan store (30 min TTL, bounded).
//
// We use a Map<planId, {plan, expiresAt}>. Plans live for 30 min from
// creation, which is the longest a developer is plausibly going to take
// reviewing a plan in the UI before clicking Apply. Eviction is lazy:
// we sweep stale entries each time we look one up or store a new plan.
// The store is bounded to keep memory usage predictable in long-lived dev
// processes even if /plan is called repeatedly without /apply.
// ---------------------------------------------------------------------------
type StoredPlan = {
  plan: z.infer<typeof FeaturePlan>;
  expiresAt: number;
};
const PLAN_TTL_MS = 30 * 60 * 1000;
const PLAN_STORE_MAX_SIZE = 100;
const planStore = new Map<string, StoredPlan>();

function storePlan(plan: z.infer<typeof FeaturePlan>): string {
  // Lazy eviction + bounding: drop expired entries, then if still at cap,
  // drop the oldest remaining entry. Map iteration order is insertion order,
  // so the first key is the oldest.
  const now = Date.now();
  for (const [k, v] of planStore) {
    if (v.expiresAt < now) planStore.delete(k);
  }
  if (planStore.size >= PLAN_STORE_MAX_SIZE) {
    const oldestKey = planStore.keys().next().value;
    if (oldestKey !== undefined) planStore.delete(oldestKey);
  }

  const id = randomUUID();
  planStore.set(id, { plan, expiresAt: now + PLAN_TTL_MS });
  return id;
}

function getPlan(id: string): z.infer<typeof FeaturePlan> | null {
  // Lazy eviction.
  for (const [k, v] of planStore.entries()) {
    if (v.expiresAt < Date.now()) planStore.delete(k);
  }
  const hit = planStore.get(id);
  return hit ? hit.plan : null;
}

/** Test-only — drains the plan store between tests. */
export function _clearPlanStore(): void {
  planStore.clear();
}

// ---------------------------------------------------------------------------
// OpenAI client — pluggable so tests can inject a fake.
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the OpenAI client we actually use, narrow enough to
 * be trivial to mock in tests via setOpenAIClientFactory().
 */
export interface AiClient {
  chat: {
    completions: {
      create: (req: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format?: unknown;
        max_completion_tokens?: number;
        stream?: false;
      }) => Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

let _factory: (() => AiClient | null) | null = null;

/** Override the OpenAI client factory — used by tests. */
export function setOpenAIClientFactory(
  factory: (() => AiClient | null) | null,
): void {
  _factory = factory;
}

function getOpenAI(): AiClient | null {
  if (_factory) return _factory();
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!apiKey) return null;
  const provider = (process.env.AI_INTEGRATIONS_PROVIDER ?? "openai").toLowerCase();
  try {
    if (provider === "azure") {
      // Azure OpenAI is the HIPAA-eligible path. The deployment name in
      // the URL (set on the client) overrides the `model` field sent in
      // the request body, so callers can keep passing FEATURE_BUILDER_MODEL
      // — we just route to the corresponding Azure deployment.
      const resource = process.env.AI_INTEGRATIONS_AZURE_RESOURCE;
      const endpoint =
        process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
        (resource ? `https://${resource}.openai.azure.com` : undefined);
      if (!endpoint) return null;
      const apiVersion =
        process.env.AI_INTEGRATIONS_AZURE_API_VERSION ?? "2024-02-15-preview";
      // Fall back to FEATURE_BUILDER_MODEL when no Azure-specific
      // deployment is set — common when the Azure deployment was named
      // after the model.
      const deployment =
        process.env.AI_INTEGRATIONS_AZURE_DEPLOYMENT ?? FEATURE_BUILDER_MODEL;
      return new AzureOpenAI({
        apiKey,
        endpoint,
        apiVersion,
        deployment,
      }) as unknown as AiClient;
    }
    const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    if (!baseURL) return null;
    return new OpenAI({ apiKey, baseURL }) as unknown as AiClient;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /plan
// ---------------------------------------------------------------------------

const PlanRequestBody = z.object({
  description: z.string().min(1).max(4000),
});

const PLAN_SYSTEM_PROMPT = `You are a senior engineer working in the Mediflow codebase. Given the request below and the codebase context, produce a FeaturePlan that lists every file that needs to be created or modified, with a one-line preview for each, branch slug, and risks. DO NOT produce file contents yet — only the plan.

Output strict JSON matching the FeaturePlan schema. The branchSlug must be lowercase letters, digits, and hyphens only. Use 'create' for new files and 'modify' for changes to existing files. Cap the file list at 50. Flag any HIPAA/PHI implications in the risks array.`;

router.post(
  "/feature-builder/plan",
  auditMiddleware("dev_console", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = PlanRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid body",
        detail: parsed.error.message,
      });
      return;
    }

    const ai = getOpenAI();
    if (!ai) {
      res.status(503).json({
        error:
          "AI integration is not configured (AI_INTEGRATIONS_OPENAI_API_KEY/BASE_URL).",
      });
      return;
    }

    let context: string;
    try {
      context = await buildCodebaseContext();
    } catch (err) {
      res.status(500).json({
        error: "Failed to build codebase context",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let raw: string;
    try {
      const response = await ai.chat.completions.create({
        model: FEATURE_BUILDER_MODEL,
        messages: [
          { role: "system", content: PLAN_SYSTEM_PROMPT },
          {
            role: "user",
            content: `# Request\n${parsed.data.description}\n\n# Codebase context\n${context}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: FeaturePlanJsonSchema,
        },
        stream: false,
      });
      raw = response.choices[0]?.message?.content ?? "";
    } catch (err) {
      res.status(503).json({
        error: "AI service unavailable",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let plan;
    try {
      const json = JSON.parse(raw);
      plan = FeaturePlan.parse(json);
    } catch (err) {
      res.status(502).json({
        error: "AI returned an invalid plan",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const planId = storePlan(plan);
    res.json({ planId, plan });
  },
);

// ---------------------------------------------------------------------------
// POST /apply
// ---------------------------------------------------------------------------

const ApplyRequestBody = z.object({
  planId: z.string().uuid(),
  mode: z.enum(["pr", "commit-only"]),
  /** Test/CI hook — override the working tree so we don't push from prod. */
  cwd: z.string().optional(),
});

const FILE_SYSTEM_PROMPT = `You are generating a single source file for the Mediflow codebase. Return ONLY the full contents of the file — no markdown fences, no explanatory prose. Follow every convention listed in the context block; in particular, mutating Express routes MUST chain requireAuth + requirePermission + auditMiddleware, and SQL migrations MUST be idempotent (CREATE … IF NOT EXISTS).`;

/**
 * Generate a single file's content via the AI client. Returns the
 * stripped string; the caller is responsible for typecheck + commit.
 */
async function generateFileContent(
  ai: AiClient,
  context: string,
  plan: z.infer<typeof FeaturePlan>,
  filePath: string,
  preview: string,
  reason: string,
): Promise<string> {
  const response = await ai.chat.completions.create({
    model: FEATURE_BUILDER_MODEL,
    messages: [
      { role: "system", content: FILE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `# Feature summary`,
          plan.summary,
          ``,
          `# File to generate`,
          `Path: ${filePath}`,
          `Preview: ${preview}`,
          `Reason: ${reason}`,
          ``,
          `# Codebase context`,
          context,
        ].join("\n"),
      },
    ],
    stream: false,
    max_completion_tokens: 8000,
  });
  const text = response.choices[0]?.message?.content ?? "";
  // Defensive: strip ```lang fences if the model adds them despite the
  // system prompt asking it not to.
  const fence = text.match(/^```(?:[a-z]+)?\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1]! : text;
}

/**
 * Run `tasks` with at most `limit` of them in flight at a time.
 * Hand-rolled rather than reaching for p-limit since this is the only
 * concurrent-promise spot in the package.
 */
async function withConcurrency<T>(
  limit: number,
  tasks: Array<() => Promise<T>>,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    (async () => {
      while (true) {
        const idx = next++;
        if (idx >= tasks.length) return;
        results[idx] = await tasks[idx]!();
      }
    })(),
  );
  await Promise.all(workers);
  return results;
}

router.post(
  "/feature-builder/apply",
  auditMiddleware("dev_console", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = ApplyRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid body",
        detail: parsed.error.message,
      });
      return;
    }
    const { planId, mode } = parsed.data;
    const plan = getPlan(planId);
    if (!plan) {
      res.status(404).json({ error: "Plan not found or expired" });
      return;
    }
    if (plan.files.length > 50) {
      res.status(400).json({
        error: "Plan exceeds 50-file cap; refusing to apply.",
      });
      return;
    }

    const ai = getOpenAI();
    if (!ai) {
      res.status(503).json({
        error: "AI integration is not configured.",
      });
      return;
    }

    let context: string;
    try {
      context = await buildCodebaseContext();
    } catch (err) {
      res.status(500).json({
        error: "Failed to build codebase context",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Generate content for every file in the plan with concurrency 3.
    const fileContents: Record<string, string> = {};
    try {
      const generated = await withConcurrency(
        3,
        plan.files.map(
          (f) => async () =>
            [f.path, await generateFileContent(ai, context, plan, f.path, f.preview, f.reason)] as const,
        ),
      );
      for (const [p, body] of generated) fileContents[p] = body;
    } catch (err) {
      res.status(503).json({
        error: "AI generation failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Hand off to the git writer.
    try {
      const cwd = parsed.data.cwd ?? process.cwd();
      const result = await applyPlan(plan, fileContents, {
        cwd,
        mode,
        repo: process.env.GITHUB_REPO,
      });

      // If typecheck failed, give the model one repair pass. We feed
      // the errors back per-file (every file gets the same typecheck
      // log) and ask for replacements; then re-invoke applyPlan with
      // the new contents, but ONLY when we have the typecheck output
      // back.
      if (!result.typecheckOk) {
        const repaired: Record<string, string> = {};
        const tasks = plan.files.map(
          (f) => async () =>
            [
              f.path,
              await generateFileContent(
                ai,
                context +
                  `\n\n# Previous typecheck errors (fix these)\n${result.typecheckOutput ?? ""}`,
                plan,
                f.path,
                f.preview,
                f.reason,
              ),
            ] as const,
        );
        for (const [p, body] of await withConcurrency(3, tasks)) {
          repaired[p] = body;
        }
        const retried = await applyPlan(plan, repaired, {
          cwd,
          mode,
          repo: process.env.GITHUB_REPO,
        });
        res.json({
          branch: retried.branch,
          prUrl: retried.prUrl,
          typecheckErrors: retried.typecheckOk
            ? undefined
            : retried.typecheckOutput,
          retries: 1,
        });
        return;
      }

      res.json({
        branch: result.branch,
        prUrl: result.prUrl,
        typecheckErrors: undefined,
        retries: 0,
      });
    } catch (err) {
      res.status(500).json({
        error: "Apply failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

export default router;
