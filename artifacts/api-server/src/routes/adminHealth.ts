/**
 * Admin-only AI provider health check.
 *
 * GET /admin/health/ai — verifies the AI provider wiring (Azure OpenAI or
 * direct OpenAI) without exercising any user-facing AI feature. Intended
 * for the repo owner to confirm a fresh Azure OpenAI provisioning works
 * end-to-end (env vars present, client construction OK, upstream auth OK).
 *
 * Strict scope: this endpoint reuses `getOpenAI()` from `routes/ai.ts`
 * verbatim. No client refactor, no shared module extraction. The ping
 * body is the literal string "ping" — no PHI ever crosses the wire from
 * this route.
 *
 * Defense in depth:
 *   - super_admin / agency_admin / compliance_manager only
 *   - 6 calls/minute per user, in-memory store
 *   - 10s upstream timeout via AbortController
 *   - try/catch wraps the upstream call; raw provider error never returned
 *   - API key bytes never returned or logged
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { getOpenAI } from "./ai";
import { logger } from "../lib/logger";
import {
  resolveAiApiKey,
  aiApiKeyVarName,
  resolveAiModel,
} from "../lib/aiProvider";
import { normalizeBedrockModelId } from "../lib/ai/bedrockAnthropicClient";

const router: IRouter = Router();

// ---- Provider-wiring env validation ----------------------------------------

type ProviderKind = "azure" | "bedrock" | "openai" | "unset";

interface EnvValidation {
  provider: ProviderKind;
  configured: boolean;
  envValid: boolean;
  envIssues: string[];
  warnings: string[];
  modelHint: string;
}

/**
 * Inspect AI_INTEGRATIONS_* env vars and report what's missing for the
 * currently configured provider. We deliberately do NOT throw — the goal
 * is to surface issues to an admin via the JSON response so they can fix
 * configuration without grepping logs.
 */
