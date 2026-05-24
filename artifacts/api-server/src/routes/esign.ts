/**
 * Native e-signature (Beta) routes.
 *
 * Surface:
 *   POST   /esign/envelopes                   — create an envelope
 *   GET    /esign/envelopes/:envelopeId       — fetch envelope state
 *   POST   /esign/envelopes/:envelopeId/sign  — record the signature
 *   GET    /esign/envelopes/:envelopeId/signed-pdf  — stream the signed PDF
 *
 * All routes are org-scoped via `requireAuth` + the `orgId` on the
 * authenticated request. Audit-log via `auditMiddleware("esign", ...)`.
 *
 * Sign-route permission narrowing:
 *   - The caller MUST either be the signer-userId on the envelope OR
 *     hold a `super_admin` / `agency_admin` role. This matches the
 *     narrowing the legacy Day-3 `POST /onboarding/.../sign` route did,
 *     and prevents a different agent in the same org from signing
 *     someone else's paperwork.
 *
 * Audit-trail invariant: the server captures `req.ip` and
 * `req.headers["user-agent"]` itself and passes them into the provider
 * — the frontend MUST NOT supply these fields. Trusting client input
 * for the audit trail defeats the purpose.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import {
  EnvelopeNotFoundError,
  EnvelopeStateError,
  ConsentRequiredError,
  InvalidSignatureInputError,
  type EnvelopeSigner,
} from "../lib/esign/provider";
import { getMediflowProvider } from "../lib/esign/mediflowProvider";

const router: IRouter = Router();

router.use(
  auditMiddleware("esign", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.envelopeId;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

// ---- Zod schemas -----------------------------------------------------------

const SignerSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1).max(200),
  email: z.string().email().max(200),
});

const CreateEnvelopeSchema = z.object({
  pdfDocumentId: z.string().min(1),
  carrierContractingRequestId: z.string().min(1),
  signers: z.array(SignerSchema).min(1).max(10),
});

const SignSchema = z.object({
  typedName: z.string().min(1).max(200),
  signatureSvg: z.string().min(1).max(200_000),
  consentToElectronicBusiness: z.literal(true),
  intentToSign: z.literal(true),
});

const VoidSchema = z.object({
  reason: z.string().min(1).max(500),
});

// ---- Helpers ---------------------------------------------------------------

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
function clientUserAgent(req: Request): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua : null;
}

function serializeEnvelope(env: Awaited<ReturnType<ReturnType<typeof getMediflowProvider>["getEnvelope"]>>): Record<string, unknown> {
  return {
    envelopeId: env.id,
    status: env.status,
    carrierContractingRequestId: env.carrierContractingRequestId,
    // Frontend `/sign/:envelopeId` page needs the unsigned-PDF document id
    // to render the pre-signature preview. Exposed as `pdfDocumentId` to
    // match the public field name in `lib/api-spec/openapi.yaml`.
    pdfDocumentId: env.unsignedPdfDocumentId,
    signers: env.signers,
    signedAt: env.signedAt?.toISOString() ?? null,
    signedPdfDocumentId: env.signedPdfDocumentId,
    integritySha256: env.integritySha256,
    consentRecord: env.consentRecord,
  };
}

function isAdmin(req: AuthenticatedRequest): boolean {
  return (
    req.userRole === "super_admin" ||
    req.userRole === "agency_admin"
  );
}

// ---- Routes ----------------------------------------------------------------

/**
 * POST /esign/envelopes
 *
 * Creates an envelope pointing at an existing unsigned PDF document.
 * Idempotent on `(org, carrier_contracting_request_id)` while not voided
 * — re-posting returns the existing envelope rather than 409'ing. The
 * partial-unique index would otherwise raise; the provider catches +
 * returns-existing for a clean caller surface.
 *
 * Permission: `esign:create` matrix (super_admin, agency_admin,
 * compliance_manager, agent). Anyone outside the matrix gets 403.
 */
router.post(
  "/esign/envelopes",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (
      !["super_admin", "agency_admin", "compliance_manager", "agent"].includes(
        authReq.userRole,
      )
    ) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = CreateEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const signers: EnvelopeSigner[] = parsed.data.signers.map((s) => ({
      userId: s.userId,
      displayName: s.displayName,
      email: s.email,
    }));

    try {
      const envelope = await getMediflowProvider().createEnvelope({
        orgId: authReq.orgId,
        carrierContractingRequestId: parsed.data.carrierContractingRequestId,
        pdfDocumentId: parsed.data.pdfDocumentId,
        signers,
        createdByUserId: authReq.userId,
        ipAddress: clientIp(req),
        userAgent: clientUserAgent(req),
      });

      res.status(201).json({
        envelopeId: envelope.id,
        status: envelope.status,
        signingUrl: `/sign/${envelope.id}`,
      });
    } catch (err) {
      authReq.log.error({ err }, "Failed to create esign envelope");
      res.status(500).json({ error: "Failed to create envelope" });
    }
  },
);

