/**
 * DocuSign e-signature provider.
 *
 * Drop-in `ESignProvider` implementation that delegates to DocuSign's
 * managed signing service. Coexists with the native `MediflowESignProvider`
 * behind the `getEsignProvider()` factory (`./factory.ts`) — selection is
 * driven by the `ESIGN_PROVIDER` env var.
 *
 * What this provider does:
 *   - createEnvelope:        uploads the unsigned PDF to DocuSign as an
 *                            envelope with a single Signer + a SignHere
 *                            tab anchored to the `\\sn1\\` text the PDF
 *                            generator already emits. Status is set to
 *                            `sent` so DocuSign emails the signer in
 *                            parallel with our own embedded flow. Persists
 *                            our envelope row with provider='docusign' +
 *                            external_envelope_id=<DocuSign envelopeId>.
 *   - startSigningSession:   issues a fresh DocuSign recipient view URL
 *                            (a short-lived, signer-scoped embedded
 *                            signing URL). MUST be called each time the
 *                            frontend resumes signing — these URLs expire
 *                            after ~5 minutes per DocuSign defaults.
 *   - voidEnvelope:          calls DocuSign's envelope update with
 *                            status='voided' + voidedReason, mirrors the
 *                            state to our row, writes envelope_voided
 *                            event.
 *   - getEnvelope:           reads from OUR DB only. The webhook handler
 *                            (`routes/docusignWebhook.ts`, follow-up PR)
 *                            keeps our row in sync with DocuSign — we
 *                            never round-trip on every read.
 *   - getSignedPdf:          checks our envelope is `completed`. If we
 *                            already cached the signed-PDF document id
 *                            (webhook will have populated this) we read
 *                            from storage; otherwise we lazy-fetch from
 *                            DocuSign and cache for next time.
 *   - recordSignature:       UNSUPPORTED. Signing happens in DocuSign's
 *                            hosted UI; throws `UnsupportedOperationError`
 *                            so callers (the legacy `POST /sign/:id/sign`
 *                            route) get a clear 4xx with a routing hint
 *                            rather than a silent failure.
 *
 * Auth: DocuSign JWT user-impersonation. Requires one-time admin consent
 * on the integration key (a manual step at app deploy time — see the
 * deployment runbook). Tokens are cached in-process for ~50min (DocuSign
 * issues 1hr access tokens; we expire ours 10min early to avoid a race).
 *
 * Required env (validated at construction time when this provider is
 * selected — misspelled / missing vars fail loud rather than failing the
 * first envelope create):
 *
 *   DOCUSIGN_INTEGRATION_KEY    — client_id (GUID)
 *   DOCUSIGN_USER_ID            — impersonated user GUID (the API user
 *                                 that owns the envelopes)
 *   DOCUSIGN_ACCOUNT_ID         — API account GUID
 *   DOCUSIGN_PRIVATE_KEY        — RSA private key (PEM, multi-line). Pair
 *                                 to the public key registered on the
 *                                 integration key in DocuSign Admin.
 *   DOCUSIGN_BASE_PATH          — DocuSign REST API base; sandbox is
 *                                 `https://demo.docusign.net/restapi`,
 *                                 prod is `https://www.docusign.net/restapi`.
 *                                 No trailing slash.
 *
 * Tests inject a fake `DocuSignClientFactory` so the SDK is never reached
 * during unit/integration runs (otherwise we'd be hitting DocuSign's
 * rate-limited sandbox + leaking envelopes into someone's demo account).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  documentsTable,
  esignEnvelopesTable,
  esignSigningEventsTable,
  type EsignEnvelope,
  type EnvelopeSigner,
} from "@workspace/db";
import {
  type CreateEnvelopeInput,
  type ESignProvider,
  type SignerContext,
  type SignerInput,
  type SigningSession,
  type SigningSessionInput,
  EnvelopeNotFoundError,
  EnvelopeStateError,
  InvalidSignatureInputError,
  UnsupportedOperationError,
} from "./provider";
import { ObjectStorageService } from "../objectStorage";
import { logger } from "../logger";
// EsignStorage is shared with the native provider — both providers cache
// signed PDFs to GCS through the same interface. Importing here rather
// than redefining keeps test seams identical (tests reuse
// InMemoryEsignStorage across both providers).
import type { EsignStorage } from "./mediflowProvider";

// ---------- SDK boundary types ---------------------------------------------
//
// `docusign-esign` ships as plain JS (no .d.ts). We declare the narrow
// shape we actually use here so the rest of the file stays strongly typed
// — the `any`-cast is contained to one line in `loadSdk()`.

interface DocuSignSdkApiClient {
  setBasePath(path: string): void;
  setOAuthBasePath(path: string): void;
  addDefaultHeader(name: string, value: string): void;
  requestJWTUserToken(
    integrationKey: string,
    userId: string,
    scopes: string[],
    privateKey: Buffer,
    expiresIn: number,
  ): Promise<{ body: { access_token: string; expires_in: number } }>;
}

interface DocuSignSdkEnvelopesApi {
  createEnvelope(
    accountId: string,
    opts: { envelopeDefinition: unknown },
  ): Promise<{ envelopeId: string; status: string }>;
  createRecipientView(
    accountId: string,
    envelopeId: string,
    opts: { recipientViewRequest: unknown },
  ): Promise<{ url: string }>;
  update(
    accountId: string,
    envelopeId: string,
    opts: { envelope: unknown },
  ): Promise<unknown>;
  getDocument(
    accountId: string,
    envelopeId: string,
    documentId: string,
  ): Promise<Buffer>;
}

interface DocuSignSdk {
  ApiClient: new () => DocuSignSdkApiClient;
  EnvelopesApi: new (apiClient: DocuSignSdkApiClient) => DocuSignSdkEnvelopesApi;
}

// Cached lazy import. Tests override via the constructor `sdk` option so
// this is never reached during the test suite.
let _sdkPromise: Promise<DocuSignSdk> | undefined;
async function loadSdk(): Promise<DocuSignSdk> {
  if (!_sdkPromise) {
    // The docusign-esign SDK ships as plain JS with no .d.ts. The
    // require()-style import returns the module shape declared above;
    // the cast is the one untyped boundary in this file.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error -- docusign-esign has no bundled type declarations.
    _sdkPromise = import("docusign-esign") as unknown as Promise<DocuSignSdk>;
  }
  return _sdkPromise;
}

// ---------- Config ---------------------------------------------------------

export interface DocuSignProviderConfig {
  integrationKey: string;
  userId: string;
  accountId: string;
  privateKey: string;
  /** DocuSign REST base path (no trailing slash). */
  basePath: string;
}

