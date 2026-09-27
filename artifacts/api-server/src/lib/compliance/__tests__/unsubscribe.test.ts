import { describe, it, expect } from "vitest";
import {
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
