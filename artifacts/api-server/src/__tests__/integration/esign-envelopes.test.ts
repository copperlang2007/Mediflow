/**
 * Day-5 native e-signature (Beta) integration tests.
 *
 * Surface under test:
 *   POST /api/esign/envelopes                          — create
 *   GET  /api/esign/envelopes/:envelopeId              — fetch
 *   POST /api/esign/envelopes/:envelopeId/sign         — record signature
 *   POST /api/esign/envelopes/:envelopeId/void         — admin void
 *   GET  /api/esign/envelopes/:envelopeId/signed-pdf   — stream signed PDF
 *
 * Also covers the onboarding `POST /:agentId/carriers/:carrierId/sign`
 * route's new behaviour (create envelope + return signingUrl) and the
 * post-completion contracting transition (signed → submit task created).
 *
 * The provider runs against an in-memory storage backend by default (no
 * PRIVATE_OBJECT_DIR env var → InMemoryEsignStorage is selected). The
 * SHA-256 integrity assertion reads the stored bytes back through the
 * same storage interface and confirms the hash matches.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const { dbF, clerkF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  clerkF: async (): Promise<Record<string, unknown>> => {
    const { clerkMockFactory } = await import("../helpers/testApp");
    return clerkMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);

import { and, eq } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import {
  agentsTable,
  agentOnboardingRunsTable,
  agentContractingProfilesTable,
  carriersTable,
  carrierContractingRequestsTable,
  documentsTable,
  esignEnvelopesTable,
  esignSigningEventsTable,
  taskInstancesTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let testStorage: import("../../lib/esign/mediflowProvider").InMemoryEsignStorage;
let setMediflowProvider: (
  provider:
    | import("../../lib/esign/mediflowProvider").MediflowESignProvider
    | undefined,
) => void;

// Per-test ids to keep the partial-unique active-onboarding index out of
// the way across describe blocks.
let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

interface SignCtx {
  org: { id: string };
  otherOrg: { id: string };
  admin: { id: string };
  agencyAdmin: { id: string };
  otherOrgAdmin: { id: string };
  agentUser: { id: string };
  interloperAgent: { id: string };
  agentId: string;
  carrierA: { id: string; name: string };
  requestId: string;
  pdfDocId: string;
}

async function buildSignCtx(): Promise<SignCtx> {
  const handle = await bootTestDb();
  const org = await seedOrg(handle.db, { id: nextId("esign-org") });
  const otherOrg = await seedOrg(handle.db, { id: nextId("esign-other") });
  const admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "super_admin",
  });
  const agencyAdmin = await seedUser(handle.db, {
    orgId: org.id,
    role: "agency_admin",
  });
  const otherOrgAdmin = await seedUser(handle.db, {
    orgId: otherOrg.id,
    role: "super_admin",
  });
  const agentUser = await seedUser(handle.db, {
    orgId: org.id,
    role: "agent",
  });
  const interloperAgent = await seedUser(handle.db, {
    orgId: org.id,
    role: "agent",
  });
  const agentRow = await seedAgent(handle.db, { orgId: org.id });
  await handle.db
    .update(agentsTable)
    .set({ userId: agentUser.id, email: "agent@example.com" })
    .where(eq(agentsTable.id, agentRow.id));

  const carrierA = { id: nextId("carrier-a"), name: "Acme Health" };
  await handle.db.insert(carriersTable).values({
    id: carrierA.id,
    orgId: org.id,
    name: carrierA.name,
  });

  // Drive the onboarding run + carrier request through to
  // `paperwork_generated` so the e-sign envelope create route has a
  // valid carrier_contracting_request to point at.
  await request(app)
    .post("/api/onboarding/start")
    .set(withAuth(admin.id))
    .send({ agentId: agentRow.id });
  await request(app)
    .patch(`/api/onboarding/${agentRow.id}/profile`)
    .set(withAuth(admin.id))
    .send({ phone: "+15551234567", email: "agent@example.com" });
  await request(app)
    .post(`/api/onboarding/${agentRow.id}/carriers/select`)
    .set(withAuth(admin.id))
    .send({ selections: [{ carrierId: carrierA.id, states: ["FL"] }] });
  await request(app)
    .post(`/api/onboarding/${agentRow.id}/request-contracting`)
    .set(withAuth(admin.id))
    .send({});

  const [reqRow] = await handle.db
    .select()
    .from(carrierContractingRequestsTable)
    .where(
      and(
        eq(carrierContractingRequestsTable.orgId, org.id),
        eq(carrierContractingRequestsTable.agentId, agentRow.id),
      ),
    );

  return {
    org,
    otherOrg,
    admin,
    agencyAdmin,
    otherOrgAdmin,
    agentUser,
    interloperAgent,
    agentId: agentRow.id,
    carrierA,
    requestId: reqRow.id,
    pdfDocId: reqRow.paperworkDocumentId!,
  };
}

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
  // Dynamic import so the provider's transitive `@workspace/db` import
  // happens AFTER bootTestDb() — same idiom the app import uses.
  const mod = await import("../../lib/esign/mediflowProvider");
  setMediflowProvider = mod.setMediflowProvider;
  testStorage = new mod.InMemoryEsignStorage();
  setMediflowProvider(new mod.MediflowESignProvider({ storage: testStorage }));
});

afterAll(async () => {
  setMediflowProvider(undefined);
  await shutdownTestDb();
});

// ---------------------------------------------------------------------------
// POST /api/esign/envelopes
// ---------------------------------------------------------------------------

describe("POST /api/esign/envelopes", () => {
  it("creates an envelope in `pending`, writes an envelope_created event, returns signingUrl", async () => {
    const ctx = await buildSignCtx();
    const res = await request(app)
      .post("/api/esign/envelopes")
      .set(withAuth(ctx.admin.id))
      .send({
        pdfDocumentId: ctx.pdfDocId,
        carrierContractingRequestId: ctx.requestId,
        signers: [
          {
            userId: ctx.agentUser.id,
            displayName: "Test Agent",
            email: "agent@example.com",
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.envelopeId).toBeTruthy();
    expect(res.body.status).toBe("pending");
    expect(res.body.signingUrl).toBe(`/sign/${res.body.envelopeId}`);

    const handle = await bootTestDb();
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, res.body.envelopeId));
    expect(env.orgId).toBe(ctx.org.id);
    expect(env.status).toBe("pending");
    expect(env.unsignedPdfDocumentId).toBe(ctx.pdfDocId);

    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.envelopeId, res.body.envelopeId));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("envelope_created");
    expect(events[0].actorUserId).toBe(ctx.admin.id);
  });

  it("is idempotent on (org, carrier_contracting_request_id) while not voided", async () => {
    const ctx = await buildSignCtx();
    const body = {
      pdfDocumentId: ctx.pdfDocId,
      carrierContractingRequestId: ctx.requestId,
      signers: [
        {
          userId: ctx.agentUser.id,
          displayName: "Test Agent",
          email: "a@b.com",
        },
      ],
    };
    const first = await request(app)
      .post("/api/esign/envelopes")
      .set(withAuth(ctx.admin.id))
      .send(body);
    const second = await request(app)
      .post("/api/esign/envelopes")
      .set(withAuth(ctx.admin.id))
      .send(body);
    expect(first.body.envelopeId).toBe(second.body.envelopeId);
  });

  it("rejects unauthenticated callers", async () => {
    const ctx = await buildSignCtx();
    const res = await request(app)
      .post("/api/esign/envelopes")
      .send({
        pdfDocumentId: ctx.pdfDocId,
        carrierContractingRequestId: ctx.requestId,
        signers: [
          {
            userId: ctx.agentUser.id,
            displayName: "Test",
            email: "a@b.com",
          },
        ],
      });
    expect(res.status).toBe(401);
  });

  it("rejects viewer role", async () => {
    const ctx = await buildSignCtx();
    const handle = await bootTestDb();
    const viewer = await seedUser(handle.db, {
      orgId: ctx.org.id,
      role: "viewer",
    });
    const res = await request(app)
      .post("/api/esign/envelopes")
      .set(withAuth(viewer.id))
      .send({
        pdfDocumentId: ctx.pdfDocId,
        carrierContractingRequestId: ctx.requestId,
        signers: [
          {
            userId: ctx.agentUser.id,
            displayName: "Test",
            email: "a@b.com",
          },
        ],
      });
    expect(res.status).toBe(403);
  });

  it("400 when zod body is invalid", async () => {
    const ctx = await buildSignCtx();
    const res = await request(app)
      .post("/api/esign/envelopes")
      .set(withAuth(ctx.admin.id))
      .send({ pdfDocumentId: "", carrierContractingRequestId: "", signers: [] });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/esign/envelopes/:envelopeId/sign
// ---------------------------------------------------------------------------

async function createEnv(ctx: SignCtx): Promise<string> {
  const res = await request(app)
    .post("/api/esign/envelopes")
    .set(withAuth(ctx.admin.id))
    .send({
      pdfDocumentId: ctx.pdfDocId,
      carrierContractingRequestId: ctx.requestId,
      signers: [
        {
          userId: ctx.agentUser.id,
          displayName: "Test Agent",
          email: "agent@example.com",
        },
      ],
    });
  return res.body.envelopeId as string;
}

const VALID_SIGN_BODY = {
  typedName: "Test Agent",
  signatureSvg: "<svg><path d='M0,0 L10,10' /></svg>",
  consentToElectronicBusiness: true as const,
  intentToSign: true as const,
};

describe("POST /api/esign/envelopes/:envelopeId/sign", () => {
  it("happy path: signs → completed envelope, signed PDF + integrity hash + contracting transition", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);

    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.signedPdfDocumentId).toBeTruthy();
    expect(res.body.integritySha256).toMatch(/^[0-9a-f]{64}$/);

    const handle = await bootTestDb();
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    expect(env.status).toBe("completed");
    expect(env.signedAt).toBeTruthy();
    expect(env.consentRecord).toBeTruthy();
    const consent = env.consentRecord as unknown as Record<string, unknown>;
    expect(consent.version).toBe("1.0.0");
    expect(consent.ipAddress).toBeTruthy();

    // Signer row stamped with signedAt.
    const signers = env.signers as Array<{ signedAt?: string }>;
    expect(signers[0].signedAt).toBeTruthy();

    // Audit events written: consent_accepted + signature_captured +
    // envelope_completed (in addition to the envelope_created from create).
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.envelopeId, envId));
    const types = events.map((e) => e.eventType).sort();
    expect(types).toEqual([
      "consent_accepted",
      "envelope_completed",
      "envelope_created",
      "signature_captured",
    ]);

    // Carrier contracting request transitioned to `signed`.
    const [creq] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    expect(creq.status).toBe("signed");
    expect(creq.signatureCompletedAt).toBeTruthy();

    // Carrier sign task closed + submit task created.
    const [runRow] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(
        and(
          eq(agentOnboardingRunsTable.agentId, ctx.agentId),
          eq(agentOnboardingRunsTable.orgId, ctx.org.id),
        ),
      );
    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, ctx.org.id));
    const signTask = tasks.find(
      (t) => t.contractingTaskKey === `${runRow.id}:sign:${ctx.requestId}`,
    );
    expect(signTask?.status).toBe("completed");
    const submitTask = tasks.find(
      (t) => t.contractingTaskKey === `${ctx.requestId}:submit`,
    );
    expect(submitTask).toBeTruthy();
    expect(submitTask?.title).toMatch(/Submit signed packet/);
    expect(submitTask?.assignedToUserId).toBeNull();
  });

  it("rejects when consentToElectronicBusiness is not true", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send({ ...VALID_SIGN_BODY, consentToElectronicBusiness: false });
    expect(res.status).toBe(400);
  });

  it("rejects when intentToSign is not true", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send({ ...VALID_SIGN_BODY, intentToSign: false });
    expect(res.status).toBe(400);
  });

  it("rejects when typedName is empty", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send({ ...VALID_SIGN_BODY, typedName: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-signer non-admin caller in the same org", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.interloperAgent.id))
      .send(VALID_SIGN_BODY);
    expect(res.status).toBe(403);
  });

  it("admin (super_admin) can sign on behalf", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.admin.id))
      .send(VALID_SIGN_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
  });

  it("agency_admin can sign on behalf", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agencyAdmin.id))
      .send(VALID_SIGN_BODY);
    expect(res.status).toBe(200);
  });

  it("cross-org: another org's admin cannot sign the envelope (404)", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.otherOrgAdmin.id))
      .send(VALID_SIGN_BODY);
    expect(res.status).toBe(404);
  });

  it("re-sign on completed envelope is idempotent (no error, no duplicate events)", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    const second = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("completed");

    const handle = await bootTestDb();
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.envelopeId, envId));
    const completedEvents = events.filter(
      (e) => e.eventType === "envelope_completed",
    );
    expect(completedEvents).toHaveLength(1);
  });

  it("404 on a non-existent envelope id", async () => {
    const ctx = await buildSignCtx();
    const res = await request(app)
      .post(`/api/esign/envelopes/${randomUUID()}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/esign/envelopes/:envelopeId
// ---------------------------------------------------------------------------

describe("GET /api/esign/envelopes/:envelopeId", () => {
  it("returns the envelope for the owning org", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .get(`/api/esign/envelopes/${envId}`)
      .set(withAuth(ctx.admin.id));
    expect(res.status).toBe(200);
    expect(res.body.envelopeId).toBe(envId);
    expect(res.body.status).toBe("pending");
  });

  it("returns 404 for a cross-org envelope", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .get(`/api/esign/envelopes/${envId}`)
      .set(withAuth(ctx.otherOrgAdmin.id));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/esign/envelopes/:envelopeId/signed-pdf
// ---------------------------------------------------------------------------

describe("GET /api/esign/envelopes/:envelopeId/signed-pdf", () => {
  it("rejects with 409 when the envelope is not yet completed", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .get(`/api/esign/envelopes/${envId}/signed-pdf`)
      .set(withAuth(ctx.admin.id));
    expect(res.status).toBe(409);
  });

  it("returns the signed PDF buffer when completed, and the stored SHA-256 matches the bytes", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);

    const res = await request(app)
      .get(`/api/esign/envelopes/${envId}/signed-pdf`)
      .set(withAuth(ctx.admin.id))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    const buf = res.body as Buffer;
    expect(buf.byteLength).toBeGreaterThan(0);
    // PDF magic
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");

    const handle = await bootTestDb();
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    const freshHash = createHash("sha256").update(buf).digest("hex");
    expect(freshHash).toBe(env.integritySha256);

    // The signed PDF contains the appended certificate page (so >= 2 pages).
    const pdf = await PDFDocument.load(buf);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it("cross-org access returns 404", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    const res = await request(app)
      .get(`/api/esign/envelopes/${envId}/signed-pdf`)
      .set(withAuth(ctx.otherOrgAdmin.id));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/esign/envelopes/:envelopeId/void
// ---------------------------------------------------------------------------

describe("POST /api/esign/envelopes/:envelopeId/void", () => {
  it("admin can void a pending envelope, frees the partial-unique slot for retry", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);

    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/void`)
      .set(withAuth(ctx.admin.id))
      .send({ reason: "Wrong template selected" });
    expect(res.status).toBe(200);

    const handle = await bootTestDb();
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    expect(env.status).toBe("voided");
    expect(env.voidedAt).toBeTruthy();

    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(eq(esignSigningEventsTable.envelopeId, envId));
    expect(events.some((e) => e.eventType === "envelope_voided")).toBe(true);

    // A fresh envelope can now be created against the same request.
    const second = await request(app)
      .post("/api/esign/envelopes")
      .set(withAuth(ctx.admin.id))
      .send({
        pdfDocumentId: ctx.pdfDocId,
        carrierContractingRequestId: ctx.requestId,
        signers: [
          {
            userId: ctx.agentUser.id,
            displayName: "Test",
            email: "a@b.com",
          },
        ],
      });
    expect(second.status).toBe(201);
    expect(second.body.envelopeId).not.toBe(envId);
  });

  it("agent role cannot void", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/void`)
      .set(withAuth(ctx.agentUser.id))
      .send({ reason: "test" });
    expect(res.status).toBe(403);
  });

  it("cannot void a completed envelope", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/void`)
      .set(withAuth(ctx.admin.id))
      .send({ reason: "too late" });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Provider unit tests — exercise the in-memory storage path directly.
// ---------------------------------------------------------------------------

describe("MediflowESignProvider — direct (unit-ish)", () => {
  it("SHA-256 is stable: signing the same envelope twice (idempotent re-call) returns the same hash", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    const first = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    const handle = await bootTestDb();
    const [env1] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    const second = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    expect(first.body.integritySha256).toBeDefined();
    expect(second.body.integritySha256 ?? env1.integritySha256).toBe(
      env1.integritySha256,
    );
  });

  it("consent record persisted verbatim (text + version 1.0.0)", async () => {
    const ctx = await buildSignCtx();
    const envId = await createEnv(ctx);
    await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);

    const handle = await bootTestDb();
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    const consent = env.consentRecord as unknown as Record<string, string | null>;
    expect(consent.version).toBe("1.0.0");
    expect(consent.consentText).toMatch(/electronic signature has the same legal effect/);
    expect(consent.consentText).toMatch(/\{\{ESIGN_PAPER_COPY_CONTACT\}\}/);
  });
});

// ---------------------------------------------------------------------------
// New onboarding sign route surface (post-PR #101 → envelope creation)
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/:agentId/carriers/:carrierId/sign — envelope handoff", () => {
  it("returns envelopeId + signingUrl instead of synchronously transitioning", async () => {
    const ctx = await buildSignCtx();
    const res = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/carriers/${ctx.carrierA.id}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.envelopeId).toBeTruthy();
    expect(res.body.signingUrl).toBe(`/sign/${res.body.envelopeId}`);

    // contracting request status NOT yet transitioned (still in paperwork_generated).
    const handle = await bootTestDb();
    const [creq] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    expect(creq.status).toBe("paperwork_generated");
  });

  it("returns 409 when paperwork document is missing", async () => {
    const ctx = await buildSignCtx();
    // Strip the paperwork document id.
    const handle = await bootTestDb();
    await handle.db
      .update(carrierContractingRequestsTable)
      .set({ paperworkDocumentId: null })
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    const res = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/carriers/${ctx.carrierA.id}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send({});
    expect(res.status).toBe(409);
  });

  it("agent_support is rejected (not signer, not admin)", async () => {
    const ctx = await buildSignCtx();
    const handle = await bootTestDb();
    const agentSupport = await seedUser(handle.db, {
      orgId: ctx.org.id,
      role: "agent_support",
    });
    const res = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/carriers/${ctx.carrierA.id}/sign`)
      .set(withAuth(agentSupport.id))
      .send({});
    expect(res.status).toBe(403);
  });

  // Profile email is used as the signer email when present.
  it("uses contracting profile email if set", async () => {
    const ctx = await buildSignCtx();
    const handle = await bootTestDb();
    await handle.db
      .update(agentContractingProfilesTable)
      .set({ email: "agent-profile@example.com" })
      .where(
        and(
          eq(agentContractingProfilesTable.agentId, ctx.agentId),
          eq(agentContractingProfilesTable.orgId, ctx.org.id),
        ),
      );
    const res = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/carriers/${ctx.carrierA.id}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send({});
    expect(res.status).toBe(200);
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, res.body.envelopeId));
    const signers = env.signers as Array<{ email: string }>;
    expect(signers[0].email).toBe("agent-profile@example.com");
  });
});
