/**
 * PKI round-trip prototype — Phase A.
 *
 * Goal: prove we can sign a `pdf-lib` PDF with a PEM-backed `@signpdf/signpdf`
 * Signer subclass, then re-parse the signed PDF and verify the embedded
 * PKCS#7/CMS signature against the same bytes.
 *
 * Run:  pnpm tsx scripts/pki-roundtrip-prototype.ts
 *
 * Exit 0 iff isolated round-trip is green.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import forge from "node-forge";
import signpdfDefault from "@signpdf/signpdf";
import { Signer, SignPdfError, extractSignature } from "@signpdf/utils";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";

const signpdf = (signpdfDefault as unknown as { default?: typeof signpdfDefault })
  .default ?? signpdfDefault;

// ---- 1. Generate a dev self-signed cert + key in-memory ----------------------

function generateDevCert(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: "commonName", value: "Mediflow PKI Prototype DEV ONLY" },
    { name: "organizationName", value: "Mediflow Dev" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

// ---- 2. PEM-backed Signer (port of @signpdf/signer-p12 to direct PEM) -------

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

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(pdfBuffer.toString("binary"));
    p7.addCertificate(this.cert);
    p7.addSigner({
      key: this.key as forge.pki.rsa.PrivateKey,
      certificate: this.cert,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.signingTime, value: signingTime ?? new Date() },
        { type: forge.pki.oids.messageDigest },
      ],
    });
    p7.sign({ detached: true });
    const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    return Buffer.from(der, "binary");
  }
}

// ---- 3. Verifier --------------------------------------------------------------

interface VerifyResult {
  valid: boolean;
  reason?: string;
  signerCN?: string;
}

/**
 * Verify a PKCS#7/CMS signature embedded in a signed PDF.
 *
 * Approach: use `@signpdf/utils#extractSignature` (the canonical extractor
 * from the same project that produced the signature) to pull `signedData`
 * (the PDF bytes outside the /Contents hex window) and `signature` (the DER
 * CMS blob). Then walk the CMS via node-forge's ASN.1 parsing to verify:
 *
 *   1. The messageDigest authenticated attribute equals SHA-256(signedData).
 *   2. The signer's encryptedDigest verifies as RSA-PKCS#1-v1.5 / SHA-256
 *      over the DER-encoded authenticatedAttributes SET (re-tagged from the
 *      IMPLICIT [0] context-specific form to a UNIVERSAL SET, which is what
 *      the signer hashed at sign time — RFC 5652 §5.4).
 */
