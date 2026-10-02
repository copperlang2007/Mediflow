/**
 * PKI signer + verifier for completed e-signed PDFs.
 *
 * The Phase 3 hardening for the native e-sign provider seals every
 * completed envelope's PDF with a PKCS#7/CMS detached signature (Adobe
 * pkcs7.detached / adbe.pkcs7.detached SubFilter). This gives true
 * tamper-evidence on the bytes — any post-storage modification breaks the
 * `messageDigest` check below.
 *
 * Architecture:
 *   - Cert + key live in PEM env vars (`ESIGN_SIGNING_CERT_PEM`,
 *     `ESIGN_SIGNING_KEY_PEM`). In dev / test we fall back to an
 *     **ephemeral** self-signed sentinel generated in-memory at module
 *     load whose subject CN explicitly contains "DEV ONLY". We do NOT
 *     commit a PEM fixture because (a) every secret-scanner flags
 *     committed private keys, and (b) ephemeral keys are equally good
 *     for round-trip tests with the module-level cache.
 *   - A production boot guard refuses to start if the dev sentinel CN
 *     leaks into prod, mirroring the `medicareId.ts` key-guard pattern.
 *   - We never log the private key. Errors thrown from this module say
 *     WHAT failed, never WITH WHAT material.
 *
 * Verification is intentionally a tamper-evidence check, not a
 * trust-chain check: we verify (a) the signed bytes hash matches the
 * embedded `messageDigest` attribute, and (b) the SignerInfo signature
 * verifies under the embedded signer cert's public key. We do NOT walk
 * the chain to a CA — that's a separate, out-of-scope LTV concern.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import forge from "node-forge";
import signpdfDefault from "@signpdf/signpdf";
import { Signer, SignPdfError, extractSignature } from "@signpdf/utils";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";

// `@signpdf/signpdf` is published as a CJS module with a default export of
// an already-constructed SignPdf instance. Under ESM it can land as either
// `signpdfDefault` or `signpdfDefault.default` depending on the bundler.
const signpdf = (
  (signpdfDefault as unknown as { default?: typeof signpdfDefault }).default ??
  signpdfDefault
) as { sign(buf: Buffer, signer: Signer, signingTime?: Date): Promise<Buffer> };

// ---- key material loading ---------------------------------------------------

interface PemCreds {
  certPem: string;
  keyPem: string;
  /** True iff we fell back to the ephemeral dev sentinel cert. */
  isDevSentinel: boolean;
}

const DEV_SENTINEL_CN_FRAGMENT = "DEV ONLY";

let cachedCreds: PemCreds | null = null;

/**
 * Generate an ephemeral dev sentinel RSA keypair + self-signed cert at
 * process start. The cert's subject CN contains "DEV ONLY" so the
 * production boot guard refuses it. We generate in-memory rather than
 * committing a real PEM fixture because:
 *   (a) GitGuardian and other secret-scanners flag committed PEMs even
 *       when documented as dev-only — every PR fails CI
 *   (b) committed PEMs create a confused-deputy risk if the CN guard
 *       ever regresses
 *   (c) ephemeral keys are equally good for round-trip tests; the same
 *       process boot gets a stable cert via the module-level cache
 *
 * RSA-2048 is sufficient for sign/verify round-trip; this is never
 * shipped to a real CA or trusted by anything outside our test suite.
 */
function generateDevSentinel(): PemCreds {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: "commonName", value: "agencyBRIDGE ESign DEV ONLY" },
    { name: "organizationName", value: "agencyBRIDGE (dev sentinel)" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    isDevSentinel: true,
  };
}

function isNonProdEnv(): boolean {
  const env = process.env.NODE_ENV;
  return env === "test" || env === "development" || env === undefined;
}

/**
 * Resolve the cert + key. In prod, both env vars are required. In dev/test,
 * we generate an ephemeral sentinel cert in-memory.
 *
 * NEVER log the returned `keyPem` value. Never include it in error
 * messages. Throws on missing-in-prod with no key material in the message.
 */
