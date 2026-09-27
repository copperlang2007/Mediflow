import { describe, it, expect } from "vitest";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../../lib/campaigns/unsubscribeToken";
import { signSvixPayload, verifySvixSignature } from "../../lib/campaigns/svix";
import {
  isWithinSendWindow,
  nextSendWindowStart,
  timeZoneForState,
} from "../../lib/campaigns/quietHours";
import { applyMergeFields, smsSegments, withStopLine } from "../../lib/campaigns/render";

const SECRET = "unit-test-secret-0123456789abcdef-xyz";

describe("unsubscribe tokens", () => {
  it("round-trips and rejects tampering or a different key", () => {
    const t = signUnsubscribeToken({ kind: "r", id: "abc-123" }, SECRET)!;
    expect(verifyUnsubscribeToken(t, SECRET)).toEqual({ kind: "r", id: "abc-123" });
    const [p, s] = t.split(".");
    const otherPayload = Buffer.from("r:abc-124").toString("base64url");
    expect(verifyUnsubscribeToken(`${otherPayload}.${s}`, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(`${p}.${s}x`, SECRET)).toBeNull();
    expect(verifyUnsubscribeToken(t, `${SECRET}-rotated`)).toBeNull();
    expect(verifyUnsubscribeToken(t, null)).toBeNull();
  });

  it("does not sign without a secret", () => {
    expect(signUnsubscribeToken({ kind: "c", id: "x" }, null)).toBeNull();
  });
});

describe("svix verification", () => {
  const secret = `whsec_${Buffer.from("k").toString("base64")}`;
  it("accepts a fresh signature and rejects a stale one", () => {
    const now = 1_800_000_000;
    const sig = signSvixPayload(secret, "id1", String(now), "{}");
    expect(verifySvixSignature({ secret, id: "id1", timestamp: String(now), signature: sig, rawBody: "{}", nowSeconds: now })).toBe(true);
    expect(verifySvixSignature({ secret, id: "id1", timestamp: String(now), signature: sig, rawBody: "{ }", nowSeconds: now })).toBe(false);
    expect(verifySvixSignature({ secret, id: "id1", timestamp: String(now), signature: sig, rawBody: "{}", nowSeconds: now + 3600 })).toBe(false);
    expect(verifySvixSignature({ secret: null, id: "id1", timestamp: String(now), signature: sig, rawBody: "{}", nowSeconds: now })).toBe(false);
  });
});

describe("quiet hours", () => {
  it("maps states to zones and keeps sends inside 8am–9pm local", () => {
    expect(timeZoneForState("ca", "America/New_York")).toBe("America/Los_Angeles");
    expect(timeZoneForState(null, "America/Chicago")).toBe("America/Chicago");
    expect(timeZoneForState("ZZ", "Not/AZone")).toBe("America/New_York");
    const tz = "America/New_York";
    expect(isWithinSendWindow(new Date("2027-01-15T14:00:00Z"), tz)).toBe(true); // 9am
    expect(isWithinSendWindow(new Date("2027-01-16T02:30:00Z"), tz)).toBe(false); // 9:30pm
    const next = nextSendWindowStart(new Date("2027-01-16T02:30:00Z"), tz);
    expect(next.toISOString()).toBe("2027-01-16T13:00:00.000Z"); // 8am next day
  });
});

describe("render helpers", () => {
  it("escapes merge values in HTML and blanks unknown tokens", () => {
    const ctx = { first_name: "<b>Al</b>", last_name: "", agency_name: "A", agent_name: "", plan_type: "", carrier: "", plan_year: "" };
    expect(applyMergeFields("Hi {{first_name}}{{ssn}}", ctx, { html: true })).toBe("Hi &lt;b&gt;Al&lt;/b&gt;");
    expect(withStopLine("Hello")).toBe("Hello\nReply STOP to opt out.");
    expect(withStopLine("Hello. Reply STOP to end")).toBe("Hello. Reply STOP to end");
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
  });
});
