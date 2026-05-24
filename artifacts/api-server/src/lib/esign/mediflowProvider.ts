/**
 * Mediflow native e-signature provider (Beta).
 *
 * PHASE 3 HARDENING — status:
 *   Shipped:
 *     - DB-level append-only enforcement on `esign_signing_events`
 *       (BEFORE UPDATE / BEFORE DELETE triggers, migration 0022) so the
 *       audit trail cannot be tampered with even by application code.
 *     - Certificate-of-completion email delivery: each signer with a
 *       non-empty email receives the signed PDF + integrity hash after
 *       envelope completion. Fire-and-forget — failures are logged +
 *       captured to Sentry but never fail the signing flow.
 *   Still pending (shipping in dedicated post-demo PRs):
 *     - PKI signing of the final PDF with an org-owned certificate (true
 *       tamper-evident sealing per ESIGN §101(g))
 *     - Knowledge-based authentication (KBA) — DOB / SSN-last-4 / OFAC-style
 *       identity proofing before the signer can sign
 *     - Voice + SMS verification (multi-channel identity binding)
 *     - Long-term-validation (LTV) timestamp authority for documents
 *       intended to outlive the signing certificate
 *     - PDF-level anti-tamper stamping beyond the SHA-256 hash + the
 *       audit-trail certificate page
 *
 * Today's tamper-evidence story is the `integrity_sha256` column +
 * the DB-enforced append-only `esign_signing_events` audit trail +
 * the visible certificate-of-completion page appended to every signed
 * PDF + the certificate-of-completion email to every signer.
 *
 * Single-signer assumption: the MVP routes every envelope to exactly one
 * signer (the agent). Multi-signer routing is a Phase-3 swap behind the
 * same provider interface.
 */
import { randomUUID, createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  db,
  documentsTable,
  esignEnvelopesTable,
  esignSigningEventsTable,
  type EsignEnvelope,
  type EnvelopeSigner,
  type EsignConsentRecord,
} from "@workspace/db";
import {
  type CreateEnvelopeInput,
  type ESignProvider,
  type SignerContext,
  type SignerInput,
  ConsentRequiredError,
  EnvelopeNotFoundError,
  EnvelopeStateError,
  InvalidSignatureInputError,
} from "./provider";
import { ESIGN_CONSENT_TEXT, ESIGN_CONSENT_VERSION } from "./consent";
import { renderSignatureCertificate } from "../contractingPdf/signatureCertificate";
import { ObjectStorageService } from "../objectStorage";
import { completeCarrierSigningTransition } from "./carrierSignCallback";
import { sendCertificateOfCompletion } from "./completionEmail";
import { logger } from "../logger";
import { captureWorkerError } from "../sentry";

/**
 * Storage facade so tests can swap a fake implementation in without
 * pulling the full GCS sidecar. Production uses ObjectStorageService;
 * tests can override via the `storage` constructor option.
 */
export interface EsignStorage {
  uploadPdf(buffer: Buffer, filename: string, orgId: string): Promise<string>;
  readPdf(storageKey: string): Promise<Buffer>;
}

class GcsEsignStorage implements EsignStorage {
  private readonly svc = new ObjectStorageService();

  async uploadPdf(
    buffer: Buffer,
    filename: string,
    orgId: string,
  ): Promise<string> {
    return this.svc.uploadDocument(buffer, filename, orgId, {
      contentType: "application/pdf",
    });
  }

  async readPdf(storageKey: string): Promise<Buffer> {
    const file = await this.svc.getObjectEntityFile(storageKey);
    const [bytes] = await file.download();
    return bytes;
  }
}

export interface MediflowProviderOptions {
  /** Override for tests; defaults to GcsEsignStorage. */
  storage?: EsignStorage;
  /**
   * Override for tests; defaults to the prod consent text. The provider
   * stores the EXACT text passed here on the envelope so we can prove
   * what the signer agreed to.
   */
  consentText?: string;
  consentVersion?: string;
}

export class MediflowESignProvider implements ESignProvider {
  private readonly storage: EsignStorage;
  private readonly consentText: string;
  private readonly consentVersion: string;
  /**
   * Tracks the fire-and-forget certificate-of-completion email promise
   * from the most recent `recordSignature` call. Production code should
   * NOT await this — the email is intentionally fire-and-forget. Tests
   * can await it to assert email side-effects deterministically.
   */
  public lastCompletionEmailPromise: Promise<unknown> | undefined;

