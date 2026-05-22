/**
 * Day-3 integration tests for the contracting-orchestration routes.
 *
 * Surface:
 *   - POST /onboarding/start             — creates agent task
 *   - POST /onboarding/:agentId/carriers/select — creates admin review task
 *   - POST /onboarding/:agentId/request-contracting  (new, admin)
 *   - POST /onboarding/:agentId/carriers/:carrierId/sign (new, agent or admin)
 *   - Eventually-complete flow            — notification + admin tasks closed
 *
 * Defense-in-depth:
 *   - Cross-org calls 404 on every new route
 *   - agent role cannot fire `request-contracting`
 *   - Re-call idempotency on every new route (no duplicate tasks)
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
import { randomUUID } from "node:crypto";
import {
  agentsTable,
  agentOnboardingRunsTable,
  carrierContractingRequestsTable,
  carriersTable,
  notificationsTable,
  taskInstancesTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

// Per-test fresh orgs / agents — every test seeds its own set so the
// partial-unique `(org, agent) active onboarding` index never interferes
// across `it()` blocks. This keeps the orchestration assertions cleanly
// scoped.
let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomUUID().slice(0, 8)}`;
}

async function freshOrg(): Promise<{
  org: { id: string };
  admin: { id: string };
  agentSupport: { id: string };
  agentUser: { id: string };
  agent: { id: string };
  carrierA: { id: string; name: string };
  carrierB: { id: string; name: string };
}> {
  const handle = await bootTestDb();
  const org = await seedOrg(handle.db, { id: nextId("ct-org") });
  const admin = await seedUser(handle.db, {
    orgId: org.id,
    role: "super_admin",
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
  // Link the agent record to the agent user — so `/sign` can verify the
  // caller is the owning agent.
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

  return {
    org,
    admin,
    agentSupport,
    agentUser,
    agent: { id: agentRow.id },
    carrierA,
    carrierB,
  };
}

async function startRun(adminId: string, agentId: string): Promise<string> {
  const res = await request(app)
    .post("/api/onboarding/start")
    .set(withAuth(adminId))
    .send({ agentId });
  expect(res.status).toBe(201);
  return res.body.run.id as string;
}

/**
 * Drive the run through the early state-machine steps so subsequent
 * `request-contracting` / `sign` calls have a valid origin state to
 * transition from. Without this the run stays in `draft` and downstream
 * route handlers silently no-op on the run transition (forbidden →
 * caught → keep going), which produces test failures that look like
 * orchestration bugs but are actually missing setup.
 */
async function patchProfile(adminId: string, agentId: string): Promise<void> {
  const res = await request(app)
    .patch(`/api/onboarding/${agentId}/profile`)
    .set(withAuth(adminId))
    .send({ phone: "+15551234567" });
  expect(res.status).toBe(200);
}

async function selectCarriers(
  adminId: string,
  agentId: string,
  selections: Array<{ carrierId: string; states: string[] }>,
): Promise<void> {
  // Auto-bridge through profile_in_progress on the first call so the
  // state machine permits `draft → carriers_selected` (illegal direct).
  // The PATCH is idempotent on subsequent calls — already past
  // profile_in_progress just no-ops.
  await patchProfile(adminId, agentId);
  const res = await request(app)
    .post(`/api/onboarding/${agentId}/carriers/select`)
    .set(withAuth(adminId))
    .send({ selections });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("POST /onboarding/start — task orchestration", () => {
  it("creates the agent's 'Complete contracting profile' task", async () => {
    const { handle } = await (async () => ({ handle: await bootTestDb() }))();
    const { org, admin, agentUser, agent } = await freshOrg();
    const runId = await startRun(admin.id, agent.id);

    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, org.id),
          eq(taskInstancesTable.agentId, agent.id),
        ),
      );
    const profileTask = tasks.find((t) => t.title === "Complete contracting profile");
    expect(profileTask).toBeTruthy();
    expect(profileTask!.status).toBe("open");
    expect(profileTask!.assignedToUserId).toBe(agentUser.id);
    expect(profileTask!.contractingTaskKey).toBe(`${runId}:complete-profile`);
    expect(profileTask!.createdBy).toBe(admin.id);
  });

  it("records startedByUserId on the run", async () => {
    const { admin, agent } = await freshOrg();
    const runId = await startRun(admin.id, agent.id);
    const handle = await bootTestDb();
    const [run] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.id, runId));
    expect(run.startedByUserId).toBe(admin.id);
  });

  it("is idempotent — re-calling does not create a duplicate task", async () => {
    const { admin, agent } = await freshOrg();
    await startRun(admin.id, agent.id);
    // Second call returns 200 (the idempotent branch).
    const res = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(admin.id))
      .send({ agentId: agent.id });
    expect(res.status).toBe(200);

    const handle = await bootTestDb();
    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.agentId, agent.id),
          eq(taskInstancesTable.title, "Complete contracting profile"),
        ),
      );
    expect(tasks).toHaveLength(1);
  });
});