function deriveOAuthBasePath(restBasePath: string): string {
  // DocuSign's JWT consent + token endpoints live on a different host than
  // the REST API. The mapping is fixed: account.docusign.com for prod,
  // account-d.docusign.com for the demo sandbox.
  if (restBasePath.includes("demo.docusign.net")) return "account-d.docusign.com";
  return "account.docusign.com";
}

/**
 * Read + validate config from the process environment. Throws a single
 * descriptive error listing every missing var — the deploy runbook
 * surface this so an operator can fix all of them in one pass.
 */
export function readDocuSignConfigFromEnv(): DocuSignProviderConfig {
  const missing: string[] = [];
  const get = (name: string): string => {
    const v = process.env[name]?.trim();
    if (!v) {
      missing.push(name);
      return "";
    }
    return v;
  };
  const integrationKey = get("DOCUSIGN_INTEGRATION_KEY");
  const userId = get("DOCUSIGN_USER_ID");
  const accountId = get("DOCUSIGN_ACCOUNT_ID");
  const privateKey = get("DOCUSIGN_PRIVATE_KEY");
  const basePath = get("DOCUSIGN_BASE_PATH");
  if (missing.length > 0) {
    throw new Error(
      `DocuSign e-sign provider selected but required env vars are missing: ${missing.join(", ")}. ` +
        `See the deployment runbook for the JWT consent + key provisioning steps.`,
    );
  }
  return { integrationKey, userId, accountId, privateKey, basePath };
}

// ---------- JWT token cache ------------------------------------------------

interface CachedToken {
  accessToken: string;
  /** Epoch-ms expiry — caller checks Date.now() against this. */
  expiresAt: number;
}

/**
 * Refresh the access token slightly before DocuSign's hard expiry so a
 * request mid-flight doesn't race the rotation. DocuSign issues 1hr
 * tokens by default; we treat ours as valid for 50min.
 */
const TOKEN_LIFETIME_SECONDS = 60 * 60;
const TOKEN_REFRESH_LEADTIME_MS = 10 * 60 * 1000;

// ---------- Storage facade -------------------------------------------------

