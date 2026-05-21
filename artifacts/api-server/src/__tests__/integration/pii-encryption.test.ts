/**
 * Round-trip + invariant tests for the generic PII encryption helpers
 * (lib/db/src/encryption/pii.ts) — the same shape as the medicare_id
 * encryption that already ships, applied to SSN and EIN.
 *
 *   - encrypt → decrypt yields the original normalized plaintext
 *   - hash is deterministic on the normalized plaintext, non-deterministic
 *     on raw input formatting (so "123-45-6789" and "123456789" collide
 *     on hash, as intended for blind-index dup detection)
 *   - ciphertext is non-deterministic (different IV per call)
 *   - normalization rejects malformed input
 */
import { describe, it, expect } from "vitest";
import {
  encryptSsn,
  decryptSsn,
  hashSsn,
  normalizeSsn,
  encryptEin,
  decryptEin,
  normalizeEin,
} from "@workspace/db/encryption/pii";

describe("SSN encryption", () => {
  it("round-trips: encrypt → decrypt returns the normalized digits-only form", () => {
    const { encrypted } = encryptSsn("123-45-6789");
    expect(decryptSsn(encrypted)).toBe("123456789");
  });

  it("formatted and unformatted SSNs produce the same hash (dup detection)", () => {
    const hashA = hashSsn("123-45-6789");
    const hashB = hashSsn("123456789");
    const hashC = hashSsn(" 123 45 6789 ");
    expect(hashA.equals(hashB)).toBe(true);
    expect(hashA.equals(hashC)).toBe(true);
  });

  it("different SSNs produce different hashes", () => {
    expect(hashSsn("123-45-6789").equals(hashSsn("123-45-6780"))).toBe(false);
  });

  it("ciphertext is non-deterministic (random IV per call)", () => {
    const a = encryptSsn("123-45-6789").encrypted;
    const b = encryptSsn("123-45-6789").encrypted;
    expect(a.equals(b)).toBe(false);
  });

  it("rejects malformed SSN input", () => {
    expect(() => normalizeSsn("12-34")).toThrow();
    expect(() => normalizeSsn("1234567890")).toThrow();
    expect(() => normalizeSsn("abc-de-fghi")).toThrow();
  });

  it("decryptSsn throws on truncated ciphertext", () => {
    expect(() => decryptSsn(Buffer.alloc(5))).toThrow();
  });
});

describe("EIN encryption", () => {
  it("round-trips: encrypt → decrypt returns the normalized digits-only form", () => {
    const { encrypted } = encryptEin("12-3456789");
    expect(decryptEin(encrypted)).toBe("123456789");
  });

  it("normalization strips dashes", () => {
    expect(normalizeEin("12-3456789")).toBe("123456789");
  });

  it("rejects malformed EIN input", () => {
    expect(() => normalizeEin("12-345678")).toThrow();
  });
});
