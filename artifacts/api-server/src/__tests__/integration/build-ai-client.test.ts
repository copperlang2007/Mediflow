/**
 * Provider dispatch — which vendor agencyBRIDGE is about to send PHI to.
 *
 * `buildAiClient()` replaced four hand-copied construction blocks that had
 * already drifted from each other twice. These tests pin the property that
 * mattered in every one of those drifts: the provider decides the client, the
 * guard is never bypassed, and a misconfiguration returns null rather than
 * throwing into a caller that must not 5xx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const anthropicCtor = vi.fn();
const openaiCtor = vi.fn();
const azureCtor = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: vi.fn() };
    constructor(opts: unknown) {
      anthropicCtor(opts);
    }
  },
}));

vi.mock("openai", () => ({
  default: class {
    constructor(opts: unknown) {
      openaiCtor(opts);
    }
  },
  AzureOpenAI: class {
    constructor(opts: unknown) {
      azureCtor(opts);
    }
  },
}));

import { buildAiClient } from "../../lib/ai/buildAiClient";

const AI_ENV = [
  "AI_INTEGRATIONS_PROVIDER",
  "AI_INTEGRATIONS_BEDROCK_API_KEY",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_BEDROCK_BASE_URL",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
  "AI_INTEGRATIONS_AZURE_RESOURCE",
  "AI_INTEGRATIONS_AZURE_DEPLOYMENT",
  "AI_INTEGRATIONS_MODEL",
] as const;

describe("buildAiClient — provider dispatch", () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const prior: Record<string, string | undefined> = {};

  beforeEach(() => {
    anthropicCtor.mockReset();
    openaiCtor.mockReset();
    azureCtor.mockReset();
    for (const k of AI_ENV) {
      prior[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env.NODE_ENV = priorNodeEnv;
    for (const k of AI_ENV) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  });

  it("builds the Anthropic Messages adapter for bedrock — never the OpenAI SDK", () => {
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";
    process.env.AI_INTEGRATIONS_BEDROCK_API_KEY = "bedrock-token";
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-mantle.us-east-1.api.aws/anthropic";

    expect(buildAiClient()).not.toBeNull();
    expect(anthropicCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "bedrock-token",
        baseURL: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      }),
    );
    // The whole point of PR: Bedrock does not speak Chat Completions.
    expect(openaiCtor).not.toHaveBeenCalled();
  });

  it("builds AzureOpenAI for azure, honouring the deployment fallback", () => {
    process.env.AI_INTEGRATIONS_PROVIDER = "azure";
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "azure-key";
    process.env.AI_INTEGRATIONS_AZURE_RESOURCE = "my-resource";

    expect(buildAiClient({ azureDeploymentFallback: "fb-model" })).not.toBeNull();
    expect(azureCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "azure-key",
        endpoint: "https://my-resource.openai.azure.com",
        deployment: "fb-model",
      }),
    );
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("returns null — not a throw — for a non-BAA provider in production", () => {
    // The boot guard is the fail-fast. A lazy throw here would 5xx the
    // transcript webhook, whose contract forbids it.
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "openai";
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "sk-test";
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://api.openai.com/v1";

    expect(buildAiClient()).toBeNull();
    expect(openaiCtor).not.toHaveBeenCalled();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("returns null when the provider is eligible but no key is set", () => {
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL = "https://example.invalid";
    expect(buildAiClient()).toBeNull();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("returns null when the provider is eligible but no base URL is set", () => {
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";
    process.env.AI_INTEGRATIONS_BEDROCK_API_KEY = "bedrock-token";
    expect(buildAiClient()).toBeNull();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("returns null when bedrock routing cannot work, so AI degrades and the app lives", () => {
    // The other half of demoting the routing checks from boot-FATAL: the
    // process stays up, and every AI path gets a null client (a 503 from
    // /ai/chat, a skipped transcript parse) rather than an opaque provider
    // error mid-request.
    // Reported by the AWS review agent on PR #207.
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";
    process.env.AI_INTEGRATIONS_BEDROCK_API_KEY = "bedrock-token";
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1";
    process.env.AI_INTEGRATIONS_MODEL = "us.anthropic.claude-sonnet-4-6";

    expect(buildAiClient()).toBeNull();
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it("still reads the legacy key name so a pre-rename environment boots", () => {
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "legacy-bedrock-token";
    // A ROUTABLE base URL: this case is about the key name, and a placeholder
    // host now makes the client null for an unrelated reason (no provider
    // prefix can be inferred), which would have passed for the wrong reason.
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";

    expect(buildAiClient()).not.toBeNull();
    expect(anthropicCtor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "legacy-bedrock-token" }),
    );
  });
});
