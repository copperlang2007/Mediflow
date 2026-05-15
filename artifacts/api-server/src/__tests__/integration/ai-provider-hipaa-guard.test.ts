/**
 * Unit test: HIPAA provider guard (`lib/aiProvider.ts`).
 *
 * MediFlow streams full contact Medicare profiles (PHI) to the LLM
 * provider in the system prompt. Only Azure OpenAI is BAA-covered; the
 * standard `api.openai.com` API has no HIPAA BAA and must never receive
 * PHI. In production the app must hard-fail at boot unless the provider
 * is explicitly `azure`.
 *
 * These tests exercise `resolveAiProvider()` / `assertAiProviderHipaaCompliant()`
 * directly across `NODE_ENV` x `AI_INTEGRATIONS_PROVIDER` combinations.
 * They make no network calls and need no DB.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveAiProvider,
  assertAiProviderHipaaCompliant,
  HIPAA_ELIGIBLE_PROVIDER,
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

    expect(() => resolveAiProvider()).toThrow(/must be 'azure' in production/);
    expect(() => assertAiProviderHipaaCompliant()).toThrow(/HIPAA BAA/);
  });

  it("throws when AI_INTEGRATIONS_PROVIDER is 'openai' in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "openai";

    expect(() => resolveAiProvider()).toThrow(/must be 'azure' in production/);
    expect(() => assertAiProviderHipaaCompliant()).toThrow();
  });

  it("throws on an unrecognized provider value in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "anthropic";

    expect(() => resolveAiProvider()).toThrow(/must be 'azure' in production/);
  });

  it("does NOT throw when AI_INTEGRATIONS_PROVIDER is 'azure' in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "azure";

    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("azure");
  });

  it("accepts 'azure' case-insensitively in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AI_INTEGRATIONS_PROVIDER = "AZURE";

    expect(() => assertAiProviderHipaaCompliant()).not.toThrow();
    expect(resolveAiProvider()).toBe("azure");
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

  it("still allows 'azure' in non-production", () => {
    process.env.NODE_ENV = "development";
    process.env.AI_INTEGRATIONS_PROVIDER = "azure";

    expect(resolveAiProvider()).toBe("azure");
  });
});

describe("HIPAA_ELIGIBLE_PROVIDER constant", () => {
  it("is the literal 'azure' — the only BAA-covered path", () => {
    expect(HIPAA_ELIGIBLE_PROVIDER).toBe("azure");
  });
});
