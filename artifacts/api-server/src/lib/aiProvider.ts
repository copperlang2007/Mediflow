/**
 * AI provider resolution + HIPAA guard.
 *
 * MediFlow's AI features send full contact Medicare profiles (PHI) to an
 * LLM provider in the system prompt. The provider is selected by the
 * `AI_INTEGRATIONS_PROVIDER` env var:
 *
 *   - `azure`   — Azure OpenAI. BAA-covered: Microsoft offers a BAA for
 *                 Azure OpenAI.
 *   - `bedrock` — Claude in Amazon Bedrock, served through the Anthropic
 *                 Messages API at
 *                 `https://bedrock-mantle.<region>.api.aws/anthropic`.
 *                 BAA-covered: AWS offers a BAA covering Bedrock. It does NOT
 *                 speak the OpenAI wire format — Chat Completions is
 *                 unsupported for every Anthropic model — so it is consumed
 *                 through `@anthropic-ai/sdk` behind the adapter in
 *                 `lib/ai/bedrockAnthropicClient.ts` (base URL + bearer token).
 *   - `openai`  — the standard `api.openai.com` API. OpenAI does NOT offer
 *                 a HIPAA BAA for this endpoint, so it must NEVER receive
 *                 PHI. Allowed only in dev/test.
 *
 * In production (`NODE_ENV === "production"`) we hard-fail at boot unless
 * the provider is a HIPAA-eligible value (`azure` or `bedrock`), so a
 * misconfigured prod deploy dies fast and visibly instead of silently
 * streaming PHI to a vendor with no BAA on the first patient interaction.
 *
 * This mirrors the `PHI_ENCRYPTION_KEY` boot check in
 * `lib/db/src/encryption/medicareId.ts` (PR #64): production env
 * misconfiguration is fatal, dev/test keeps the permissive default.
 *
 * Every LLM-client construction site MUST resolve the provider through
 * `resolveAiProvider()` so the guard cannot be bypassed.
 */

import { normalizeBedrockModelId } from "./ai/bedrockAnthropicClient";

export type AiProvider = "azure" | "bedrock" | "openai";

/**
 * Providers covered by a HIPAA BAA and therefore allowed to receive PHI in
 * production: `azure` (Microsoft BAA) and `bedrock` (AWS BAA).
 */
export const HIPAA_ELIGIBLE_PROVIDERS: ReadonlySet<AiProvider> = new Set([
  "azure",
  "bedrock",
]);

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isHipaaEligible(value: string): value is "azure" | "bedrock" {
  return (HIPAA_ELIGIBLE_PROVIDERS as ReadonlySet<string>).has(value);
}

/**
 * Resolve the configured AI provider and enforce the HIPAA guard.
 *
 * In production, throws unless the provider is HIPAA-eligible (`azure` or
 * `bedrock`). In non-production, returns the configured provider (default
 * `openai`) without restriction so local dev and the test suite still work.
 */
export function resolveAiProvider(): AiProvider {
  const raw = (process.env.AI_INTEGRATIONS_PROVIDER ?? "openai").toLowerCase();

  if (isProduction() && !isHipaaEligible(raw)) {
    throw new Error(
      "FATAL: AI_INTEGRATIONS_PROVIDER must be a HIPAA-eligible provider " +
        "('azure' or 'bedrock') in production — the standard OpenAI API has no " +
        "HIPAA BAA and must not receive PHI. " +
        `Got: ${process.env.AI_INTEGRATIONS_PROVIDER ?? "<unset>"}`,
    );
  }

  if (isHipaaEligible(raw)) return raw;
  return "openai";
}

/**
 * The default model for a provider that has not set `AI_INTEGRATIONS_MODEL`.
 *
 * The historical default (`gpt-5.4`) is an OpenAI model name and is kept for
 * azure/openai so existing deploys are unaffected. It is meaningless on
 * Bedrock, where an unset variable previously produced a model-not-found error
 * on the first AI request of an otherwise healthy deploy.
 *
 * The bare id is deliberate: Bedrock's required provider prefix depends on
 * which endpoint host the base URL names, so `normalizeBedrockModelId()` adds
 * the right one at request time rather than baking one in here.
 */
