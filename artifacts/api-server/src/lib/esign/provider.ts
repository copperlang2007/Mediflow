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
  /**
   * Per-carrier signing flow parent. Mutually exclusive with
   * `onboardingRunId` — exactly one of the two is required. The DB-level
   * `esign_envelopes_parent_check` constraint enforces this at write time.
   */
  carrierContractingRequestId?: string | null;
  /**
   * Phase 1.5 POA path parent. Set on run-wide POA envelopes that
   * authorize the grantee to submit ALL carrier paperwork on the agent's
   * behalf.
   */
  onboardingRunId?: string | null;
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

/**
 * Thrown by providers that don't support a particular `ESignProvider`
 * method — e.g. DocuSign cannot fulfil `recordSignature` because signing
 * happens in DocuSign's hosted UI and is reported back via webhook, not
 * the route. Callers map this to a 4xx with a routing hint.
 */
export class UnsupportedOperationError extends Error {
  constructor(operation: string, provider: string) {
    super(
      `Operation '${operation}' is not supported by the '${provider}' e-sign provider`,
    );
    this.name = "UnsupportedOperationError";
  }
}

/**
 * Input for `startSigningSession`. The route resolves these before
 * calling the provider — the provider does not look up the signer from
 * a request header, only from this input.
 */
export interface SigningSessionInput {
  envelopeId: string;
  orgId: string;
  /**
   * Clerk userId of the signer who is about to sign. Must match an
   * `EnvelopeSigner.userId` on the envelope. External providers need
   * this to map our user to a DocuSign recipient client-user-id.
   */
  signerUserId: string;
  /**
   * Fully-qualified URL the provider should redirect to after the signer
   * completes or declines. REQUIRED for external providers (DocuSign);
   * IGNORED by the native provider (which redirects in-app via
   * react-router). Provider implementations that require it but receive
   * `undefined` throw `InvalidSignatureInputError`.
   */
  returnUrl?: string;
}

export interface SigningSession {
  /**
   * URL the frontend navigates to so the signer can sign.
   *
   *  - Native provider: in-app path (e.g. `/sign/:envelopeId`). The
   *    frontend treats it as a router-internal navigation.
   *  - External providers (DocuSign): fully-qualified https URL. The
   *    frontend MUST detect external URLs (scheme check) and use
   *    `window.location.href` rather than the router — wouter does not
   *    handle cross-origin URLs.
   */
  signingUrl: string;
}

export interface ESignProvider {
  createEnvelope(input: CreateEnvelopeInput): Promise<EsignEnvelope>;

  /**
   * Resolve a URL the signer should navigate to in order to sign. For
   * external providers this typically corresponds to a recipient-view /
   * embedded-signing session that may be short-lived (DocuSign default
   * is 5 minutes) — call this fresh each time the frontend needs to
   * resume signing, do not cache the URL.
   */
  startSigningSession(input: SigningSessionInput): Promise<SigningSession>;

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
