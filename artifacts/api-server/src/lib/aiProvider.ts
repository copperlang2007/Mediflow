/**
 * AI provider resolution + HIPAA guard.
 *
 * MediFlow's AI features send full contact Medicare profiles (PHI) to an
 * LLM provider in the system prompt. The provider is selected by the
 * `AI_INTEGRATIONS_PROVIDER` env var:
 *
 *   - `azure`   — Azure OpenAI. BAA-covered: Microsoft offers a BAA for
 *                 Azure OpenAI.
 *   - `bedrock` — Amazon Bedrock's OpenAI-compatible Chat Completions API.
 *                 BAA-covered: AWS offers a BAA covering Bedrock, and the
 *                 endpoint speaks the OpenAI wire format, so it is consumed
 *                 through the same `openai` SDK client (base URL + API key).
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
 * The chat model to request. Bedrock requires a Bedrock model id (e.g.
 * `us.anthropic.claude-sonnet-4-6`); Azure/OpenAI use their own model names.
 * Configurable via `AI_INTEGRATIONS_MODEL` so the same code path serves every
 * provider; defaults to the historical value so existing Azure/OpenAI deploys
 * are unaffected.
 */
export function resolveAiModel(): string {
  return process.env.AI_INTEGRATIONS_MODEL?.trim() || "gpt-5.4";
}

/**
 * Boot-time assertion. Call once at app/worker bootstrap so a
 * misconfigured production deploy fails fast — before the first AI call.
 * Throws the same error as `resolveAiProvider()`.
 */
export function assertAiProviderHipaaCompliant(): void {
  resolveAiProvider();
}
