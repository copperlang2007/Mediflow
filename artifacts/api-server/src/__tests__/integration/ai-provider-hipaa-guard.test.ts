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
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveAiProvider,
  assertAiProviderHipaaCompliant,
  HIPAA_ELIGIBLE_PROVIDERS,
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
