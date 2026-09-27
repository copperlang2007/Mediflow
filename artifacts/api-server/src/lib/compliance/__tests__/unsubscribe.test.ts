import { describe, it, expect } from "vitest";
import {
  consumerEmailConfigIssues,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeHeaders,
  unsubscribeUrl,
} from "../unsubscribe";

describe("unsubscribe tokens", () => {
  it("round-trips the org and contact", () => {
    const token = signUnsubscribeToken({ orgId: "org-1", contactId: "contact-9" });
    expect(verifyUnsubscribeToken(token)).toEqual({ orgId: "org-1", contactId: "contact-9" });
  });

  it("rejects a token whose payload was altered", () => {
    const token = signUnsubscribeToken({ orgId: "org-1", contactId: "contact-9" });
    const [, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, o: "org-1", c: "contact-OTHER" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${mac}`)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("abc")).toBeNull();
    expect(verifyUnsubscribeToken("a.b.c")).toBeNull();
    const token = signUnsubscribeToken({ orgId: "o", contactId: "c" });
    expect(verifyUnsubscribeToken(`${token}x`)).toBeNull();
  });

  it("builds a link and one-click headers", () => {
    const url = unsubscribeUrl({ orgId: "o", contactId: "c" });
    expect(url).toMatch(/\/api\/public\/unsubscribe\?t=/);
    const headers = unsubscribeHeaders(url!);
    expect(headers["List-Unsubscribe"]).toBe(`<${url}>`);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

const KEY_32 = Buffer.alloc(32, 7).toString("base64");

describe("consumerEmailConfigIssues", () => {
  it("reports nothing outside production", () => {
    expect(consumerEmailConfigIssues({ NODE_ENV: "development" })).toEqual([]);
  });

  it("names each missing production setting", () => {
    expect(consumerEmailConfigIssues({ NODE_ENV: "production" })).toHaveLength(2);
    expect(
      consumerEmailConfigIssues({ NODE_ENV: "production", PHI_HMAC_KEY: KEY_32, APP_BASE_URL: "https://app.example.com" }),
    ).toEqual([]);
  });

  it("flags a key that does not decode to 32 bytes", () => {
    const issues = consumerEmailConfigIssues({ NODE_ENV: "production", PHI_HMAC_KEY: "!!!", APP_BASE_URL: "https://app.example.com" });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/32 bytes/);
  });
});

describe("signing key validation", () => {
  it("refuses a malformed production key instead of deriving a guessable one", () => {
    const saved = { env: process.env.NODE_ENV, key: process.env.PHI_HMAC_KEY };
    try {
      process.env.NODE_ENV = "production";
      process.env.PHI_HMAC_KEY = "!!!";
      expect(() => signUnsubscribeToken({ orgId: "o", contactId: "c" })).toThrow(/32 bytes/);
      process.env.PHI_HMAC_KEY = KEY_32;
      const token = signUnsubscribeToken({ orgId: "o", contactId: "c" });
      expect(verifyUnsubscribeToken(token)).toEqual({ orgId: "o", contactId: "c" });
    } finally {
      process.env.NODE_ENV = saved.env;
      if (saved.key === undefined) delete process.env.PHI_HMAC_KEY;
      else process.env.PHI_HMAC_KEY = saved.key;
    }
  });
});