  constructor(opts: MediflowProviderOptions = {}) {
    this.storage = opts.storage ?? new GcsEsignStorage();
    this.consentText = opts.consentText ?? ESIGN_CONSENT_TEXT;
    this.consentVersion = opts.consentVersion ?? ESIGN_CONSENT_VERSION;
  }

  // ---- createEnvelope ------------------------------------------------------

  async createEnvelope(input: CreateEnvelopeInput): Promise<EsignEnvelope> {
    // Idempotency: re-creating an envelope for the same
    // (org, carrier_contracting_request) while a non-voided envelope
    // exists returns the existing row. The partial-unique index on the
    // table would otherwise raise — we catch + return-existing so the
    // route surface stays clean.
    const [existing] = await db
      .select()
      .from(esignEnvelopesTable)
      .where(
        and(
          eq(esignEnvelopesTable.orgId, input.orgId),
          eq(
            esignEnvelopesTable.carrierContractingRequestId,
            input.carrierContractingRequestId,
          ),
        ),
      )
      .orderBy(desc(esignEnvelopesTable.createdAt))
      .limit(1);
    if (existing && existing.status !== "voided") return existing;

    const id = randomUUID();
    const [row] = await db
      .insert(esignEnvelopesTable)
      .values({
        id,
        orgId: input.orgId,
        carrierContractingRequestId: input.carrierContractingRequestId,
        unsignedPdfDocumentId: input.pdfDocumentId,
        signers: input.signers,
        status: "pending",
      })
      .returning();

    await db.insert(esignSigningEventsTable).values({
      id: randomUUID(),
      orgId: input.orgId,
      envelopeId: id,
      eventType: "envelope_created",
      actorUserId: input.createdByUserId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      eventData: {
        signers: input.signers.map((s) => ({
          userId: s.userId,
          email: s.email,
        })),
        unsignedPdfDocumentId: input.pdfDocumentId,
      },
    });

    return row;
  }

  // ---- recordSignature ----------------------------------------------------

  async recordSignature(
    envelopeId: string,
    orgId: string,
    signerInput: SignerInput,
    ctx: SignerContext,
  ): Promise<EsignEnvelope> {
    // 1. Validate inputs.
    if (
      signerInput.consentToElectronicBusiness !== true ||
      signerInput.intentToSign !== true
    ) {
      throw new ConsentRequiredError();
    }
    if (!signerInput.typedName || signerInput.typedName.trim().length === 0) {
      throw new InvalidSignatureInputError("typedName must be non-empty");
    }

    // 2. Load envelope (org-scoped).
    const envelope = await this.getEnvelope(envelopeId, orgId);
    if (envelope.status === "voided") {
      throw new EnvelopeStateError(
        envelope.status,
        "Envelope has been voided and cannot be signed",
      );
    }
    if (envelope.status === "completed") {
      // Idempotent re-completion. We still call the carrier-side
      // transition (it's no-op-safe via the same-status short-circuit
      // in completeCarrierSigningTransition + its run aggregator) so a
      // re-call after the Day-6 worker flipped requests forward to
      // `appointed` can roll the onboarding run forward to `complete`.
      try {
        await completeCarrierSigningTransition(
          orgId,
          envelope.carrierContractingRequestId,
        );
      } catch (err) {
        logger.error(
          { err, envelopeId, orgId },
          "Idempotent re-completion: carrier transition failed",
        );
      }
      return envelope;
    }

    // 3. Identify the signer record on the envelope. We require a
    //    matching userId so an admin firing this on behalf of an agent
    //    still binds the audit trail to a real EnvelopeSigner row.
    const signers = (envelope.signers as EnvelopeSigner[]) ?? [];
    const matchedIndex = signers.findIndex(
      (s) => s.userId === ctx.signerUserId,
    );
    // If no matched signer (admin signing on behalf), use the first
    // signer's identity for the visible signature + certificate. The
    // audit-event row still records `ctx.signerUserId` so we know who
    // actually clicked sign.
    const signer = matchedIndex >= 0 ? signers[matchedIndex] : signers[0];
    if (!signer) {
      throw new InvalidSignatureInputError(
        "Envelope has no signers — refusing to sign",
      );
    }

    // 4. Load the unsigned PDF bytes. The MVP `documents` table doesn't
    //    yet store actual GCS storage keys for contracting PDFs (Day 3
    //    stub used a synthetic key) — so we build a placeholder PDF for
    //    Beta. Phase 4 will swap the GCS read in at the same call site.
    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, envelope.unsignedPdfDocumentId),
          eq(documentsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!doc) {
      throw new InvalidSignatureInputError("Unsigned PDF document missing");
    }
    const unsignedBytes = await this.loadUnsignedPdfBytes(doc.storageKey);
    const unsignedHash = sha256Hex(unsignedBytes);

