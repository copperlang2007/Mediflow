/**
 * Shared client builder for both the top-level `client`, the image
 * client, and the audio client. See `./client.ts` for the rationale on
 * why we dispatch by `AI_INTEGRATIONS_PROVIDER`.
 *
 * HIPAA guard: MediFlow sends PHI to the LLM provider. Only BAA-covered
 * providers may receive it: `azure` (Microsoft BAA) and `bedrock` (AWS BAA,
 * via Bedrock's OpenAI-compatible endpoint). In production
 * (`NODE_ENV === "production"`) this builder hard-fails unless the provider
 * is HIPAA-eligible, so a misconfigured deploy cannot silently route PHI to
 * the standard OpenAI API (no BAA). In dev/test the standard API is allowed.
 * This mirrors the guard in `artifacts/api-server/src/lib/aiProvider.ts`.
 */
import OpenAI, { AzureOpenAI } from "openai";

/** Providers covered by a HIPAA BAA: `azure` (Microsoft) and `bedrock` (AWS). */
export const HIPAA_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
  "azure",
  "bedrock",
]);

export function buildOpenAIClient(): OpenAI {
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
    );
  }

  const provider = (process.env.AI_INTEGRATIONS_PROVIDER ?? "openai").toLowerCase();

  if (process.env.NODE_ENV === "production" && !HIPAA_ELIGIBLE_PROVIDERS.has(provider)) {
    throw new Error(
      "FATAL: AI_INTEGRATIONS_PROVIDER must be a HIPAA-eligible provider " +
        "('azure' or 'bedrock') in production — the standard OpenAI API has no " +
        "HIPAA BAA and must not receive PHI. " +
        `Got: ${process.env.AI_INTEGRATIONS_PROVIDER ?? "<unset>"}`,
    );
  }

  if (provider === "azure") {
    const resource = process.env.AI_INTEGRATIONS_AZURE_RESOURCE;
    const endpoint =
      process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
      (resource ? `https://${resource}.openai.azure.com` : undefined);
    if (!endpoint) {
      throw new Error(
        "Azure provider selected but no endpoint configured. Set AI_INTEGRATIONS_AZURE_RESOURCE or AI_INTEGRATIONS_OPENAI_BASE_URL.",
      );
    }
    const apiVersion =
      process.env.AI_INTEGRATIONS_AZURE_API_VERSION ?? "2024-02-15-preview";
    const deployment = process.env.AI_INTEGRATIONS_AZURE_DEPLOYMENT;
    return new AzureOpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      endpoint,
      apiVersion,
      deployment,
    });
  }

  // Named per PROVIDER, not per SDK. Bedrock's endpoint is not an OpenAI
  // endpoint — AWS lists Chat Completions as NOT supported for every
  // Anthropic model, so a Bedrock base URL points at /anthropic, never at
  // /openai/v1. The legacy name stays readable as a fallback so environments
  // configured before the rename keep booting.
  const baseURL =
    provider === "bedrock"
      ? (process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL?.trim() ||
         process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim())
      : process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim();
  if (!baseURL) {
    const expected =
      provider === "bedrock"
        ? "AI_INTEGRATIONS_BEDROCK_BASE_URL"
        : "AI_INTEGRATIONS_OPENAI_BASE_URL";
    throw new Error(
      `${expected} must be set for provider "${provider}". Did you forget to provision the AI integration?`,
    );
  }
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL,
  });
}