export function loadEsignSigningCreds(): PemCreds {
  if (cachedCreds) return cachedCreds;

  const certEnv = process.env.ESIGN_SIGNING_CERT_PEM;
  const keyEnv = process.env.ESIGN_SIGNING_KEY_PEM;

  if (certEnv && keyEnv) {
    // Sanity-parse the PEMs so a malformed config fails LOUDLY at boot
    // (rather than at the first envelope completion).
    try {
      forge.pki.certificateFromPem(certEnv);
      forge.pki.privateKeyFromPem(keyEnv);
    } catch {
      // Intentionally drop the underlying error message — it can include
      // key bytes / DER fragments. We only say WHAT failed.
      throw new Error("ESIGN_SIGNING_CERT_PEM / ESIGN_SIGNING_KEY_PEM failed to parse");
    }
    const cert = forge.pki.certificateFromPem(certEnv);
    const cn = cert.subject.getField("CN");
    const cnValue = cn && typeof cn.value === "string" ? cn.value : "";
    const isDevSentinel = cnValue.includes(DEV_SENTINEL_CN_FRAGMENT);
    cachedCreds = { certPem: certEnv, keyPem: keyEnv, isDevSentinel };
    return cachedCreds;
  }

  if (isNonProdEnv()) {
    cachedCreds = generateDevSentinel();
    return cachedCreds;
  }

  // Production with missing creds — refuse to operate.
  const missing = [!certEnv ? "ESIGN_SIGNING_CERT_PEM" : null, !keyEnv ? "ESIGN_SIGNING_KEY_PEM" : null]
    .filter(Boolean)
    .join(", ");
  throw new Error(`Missing required e-sign PKI env vars in production: ${missing}`);
}

/** For tests — clear the module-level cache between cases. */
export function resetEsignSigningCredsCacheForTests(): void {
  cachedCreds = null;
}

/**
 * Boot guard: refuses to come up in production with the committed dev
 * sentinel cert. Mirrors the `medicareId.ts` PHI-key guard.
 *
 * Call once at boot; safe to call repeatedly (idempotent).
 */
export function assertEsignSigningCredsAreProd(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const creds = loadEsignSigningCreds();
  if (creds.isDevSentinel) {
    throw new Error(
      "FATAL: NODE_ENV=production but e-sign signing cert is a DEV-ONLY sentinel " +
        `(subject CN contains "${DEV_SENTINEL_CN_FRAGMENT}"). Refusing to boot — set ` +
        "ESIGN_SIGNING_CERT_PEM and ESIGN_SIGNING_KEY_PEM to real production credentials.",
    );
  }
}

// ---- Signer subclass --------------------------------------------------------

interface PemSignerOptions {
  certPem: string;
  keyPem: string;
}

class PemSigner extends Signer {
  private readonly cert: forge.pki.Certificate;
  private readonly key: forge.pki.PrivateKey;

  constructor(opts: PemSignerOptions) {
    super();
    this.cert = forge.pki.certificateFromPem(opts.certPem);
    this.key = forge.pki.privateKeyFromPem(opts.keyPem);
  }

  async sign(pdfBuffer: Buffer, signingTime: Date | undefined = undefined): Promise<Buffer> {
    if (!(pdfBuffer instanceof Buffer)) {
      throw new SignPdfError("PDF expected as Buffer.", SignPdfError.TYPE_INPUT);
    }

    // Build a detached PKCS#7/CMS signature over the PDF bytes outside the
    // /Contents window. Authenticated attributes follow the order the
    // @signpdf/signer-p12 reference uses — EU signature validators are
    // sensitive to this ordering.
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(pdfBuffer.toString("binary"));
    p7.addCertificate(this.cert);
    p7.addSigner({
      key: this.key as forge.pki.rsa.PrivateKey,
      certificate: this.cert,
      digestAlgorithm: forge.pki.oids.sha256,
      // `value` is typed as `string` in @types/node-forge but the
      // implementation accepts a `Date` for the signingTime attribute (which
      // it then DER-encodes as UTCTime). Cast — matches the official
      // `@signpdf/signer-p12` reference at https://github.com/vbuch/node-signpdf.
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        {
          type: forge.pki.oids.signingTime,
          value: (signingTime ?? new Date()) as unknown as string,
        },
        { type: forge.pki.oids.messageDigest },
      ],
    });
    p7.sign({ detached: true });
    const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    return Buffer.from(der, "binary");
  }
}

// ---- Public sign entrypoint -------------------------------------------------

export interface PkiSignOptions {
  signingTime?: Date;
}

/**
 * PKI-seal a PDF. Inserts a /Sig placeholder via
 * `@signpdf/placeholder-plain`, then computes a PKCS#7/CMS detached
 * signature with the configured cert + key. The returned buffer is the
 * same PDF with the signature dictionary populated.
 *
 * Signature placeholder is sized at 16 KiB hex (8 KiB binary) — plenty of
 * headroom for a single signer + cert + signed attributes.
 */
