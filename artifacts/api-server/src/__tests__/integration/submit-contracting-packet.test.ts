/**
 * Day-6 contracting email-out worker — integration tests.
 *
 * Surface under test:
 *   - `submitContractingPacketWorker` (workers/submitContractingPacket.ts)
 *   - direct-enqueue plumbing in `lib/esign/carrierSignCallback.ts`
 *   - the e-sign sign route ENQUEUES the worker (verified via the
 *     `getEnqueuedJobs()` capture in the test harness)
 *
 * Resend is mocked at the `lib/email.ts` boundary so no real HTTP fires.
 * We swap a fake `sendEmail` in via vi.mock so the worker still calls it
 * with the full opts (subject, attachments, CC) and the test asserts on
 * the captured arguments.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// Capture every sendEmail call. Hoisted so the vi.mock below sees it.
const { dbF, clerkF, jobsF, emailF, emailCalls, emailResultRef } = vi.hoisted(() => {
  // Use plain arrays + a ref-object so the test bodies can mutate them and
  // the hoisted vi.mock factory still reads the latest values.
  const calls: Array<{ opts: unknown }> = [];
  const resultRef: { value: { success: true; id: string } | { success: false; error: string } } = {
    value: { success: true, id: "resend-fake-id" },
  };
  return {
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
    emailF: async (): Promise<Record<string, unknown>> => {
      // Pull the real module so the HTML template helpers (`welcomeEmailHtml`
      // etc.) are still available to any caller that imports them — only
      // `sendEmail` is overridden.
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
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/email", emailF);

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agentsTable,
  agentOnboardingRunsTable,
  auditLogTable,
  carriersTable,
  carrierContractingRequestsTable,
  esignEnvelopesTable,
  taskInstancesTable,
} from "@workspace/db/schema";

import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  getEnqueuedJobs,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let setMediflowProvider: (
  provider:
    | import("../../lib/esign/mediflowProvider").MediflowESignProvider
    | undefined,
) => void;

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

interface WorkerCtx {
  org: { id: string };
  otherOrg: { id: string };
  admin: { id: string };
  agentUser: { id: string };
  agentId: string;
  carrier: { id: string; name: string };
  requestId: string;
  envelopeId: string;
  runId: string;
}

/** Drive an agent through onboarding → request-contracting → sign so the
 * carrier_contracting_request lands in `signed` with a completed envelope.
 * The submit task gets created by the e-sign callback. */