export function verifyPdfSignature(pdfBuffer: Buffer): VerifyResult {
  let extracted: ReturnType<typeof extractSignature>;
  try {
    extracted = extractSignature(pdfBuffer);
  } catch (err) {
    return { valid: false, reason: `extractSignature failed: ${(err as Error).message}` };
  }
  const { signedData, signature } = extracted;

  // The signature returned by extractSignature is the raw DER CMS as a
  // binary-encoded string. Decode it back to a Buffer of bytes.
  const cmsDerBytes = Buffer.from(signature as unknown as string, "binary");

  let p7Msg: forge.pkcs7.PkcsSignedData;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(cmsDerBytes.toString("binary")));
    p7Msg = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;
  } catch (err) {
    return { valid: false, reason: `CMS parse failed: ${(err as Error).message}` };
  }

  // Node-forge's PkcsSignedData stores parsed fields under `rawCapture` after
  // `fromAsn1`. We need the signerInfos (a SET of SignerInfo) to verify.
  const rawCapture = (p7Msg as unknown as { rawCapture: Record<string, unknown> })
    .rawCapture;
  if (!rawCapture || !rawCapture.signerInfos) {
    return { valid: false, reason: "No signerInfos in CMS" };
  }

  // `capture` (not captureAsn1) on a SET stores the contents — an array of
  // child Asn1 nodes, one per SignerInfo SEQUENCE.
  const signerInfosCapture = rawCapture.signerInfos as forge.asn1.Asn1 | forge.asn1.Asn1[];
  let signerInfoList: forge.asn1.Asn1[];
  if (Array.isArray(signerInfosCapture)) {
    signerInfoList = signerInfosCapture;
  } else if (signerInfosCapture && Array.isArray((signerInfosCapture as forge.asn1.Asn1).value)) {
    signerInfoList = (signerInfosCapture as forge.asn1.Asn1).value as forge.asn1.Asn1[];
  } else {
    return {
      valid: false,
      reason: `signerInfos capture shape unexpected: ${typeof signerInfosCapture} keys=${signerInfosCapture ? Object.keys(signerInfosCapture as object).join(",") : ""}`,
    };
  }
  if (!signerInfoList || signerInfoList.length === 0) {
    return { valid: false, reason: "Empty signerInfos" };
  }

  // For our case there is exactly one signer.
  const signerInfo = signerInfoList[0];

  // Re-validate the signerInfo against the schema to capture its sub-fields
  // — this gives us authenticatedAttributes, signature (encryptedDigest),
  // digestAlgorithm.
  const sCapture: Record<string, unknown> = {};
  const sErrors: unknown[] = [];
  const validator = (forge.pkcs7 as unknown as { asn1?: { signedDataValidator?: unknown } });
  // Walk the signerInfo manually instead of using the validator (the
  // validator is on the parent SignedData level). The structure is fixed
  // per RFC 5652 §5.3:
  //   SignerInfo ::= SEQUENCE {
  //     version                  CMSVersion,
  //     sid                      SignerIdentifier,    -- issuerAndSerialNumber here
  //     digestAlgorithm          DigestAlgorithmIdentifier,
  //     signedAttrs          [0] IMPLICIT SignedAttributes OPTIONAL,
  //     signatureAlgorithm       SignatureAlgorithmIdentifier,
  //     signature                SignatureValue,
  //     unsignedAttrs        [1] IMPLICIT UnsignedAttributes OPTIONAL }
  // Walk by index, skipping context-specific [0]/[1] for authenticated /
  // unauthenticated attributes.
  void validator;
  void sCapture;
  void sErrors;

  const seq = signerInfo.value as forge.asn1.Asn1[];
  // 0: version, 1: sid, 2: digestAlgorithm, then optional [0] signedAttrs,
  // then signatureAlgorithm, signature, optional [1] unsignedAttrs.
  if (!Array.isArray(seq) || seq.length < 5) {
    return { valid: false, reason: "SignerInfo SEQUENCE too short" };
  }

  let signedAttrsAsn1: forge.asn1.Asn1 | undefined;
  let encryptedDigest: string | undefined;
  for (let i = 3; i < seq.length; i++) {
    const node = seq[i];
    // signedAttrs: IMPLICIT [0]
    if (node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0) {
      signedAttrsAsn1 = node;
    }
    // signature OCTET STRING (universal)
    if (
      node.tagClass === forge.asn1.Class.UNIVERSAL &&
      node.type === forge.asn1.Type.OCTETSTRING
    ) {
      encryptedDigest = node.value as string;
    }
  }
  if (!signedAttrsAsn1) {
    return { valid: false, reason: "No signedAttrs in SignerInfo" };
  }
  if (!encryptedDigest) {
    return { valid: false, reason: "No encryptedDigest in SignerInfo" };
  }

  // ---- check #1: messageDigest attribute equals SHA-256(signedData) -------
  const attrList = signedAttrsAsn1.value as forge.asn1.Asn1[];
  let mdFromAttr: string | undefined;
  for (const attr of attrList) {
    // attr is SEQUENCE { OID, SET { value } }
    const av = attr.value as forge.asn1.Asn1[];
    const oid = forge.asn1.derToOid(av[0].value as string);
    if (oid === forge.pki.oids.messageDigest) {
      const set = av[1];
      const inner = (set.value as forge.asn1.Asn1[])[0];
      mdFromAttr = inner.value as string;
    }
  }
  if (!mdFromAttr) {
    return { valid: false, reason: "No messageDigest attribute" };
  }

  const md = forge.md.sha256.create();
  // signedData from extractSignature is a Buffer; forge wants binary-string.
  md.update((signedData as Buffer).toString("binary"));
  const computedDigest = md.digest().getBytes();
  if (computedDigest !== mdFromAttr) {
    return {
      valid: false,
      reason: `messageDigest mismatch: cms=${forge.util.bytesToHex(mdFromAttr).slice(0, 16)}... computed=${forge.util.bytesToHex(computedDigest).slice(0, 16)}...`,
    };
  }

  // ---- check #2: signature over signedAttrs verifies via signer cert ------
  // The signedAttrs node is IMPLICIT [0] — for hashing per RFC 5652 §5.4,
  // we must re-encode with the UNIVERSAL SET tag (0x31) instead of the
  // context-specific [0] tag (0xa0). Easiest way: clone the ASN.1 node
  // and set tagClass=UNIVERSAL, type=SET, then DER-serialize.
  const reTagged = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.SET,
    true,
    signedAttrsAsn1.value as forge.asn1.Asn1[],
  );
  const reTaggedDer = forge.asn1.toDer(reTagged).getBytes();

  // Find the cert that matches the signer (we only added one in this proto).
  const certs = (p7Msg as unknown as { certificates: forge.pki.Certificate[] }).certificates;
  if (!certs || certs.length === 0) {
    return { valid: false, reason: "No certificates in CMS" };
  }
  const signerCert = certs[0];

  const verifyMd = forge.md.sha256.create();
  verifyMd.update(reTaggedDer);
  const publicKey = signerCert.publicKey as forge.pki.rsa.PublicKey;
  let ok = false;
  try {
    ok = publicKey.verify(verifyMd.digest().bytes(), encryptedDigest);
  } catch (err) {
    return { valid: false, reason: `RSA verify threw: ${(err as Error).message}` };
  }
  if (!ok) {
    return { valid: false, reason: "RSA signature verification failed" };
  }

  const cnAttr = signerCert.subject.getField("CN");
  return {
    valid: true,
    signerCN: cnAttr ? (cnAttr.value as string) : undefined,
  };
}

