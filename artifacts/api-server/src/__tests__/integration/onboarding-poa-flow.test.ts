/**
 * Phase 1.5 POA pivot — integration tests.
 *
 * Covers the new run-wide signing path:
 *
 *   1. POA happy path: start → profile → carriers → poa-decision (accept)
 *      → sign envelope → all carrier requests transition to
 *      `awaiting_admin_submission`, admin task created, run `signing`.
 *      Admin marks each `submitted` → records writing number → run complete.
 *
 *   2. POA opt-out: start → profile → carriers → poa-decision (decline)
 *      → every request flips to `invite_requested`, invite-request emails
 *      enqueued, admin tracking task created. Admin marks each
 *      `submitted` → records writing number → run complete.
 *
 *   3. Deprecation 410s: a POA-flow run cannot use the legacy
 *      `/request-contracting` or per-carrier `/sign` routes.
 *
 *   4. Idempotency: re-calling poa-decision with the same body returns
 *      the same envelope / poaStatus rather than creating duplicates.
 *
 *   5. Cross-org isolation preserved.
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

import { and, eq, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  agentsTable,
  agentOnboardingRunsTable,
  carrierContractingRequestsTable,
  carriersTable,
  esignEnvelopesTable,
  taskInstancesTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

interface OrgCtx {
  orgId: string;
  admin: { id: string };
  agentUser: { id: string };
  agentId: string;
  carriers: Array<{ id: string; name: string }>;
}

async function bootOrg(opts: { carrierCount: number }): Promise<OrgCtx> {
  const handle = await bootTestDb();
  const org = await seedOrg(handle.db, { id: nextId("poa-org") });
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
    .set({ userId: agentUser.id })
    .where(eq(agentsTable.id, agentRow.id));

  const carriers = Array.from({ length: opts.carrierCount }, (_, i) => ({
    id: nextId(`poa-carrier-${i}`),
    name: `Carrier ${i + 1}`,
  }));
  if (carriers.length > 0) {
    await handle.db.insert(carriersTable).values(
      carriers.map((c) => ({
        id: c.id,
        orgId: org.id,
        name: c.name,
        appointmentDeskEmail: `desk-${c.id}@example.com`,
      })),
    );
  }

  return {
    orgId: org.id,
    admin,
    agentUser,
    agentId: agentRow.id,
    carriers,
  };
}

/** Helper: drive a fresh run through start → profile → carriers. */
async function advanceToCarriersSelected(ctx: OrgCtx): Promise<string> {
  const startRes = await request(app)
    .post("/api/onboarding/start")
    .set(withAuth(ctx.admin.id))
    .send({ agentId: ctx.agentId });
  expect(startRes.status).toBe(201);
  const runId = startRes.body.run.id as string;

  await request(app)
    .patch(`/api/onboarding/${ctx.agentId}/profile`)
    .set(withAuth(ctx.admin.id))
    .send({ phone: "+15551234567" });

  await request(app)
    .post(`/api/onboarding/${ctx.agentId}/carriers/select`)
    .set(withAuth(ctx.admin.id))
    .send({
      selections: ctx.carriers.map((c) => ({
        carrierId: c.id,
        states: ["FL"],
      })),
    });

  return runId;
}

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("Phase 1.5 POA pivot — full end-to-end coverage", () => {
  it("POA happy path: accept → envelope created → sign → carriers move to awaiting_admin_submission + admin task", async () => {
    const ctx = await bootOrg({ carrierCount: 2 });
    const handle = await bootTestDb();

    const runId = await advanceToCarriersSelected(ctx);

    // POST /poa-decision with accepted: true → returns envelope + signing URL.
    const decideRes = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.agentUser.id))
      .send({ accepted: true });
    expect(decideRes.status).toBe(200);
    expect(decideRes.body.poaStatus).toBe("pending");
    expect(decideRes.body.envelopeId).toBeTruthy();
    expect(decideRes.body.signingUrl).toBe(
      `/sign/${decideRes.body.envelopeId}`,
    );
    const envelopeId = decideRes.body.envelopeId as string;

    // Run reflects poa_status = pending + the envelope id.
    {
      const [r] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, runId));
      expect(r.poaStatus).toBe("pending");
      expect(r.poaEnvelopeId).toBe(envelopeId);
      expect(r.poaExpiresAt).toBeNull();
    }

    // The envelope was created with onboarding_run_id (no carrier link).
    {
      const [env] = await handle.db
        .select()
        .from(esignEnvelopesTable)
        .where(eq(esignEnvelopesTable.id, envelopeId));
      expect(env.onboardingRunId).toBe(runId);
      expect(env.carrierContractingRequestId).toBeNull();
    }

    // Carrier requests stay in `draft` (they transition on POA SIGNED).
    {
      const reqs = await handle.db
        .select()
        .from(carrierContractingRequestsTable)
        .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
      expect(reqs.every((r) => r.status === "draft")).toBe(true);
    }

    // Idempotent re-call returns the same envelope.
    const reDecide = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.agentUser.id))
      .send({ accepted: true });
    expect(reDecide.status).toBe(200);
    expect(reDecide.body.idempotent).toBe(true);
    expect(reDecide.body.envelopeId).toBe(envelopeId);

    // Now complete the envelope via the native e-sign flow.
    const completeRes = await request(app)
      .post(`/api/esign/envelopes/${envelopeId}/sign`)
      .set(withAuth(ctx.agentUser.id))
      .send({
        typedName: "Test Agent",
        signatureSvg: "<svg/>",
        consentToElectronicBusiness: true,
        intentToSign: true,
      });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe("completed");

    // Run: poa_status = signed, poa_expires_at set, status → signing.
    {
      const [r] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, runId));
      expect(r.poaStatus).toBe("signed");
      expect(r.poaExpiresAt).toBeTruthy();
      expect(r.status).toBe("signing");
    }

    // All carrier requests flipped to awaiting_admin_submission.
    {
      const reqs = await handle.db
        .select()
        .from(carrierContractingRequestsTable)
        .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
      expect(reqs.every((r) => r.status === "awaiting_admin_submission")).toBe(
        true,
      );
    }

    // Admin task: "Submit contracts for {agent} (POA-authorized)".
    {
      const tasks = await handle.db
        .select()
        .from(taskInstancesTable)
        .where(
          and(
            eq(taskInstancesTable.orgId, ctx.orgId),
            eq(taskInstancesTable.contractingTaskKey, `${runId}:admin-poa-submit`),
          ),
        );
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("open");
      expect(tasks[0].assignedToUserId).toBe(ctx.admin.id);
      expect(tasks[0].title).toContain("POA-authorized");
    }

    // Admin marks each request submitted, then records writing number.
    const reqRows = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));

    for (let i = 0; i < reqRows.length; i += 1) {
      const submitRes = await request(app)
        .patch(`/api/admin/contracting/${reqRows[i].id}`)
        .set(withAuth(ctx.admin.id))
        .send({ status: "submitted" });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.request.status).toBe("submitted");
    }

    for (let i = 0; i < reqRows.length; i += 1) {
      const writeRes = await request(app)
        .patch(`/api/admin/contracting/${reqRows[i].id}`)
        .set(withAuth(ctx.admin.id))
        .send({ writingNumber: `POA-W-${i + 1}` });
      expect(writeRes.status).toBe(200);
      expect(writeRes.body.request.status).toBe("appointed");
    }

    // Final run state: complete.
    {
      const [r] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, runId));
      expect(r.status).toBe("complete");
    }
  }, 30_000);

  it("opt-out path: decline → all carriers go to invite_requested + admin tracking task + submit-packet jobs enqueued", async () => {
    const ctx = await bootOrg({ carrierCount: 2 });
    const handle = await bootTestDb();
    // Capture enqueued jobs from the mocked lib/jobs.
    const { getEnqueuedJobs, clearEnqueuedJobs } = await import(
      "../helpers/testApp"
    );
    clearEnqueuedJobs();

    const runId = await advanceToCarriersSelected(ctx);

    const decideRes = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.agentUser.id))
      .send({ accepted: false });
    expect(decideRes.status).toBe(200);
    expect(decideRes.body.poaStatus).toBe("opted_out");
    expect(decideRes.body.transitioned).toBe(2);

    // Run reflects opted_out + run advanced to signing.
    {
      const [r] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, runId));
      expect(r.poaStatus).toBe("opted_out");
      expect(r.status).toBe("signing");
    }

    // All carriers flipped to invite_requested.
    {
      const reqs = await handle.db
        .select()
        .from(carrierContractingRequestsTable)
        .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
      expect(reqs.every((r) => r.status === "invite_requested")).toBe(true);
    }

    // Submit-packet job enqueued for each carrier (opt-out branch).
    const enqueued = getEnqueuedJobs();
    const inviteJobs = enqueued.filter(
      (j) => j.name === "submit-contracting-packet",
    );
    expect(inviteJobs).toHaveLength(2);

    // Admin tracking task created.
    {
      const tasks = await handle.db
        .select()
        .from(taskInstancesTable)
        .where(
          and(
            eq(taskInstancesTable.orgId, ctx.orgId),
            eq(
              taskInstancesTable.contractingTaskKey,
              `${runId}:admin-optout-track`,
            ),
          ),
        );
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toContain("opt-out");
    }

    // Idempotent re-call.
    const reDecide = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.agentUser.id))
      .send({ accepted: false });
    expect(reDecide.status).toBe(200);
    expect(reDecide.body.idempotent).toBe(true);

    // Admin marks each invite_requested → submitted (agent completed direct flow).
    const reqRows = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
    for (const row of reqRows) {
      const submitRes = await request(app)
        .patch(`/api/admin/contracting/${row.id}`)
        .set(withAuth(ctx.admin.id))
        .send({ status: "submitted" });
      expect(submitRes.status).toBe(200);
      expect(submitRes.body.request.status).toBe("submitted");
    }

    // Writing numbers complete the run.
    for (let i = 0; i < reqRows.length; i += 1) {
      const writeRes = await request(app)
        .patch(`/api/admin/contracting/${reqRows[i].id}`)
        .set(withAuth(ctx.admin.id))
        .send({ writingNumber: `OPTOUT-W-${i + 1}` });
      expect(writeRes.status).toBe(200);
      expect(writeRes.body.request.status).toBe("appointed");
    }
    {
      const [r] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, runId));
      expect(r.status).toBe("complete");
    }
  }, 30_000);

  it("returns 410 on /request-contracting for a POA-flow run", async () => {
    const ctx = await bootOrg({ carrierCount: 1 });
    await advanceToCarriersSelected(ctx);

    // Decide POA — sets poa_status = pending.
    await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.agentUser.id))
      .send({ accepted: true });

    // Legacy /request-contracting now refuses with 410.
    const reqRes = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/request-contracting`)
      .set(withAuth(ctx.admin.id))
      .send({});
    expect(reqRes.status).toBe(410);
    expect(reqRes.body.poaStatus).toBe("pending");
    expect(reqRes.body.nextRoute).toContain("poa-decision");
  });

  it("returns 410 on legacy per-carrier /sign for a POA-flow run", async () => {
    const ctx = await bootOrg({ carrierCount: 1 });
    await advanceToCarriersSelected(ctx);

    await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.agentUser.id))
      .send({ accepted: true });

    const signRes = await request(app)
      .post(
        `/api/onboarding/${ctx.agentId}/carriers/${ctx.carriers[0].id}/sign`,
      )
      .set(withAuth(ctx.agentUser.id))
      .send({});
    expect(signRes.status).toBe(410);
    expect(signRes.body.nextRoute).toContain("poa-decision");
  });

  it("rejects a flip from opt_out back to POA (must cancel + restart)", async () => {
    const ctx = await bootOrg({ carrierCount: 1 });
    await advanceToCarriersSelected(ctx);

    await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.agentUser.id))
      .send({ accepted: false });

    const flipRes = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.agentUser.id))
      .send({ accepted: true });
    expect(flipRes.status).toBe(409);
    expect(flipRes.body.poaStatus).toBe("opted_out");
  });

  it("rejects /poa-decision if no carriers selected", async () => {
    const ctx = await bootOrg({ carrierCount: 0 });
    // Manual setup — start + profile, no carrier select.
    const startRes = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(ctx.admin.id))
      .send({ agentId: ctx.agentId });
    expect(startRes.status).toBe(201);

    const decideRes = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(ctx.admin.id))
      .send({ accepted: true });
    expect(decideRes.status).toBe(409);
  });

  it("multi-tenant: a POA decision in org A doesn't bleed into org B", async () => {
    const orgA = await bootOrg({ carrierCount: 1 });
    const orgB = await bootOrg({ carrierCount: 1 });
    const handle = await bootTestDb();

    await advanceToCarriersSelected(orgA);
    await advanceToCarriersSelected(orgB);

    await request(app)
      .post(`/api/onboarding/${orgA.agentId}/poa-decision`)
      .set(withAuth(orgA.agentUser.id))
      .send({ accepted: true });

    // Org B's run is untouched.
    const [bRun] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.agentId, orgB.agentId));
    expect(bRun.poaStatus).toBe("not_applicable");
    expect(bRun.poaEnvelopeId).toBeNull();

    // Org B agent can still drive their own POA decision independently.
    const bDecide = await request(app)
      .post(`/api/onboarding/${orgB.agentId}/poa-decision`)
      .set(withAuth(orgB.agentUser.id))
      .send({ accepted: false });
    expect(bDecide.status).toBe(200);
    expect(bDecide.body.poaStatus).toBe("opted_out");
  });

  it("non-admin non-owning agent cannot record poa-decision", async () => {
    const ctx = await bootOrg({ carrierCount: 1 });
    await advanceToCarriersSelected(ctx);

    // Create a foreign agent user in the same org.
    const handle = await bootTestDb();
    const otherUser = await seedUser(handle.db, {
      orgId: ctx.orgId,
      role: "agent",
    });

    const decideRes = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/poa-decision`)
      .set(withAuth(otherUser.id))
      .send({ accepted: true });
    expect(decideRes.status).toBe(403);
  });
});