describe("POST /onboarding/:agentId/carriers/select — admin review handoff", () => {
  it("closes profile task + creates admin review task on first transition", async () => {
    const { org, admin, agent, carrierA } = await freshOrg();
    const runId = await startRun(admin.id, agent.id);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL"] },
    ]);

    const handle = await bootTestDb();
    const tasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));

    const profileTask = tasks.find(
      (t) => t.contractingTaskKey === `${runId}:complete-profile`,
    );
    expect(profileTask!.status).toBe("completed");
    expect(profileTask!.completedAt).toBeTruthy();

    const adminTask = tasks.find(
      (t) => t.contractingTaskKey === `${runId}:admin-review`,
    );
    expect(adminTask).toBeTruthy();
    expect(adminTask!.status).toBe("open");
    expect(adminTask!.assignedToUserId).toBe(admin.id);
    expect(adminTask!.title).toMatch(/Review and request contracting for /);
  });

  it("re-selecting does not duplicate admin review tasks", async () => {
    const { org, admin, agent, carrierA, carrierB } = await freshOrg();
    const runId = await startRun(admin.id, agent.id);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL"] },
    ]);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL", "GA"] },
      { carrierId: carrierB.id, states: ["FL"] },
    ]);

    const handle = await bootTestDb();
    const adminTasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, org.id),
          eq(taskInstancesTable.contractingTaskKey, `${runId}:admin-review`),
        ),
      );
    expect(adminTasks).toHaveLength(1);
  });
});

describe("POST /onboarding/:agentId/request-contracting", () => {
  it("happy path: paperwork → sign tasks → admin task closed → signing", async () => {
    const { org, admin, agent, agentUser, carrierA, carrierB } = await freshOrg();
    const runId = await startRun(admin.id, agent.id);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL"] },
      { carrierId: carrierB.id, states: ["FL"] },
    ]);

    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.paperworkGenerated).toBe(2);
    expect(res.body.signTasks).toHaveLength(2);
    expect(res.body.run.status).toBe("signing");

    const handle = await bootTestDb();

    // All carrier requests advanced + have paperwork_document_id set.
    const requests = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.status).toBe("paperwork_generated");
      expect(r.paperworkDocumentId).toBeTruthy();
    }

    // Sign tasks present, one per carrier, assigned to the agent.
    const signTasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, org.id),
          eq(taskInstancesTable.agentId, agent.id),
        ),
      );
    const carrierSignTasks = signTasks.filter((t) =>
      t.title.startsWith("Sign contracting paperwork for "),
    );
    expect(carrierSignTasks).toHaveLength(2);
    for (const t of carrierSignTasks) {
      expect(t.assignedToUserId).toBe(agentUser.id);
      expect(t.status).toBe("open");
    }

    // Admin review task closed.
    const [adminTask] = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.contractingTaskKey, `${runId}:admin-review`));
    expect(adminTask.status).toBe("completed");
  });

  it("is idempotent — re-call returns current state, no duplicate sign tasks", async () => {
    const { org, admin, agent, carrierA } = await freshOrg();
    const runId = await startRun(admin.id, agent.id);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL"] },
    ]);

    await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .set(withAuth(admin.id))
      .send({});

    const second = await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .set(withAuth(admin.id))
      .send({});
    expect(second.status).toBe(200);
    // Re-call: nothing was in `draft`, so paperworkGenerated stays at 0.
    expect(second.body.paperworkGenerated).toBe(0);

    const handle = await bootTestDb();
    const signTasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, org.id),
          eq(taskInstancesTable.contractingTaskKey, `${runId}:sign:${(
            await handle.db
              .select()
              .from(carrierContractingRequestsTable)
              .where(eq(carrierContractingRequestsTable.onboardingRunId, runId))
          )[0].id}`),
        ),
      );
    expect(signTasks).toHaveLength(1);
  });

  it("rejects an agent role (admin-only)", async () => {
    const { admin, agent, agentUser, carrierA } = await freshOrg();
    await startRun(admin.id, agent.id);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL"] },
    ]);

    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .set(withAuth(agentUser.id))
      .send({});
    expect(res.status).toBe(403);
  });

  it("rejects agent_support role (admin-only)", async () => {
    const { admin, agent, agentSupport, carrierA } = await freshOrg();
    await startRun(admin.id, agent.id);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL"] },
    ]);

    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .set(withAuth(agentSupport.id))
      .send({});
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers", async () => {
    const { agent } = await freshOrg();
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("cross-org isolation: another org's admin gets 404", async () => {
    const { agent, carrierA, admin } = await freshOrg();
    await startRun(admin.id, agent.id);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL"] },
    ]);

    const handle = await bootTestDb();
    const otherOrg = await seedOrg(handle.db, { id: nextId("other-org") });
    const otherAdmin = await seedUser(handle.db, {
      orgId: otherOrg.id,
      role: "super_admin",
    });

    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .set(withAuth(otherAdmin.id))
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 409 if no carriers selected yet", async () => {
    const { admin, agent } = await freshOrg();
    await startRun(admin.id, agent.id);

    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(409);
  });

  it("404 for an agent with no active onboarding run", async () => {
    const { admin } = await freshOrg();
    const handle = await bootTestDb();
    const isolatedAgent = await seedAgent(handle.db, { orgId: (await freshOrg()).org.id });
    const res = await request(app)
      .post(`/api/onboarding/${isolatedAgent.id}/request-contracting`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(404);
  });

  it("agency_admin (not just super_admin) can fire request-contracting", async () => {
    const ctx = await freshOrg();
    const handle = await bootTestDb();
    const agencyAdmin = await seedUser(handle.db, {
      orgId: ctx.org.id,
      role: "agency_admin",
    });
    await startRun(ctx.admin.id, ctx.agent.id);
    await selectCarriers(ctx.admin.id, ctx.agent.id, [
      { carrierId: ctx.carrierA.id, states: ["FL"] },
    ]);

    const res = await request(app)
      .post(`/api/onboarding/${ctx.agent.id}/request-contracting`)
      .set(withAuth(agencyAdmin.id))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe("signing");
  });
});

