/**
 * Integration tests for the agent activity leaderboard / scorecard
 * (routes/agentLeaderboard.ts + lib/agents/leaderboard.ts).
 *
 * Ranks the org's active agents by inbound-routing activity over a rolling
 * window. Verifies the per-agent metrics (inbounds routed, callbacks resolved,
 * open leads), the window filter (out-of-window routed rows excluded), the
 * ranking order (inboundsRouted desc, openLeads asc, lastName), the
 * readyToSell flag, and the permission gate (an `agent` role lacks
 * `agent:read` → 403).
 *
 * A deterministic `now` is achieved by seeding routing/callback rows with
 * explicit `createdAt`/`resolvedAt` offsets relative to a fixed clock and
 * requesting a window that straddles them.
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
import {
  carriersTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  agentsTable,
  leadRoutingTable,
  leadCallbacksTable,
  leadsTable,
  contactsTable,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { AgentLeaderboardEntry } from "../../lib/agents/leaderboard";

import type { Express } from "express";
import { sellingPlanYear } from "../../lib/compliance/planYear";

// Credentials must be for the plan year being sold (flips to next year on Oct 1).
const YEAR = sellingPlanYear();
const FUTURE = new Date(`${YEAR + 1}-01-01T00:00:00Z`);

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let agentRoleUser: { id: string };
let carrierA: { id: string };

// Three active agents with differing activity, plus one inactive (excluded).
let alpha: { id: string }; // most routed (ready)
let bravo: { id: string }; // fewer routed, resolves a callback
let carol: { id: string }; // zero routed in window (had one OUT of window)
let inactiveAgent: { id: string }; // excluded from the ranking

// Helpers ------------------------------------------------------------------

async function activate(agentId: string): Promise<void> {
  await testDb
    .update(agentsTable)
    .set({ status: "active" })
    .where(eq(agentsTable.id, agentId));
}

async function makeReady(agentId: string): Promise<void> {
  await activate(agentId);
  await testDb.insert(stateLicensesTable).values({
    id: `lic-${randomUUID()}`,
    agentId,
    stateCode: "FL",
    licenseType: "health",
    status: "active",
    expiryDate: FUTURE,
  });
  await testDb.insert(carrierCertificationsTable).values({
    id: `cert-${randomUUID()}`,
    agentId,
    carrierId: carrierA.id,
    certificationYear: YEAR,
    status: "passed",
    expiryDate: FUTURE,
  });
  await testDb.insert(ahipRecordsTable).values({
    id: `ahip-${randomUUID()}`,
    agentId,
    certificationYear: YEAR,
    status: "passed",
  });
}

async function seedRoute(
  agentId: string,
  createdAt: Date,
  status = "routed",
): Promise<void> {
  await testDb.insert(leadRoutingTable).values({
    id: `route-${randomUUID()}`,
    orgId: org.id,
    contactId: null,
    carrierId: carrierA.id,
    stateCode: "FL",
    agentId,
    status,
    createdAt,
  });
}

async function seedCallback(
  resolvedAgentId: string,
  resolvedAt: Date | null,
  status: string,
): Promise<void> {
  await testDb.insert(leadCallbacksTable).values({
    id: `cb-${randomUUID()}`,
    orgId: org.id,
    contactId: null,
    carrierId: carrierA.id,
    stateCode: "FL",
    status,
    slaDueAt: resolvedAt ?? new Date(),
    resolvedAgentId,
    resolvedAt,
  });
}

async function seedOpenLead(
  agentId: string,
  status: "new" | "contacted" | "qualified" | "converted",
): Promise<void> {
  const contactId = `contact-${randomUUID()}`;
  await testDb.insert(contactsTable).values({
    id: contactId,
    orgId: org.id,
    firstName: "Lead",
    lastName: "Contact",
    status: "lead",
  });
  await testDb.insert(leadsTable).values({
    id: `lead-${randomUUID()}`,
    orgId: org.id,
    contactId,
    assignedAgentId: agentId,
    status,
  });
}

function leaderboard(params: Record<string, string> = {}, userId?: string) {
  const qs = new URLSearchParams(params).toString();
  return request(app)
    .get(`/api/agents/leaderboard${qs ? `?${qs}` : ""}`)
    .set(withAuth(userId ?? admin.id));
}

function findAgent(
  body: { data: AgentLeaderboardEntry[] },
  id: string,
): AgentLeaderboardEntry | undefined {
  return body.data.find((a) => a.agentId === id);
}

// Fixed clock: the test seeds rows at offsets from "now" and requests a 168h
// (7d) window, so a row 10 days old falls OUTSIDE while recent rows fall IN.
const HOUR = 60 * 60 * 1000;
const now = new Date();
const oneHourAgo = new Date(now.getTime() - 1 * HOUR);
const twoHoursAgo = new Date(now.getTime() - 2 * HOUR);
const tenDaysAgo = new Date(now.getTime() - 240 * HOUR);

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "lb-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  agentRoleUser = await seedUser(testDb, { orgId: org.id, role: "agent" });

  carrierA = { id: `carrier-${randomUUID()}` };
  await testDb
    .insert(carriersTable)
    .values([{ id: carrierA.id, orgId: org.id, name: "Acme Health" }]);

  // Alpha — ready, 3 routed in window, 2 open leads.
  alpha = await seedAgent(testDb, { orgId: org.id, lastName: "Alpha" });
  await makeReady(alpha.id);
  await seedRoute(alpha.id, oneHourAgo);
  await seedRoute(alpha.id, twoHoursAgo);
  await seedRoute(alpha.id, oneHourAgo);
  await seedOpenLead(alpha.id, "new");
  await seedOpenLead(alpha.id, "qualified");
  await seedOpenLead(alpha.id, "converted"); // closed → NOT counted

  // Bravo — active but NOT ready (no creds), 1 routed in window, resolves a
  // callback, 0 open leads.
  bravo = await seedAgent(testDb, { orgId: org.id, lastName: "Bravo" });
  await activate(bravo.id);
  await seedRoute(bravo.id, oneHourAgo);
  await seedCallback(bravo.id, oneHourAgo, "resolved");
  await seedCallback(bravo.id, null, "open"); // not resolved → NOT counted

  // Carol — active, ZERO routed in window (one route 10 days ago, out of
  // window), 1 open lead. Ties at 0 with anyone, ranked by openLeads then name.
  carol = await seedAgent(testDb, { orgId: org.id, lastName: "Carol" });
  await activate(carol.id);
  await seedRoute(carol.id, tenDaysAgo);
  await seedOpenLead(carol.id, "contacted");

  // Inactive agent — has a routed row but is excluded from the leaderboard.
  inactiveAgent = await seedAgent(testDb, {
    orgId: org.id,
    lastName: "Zinactive",
  });
  await seedRoute(inactiveAgent.id, oneHourAgo);
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("GET /agents/leaderboard — per-agent metrics", () => {
  it("counts inbounds routed within the window", async () => {
    const res = await leaderboard({ sinceHours: "168" });
    expect(res.status).toBe(200);
    expect(findAgent(res.body, alpha.id)!.inboundsRouted).toBe(3);
    expect(findAgent(res.body, bravo.id)!.inboundsRouted).toBe(1);
    // Carol's only route is 10 days old — outside the 7d window.
    expect(findAgent(res.body, carol.id)!.inboundsRouted).toBe(0);
  });

  it("counts only resolved callbacks within the window", async () => {
    const res = await leaderboard({ sinceHours: "168" });
    // Bravo resolved one; the second callback is still open.
    expect(findAgent(res.body, bravo.id)!.callbacksResolved).toBe(1);
    expect(findAgent(res.body, alpha.id)!.callbacksResolved).toBe(0);
  });

  it("counts current open leads (point-in-time, excludes closed)", async () => {
    const res = await leaderboard({ sinceHours: "168" });
    // Alpha has new + qualified open; the converted one does not count.
    expect(findAgent(res.body, alpha.id)!.openLeads).toBe(2);
    expect(findAgent(res.body, bravo.id)!.openLeads).toBe(0);
    expect(findAgent(res.body, carol.id)!.openLeads).toBe(1);
  });

  it("surfaces the readyToSell flag from the readiness read model", async () => {
    const res = await leaderboard({ sinceHours: "168" });
    expect(findAgent(res.body, alpha.id)!.readyToSell).toBe(true);
    // Bravo is active but has no credentials.
    expect(findAgent(res.body, bravo.id)!.readyToSell).toBe(false);
  });

  it("excludes inactive agents from the ranking", async () => {
    const res = await leaderboard({ sinceHours: "168" });
    expect(findAgent(res.body, inactiveAgent.id)).toBeUndefined();
    expect(res.body.data).toHaveLength(3);
    expect(res.body.sinceHours).toBe(168);
    expect(typeof res.body.asOf).toBe("string");
  });
});

describe("GET /agents/leaderboard — window filter", () => {
  it("excludes routed rows older than the window", async () => {
    // A 1h window still captures the recent routes but Carol's 10-day-old one
    // stays excluded; tightening the window does not resurrect it.
    const res = await leaderboard({ sinceHours: "24" });
    expect(findAgent(res.body, alpha.id)!.inboundsRouted).toBe(3);
    expect(findAgent(res.body, carol.id)!.inboundsRouted).toBe(0);
  });

  it("includes the out-of-window route once the window is wide enough", async () => {
    // 11 days (264h) now includes Carol's 10-day-old route.
    const res = await leaderboard({ sinceHours: "264" });
    expect(findAgent(res.body, carol.id)!.inboundsRouted).toBe(1);
  });
});

describe("GET /agents/leaderboard — ranking order", () => {
  it("ranks by inboundsRouted desc, then openLeads asc, then lastName", async () => {
    const res = await leaderboard({ sinceHours: "168" });
    const ids = res.body.data.map((a: AgentLeaderboardEntry) => a.agentId);
    // Alpha (3) > Bravo (1) > Carol (0).
    expect(ids).toEqual([alpha.id, bravo.id, carol.id]);
    expect(res.body.data.map((a: AgentLeaderboardEntry) => a.rank)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("GET /agents/leaderboard — permission gate", () => {
  it("403s for an `agent` role (lacks agent:read)", async () => {
    const res = await leaderboard({}, agentRoleUser.id);
    expect(res.status).toBe(403);
  });

  it("200s for an allowed role (agency_admin)", async () => {
    const res = await leaderboard();
    expect(res.status).toBe(200);
  });
});