class GcsDocuSignStorage implements EsignStorage {
  private readonly svc = new ObjectStorageService();
  async uploadPdf(buffer: Buffer, filename: string, orgId: string): Promise<string> {
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

// ---------- DocuSignClientFactory (test seam) ------------------------------

/**
 * Yields a ready-to-use EnvelopesApi for a given config. Production uses
 * the real SDK + JWT auth; tests inject a fake that returns a stubbed
 * EnvelopesApi so no DocuSign HTTP calls are made.
 */
export interface DocuSignClientFactory {
  getEnvelopesApi(): Promise<DocuSignSdkEnvelopesApi>;
}

class JwtDocuSignClientFactory implements DocuSignClientFactory {
  private cachedToken: CachedToken | undefined;
  private cachedApi: DocuSignSdkEnvelopesApi | undefined;
  private cachedApiTokenAtCreation: string | undefined;

  constructor(private readonly config: DocuSignProviderConfig) {}

  async getEnvelopesApi(): Promise<DocuSignSdkEnvelopesApi> {
    const token = await this.getAccessToken();
    // Reuse the EnvelopesApi instance only when it was built with the
    // currently-valid token. On rotation we rebuild — the SDK caches the
    // Authorization header on the underlying ApiClient.
    if (this.cachedApi && this.cachedApiTokenAtCreation === token) {
      return this.cachedApi;
    }
    const sdk = await loadSdk();
    const apiClient = new sdk.ApiClient();
    apiClient.setBasePath(this.config.basePath);
    apiClient.setOAuthBasePath(deriveOAuthBasePath(this.config.basePath));
    apiClient.addDefaultHeader("Authorization", `Bearer ${token}`);
    this.cachedApi = new sdk.EnvelopesApi(apiClient);
    this.cachedApiTokenAtCreation = token;
    return this.cachedApi;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + TOKEN_REFRESH_LEADTIME_MS) {
      return this.cachedToken.accessToken;
    }
    const sdk = await loadSdk();
    const apiClient = new sdk.ApiClient();
    apiClient.setOAuthBasePath(deriveOAuthBasePath(this.config.basePath));
    const result = await apiClient.requestJWTUserToken(
      this.config.integrationKey,
      this.config.userId,
      ["signature", "impersonation"],
      Buffer.from(this.config.privateKey, "utf8"),
      TOKEN_LIFETIME_SECONDS,
    );
    const accessToken = result.body.access_token;
    const expiresIn = result.body.expires_in ?? TOKEN_LIFETIME_SECONDS;
    this.cachedToken = {
      accessToken,
      expiresAt: now + expiresIn * 1000,
    };
    return accessToken;
  }
}

// ---------- Provider -------------------------------------------------------

export interface DocuSignProviderOptions {
  config?: DocuSignProviderConfig;
  /** Test seam — inject a fake client factory to stub the SDK entirely. */
  clientFactory?: DocuSignClientFactory;
  /** Test seam — inject a fake storage to stub GCS. */
  storage?: EsignStorage;
}

export class DocuSignESignProvider implements ESignProvider {
  private readonly config: DocuSignProviderConfig;
  private readonly clientFactory: DocuSignClientFactory;
  private readonly storage: EsignStorage;

  constructor(opts: DocuSignProviderOptions = {}) {
    this.config = opts.config ?? readDocuSignConfigFromEnv();
    this.clientFactory =
      opts.clientFactory ?? new JwtDocuSignClientFactory(this.config);
    this.storage = opts.storage ?? new GcsDocuSignStorage();
  }

  // ---- createEnvelope -----------------------------------------------------