describe("POST /onboarding/:agentId/carriers/:carrierId/sign — envelope creation", () => {
  // Day-5 e-signature change: the route now creates an `esign_envelopes`
  // row and returns the signing URL instead of synchronously transitioning
  // the request to `signed`. The actual transition happens in the
  // envelope-completion path (covered by the dedicated esign tests).

  async function setupSigning(): Promise<{
    org: { id: string };
    admin: { id: string };
    agent: { id: string };
    agentUser: { id: string };
    agentSupport: { id: string };
    carrierA: { id: string; name: string };
    runId: string;
    requestId: string;
  }> {
    const ctx = await freshOrg();
    const runId = await startRun(ctx.admin.id, ctx.agent.id);
    await selectCarriers(ctx.admin.id, ctx.agent.id, [
      { carrierId: ctx.carrierA.id, states: ["FL"] },
    ]);
    await request(app)
      .post(`/api/onboarding/${ctx.agent.id}/request-contracting`)
      .set(withAuth(ctx.admin.id))
      .send({});
    const handle = await bootTestDb();
    const [req] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
    return { ...ctx, runId, requestId: req.id };
  }

  it("happy path: agent starts signing → envelope is created in `pending`, signingUrl returned", async () => {
    const { agent, agentUser, carrierA, requestId } = await setupSigning();

    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${carrierA.id}/sign`)
      .set(withAuth(agentUser.id))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.envelopeId).toBeTruthy();
    expect(res.body.status).toBe("pending");
    expect(res.body.signingUrl).toBe(`/sign/${res.body.envelopeId}`);
    expect(res.body.carrierContractingRequestId).toBe(requestId);
  });

  it("admin can start signing on behalf", async () => {
    const { admin, agent, carrierA } = await setupSigning();
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${carrierA.id}/sign`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.envelopeId).toBeTruthy();
  });

  it("is idempotent: re-calling returns the same envelope, no duplicate row", async () => {
    const { agent, agentUser, carrierA } = await setupSigning();
    const first = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${carrierA.id}/sign`)
      .set(withAuth(agentUser.id))
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${carrierA.id}/sign`)
      .set(withAuth(agentUser.id))
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.envelopeId).toBe(first.body.envelopeId);
  });

  it("agent_support cannot sign (not the agent + not admin)", async () => {
    const { agent, agentSupport, carrierA } = await setupSigning();
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${carrierA.id}/sign`)
      .set(withAuth(agentSupport.id))
      .send({});
    expect(res.status).toBe(403);
  });

  it("a DIFFERENT agent (not the owner) cannot sign — same org", async () => {
    const ctx = await setupSigning();
    const handle = await bootTestDb();
    // Same-org `agent` role user, NOT linked to ctx.agent. The narrowing
    // check (`isOwningAgent`) compares `agent.userId === authReq.userId`
    // — fails because the agent's userId is `ctx.agentUser.id`.
    const interloper = await seedUser(handle.db, {
      orgId: ctx.org.id,
      role: "agent",
    });
    const res = await request(app)
      .post(`/api/onboarding/${ctx.agent.id}/carriers/${ctx.carrierA.id}/sign`)
      .set(withAuth(interloper.id))
      .send({});
    expect(res.status).toBe(403);
  });

  it("cross-org isolation: admin from another org gets 404", async () => {
    const { agent, carrierA } = await setupSigning();
    const handle = await bootTestDb();
    const otherOrg = await seedOrg(handle.db, { id: nextId("other-org") });
    const otherAdmin = await seedUser(handle.db, {
      orgId: otherOrg.id,
      role: "super_admin",
    });
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${carrierA.id}/sign`)
      .set(withAuth(otherAdmin.id))
      .send({});
    expect(res.status).toBe(404);
  });

  it("404 when no contracting request exists for the (agent, carrier) pair", async () => {
    const { admin, agent, org } = await setupSigning();
    const handle = await bootTestDb();
    // Carrier exists in same org but the agent has no contracting
    // request for it (only carrierA was selected in setupSigning).
    const unrelated = { id: nextId("carrier-unrelated") };
    await handle.db.insert(carriersTable).values({
      id: unrelated.id,
      orgId: org.id,
      name: "Unrelated Co",
    });
    const res = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${unrelated.id}/sign`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("contractingTasks key + idempotency helpers", () => {
  it("completeProfileTaskKey is deterministic per run", async () => {
    const { completeProfileTaskKey, adminReviewTaskKey, carrierSignTaskKey, carrierSubmitTaskKey } =
      await import("../../workers/contractingTasks");
    expect(completeProfileTaskKey("r1")).toBe("r1:complete-profile");
    expect(adminReviewTaskKey("r1")).toBe("r1:admin-review");
    expect(carrierSignTaskKey("r1", "req-1")).toBe("r1:sign:req-1");
    expect(carrierSubmitTaskKey("req-1")).toBe("req-1:submit");
    // Distinct keys for distinct inputs (regression guard against a
    // future refactor accidentally collapsing the key space).
    expect(completeProfileTaskKey("r1")).not.toBe(adminReviewTaskKey("r1"));
  });

  it("closeContractingTask is a no-op on an already-completed task", async () => {
    const { admin, agent } = await freshOrg();
    const runId = await startRun(admin.id, agent.id);
    const { closeContractingTask, completeProfileTaskKey } = await import(
      "../../workers/contractingTasks"
    );

    const handle = await bootTestDb();
    const [agentRow] = await handle.db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agent.id));

    const closed1 = await closeContractingTask(
      agentRow.orgId,
      completeProfileTaskKey(runId),
    );
    expect(closed1).toBeTruthy();
    expect(closed1!.status).toBe("completed");

    const closed2 = await closeContractingTask(
      agentRow.orgId,
      completeProfileTaskKey(runId),
    );
    // Second close finds the row already in `completed` — gated UPDATE
    // returns no rows → null.
    expect(closed2).toBeNull();
  });
});

describe("carrier_contracting_requests lifecycle on /sign", () => {
  it("records signatureCompletedAt after the e-sign envelope completes", async () => {
    const { agent, agentUser, carrierA, requestId } = await (async () => {
      const ctx = await freshOrg();
      const runId = await startRun(ctx.admin.id, ctx.agent.id);
      await selectCarriers(ctx.admin.id, ctx.agent.id, [
        { carrierId: ctx.carrierA.id, states: ["FL"] },
      ]);
      await request(app)
        .post(`/api/onboarding/${ctx.agent.id}/request-contracting`)
        .set(withAuth(ctx.admin.id))
        .send({});
      const handle = await bootTestDb();
      const [req] = await handle.db
        .select()
        .from(carrierContractingRequestsTable)
        .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
      return { ...ctx, runId, requestId: req.id };
    })();

    const before = Date.now();
    const startRes = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${carrierA.id}/sign`)
      .set(withAuth(agentUser.id))
      .send({});
    expect(startRes.status).toBe(200);
    const envelopeId = startRes.body.envelopeId as string;

    // Drive the envelope through completion — this is where the
    // contracting request is transitioned to `signed` (via
    // completeCarrierSigningTransition).
    const completeRes = await request(app)
      .post(`/api/esign/envelopes/${envelopeId}/sign`)
      .set(withAuth(agentUser.id))
      .send({
        typedName: "Test Agent",
        signatureSvg: "<svg/>",
        consentToElectronicBusiness: true,
        intentToSign: true,
      });
    expect(completeRes.status).toBe(200);

    const handle = await bootTestDb();
    const [req] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, requestId));
    expect(req.signatureCompletedAt).toBeTruthy();
    expect(new Date(req.signatureCompletedAt!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("updates lastStatusChangeAt on every transition", async () => {
    const ctx = await freshOrg();
    const runId = await startRun(ctx.admin.id, ctx.agent.id);
    await selectCarriers(ctx.admin.id, ctx.agent.id, [
      { carrierId: ctx.carrierA.id, states: ["FL"] },
    ]);
    const handle = await bootTestDb();
    const [reqBefore] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
    const tBefore = new Date(reqBefore.lastStatusChangeAt).getTime();

    await new Promise((r) => setTimeout(r, 10));
    await request(app)
      .post(`/api/onboarding/${ctx.agent.id}/request-contracting`)
      .set(withAuth(ctx.admin.id))
      .send({});

    const [reqAfter] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.id, reqBefore.id));
    expect(new Date(reqAfter.lastStatusChangeAt).getTime()).toBeGreaterThan(tBefore);
  });
});

