/**
 * Phase 2 of the inbound lead queue:
 *   - carrier-name resolution (id XOR name, ambiguous / not-found)
 *   - the HMAC-authed public route POST /api/queue/v1/route-inbound
 *   - agent presence: heartbeat, the availableOnly filter, the
 *     "presence not configured ⇒ don't filter" fallback, and dialer
 *     call-state events flipping an agent out of the routable pool.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";

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
import {
  carriersTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  agentsTable,
  agentPresenceTable,
  dialTicketsTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";

import type { Express } from "express";

const YEAR = 2026;
const FUTURE = new Date("2027-01-01T00:00:00Z");
const SECRET = "test-queue-secret";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let carrierA: { id: string };

async function makeReadyAgent(
  lastName: string,
  opts: { phone?: string } = {},
): Promise<{ id: string }> {
  const agent = await seedAgent(testDb, { orgId: org.id, lastName });
  await testDb
    .update(agentsTable)
    .set({ status: "active", phone: opts.phone ?? null })
    .where(eq(agentsTable.id, agent.id));
  await testDb.insert(stateLicensesTable).values({
    id: `lic-${randomUUID()}`,
    agentId: agent.id,
    stateCode: "FL",
    licenseType: "health",
    status: "active",
    expiryDate: FUTURE,
  });
  await testDb.insert(carrierCertificationsTable).values({
    id: `cert-${randomUUID()}`,
    agentId: agent.id,
    carrierId: carrierA.id,
    certificationYear: YEAR,
    status: "passed",
    expiryDate: FUTURE,
  });
  await testDb.insert(ahipRecordsTable).values({
    id: `ahip-${randomUUID()}`,
    agentId: agent.id,
    certificationYear: YEAR,
    status: "passed",
  });
  return agent;
}

async function heartbeat(agentId: string, status: string): Promise<void> {
  // Insert directly to avoid needing a Clerk user per agent in these helpers.
  await testDb
    .insert(agentPresenceTable)
    .values({
      agentId,
      orgId: org.id,
      status: status as "available",
      source: "heartbeat",
      lastSeenAt: new Date(),
      expiresAt: status === "offline" ? null : new Date(Date.now() + 60_000),
    })
    .onConflictDoUpdate({
      target: agentPresenceTable.agentId,
      set: {
        status: status as "available",
        expiresAt: status === "offline" ? null : new Date(Date.now() + 60_000),
      },
    });
}

/** Sign a JSON string exactly like the Atlas proxy does. */
function signed(bodyStr: string, secret = SECRET, tOverride?: number) {
  const t = tOverride ?? Math.floor(Date.now() / 1000);
  const v1 = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${bodyStr}`, "utf8")
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

function publicRoute(bodyStr: string, sig: string | null) {
  const req = request(app)
    .post("/api/queue/v1/route-inbound")
    .set("Content-Type", "application/json");
  if (sig) req.set("X-MB-Signature", sig);
  return req.send(bodyStr);
}

beforeAll(async () => {
  process.env.LEAD_QUEUE_WEBHOOK_SECRET = SECRET;
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "lq2-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  carrierA = { id: `carrier-${randomUUID()}` };
  await testDb
    .insert(carriersTable)
    .values({ id: carrierA.id, orgId: org.id, name: "Acme Health" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("carrier-name resolution", () => {
  it("resolves carrierName (case-insensitive) on ready-to-sell", async () => {
    const agent = await makeReadyAgent("CarrierName");
    const res = await request(app)
      .get(
        `/api/queue/ready-to-sell?stateCode=FL&carrierName=acme%20health&certificationYear=${YEAR}`,
      )
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.carrierId).toBe(carrierA.id);
    expect(res.body.data.map((a: { agentId: string }) => a.agentId)).toContain(
      agent.id,
    );
  });

  it("404s an unknown carrier name", async () => {
    const res = await request(app)
      .get(`/api/queue/ready-to-sell?stateCode=FL&carrierName=Nonexistent`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(404);
  });

  it("409s an ambiguous carrier name (two active carriers, same name)", async () => {
    await testDb
      .insert(carriersTable)
      .values({
        id: `carrier-${randomUUID()}`,
        orgId: org.id,
        name: "Dupe Co",
      });
    await testDb
      .insert(carriersTable)
      .values({
        id: `carrier-${randomUUID()}`,
        orgId: org.id,
        name: "Dupe Co",
      });
    const res = await request(app)
      .post("/api/queue/route-inbound")
      .set(withAuth(admin.id))
      .send({
        carrierName: "Dupe Co",
        contactState: "FL",
        certificationYear: YEAR,
      });
    expect(res.status).toBe(409);
  });
});

describe("public HMAC route /api/queue/v1/route-inbound", () => {
  it("routes with a valid signature", async () => {
    await makeReadyAgent("PublicOk", { phone: "+15550001111" });
    const bodyStr = JSON.stringify({
      orgId: org.id,
      carrierId: carrierA.id,
      contactState: "FL",
      certificationYear: YEAR,
      availableOnly: false,
    });
    const res = await publicRoute(bodyStr, signed(bodyStr));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("routed");
    expect(typeof res.body.target_user_id).toBe("string");
  });

  it("rejects a missing signature with 401", async () => {
    const bodyStr = JSON.stringify({
      orgId: org.id,
      carrierId: carrierA.id,
      contactState: "FL",
    });
    const res = await publicRoute(bodyStr, null);
    expect(res.status).toBe(401);
  });

  it("rejects a tampered signature with 401", async () => {
    const bodyStr = JSON.stringify({
      orgId: org.id,
      carrierId: carrierA.id,
      contactState: "FL",
    });
    const res = await publicRoute(bodyStr, signed(bodyStr, "wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("rejects a stale timestamp with 403", async () => {
    const bodyStr = JSON.stringify({
      orgId: org.id,
      carrierId: carrierA.id,
      contactState: "FL",
    });
    const staleT = Math.floor(Date.now() / 1000) - 10_000;
    const res = await publicRoute(bodyStr, signed(bodyStr, SECRET, staleT));
    expect(res.status).toBe(403);
  });
});

describe("presence-aware routing", () => {
  it("heartbeat endpoint records the calling agent's presence", async () => {
    const agentUser = await seedUser(testDb, { orgId: org.id, role: "agent" });
    const agent = await makeReadyAgent("Heartbeater");
    await testDb
      .update(agentsTable)
      .set({ userId: agentUser.id })
      .where(eq(agentsTable.id, agent.id));
    const res = await request(app)
      .post("/api/queue/presence/heartbeat")
      .set(withAuth(agentUser.id))
      .send({ status: "available" });
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(agent.id);
    expect(res.body.status).toBe("available");
  });

  it("availableOnly routes to an available agent and never the absent one", async () => {
    const present = await makeReadyAgent("PresentAgent", {
      phone: "+15552223333",
    });
    const absent = await makeReadyAgent("AbsentAgent", {
      phone: "+15554445555",
    });
    await heartbeat(present.id, "available"); // only this one checks in
    // (`absent` deliberately never heartbeats.)

    const res = await request(app)
      .post("/api/queue/route-inbound")
      .set(withAuth(admin.id))
      .send({
        carrierId: carrierA.id,
        contactState: "FL",
        certificationYear: YEAR,
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("routed");
    expect(res.body.presenceFiltered).toBe(true);
    // The absent (non-checked-in) agent must never be selected; the chosen
    // agent must be one that is actually marked available.
    expect(res.body.target_user_id).not.toBe(absent.id);
    const { getAvailableAgentIds } =
      await import("../../lib/leadQueue/presence");
    const avail = await getAvailableAgentIds(org.id);
    expect(avail.ids).toContain(present.id);
    expect(avail.ids).not.toContain(absent.id);
    expect(avail.ids).toContain(res.body.target_user_id);
  });

  it("a dialer call.in_progress event removes the agent from the pool", async () => {
    const onCall = await makeReadyAgent("OnCallAgent");
    await heartbeat(onCall.id, "available");

    // Seed a dial ticket for this agent, then dispatch the dialer event that
    // the webhook receiver would.
    const ticketId = `ticket-${randomUUID()}`;
    await testDb.insert(dialTicketsTable).values({
      id: ticketId,
      orgId: org.id,
      agentId: onCall.id,
      status: "CALLING",
    });
    const { dispatchEvent } = await import("../../lib/dialer/handlers");
    const result = await dispatchEvent({
      eventId: `evt-${randomUUID()}`,
      type: "call.in_progress",
      orgId: org.id,
      dialTicketId: ticketId,
    });
    expect(result.handled).toBe(true);

    const { getAvailableAgentIds } =
      await import("../../lib/leadQueue/presence");
    const avail = await getAvailableAgentIds(org.id);
    expect(avail.ids).not.toContain(onCall.id);

    // And a terminal event parks them in `wrap` (still not routable).
    await dispatchEvent({
      eventId: `evt-${randomUUID()}`,
      type: "call.completed",
      orgId: org.id,
      dialTicketId: ticketId,
    });
    const after = await getAvailableAgentIds(org.id);
    expect(after.ids).not.toContain(onCall.id);
  });
});
