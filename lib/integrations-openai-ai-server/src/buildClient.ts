/**
 * Shared client builder for both the top-level `client`, the image
 * client, and the audio client. See `./client.ts` for the rationale on
 * why we dispatch by `AI_INTEGRATIONS_PROVIDER`.
 *
 * HIPAA guard: MediFlow sends PHI to the LLM provider. Only Azure OpenAI
 * is BAA-covered. In production (`NODE_ENV === "production"`) this builder
 * hard-fails unless `AI_INTEGRATIONS_PROVIDER=azure`, so a misconfigured
 * deploy cannot silently route PHI to the standard OpenAI API (no BAA).
 * In dev/test the standard API is allowed. This mirrors the guard in
 * `artifacts/api-server/src/lib/aiProvider.ts`.
 */
import OpenAI, { AzureOpenAI } from "openai";

/** The HIPAA-eligible provider value. Azure OpenAI is BAA-covered. */
export const HIPAA_ELIGIBLE_PROVIDER = "azure" as const;

export function buildOpenAIClient(): OpenAI {
  if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
    );
  }

  const provider = (process.env.AI_INTEGRATIONS_PROVIDER ?? "openai").toLowerCase();

  if (process.env.NODE_ENV === "production" && provider !== HIPAA_ELIGIBLE_PROVIDER) {
    throw new Error(
      "FATAL: AI_INTEGRATIONS_PROVIDER must be 'azure' in production — " +
        "the standard OpenAI API has no HIPAA BAA and must not receive PHI. " +
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

  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
    throw new Error(
      "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
    );
  }
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}