function validateEnv(): EnvValidation {
  const issues: string[] = [];
  const warnings: string[] = [];

  const rawProvider = (process.env.AI_INTEGRATIONS_PROVIDER ?? "").toLowerCase();

  let provider: ProviderKind;
  if (rawProvider === "azure") provider = "azure";
  else if (rawProvider === "bedrock") provider = "bedrock";
  else if (rawProvider === "openai") provider = "openai";
  else if (!rawProvider) {
    provider = "unset";
    warnings.push("AI_INTEGRATIONS_PROVIDER is not set — defaulting to 'openai' which is NOT HIPAA-eligible");
  } else {
    provider = "unset";
    issues.push(`AI_INTEGRATIONS_PROVIDER has unknown value '${rawProvider}'`);
  }

  // Call the SAME resolver the runtime uses rather than re-deriving the rule.
  // A local copy already drifted once in this PR: it read both names
  // regardless of provider while resolveAiApiKey() only falls back for
  // bedrock, so an azure deploy holding only the bedrock key reported
  // {configured: true} while getOpenAI() returned null. `unset` resolves as
  // openai, matching resolveAiProvider()'s own default.
  const resolverProvider = provider === "unset" ? "openai" : provider;
  const apiKey = resolveAiApiKey(resolverProvider);

  if (!apiKey) {
    issues.push(`${aiApiKeyVarName(resolverProvider)} missing`);
  } else if (
    provider === "bedrock" &&
    !process.env.AI_INTEGRATIONS_BEDROCK_API_KEY?.trim()
  ) {
    warnings.push(
      "AI_INTEGRATIONS_BEDROCK_API_KEY is unset; falling back to the legacy " +
        "AI_INTEGRATIONS_OPENAI_API_KEY. Rename it — the value is a Bedrock " +
        "token, not an OpenAI credential.",
    );
  }

  // HIPAA guard: only `azure` and `bedrock` are BAA-eligible. In production
  // this is an ISSUE, not a warning: such a deploy cannot legitimately serve
  // AI at all (assertAiProviderHipaaCompliant() refuses to boot it), so
  // reporting `configured: true` with a soft warning would describe a state
  // the runtime does not permit. Filing it as an issue also means this
  // endpoint names the real cause without depending on catching a throw.
  if (
    process.env.NODE_ENV === "production" &&
    provider !== "azure" &&
    provider !== "bedrock"
  ) {
    issues.push(
      "AI_INTEGRATIONS_PROVIDER is not HIPAA-eligible (must be 'azure' or 'bedrock' in production)",
    );
  }

  let modelHint = "gpt-4o-mini";

  if (provider === "azure") {
    const resource = process.env.AI_INTEGRATIONS_AZURE_RESOURCE;
    const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    if (!resource && !baseURL) {
      issues.push("AI_INTEGRATIONS_AZURE_RESOURCE missing (or set AI_INTEGRATIONS_OPENAI_BASE_URL)");
    }
    const deployment = process.env.AI_INTEGRATIONS_AZURE_DEPLOYMENT;
    if (!deployment) {
      issues.push("AI_INTEGRATIONS_AZURE_DEPLOYMENT missing");
    } else {
      modelHint = deployment;
    }
    if (!process.env.AI_INTEGRATIONS_AZURE_API_VERSION) {
      warnings.push("AI_INTEGRATIONS_AZURE_API_VERSION unset — using SDK default");
    }
  } else if (provider === "bedrock") {
    // NOT an OpenAI endpoint. AWS's API-compatibility matrix lists Chat
    // Completions as unsupported for every Anthropic model, so a Bedrock
    // base URL for Claude points at the Anthropic Messages interface —
    // https://bedrock-runtime.<region>.amazonaws.com/anthropic — not at
    // /openai/v1. The legacy variable is accepted as a fallback so a
    // pre-rename environment still reports healthy, but it is flagged so the
    // drift is visible rather than silent.
    const bedrockBaseUrl = process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL?.trim();
    const legacyBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim();
    if (!bedrockBaseUrl && !legacyBaseUrl) {
      issues.push(
        "AI_INTEGRATIONS_BEDROCK_BASE_URL missing (Bedrock Anthropic Messages endpoint)",
      );
    } else if (!bedrockBaseUrl) {
      warnings.push(
        "AI_INTEGRATIONS_BEDROCK_BASE_URL unset — falling back to the legacy AI_INTEGRATIONS_OPENAI_BASE_URL; rename it",
      );
    }
    const model = process.env.AI_INTEGRATIONS_MODEL?.trim();
    if (!model) {
      // Resolve the SAME default the application uses. Leaving the hint at
      // the OpenAI placeholder made the ping send a non-Claude model id, so a
      // correctly configured default deploy failed its own health check.
      modelHint = resolveAiModel("bedrock");
      warnings.push(
        `AI_INTEGRATIONS_MODEL unset — using the default (${modelHint}); set one to pin a Bedrock model id (e.g. us.anthropic.claude-sonnet-5)`,
      );
    } else {
      modelHint = model;
    }
    // The adapter rewrites a bare `claude-…` id with the provider prefix the
    // configured endpoint host needs. That rewrite is invisible to the
    // operator: a model with no GLOBAL inference profile comes back as an
    // opaque model-not-found with no hint that the id they set is not the id
    // that was sent. Surface both so the transformation is legible.
    // Reported by the AWS review agent on PR #207.
    const effectiveModel = normalizeBedrockModelId(
      modelHint,
      bedrockBaseUrl ?? legacyBaseUrl ?? "",
    );
    if (effectiveModel !== modelHint) {
      warnings.push(
        `AI_INTEGRATIONS_MODEL "${modelHint}" is sent to Bedrock as "${effectiveModel}" — the endpoint's required provider prefix is added automatically. Set a fully-qualified id to control the routing yourself.`,
      );
    } else if (modelHint.startsWith("claude-")) {
      // A bare id that came back unchanged means the base URL host is neither
      // bedrock-mantle nor bedrock-runtime, so the adapter declined to guess a
      // provider prefix. Bedrock will reject the bare id; say so here rather
      // than letting it surface as an opaque model-not-found.
      issues.push(
        `AI_INTEGRATIONS_MODEL "${modelHint}" has no Bedrock provider prefix and the base URL host is not recognised, so one cannot be inferred. Set a fully-qualified id (e.g. global.anthropic.${modelHint}).`,
      );
    }
    modelHint = effectiveModel;
  } else if (provider === "openai") {
    if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
      issues.push("AI_INTEGRATIONS_OPENAI_BASE_URL missing");
    }
  }

  // `configured` = client COULD be built (key + provider known + required
  // per-provider env present). `envValid` = no issues at all.
  const configured = Boolean(apiKey) && provider !== "unset" && issues.length === 0;
  const envValid = issues.length === 0;

  return { provider, configured, envValid, envIssues: issues, warnings, modelHint };
}

// ---- Error categorization --------------------------------------------------

type PingErrorCategory =
  | "auth_failed"
  | "rate_limited"
  | "network"
  | "not_found"
  | "timeout"
  | "unknown";

interface CategorizedError {
  category: PingErrorCategory;
  message: string;
}

/**
 * Map a provider exception to a coarse category + a clean human message.
 * NEVER pass the raw error string through — provider errors can echo the
 * API key, the prompt, or arbitrary request metadata.
 */