export const DEFAULT_BEDROCK_MODEL = "claude-sonnet-5";
const DEFAULT_OPENAI_MODEL = "gpt-5.4";

/**
 * The chat model to request. Configurable via `AI_INTEGRATIONS_MODEL` so the
 * same code path serves every provider.
 *
 * Deliberately never throws, even in production on a non-BAA provider. Two
 * modules (`transcriptParse`, `feature-builder`) read a model id at module
 * scope, and imports run before `bootstrap()` — a throw here would turn the
 * boot guard's clear FATAL into an opaque import-time crash. Choosing a
 * default model sends nothing anywhere; the guard still stops the process.
 */
export function resolveAiModel(provider?: AiProvider): string {
  const configured = process.env.AI_INTEGRATIONS_MODEL?.trim();
  if (configured) return configured;
  let resolved = provider;
  if (!resolved) {
    const raw = (process.env.AI_INTEGRATIONS_PROVIDER ?? "").toLowerCase();
    resolved = isHipaaEligible(raw) ? raw : "openai";
  }
  return resolved === "bedrock" ? DEFAULT_BEDROCK_MODEL : DEFAULT_OPENAI_MODEL;
}

/**
 * The base URL for the configured provider's API.
 *
 * The variable is named per PROVIDER, not per SDK, because the two stopped
 * agreeing once Bedrock entered the picture:
 *
 *   - bedrock       → AI_INTEGRATIONS_BEDROCK_BASE_URL
 *   - azure/openai  → AI_INTEGRATIONS_OPENAI_BASE_URL
 *
 * Bedrock's endpoint is not an OpenAI endpoint. AWS's compatibility matrix
 * lists Chat Completions as NOT supported for every Anthropic model — Claude
 * in Amazon Bedrock is reachable over the Anthropic Messages API at
 * `https://bedrock-mantle.<region>.api.aws/anthropic`, never over
 * `/openai/v1`. Calling that variable AI_INTEGRATIONS_OPENAI_BASE_URL while it
 * holds an Anthropic endpoint is how a deploy ends up green and broken.
 *
 * The legacy name is still read as a fallback for bedrock so an environment
 * configured before this rename keeps booting; it is deliberately a fallback
 * and not an alias, so `env | grep BEDROCK` tells the truth on new deploys.
 */
export function resolveAiBaseUrl(
  provider: AiProvider = resolveAiProvider(),
): string | undefined {
  if (provider === "bedrock") {
    return (
      process.env["AI_INTEGRATIONS_BEDROCK_BASE_URL"]?.trim() ||
      process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]?.trim() ||
      undefined
    );
  }
  return process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]?.trim() || undefined;
}

/**
 * The API key for the configured provider.
 *
 * Named per PROVIDER for the same reason as the base URL: for bedrock this
 * value is an AWS Bedrock bearer token minted in the operator's own AWS
 * account and covered by their AWS BAA. It is NOT an OpenAI credential and
 * never reaches api.openai.com. Calling it AI_INTEGRATIONS_OPENAI_API_KEY
 * told every operator the opposite — that MediFlow wanted an OpenAI account —
 * which is both false and, in a PHI system, alarming on its face.
 *
 *   - bedrock       → AI_INTEGRATIONS_BEDROCK_API_KEY
 *   - azure/openai  → AI_INTEGRATIONS_OPENAI_API_KEY
 *
 * Azure keeps the OPENAI name because there the name is true: the credential
 * really is an OpenAI-shaped API key issued by Azure OpenAI.
 *
 * The legacy name remains readable as a FALLBACK (not an alias) for bedrock
 * so an environment configured before this rename keeps booting.
 */
export function resolveAiApiKey(
  provider: AiProvider = resolveAiProvider(),
): string | undefined {
  if (provider === "bedrock") {
    return (
      process.env["AI_INTEGRATIONS_BEDROCK_API_KEY"]?.trim() ||
      process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]?.trim() ||
      undefined
    );
  }
  return process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]?.trim() || undefined;
}

