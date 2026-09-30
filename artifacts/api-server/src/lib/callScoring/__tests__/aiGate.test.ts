/**
 * Guard: the AI used for call scoring comes from the one HIPAA-gated client
 * builder. It has exactly two provider branches that are allowed in production
 * (azure, bedrock); the direct OpenAI branch exists only outside production.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAiClient } from "../../ai/buildAiClient";
import { resolveAiReviewer } from "../aiReviewer";

const source = readFileSync(fileURLToPath(new URL("../../ai/buildAiClient.ts", import.meta.url)), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
});

function env(provider: string, nodeEnv: string) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("AI_INTEGRATIONS_PROVIDER", provider);
  vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "test-key-not-real");
  vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "https://example.invalid/v1");
  vi.stubEnv("AI_INTEGRATIONS_AZURE_RESOURCE", "example");
}

describe("the AI client used by call scoring is HIPAA-gated", () => {
  it("has only azure and bedrock provider branches, and OpenAI only as the non-provider fallthrough", () => {
    const branches = [...source.matchAll(/provider === "([a-z]+)"/g)].map((m) => m[1]);
    expect(new Set(branches)).toEqual(new Set(["azure", "bedrock"]));
    expect(source.match(/new OpenAI\(/g)).toHaveLength(1);
    expect(source.match(/new AzureOpenAI\(/g)).toHaveLength(1);
  });

  it("in production, OpenAI (no BAA) never yields a client, so scoring reports needs_setup", () => {
    env("openai", "production");
    expect(buildAiClient()).toBeNull();
    expect(resolveAiReviewer()).toBeNull();
    // An unknown provider name is treated the same way.
    env("something-else", "production");
    expect(buildAiClient()).toBeNull();
    expect(resolveAiReviewer()).toBeNull();
  });

  it("in production, azure and bedrock are the providers that can build a client", () => {
    env("azure", "production");
    expect(buildAiClient()).not.toBeNull();
    env("bedrock", "production");
    vi.stubEnv("AI_INTEGRATIONS_BEDROCK_BASE_URL", "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic/v1");
    vi.stubEnv("AI_INTEGRATIONS_MODEL", "claude-sonnet-5");
    expect(buildAiClient()).not.toBeNull();
  });

  it("outside production the direct OpenAI client is allowed (dev and tests)", () => {
    env("openai", "development");
    expect(buildAiClient()).not.toBeNull();
    expect(resolveAiReviewer()).not.toBeNull();
  });

  it("with no key configured there is no reviewer at all", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_INTEGRATIONS_PROVIDER", "azure");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "");
    expect(resolveAiReviewer()).toBeNull();
  });
});
