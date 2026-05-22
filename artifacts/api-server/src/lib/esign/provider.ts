/**
 * Native e-signature provider interface (Beta).
 *
 * Phase 2 ships the in-process `MediflowESignProvider` — visible signature
 * via pdf-lib, SHA-256 integrity hash, an audit-trail certificate page,
 * and a granular events table. Phase 3 will swap implementations behind
 * this same interface (PKI-signed PDFs, KBA, voice/SMS verification,
 * optionally a managed hosted version) without changing route or
 * envelope-callback code.
 *
 * Every method is org-scoped through `orgId` on the inputs / context.
 * Implementations MUST 404 when an envelope is read or written from
 * outside its owning org.
 */
import type {
  EsignEnvelope,
  EnvelopeSigner,
  EsignConsentRecord,
} from "@workspace/db";

/**
 * Input for `createEnvelope` — the route's body shape, after auth + zod
 * validation. `signers` is required but the array can have a single
 * entry; multi-signer routing lands in Phase 3.
 */
export interface CreateEnvelopeInput {
  orgId: string;
  carrierContractingRequestId: string;
  pdfDocumentId: string;
  signers: EnvelopeSigner[];
  /**
   * Who fired the route — written to the `envelope_created` event row so
   * the audit trail can attribute the creation.
   */
  createdByUserId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Input for `recordSignature` — the body of `POST /sign/:envelopeId/sign`,
 * after validation. The caller-context (req.ip, user-agent, userId) is
 * passed separately as `SignerContext` so client code can never spoof
 * the audit trail by sending those fields in the body.
 */
export interface SignerInput {
  typedName: string;
  signatureSvg: string;
  consentToElectronicBusiness: true;
  intentToSign: true;
}

export interface SignerContext {
  /**
   * Caller's Clerk userId. Used to look up the matching `EnvelopeSigner`
   * on the envelope (the userId on the signer row MUST equal this, OR the
   * caller must hold an admin role — that narrowing is the route's job).
   */
  signerUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Class of errors that map to specific HTTP responses. Routes catch the
 * subclass and translate to JSON without leaking provider internals.
 */
export class EnvelopeNotFoundError extends Error {
  constructor() {
    super("Envelope not found");
    this.name = "EnvelopeNotFoundError";
  }
}

export class EnvelopeStateError extends Error {
  constructor(public envelopeStatus: string, message: string) {
    super(message);
    this.name = "EnvelopeStateError";
  }
}

export class ConsentRequiredError extends Error {
  constructor() {
    super(
      "Both consentToElectronicBusiness and intentToSign must be true to sign",
    );
    this.name = "ConsentRequiredError";
  }
}

export class InvalidSignatureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSignatureInputError";
  }
}

export interface ESignProvider {
  createEnvelope(input: CreateEnvelopeInput): Promise<EsignEnvelope>;

  /**
   * Apply the signature to the unsigned PDF, persist the signed copy,
   * write audit events, and transition the envelope to `completed`. The
   * caller is responsible for permission narrowing (signer-userId vs.
   * admin role) BEFORE calling this method.
   */
  recordSignature(
    envelopeId: string,
    orgId: string,
    signerInput: SignerInput,
    ctx: SignerContext,
  ): Promise<EsignEnvelope>;

  voidEnvelope(
    envelopeId: string,
    orgId: string,
    reason: string,
    actorUserId: string | null,
  ): Promise<void>;

  /** Org-scoped read. Throws `EnvelopeNotFoundError` on miss. */
  getEnvelope(envelopeId: string, orgId: string): Promise<EsignEnvelope>;

  /**
   * Stream the signed PDF bytes from object storage. Throws
   * `EnvelopeStateError` if the envelope is not yet completed.
   */
  getSignedPdf(envelopeId: string, orgId: string): Promise<Buffer>;
}

// Re-export the consent-record + signer types for route code to import
// from a single place.
export type { EsignEnvelope, EnvelopeSigner, EsignConsentRecord };