function categorizeError(err: unknown, timedOut: boolean): CategorizedError {
  if (timedOut) return { category: "timeout", message: "Upstream request exceeded 10s deadline" };

  // OpenAI SDK exceptions expose `.status` (HTTP code) and `.name`.
  const e = err as { status?: number; name?: string; code?: string } | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const name = typeof e?.name === "string" ? e.name : undefined;
  const code = typeof e?.code === "string" ? e.code : undefined;

  if (status === 401 || status === 403 || name === "AuthenticationError" || name === "PermissionDeniedError") {
    return { category: "auth_failed", message: "Upstream rejected the API key (401/403)" };
  }
  if (status === 404 || name === "NotFoundError") {
    return { category: "not_found", message: "Upstream returned 404 — deployment or model not found" };
  }
  if (status === 429 || name === "RateLimitError") {
    return { category: "rate_limited", message: "Upstream returned 429 — provider rate limit hit" };
  }
  if (
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT"
  ) {
    return { category: "network", message: "Network error reaching the upstream provider" };
  }

  return { category: "unknown", message: "Upstream call failed (see server logs for redacted detail)" };
}

// ---- Rate limit ------------------------------------------------------------
//
// 6 calls/min per (orgId, userId). Keyed AFTER requireAuth so the key is
// always populated; default in-memory store is sufficient (the spec
// explicitly permits it).
const healthAiLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    const r = req as AuthenticatedRequest;
    return `${r.orgId ?? "no-org"}:${r.userId ?? "no-user"}`;
  },
  message: { error: "AI health check rate limit exceeded — try again in a minute." },
});

// ---- Route -----------------------------------------------------------------

router.get(
  "/admin/health/ai",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  healthAiLimiter,
  auditMiddleware("audit_log", "read", { includeReads: true }),
  async (req: Request, res: Response): Promise<void> => {
    const env = validateEnv();

    // If the env is incomplete enough that we can't construct a client at
    // all, return early with a structured "not configured" result rather
    // than attempting a ping that's guaranteed to fail.
    if (!env.configured) {
      res.status(200).json({
        provider: env.provider,
        configured: false,
        envValid: env.envValid,
        envIssues: env.envIssues,
        ping: {
          ok: false,
          category: "unknown" as PingErrorCategory,
          message: "AI provider not configured — see envIssues",
        },
        warnings: env.warnings,
      });
      return;
    }

    // getOpenAI() calls resolveAiProvider(), which THROWS in production when
    // the provider is not HIPAA-eligible. That throw is deliberate at the
    // runtime call sites -- a prod deploy pointed at a non-BAA provider must
    // fail loudly -- but it must never escape HERE. This endpoint exists to
    // tell an operator what is misconfigured; letting it 500 on the exact
    // misconfiguration it is meant to describe sends them to the logs to
    // rediscover what this response could have told them.
    let client: ReturnType<typeof getOpenAI> = null;
    let constructionError = false;
    try {
      client = getOpenAI();
    } catch {
      // Swallow the reason deliberately: it can name env vars and provider
      // values. envIssues already carries the actionable detail.
      constructionError = true;
    }
    if (!client) {
      // Client factory returned null or threw despite env looking valid —
      // surface it as a config issue but never echo the underlying reason.
      res.status(200).json({
        provider: env.provider,
        configured: false,
        envValid: env.envValid,
        envIssues: env.envIssues,
        ping: {
          ok: false,
          category: "unknown" as PingErrorCategory,
          message: constructionError
            ? "AI client could not be constructed — the configured " +
              "AI_INTEGRATIONS_PROVIDER is rejected in production (only " +
              "'azure' and 'bedrock' are HIPAA-eligible)"
            : "AI client could not be constructed",
        },
        warnings: env.warnings,
      });
      return;
    }

    // -- Ping ----------------------------------------------------------------
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);

    const startedAt = Date.now();
    try {
      const response = await client.chat.completions.create(
        {
          model: env.modelHint,
          max_tokens: 1,
          // A user turn, not a system turn: the Anthropic Messages API
          // (bedrock) rejects a request with no user message, and a health
          // check that cannot run on the production provider is worthless.
          messages: [{ role: "user", content: "ping" }],
        },
        { signal: controller.signal },
      );
      const latencyMs = Date.now() - startedAt;
      const reportedModel = response.model ?? env.modelHint;

      res.status(200).json({
        provider: env.provider,
        configured: true,
        envValid: env.envValid,
        envIssues: env.envIssues,
        ping: {
          ok: true,
          latencyMs,
          // `model` is what the provider echoed back; `modelRequested` is what
          // we asked for. They differ whenever the adapter added a prefix, and
          // an operator comparing the health page to their env var needs both.
          model: reportedModel,
          modelRequested: env.modelHint,
        },
        warnings: env.warnings,
      });
    } catch (err) {
      const { category, message } = categorizeError(err, timedOut);
      // Log a redacted record server-side. We deliberately do NOT log the
      // raw err object because some SDK errors include the request body
      // (including system prompt) and headers (which may carry the key).
      logger.warn(
        { category, latencyMs: Date.now() - startedAt },
        "AI provider health ping failed",
      );
      res.status(200).json({
        provider: env.provider,
        configured: true,
        envValid: env.envValid,
        envIssues: env.envIssues,
        ping: {
          ok: false,
          category,
          message,
        },
        warnings: env.warnings,
      });
    } finally {
      clearTimeout(timeout);
    }
  },
);

export default router;