async function driveToSigned(opts: {
  appointmentDeskEmail: string | null;
  appointmentDeskMetadata?: Record<string, unknown>;
}): Promise<WorkerCtx> {
  const handle = await bootTestDb();
  const org = await seedOrg(handle.db, { id: nextId("submit-org") });
  const otherOrg = await seedOrg(handle.db, { id: nextId("submit-other") });
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
    .set({ userId: agentUser.id, email: "agent@example.com", npn: "12345678" })
    .where(eq(agentsTable.id, agentRow.id));

  const carrierId = nextId("carrier");
  const carrier = { id: carrierId, name: "Acme Health" };
  await handle.db.insert(carriersTable).values({
    id: carrierId,
    orgId: org.id,
    name: carrier.name,
    appointmentDeskEmail: opts.appointmentDeskEmail,
    appointmentDeskMetadata: opts.appointmentDeskMetadata ?? {},
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
    .send({ selections: [{ carrierId, states: ["FL", "GA"] }] });
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

  // Create envelope + sign it → carrier request lands in `signed`.
  const createRes = await request(app)
    .post("/api/esign/envelopes")
    .set(withAuth(admin.id))
    .send({
      pdfDocumentId: reqRow.paperworkDocumentId,
      carrierContractingRequestId: reqRow.id,
      signers: [
        {
          userId: agentUser.id,
          displayName: "Test Agent",
          email: "agent@example.com",
        },
      ],
    });
  const envelopeId = createRes.body.envelopeId as string;
  await request(app)
    .post(`/api/esign/envelopes/${envelopeId}/sign`)
    .set(withAuth(agentUser.id))
    .send(VALID_SIGN_BODY);

  // Drain the certificate-of-completion fire-and-forget email side-effect
  // before returning so its emailCall doesn't pollute the worker tests that
  // count emailCalls. The worker itself fires a separate appointment-desk
  // email — that's what these tests are asserting on.
  const provider = (
    await import("../../lib/esign/mediflowProvider")
  ).getMediflowProvider();
  await provider.lastCompletionEmailPromise;
  emailCalls.length = 0;

  const [runRow] = await handle.db
    .select()
    .from(agentOnboardingRunsTable)
    .where(
      and(
        eq(agentOnboardingRunsTable.agentId, agentRow.id),
        eq(agentOnboardingRunsTable.orgId, org.id),
      ),
    );

  return {
    org,
    otherOrg,
    admin,
    agentUser,
    agentId: agentRow.id,
    carrier,
    requestId: reqRow.id,
    envelopeId,
    runId: runRow.id,
  };
}

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
  // Wire the in-memory e-sign storage so signing produces a real PDF the
  // worker can fetch via getSignedPdf().
  const mod = await import("../../lib/esign/mediflowProvider");
  setMediflowProvider = mod.setMediflowProvider;
  setMediflowProvider(
    new mod.MediflowESignProvider({ storage: new mod.InMemoryEsignStorage() }),
  );
});

afterAll(async () => {
  setMediflowProvider(undefined);
  await shutdownTestDb();
});

beforeEach(() => {
  emailCalls.length = 0;
  emailResultRef.value = { success: true, id: "resend-fake-id" };
  clearEnqueuedJobs();
});

// ---------------------------------------------------------------------------
// Direct-enqueue from the e-sign sign route
// ---------------------------------------------------------------------------

describe("e-sign sign → direct-enqueues submit-contracting-packet", () => {
  it("enqueues SUBMIT_CONTRACTING_PACKET with the request id + org id + a singletonKey", async () => {
    const ctx = await driveToSigned({
      appointmentDeskEmail: "appointments@acme.example",
    });

    const enqueued = getEnqueuedJobs().filter(
      (j) => j.name === "submit-contracting-packet",
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].data).toEqual({
      carrierContractingRequestId: ctx.requestId,
      orgId: ctx.org.id,
    });
  });
});

// ---------------------------------------------------------------------------
// Worker happy path
// ---------------------------------------------------------------------------

