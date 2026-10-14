/**
 * Certificate-of-completion email — integration tests.
 *
 * Surface under test:
 *   - `sendCertificateOfCompletion` (lib/esign/completionEmail.ts)
 *   - the fire-and-forget hook wired into
 *     `MediflowESignProvider.recordSignature` that calls it after the
 *     envelope completes + carrier-contracting transition fires.
 *
 * Resend is mocked at the `lib/email.ts` boundary so no real HTTP fires.
 * The mock captures every send and a per-test ref-object controls the
 * mocked result (success vs failure).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { dbF, authF, jobsF, emailF, emailCalls, emailResultRef } = vi.hoisted(() => {
  const calls: Array<{ opts: any }> = [];
  const resultRef: { value: { success: true; id: string } | { success: false; error: string } } = {
    value: { success: true, id: "resend-fake-id" },
  };
  return {
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
    emailF: async (): Promise<Record<string, unknown>> => {
      const actual = await import("../../lib/email");
      return {
        ...actual,
        sendEmail: async (opts: unknown): Promise<unknown> => {
          calls.push({ opts });
          return resultRef.value;
        },
        isEmailConfigured: (): boolean => true,
      };
    },
    emailCalls: calls,
    emailResultRef: resultRef,
  };
});
vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/email", emailF);

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agentsTable,
  carriersTable,
  carrierContractingRequestsTable,
  esignEnvelopesTable,
  esignSigningEventsTable,
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
let getProvider: () => import("../../lib/esign/mediflowProvider").MediflowESignProvider;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

const VALID_SIGN_BODY = {
  typedName: "Test Agent",
  signatureSvg: "<svg><path d='M0,0 L10,10' /></svg>",
  consentToElectronicBusiness: true as const,
  intentToSign: true as const,
};

interface SignCtx {
  org: { id: string };
  admin: { id: string };
  agentUser: { id: string };
  agentId: string;
  carrierA: { id: string; name: string };
  requestId: string;
  pdfDocId: string;
}

async function buildCtx(): Promise<SignCtx> {
  const handle = await bootTestDb();
  const org = await seedOrg(handle.db, { id: nextId("ce-org") });
  const admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "super_admin",
  });
  const agentUser = await seedUser(handle.db, {
    orgId: org.id,
    role: "agent",
  });
  const agentRow = await seedAgent(handle.db, { orgId: org.id });
  await handle.db
    .update(agentsTable)
    .set({
      userId: agentUser.id,
      email: "agent@example.com",
    })
    .where(eq(agentsTable.id, agentRow.id));

  const carrierA = { id: nextId("ce-carrier"), name: "Acme Health" };
  await handle.db.insert(carriersTable).values({
    id: carrierA.id,
    orgId: org.id,
    name: carrierA.name,
  });

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
    admin,
    agentUser,
    agentId: agentRow.id,
    carrierA,
    requestId: reqRow.id,
    pdfDocId: reqRow.paperworkDocumentId!,
  };
}

async function createEnvWithSigners(
  ctx: SignCtx,
  signers: Array<{ userId: string; displayName: string; email: string }>,
): Promise<string> {
  const res = await request(app)
    .post("/api/esign/envelopes")
    .set(withAuth(ctx.admin.id))
    .send({
      pdfDocumentId: ctx.pdfDocId,
      carrierContractingRequestId: ctx.requestId,
      signers,
    });
  return res.body.envelopeId as string;
}

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
  const mod = await import("../../lib/esign/mediflowProvider");
  setMediflowProvider = mod.setMediflowProvider;
  getProvider = mod.getMediflowProvider;
  testStorage = new mod.InMemoryEsignStorage();
  setMediflowProvider(new mod.MediflowESignProvider({ storage: testStorage }));
});

afterAll(async () => {
  setMediflowProvider(undefined);
  await shutdownTestDb();
});

beforeEach(() => {
  emailCalls.length = 0;
  emailResultRef.value = { success: true, id: "resend-fake-id" };
});

describe("certificate-of-completion email — happy path", () => {
  it("sends one email per signer with the PDF attached + integrity hash + writes one audit event each", async () => {
    const ctx = await buildCtx();
    const envId = await createEnvWithSigners(ctx, [
      {
        userId: ctx.agentUser.id,
        displayName: "Test Agent",
        email: "agent@example.com",
      },
    ]);

    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");

    // Await the fire-and-forget hook deterministically.
    await getProvider().lastCompletionEmailPromise;

    expect(emailCalls).toHaveLength(1);
    const opts = emailCalls[0].opts;
    expect(opts.to.email).toBe("agent@example.com");
    expect(opts.subject).toMatch(/^Signed:/);
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments[0].filename).toBe(`signed-${envId}.pdf`);
    expect(opts.attachments[0].contentType).toBe("application/pdf");
    expect(Buffer.isBuffer(opts.attachments[0].content)).toBe(true);
    expect(opts.attachments[0].content.subarray(0, 4).toString()).toBe("%PDF");
    // Integrity hash present in both HTML and text bodies.
    expect(opts.html).toContain(res.body.integritySha256);
    expect(opts.text).toContain(res.body.integritySha256);

    // One certificate_of_completion_emailed audit event per signer.
    const handle = await bootTestDb();
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(
        and(
          eq(esignSigningEventsTable.envelopeId, envId),
          eq(
            esignSigningEventsTable.eventType,
            "certificate_of_completion_emailed",
          ),
        ),
      );
    expect(events).toHaveLength(1);
    const evData = events[0].eventData as Record<string, unknown>;
    expect(evData.email).toBe("agent@example.com");
    expect(evData.success).toBe(true);
    expect(evData.signerUserId).toBe(ctx.agentUser.id);
  });
});

describe("certificate-of-completion email — send failure", () => {
  it("signing flow still completes when Resend rejects; audit event records the failure", async () => {
    emailResultRef.value = { success: false, error: "Resend rate-limited" };
    const ctx = await buildCtx();
    const envId = await createEnvWithSigners(ctx, [
      {
        userId: ctx.agentUser.id,
        displayName: "Test Agent",
        email: "agent@example.com",
      },
    ]);

    const res = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    // Signing succeeds despite the email failure.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");

    await getProvider().lastCompletionEmailPromise;

    // Envelope is durably completed + carrier-contracting transition fired.
    const handle = await bootTestDb();
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    expect(env.status).toBe("completed");
    const [creq] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    expect(creq.status).toBe("signed");

    // Audit row captures the failure.
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(
        and(
          eq(esignSigningEventsTable.envelopeId, envId),
          eq(
            esignSigningEventsTable.eventType,
            "certificate_of_completion_emailed",
          ),
        ),
      );
    expect(events).toHaveLength(1);
    const evData = events[0].eventData as Record<string, unknown>;
    expect(evData.success).toBe(false);
    expect(evData.error).toBe("Resend rate-limited");
  });
});

describe("certificate-of-completion email — empty email", () => {
  it("skips signers without an email and writes no event row for them", async () => {
    const ctx = await buildCtx();
    // Provider-level direct invocation: the HTTP route's zod body schema
    // requires a non-empty email, so we exercise the helper directly by
    // creating a degenerate envelope with a blank-email signer.
    const handle = await bootTestDb();
    const envId = nextId("env-empty");
    await handle.db.insert(esignEnvelopesTable).values({
      id: envId,
      orgId: ctx.org.id,
      carrierContractingRequestId: ctx.requestId,
      unsignedPdfDocumentId: ctx.pdfDocId,
      signers: [
        { userId: ctx.agentUser.id, displayName: "No Email Signer", email: "" },
      ],
      status: "completed",
      integritySha256: "deadbeef".repeat(8),
    });

    const { sendCertificateOfCompletion } = await import(
      "../../lib/esign/completionEmail"
    );
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    const result = await sendCertificateOfCompletion(
      env,
      Buffer.from("%PDF-fake"),
      "deadbeef".repeat(8),
      { documentName: "Doc" },
    );

    expect(result.attempts).toBe(0);
    expect(result.sent).toBe(0);
    expect(emailCalls).toHaveLength(0);

    // No event row written for the empty-email signer.
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(
        and(
          eq(esignSigningEventsTable.envelopeId, envId),
          eq(
            esignSigningEventsTable.eventType,
            "certificate_of_completion_emailed",
          ),
        ),
      );
    expect(events).toHaveLength(0);
  });
});

describe("certificate-of-completion email — idempotency", () => {
  it("re-completing an envelope does NOT re-send the certificate email", async () => {
    const ctx = await buildCtx();
    const envId = await createEnvWithSigners(ctx, [
      {
        userId: ctx.agentUser.id,
        displayName: "Test Agent",
        email: "agent@example.com",
      },
    ]);

    // First sign — sends one email.
    await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    await getProvider().lastCompletionEmailPromise;
    expect(emailCalls).toHaveLength(1);

    // Second sign — hits the `completed` short-circuit; must NOT re-send.
    emailCalls.length = 0;
    const second = await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    expect(second.status).toBe(200);
    // Await any in-flight promise (the short-circuit does not set one, but
    // be safe in case a previous test left one stale).
    await getProvider().lastCompletionEmailPromise;
    expect(emailCalls).toHaveLength(0);

    // Still exactly one certificate_of_completion_emailed event.
    const handle = await bootTestDb();
    const events = await handle.db
      .select()
      .from(esignSigningEventsTable)
      .where(
        and(
          eq(esignSigningEventsTable.envelopeId, envId),
          eq(
            esignSigningEventsTable.eventType,
            "certificate_of_completion_emailed",
          ),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("calling the helper twice for the same envelope short-circuits the second call (defense in depth)", async () => {
    const ctx = await buildCtx();
    const envId = await createEnvWithSigners(ctx, [
      {
        userId: ctx.agentUser.id,
        displayName: "Test Agent",
        email: "agent@example.com",
      },
    ]);
    await request(app)
      .post(`/api/esign/envelopes/${envId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send(VALID_SIGN_BODY);
    await getProvider().lastCompletionEmailPromise;
    expect(emailCalls).toHaveLength(1);

    emailCalls.length = 0;
    const handle = await bootTestDb();
    const [env] = await handle.db
      .select()
      .from(esignEnvelopesTable)
      .where(eq(esignEnvelopesTable.id, envId));
    const { sendCertificateOfCompletion } = await import(
      "../../lib/esign/completionEmail"
    );
    const result = await sendCertificateOfCompletion(
      env,
      Buffer.from("%PDF-fake"),
      env.integritySha256!,
      { documentName: "Doc" },
    );
    expect(result.attempts).toBe(0);
    expect(emailCalls).toHaveLength(0);
  });
});
