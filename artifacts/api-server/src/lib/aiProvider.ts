/**
 * AI provider resolution + HIPAA guard.
 *
 * MediFlow's AI features send full contact Medicare profiles (PHI) to an
 * LLM provider in the system prompt. The provider is selected by the
 * `AI_INTEGRATIONS_PROVIDER` env var:
 *
 *   - `azure`  — Azure OpenAI. The ONLY HIPAA-eligible path: Microsoft
 *                offers a BAA covering Azure OpenAI.
 *   - `openai` — the standard `api.openai.com` API. OpenAI does NOT offer
 *                a HIPAA BAA for this endpoint, so it must NEVER receive
 *                PHI. Allowed only in dev/test.
 *
 * In production (`NODE_ENV === "production"`) we hard-fail at boot unless
 * the provider is explicitly `azure`, so a misconfigured prod deploy dies
 * fast and visibly instead of silently streaming PHI to a vendor with no
 * BAA on the first patient interaction.
 *
 * This mirrors the `PHI_ENCRYPTION_KEY` boot check in
 * `lib/db/src/encryption/medicareId.ts` (PR #64): production env
 * misconfiguration is fatal, dev/test keeps the permissive default.
 *
 * Every LLM-client construction site MUST resolve the provider through
 * `resolveAiProvider()` so the guard cannot be bypassed.
 */

/** The HIPAA-eligible provider value. Azure OpenAI is BAA-covered. */
export const HIPAA_ELIGIBLE_PROVIDER = "azure" as const;

export type AiProvider = "azure" | "openai";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Resolve the configured AI provider and enforce the HIPAA guard.
 *
 * In production, throws unless the provider is explicitly `azure`. In
 * non-production, returns the configured provider (default `openai`)
 * without restriction so local dev and the test suite still work.
 */
export function resolveAiProvider(): AiProvider {
  const raw = (process.env.AI_INTEGRATIONS_PROVIDER ?? "openai").toLowerCase();

  if (isProduction() && raw !== HIPAA_ELIGIBLE_PROVIDER) {
    throw new Error(
      "FATAL: AI_INTEGRATIONS_PROVIDER must be 'azure' in production — " +
        "the standard OpenAI API has no HIPAA BAA and must not receive PHI. " +
        `Got: ${process.env.AI_INTEGRATIONS_PROVIDER ?? "<unset>"}`,
    );
  }

  return raw === HIPAA_ELIGIBLE_PROVIDER ? "azure" : "openai";
}

/**
 * Boot-time assertion. Call once at app/worker bootstrap so a
 * misconfigured production deploy fails fast — before the first AI call.
 * Throws the same error as `resolveAiProvider()`.
 */
export function assertAiProviderHipaaCompliant(): void {
  resolveAiProvider();
}