describe("submitContractingPacketWorker — happy path", () => {
  it("sends the email, advances the request to submitted, closes the submit task, advances the run", async () => {
    const ctx = await driveToSigned({
      appointmentDeskEmail: "appointments@acme.example",
      appointmentDeskMetadata: { cc: ["ops@acme.example"] },
    });
    const { submitContractingPacketWorker } = await import(
      "../../workers/submitContractingPacket"
    );

    await submitContractingPacketWorker({
      carrierContractingRequestId: ctx.requestId,
      orgId: ctx.org.id,
    });

    // 1. Email sent with the right shape.
    expect(emailCalls).toHaveLength(1);
    const opts = emailCalls[0].opts as {
      to: { email: string };
      cc?: Array<{ email: string }>;
      subject: string;
      attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
      html: string;
      text?: string;
    };
    expect(opts.to.email).toBe("appointments@acme.example");
    expect(opts.cc).toEqual([{ email: "ops@acme.example" }]);
    expect(opts.subject).toMatch(/contracting submission/i);
    expect(opts.subject).toMatch(/Acme Health/);
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments?.[0].contentType).toBe("application/pdf");
    expect(opts.attachments?.[0].content.byteLength).toBeGreaterThan(0);
    expect(opts.attachments?.[0].content.subarray(0, 4).toString()).toBe("%PDF");
    // Cover-letter mentions NPN + states.
    expect(opts.html).toMatch(/12345678/);
    expect(opts.html).toMatch(/FL/);
    expect(opts.text).toMatch(/FL/);

    // 2. Request transitioned to `submitted`.
    const handle = await bootTestDb();
    const [req] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    expect(req.status).toBe("submitted");
    expect(req.submittedAt).toBeTruthy();

    // 3. Submit task closed.
    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, ctx.org.id));
    const submitTask = tasks.find(
      (t) => t.contractingTaskKey === `${ctx.requestId}:submit`,
    );
    expect(submitTask?.status).toBe("completed");

    // 4. Single-carrier run → all requests `submitted` → run advances
    //    from `signing` to `submitted`.
    const [run] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.id, ctx.runId));
    expect(run.status).toBe("submitted");

    // 5. Audit-log row written by the worker (resourceType = carrier_contracting).
    const audits = await handle.db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, ctx.org.id),
          eq(auditLogTable.resourceType, "carrier_contracting"),
          eq(auditLogTable.resourceId, ctx.requestId),
        ),
      );
    const workerAudit = audits.find(
      (a) =>
        a.userRole === "system" &&
        (a.changes as Record<string, unknown> | null)?.worker ===
          "submitContractingPacket",
    );
    expect(workerAudit).toBeTruthy();
  });

  it("uses CONTRACTING_EMAIL_FROM env when set, falling back to EMAIL_FROM_ADDRESS", async () => {
    const ctx = await driveToSigned({
      appointmentDeskEmail: "appointments@acme.example",
    });
    const prevFrom = process.env.CONTRACTING_EMAIL_FROM;
    process.env.CONTRACTING_EMAIL_FROM = "contracting@mediflow.test";
    try {
      const { submitContractingPacketWorker } = await import(
        "../../workers/submitContractingPacket"
      );
      await submitContractingPacketWorker({
        carrierContractingRequestId: ctx.requestId,
        orgId: ctx.org.id,
      });
      const opts = emailCalls[0].opts as { from?: string };
      expect(opts.from).toBe("contracting@mediflow.test");
    } finally {
      if (prevFrom === undefined) delete process.env.CONTRACTING_EMAIL_FROM;
      else process.env.CONTRACTING_EMAIL_FROM = prevFrom;
    }
  });

  it("uses metadata.subject as the subject line when provided", async () => {
    const ctx = await driveToSigned({
      appointmentDeskEmail: "appointments@acme.example",
      appointmentDeskMetadata: { subject: "Acme: New writing-number request" },
    });
    const { submitContractingPacketWorker } = await import(
      "../../workers/submitContractingPacket"
    );
    await submitContractingPacketWorker({
      carrierContractingRequestId: ctx.requestId,
      orgId: ctx.org.id,
    });
    const opts = emailCalls[0].opts as { subject: string };
    expect(opts.subject).toBe("Acme: New writing-number request");
  });
});

// ---------------------------------------------------------------------------
// Worker: appointment_desk_email IS NULL
// ---------------------------------------------------------------------------

describe("submitContractingPacketWorker — appointment desk not yet configured", () => {
  it("does NOT send an email, leaves status unchanged, leaves the submit task open, does NOT throw", async () => {
    const ctx = await driveToSigned({ appointmentDeskEmail: null });
    const { submitContractingPacketWorker } = await import(
      "../../workers/submitContractingPacket"
    );

    await expect(
      submitContractingPacketWorker({
        carrierContractingRequestId: ctx.requestId,
        orgId: ctx.org.id,
      }),
    ).resolves.toBeUndefined();

    expect(emailCalls).toHaveLength(0);

    const handle = await bootTestDb();
    const [req] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    // Still `signed` — we did NOT advance.
    expect(req.status).toBe("signed");

    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, ctx.org.id));
    const submitTask = tasks.find(
      (t) => t.contractingTaskKey === `${ctx.requestId}:submit`,
    );
    expect(submitTask?.status).toBe("open");
  });

  it("treats a syntactically invalid email the same as null (WARN + leave open)", async () => {
    const ctx = await driveToSigned({
      appointmentDeskEmail: "not-an-email",
    });
    const { submitContractingPacketWorker } = await import(
      "../../workers/submitContractingPacket"
    );
    await submitContractingPacketWorker({
      carrierContractingRequestId: ctx.requestId,
      orgId: ctx.org.id,
    });
    expect(emailCalls).toHaveLength(0);
    const handle = await bootTestDb();
    const [req] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    expect(req.status).toBe("signed");
  });
});