export async function pkiSignPdf(pdfBytes: Buffer, opts: PkiSignOptions = {}): Promise<Buffer> {
  const creds = loadEsignSigningCreds();
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: pdfBytes,
    reason: "agencyBRIDGE e-signature (PKI-sealed)",
    contactInfo: "esign@mediflow.local",
    name: "agencyBRIDGE ESign Provider",
    location: "agencyBRIDGE",
    signatureLength: 8192,
  });
  const signer = new PemSigner({ certPem: creds.certPem, keyPem: creds.keyPem });
  const signed = await signpdf.sign(withPlaceholder, signer, opts.signingTime ?? new Date());
  return signed;
}

// ---- Verify ------------------------------------------------------------------

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  /** Common Name of the signer cert when verification succeeded. */
  signerCN?: string;
}

/**
 * Binary string of the raw /Contents signature window (between the `<` and
 * `>` that sit in the ByteRange gap), zero padding included.
 * Exported for tests.
 */
export function extractCmsWithPadding(pdfBuffer: Buffer, byteRange: number[]): string {
  const hex = pdfBuffer
    .subarray(byteRange[0] + byteRange[1] + 1, byteRange[2] - 1)
    .toString("latin1");
  return Buffer.from(hex, "hex").toString("binary");
}

/**
 * Parse the DER value at the start of `binary`, ignoring trailing bytes
 * (the /Contents zero padding). node-forge >= 1.3 supports `parseAllBytes`,
 * but @types/node-forge only declares the legacy boolean `strict` argument.
 */
export function parseDerPrefix(binary: string): forge.asn1.Asn1 {
  const fromDer = forge.asn1.fromDer as unknown as (
    bytes: forge.util.ByteStringBuffer,
    options: { parseAllBytes: boolean },
  ) => forge.asn1.Asn1;
  return fromDer(forge.util.createBuffer(binary), { parseAllBytes: false });
}

/**
 * Verify a PKCS#7/CMS signature embedded in a signed PDF.
 *
 * Tamper-evidence only — we check that the bytes outside the /Contents
 * window match the embedded `messageDigest` attribute, and that the
 * signer's encrypted-digest verifies under the embedded cert's public key.
 * We do NOT walk the cert chain to a CA — that is out of scope for this
 * pass (see module header).
 */
