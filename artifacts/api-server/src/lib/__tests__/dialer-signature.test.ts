/**
 * Unit tests — masterBRIDGE webhook signature verification (spec §4.2).
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  parseSignatureHeader,
  computeSignature,
  verifyWebhookSignature,
} from "../dialer/signature";

const SECRET = "shh";
const NOW = 1_700_000_000;

function header(rawBody: string, t = NOW, secret = SECRET): string {
  return `t=${t},v1=${computeSignature(secret, t, rawBody)}`;
}

describe("parseSignatureHeader", () => {
  it("parses t and v1 regardless of ordering and ignores unknown parts", () => {
    expect(parseSignatureHeader("v1=abc,t=123,scheme=2")).toEqual({
      t: 123,
      v1: "abc",
    });
  });
  it("returns null on missing parts or empty header", () => {
    expect(parseSignatureHeader("t=123")).toBeNull();
    expect(parseSignatureHeader("v1=abc")).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader(undefined)).toBeNull();
  });
});

describe("computeSignature", () => {
  it("is HMAC-SHA256 over `${t}.${rawBody}`", () => {
    const raw = '{"a":1}';
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`${NOW}.${raw}`, "utf8")
      .digest("hex");
    expect(computeSignature(SECRET, NOW, raw)).toBe(expected);
    expect(computeSignature(SECRET, NOW, Buffer.from(raw))).toBe(expected);
  });
});

describe("verifyWebhookSignature", () => {
  const raw = '{"eventId":"evt_1"}';

  it("accepts a valid signature within tolerance", () => {
    const res = verifyWebhookSignature({
      secret: SECRET,
      header: header(raw),
      rawBody: raw,
      nowSeconds: NOW + 10,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a mismatched signature", () => {
    const res = verifyWebhookSignature({
      secret: SECRET,
      header: `t=${NOW},v1=deadbeef`,
      rawBody: raw,
      nowSeconds: NOW,
    });
    expect(res).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a stale timestamp beyond ±5 min", () => {
    const res = verifyWebhookSignature({
      secret: SECRET,
      header: header(raw, NOW),
      rawBody: raw,
      nowSeconds: NOW + 6 * 60,
    });
    expect(res).toEqual({ ok: false, reason: "stale" });
  });

  it("fails closed when the secret is unconfigured", () => {
    const res = verifyWebhookSignature({
      secret: undefined,
      header: header(raw),
      rawBody: raw,
    });
    expect(res).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("rejects a missing header", () => {
    const res = verifyWebhookSignature({
      secret: SECRET,
      header: undefined,
      rawBody: raw,
    });
    expect(res).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const sig = header(raw);
    const res = verifyWebhookSignature({
      secret: SECRET,
      header: sig,
      rawBody: raw + " ",
      nowSeconds: NOW,
    });
    expect(res.ok).toBe(false);
  });
});
