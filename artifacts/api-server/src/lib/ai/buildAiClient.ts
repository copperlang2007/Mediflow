/**
 * The single place an AI client is constructed.
 *
 * Before this file, four call sites (`routes/ai.ts`,
 * `routes/dev/feature-builder.ts`, `workers/weeklyComplianceReport.ts`,
 * `lib/dialer/transcriptParse.ts`) each carried their own copy of the same
 * forty lines. The copies drifted — twice in one PR — and each drift was a
 * chance for one path to construct a client the HIPAA guard had not gated.
 * A PHI system should have exactly one answer to "which vendor are we about
 * to send this to", so there is now exactly one.
 *
 * Returns `null` — never throws — when AI is not configured or the provider
 * is not usable. The authoritative fail-fast is
 * `assertAiProviderHipaaCompliant()` at bootstrap (`index.ts`): the process
 * refuses to start on a non-BAA provider in production, so a lazy throw here
 * would be unreachable in prod while breaking the callers' contracts (the
 * transcript webhook must not 5xx; a worker must not die).
 */

import OpenAI, { AzureOpenAI } from "openai";
import {
  resolveAiProvider,
  resolveAiApiKey,
  resolveAiBaseUrl,
} from "../aiProvider";
import {
  createBedrockAnthropicClient,
  type ChatCompletionClient,
} from "./bedrockAnthropicClient";

export interface BuildAiClientOptions {
  /**
   * Azure deployment to fall back to when `AI_INTEGRATIONS_AZURE_DEPLOYMENT`
   * is unset. The deployment in the URL overrides the `model` field in the
   * request body, so feature-builder passes its own model id here to keep
   * routing to the matching deployment.
   */
  azureDeploymentFallback?: string;
}

/**
 * Build the configured AI client, or `null` if one cannot be built.
 *
 * The returned client always presents the Chat Completions shape:
 *   - `azure`   — Azure OpenAI, which genuinely speaks it.
 *   - `bedrock` — Claude on Amazon Bedrock, which speaks the Anthropic
 *                 Messages API; adapted by `createBedrockAnthropicClient()`.
 *   - `openai`  — the direct API. Dev/test only; the boot guard blocks it in
 *                 production because OpenAI offers no HIPAA BAA.
 */
export function buildAiClient(
  opts: BuildAiClientOptions = {},
): ChatCompletionClient | null {
  try {
    const provider = resolveAiProvider();
    const apiKey = resolveAiApiKey(provider);
    if (!apiKey) return null;

    if (provider === "azure") {
      const resource = process.env.AI_INTEGRATIONS_AZURE_RESOURCE;
      const endpoint =
        process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
        (resource ? `https://${resource}.openai.azure.com` : undefined);
      if (!endpoint) return null;
      const apiVersion =
        process.env.AI_INTEGRATIONS_AZURE_API_VERSION ?? "2024-02-15-preview";
      const deployment =
        process.env.AI_INTEGRATIONS_AZURE_DEPLOYMENT ??
        opts.azureDeploymentFallback;
      return new AzureOpenAI({
        apiKey,
        endpoint,
        apiVersion,
        deployment,
      }) as unknown as ChatCompletionClient;
    }

    const baseURL = resolveAiBaseUrl(provider);
    if (!baseURL) return null;

    if (provider === "bedrock") {
      return createBedrockAnthropicClient({ apiKey, baseURL });
    }

    return new OpenAI({ apiKey, baseURL }) as unknown as ChatCompletionClient;
  } catch {
    return null;
  }
}
