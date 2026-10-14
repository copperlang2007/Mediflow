/**
 * DocuSignESignProvider integration tests.
 *
 * The DocuSign SDK is never reached during these tests — the `clientFactory`
 * test seam on the provider lets us inject a fake `DocuSignClientFactory`
 * that returns a stubbed EnvelopesApi. Calls (createEnvelope,
 * createRecipientView, update, getDocument) are recorded so each test
 * can assert what we sent to DocuSign without making a real HTTP call.
 *
 * What's covered:
 *   - createEnvelope: success path persists provider='docusign' +
 *     external_envelope_id, writes audit event, returns row.
 *   - createEnvelope: idempotency mirrors the native provider.
 *   - createEnvelope: parent-mutex error (both/neither parent set).
 *   - startSigningSession: returns DocuSign recipient view URL;
 *     fails clearly when returnUrl is missing or signer isn't on envelope.
 *   - recordSignature: throws UnsupportedOperationError.
 *   - voidEnvelope: updates DocuSign + mirrors to our row.
 *   - getEnvelope: org-scoped read, 404 cross-org.
 *   - getSignedPdf: cold path fetches from DocuSign;
 *     non-completed envelope is rejected.
 *
 * What is NOT covered (intentional — separate PR):
 *   - The DocuSign Connect webhook handler that promotes envelopes from
 *     'pending' to 'completed' lives in routes/docusignWebhook.ts and is
 *     tested separately.
 *   - The factory-wired `ESIGN_PROVIDER=docusign` path. The factory still
 *     throws "not yet implemented" until the webhook ships in PR 2c —
 *     no point flipping the env switch before envelopes can complete.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { dbF, authF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  authF: async (): Promise<Record<string, unknown>> => {
    const { identityMockFactory } = await import("../helpers/testApp");
    return identityMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agentOnboardingRunsTable,
  documentsTable,
  esignEnvelopesTable,
  esignSigningEventsTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedAgent } from "../helpers/testDb";

// ---- Fake DocuSign SDK -----------------------------------------------------

interface CapturedCall {
  method: string;
  args: unknown[];
}

interface FakeEnvelopesApiBehaviour {
  createEnvelopeResult?: { envelopeId: string; status: string };
  createEnvelopeError?: Error;
  recipientViewUrl?: string;
  recipientViewError?: Error;
  updateError?: Error;
  getDocumentResult?: Buffer;
  getDocumentError?: Error;
}

function makeFakeApi(behaviour: FakeEnvelopesApiBehaviour): {
  api: import("../../lib/esign/docusignProvider").DocuSignClientFactory;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const envelopesApi = {
    async createEnvelope(accountId: string, opts: { envelopeDefinition: unknown }) {
      calls.push({ method: "createEnvelope", args: [accountId, opts] });
      if (behaviour.createEnvelopeError) throw behaviour.createEnvelopeError;
      return (
        behaviour.createEnvelopeResult ?? {
          envelopeId: `ds-env-${randomUUID()}`,
          status: "sent",
        }
      );
    },
    async createRecipientView(
      accountId: string,
      envelopeId: string,
      opts: { recipientViewRequest: unknown },
    ) {
      calls.push({
        method: "createRecipientView",
        args: [accountId, envelopeId, opts],
      });
      if (behaviour.recipientViewError) throw behaviour.recipientViewError;
      return { url: behaviour.recipientViewUrl ?? "https://demo.docusign.net/sign?token=xyz" };
    },
    async update(accountId: string, envelopeId: string, opts: { envelope: unknown }) {
      calls.push({ method: "update", args: [accountId, envelopeId, opts] });
      if (behaviour.updateError) throw behaviour.updateError;
      return {};
    },
    async getDocument(accountId: string, envelopeId: string, documentId: string) {
      calls.push({ method: "getDocument", args: [accountId, envelopeId, documentId] });
      if (behaviour.getDocumentError) throw behaviour.getDocumentError;
      return behaviour.getDocumentResult ?? Buffer.from("%PDF-1.4 fake combined doc");
    },
  };
  return {
    api: {
      async getEnvelopesApi() {
        return envelopesApi;
      },
    },
    calls,
  };
}

// ---- Test fixtures ---------------------------------------------------------

let testStorage: import("../../lib/esign/mediflowProvider").InMemoryEsignStorage;
let DocuSignESignProvider: typeof import("../../lib/esign/docusignProvider").DocuSignESignProvider;
let UnsupportedOperationError: typeof import("../../lib/esign/provider").UnsupportedOperationError;
let InvalidSignatureInputError: typeof import("../../lib/esign/provider").InvalidSignatureInputError;
let EnvelopeStateError: typeof import("../../lib/esign/provider").EnvelopeStateError;
let EnvelopeNotFoundError: typeof import("../../lib/esign/provider").EnvelopeNotFoundError;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

const TEST_CONFIG = {
  integrationKey: "fake-integration-key",
  userId: "fake-user-id",
  accountId: "fake-account-id",
  privateKey: "fake-private-key-not-actually-used-with-test-seam",
  basePath: "https://demo.docusign.net/restapi",
};

async function seedDocument(orgId: string): Promise<{ id: string; storageKey: string }> {
  const handle = await bootTestDb();
  const pdfBytes = Buffer.from("%PDF-1.4 fake unsigned doc");
  // uploadPdf returns the actual key the storage assigned — use that as
  // the documents row's storage_key so the provider can read it back.
  const storageKey = await testStorage.uploadPdf(pdfBytes, "test.pdf", orgId);

  const docId = nextId("doc");
  await handle.db.insert(documentsTable).values({
    id: docId,
    orgId,
    name: "Test PDF",
    category: "contracting",
    storageKey,
    fileSizeBytes: pdfBytes.length,
    mimeType: "application/pdf",
  });
  return { id: docId, storageKey };
}

/**
 * Seed an agent_onboarding_runs row so the FK on esign_envelopes resolves.
 * Returns the run id for use as `onboardingRunId` in createEnvelope calls.
 */
