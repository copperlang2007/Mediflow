/**
 * Regression: the transcript webhook must degrade, never throw.
 *
 * `parseTranscript()` is called from `handleTranscriptReady`, whose contract
 * is explicit that "a failure must not 5xx the webhook" — a 500 makes the
 * dialer retry a request whose transcript hash is already stored.
 *
 * `buildDefaultAiClient()` calls `resolveAiProvider()`, which throws in
 * production for a non-HIPAA-eligible provider. That call briefly sat outside
 * the surrounding try/catch, so the throw propagated through parseTranscript →
 * handleTranscriptReady (neither catches) and became a 500.
 *
 * The authoritative fail-fast for a bad provider is
 * `assertAiProviderHipaaCompliant()` at bootstrap — the process refuses to
 * start — so re-throwing lazily here bought nothing and cost the contract.
 *
 * Reported by the AWS review agent on PR #206.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@workspace/db", () => ({}));

import { parseTranscript } from "../../lib/dialer/transcriptParse";

const AI_ENV = [
  "AI_INTEGRATIONS_PROVIDER",
  "AI_INTEGRATIONS_BEDROCK_API_KEY",
  "AI_INTEGRATIONS_OPENAI_API_KEY",
  "AI_INTEGRATIONS_BEDROCK_BASE_URL",
  "AI_INTEGRATIONS_OPENAI_BASE_URL",
] as const;

describe("parseTranscript — provider guard must not 5xx the webhook", () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorAi: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of AI_ENV) {
      priorAi[k] = process.env[k];
      delete process.env[k];
    }
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = priorNodeEnv;
    for (const k of AI_ENV) {
      if (priorAi[k] === undefined) delete process.env[k];
      else process.env[k] = priorAi[k];
    }
  });

  it("returns null (not a throw) when the provider is openai in production", async () => {
    process.env.AI_INTEGRATIONS_PROVIDER = "openai";
    await expect(
      parseTranscript("hello world", { dialTicketId: "dt-1" }),
    ).resolves.toBeNull();
  });

  it("returns null (not a throw) when the provider is unset in production", async () => {
    await expect(
      parseTranscript("hello world", { dialTicketId: "dt-2" }),
    ).resolves.toBeNull();
  });

  it("returns null (not a throw) on a typo'd provider in production", async () => {
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrok";
    await expect(
      parseTranscript("hello world", { dialTicketId: "dt-3" }),
    ).resolves.toBeNull();
  });

  it("still returns null for the eligible provider with no key configured", async () => {
    process.env.AI_INTEGRATIONS_PROVIDER = "bedrock";
    await expect(
      parseTranscript("hello world", { dialTicketId: "dt-4" }),
    ).resolves.toBeNull();
  });
});
