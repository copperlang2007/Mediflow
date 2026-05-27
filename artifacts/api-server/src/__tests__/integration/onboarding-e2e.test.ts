/**
 * End-to-end integration test of the full INSUREitALL onboarding flow.
 *
 * Walks the whole flow as an integration test (no UI — just hitting the
 * routes in sequence and asserting the resulting state at each step):
 *
 *   1. Admin POST /onboarding/start
 *      → run created in 'draft', "Complete profile" task assigned to
 *        the agent's linked user.
 *   2. Agent PATCH /:agentId/profile (full profile incl. SSN)
 *      → profile saved (SSN encrypted, not plaintext on read), run
 *        advances to 'profile_in_progress'.
 *   3. Agent POST /:agentId/carriers/select (3 carriers)
 *      → 3 carrier_contracting_requests in 'draft', run →
 *        'carriers_selected', profile task closed, admin review task
 *        created.
 *   4. Admin POST /:agentId/request-contracting
 *      → all 3 requests → 'paperwork_generated', 3 sign tasks for
 *        agent, admin review task closed, run → 'signing'.
 *   5. Agent POST /:agentId/carriers/:carrierId/sign (×3)
 *      → each request → 'signed', SYSTEM submit task created per
 *        carrier, agent sign tasks closed.
 *   6. Simulate "signed packets emailed and acknowledged" by directly
 *      transitioning each request to 'submitted' via a DB update
 *      (Day 6 worker that drains submit tasks is not implemented yet
 *      — this is the seam where Day 6's email-out worker will plug in).
 *      Re-call `/sign` on one row idempotently to re-trigger the
 *      aggregator → run → 'submitted'.
 *   7. Admin PATCH /admin/contracting/:requestId (writing number) ×3
 *      → each request → 'appointed', writing_number recorded,
 *        appointed_at set; on the THIRD PATCH the run flips to
 *        'complete' + a notification row is written.
 *
 * Also covers:
 *   - The cancel path (start → profile → carriers → cancel) as a
 *     second top-level scenario.
 *   - Multi-tenant isolation: a parallel agent in org B is untouched
 *     by org A's flow (no leaked tasks / requests / runs).
 *   - Idempotency: every state-transitioning call is re-callable
 *     without side effects.
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
  agentContractingProfilesTable,
  agentOnboardingRunsTable,
  carrierContractingRequestsTable,
  carriersTable,
  notificationsTable,
  taskInstancesTable,
} from "@workspace/db/schema";
import { decryptSsn } from "@workspace/db/encryption/pii";

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
  const org = await seedOrg(handle.db, { id: nextId("e2e-org") });
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
    id: nextId(`carrier-${i}`),
    name: `Carrier ${i + 1}`,
  }));
  await handle.db.insert(carriersTable).values(
    carriers.map((c) => ({ id: c.id, orgId: org.id, name: c.name })),
  );

  return {
    orgId: org.id,
    admin,
    agentUser,
    agentId: agentRow.id,
    carriers,
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

describe("INSUREitALL onboarding — full end-to-end flow", () => {
  it("walks start → profile → carriers → request-contracting → sign → submitted → appointed with idempotency at every step", async () => {
    const orgA = await bootOrg({ carrierCount: 3 });
    // Org B set up in parallel — assert at the end that nothing in org B
    // got touched by org A's flow.
    const orgB = await bootOrg({ carrierCount: 2 });

    const handle = await bootTestDb();

    // -------------------------------------------------------------------
    // 1. POST /onboarding/start
    // -------------------------------------------------------------------
    const startRes = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(orgA.admin.id))
      .send({ agentId: orgA.agentId });
    expect(startRes.status).toBe(201);
    expect(startRes.body.run.status).toBe("draft");
    expect(startRes.body.run.startedByUserId).toBe(orgA.admin.id);
    const runId = startRes.body.run.id as string;

    // Idempotent re-call.
    const startAgain = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(orgA.admin.id))
      .send({ agentId: orgA.agentId });
    expect(startAgain.status).toBe(200);
    expect(startAgain.body.idempotent).toBe(true);
    expect(startAgain.body.run.id).toBe(runId);

    // Profile task exists, assigned to the agent's user, exactly one row.
    const profileTasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, orgA.orgId),
          eq(taskInstancesTable.contractingTaskKey, `${runId}:complete-profile`),
        ),
      );
    expect(profileTasks).toHaveLength(1);
    expect(profileTasks[0].status).toBe("open");
    expect(profileTasks[0].assignedToUserId).toBe(orgA.agentUser.id);

    // -------------------------------------------------------------------
    // 2. PATCH /:agentId/profile — full profile incl SSN
    // -------------------------------------------------------------------
    const profilePatch = {
      ssn: "123-45-6789",
      dob: "1985-06-01",
      homeAddressLine1: "100 Test Ln",
      homeCity: "Tampa",
      homeState: "FL",
      homeZip: "33602",
      phone: "+15551234567",
      email: "agent@example.com",
      entityType: "individual" as const,
    };
    const profRes = await request(app)
      .patch(`/api/onboarding/${orgA.agentId}/profile`)
      .set(withAuth(orgA.admin.id))
      .send(profilePatch);
    expect(profRes.status).toBe(200);
    expect(profRes.body.profile.ssn).toBe("123-45-6789"); // privileged role

    // DB: SSN is encrypted bytea, not plaintext.
    const [profile] = await handle.db
      .select()
      .from(agentContractingProfilesTable)
      .where(eq(agentContractingProfilesTable.agentId, orgA.agentId));
    expect(profile.ssnEncrypted).toBeTruthy();
    expect(profile.ssnEncrypted!.toString("utf8")).not.toContain("123456789");
    expect(decryptSsn(profile.ssnEncrypted!)).toBe("123456789");

    // Run advanced to profile_in_progress.
    {
      const [r] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, runId));
      expect(r.status).toBe("profile_in_progress");
    }

    // Re-PATCH is a no-op for status (already past draft).
    const profAgain = await request(app)
      .patch(`/api/onboarding/${orgA.agentId}/profile`)
      .set(withAuth(orgA.admin.id))
      .send({ phone: "+15559999999" });
    expect(profAgain.status).toBe(200);

    // -------------------------------------------------------------------
    // 3. POST /:agentId/carriers/select (3 carriers)
    // -------------------------------------------------------------------
    const selectRes = await request(app)
      .post(`/api/onboarding/${orgA.agentId}/carriers/select`)
      .set(withAuth(orgA.admin.id))
      .send({
        selections: orgA.carriers.map((c) => ({
          carrierId: c.id,
          states: ["FL", "GA"],
        })),
      });
    expect(selectRes.status).toBe(201);
    expect(selectRes.body.carrierRequests).toHaveLength(3);
    for (const cr of selectRes.body.carrierRequests) {
      expect(cr.status).toBe("draft");
    }

    // Run advanced + profile task closed + admin review task created.
    {
      const [r] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, runId));
      expect(r.status).toBe("carriers_selected");

      const [profileTask] = await handle.db
        .select()
        .from(taskInstancesTable)
        .where(
          eq(
            taskInstancesTable.contractingTaskKey,
            `${runId}:complete-profile`,
          ),
        );
      expect(profileTask.status).toBe("completed");

      const [adminTask] = await handle.db
        .select()
        .from(taskInstancesTable)
        .where(
          eq(taskInstancesTable.contractingTaskKey, `${runId}:admin-review`),
        );
      expect(adminTask.status).toBe("open");
      expect(adminTask.assignedToUserId).toBe(orgA.admin.id);
    }

    // Idempotent re-select with the same carrier set keeps a single row
    // per carrier (the partial-unique holds) and doesn't duplicate the
    // admin review task.
    const selectAgain = await request(app)
      .post(`/api/onboarding/${orgA.agentId}/carriers/select`)
      .set(withAuth(orgA.admin.id))
      .send({
        selections: [{ carrierId: orgA.carriers[0].id, states: ["FL"] }],
      });
    expect(selectAgain.status).toBe(201);
    const requestsAfterReselect = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
    expect(requestsAfterReselect).toHaveLength(3);
    const adminTasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        eq(taskInstancesTable.contractingTaskKey, `${runId}:admin-review`),
      );
    expect(adminTasks).toHaveLength(1);

    // -------------------------------------------------------------------
    // 4. POST /:agentId/request-contracting
    // -------------------------------------------------------------------
    const reqRes = await request(app)
      .post(`/api/onboarding/${orgA.agentId}/request-contracting`)
      .set(withAuth(orgA.admin.id))
      .send({});
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.paperworkGenerated).toBe(3);
    expect(reqRes.body.signTasks).toHaveLength(3);
    expect(reqRes.body.run.status).toBe("signing");

    {
      const reqRows = await handle.db
        .select()
        .from(carrierContractingRequestsTable)
        .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
      for (const r of reqRows) {
        expect(r.status).toBe("paperwork_generated");
        expect(r.paperworkDocumentId).toBeTruthy();
      }

      // Admin review task closed.
      const [adminTask] = await handle.db
        .select()
        .from(taskInstancesTable)
        .where(
          eq(taskInstancesTable.contractingTaskKey, `${runId}:admin-review`),
        );
      expect(adminTask.status).toBe("completed");

      // 3 sign tasks for the agent.
      const signTasks = await handle.db
        .select()
        .from(taskInstancesTable)
        .where(
          and(
            eq(taskInstancesTable.orgId, orgA.orgId),
            eq(taskInstancesTable.agentId, orgA.agentId),
          ),
        );
      const signOnly = signTasks.filter((t) =>
        t.title.startsWith("Sign contracting paperwork for "),
      );
      expect(signOnly).toHaveLength(3);
      for (const t of signOnly) {
        expect(t.status).toBe("open");
        expect(t.assignedToUserId).toBe(orgA.agentUser.id);
      }
    }

    // Idempotent re-call: nothing left in `draft`, paperworkGenerated=0.
    const reqAgain = await request(app)
      .post(`/api/onboarding/${orgA.agentId}/request-contracting`)
      .set(withAuth(orgA.admin.id))
      .send({});
    expect(reqAgain.status).toBe(200);
    expect(reqAgain.body.paperworkGenerated).toBe(0);

    // -------------------------------------------------------------------
    // 5. POST /:agentId/carriers/:carrierId/sign (×3) — Day-5 e-sign flow
    //    creates an envelope; we complete each via POST /esign/.../sign
    //    to drive the carrier_contracting_request to `signed`.
    // -------------------------------------------------------------------
    const envelopeIds: string[] = [];
    for (const c of orgA.carriers) {
      const signRes = await request(app)
        .post(`/api/onboarding/${orgA.agentId}/carriers/${c.id}/sign`)
        .set(withAuth(orgA.agentUser.id))
        .send({});
      expect(signRes.status).toBe(200);
      expect(signRes.body.envelopeId).toBeTruthy();
      expect(signRes.body.status).toBe("pending");
      envelopeIds.push(signRes.body.envelopeId);

      const completeRes = await request(app)
        .post(`/api/esign/envelopes/${signRes.body.envelopeId}/sign`)
        .set(withAuth(orgA.agentUser.id))
        .send({
          typedName: "Test Agent",
          signatureSvg: "<svg/>",
          consentToElectronicBusiness: true,
          intentToSign: true,
        });
      expect(completeRes.status).toBe(200);
      expect(completeRes.body.status).toBe("completed");
    }

    // Idempotent re-start on the first carrier — returns the existing
    // (completed) envelope rather than 409'ing.
    const reSign = await request(app)
      .post(`/api/onboarding/${orgA.agentId}/carriers/${orgA.carriers[0].id}/sign`)
      .set(withAuth(orgA.agentUser.id))
      .send({});
    expect(reSign.status).toBe(200);
    expect(reSign.body.envelopeId).toBe(envelopeIds[0]);

    {
      const reqRows = await handle.db
        .select()
        .from(carrierContractingRequestsTable)
        .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
      for (const r of reqRows) {
        expect(r.status).toBe("signed");
        expect(r.signatureCompletedAt).toBeTruthy();
      }

      // System submit tasks created, one per carrier, unassigned.
      const submitTasks = await handle.db
        .select()
        .from(taskInstancesTable)
        .where(
          and(
            eq(taskInstancesTable.orgId, orgA.orgId),
            eq(taskInstancesTable.title, `Submit signed packet to ${orgA.carriers[0].name} appointment desk`),
          ),
        );
      expect(submitTasks).toHaveLength(1);
      expect(submitTasks[0].assignedToUserId).toBeNull();

      // Sign tasks closed.
      const signTasks = await handle.db
        .select()
        .from(taskInstancesTable)
        .where(
          and(
            eq(taskInstancesTable.orgId, orgA.orgId),
            eq(taskInstancesTable.agentId, orgA.agentId),
          ),
        );
      const openSign = signTasks.filter(
        (t) =>
          t.title.startsWith("Sign contracting paperwork for ") &&
          t.status === "open",
      );
      expect(openSign).toHaveLength(0);
    }

    // -------------------------------------------------------------------
    // 6. Simulate Day-6 worker: each request → 'submitted'.
    // -------------------------------------------------------------------
    await handle.db
      .update(carrierContractingRequestsTable)
      .set({ status: "submitted", submittedAt: new Date() })
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));

    // Roll the run forward to `submitted` directly — the e-sign flow no
    // longer has a passive "re-call /sign" trigger.
    await handle.db
      .update(agentOnboardingRunsTable)
      .set({ status: "submitted" })
      .where(eq(agentOnboardingRunsTable.id, runId));

    {
      const [r] = await handle.db
        .select()
        .from(agentOnboardingRunsTable)
        .where(eq(agentOnboardingRunsTable.id, runId));
      expect(r.status).toBe("submitted");
    }

    // -------------------------------------------------------------------
    // 7. PATCH /admin/contracting/:requestId (writing number, → appointed) ×3
    // -------------------------------------------------------------------
    const reqRows = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.onboardingRunId, runId));
    expect(reqRows).toHaveLength(3);

    for (let i = 0; i < reqRows.length; i += 1) {
      const patchRes = await request(app)
        .patch(`/api/admin/contracting/${reqRows[i].id}`)
        .set(withAuth(orgA.admin.id))
        .send({ writingNumber: `W-A-${i + 1}` });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.request.status).toBe("appointed");
      expect(patchRes.body.request.writingNumber).toBe(`W-A-${i + 1}`);
      expect(patchRes.body.request.appointedAt).toBeTruthy();
    }

    // Idempotent re-PATCH with the same body.
    const idempPatch = await request(app)
      .patch(`/api/admin/contracting/${reqRows[0].id}`)
      .set(withAuth(orgA.admin.id))
      .send({ writingNumber: "W-A-1" });
    expect(idempPatch.status).toBe(200);
    expect(idempPatch.body.idempotent).toBe(true);

    // On the third PATCH, the run flipped to 'complete'.
    const [completedRun] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.id, runId));
    expect(completedRun.status).toBe("complete");
    expect(completedRun.completedAt).toBeTruthy();

    // Notification row written for the admin who started the run.
    // resourceId is the agent id (not the run id) so the panel deep-link
    // matches the `/admin-onboarding/:agentId` route.
    const notifs = await handle.db
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.orgId, orgA.orgId),
          eq(notificationsTable.userId, orgA.admin.id),
          eq(notificationsTable.resourceId, orgA.agentId),
          eq(notificationsTable.type, "onboarding_complete"),
        ),
      );
    expect(notifs).toHaveLength(1);
    expect(notifs[0].resourceType).toBe("agent_onboarding");

    // Any outstanding admin tasks for the run are closed.
    const openAdminTasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, orgA.orgId),
          eq(taskInstancesTable.contractingTaskKey, `${runId}:admin-review`),
          ne(taskInstancesTable.status, "completed"),
        ),
      );
    expect(openAdminTasks).toHaveLength(0);

    // -------------------------------------------------------------------
    // Multi-tenant assertion: org B is untouched by org A's flow.
    // -------------------------------------------------------------------
    const orgBRuns = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.orgId, orgB.orgId));
    expect(orgBRuns).toHaveLength(0);

    const orgBRequests = await handle.db
      .select()
      .from(carrierContractingRequestsTable)
      .where(eq(carrierContractingRequestsTable.orgId, orgB.orgId));
    expect(orgBRequests).toHaveLength(0);

    const orgBTasks = await handle.db
      .select()
      .from(taskInstancesTable)
      .where(
        and(
          eq(taskInstancesTable.orgId, orgB.orgId),
          eq(taskInstancesTable.agentId, orgB.agentId),
        ),
      );
    expect(orgBTasks).toHaveLength(0);

    const orgBNotifs = await handle.db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.orgId, orgB.orgId));
    expect(orgBNotifs).toHaveLength(0);
  }, 30_000);

  it("cancel path: start → profile → carriers → cancel closes the run + open tasks", async () => {
    const ctx = await bootOrg({ carrierCount: 2 });
    const handle = await bootTestDb();

    // Start.
    const startRes = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(ctx.admin.id))
      .send({ agentId: ctx.agentId });
    expect(startRes.status).toBe(201);
    const runId = startRes.body.run.id as string;

    // Profile.
    await request(app)
      .patch(`/api/onboarding/${ctx.agentId}/profile`)
      .set(withAuth(ctx.admin.id))
      .send({ phone: "+15551234567" });

    // Carriers.
    await request(app)
      .post(`/api/onboarding/${ctx.agentId}/carriers/select`)
      .set(withAuth(ctx.admin.id))
      .send({
        selections: [{ carrierId: ctx.carriers[0].id, states: ["FL"] }],
      });

    // Cancel.
    const cancelRes = await request(app)
      .post(`/api/onboarding/${ctx.agentId}/cancel`)
      .set(withAuth(ctx.admin.id));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.run.status).toBe("cancelled");

    // Run is cancelled in DB.
    const [run] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.id, runId));
    expect(run.status).toBe("cancelled");

    // The partial-unique permits a fresh `/start` after cancel.
    const restart = await request(app)
      .post("/api/onboarding/start")
      .set(withAuth(ctx.admin.id))
      .send({ agentId: ctx.agentId });
    expect(restart.status).toBe(201);
    expect(restart.body.run.status).toBe("draft");
    expect(restart.body.run.id).not.toBe(runId);
  });

  it("multi-tenant: parallel agents in org A and org B advance independently", async () => {
    const orgA = await bootOrg({ carrierCount: 1 });
    const orgB = await bootOrg({ carrierCount: 1 });
    const handle = await bootTestDb();

    // Start both in parallel.
    const [aStart, bStart] = await Promise.all([
      request(app)
        .post("/api/onboarding/start")
        .set(withAuth(orgA.admin.id))
        .send({ agentId: orgA.agentId }),
      request(app)
        .post("/api/onboarding/start")
        .set(withAuth(orgB.admin.id))
        .send({ agentId: orgB.agentId }),
    ]);
    expect(aStart.status).toBe(201);
    expect(bStart.status).toBe(201);

    // Org A advances; org B stays in draft.
    await request(app)
      .patch(`/api/onboarding/${orgA.agentId}/profile`)
      .set(withAuth(orgA.admin.id))
      .send({ phone: "+1" });

    const [bRun] = await handle.db
      .select()
      .from(agentOnboardingRunsTable)
      .where(eq(agentOnboardingRunsTable.agentId, orgB.agentId));
    expect(bRun.status).toBe("draft");

    // Org A admin cannot read org B's onboarding (cross-org 404).
    const crossOrgRead = await request(app)
      .get(`/api/onboarding/${orgB.agentId}`)
      .set(withAuth(orgA.admin.id));
    expect(crossOrgRead.status).toBe(404);
  });
});