async function seedOnboardingRun(orgId: string): Promise<string> {
  const handle = await bootTestDb();
  const agent = await seedAgent(handle.db, { orgId });
  counter += 1;
  const runId = `run-${counter}-${randomUUID().slice(0, 8)}`;
  await handle.db.insert(agentOnboardingRunsTable).values({
    id: runId,
    orgId,
    agentId: agent.id,
    status: "draft",
  });
  return runId;
}

beforeAll(async () => {
  await bootTestDb();
  const mediflowMod = await import("../../lib/esign/mediflowProvider");
  testStorage = new mediflowMod.InMemoryEsignStorage();
  const docusignMod = await import("../../lib/esign/docusignProvider");
  DocuSignESignProvider = docusignMod.DocuSignESignProvider;
  const providerMod = await import("../../lib/esign/provider");
  UnsupportedOperationError = providerMod.UnsupportedOperationError;
  InvalidSignatureInputError = providerMod.InvalidSignatureInputError;
  EnvelopeStateError = providerMod.EnvelopeStateError;
  EnvelopeNotFoundError = providerMod.EnvelopeNotFoundError;
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(async () => {
  // Each test owns its own DocuSign mock — we always construct the provider
  // fresh in-test so the captured-calls array doesn't leak across tests.
});

// ---------------------------------------------------------------------------
// createEnvelope
// ---------------------------------------------------------------------------

describe("DocuSignESignProvider.createEnvelope", () => {
  it("persists provider='docusign' + external_envelope_id, writes audit event", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const runId = await seedOnboardingRun(org.id);
    const { api: clientFactory, calls } = makeFakeApi({
      createEnvelopeResult: { envelopeId: "ds-envelope-abc-123", status: "sent" },
    });
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });

    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: runId,
      pdfDocumentId: doc.id,
      signers: [
        {
          userId: "user-1",
          displayName: "Alice Agent",
          email: "alice@example.com",
        },
      ],
      createdByUserId: "user-1",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
    });

    expect(env.provider).toBe("docusign");
    expect(env.externalEnvelopeId).toBe("ds-envelope-abc-123");
    expect(env.status).toBe("pending");
    expect(env.unsignedPdfDocumentId).toBe(doc.id);

    // Verify the SDK call shape
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("createEnvelope");
    const [accountId, opts] = calls[0]!.args as [
      string,
      { envelopeDefinition: { recipients: { signers: Array<{ email: string; clientUserId: string }> } } },
    ];
    expect(accountId).toBe(TEST_CONFIG.accountId);
    expect(opts.envelopeDefinition.recipients.signers[0]!.email).toBe(
      "alice@example.com",
    );
    expect(opts.envelopeDefinition.recipients.signers[0]!.clientUserId).toBe(
      "user-1",
    );

    // Audit event
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.envelopeId, env.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("envelope_created");
    const data = events[0]!.eventData as Record<string, unknown>;
    expect(data.provider).toBe("docusign");
    expect(data.externalEnvelopeId).toBe("ds-envelope-abc-123");
  });

  it("is idempotent — returns existing envelope for the same parent", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const runId = await seedOnboardingRun(org.id);
    const { api: clientFactory, calls } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const input = {
      orgId: org.id,
      onboardingRunId: runId,
      pdfDocumentId: doc.id,
      signers: [
        { userId: "u1", displayName: "Alice", email: "a@e.com" },
      ],
      createdByUserId: "u1",
      ipAddress: null,
      userAgent: null,
    };

    const first = await provider.createEnvelope(input);
    const second = await provider.createEnvelope(input);

    expect(second.id).toBe(first.id);
    expect(second.externalEnvelopeId).toBe(first.externalEnvelopeId);
    // SDK only called once — the second call short-circuited on existing row.
    expect(calls.filter((c) => c.method === "createEnvelope")).toHaveLength(1);
  });

  it("rejects when both carrier and run parents are set", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });

    await expect(
      provider.createEnvelope({
        orgId: org.id,
        carrierContractingRequestId: "carrier-x",
        onboardingRunId: "run-x",
        pdfDocumentId: doc.id,
        signers: [{ userId: "u1", displayName: "A", email: "a@e.com" }],
        createdByUserId: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(InvalidSignatureInputError);
  });

  it("rejects multi-signer input (single-signer v1)", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });

    await expect(
      provider.createEnvelope({
        orgId: org.id,
        onboardingRunId: await seedOnboardingRun(org.id),
        pdfDocumentId: doc.id,
        signers: [
          { userId: "u1", displayName: "A", email: "a@e.com" },
          { userId: "u2", displayName: "B", email: "b@e.com" },
        ],
        createdByUserId: null,
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toBeInstanceOf(InvalidSignatureInputError);
  });
});