  async createEnvelope(input: CreateEnvelopeInput): Promise<EsignEnvelope> {
    // Polymorphic parent check — same rule MediflowESignProvider enforces.
    const hasCarrier = Boolean(input.carrierContractingRequestId);
    const hasRun = Boolean(input.onboardingRunId);
    if (hasCarrier === hasRun) {
      throw new InvalidSignatureInputError(
        "createEnvelope: exactly one of carrierContractingRequestId or onboardingRunId must be set",
      );
    }

    // Idempotency: re-creating an envelope for the same parent while a
    // non-voided envelope exists returns the existing row. Same partial-
    // unique index handling as the native provider.
    const parentClause = hasCarrier
      ? eq(
          esignEnvelopesTable.carrierContractingRequestId,
          input.carrierContractingRequestId!,
        )
      : eq(esignEnvelopesTable.onboardingRunId, input.onboardingRunId!);
    const [existing] = await db
      .select()
      .from(esignEnvelopesTable)
      .where(and(eq(esignEnvelopesTable.orgId, input.orgId), parentClause))
      .limit(1);
    if (existing && existing.status !== "voided") return existing;

    // Load the unsigned PDF bytes from storage so we can hand them to
    // DocuSign as a base64 document attachment.
    const [doc] = await db
      .select()
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.id, input.pdfDocumentId),
          eq(documentsTable.orgId, input.orgId),
        ),
      )
      .limit(1);
    if (!doc) {
      throw new InvalidSignatureInputError(
        `createEnvelope: pdf document ${input.pdfDocumentId} not found in org`,
      );
    }
    const pdfBytes = await this.storage.readPdf(doc.storageKey);

    if (input.signers.length !== 1) {
      // DocuSign supports multi-signer routing but the route layer only
      // wires single-signer flows today. Surface clearly.
      throw new InvalidSignatureInputError(
        "createEnvelope: DocuSign provider expects exactly one signer (multi-signer routing not wired)",
      );
    }
    const signer = input.signers[0]!;

    // Anchor the SignHere tab to the `\\sn1\\` marker that
    // contractingPdf/poaTemplate.ts already emits in the unsigned PDF.
    // Mirrors what the native provider's coordinate-based positioning
    // produces visually.
    const envelopeDefinition = {
      emailSubject: "Please sign your agencyBRIDGE document",
      documents: [
        {
          documentBase64: pdfBytes.toString("base64"),
          name: doc.name ?? "document.pdf",
          fileExtension: "pdf",
          documentId: "1",
        },
      ],
      recipients: {
        signers: [
          {
            email: signer.email,
            name: signer.displayName,
            recipientId: "1",
            routingOrder: "1",
            // clientUserId is what makes this an EMBEDDED signer — without
            // it DocuSign sends a "please sign" email and the recipient
            // signs via DocuSign's hosted page. With it we can issue
            // recipient-view URLs for in-app embedded signing.
            clientUserId: signer.userId,
            tabs: {
              signHereTabs: [
                {
                  anchorString: "\\sn1\\",
                  anchorUnits: "pixels",
                  anchorXOffset: "0",
                  anchorYOffset: "0",
                },
              ],
            },
          },
        ],
      },
      status: "sent",
    };

    const api = await this.clientFactory.getEnvelopesApi();
    const result = await api.createEnvelope(this.config.accountId, {
      envelopeDefinition,
    });

    const id = randomUUID();
    const [row] = await db
      .insert(esignEnvelopesTable)
      .values({
        id,
        orgId: input.orgId,
        carrierContractingRequestId: input.carrierContractingRequestId ?? null,
        onboardingRunId: input.onboardingRunId ?? null,
        unsignedPdfDocumentId: input.pdfDocumentId,
        signers: input.signers,
        status: "pending",
        provider: "docusign",
        externalEnvelopeId: result.envelopeId,
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
        provider: "docusign",
        externalEnvelopeId: result.envelopeId,
        docusignStatus: result.status,
        signers: input.signers.map((s) => ({
          userId: s.userId,
          email: s.email,
        })),
      },
    });

    return row!;
  }

  // ---- startSigningSession ------------------------------------------------

  async startSigningSession(
    input: SigningSessionInput,
  ): Promise<SigningSession> {
    if (!input.returnUrl) {
      throw new InvalidSignatureInputError(
        "startSigningSession: returnUrl is required for DocuSign provider",
      );
    }
    const env = await this.getEnvelope(input.envelopeId, input.orgId);
    if (!env.externalEnvelopeId) {
      // Shouldn't happen — createEnvelope always writes it. Defensive
      // because a DB row with provider='docusign' + NULL externalId would
      // be a data-corruption case rather than a normal flow.
      throw new EnvelopeStateError(
        env.status,
        "DocuSign envelope row missing externalEnvelopeId — corrupt state",
      );
    }
    const signer = (env.signers as EnvelopeSigner[]).find(
      (s) => s.userId === input.signerUserId,
    );
    if (!signer) {
      throw new InvalidSignatureInputError(
        `startSigningSession: signerUserId ${input.signerUserId} is not on envelope`,
      );
    }
    const api = await this.clientFactory.getEnvelopesApi();
    const view = await api.createRecipientView(
      this.config.accountId,
      env.externalEnvelopeId,
      {
        recipientViewRequest: {
          returnUrl: input.returnUrl,
          // 'none' = no DocuSign-side identity verification. KBA / SMS /
          // phone-call verification is a per-envelope upgrade — for v1
          // we keep parity with the native flow (no extra identity gate).
          authenticationMethod: "none",
          email: signer.email,
          userName: signer.displayName,
          clientUserId: signer.userId,
        },
      },
    );
    return { signingUrl: view.url };
  }

  // ---- recordSignature ----------------------------------------------------

  async recordSignature(
    _envelopeId: string,
    _orgId: string,
    _signerInput: SignerInput,
    _ctx: SignerContext,
  ): Promise<EsignEnvelope> {
    throw new UnsupportedOperationError("recordSignature", "docusign");
  }

  // ---- voidEnvelope -------------------------------------------------------

  async voidEnvelope(
    envelopeId: string,
    orgId: string,
    reason: string,
    actorUserId: string | null,
  ): Promise<void> {
    const env = await this.getEnvelope(envelopeId, orgId);
    if (env.status === "voided") return; // idempotent
    if (env.status === "completed") {
      throw new EnvelopeStateError(
        env.status,
        "Cannot void a completed envelope",
      );
    }
    if (!env.externalEnvelopeId) {
      throw new EnvelopeStateError(
        env.status,
        "DocuSign envelope row missing externalEnvelopeId — corrupt state",
      );
    }
    const api = await this.clientFactory.getEnvelopesApi();
    await api.update(this.config.accountId, env.externalEnvelopeId, {
      envelope: { status: "voided", voidedReason: reason },
    });

    await db
      .update(esignEnvelopesTable)
      .set({ status: "voided", voidedAt: new Date() })
      .where(eq(esignEnvelopesTable.id, envelopeId));

    await db.insert(esignSigningEventsTable).values({
      id: randomUUID(),
      orgId,
      envelopeId,
      eventType: "envelope_voided",
      actorUserId,
      eventData: { reason, provider: "docusign" },
    });
  }

  // ---- getEnvelope --------------------------------------------------------

  async getEnvelope(envelopeId: string, orgId: string): Promise<EsignEnvelope> {
    // Single source of truth = our DB. The webhook handler keeps our row
    // in sync with DocuSign envelope state; we never round-trip to
    // DocuSign on each read.
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
    const env = await this.getEnvelope(envelopeId, orgId);
    if (env.status !== "completed") {
      throw new EnvelopeStateError(
        env.status,
        `Cannot fetch signed PDF for envelope in status '${env.status}'`,
      );
    }
    // Hot path: webhook has already cached the signed PDF to GCS and
    // populated signedPdfDocumentId. Read from storage rather than
    // round-tripping to DocuSign.
    if (env.signedPdfDocumentId) {
      const [doc] = await db
        .select()
        .from(documentsTable)
        .where(eq(documentsTable.id, env.signedPdfDocumentId))
        .limit(1);
      if (doc) return this.storage.readPdf(doc.storageKey);
      logger.warn(
        { envelopeId, signedPdfDocumentId: env.signedPdfDocumentId },
        "DocuSign envelope has signedPdfDocumentId but document row is missing — falling back to DocuSign fetch",
      );
    }
    // Cold path: webhook hasn't cached it (e.g. race between webhook
    // delivery + this call, or an envelope that completed before the
    // webhook was wired). Fetch from DocuSign — the 'combined' magic-
    // string returns all documents in the envelope as a single PDF
    // including the DocuSign certificate of completion.
    if (!env.externalEnvelopeId) {
      throw new EnvelopeStateError(
        env.status,
        "DocuSign envelope row missing externalEnvelopeId — corrupt state",
      );
    }
    const api = await this.clientFactory.getEnvelopesApi();
    return api.getDocument(
      this.config.accountId,
      env.externalEnvelopeId,
      "combined",
    );
  }
}

// ---------- Singleton accessor ---------------------------------------------

let _singleton: DocuSignESignProvider | undefined;

/**
 * Resolve the process-wide DocuSign provider. The factory
 * (`./factory.ts`) is the only call site in production code; tests
 * construct their own instance with the test seams.
 */
export function getDocuSignProvider(): DocuSignESignProvider {
  if (!_singleton) {
    _singleton = new DocuSignESignProvider();
  }
  return _singleton;
}

/**
 * Test helper — reset the cached singleton so each test starts clean.
 */
export function _resetDocuSignProviderForTests(
  provider: DocuSignESignProvider | undefined,
): void {
  _singleton = provider;
}