    // 5. Apply visible signature + append the certificate page.
    const signedAt = new Date();
    const consentAcceptedAt = signedAt; // single-step Beta: consent + sign together
    const consentRecord: EsignConsentRecord = {
      consentText: this.consentText,
      version: this.consentVersion,
      acceptedAt: consentAcceptedAt.toISOString(),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    };

    const signedPdfBuffer = await this.applySignatureToPdf({
      unsignedBytes,
      signer,
      typedName: signerInput.typedName,
      signedAt,
      consentRecord,
      unsignedHash,
      documentName: doc.name,
    });

    // 6. Integrity hash of the final signed PDF.
    const integritySha256 = sha256Hex(signedPdfBuffer);

    // 7. Upload to storage + create a `documents` row pointing at it.
    const safeName = `${doc.name.replace(/\.pdf$/i, "")}-signed.pdf`;
    const storageKey = await this.storage.uploadPdf(
      signedPdfBuffer,
      safeName,
      orgId,
    );
    const signedDocId = randomUUID();
    await db.insert(documentsTable).values({
      id: signedDocId,
      orgId,
      name: safeName,
      category: "contracting",
      storageKey,
      mimeType: "application/pdf",
      fileSizeBytes: signedPdfBuffer.byteLength,
      uploadedBy: ctx.signerUserId,
    });

    // 8. Stamp the signedAt on the matching signer row.
    const newSigners = signers.map((s, i) =>
      i === matchedIndex || (matchedIndex < 0 && i === 0)
        ? { ...s, signedAt: signedAt.toISOString() }
        : s,
    );

    // 9. Update the envelope row.
    const [updated] = await db
      .update(esignEnvelopesTable)
      .set({
        status: "completed",
        signedPdfDocumentId: signedDocId,
        integritySha256,
        consentRecord,
        signedAt,
        signers: newSigners,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(esignEnvelopesTable.id, envelopeId),
          eq(esignEnvelopesTable.orgId, orgId),
        ),
      )
      .returning();
    if (!updated) {
      throw new EnvelopeNotFoundError();
    }

    // 10. Write the granular audit events: consent + signature + completion.
    const audit = async (
      eventType:
        | "consent_accepted"
        | "signature_captured"
        | "envelope_completed",
      eventData: Record<string, unknown>,
    ): Promise<void> => {
      await db.insert(esignSigningEventsTable).values({
        id: randomUUID(),
        orgId,
        envelopeId,
        eventType,
        actorUserId: ctx.signerUserId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        eventData,
      });
    };
    await audit("consent_accepted", {
      consentVersion: this.consentVersion,
      acceptedAt: consentAcceptedAt.toISOString(),
    });
    await audit("signature_captured", {
      typedName: signerInput.typedName,
      signatureSvgLength: signerInput.signatureSvg.length,
      unsignedSha256: unsignedHash,
    });
    await audit("envelope_completed", {
      integritySha256,
      signedPdfDocumentId: signedDocId,
    });

    // 11. Carrier-contracting workflow handoff. Errors here do NOT undo
    //     the envelope completion — the signature is captured and the
    //     audit trail is durable; the contracting row can be retried.
    try {
      await completeCarrierSigningTransition(
        orgId,
        updated.carrierContractingRequestId,
      );
    } catch (err) {
      logger.error(
        { err, envelopeId, orgId },
        "Carrier-contracting transition failed after envelope completion",
      );
    }