// ---------------------------------------------------------------------------
// startSigningSession
// ---------------------------------------------------------------------------

describe("DocuSignESignProvider.startSigningSession", () => {
  it("returns the recipient view URL from DocuSign", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory, calls } = makeFakeApi({
      recipientViewUrl: "https://demo.docusign.net/sign?token=fresh-xyz",
    });
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });

    const session = await provider.startSigningSession({
      envelopeId: env.id,
      orgId: org.id,
      signerUserId: "u1",
      returnUrl: "https://app.mediflow.com/sign-complete",
    });

    expect(session.signingUrl).toBe(
      "https://demo.docusign.net/sign?token=fresh-xyz",
    );
    const viewCall = calls.find((c) => c.method === "createRecipientView");
    expect(viewCall).toBeDefined();
    const opts = viewCall!.args[2] as {
      recipientViewRequest: { returnUrl: string; clientUserId: string };
    };
    expect(opts.recipientViewRequest.returnUrl).toBe(
      "https://app.mediflow.com/sign-complete",
    );
    expect(opts.recipientViewRequest.clientUserId).toBe("u1");
  });

  it("rejects when returnUrl is missing", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });

    await expect(
      provider.startSigningSession({
        envelopeId: env.id,
        orgId: org.id,
        signerUserId: "u1",
        // returnUrl omitted on purpose
      }),
    ).rejects.toBeInstanceOf(InvalidSignatureInputError);
  });

  it("rejects when signerUserId is not on the envelope", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });

    await expect(
      provider.startSigningSession({
        envelopeId: env.id,
        orgId: org.id,
        signerUserId: "someone-else",
        returnUrl: "https://app.example.com/done",
      }),
    ).rejects.toBeInstanceOf(InvalidSignatureInputError);
  });
});

// ---------------------------------------------------------------------------
// recordSignature
// ---------------------------------------------------------------------------