/**
 * GET /esign/envelopes/:envelopeId
 *
 * Org-scoped read. 404 on miss OR on a cross-org id.
 */
router.get(
  "/esign/envelopes/:envelopeId",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const envelopeId = String(req.params.envelopeId);
    try {
      const env = await getMediflowProvider().getEnvelope(
        envelopeId,
        authReq.orgId,
      );
      res.json(serializeEnvelope(env));
    } catch (err) {
      if (err instanceof EnvelopeNotFoundError) {
        res.status(404).json({ error: "Envelope not found" });
        return;
      }
      throw err;
    }
  },
);

/**
 * POST /esign/envelopes/:envelopeId/sign
 *
 * Records the signature. Server-captured req.ip + user-agent become the
 * audit trail; the frontend MUST NOT pass these fields in the body.
 *
 * Permission narrowing: the caller MUST be either the signer-userId on
 * the envelope OR a super_admin / agency_admin.
 */
router.post(
  "/esign/envelopes/:envelopeId/sign",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const envelopeId = String(req.params.envelopeId);

    const parsed = SignSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    // Load the envelope first so we can permission-narrow on the
    // signer-userId. Cross-org / missing → 404.
    let envelope;
    try {
      envelope = await getMediflowProvider().getEnvelope(
        envelopeId,
        authReq.orgId,
      );
    } catch (err) {
      if (err instanceof EnvelopeNotFoundError) {
        res.status(404).json({ error: "Envelope not found" });
        return;
      }
      throw err;
    }

    const signers = (envelope.signers as EnvelopeSigner[]) ?? [];
    const isSelf = signers.some((s) => s.userId === authReq.userId);
    if (!isSelf && !isAdmin(authReq)) {
      res.status(403).json({
        error:
          "Only the signer or an admin (super_admin/agency_admin) can sign this envelope",
      });
      return;
    }

    try {
      const updated = await getMediflowProvider().recordSignature(
        envelopeId,
        authReq.orgId,
        parsed.data,
        {
          signerUserId: authReq.userId,
          ipAddress: clientIp(req),
          userAgent: clientUserAgent(req),
        },
      );
      res.status(200).json({
        envelopeId: updated.id,
        status: updated.status,
        signedPdfDocumentId: updated.signedPdfDocumentId,
        integritySha256: updated.integritySha256,
      });
    } catch (err) {
      if (err instanceof ConsentRequiredError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof InvalidSignatureInputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof EnvelopeNotFoundError) {
        res.status(404).json({ error: "Envelope not found" });
        return;
      }
      if (err instanceof EnvelopeStateError) {
        res
          .status(409)
          .json({ error: err.message, envelopeStatus: err.envelopeStatus });
        return;
      }
      throw err;
    }
  },
);

/**
 * POST /esign/envelopes/:envelopeId/void  (admin only)
 *
 * Marks the envelope `voided` so a fresh envelope can be created for the
 * same carrier_contracting_request.
 */
router.post(
  "/esign/envelopes/:envelopeId/void",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!isAdmin(authReq)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const envelopeId = String(req.params.envelopeId);
    const parsed = VoidSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    try {
      await getMediflowProvider().voidEnvelope(
        envelopeId,
        authReq.orgId,
        parsed.data.reason,
        authReq.userId,
      );
      res.status(200).json({ envelopeId, status: "voided" });
    } catch (err) {
      if (err instanceof EnvelopeNotFoundError) {
        res.status(404).json({ error: "Envelope not found" });
        return;
      }
      if (err instanceof EnvelopeStateError) {
        res
          .status(409)
          .json({ error: err.message, envelopeStatus: err.envelopeStatus });
        return;
      }
      throw err;
    }
  },
);

/**
 * GET /esign/envelopes/:envelopeId/signed-pdf
 *
 * Streams the signed PDF bytes as `application/pdf`. 409 when the
 * envelope is not yet `completed`.
 */
router.get(
  "/esign/envelopes/:envelopeId/signed-pdf",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const envelopeId = String(req.params.envelopeId);
    try {
      const buf = await getMediflowProvider().getSignedPdf(
        envelopeId,
        authReq.orgId,
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(buf.byteLength));
      res.status(200).send(buf);
    } catch (err) {
      if (err instanceof EnvelopeNotFoundError) {
        res.status(404).json({ error: "Envelope not found" });
        return;
      }
      if (err instanceof EnvelopeStateError) {
        res
          .status(409)
          .json({ error: err.message, envelopeStatus: err.envelopeStatus });
        return;
      }
      throw err;
    }
  },
);

export default router;
