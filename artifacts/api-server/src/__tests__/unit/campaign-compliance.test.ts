import { describe, it, expect } from "vitest";
import { signSvixPayload, verifySvixSignature } from "../../lib/campaigns/svix";
// Unsubscribe tokens and texting-hours rules are the shared compliance
// modules (lib/compliance/unsubscribe.ts, quietHours.ts), tested in
// lib/compliance/__tests__.
import { applyMergeFields, smsSegments, withStopLine } from "../../lib/campaigns/render";

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