describe("DocuSignESignProvider.recordSignature", () => {
  it("throws UnsupportedOperationError — DocuSign signs in hosted UI", async () => {
    const { api: clientFactory } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    await expect(
      provider.recordSignature(
        "any-envelope-id",
        "any-org-id",
        {
          typedName: "Alice",
          signatureSvg: "<svg/>",
          consentToElectronicBusiness: true,
          intentToSign: true,
        },
        { signerUserId: "u1", ipAddress: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});

// ---------------------------------------------------------------------------
// voidEnvelope
// ---------------------------------------------------------------------------

describe("DocuSignESignProvider.voidEnvelope", () => {
  it("calls DocuSign update, mirrors to our row, writes audit event", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory, calls } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });

    await provider.voidEnvelope(env.id, org.id, "admin requested", "admin-1");

    // DocuSign update was called with status='voided'
    const updateCall = calls.find((c) => c.method === "update");
    expect(updateCall).toBeDefined();
    const opts = updateCall!.args[2] as {
      envelope: { status: string; voidedReason: string };
    };
    expect(opts.envelope.status).toBe("voided");
    expect(opts.envelope.voidedReason).toBe("admin requested");

    // Local row mirrored
    const [updated] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, env.id));
    expect(updated!.status).toBe("voided");
    expect(updated!.voidedAt).toBeInstanceOf(Date);

    // Audit event
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.envelopeId, env.id));
    const voidEvent = events.find((e) => e.eventType === "envelope_voided");
    expect(voidEvent).toBeDefined();
  });

  it("rejects voiding a completed envelope", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });
    // Simulate webhook having moved the envelope to 'completed'
    await handle.db
      .update(esignEnvelopesTable)
      .set({ status: "completed", signedAt: new Date() })
      .where(eq(esignEnvelopesTable.id, env.id));

    await expect(
      provider.voidEnvelope(env.id, org.id, "too late", "admin-1"),
    ).rejects.toBeInstanceOf(EnvelopeStateError);
  });

  it("is idempotent on an already-voided envelope", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory, calls } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });

    await provider.voidEnvelope(env.id, org.id, "first", "admin-1");
    await provider.voidEnvelope(env.id, org.id, "second", "admin-1");

    // Only one update + one void event — second call short-circuited.
    expect(calls.filter((c) => c.method === "update")).toHaveLength(1);
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.envelopeId, env.id));
    expect(events.filter((e) => e.eventType === "envelope_voided")).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// getEnvelope
// ---------------------------------------------------------------------------

describe("DocuSignESignProvider.getEnvelope", () => {
  it("404s when the envelope is in a different org", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const otherOrg = await seedOrg(handle.db, { id: nextId("ds-other") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });

    await expect(
      provider.getEnvelope(env.id, otherOrg.id),
    ).rejects.toBeInstanceOf(EnvelopeNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getSignedPdf
// ---------------------------------------------------------------------------

describe("DocuSignESignProvider.getSignedPdf", () => {
  it("rejects when the envelope is not yet completed", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const { api: clientFactory } = makeFakeApi({});
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });

    await expect(
      provider.getSignedPdf(env.id, org.id),
    ).rejects.toBeInstanceOf(EnvelopeStateError);
  });

  it("cold path — fetches combined PDF from DocuSign when not yet cached", async () => {
    const handle = await bootTestDb();
    const org = await seedOrg(handle.db, { id: nextId("ds-org") });
    const doc = await seedDocument(org.id);
    const fakePdfBytes = Buffer.from("%PDF-1.4 signed from docusign");
    const { api: clientFactory, calls } = makeFakeApi({
      getDocumentResult: fakePdfBytes,
    });
    const provider = new DocuSignESignProvider({
      config: TEST_CONFIG,
      clientFactory,
      storage: testStorage,
    });
    const env = await provider.createEnvelope({
      orgId: org.id,
      onboardingRunId: await seedOnboardingRun(org.id),
      pdfDocumentId: doc.id,
      signers: [{ userId: "u1", displayName: "Alice", email: "a@e.com" }],
      createdByUserId: null,
      ipAddress: null,
      userAgent: null,
    });
    // Simulate webhook moved to completed but didn't yet cache signed PDF
    await handle.db
      .update(esignEnvelopesTable)
      .set({ status: "completed", signedAt: new Date() })
      .where(eq(esignEnvelopesTable.id, env.id));

    const bytes = await provider.getSignedPdf(env.id, org.id);
    expect(bytes.equals(fakePdfBytes)).toBe(true);

    // getDocument called with the 'combined' magic-string
    const getDocCall = calls.find((c) => c.method === "getDocument");
    expect(getDocCall).toBeDefined();
    expect(getDocCall!.args[2]).toBe("combined");
  });
});
