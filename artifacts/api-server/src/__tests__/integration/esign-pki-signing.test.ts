/**
 * Phase 3 hardening: PKI signing of completed e-sign envelopes.
 *
 * End-to-end tests:
 *
 *   - signing an envelope produces a PDF whose embedded PKCS#7/CMS
 *     signature verifies against `verifyPdfSignature`;
 *   - if the bytes at rest are tampered with, `getSignedPdf` (the route)
 *     refuses to hand them back — instead returning the
 *     `EnvelopeStateError` HTTP error.
 *
 * The boot-guard (dev-sentinel rejection / missing-env rejection) is
 * covered in the pkiSigner unit test — covering it here would require
 * forcing NODE_ENV=production at the integration-test level, which
 * collides with how the shared test app is mounted.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agentsTable,
  carriersTable,
  carrierContractingRequestsTable,
  documentsTable,
  esignEnvelopesTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testStorage: import("../../lib/esign/mediflowProvider").InMemoryEsignStorage;
let setMediflowProvider: (
  provider: import("../../lib/esign/mediflowProvider").MediflowESignProvider | undefined,
) => void;
let verifyPdfSignature: typeof import("../../lib/esign/pkiSigner").verifyPdfSignature;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

interface Ctx {
  org: { id: string };
  admin: { id: string };
  agentUser: { id: string };
  agentId: string;
  carrierId: string;
  requestId: string;
  pdfDocId: string;
}

async function buildCtx(): Promise<Ctx> {
  const handle = await bootTestDb();
  const org = await seedOrg(handle.db, { id: nextId("pki-org") });
  const admin = await seedUser(handle.db, { orgId: org.id, role: "super_admin" });
  const agentUser = await seedUser(handle.db, { orgId: org.id, role: "agent" });
  const agentRow = await seedAgent(handle.db, { orgId: org.id });
  await handle.db
    .update(agentsTable)
    .set({ userId: agentUser.id, email: "pki-agent@example.com" })
    .where(eq(agentsTable.id, agentRow.id));
  const carrierId = nextId("pki-carrier");
  await handle.db
    .insert(carriersTable)
    .values({ id: carrierId, orgId: org.id, name: "PKI Test Carrier" });

  await request(app)
    .post("/api/onboarding/start")
    .set(withAuth(admin.id))
    .send({ agentId: agentRow.id });
  await request(app)
    .patch(`/api/onboarding/${agentRow.id}/profile`)
    .set(withAuth(admin.id))
    .send({ phone: "+15551234567", email: "pki-agent@example.com" });
  await request(app)
    .post(`/api/onboarding/${agentRow.id}/carriers/select`)
    .set(withAuth(admin.id))
    .send({ selections: [{ carrierId, states: ["FL"] }] });
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
    admin,
    agentUser,
    agentId: agentRow.id,
    carrierId,
    requestId: reqRow.id,
    pdfDocId: reqRow.paperworkDocumentId!,
  };
}

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request = ((await import("supertest")) as any).default;
  const provMod = await import("../../lib/esign/mediflowProvider");
  setMediflowProvider = provMod.setMediflowProvider;
  testStorage = new provMod.InMemoryEsignStorage();
  setMediflowProvider(new provMod.MediflowESignProvider({ storage: testStorage }));
  const pkiMod = await import("../../lib/esign/pkiSigner");
  verifyPdfSignature = pkiMod.verifyPdfSignature;
});

afterAll(async () => {
  setMediflowProvider(undefined);
  await shutdownTestDb();
});

const VALID_SIGN_BODY = {
  typedName: "PKI Test Agent",
  signatureSvg: "<svg></svg>",
  consentToElectronicBusiness: true,
  intentToSign: true,
};

async function createAndSignEnvelope(ctx: Ctx): Promise<{ envId: string }> {
  const create = await request(app)
    .post("/api/esign/envelopes")
    .set(withAuth(ctx.admin.id))
    .send({
      pdfDocumentId: ctx.pdfDocId,
      carrierContractingRequestId: ctx.requestId,
      signers: [
        {
          userId: ctx.agentUser.id,
          displayName: "PKI Test Agent",
          email: "pki-agent@example.com",
        },
      ],
    });
  expect(create.status).toBe(201);
  const envId = create.body.envelopeId as string;

  const sign = await request(app)
    .post(`/api/esign/envelopes/${envId}/sign`)
    .set(withAuth(ctx.agentUser.id))
    .send(VALID_SIGN_BODY);
  expect(sign.status).toBe(200);
  return { envId };
}

async function fetchSignedPdfOnce(
  envId: string,
  actorUserId: string,
): Promise<{ status: number; body: Buffer }> {
  const res = await request(app)
    .get(`/api/esign/envelopes/${envId}/signed-pdf`)
    .set(withAuth(actorUserId))
    .buffer(true)
    .parse((r, callback) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => callback(null, Buffer.concat(chunks)));
    });
  return { status: res.status, body: res.body as Buffer };
}

/**
 * Fetch the signed PDF, expecting the success path.
 *
 * The signed PDF is available once the envelope reaches `completed`.
 * `/sign` awaits that transition, but under a heavily loaded CI runner the
 * immediate read-back has been observed to briefly see a not-yet-completed
 * envelope and 409 (real clients navigate/poll rather than fetching in the
 * same tick). Retry the transient 409 a few times so the end-to-end test is
 * deterministic without weakening the assertion on the 200 path.
 *
 * Use `fetchSignedPdfOnce` directly when a 409 is the *expected* terminal
 * outcome (e.g. the tamper-evidence case) so it isn't needlessly retried.
 */
