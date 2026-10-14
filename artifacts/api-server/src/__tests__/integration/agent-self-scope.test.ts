/**
 * Agents get SELF-SCOPED access to onboarding and tasks.
 *
 * An `agent` may see and act on ONLY their own onboarding runs and their own
 * tasks — never another agent's, never another org's. Admin behaviour is
 * unchanged and unauthenticated callers are rejected.
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

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentsTable,
  agentOnboardingRunsTable,
  agentContractingProfilesTable,
  taskInstancesTable,
  carriersTable,
  stateLicensesTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;
let db: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let agentUser: { id: string };
let peerUser: { id: string };
let foreignUser: { id: string };
let agent: { id: string };
let peer: { id: string };
let foreign: { id: string };

const T_OWN = `task-own-${randomUUID()}`;
const T_ASSIGNED = `task-assigned-${randomUUID()}`;
const T_PEER = `task-peer-${randomUUID()}`;
const T_FOREIGN = `task-foreign-${randomUUID()}`;

async function linkAgent(agentId: string, userId: string): Promise<void> {
  await db.update(agentsTable).set({ userId }).where(eq(agentsTable.id, agentId));
}

async function run(agentId: string, orgId: string): Promise<string> {
  const id = `run-${randomUUID()}`;
  await db.insert(agentOnboardingRunsTable).values({
    id,
    orgId,
    agentId,
    status: "profile_in_progress",
  });
  return id;
}

async function task(id: string, orgId: string, extra: Record<string, unknown>): Promise<void> {
  await db.insert(taskInstancesTable).values({
    id,
    orgId,
    title: `title-${id}`,
    ...extra,
  } as typeof taskInstancesTable.$inferInsert);
}

const C_OWN = `carrier-own-${randomUUID()}`;
const C_FOREIGN = `carrier-foreign-${randomUUID()}`;
const L_OWN = `lic-own-${randomUUID()}`;
const L_PEER = `lic-peer-${randomUUID()}`;
let unlinkedUser: { id: string };

let ownRun: string;
let peerRun: string;
let foreignRun: string;

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default; // eslint-disable-line @typescript-eslint/no-explicit-any

  org = await seedOrg(db, { id: "self-scope-org" });
  otherOrg = await seedOrg(db, { id: "self-scope-other-org" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  agentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  peerUser = await seedUser(db, { orgId: org.id, role: "agent" });
  foreignUser = await seedUser(db, { orgId: otherOrg.id, role: "agent" });

  agent = await seedAgent(db, { orgId: org.id, lastName: "Own" });
  peer = await seedAgent(db, { orgId: org.id, lastName: "Peer" });
  foreign = await seedAgent(db, { orgId: otherOrg.id, lastName: "Foreign" });
  await linkAgent(agent.id, agentUser.id);
  await linkAgent(peer.id, peerUser.id);
  await linkAgent(foreign.id, foreignUser.id);

  ownRun = await run(agent.id, org.id);
  await db.insert(agentContractingProfilesTable).values({ agentId: agent.id, orgId: org.id });
  peerRun = await run(peer.id, org.id);
  foreignRun = await run(foreign.id, otherOrg.id);

  unlinkedUser = await seedUser(db, { orgId: org.id, role: "agent" }); // deliberately NOT linked
  await db.insert(carriersTable).values([
    {
      id: C_OWN,
      orgId: org.id,
      name: "Own Org Carrier",
      appointmentDeskEmail: "desk@carrier.example",
      appointmentDeskMetadata: { subject: "internal" },
    },
    { id: C_FOREIGN, orgId: otherOrg.id, name: "Foreign Org Carrier" },
  ]);
  await db.insert(stateLicensesTable).values([
    { id: L_OWN, agentId: agent.id, stateCode: "FL", licenseType: "Health", status: "active" },
    { id: L_PEER, agentId: peer.id, stateCode: "GA", licenseType: "Health", status: "active" },
  ]);

  await task(T_OWN, org.id, { agentId: agent.id });
  await task(T_ASSIGNED, org.id, { assignedToUserId: agentUser.id });
  await task(T_PEER, org.id, { agentId: peer.id, assignedToUserId: peerUser.id });
  await task(T_FOREIGN, otherOrg.id, { agentId: foreign.id, assignedToUserId: foreignUser.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("onboarding — agent self-scope", () => {
  it("agent lists only their own onboarding runs", async () => {
    const res = await request(app).get("/api/onboarding").set(withAuth(agentUser.id));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: { id: string }) => r.id);
    expect(ids).toEqual([ownRun]);
    expect(res.body.total).toBe(1);
  });

  it("agent reads their own onboarding run", async () => {
    const res = await request(app).get(`/api/onboarding/${agent.id}`).set(withAuth(agentUser.id));
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(ownRun);
  });

  it("agent can update their own profile", async () => {
    const res = await request(app)
      .patch(`/api/onboarding/${agent.id}/profile`)
      .set(withAuth(agentUser.id))
      .send({ businessName: "Own Agency LLC" });
    expect(res.status).toBe(200);
    expect(res.body.profile.businessName).toBe("Own Agency LLC");
  });

  it("agent cannot read or write another agent's onboarding (same org)", async () => {
    const read = await request(app).get(`/api/onboarding/${peer.id}`).set(withAuth(agentUser.id));
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toContain(peerRun);

    const patch = await request(app)
      .patch(`/api/onboarding/${peer.id}/profile`)
      .set(withAuth(agentUser.id))
      .send({ businessName: "Hijack" });
    expect(patch.status).toBe(404);

    const select = await request(app)
      .post(`/api/onboarding/${peer.id}/carriers/select`)
      .set(withAuth(agentUser.id))
      .send({ carrierIds: [] });
    expect(select.status).toBe(404);
  });

  it("agent cannot read another org's onboarding", async () => {
    const res = await request(app).get(`/api/onboarding/${foreign.id}`).set(withAuth(agentUser.id));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(foreignRun);
  });

  it("agent cannot cancel a run (admin-only action stays admin-only)", async () => {
    const res = await request(app).post(`/api/onboarding/${agent.id}/cancel`).set(withAuth(agentUser.id));
    expect(res.status).toBe(403);
  });

  it("admin still sees every run in their own org (and none from other orgs)", async () => {
    const res = await request(app).get("/api/onboarding").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual([ownRun, peerRun].sort());
    const one = await request(app).get(`/api/onboarding/${peer.id}`).set(withAuth(admin.id));
    expect(one.status).toBe(200);
  });

  it("rejects unauthenticated callers", async () => {
    expect((await request(app).get("/api/onboarding")).status).toBe(401);
    expect((await request(app).get(`/api/onboarding/${agent.id}`)).status).toBe(401);
  });
});

describe("tasks — agent self-scope", () => {
  it("agent lists only their own tasks (own agent id or assigned to them)", async () => {
    const res = await request(app).get("/api/tasks").set(withAuth(agentUser.id));
    expect(res.status).toBe(200);
    const ids = res.body.tasks.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual([T_OWN, T_ASSIGNED].sort());
    expect(res.body.total).toBe(2);
  });

  it("agent cannot widen the list via query filters", async () => {
    const byAgent = await request(app).get(`/api/tasks?agentId=${peer.id}`).set(withAuth(agentUser.id));
    expect(byAgent.status).toBe(200);
    expect(byAgent.body.tasks).toEqual([]);
    const byUser = await request(app)
      .get(`/api/tasks?assignedToUserId=${peerUser.id}`)
      .set(withAuth(agentUser.id));
    expect(byUser.body.tasks).toEqual([]);
  });

  it("agent reads their own /agents/:id/tasks but not another agent's or org's", async () => {
    const own = await request(app).get(`/api/agents/${agent.id}/tasks`).set(withAuth(agentUser.id));
    expect(own.status).toBe(200);
    expect(own.body.data.map((t: { id: string }) => t.id)).toEqual([T_OWN]);
    expect((await request(app).get(`/api/agents/${peer.id}/tasks`).set(withAuth(agentUser.id))).status).toBe(404);
    expect((await request(app).get(`/api/agents/${foreign.id}/tasks`).set(withAuth(agentUser.id))).status).toBe(404);
  });

  it("agent can update the status of their own task", async () => {
    const res = await request(app)
      .patch(`/api/tasks/${T_OWN}`)
      .set(withAuth(agentUser.id))
      .send({ status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    const done = await request(app)
      .patch(`/api/tasks/${T_ASSIGNED}`)
      .set(withAuth(agentUser.id))
      .send({ status: "completed" });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("completed");
  });

  it("agent cannot act on another agent's or another org's task", async () => {
    for (const id of [T_PEER, T_FOREIGN]) {
      const res = await request(app)
        .patch(`/api/tasks/${id}`)
        .set(withAuth(agentUser.id))
        .send({ status: "completed" });
      expect(res.status).toBe(404);
      const [row] = await db.select().from(taskInstancesTable).where(eq(taskInstancesTable.id, id));
      expect(row.status).toBe("open");
    }
  });

  it("agent cannot edit anything but status, nor create/delete tasks, nor touch templates", async () => {
    const edit = await request(app)
      .patch(`/api/tasks/${T_OWN}`)
      .set(withAuth(agentUser.id))
      .send({ assignedToUserId: peerUser.id });
    expect(edit.status).toBe(403);
    const create = await request(app)
      .post("/api/tasks")
      .set(withAuth(agentUser.id))
      .send({ title: "nope" });
    expect(create.status).toBe(403);
    const del = await request(app).delete(`/api/tasks/${T_OWN}`).set(withAuth(agentUser.id));
    expect(del.status).toBe(403);
    expect((await request(app).get("/api/task-templates").set(withAuth(agentUser.id))).status).toBe(403);
    expect(
      (await request(app).patch("/api/task-templates/x").set(withAuth(agentUser.id)).send({ name: "x" })).status,
    ).toBe(403);
  });

  it("admin behaviour is unchanged: sees all org tasks, none from other orgs", async () => {
    const res = await request(app).get("/api/tasks").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const ids = res.body.tasks.map((t: { id: string }) => t.id);
    expect(ids).toEqual(expect.arrayContaining([T_OWN, T_ASSIGNED, T_PEER]));
    expect(ids).not.toContain(T_FOREIGN);
    const patch = await request(app)
      .patch(`/api/tasks/${T_PEER}`)
      .set(withAuth(admin.id))
      .send({ status: "completed" });
    expect(patch.status).toBe(200);
    const cross = await request(app)
      .patch(`/api/tasks/${T_FOREIGN}`)
      .set(withAuth(admin.id))
      .send({ status: "completed" });
    expect(cross.status).toBe(404);
  });

  it("rejects unauthenticated callers", async () => {
    expect((await request(app).get("/api/tasks")).status).toBe(401);
    expect((await request(app).patch(`/api/tasks/${T_OWN}`).send({ status: "completed" })).status).toBe(401);
  });
});

describe("GET /agents/me — agent self lookup", () => {
  it("returns only the caller's own minimal profile", async () => {
    const res = await request(app).get("/api/agents/me").set(withAuth(agentUser.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: agent.id,
      firstName: expect.any(String),
      lastName: "Own",
      status: expect.any(String),
    });
  });

  it("each agent resolves to their own profile, never a peer's or another org's", async () => {
    const peerRes = await request(app).get("/api/agents/me").set(withAuth(peerUser.id));
    expect(peerRes.body.id).toBe(peer.id);
    const foreignRes = await request(app).get("/api/agents/me").set(withAuth(foreignUser.id));
    expect(foreignRes.body.id).toBe(foreign.id);
  });

  it("is agent-role only (admins use the roster) and requires auth", async () => {
    expect((await request(app).get("/api/agents/me").set(withAuth(admin.id))).status).toBe(403);
    expect((await request(app).get("/api/agents/me")).status).toBe(401);
  });

  it("agents still cannot browse the roster or read other agent records", async () => {
    expect((await request(app).get("/api/agents").set(withAuth(agentUser.id))).status).toBe(403);
    expect((await request(app).get(`/api/agents/${peer.id}`).set(withAuth(agentUser.id))).status).toBe(403);
  });
});

describe("GET /carriers — agent read is org-scoped and narrowed", () => {
  it("agent sees own org's carriers without appointment-desk config, none from other orgs", async () => {
    const res = await request(app).get("/api/carriers").set(withAuth(agentUser.id));
    expect(res.status).toBe(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toContain(C_OWN);
    expect(ids).not.toContain(C_FOREIGN);
    const own = res.body.find((c: { id: string }) => c.id === C_OWN);
    expect(own.name).toBe("Own Org Carrier");
    expect(own).not.toHaveProperty("appointmentDeskEmail");
    expect(own).not.toHaveProperty("appointmentDeskMetadata");
  });

  it("admin still gets the full row (org-scoped)", async () => {
    const res = await request(app).get("/api/carriers").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toContain(C_OWN);
    expect(ids).not.toContain(C_FOREIGN);
    expect(res.body.find((c: { id: string }) => c.id === C_OWN).appointmentDeskEmail).toBe("desk@carrier.example");
  });

  it("agents cannot write carriers; unauthenticated is rejected", async () => {
    expect((await request(app).post("/api/carriers").set(withAuth(agentUser.id)).send({ name: "x" })).status).toBe(403);
    expect((await request(app).patch(`/api/carriers/${C_OWN}`).set(withAuth(agentUser.id)).send({ name: "x" })).status).toBe(403);
    expect((await request(app).get("/api/carriers")).status).toBe(401);
  });
});

describe("GET /agents/:id/licenses — agent sees own only", () => {
  it("agent reads their own licenses", async () => {
    const res = await request(app).get(`/api/agents/${agent.id}/licenses`).set(withAuth(agentUser.id));
    expect(res.status).toBe(200);
    expect(res.body.data.map((l: { id: string }) => l.id)).toEqual([L_OWN]);
  });

  it("agent cannot read another agent's (same org) or another org's licenses", async () => {
    const peerRes = await request(app).get(`/api/agents/${peer.id}/licenses`).set(withAuth(agentUser.id));
    expect(peerRes.status).toBe(404);
    expect(JSON.stringify(peerRes.body)).not.toContain(L_PEER);
    expect((await request(app).get(`/api/agents/${foreign.id}/licenses`).set(withAuth(agentUser.id))).status).toBe(404);
  });

  it("agent cannot write licenses; admin unchanged; unauthenticated rejected", async () => {
    const create = await request(app)
      .post(`/api/agents/${agent.id}/licenses`)
      .set(withAuth(agentUser.id))
      .send({ stateCode: "TX", licenseType: "Health" });
    expect(create.status).toBe(403);
    const admRes = await request(app).get(`/api/agents/${peer.id}/licenses`).set(withAuth(admin.id));
    expect(admRes.status).toBe(200);
    expect((await request(app).get(`/api/agents/${foreign.id}/licenses`).set(withAuth(admin.id))).status).toBe(404);
    expect((await request(app).get(`/api/agents/${agent.id}/licenses`)).status).toBe(401);
  });
});

describe("unlinked agent (no agents.user_id row) fails closed", () => {
  it("GET /agents/me is a 404", async () => {
    expect((await request(app).get("/api/agents/me").set(withAuth(unlinkedUser.id))).status).toBe(404);
  });

  it("every agent-scoped path answers 404 for any agent id, including a real peer's", async () => {
    for (const id of [agent.id, peer.id, foreign.id]) {
      expect((await request(app).get(`/api/onboarding/${id}`).set(withAuth(unlinkedUser.id))).status).toBe(404);
      expect((await request(app).get(`/api/agents/${id}/tasks`).set(withAuth(unlinkedUser.id))).status).toBe(404);
      expect((await request(app).get(`/api/agents/${id}/licenses`).set(withAuth(unlinkedUser.id))).status).toBe(404);
    }
    const patch = await request(app)
      .patch(`/api/onboarding/${agent.id}/profile`)
      .set(withAuth(unlinkedUser.id))
      .send({ businessName: "Hijack" });
    expect(patch.status).toBe(404);
  });

  it("onboarding list is empty, not the unfiltered org list", async () => {
    const res = await request(app).get("/api/onboarding").set(withAuth(unlinkedUser.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("tasks are limited to those assigned to the caller (none here), never the org's", async () => {
    const before = await request(app).get("/api/tasks").set(withAuth(unlinkedUser.id));
    expect(before.status).toBe(200);
    expect(before.body.tasks).toEqual([]);
    expect(before.body.total).toBe(0);

    const mine = `task-unlinked-${randomUUID()}`;
    await task(mine, org.id, { assignedToUserId: unlinkedUser.id });
    const after = await request(app).get("/api/tasks").set(withAuth(unlinkedUser.id));
    expect(after.body.tasks.map((t: { id: string }) => t.id)).toEqual([mine]);

    const foreignPatch = await request(app)
      .patch(`/api/tasks/${T_PEER}`)
      .set(withAuth(unlinkedUser.id))
      .send({ status: "completed" });
    expect(foreignPatch.status).toBe(404);
  });
});