    // 12. Certificate-of-completion email — fire-and-forget. Failures
    //     here MUST NOT undo the completed envelope. We `.catch` rather
    //     than `await`-throw so a Resend outage / config-missing cannot
    //     surface to the route caller. Same observability convention as
    //     `enqueue` from PR #73: log + Sentry-capture + continue.
    //
    //     The promise is stashed on the provider so tests can await it
    //     deterministically. The re-completion (`completed`) branch
    //     above does NOT enter this code path, so an idempotent re-sign
    //     never triggers a duplicate email.
    this.lastCompletionEmailPromise = sendCertificateOfCompletion(
      updated,
      signedPdfBuffer,
      integritySha256,
      { documentName: doc.name },
    ).catch((err: unknown) => {
      logger.warn(
        { err, envelopeId, orgId },
        "Certificate-of-completion email hook threw",
      );
      captureWorkerError(err, {
        worker: "esignCompletionEmail",
        envelopeId,
        orgId,
      });
    });

    return updated;
  }

  // ---- voidEnvelope --------------------------------------------------------

  async voidEnvelope(
    envelopeId: string,
    orgId: string,
    reason: string,
    actorUserId: string | null,
  ): Promise<void> {
    const envelope = await this.getEnvelope(envelopeId, orgId);
    if (envelope.status === "completed") {
      throw new EnvelopeStateError(
        envelope.status,
        "Cannot void a completed envelope",
      );
    }
    if (envelope.status === "voided") return; // idempotent
    await db
      .update(esignEnvelopesTable)
      .set({
        status: "voided",
        voidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(esignEnvelopesTable.id, envelopeId),
          eq(esignEnvelopesTable.orgId, orgId),
        ),
      );
    await db.insert(esignSigningEventsTable).values({
      id: randomUUID(),
      orgId,
      envelopeId,
      eventType: "envelope_voided",
      actorUserId,
      eventData: { reason },
    });
  }

  // ---- getEnvelope --------------------------------------------------------

  async getEnvelope(envelopeId: string, orgId: string): Promise<EsignEnvelope> {
    const [row] = await db
      .select()
      .from(esignEnvelopesTable)
      .where(
        and(
          eq(esignEnvelopesTable.id, envelopeId),
          eq(esignEnvelopesTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!row) throw new EnvelopeNotFoundError();
    return row;
  }

  // ---- getSignedPdf -------------------------------------------------------

  async getSignedPdf(envelopeId: string, orgId: string): Promise<Buffer> {
    const envelope = await this.getEnvelope(envelopeId, orgId);
    if (envelope.status !== "completed" || !envelope.signedPdfDocumentId) {
      throw new EnvelopeStateError(
        envelope.status,
        "Envelope is not yet completed",
      );
    }
    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, envelope.signedPdfDocumentId),
          eq(documentsTable.orgId, orgId),
        ),
      )
      .limit(1);
    if (!doc) {
      throw new EnvelopeStateError(
        envelope.status,
        "Signed PDF row missing",
      );
    }
    return this.storage.readPdf(doc.storageKey);
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Load the unsigned PDF bytes. The Day-3 placeholder paperwork path
   * does NOT yet store real bytes in GCS — only a synthetic storage key
   * + the documents row. For Beta, if the storage read fails (or the
   * key looks synthetic), we generate a small placeholder PDF inline
   * so the signing flow still produces a valid output. Phase 4 wires
   * real bytes through and this fallback collapses.
   */
  private async loadUnsignedPdfBytes(storageKey: string): Promise<Buffer> {
    try {
      return await this.storage.readPdf(storageKey);
    } catch {
      // Fallback — build a tiny placeholder so signing still produces
      // a real PDF with a sig area + certificate page.
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([612, 792]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      page.drawText("Carrier Contracting Paperwork (Beta placeholder)", {
        x: 50,
        y: 740,
        size: 14,
        font,
      });
      page.drawText(
        "This PDF is a Beta placeholder. Phase 4 will load the actual carrier paperwork from object storage.",
        { x: 50, y: 710, size: 10, font },
      );
      const bytes = await pdf.save();
      return Buffer.from(bytes);
    }
  }

  /**
   * Apply the visible signature mark to the unsigned PDF + append the
   * certificate page.
   *
   * Placement: top-right of the last page. Same behavior the Day-5 e-sign
   * rollout shipped with.
   */
  private async applySignatureToPdf(args: {
    unsignedBytes: Buffer;
    signer: EnvelopeSigner;
    typedName: string;
    signedAt: Date;
    consentRecord: EsignConsentRecord;
    unsignedHash: string;
    documentName: string;
  }): Promise<Buffer> {
    const pdf = await PDFDocument.load(args.unsignedBytes);
    const pages = pdf.getPages();

    const targetPage = pages[pages.length - 1];

    if (targetPage) {
      const fontItalic = await pdf.embedFont(StandardFonts.HelveticaOblique);
      const font = await pdf.embedFont(StandardFonts.Helvetica);

      const { width, height } = targetPage.getSize();
      const sigX = width - 250;
      const sigY = height - 100;

      targetPage.drawText("Signed electronically by:", {
        x: sigX,
        y: sigY + 30,
        size: 9,
        font,
        color: rgb(0, 0, 0),
      });
      targetPage.drawText(args.typedName, {
        x: sigX,
        y: sigY + 12,
        size: 16,
        font: fontItalic,
        color: rgb(0, 0, 0.6),
      });
      targetPage.drawText(args.signedAt.toISOString(), {
        x: sigX,
        y: sigY - 4,
        size: 8,
        font,
        color: rgb(0, 0, 0),
      });
    }

    // Append the audit-trail certificate page.
    const certPdf = await renderSignatureCertificate({
      documentName: args.documentName,
      documentHash: args.unsignedHash,
      signer: {
        fullName: args.signer.displayName,
        email: args.signer.email,
        userId: args.signer.userId,
        npn: null,
      },
      consentAt: args.consentRecord.acceptedAt,
      signedAt: args.signedAt.toISOString(),
      ipAddress: args.consentRecord.ipAddress,
      userAgent: args.consentRecord.userAgent,
      consentText: args.consentRecord.consentText,
    });
    const certPages = await pdf.copyPages(certPdf, certPdf.getPageIndices());
    for (const p of certPages) pdf.addPage(p);

    const bytes = await pdf.save({ useObjectStreams: false });
    return Buffer.from(bytes);
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---- In-memory storage (test default) --------------------------------------

/**
 * Process-local in-memory storage. Used when `PRIVATE_OBJECT_DIR` is not
 * set in the environment — which is the test-harness default. Production
 * sets the env var so the GCS-backed implementation wins.
 *
 * The map is module-level so multiple provider instances within a single
 * test process see each other's writes; that mirrors how a real GCS
 * bucket behaves across handler invocations.
 */
const MEMORY_BLOB_STORE = new Map<string, Buffer>();

export class InMemoryEsignStorage implements EsignStorage {
  async uploadPdf(
    buffer: Buffer,
    filename: string,
    orgId: string,
  ): Promise<string> {
    const id = randomUUID();
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `/objects/documents/${orgId}/${id}/${safe}`;
    MEMORY_BLOB_STORE.set(key, Buffer.from(buffer));
    return key;
  }

  async readPdf(storageKey: string): Promise<Buffer> {
    const buf = MEMORY_BLOB_STORE.get(storageKey);
    if (!buf) throw new Error(`InMemoryEsignStorage: no blob at ${storageKey}`);
    return buf;
  }
}

// ---- Singleton --------------------------------------------------------------

let _singleton: MediflowESignProvider | undefined;

/**
 * Lazy singleton — used by `routes/esign.ts` so the GCS storage client is
 * only constructed on first use. Tests can call `setMediflowProvider(...)`
 * to inject a provider with a fake storage backend.
 *
 * Default selection:
 *   - `PRIVATE_OBJECT_DIR` set → GCS-backed storage (production).
 *   - otherwise               → `InMemoryEsignStorage` (test/dev).
 *
 * The fallback is intentional: it lets the integration test harness run
 * without provisioning a GCS bucket, and matches the pattern other
 * route-level singletons in this codebase use.
 */
export function getMediflowProvider(): MediflowESignProvider {
  if (!_singleton) {
    const useGcs = Boolean(process.env.PRIVATE_OBJECT_DIR);
    _singleton = new MediflowESignProvider({
      storage: useGcs ? new GcsEsignStorage() : new InMemoryEsignStorage(),
    });
  }
  return _singleton;
}

export function setMediflowProvider(
  provider: MediflowESignProvider | undefined,
): void {
  _singleton = provider;
}