// ---------------------------------------------------------------------------
// Worker: idempotency
// ---------------------------------------------------------------------------

describe("submitContractingPacketWorker — idempotency", () => {
  it("a second run after submitted is a no-op (no extra email, no status flip)", async () => {
    const ctx = await driveToSigned({
      appointmentDeskEmail: "appointments@acme.example",
    });
    const { submitContractingPacketWorker } = await import(
      "../../workers/submitContractingPacket"
    );

    await submitContractingPacketWorker({
      carrierContractingRequestId: ctx.requestId,
      orgId: ctx.org.id,
    });
    expect(emailCalls).toHaveLength(1);

    await submitContractingPacketWorker({
      carrierContractingRequestId: ctx.requestId,
      orgId: ctx.org.id,
    });
    expect(emailCalls).toHaveLength(1); // no new send

    const handle = await bootTestDb();
    const [req] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    expect(req.status).toBe("submitted");
  });
});

// ---------------------------------------------------------------------------
// Worker: Resend failure
// ---------------------------------------------------------------------------

describe("submitContractingPacketWorker — Resend failure", () => {
  it("throws so pg-boss retries kick in (and does NOT advance the request status)", async () => {
    const ctx = await driveToSigned({
      appointmentDeskEmail: "appointments@acme.example",
    });
    emailResultRef.value = { success: false, error: "HTTP 503" };

    const { submitContractingPacketWorker } = await import(
      "../../workers/submitContractingPacket"
    );

    await expect(
      submitContractingPacketWorker({
        carrierContractingRequestId: ctx.requestId,
        orgId: ctx.org.id,
      }),
    ).rejects.toThrow(/Email send to appointment desk failed/);

    const handle = await bootTestDb();
    const [req] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    // Status NOT advanced — a retry will try again.
    expect(req.status).toBe("signed");

    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, ctx.org.id));
    const submitTask = tasks.find(
      (t) => t.contractingTaskKey === `${ctx.requestId}:submit`,
    );
    expect(submitTask?.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Worker: cross-org safety
// ---------------------------------------------------------------------------

describe("submitContractingPacketWorker — cross-org safety", () => {
  it("rejects a request id passed with the wrong orgId (no email, no state change)", async () => {
    const ctx = await driveToSigned({
      appointmentDeskEmail: "appointments@acme.example",
    });
    const { submitContractingPacketWorker } = await import(
      "../../workers/submitContractingPacket"
    );

    // Run the worker with the OTHER org's id but the same request id.
    await submitContractingPacketWorker({
      carrierContractingRequestId: ctx.requestId,
      orgId: ctx.otherOrg.id,
    });

    expect(emailCalls).toHaveLength(0);
    const handle = await bootTestDb();
    const [req] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestId));
    expect(req.status).toBe("signed");
  });
});

// ---------------------------------------------------------------------------
// jobs.ts registration — sanity check
// ---------------------------------------------------------------------------

describe("JOB_NAMES.SUBMIT_CONTRACTING_PACKET", () => {
  it("is registered and is the constant the carrierSignCallback enqueues", async () => {
    const { JOB_NAMES } = await import("../../lib/jobs");
    expect(JOB_NAMES.SUBMIT_CONTRACTING_PACKET).toBe("submit-contracting-packet");
  });
});