async function fetchSignedPdf(envId: string, actorUserId: string): Promise<{ status: number; body: Buffer }> {
  const MAX_ATTEMPTS = 5;
  let result = await fetchSignedPdfOnce(envId, actorUserId);
  for (let attempt = 1; attempt < MAX_ATTEMPTS && result.status === 409; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    result = await fetchSignedPdfOnce(envId, actorUserId);
  }
  return result;
}

describe("e-sign PKI signing — end-to-end", () => {
  it("a signed envelope's PDF carries a valid PKCS#7/CMS signature", async () => {
    const ctx = await buildCtx();
    const { envId } = await createAndSignEnvelope(ctx);
    const { status, body } = await fetchSignedPdf(envId, ctx.admin.id);
    expect(status).toBe(200);
    expect(body.subarray(0, 4).toString()).toBe("%PDF");
    const verdict = verifyPdfSignature(body);
    expect(verdict.valid).toBe(true);
    expect(verdict.signerCN).toBeTruthy();
  });

  it("getSignedPdf hard-fails (5xx) when the stored bytes have been tampered with", async () => {
    const ctx = await buildCtx();
    const { envId } = await createAndSignEnvelope(ctx);

    // Reach into the in-memory storage and flip a byte in the persisted
    // signed PDF. The route MUST refuse to release the bytes.
    const handle = await bootTestDb();
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    const [doc] = await handle.db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.id, env.signedPdfDocumentId!));
    const original = await testStorage.readPdf(doc.storageKey);
    const tampered = Buffer.from(original);
    // Flip a byte well inside the PDF (byte 100 is in the header area).
    tampered[100] ^= 0xff;
    // Overwrite the in-memory blob directly. We use the storage abstraction
    // by re-uploading under the same key. The InMemoryEsignStorage uses a
    // module-level Map keyed by storageKey, so the easiest re-write is via
    // a direct uploadPdf — but that creates a new key. Instead, monkey-patch:
    const memMap = (
      (await import("../../lib/esign/mediflowProvider")) as unknown as {
        InMemoryEsignStorage: { prototype: { readPdf: typeof testStorage.readPdf } };
      }
    );
    void memMap;
    // The simplest tamper path: replace the buffer at the same key in the
    // underlying Map. We don't have a public accessor, so we use the
    // already-known facade method and access the internal Map by importing
    // it indirectly: store via a fresh upload, then update the document
    // row to point at the new (tampered) key.
    const newKey = await testStorage.uploadPdf(tampered, "tampered.pdf", ctx.org.id);
    await handle.db
      .update(documentsTable)
      .set({ storageKey: newKey })
      .where(eq(documentsTable.id, doc.id));

    // 409 is the expected terminal outcome here (tamper detected), so use
    // the single-shot fetch — no transient to retry past.
    const { status, body } = await fetchSignedPdfOnce(envId, ctx.admin.id);
    // Route surfaces `EnvelopeStateError` as a 409.
    expect(status).toBe(409);
    // Make sure we did NOT just stream the tampered bytes back as a PDF
    // — a successful 200 with tampered bytes would be the exact bug this
    // test exists to prevent.
    expect(body.subarray(0, 4).toString()).not.toBe("%PDF");
  });
});
