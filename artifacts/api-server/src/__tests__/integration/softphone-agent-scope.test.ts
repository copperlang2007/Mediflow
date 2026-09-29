/**
 * The plain `agent` role may open the softphone and dial ITS OWN assigned
 * contacts - and nothing else. The softphone read endpoints are self-scoped:
 * only contacts assigned to the caller's own linked, ACTIVE agent profile (same
 * org), and only dialer fields (never MBI / Medicare ID, birth date, health
 * data). The general /contacts routes stay closed to agents, an unlinked or
 * non-active agent fails closed, and back-office behaviour is unchanged.
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

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";
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
let unlinkedUser: { id: string };
let inactiveUser: { id: string };
let agent: { id: string };
let peer: { id: string };
let mine: { id: string };
let peers: { id: string };
let foreign: { id: string };
let unassigned: { id: string };

const MBI = "1EG4TE5MK73";
const MINE_PHONE = "(503) 555-2001";
const PEER_PHONE = "(503) 555-2002";

async function contact(orgId: string, first: string, phone: string, assignedAgentId: string | null) {
  const c = await seedContact(db, {
    orgId,
    firstName: first,
    lastName: "Scope",
    email: `${first.toLowerCase()}@example.com`,
    dob: new Date("1950-02-03"),
    medicareId: MBI,
    healthConditions: ["diabetes"],
    status: "enrolled",
  });
  await db
    .update(schema.contactsTable)
    .set({ phone, stateCode: "OR", zipCode: "97201", assignedAgentId })
    .where(eq(schema.contactsTable.id, c.id));
  return c;
}

async function callLog(contactId: string, userId: string, body: string) {
  await db.insert(schema.activitiesTable).values({
    id: randomUUID(), orgId: org.id, contactId, type: "call_log", body,
    metadata: { disposition: "POSITIVE", direction: "outbound", transcript: "SECRET-TRANSCRIPT" },
    createdBy: userId,
  });
}

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(db, { id: "sp-org" });
  otherOrg = await seedOrg(db, { id: "sp-other-org" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  agentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  peerUser = await seedUser(db, { orgId: org.id, role: "agent" });
  unlinkedUser = await seedUser(db, { orgId: org.id, role: "agent" });
  inactiveUser = await seedUser(db, { orgId: org.id, role: "agent" });

  agent = await seedAgent(db, { orgId: org.id, firstName: "Sam", lastName: "Own" });
  peer = await seedAgent(db, { orgId: org.id, firstName: "Pat", lastName: "Peer" });
  const inactive = await seedAgent(db, { orgId: org.id, firstName: "Ivy", lastName: "Idle" });
  await db.update(schema.agentsTable).set({ userId: agentUser.id, status: "active" }).where(eq(schema.agentsTable.id, agent.id));
  await db.update(schema.agentsTable).set({ userId: peerUser.id, status: "active" }).where(eq(schema.agentsTable.id, peer.id));
  await db.update(schema.agentsTable).set({ userId: inactiveUser.id, status: "suspended" }).where(eq(schema.agentsTable.id, inactive.id));

  mine = await contact(org.id, "Mine", MINE_PHONE, agent.id);
  peers = await contact(org.id, "Peers", PEER_PHONE, peer.id);
  unassigned = await contact(org.id, "Nobody", "(503) 555-2003", null);
  foreign = await contact(otherOrg.id, "Foreign", MINE_PHONE, null);

  await callLog(mine.id, agentUser.id, "Outbound call completed");
  await callLog(peers.id, peerUser.id, "Peer call");
  await callLog(mine.id, peerUser.id, "Peer note on my contact");
});

afterAll(async () => {
  await shutdownTestDb();
});

const get = (path: string, userId: string) => request(app).get(`/api${path}`).set(withAuth(userId));

function assertNoSensitive(body: unknown): void {
  const text = JSON.stringify(body);
  for (const k of ["medicare", "mbi", "dob", "birth", "healthCondition", "diabetes", MBI, "1950-02-03", "SECRET-TRANSCRIPT"]) {
    expect(text.toLowerCase()).not.toContain(k.toLowerCase());
  }
}

describe("agent softphone - own assigned contacts only", () => {
  it("lookup returns only my assigned contact, dialer fields only", async () => {
    const res = await get("/softphone/lookup?phone=5035552001", agentUser.id);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ["assignedAgentId", "currentPlanType", "email", "firstName", "id", "lastName", "phone", "stateCode", "status", "zipCode"],
    );
    expect(res.body.data[0].email).toBeNull();
    assertNoSensitive(res.body);
  });

  it("lookup never finds a peer's, an unassigned or another org's contact", async () => {
    for (const phone of ["5035552002", "5035552003"]) {
      const res = await get(`/softphone/lookup?phone=${phone}`, agentUser.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
    // Same number exists in another org; only my own org's assigned row comes back.
    const same = await get("/softphone/lookup?phone=5035552001", agentUser.id);
    expect(same.body.data.map((c: { id: string }) => c.id)).not.toContain(foreign.id);
  });

  it("contact search is self-scoped and free of sensitive fields", async () => {
    const res = await get("/softphone/contacts?search=Scope", agentUser.id);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    assertNoSensitive(res.body);
    // Cannot search by email (a back-office-only matcher) or by wildcard.
    const byEmail = await get("/softphone/contacts?search=peers@example.com", agentUser.id);
    expect(byEmail.body.data).toEqual([]);
    const wild = await get("/softphone/contacts?search=%25%25", agentUser.id);
    expect(wild.body.data).toEqual([]);
    const byPhone = await get("/softphone/contacts?search=555-2002", agentUser.id);
    expect(byPhone.body.data).toEqual([]);
  });

  it("contact by id: mine 200, peer / unassigned / foreign 404", async () => {
    const ok = await get(`/softphone/contacts/${mine.id}`, agentUser.id);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(mine.id);
    assertNoSensitive(ok.body);
    for (const c of [peers, unassigned, foreign]) {
      expect((await get(`/softphone/contacts/${c.id}`, agentUser.id)).status).toBe(404);
    }
  });

  it("precheck works for my contact and 404s for anyone else's", async () => {
    const ok = await get(`/softphone/precheck?contactId=${mine.id}`, agentUser.id);
    expect(ok.status).toBe(200);
    expect(ok.body.agent).toMatchObject({ id: agent.id, source: "you" });
    assertNoSensitive(ok.body);
    for (const c of [peers, unassigned, foreign]) {
      expect((await get(`/softphone/precheck?contactId=${c.id}`, agentUser.id)).status).toBe(404);
    }
    // Cannot borrow another agent's licensing.
    const forged = await get(`/softphone/precheck?contactId=${mine.id}&agentId=${peer.id}`, agentUser.id);
    expect(forged.status).toBe(404);
  });

  it("recent calls: only my own calls on my contacts, metadata reduced", async () => {
    const res = await get("/softphone/recent-calls", agentUser.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ contactId: mine.id, body: "Outbound call completed" });
    expect(res.body.data[0].metadata).toEqual({ disposition: "POSITIVE", direction: "outbound" });
    assertNoSensitive(res.body);
  });

  it("dispositions load", async () => {
    const res = await get("/softphone/dispositions", agentUser.id);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("calls list still shows only my sessions and hides names of contacts not assigned to me", async () => {
    await db.insert(schema.callSessionsTable).values({
      id: randomUUID(), orgId: org.id, contactId: peers.id, userId: agentUser.id, agentId: agent.id,
      direction: "outbound", status: "completed", toNumber: "+15035552002", consentBasis: "test",
    } as never);
    const res = await get("/softphone/calls", agentUser.id);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: { contactId: string }) => r.contactId === peers.id);
    expect(row.firstName).toBeNull();
    expect(row.lastName).toBeNull();
  });

  it("placing a call to a peer's contact is still refused", async () => {
    const res = await request(app).post("/api/softphone/calls").set(withAuth(agentUser.id)).send({ contactId: peers.id });
    expect(res.status).toBe(404);
  });
});

describe("agent still cannot use the general contact routes", () => {
  it.each([
    ["/contacts"],
    [`/contacts/${"MINE"}`],
    [`/contacts/${"MINE"}/activities`],
    [`/contacts/${"MINE"}/call-summaries`],
    ["/client-portal/preview/MINE"],
  ])("GET %s -> 403", async (path) => {
    const res = await get(path.replace("MINE", mine.id), agentUser.id);
    expect(res.status).toBe(403);
  });
});

describe("fail closed", () => {
  it("unlinked agent gets 404 on every softphone read route", async () => {
    for (const path of [
      "/softphone/lookup?phone=5035552001",
      "/softphone/contacts?search=Scope",
      `/softphone/contacts/${mine.id}`,
      `/softphone/precheck?contactId=${mine.id}`,
      "/softphone/recent-calls",
      "/softphone/dispositions",
    ]) {
      const res = await get(path, unlinkedUser.id);
      expect(res.status, path).toBe(404);
      assertNoSensitive(res.body);
    }
  });

  it("non-active agent gets 409 on every softphone read route", async () => {
    for (const path of [
      "/softphone/lookup?phone=5035552001",
      "/softphone/contacts?search=Scope",
      `/softphone/contacts/${mine.id}`,
      `/softphone/precheck?contactId=${mine.id}`,
      "/softphone/recent-calls",
      "/softphone/dispositions",
    ]) {
      const res = await get(path, inactiveUser.id);
      expect(res.status, path).toBe(409);
    }
  });

  it("an agent linked to a profile in ANOTHER org is treated as unlinked", async () => {
    const stray = await seedUser(db, { orgId: org.id, role: "agent" });
    const other = await seedAgent(db, { orgId: otherOrg.id });
    await db.update(schema.agentsTable).set({ userId: stray.id, status: "active" }).where(eq(schema.agentsTable.id, other.id));
    expect((await get("/softphone/recent-calls", stray.id)).status).toBe(404);
  });

  it("viewer keeps its existing contact:read access to the dialer lookups", async () => {
    const viewer = await seedUser(db, { orgId: org.id, role: "viewer" });
    // viewer has contact:read (unchanged); developer likewise; both never call.
    expect((await get("/softphone/dispositions", viewer.id)).status).toBe(200);
  });

  it("unauthenticated is rejected", async () => {
    expect((await request(app).get("/api/softphone/contacts?search=Scope")).status).toBe(401);
  });
});

describe("back office unchanged", () => {
  it("admin lookup sees every org contact for the number, incl. email, not sensitive fields", async () => {
    const res = await get("/softphone/lookup?phone=5035552002", admin.id);
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { id: string }) => c.id)).toEqual([peers.id]);
    expect(res.body.data[0].email).toBe("peers@example.com");
    assertNoSensitive(res.body);
  });

  it("admin contact search covers unassigned and other agents' contacts, but not other orgs", async () => {
    const res = await get("/softphone/contacts?search=Scope", admin.id);
    const ids = res.body.data.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([mine.id, peers.id, unassigned.id].sort());
    assertNoSensitive(res.body);
  });

  it("admin recent calls still list every agent's calls", async () => {
    const res = await get("/softphone/recent-calls", admin.id);
    expect(res.body.data.length).toBe(3);
  });

  it("admin precheck may still name another agent", async () => {
    const res = await get(`/softphone/precheck?contactId=${mine.id}&agentId=${peer.id}`, admin.id);
    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({ id: peer.id, source: "requested" });
  });
});
