/**
 * Integration test: Twilio inbound SMS webhook URL reconstruction.
 *
 * Previously the route trusted attacker-controllable Host /
 * X-Forwarded-Proto headers to rebuild the URL that Twilio signed —
 * which is operationally fragile (header mismatch behind a misbehaving
 * proxy silently 403s legitimate inbound SMS). The fix introduces a
 * new env var `TWILIO_WEBHOOK_PUBLIC_HOST` that pins the URL host;
 * the header path is retained as a fallback so dev/tunnel workflows
 * keep working.
 *
 * These tests intercept `validateTwilioWebhookSignature` to capture the
 * URL the route passes in. We never make real signature validation calls.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

const { dbF, authF, jobsF, smsF, sseF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  authF: async (): Promise<Record<string, unknown>> => {
    const { identityMockFactory } = await import("../helpers/testApp");
    return identityMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
  // Spy on validateTwilioWebhookSignature — return true to short-circuit
  // signature checking, but capture the URL the route reconstructs.
  smsF: async (): Promise<Record<string, unknown>> => {
    const actual = await import("../../lib/sms");
    return {
      ...actual,
      validateTwilioWebhookSignature: vi.fn(() => true),
      classifyInboundMessage: actual.classifyInboundMessage,
    };
  },
  sseF: async (): Promise<Record<string, unknown>> => {
    const actual = await import("../../lib/sseManager");
    return {
      ...actual,
      broadcastToUser: vi.fn(),
    };
  },
}));

vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/sms", smsF);
vi.mock("../../lib/sseManager", sseF);

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import type { Express } from "express";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;
let validateSig: ReturnType<typeof vi.fn>;

const ORIGINAL_PUBLIC_HOST = process.env.TWILIO_WEBHOOK_PUBLIC_HOST;

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports
  request = ((await import("supertest")) as any).default;

  const sms = await import("../../lib/sms");
  validateSig = sms.validateTwilioWebhookSignature as ReturnType<typeof vi.fn>;
});

afterAll(async () => {
  await shutdownTestDb();
});

afterEach(() => {
  if (ORIGINAL_PUBLIC_HOST === undefined) {
    delete process.env.TWILIO_WEBHOOK_PUBLIC_HOST;
  } else {
    process.env.TWILIO_WEBHOOK_PUBLIC_HOST = ORIGINAL_PUBLIC_HOST;
  }
  validateSig.mockClear();
});

describe("Twilio webhook URL reconstruction", () => {
  it("uses TWILIO_WEBHOOK_PUBLIC_HOST when set, ignoring spoofed headers", async () => {
    process.env.TWILIO_WEBHOOK_PUBLIC_HOST = "https://mediflow.app";

    const res = await request(app)
      .post("/webhooks/twilio/sms")
      .set("Host", "attacker.example.com")
      .set("X-Forwarded-Proto", "http")
      .set("X-Twilio-Signature", "fake-sig")
      .type("form")
      .send({
        From: "+15555550000",
        To: "+15555550001",
        Body: "hello",
        MessageSid: "SM-host-pin-test-1",
      });

    expect(res.status).toBe(200);
    expect(validateSig).toHaveBeenCalledTimes(1);
    const [url] = validateSig.mock.calls[0];
    expect(url).toBe("https://mediflow.app/webhooks/twilio/sms");
    expect(url).not.toContain("attacker.example.com");
  });

  it("strips a trailing slash on TWILIO_WEBHOOK_PUBLIC_HOST", async () => {
    process.env.TWILIO_WEBHOOK_PUBLIC_HOST = "https://mediflow.app/";

    const res = await request(app)
      .post("/webhooks/twilio/sms")
      .set("X-Twilio-Signature", "fake-sig")
      .type("form")
      .send({
        From: "+15555550000",
        To: "+15555550001",
        Body: "hello",
        MessageSid: "SM-host-pin-test-2",
      });

    expect(res.status).toBe(200);
    const [url] = validateSig.mock.calls[0];
    // Should not have double-slash before the path.
    expect(url).toBe("https://mediflow.app/webhooks/twilio/sms");
  });

  it("falls back to Host + X-Forwarded-Proto when TWILIO_WEBHOOK_PUBLIC_HOST is unset", async () => {
    delete process.env.TWILIO_WEBHOOK_PUBLIC_HOST;

    const res = await request(app)
      .post("/webhooks/twilio/sms")
      .set("Host", "tunnel.ngrok.io")
      .set("X-Forwarded-Proto", "https")
      .set("X-Twilio-Signature", "fake-sig")
      .type("form")
      .send({
        From: "+15555550000",
        To: "+15555550001",
        Body: "hello",
        MessageSid: "SM-host-pin-test-3",
      });

    expect(res.status).toBe(200);
    const [url] = validateSig.mock.calls[0];
    expect(url).toBe("https://tunnel.ngrok.io/webhooks/twilio/sms");
  });
});
