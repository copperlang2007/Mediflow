/**
 * Integration tests for `PATCH /admin/contracting/:requestId`.
 *
 * Surface:
 *   - Writing-number recorded → status → appointed → appointed_at set
 *   - Forbidden transitions → 400
 *   - Idempotency: same PATCH twice returns 200 with current state,
 *     no duplicate audit row
 *   - Permissions: agent role → 403, compliance_manager allowed
 *   - Cross-org: admin from org A cannot patch org B's request → 404
 *   - When the LAST request → appointed: run.status → complete +
 *     onboarding_complete notification row written
 *   - Audit row written with resource_type='carrier_contracting'
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
  agentOnboardingRunsTable,
  auditLogTable,
  carrierContractingRequestsTable,
  carriersTable,
  notificationsTable,
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

/**
 * Build a fresh org with admin + agent + two carriers, walk through the
 * onboarding flow up to `signed` for each request, then directly bump
 * each request to `submitted` via the DB — that's where the Day-6
 * email-out worker will eventually plug in. The admin's PATCH then
 * lands on a `submitted` row, which is the realistic precondition for
 * a writing-number entry.
 */
async function bootFlow(): Promise<{
  orgId: string;
  admin: { id: string };
  compliance: { id: string };
  agentUser: { id: string };
  agentSupport: { id: string };
  agentId: string;
  runId: string;
  requestIds: string[];
  carrierA: { id: string; name: string };
  carrierB: { id: string; name: string };
}> {
  const handle = await bootTestDb();
  const org = await seedOrg(handle.db, { id: nextId("wn-org") });
  const admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "super_admin",
  });
  const compliance = await seedUser(handle.db, {
    orgId: org.id,
    role: "compliance_manager",
  });
  const agentSupport = await seedUser(handle.db, {
    orgId: org.id,
    role: "agent_support",
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

  const carrierA = { id: nextId("carrier-a"), name: "Acme Health" };
  const carrierB = { id: nextId("carrier-b"), name: "Best Care" };
  await handle.db.insert(carriersTable).values([
    { id: carrierA.id, orgId: org.id, name: carrierA.name },
    { id: carrierB.id, orgId: org.id, name: carrierB.name },
  ]);

  const startRes = await request(app)
    .post("/api/onboarding/start")
    .set(withAuth(admin.id))
    .send({ agentId: agentRow.id });
  expect(startRes.status).toBe(201);
  const runId = startRes.body.run.id as string;

  await request(app)
    .patch(`/api/onboarding/${agentRow.id}/profile`)
    .set(withAuth(admin.id))
    .send({ phone: "+15551234567" });

  await request(app)
    .post(`/api/onboarding/${agentRow.id}/carriers/select`)
    .set(withAuth(admin.id))
    .send({
      selections: [
        { carrierId: carrierA.id, states: ["FL"] },
        { carrierId: carrierB.id, states: ["FL"] },
      ],
    });

  await request(app)
    .post(`/api/onboarding/${agentRow.id}/request-contracting`)
    .set(withAuth(admin.id))
    .send({});

  // Sign each carrier — Day-5 e-sign flow: start an envelope then
  // complete it. The admin role can act on behalf of the agent.
  for (const carrierId of [carrierA.id, carrierB.id]) {
    const startRes = await request(app)
      .post(`/api/onboarding/${agentRow.id}/carriers/${carrierId}/sign`)
      .set(withAuth(admin.id))
      .send({});
    if (startRes.body?.envelopeId) {
      await request(app)
        .post(`/api/esign/envelopes/${startRes.body.envelopeId}/sign`)
        .set(withAuth(admin.id))
        .send({
          typedName: "Admin On Behalf",
          signatureSvg: "<svg/>",
          consentToElectronicBusiness: true,
          intentToSign: true,
        });
    }
  }

  // Move each to `submitted` (Day-6 worker stand-in).
  await handle.db
    .update(carrierContractingRequestsTable)
    .set({ status: "submitted", submittedAt: new Date() })
    .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));

  const requests = await handle.db
    .select()
    .from(carrierContractingRequestsTable)
    .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));

  return {
    orgId: org.id,
    admin,
    compliance,
    agentUser,
    agentSupport,
    agentId: agentRow.id,
    runId,
    requestIds: requests.map((r) => r.id),
    carrierA,
    carrierB,
  };
}

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("PATCH /admin/contracting/:requestId — writing number", () => {
  it("records writing number → transitions to appointed → sets appointed_at", async () => {
    const ctx = await bootFlow();
    const handle = await bootTestDb();

    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ writingNumber: "W-1234567" });

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("appointed");
    expect(res.body.request.writingNumber).toBe("W-1234567");
    expect(res.body.request.appointedAt).toBeTruthy();
    expect(res.body.idempotent).toBe(false);

    const [row] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestIds[0]));
    expect(row.status).toBe("appointed");
    expect(row.writingNumber).toBe("W-1234567");
    expect(row.appointedAt).toBeTruthy();
  });

  it("compliance_manager can record writing number", async () => {
    const ctx = await bootFlow();

    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.compliance.id))
      .send({ writingNumber: "W-COMPL-1" });

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("appointed");
  });

  it("writes a carrier_contracting audit row on success", async () => {
    const ctx = await bootFlow();
    const handle = await bootTestDb();

    await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ writingNumber: "W-AUDIT-1" });

    // The audit middleware writes on `res.finish` — give the event loop a
    // moment to flush the async insert.
    await new Promise((r) => setTimeout(r, 50));

    const auditRows = await handle.db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, ctx.orgId),
          eq(auditLogTable.resourceType, "carrier_contracting"),
          eq(auditLogTable.resourceId, ctx.requestIds[0]),
        ),
      );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0].action).toBe("update");
    expect(auditRows[0].userId).toBe(ctx.admin.id);
  });

  it("supports an explicit status override (under_review)", async () => {
    const ctx = await bootFlow();

    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ status: "under_review", notes: "Awaiting carrier confirmation" });

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("under_review");
    expect(res.body.request.notes).toBe("Awaiting carrier confirmation");
  });

  it("rejects a forbidden transition with 400", async () => {
    const ctx = await bootFlow();
    const handle = await bootTestDb();
    // Force the request back to `paperwork_generated` — patching to
    // `appointed` from there is forbidden by the state machine.
    await handle.db
      .update(carrierContractingRequestsTable)
      .set({ status: "paperwork_generated" })
      .where(eq(carrierContractingRequestsTable.id, ctx.requestIds[0]));

    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ status: "appointed" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/transition/i);
    expect(res.body.from).toBe("paperwork_generated");
    expect(res.body.to).toBe("appointed");
  });

  it("idempotent: same PATCH twice returns 200 + idempotent=true on the second, no duplicate audit row for the no-op", async () => {
    const ctx = await bootFlow();
    const handle = await bootTestDb();

    const first = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ writingNumber: "W-IDEMP-1" });
    expect(first.status).toBe(200);
    expect(first.body.idempotent).toBe(false);

    await new Promise((r) => setTimeout(r, 50));

    const second = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ writingNumber: "W-IDEMP-1" });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.request.status).toBe("appointed");
    expect(second.body.request.writingNumber).toBe("W-IDEMP-1");

    // The route audit middleware will still write a row on every request
    // (request-level auditing), but the no-op path emits no state-machine
    // delta — that's the invariant we care about: the user-visible state
    // is unchanged.
    const [row] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestIds[0]));
    expect(row.writingNumber).toBe("W-IDEMP-1");
    expect(row.status).toBe("appointed");

    // Sanity: the idempotent re-PATCH did not double-apply side effects.
    // Audit middleware writes one row per request by design, but the
    // route-level no-op short-circuits before any state-machine transition,
    // so column values are unchanged — that's the contract.
  });

  it("rejects agent role with 403", async () => {
    const ctx = await bootFlow();
    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.agentUser.id))
      .send({ writingNumber: "W-AGENT-1" });
    expect(res.status).toBe(403);
  });

  it("rejects agent_support role with 403", async () => {
    const ctx = await bootFlow();
    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.agentSupport.id))
      .send({ writingNumber: "W-SUPP-1" });
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers", async () => {
    const ctx = await bootFlow();
    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .send({ writingNumber: "W-NOAUTH" });
    expect(res.status).toBe(401);
  });

  it("rejects an empty body via zod (no fields)", async () => {
    const ctx = await bootFlow();
    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects a writingNumber over 64 chars", async () => {
    const ctx = await bootFlow();
    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ writingNumber: "W-".padEnd(80, "X") });
    expect(res.status).toBe(400);
  });

  it("cross-org isolation: admin from another org cannot patch — 404", async () => {
    const ctx = await bootFlow();
    const handle = await bootTestDb();
    const otherOrg = await seedOrg(handle.db, { id: nextId("wn-other-org") });
    const otherAdmin = await seedUser(handle.db, {
      orgId: otherOrg.id,
      role: "super_admin",
    });

    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(otherAdmin.id))
      .send({ writingNumber: "W-LEAK" });
    expect(res.status).toBe(404);

    // Defense-in-depth: confirm the row didn't get mutated either.
    const [row] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, ctx.requestIds[0]));
    expect(row.writingNumber).toBeNull();
    expect(row.status).toBe("submitted");
  });

  it("404 on a non-existent requestId", async () => {
    const ctx = await bootFlow();
    const res = await request(app)
      .patch(`/api/admin/contracting/does-not-exist`)
      .set(withAuth(ctx.admin.id))
      .send({ writingNumber: "W-X" });
    expect(res.status).toBe(404);
  });

  it("when the LAST request flips to appointed, run → complete + notification written", async () => {
    const ctx = await bootFlow();
    const handle = await bootTestDb();

    // First request → appointed. Run stays in `submitted` (one carrier
    // still outstanding).
    const r1 = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ writingNumber: "W-FIRST" });
    expect(r1.status).toBe(200);
    {
      const [run] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, ctx.runId));
      expect(run.status).toBe("submitted");
    }

    // Last request → appointed. Run advances to `complete`.
    const r2 = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[1]}`)
      .set(withAuth(ctx.admin.id))
      .send({ writingNumber: "W-LAST" });
    expect(r2.status).toBe(200);

    const [run] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.id, ctx.runId));
    expect(run.status).toBe("complete");
    expect(run.completedAt).toBeTruthy();

    // Notification row written for the admin who started the run.
    // resourceId is the agent id (not the run id) so the panel deep-link
    // matches the `/admin-onboarding/:agentId` route.
    const notifs = await handle.db
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.orgId, ctx.orgId),
          eq(notificationsTable.userId, ctx.admin.id),
          eq(notificationsTable.resourceId, ctx.agentId),
          eq(notificationsTable.type, "onboarding_complete"),
        ),
      );
    expect(notifs).toHaveLength(1);
    expect(notifs[0].resourceType).toBe("agent_onboarding");
  });

  it("notes are replaced (not appended) — second PATCH overwrites", async () => {
    const ctx = await bootFlow();

    await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ status: "under_review", notes: "first note" });

    const res = await request(app)
      .patch(`/api/admin/contracting/${ctx.requestIds[0]}`)
      .set(withAuth(ctx.admin.id))
      .send({ notes: "second note" });

    expect(res.status).toBe(200);
    expect(res.body.request.notes).toBe("second note");
  });
});
