/**
 * Unit tests for the PKI signer + verifier.
 *
 * These are pure in-memory tests — no DB, no provider, no HTTP. They cover:
 *
 *   - Round-trip sign → verify against the same bytes.
 *   - Tamper detection: flipping a byte breaks verification.
 *   - Dev-sentinel cert detection (CN substring).
 *   - Boot guard refuses dev sentinel in production.
 *   - Boot guard refuses missing env vars in production.
 *   - Boot guard is a no-op outside production.
 *   - PEM parse failures don't leak key material in the error message.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import forge from "node-forge";
import { extractSignature } from "@signpdf/utils";

import {
  pkiSignPdf,
  verifyPdfSignature,
  extractCmsWithPadding,
  parseDerPrefix,
  loadEsignSigningCreds,
  assertEsignSigningCredsAreProd,
  resetEsignSigningCredsCacheForTests,
} from "../pkiSigner";

async function buildPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("pkiSigner test fixture", { x: 50, y: 740, size: 14, font });
  const bytes = await pdf.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}

// Save+restore the bits of process.env we mutate so individual tests can
// claim a clean slate.
const SNAPSHOT_KEYS = [
  "NODE_ENV",
  "ESIGN_SIGNING_CERT_PEM",
  "ESIGN_SIGNING_KEY_PEM",
] as const;

describe("pkiSigner round-trip", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SNAPSHOT_KEYS) saved[k] = process.env[k];
    // Force the dev-sentinel path.
    delete process.env.ESIGN_SIGNING_CERT_PEM;
    delete process.env.ESIGN_SIGNING_KEY_PEM;
    process.env.NODE_ENV = "test";
    resetEsignSigningCredsCacheForTests();
  });

  afterEach(() => {
    for (const k of SNAPSHOT_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEsignSigningCredsCacheForTests();
  });

  it("signs a PDF and the embedded signature verifies against the same bytes", async () => {
    const unsigned = await buildPdf();
    const signed = await pkiSignPdf(unsigned);
    expect(signed.byteLength).toBeGreaterThan(unsigned.byteLength);
    // PDF magic is preserved.
    expect(signed.subarray(0, 4).toString()).toBe("%PDF");

    const verdict = verifyPdfSignature(signed);
    // Surface WHICH verify branch failed so a failure is diagnosable instead
    // of an opaque `expected false to be true`.
    expect(verdict.valid, `verify failed with reason: ${verdict.reason}`).toBe(true);
    expect(verdict.signerCN).toContain("DEV ONLY");
  });

  it("verifies a signature whose CMS blob ends in a 0x00 byte", async () => {
    // Regression: extractSignature strips trailing "00" hex pairs as
    // placeholder padding, which also dropped a real trailing 0x00 of the
    // CMS (~1 in 256 signatures), so valid PDFs failed as tampered — the
    // rare CI flake in the round-trip test above. Vary signingTime until the
    // CMS ends in 0x00 (expected within a few hundred tries).
    const unsigned = await buildPdf();
    let hit: Buffer | null = null;
    for (let i = 0; i < 4000 && !hit; i++) {
      const signed = await pkiSignPdf(unsigned, {
        signingTime: new Date(Date.UTC(2026, 0, 1) + i * 1000),
      });
      const cms = extractCmsWithPadding(signed, extractSignature(signed).ByteRange);
      const derLength = forge.asn1.toDer(parseDerPrefix(cms)).length();
      if (cms.charCodeAt(derLength - 1) === 0) hit = signed;
    }
    expect(hit, "no trailing-zero signature found in 4000 tries").not.toBeNull();
    const verdict = verifyPdfSignature(hit!);
    expect(verdict.valid, `verify failed with reason: ${verdict.reason}`).toBe(true);
  }, 120_000);

  it("rejects a PDF with a flipped byte (tamper detection)", async () => {
    const signed = await pkiSignPdf(await buildPdf());
    // Pick a byte well outside the /Contents window. Byte 100 sits in the
    // header / catalog text which is part of the ByteRange.
    const tampered = Buffer.from(signed);
    tampered[100] ^= 0xff;
    const verdict = verifyPdfSignature(tampered);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/messageDigest|RSA|extractSignature/);
  });

  it("returns a falsy verdict for a PDF with no embedded signature", async () => {
    const unsigned = await buildPdf();
    const verdict = verifyPdfSignature(unsigned);
    expect(verdict.valid).toBe(false);
  });
});

describe("pkiSigner dev-sentinel loading", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SNAPSHOT_KEYS) saved[k] = process.env[k];
    resetEsignSigningCredsCacheForTests();
  });
  afterEach(() => {
    for (const k of SNAPSHOT_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEsignSigningCredsCacheForTests();
  });

  it("falls back to the dev sentinel when env vars are unset and NODE_ENV=test", () => {
    delete process.env.ESIGN_SIGNING_CERT_PEM;
    delete process.env.ESIGN_SIGNING_KEY_PEM;
    process.env.NODE_ENV = "test";
    const creds = loadEsignSigningCreds();
    expect(creds.isDevSentinel).toBe(true);
    expect(creds.certPem).toContain("BEGIN CERTIFICATE");
    expect(creds.keyPem).toContain("PRIVATE KEY");
  });

  it("marks env-provided creds as not the dev sentinel when CN is real", async () => {
    // Generate a fresh self-signed cert with a non-sentinel CN, supply via env.
    const forge = (await import("node-forge")).default;
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: "commonName", value: "Acme Insurance Org" }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    process.env.ESIGN_SIGNING_CERT_PEM = forge.pki.certificateToPem(cert);
    process.env.ESIGN_SIGNING_KEY_PEM = forge.pki.privateKeyToPem(keys.privateKey);
    process.env.NODE_ENV = "test";
    resetEsignSigningCredsCacheForTests();

    const creds = loadEsignSigningCreds();
    expect(creds.isDevSentinel).toBe(false);
  });
});

describe("pkiSigner production boot guard", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SNAPSHOT_KEYS) saved[k] = process.env[k];
    resetEsignSigningCredsCacheForTests();
  });
  afterEach(() => {
    for (const k of SNAPSHOT_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEsignSigningCredsCacheForTests();
  });

  it("is a no-op outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.ESIGN_SIGNING_CERT_PEM;
    delete process.env.ESIGN_SIGNING_KEY_PEM;
    expect(() => assertEsignSigningCredsAreProd()).not.toThrow();
  });

  it("throws in production when the dev sentinel cert is loaded (env vars missing)", () => {
    delete process.env.ESIGN_SIGNING_CERT_PEM;
    delete process.env.ESIGN_SIGNING_KEY_PEM;
    process.env.NODE_ENV = "production";
    // In prod-no-env, loadEsignSigningCreds() throws "missing env vars" —
    // which is also a refusal-to-boot. Either error path is acceptable;
    // we assert SOMETHING throws.
    expect(() => assertEsignSigningCredsAreProd()).toThrow();
  });

  it("throws in production when env vars POINT AT a cert with DEV-ONLY CN", async () => {
    // Build a sentinel-shaped cert programmatically and inject it via env.
    // The guard MUST refuse even when the cert was loaded from the
    // supposedly-prod env vars. We generate here rather than read a
    // committed fixture (committing PEM private keys triggers every
    // secret-scanner under the sun and we removed the fixtures).
    const forge = (await import("node-forge")).default;
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(
      cert.validity.notBefore.getFullYear() + 1,
    );
    const attrs = [
      { name: "commonName", value: "agencyBRIDGE ESign DEV ONLY" },
      { name: "organizationName", value: "agencyBRIDGE (dev sentinel)" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    process.env.ESIGN_SIGNING_CERT_PEM = forge.pki.certificateToPem(cert);
    process.env.ESIGN_SIGNING_KEY_PEM = forge.pki.privateKeyToPem(
      keys.privateKey,
    );
    process.env.NODE_ENV = "production";
    resetEsignSigningCredsCacheForTests();
    expect(() => assertEsignSigningCredsAreProd()).toThrow(/DEV ONLY/);
  });

  it("does NOT throw in production with a real-looking cert", async () => {
    const forge = (await import("node-forge")).default;
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: "commonName", value: "agencyBRIDGE Production CA" }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    process.env.ESIGN_SIGNING_CERT_PEM = forge.pki.certificateToPem(cert);
    process.env.ESIGN_SIGNING_KEY_PEM = forge.pki.privateKeyToPem(keys.privateKey);
    process.env.NODE_ENV = "production";
    resetEsignSigningCredsCacheForTests();
    expect(() => assertEsignSigningCredsAreProd()).not.toThrow();
  });

  it("malformed PEM error message does NOT leak key material", () => {
    process.env.ESIGN_SIGNING_CERT_PEM = "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----";
    process.env.ESIGN_SIGNING_KEY_PEM =
      "-----BEGIN PRIVATE KEY-----\nSECRETKEYBYTES-DO-NOT-LEAK\n-----END PRIVATE KEY-----";
    process.env.NODE_ENV = "test";
    resetEsignSigningCredsCacheForTests();
    try {
      loadEsignSigningCreds();
      throw new Error("expected loadEsignSigningCreds to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("SECRETKEYBYTES-DO-NOT-LEAK");
      expect(msg).not.toContain("BEGIN PRIVATE KEY");
    }
  });
});
