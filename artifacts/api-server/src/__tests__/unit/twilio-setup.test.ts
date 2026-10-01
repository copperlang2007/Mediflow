import { describe, it, expect } from "vitest";
import { twilioSetupStatus } from "../../lib/twilioSetup";

const SID = (p: string) => `${p}${"0123456789abcdef".repeat(2)}`;
const FULL = {
  TWILIO_ACCOUNT_SID: SID("AC"),
  TWILIO_AUTH_TOKEN: "auth-token-value",
  TWILIO_FROM_NUMBER: "+15125550100",
  TWILIO_VOICE_CALLER_ID: "+15125550100",
  TWILIO_API_KEY_SID: SID("SK"),
  TWILIO_API_KEY_SECRET: "api-key-secret-value",
  TWILIO_TWIML_APP_SID: SID("AP"),
  TWILIO_WEBHOOK_PUBLIC_HOST: "https://app.example.com/",
};

describe("twilioSetupStatus", () => {
  it("is ready for texting and calling when every setting is well-formed", () => {
    const s = twilioSetupStatus(FULL);
    expect(s.sms.ready).toBe(true);
    expect(s.voice.ready).toBe(true);
    expect(s.webhooks).toEqual({
      smsInbound: "https://app.example.com/webhooks/twilio/sms",
      voiceRequest: "https://app.example.com/api/webhooks/twilio/voice",
      voiceStatus: "https://app.example.com/api/webhooks/twilio/voice-status",
    });
  });

  it("names what is missing or malformed, never a value", () => {
    const s = twilioSetupStatus({ ...FULL, TWILIO_FROM_NUMBER: "512-555-0100", TWILIO_API_KEY_SECRET: " ", TWILIO_WEBHOOK_PUBLIC_HOST: "http://app.example.com/x" });
    expect(s.sms.ready).toBe(false);
    expect(s.voice.ready).toBe(false);
    expect(s.sms.checks.find((c) => c.name === "TWILIO_FROM_NUMBER")).toMatchObject({ ok: false, problem: expect.stringMatching(/\+1512/) });
    expect(s.voice.checks.find((c) => c.name === "TWILIO_API_KEY_SECRET")).toEqual({ name: "TWILIO_API_KEY_SECRET", ok: false, problem: "not set" });
    expect(s.webhooks).toBeNull();
    const text = JSON.stringify(s);
    for (const v of ["auth-token-value", "512-555-0100", SID("AC"), SID("SK")]) expect(text).not.toContain(v);
  });

  it("reports everything unset on a fresh deployment", () => {
    const s = twilioSetupStatus({});
    expect(s.sms.checks.every((c) => !c.ok && c.problem === "not set")).toBe(true);
    expect(s.voice.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["TWILIO_TWIML_APP_SID", "TWILIO_VOICE_CALLER_ID", "TWILIO_WEBHOOK_PUBLIC_HOST"]));
  });
});