describe("Run completion + notification", () => {
  it("when every request reaches 'appointed', the run flips to complete + notification is written", async () => {
    const { org, admin, agent, carrierA, carrierB } = await freshOrg();
    const runId = await startRun(admin.id, agent.id);
    await selectCarriers(admin.id, agent.id, [
      { carrierId: carrierA.id, states: ["FL"] },
      { carrierId: carrierB.id, states: ["FL"] },
    ]);
    await request(app)
      .post(`/api/onboarding/${agent.id}/request-contracting`)
      .set(withAuth(admin.id))
      .send({});
    // Drive each carrier through the e-sign envelope completion.
    for (const carrierId of [carrierA.id, carrierB.id]) {
      const startRes = await request(app)
        .post(`/api/onboarding/${agent.id}/carriers/${carrierId}/sign`)
        .set(withAuth(admin.id))
        .send({});
      const envelopeId = startRes.body.envelopeId;
      await request(app)
        .post(`/api/esign/envelopes/${envelopeId}/sign`)
        .set(withAuth(admin.id))
        .send({
          typedName: "Admin",
          signatureSvg: "<svg/>",
          consentToElectronicBusiness: true,
          intentToSign: true,
        });
    }

    // Day-6 worker simulation: flip each request to `appointed` directly.
    const handle = await bootTestDb();
    await handle.db
      .update(carrierContractingRequestsTable)
      .set({ status: "appointed", appointedAt: new Date() })
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));

    // Trigger the run-aggregator by re-completing the (already-completed)
    // envelope for carrierA. completeCarrierSigningTransition's idempotent
    // path still calls maybeAdvanceRunForRequests, which is where the
    // complete + notification logic lives.
    const [envA] = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(
        and(
          eq(carrierContractingRequestsTable.onboardingRunId, runId),
          eq(carrierContractingRequestsTable.carrierId, carrierA.id),
        ),
      );
    const startRes = await request(app)
      .post(`/api/onboarding/${agent.id}/carriers/${carrierA.id}/sign`)
      .set(withAuth(admin.id))
      .send({});
    await request(app)
      .post(`/api/esign/envelopes/${startRes.body.envelopeId}/sign`)
      .set(withAuth(admin.id))
      .send({
        typedName: "Admin",
        signatureSvg: "<svg/>",
        consentToElectronicBusiness: true,
        intentToSign: true,
      });
    void envA;

    // Run should now be complete.
    const [run] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.id, runId));
    expect(run.status).toBe("complete");
    expect(run.completedAt).toBeTruthy();

    // Admin review task is closed (it was closed earlier on
    // request-contracting). Verify it stayed closed.
    const [adminTask] = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.contractingTaskKey, `${runId}:admin-review`));
    expect(adminTask.status).toBe("completed");

    // Notification written for the admin who started the run.
    const notifs = await handle.db
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.orgId, org.id),
          eq(notificationsTable.userId, admin.id),
          eq(notificationsTable.resourceId, runId),
        ),
      );
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    const notif = notifs.find((n) => n.type === "onboarding_complete");
    expect(notif).toBeTruthy();
    expect(notif!.title).toMatch(/onboarding complete/i);
  });
});
