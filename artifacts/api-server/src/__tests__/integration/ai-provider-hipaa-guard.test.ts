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
  resolveAiApiKey,
  aiApiKeyVarName,
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

describe("resolveAiApiKey — the credential is a Bedrock token, not an OpenAI key", () => {
  const KEYS = [
    "AI_INTEGRATIONS_BEDROCK_API_KEY",
    "AI_INTEGRATIONS_OPENAI_API_KEY",
  ] as const;

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("reads the BEDROCK-named variable for the bedrock provider", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_API_KEY = "bedrock-token";
    expect(resolveAiApiKey("bedrock")).toBe("bedrock-token");
  });

  it("prefers the BEDROCK name over the legacy OPENAI name when both are set", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_API_KEY = "new-token";
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "stale-token";
    expect(resolveAiApiKey("bedrock")).toBe("new-token");
  });

  it("falls back to the legacy OPENAI name so a pre-rename deploy still boots", () => {
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "legacy-token";
    expect(resolveAiApiKey("bedrock")).toBe("legacy-token");
  });

  it("does NOT read the bedrock name for azure — azure's key really is OpenAI-shaped", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_API_KEY = "bedrock-token";
    expect(resolveAiApiKey("azure")).toBeUndefined();
  });

  it("treats a whitespace-only value as unset", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_API_KEY = "   ";
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "real-token";
    expect(resolveAiApiKey("bedrock")).toBe("real-token");
  });

  it("names the canonical variable per provider for operator-facing messages", () => {
    expect(aiApiKeyVarName("bedrock")).toBe("AI_INTEGRATIONS_BEDROCK_API_KEY");
    expect(aiApiKeyVarName("azure")).toBe("AI_INTEGRATIONS_OPENAI_API_KEY");
  });
});

describe("assertAiProviderHipaaCompliant — bedrock model routability at boot", () => {
  // `/admin/health/ai` already reports an unroutable bare model id, but only
  // to someone who goes looking. Without this check a GovCloud/China/private-
  // DNS deploy boots clean, passes its container health check, serves every
  // non-AI route, and fails on the first AI request a real user makes.
  const KEYS = [
    "AI_INTEGRATIONS_PROVIDER",
    "AI_INTEGRATIONS_MODEL",
    "AI_INTEGRATIONS_BEDROCK_BASE_URL",
    "AI_INTEGRATIONS_OPENAI_BASE_URL",
  ] as const;
  const prior: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      prior[k] = process.env[k];
      delete process.env[k];
    }
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  });

  it("refuses to boot when a bare claude id cannot be prefixed for the host", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock.internal.example.com/anthropic";
    expect(() => assertAiProviderHipaaCompliant()).toThrow(
      /no Bedrock provider prefix/,
    );
  });

  it("boots on a recognised host, where the prefix is inferred at request time", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
  });

  it("boots on an unrecognised host when the operator qualified the id themselves", () => {
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock.internal.example.com/anthropic";
    process.env.AI_INTEGRATIONS_MODEL = "us.anthropic.claude-sonnet-5";
    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
  });

  it("refuses to boot on a non-Anthropic model id", () => {
    // The bedrock path speaks Bedrock's Anthropic Messages route, which serves
    // no other family. `gpt-5.4` is reachable for real: resolveAiModel() with
    // no provider argument returns the openai default.
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
    for (const bad of ["gpt-5.4", "us.amazon.nova-lite", "claude5-sonnet"]) {
      process.env.AI_INTEGRATIONS_MODEL = bad;
      expect(() => assertAiProviderHipaaCompliant()).toThrow(
        /is not an Anthropic model id/,
      );
    }
  });

  it("rejects the near-miss shapes a prefix check waves through", () => {
    // Wrong case, missing family, and a hyphen where the dot belongs. Each
    // looks close enough to a valid id to survive review and is rejected by
    // Bedrock at request time, not before.
    // Reported by the AWS review agent on PR #207.
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
    for (const bad of [
      "Claude-Sonnet-5",
      "sonnet-5",
      "us-anthropic.claude-sonnet-5",
    ]) {
      process.env.AI_INTEGRATIONS_MODEL = bad;
      expect(() => assertAiProviderHipaaCompliant()).toThrow(
        /is not an Anthropic model id/,
      );
    }
  });

  it("accepts every Anthropic id shape, bare or regionally prefixed", () => {
    // The boundary: this must not reject a configuration that works.
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
    for (const good of [
      "claude-sonnet-5",
      "anthropic.claude-sonnet-5",
      "us.anthropic.claude-sonnet-4-6",
      "global.anthropic.claude-sonnet-5",
    ]) {
      process.env.AI_INTEGRATIONS_MODEL = good;
      expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    }
  });

  it("refuses to boot on a base URL still pointing at /openai/v1", () => {
    // Chat Completions is unsupported for every Anthropic model — the exact
    // misconfiguration this PR exists to eliminate. It survived the earlier
    // guard because the host matches `bedrock-runtime` and the path is never
    // inspected.
    process.env.AI_INTEGRATIONS_MODEL = "us.anthropic.claude-sonnet-4-6";
    process.env.AI_INTEGRATIONS_BEDROCK_BASE_URL =
      "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1";
    expect(() => assertAiProviderHipaaCompliant()).toThrow(/openai\/v1/);
  });

  it("leaves a missing base URL to the caller that reports missing config", () => {
    // An absent base URL is already an issue on /admin/health/ai and makes
    // buildAiClient() return null. Throwing a MODEL error for it would name
    // the wrong variable.
    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
  });
});