export function verifyPdfSignature(pdfBuffer: Buffer): VerifyResult {
  let extracted: ReturnType<typeof extractSignature>;
  try {
    extracted = extractSignature(pdfBuffer);
  } catch (err) {
    return { valid: false, reason: `extractSignature failed: ${(err as Error).message}` };
  }
  const { signedData } = extracted;

  // Don't use `extracted.signature`: extractSignature strips trailing "00"
  // hex pairs to drop the placeholder padding, which also eats real trailing
  // 0x00 bytes of the CMS blob (~1 in 256 signatures end in one), so a valid
  // PDF would fail as tampered. Instead decode the whole /Contents window,
  // padding included, and let the outer DER SEQUENCE's length decide where
  // the CMS ends.
  const cmsBinary = extractCmsWithPadding(pdfBuffer, extracted.ByteRange);
  let p7Msg: forge.pkcs7.PkcsSignedData;
  try {
    const asn1 = parseDerPrefix(cmsBinary);
    p7Msg = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;
  } catch (err) {
    return { valid: false, reason: `CMS parse failed: ${(err as Error).message}` };
  }

  // node-forge stashes the raw asn1 captures on `rawCapture` after fromAsn1.
  const rawCapture = (p7Msg as unknown as { rawCapture?: Record<string, unknown> }).rawCapture;
  if (!rawCapture || !rawCapture.signerInfos) {
    return { valid: false, reason: "No signerInfos in CMS" };
  }

  // For a SET-typed `capture` (no captureAsn1), node-forge stores the
  // array of child Asn1 nodes directly. Defensively handle both shapes.
  const sInfosCapture = rawCapture.signerInfos as forge.asn1.Asn1 | forge.asn1.Asn1[];
  const signerInfoList: forge.asn1.Asn1[] = Array.isArray(sInfosCapture)
    ? sInfosCapture
    : ((sInfosCapture as forge.asn1.Asn1).value as forge.asn1.Asn1[]) ?? [];
  if (signerInfoList.length === 0) {
    return { valid: false, reason: "Empty signerInfos" };
  }

  const signerInfo = signerInfoList[0];
  const seq = signerInfo.value as forge.asn1.Asn1[];
  if (!Array.isArray(seq) || seq.length < 5) {
    return { valid: false, reason: "SignerInfo SEQUENCE too short" };
  }

  // RFC 5652 §5.3 SignerInfo layout:
  //   version, sid, digestAlgorithm,
  //   [0] IMPLICIT signedAttrs OPTIONAL,
  //   signatureAlgorithm, signatureValue,
  //   [1] IMPLICIT unsignedAttrs OPTIONAL.
  // Items 0..2 are fixed; we walk 3..end to pick out signedAttrs (the
  // IMPLICIT [0] node) and signatureValue (the OCTET STRING).
  let signedAttrsAsn1: forge.asn1.Asn1 | undefined;
  let encryptedDigest: string | undefined;
  for (let i = 3; i < seq.length; i++) {
    const node = seq[i];
    if (node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0) {
      signedAttrsAsn1 = node;
    }
    if (node.tagClass === forge.asn1.Class.UNIVERSAL && node.type === forge.asn1.Type.OCTETSTRING) {
      encryptedDigest = node.value as string;
    }
  }
  if (!signedAttrsAsn1) return { valid: false, reason: "No signedAttrs in SignerInfo" };
  if (!encryptedDigest) return { valid: false, reason: "No encryptedDigest in SignerInfo" };

  // ---- Check #1: messageDigest attr == SHA-256(signedData). ---------------
  const attrList = signedAttrsAsn1.value as forge.asn1.Asn1[];
  let mdFromAttr: string | undefined;
  for (const attr of attrList) {
    const av = attr.value as forge.asn1.Asn1[];
    const oid = forge.asn1.derToOid(av[0].value as string);
    if (oid === forge.pki.oids.messageDigest) {
      const set = av[1];
      const inner = (set.value as forge.asn1.Asn1[])[0];
      mdFromAttr = inner.value as string;
    }
  }
  if (!mdFromAttr) return { valid: false, reason: "No messageDigest attribute" };

  const md = forge.md.sha256.create();
  md.update((signedData as Buffer).toString("binary"));
  if (md.digest().getBytes() !== mdFromAttr) {
    return { valid: false, reason: "messageDigest mismatch (PDF tampered)" };
  }

  // ---- Check #2: signature over signedAttrs verifies. ---------------------
  // Per RFC 5652 §5.4, the bytes hashed for the signatureValue are the
  // DER-encoding of the signedAttrs SET *re-tagged* from the IMPLICIT [0]
  // context-specific form (0xa0) to the UNIVERSAL SET form (0x31).
  const reTagged = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SET,
    true,
    signedAttrsAsn1.value as forge.asn1.Asn1[],
  );
  const reTaggedDer = forge.asn1.toDer(reTagged).getBytes();

  const certs = (p7Msg as unknown as { certificates?: forge.pki.Certificate[] }).certificates;
  if (!certs || certs.length === 0) {
    return { valid: false, reason: "No certificates in CMS" };
  }
  const signerCert = certs[0];
  // Verified with Node's native RSASSA-PKCS1-v1_5, NOT node-forge's
  // `publicKey.verify`: GHSA-86w9-cpqp-85rv (node-forge <=1.4.0, no patched
  // release) makes forge's verifier accept extra nested DigestAlgorithm
  // elements. forge is still used here to parse the CMS and to sign.
  let ok = false;
  try {
    const keyObject = createPublicKey(
      forge.pki.publicKeyToPem(signerCert.publicKey as forge.pki.rsa.PublicKey),
    );
    ok = cryptoVerify(
      "sha256",
      Buffer.from(reTaggedDer, "binary"),
      keyObject,
      Buffer.from(encryptedDigest, "binary"),
    );
  } catch {
    // Drop the underlying error; the verify path runs over a CMS we may
    // not fully trust, so we treat exceptions as a fail without leaking
    // internals.
    return { valid: false, reason: "RSA verify threw" };
  }
  if (!ok) return { valid: false, reason: "RSA signature verification failed" };

  const cnAttr = signerCert.subject.getField("CN");
  return { valid: true, signerCN: cnAttr ? (cnAttr.value as string) : undefined };
}