// ---- 4. Driver ---------------------------------------------------------------

async function buildUnsignedPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("PKI Round-Trip Prototype", { x: 50, y: 740, size: 18, font });
  page.drawText("If you can read this and the verifier prints OK, we're done.", {
    x: 50,
    y: 710,
    size: 11,
    font,
  });
  const bytes = await pdf.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}

async function main(): Promise<void> {
  const { certPem, keyPem } = generateDevCert();
  console.log("[1/4] generated dev cert (RSA-2048)");

  const unsigned = await buildUnsignedPdf();
  console.log(`[2/4] built unsigned PDF (${unsigned.byteLength} bytes)`);

  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: unsigned,
    reason: "Round-trip prototype",
    contactInfo: "dev@mediflow.local",
    name: "Mediflow PKI Prototype",
    location: "in-process",
    signatureLength: 8192,
  });
  console.log(`[3/4] inserted /Sig placeholder (${withPlaceholder.byteLength} bytes)`);

  const signer = new PemSigner({ certPem, keyPem });
  const signed = await signpdf.sign(withPlaceholder, signer, new Date());
  console.log(`[4/4] signed PDF (${signed.byteLength} bytes)`);

  const verdict = verifyPdfSignature(signed);
  if (!verdict.valid) {
    console.error(`FAIL: ${verdict.reason ?? "unknown"}`);
    process.exit(1);
  }
  console.log(`OK: signature verified (signer CN: ${verdict.signerCN ?? "?"})`);

  // Tamper test: flip a single byte in the signed payload — must fail.
  const tampered = Buffer.from(signed);
  // Pick a byte well outside the /Contents hex window: byte 100 is in the
  // PDF header / catalog text. Flip it.
  tampered[100] ^= 0xff;
  const tamperedVerdict = verifyPdfSignature(tampered);
  if (tamperedVerdict.valid) {
    console.error("FAIL: tampered PDF still verified — verifier is broken");
    process.exit(2);
  }
  console.log(`OK: tampered PDF correctly rejected (${tamperedVerdict.reason})`);
}

main().catch((err) => {
  console.error("UNCAUGHT:", err);
  process.exit(99);
});
