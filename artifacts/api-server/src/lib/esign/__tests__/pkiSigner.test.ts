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

import {
  pkiSignPdf,
  verifyPdfSignature,
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
    // This assertion has flaked rarely in CI (~1 in a few hundred full-suite
    // runs; never reproduced in 12 isolated runs). Surface WHICH verify
    // branch failed so the next occurrence is diagnosable instead of an
    // opaque `expected false to be true`.
    expect(verdict.valid, `verify failed with reason: ${verdict.reason}`).toBe(true);
    expect(verdict.signerCN).toContain("DEV ONLY");
  });

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
      { name: "commonName", value: "Mediflow ESign DEV ONLY" },
      { name: "organizationName", value: "Mediflow (dev sentinel)" },
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
    const attrs = [{ name: "commonName", value: "Mediflow Production CA" }];
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