/**
 * The env var name an operator should set for this provider's API key —
 * used in error/health messages so they name the CANONICAL variable rather
 * than the legacy one.
 */
export function aiApiKeyVarName(
  provider: AiProvider = resolveAiProvider(),
): string {
  return provider === "bedrock"
    ? "AI_INTEGRATIONS_BEDROCK_API_KEY"
    : "AI_INTEGRATIONS_OPENAI_API_KEY";
}

/**
 * Boot-time assertion. Call once at app/worker bootstrap so a
 * misconfigured production deploy fails fast — before the first AI call.
 * Throws the same error as `resolveAiProvider()`.
 */
export function assertAiProviderHipaaCompliant(): void {
  const provider = resolveAiProvider();
  if (provider !== "bedrock") return;

  // A bare `claude-…` id needs a provider prefix, and the adapter infers one
  // from the endpoint host. On a host it does not recognise — GovCloud, China,
  // a private DNS name in front of a VPC endpoint — it declines to guess and
  // sends the id through unchanged, which Bedrock rejects.
  //
  // `/admin/health/ai` already reports this, but that endpoint is only
  // consulted by someone who has gone looking. Without the check here, such a
  // deploy boots clean, passes its container health check, serves every
  // non-AI route, and fails only on the first AI request a user makes. That is
  // exactly the class of green-and-broken deploy this PR exists to eliminate,
  // so it fails at boot instead.
  // Reported by the AWS review agent on PR #207.
  const model = resolveAiModel("bedrock");
  const baseUrl = resolveAiBaseUrl("bedrock") ?? "";
  if (!baseUrl) return; // absent config is the caller's own error to report

  // The bedrock path is served by `@anthropic-ai/sdk` against Bedrock's
  // `/anthropic` Messages route, which serves Anthropic models and nothing
  // else. An id for any other family cannot work there no matter how it is
  // prefixed — an OpenAI id (the openai-side default `gpt-5.4`, which
  // `resolveAiModel()` returns whenever the provider is not yet known at the
  // call), an Amazon Nova id, or a typo like `claude5-sonnet` that misses the
  // `claude-` shape all sail past a check that only looks at prefixes.
  // Reported by the AWS review agent on PR #207.
  const isAnthropicId =
    model.startsWith("claude-") || /^([a-z]+\.)?anthropic\./.test(model);
  if (!isAnthropicId) {
    throw new Error(
      `FATAL: AI_INTEGRATIONS_MODEL "${model}" is not an Anthropic model id, ` +
        `but AI_INTEGRATIONS_PROVIDER=bedrock routes through Bedrock's ` +
        `Anthropic Messages API, which serves no other model family. Set an ` +
        `Anthropic id (e.g. global.anthropic.claude-sonnet-5).`,
    );
  }

  // `/openai/v1` is the Chat Completions path. AWS lists Chat Completions as
  // unsupported for every Anthropic model, so a base URL still pointing there
  // is the precise misconfiguration this PR exists to eliminate — and it
  // survives today because `normalizeBedrockModelId()` matches on host alone
  // and happily prefixes an id destined for a path that cannot serve it.
  if (baseUrl.includes("/openai/v1")) {
    throw new Error(
      `FATAL: the Bedrock base URL "${baseUrl}" points at the OpenAI-compatible ` +
        `/openai/v1 path, which AWS lists as unsupported for every Anthropic ` +
        `model. Use the Anthropic Messages path instead ` +
        `(e.g. https://bedrock-runtime.<region>.amazonaws.com/anthropic).`,
    );
  }

  if (normalizeBedrockModelId(model, baseUrl) === model && model.startsWith("claude-")) {
    throw new Error(
      `FATAL: AI_INTEGRATIONS_MODEL "${model}" has no Bedrock provider prefix ` +
        `and the host in AI_INTEGRATIONS_BEDROCK_BASE_URL is not one this ` +
        `build recognises, so a prefix cannot be inferred. Set a ` +
        `fully-qualified model id (e.g. global.anthropic.${model}).`,
    );
  }
}
