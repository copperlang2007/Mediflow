/**
 * Unit test: HIPAA provider guard (`lib/aiProvider.ts`).
 *
 * MediFlow streams full contact Medicare profiles (PHI) to the LLM
 * provider in the system prompt. Only BAA-covered providers may receive
 * PHI: `azure` (Microsoft BAA) and `bedrock` (AWS BAA). The standard
 * `api.openai.com` API has no HIPAA BAA and must never receive PHI. In
 * production the app must hard-fail at boot unless the provider is a
 * HIPAA-eligible value.
 *
 * These tests exercise `resolveAiProvider()` / `assertAiProviderHipaaCompliant()`
 * directly across `NODE_ENV` x `AI_INTEGRATIONS_PROVIDER` combinations.
 * They make no network calls and need no DB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveAiProvider,
  assertAiProviderHipaaCompliant,
  HIPAA_ELIGIBLE_PROVIDERS,
  resolveAiBaseUrl,
} from "../../lib/aiProvider";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_PROVIDER = process.env.AI_INTEGRATIONS_PROVIDER;

function restore(): void {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_PROVIDER === undefined) delete process.env.AI_INTEGRATIONS_PROVIDER;
  else process.env.AI_INTEGRATIONS_PROVIDER = ORIGINAL_PROVIDER;
}

afterEach(restore);

describe("HIPAA provider guard — production", () => {
  it("throws when AI_INTEGRATIONS_PROVIDER is unset in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AI_INTEGRATIONS_PROVIDER;

    expect(() => resolveAiProvider()).toThrow(/HIPAA-eligible provider/);
    expect(() => assertAiProviderHipaaCompliant()).toThrow(/HIPAA BAA/);
  });

  it("throws when AI_INTEGRATIONS_PROVIDER is 'openai' in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "openai";

    expect(() => resolveAiProvider()).toThrow(/HIPAA-eligible provider/);
    expect(() => assertAiProviderHipaaCompliant()).toThrow();
  });

  it("throws on an unrecognized provider value in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "anthropic";

    expect(() => resolveAiProvider()).toThrow(/HIPAA-eligible provider/);
  });

  it("does NOT throw when AI_INTEGRATIONS_PROVIDER is 'azure' in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "azure";

    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("azure");
  });

  it("does NOT throw when AI_INTEGRATIONS_PROVIDER is 'bedrock' in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";

    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("bedrock");
  });

  it("accepts HIPAA-eligible providers case-insensitively in production", () => {
    process.env.NODE_ENV = "production";

    process.env.AI_INTEGRATIONS_PROVIDER = "AZURE";
    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("azure");

    process.env.AI_INTEGRATIONS_PROVIDER = "Bedrock";
    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("bedrock");
  });
});

describe("HIPAA provider guard — non-production (current behavior preserved)", () => {
  it("allows the default (unset) provider in test env", () => {
    process.env.NODE_ENV = "test";
    delete process.env.AI_INTEGRATIONS_PROVIDER;

    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("openai");
  });

  it("allows the standard 'openai' provider in development env", () => {
    process.env.NODE_ENV = "development";
    process.env.AI_INTEGRATIONS_PROVIDER = "openai";

    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("openai");
  });

  it("allows the standard 'openai' provider when NODE_ENV is unset", () => {
    delete process.env.NODE_ENV;
    process.env.AI_INTEGRATIONS_PROVIDER = "openai";

    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("openai");
  });

  it("still allows 'azure' and 'bedrock' in non-production", () => {
    process.env.NODE_ENV = "development";

    process.env.AI_INTEGRATIONS_PROVIDER = "azure";
    expect(resolveAiProvider()).toBe("azure");

    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";
    expect(resolveAiProvider()).toBe("bedrock");
  });
});

describe("HIPAA_ELIGIBLE_PROVIDERS constant", () => {
  it("covers exactly the BAA-eligible providers: azure and bedrock", () => {
    expect(HIPAA_ELIGIBLE_PROVIDERS.has("azure")).toBe(true);
    expect(HIPAA_ELIGIBLE_PROVIDERS.has("bedrock")).toBe(true);
    expect(HIPAA_ELIGIBLE_PROVIDERS.size).toBe(2);
  });
});

describe("resolveAiBaseUrl — the variable is named per provider, not per SDK", () => {
  const KEYS = [
    "AI_INTEGRATIONS_BEDROCK_BASE_URL",
    "AI_INTEGRATIONS_OPENAI_BASE_URL",
  ] as const;

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("reads the BEDROCK-named variable for the bedrock provider", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
    expect(resolveAiBaseUrl("bedrock")).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
    );
  });

  it("prefers the BEDROCK name over the legacy OPENAI name when both are set", () => {
    // The whole point of the rename: an environment mid-migration must resolve
    // to the new value, not silently keep using the stale OpenAI-shaped URL.
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1";
    expect(resolveAiBaseUrl("bedrock")).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
    );
  });

  it("falls back to the legacy OPENAI name so a pre-rename deploy still boots", () => {
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://legacy.example/v1";
    expect(resolveAiBaseUrl("bedrock")).toBe("https://legacy.example/v1");
  });

  it("does NOT read the BEDROCK name for azure — that endpoint really is OpenAI-shaped", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL = "https://bedrock.example/anthropic";
    expect(resolveAiBaseUrl("azure")).toBeUndefined();

    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://azure.example/openai";
    expect(resolveAiBaseUrl("azure")).toBe("https://azure.example/openai");
  });

  it("treats a whitespace-only value as unset rather than as a URL", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL = "   ";
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://legacy.example/v1";
    expect(resolveAiBaseUrl("bedrock")).toBe("https://legacy.example/v1");
  });
});
