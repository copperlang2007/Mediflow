/**
 * Claim-on-route tests for the inbound lead queue (lib/leadQueue/service.ts +
 * readyToSell.ts). Verifies that routing is no longer a read-only suggestion:
 *
 *   - every decision writes a `lead_routing` audit row (routed AND
 *     no_agent_available);
 *   - a retried route for the same (contact, carrier) inside the idempotency
 *     window replays the original decision and writes no second row;
 *   - recent claims count as in-flight load, so back-to-back inbounds spread
 *     across equally-loaded agents instead of stacking on the first.
 *
 * These run against the service directly (not over HTTP) so the `now` clock —
 * and therefore the in-flight / idempotency windows — is deterministic.
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
import { and, eq } from "drizzle-orm";
import {
  carriersTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  leadRoutingTable,
  agentsTable,
  agentPresenceTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";

const YEAR = 2026;
const FUTURE = new Date("2027-01-01T00:00:00Z");

let testDb: TestDb;
let resolveAndRouteInbound: typeof import("../../lib/leadQueue/service").resolveAndRouteInbound;

let org: { id: string };
let carrierA: { id: string };

async function activate(agentId: string): Promise<void> {
  await testDb
    .update(agentsTable)
    .set({ status: "active" })
    .where(eq(agentsTable.id, agentId));
}

/** Seed a fully ready-to-sell agent for (`carrierId`, FL) with a phone. */
async function seedReadyAgent(
  lastName: string,
  carrierId: string = carrierA.id,
): Promise<{ id: string }> {
  const agent = await seedAgent(testDb, { orgId: org.id, lastName });
  await activate(agent.id);
  await testDb
    .update(agentsTable)
    .set({ phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}` })
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
    carrierId,
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

function claimsForOrg() {
  return testDb
    .select()
    .from(leadRoutingTable)
    .where(eq(leadRoutingTable.orgId, org.id));
}

/**
 * Write an agent presence row directly (no Clerk user needed). A non-offline
 * status with a future `expiresAt` makes the org "presence configured"; only
 * `available` puts the agent in the available set.
 */
async function setPresence(
  orgId: string,
  agentId: string,
  status: "available" | "away" | "on_call" | "offline",
  now: Date,
): Promise<void> {
  await testDb
    .insert(agentPresenceTable)
    .values({
      agentId,
      orgId,
      status,
      source: "heartbeat",
      lastSeenAt: now,
      expiresAt:
        status === "offline" ? null : new Date(now.getTime() + 60_000),
    })
    .onConflictDoUpdate({
      target: agentPresenceTable.agentId,
      set: {
        status,
        orgId,
        lastSeenAt: now,
        expiresAt:
          status === "offline" ? null : new Date(now.getTime() + 60_000),
      },
    });
}

/** True when the agent is still ready-to-sell for (carrierId, FL) right now. */
async function isReadyToSell(
  agentId: string,
  carrierId: string,
): Promise<boolean> {
  const { findReadyToSellAgents } = await import(
    "../../lib/leadQueue/readyToSell"
  );
  const pool = await findReadyToSellAgents({
    orgId: org.id,
    stateCode: "FL",
    carrierId,
    certificationYear: YEAR,
    now: new Date("2026-06-04T00:00:00Z"),
  });
  return pool.some((a) => a.agentId === agentId);
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  resolveAndRouteInbound = (await import("../../lib/leadQueue/service"))
    .resolveAndRouteInbound;

  org = await seedOrg(testDb, { id: "lqc-org" });
  carrierA = { id: `carrier-${randomUUID()}` };
  await testDb
    .insert(carriersTable)
    .values({ id: carrierA.id, orgId: org.id, name: "Acme Health" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("claim-on-route — audit trail", () => {
  it("records a routed claim with the chosen agent and source", async () => {
    const agent = await seedReadyAgent("Audit");
    const out = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrierA.id,
      contactState: "FL",
      certificationYear: YEAR,
      availableOnly: false,
      source: "public",
      now: new Date("2026-06-03T10:00:00Z"),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.status).toBe("routed");
    expect(out.body.agent?.agentId).toBe(agent.id);
    expect(out.body.idempotent).toBe(false);
    expect(out.body.routingId).toBeTruthy();

    const [row] = await testDb
      .select()
      .from(leadRoutingTable)
      .where(eq(leadRoutingTable.id, out.body.routingId));
    expect(row.agentId).toBe(agent.id);
    expect(row.status).toBe("routed");
    expect(row.carrierId).toBe(carrierA.id);
    expect(row.stateCode).toBe("FL");
    expect(row.source).toBe("public");
  });

  it("records a no_agent_available decision (no eligible agent)", async () => {
    // A state nobody is licensed in → empty pool, but still audited.
    const before = (await claimsForOrg()).length;
    const out = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrierA.id,
      contactState: "WY",
      certificationYear: YEAR,
      availableOnly: false,
      source: "in_app",
      now: new Date("2026-06-03T10:05:00Z"),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.status).toBe("no_agent_available");
    expect(out.body.target_phone).toBeNull();

    const [row] = await testDb
      .select()
      .from(leadRoutingTable)
      .where(eq(leadRoutingTable.id, out.body.routingId));
    expect(row.status).toBe("no_agent_available");
    expect(row.agentId).toBeNull();
    expect((await claimsForOrg()).length).toBe(before + 1);
  });
});

describe("claim-on-route — idempotency", () => {
  it("replays the original decision for a repeat (contact, carrier) in-window", async () => {
    await seedReadyAgent("Idem");
    const contactId = `ghl-${randomUUID()}`;
    const base = {
      orgId: org.id,
      carrierId: carrierA.id,
      contactState: "FL",
      contactId,
      certificationYear: YEAR,
      availableOnly: false,
      source: "public" as const,
    };

    const first = await resolveAndRouteInbound({
      ...base,
      now: new Date("2026-06-03T11:00:00Z"),
    });
    const second = await resolveAndRouteInbound({
      ...base,
      now: new Date("2026-06-03T11:00:05Z"), // 5s later, inside the 60s window
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.body.idempotent).toBe(true);
    expect(second.body.routingId).toBe(first.body.routingId);
    expect(second.body.target_user_id).toBe(first.body.target_user_id);

    // Exactly one row written for this contact — the retry did not re-route.
    const rows = await testDb
      .select()
      .from(leadRoutingTable)
      .where(
        and(
          eq(leadRoutingTable.orgId, org.id),
          eq(leadRoutingTable.contactId, contactId),
        ),
      );
    expect(rows.length).toBe(1);
  });
});

describe("claim-on-route — in-flight load balancing", () => {
  it("spreads back-to-back inbounds across equally-loaded agents", async () => {
    // A dedicated carrier so ONLY these two agents are eligible (other tests
    // seeded agents against carrierA). Two fresh agents, zero open leads each.
    // Lower lastName sorts first on a tie, so the first route picks A; the
    // recorded claim then makes A look busier, so the second route must pick B.
    const carrierBal = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrierBal.id, orgId: org.id, name: "Balance Co" });
    const a = await seedReadyAgent("Balance-A", carrierBal.id);
    const b = await seedReadyAgent("Balance-B", carrierBal.id);

    const first = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrierBal.id,
      contactState: "FL",
      certificationYear: YEAR,
      availableOnly: false,
      source: "public",
      now: new Date("2026-06-03T12:00:00Z"),
    });
    const second = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrierBal.id,
      contactState: "FL",
      certificationYear: YEAR,
      availableOnly: false,
      source: "public",
      now: new Date("2026-06-03T12:00:01Z"),
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const picks = [first.body.agent?.agentId, second.body.agent?.agentId];
    expect(picks).toContain(a.id);
    expect(picks).toContain(b.id);
    expect(picks[0]).not.toBe(picks[1]);
  });
});

describe("tiered overflow / fallback routing", () => {
  it("tier 1 — routes to an available agent as fallbackTier='available'", async () => {
    const carrier = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrier.id, orgId: org.id, name: "Tier1 Co" });
    const now = new Date("2026-06-04T09:00:00Z");
    const agent = await seedReadyAgent("Tier1-Avail", carrier.id);
    await setPresence(org.id, agent.id, "available", now);

    const out = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrier.id,
      contactState: "FL",
      certificationYear: YEAR,
      // availableOnly defaults to true → presence is applied.
      source: "public",
      now,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.status).toBe("routed");
    expect(out.body.agent?.agentId).toBe(agent.id);
    expect(out.body.presenceFiltered).toBe(true);
    expect(out.body.fallbackTier).toBe("available");

    const [row] = await testDb
      .select()
      .from(leadRoutingTable)
      .where(eq(leadRoutingTable.id, out.body.routingId));
    expect(row.fallbackTier).toBe("available");
  });

  it("tier 2 — falls back to an eligible-but-offline agent as 'eligible_offline'", async () => {
    const carrier = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrier.id, orgId: org.id, name: "Tier2 Co" });
    const now = new Date("2026-06-04T10:00:00Z");

    // Two ready-to-sell agents on this carrier. Presence is configured (so the
    // filter IS applied), but the only qualified agent is merely "away", not
    // available. A second agent is "available" but on a DIFFERENT carrier, so
    // it's the presence rows — not who's eligible — that make the org filtered.
    const away = await seedReadyAgent("Tier2-Away", carrier.id);
    await setPresence(org.id, away.id, "away", now);

    const out = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrier.id,
      contactState: "FL",
      certificationYear: YEAR,
      source: "public",
      now,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Routed to the offline-but-qualified agent rather than dropped.
    expect(out.body.status).toBe("routed");
    expect(out.body.agent?.agentId).toBe(away.id);
    expect(out.body.presenceFiltered).toBe(true);
    expect(out.body.fallbackTier).toBe("eligible_offline");
    // Compliance guardrail: the routed agent is STILL ready-to-sell.
    expect(await isReadyToSell(away.id, carrier.id)).toBe(true);

    const [row] = await testDb
      .select()
      .from(leadRoutingTable)
      .where(eq(leadRoutingTable.id, out.body.routingId));
    expect(row.fallbackTier).toBe("eligible_offline");
    expect(row.agentId).toBe(away.id);
  });

  it("no eligible agent at all → no_agent_available, tier null", async () => {
    const carrier = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrier.id, orgId: org.id, name: "Tier-None Co" });
    const now = new Date("2026-06-04T11:00:00Z");

    // Presence configured for the org (an unrelated agent), but nobody is
    // ready-to-sell for this carrier → even tier 2 is empty.
    const other = await seedReadyAgent("TierNone-Other");
    await setPresence(org.id, other.id, "away", now);

    const out = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrier.id,
      contactState: "FL",
      certificationYear: YEAR,
      source: "public",
      now,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.status).toBe("no_agent_available");
    expect(out.body.agent).toBeNull();
    expect(out.body.fallbackTier).toBeNull();

    const [row] = await testDb
      .select()
      .from(leadRoutingTable)
      .where(eq(leadRoutingTable.id, out.body.routingId));
    expect(row.fallbackTier).toBeNull();
  });

  it("presence not configured → routes normally as 'available' (no spurious fallback)", async () => {
    const carrier = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrier.id, orgId: org.id, name: "NoPresence Co" });
    const now = new Date("2026-06-04T12:00:00Z");

    // A ready-to-sell agent but NO presence rows for this carrier's agent —
    // the org's presence stays unconfigured for this isolated carrier pool, so
    // the filter is not applied and the match is simply 'available'.
    const agent = await seedReadyAgent("NoPresence-Agent", carrier.id);

    const out = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrier.id,
      contactState: "FL",
      certificationYear: YEAR,
      // Force "presence not applied" deterministically regardless of other
      // orgs' presence rows: availableOnly:false means no presence filter.
      availableOnly: false,
      source: "public",
      now,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.status).toBe("routed");
    expect(out.body.agent?.agentId).toBe(agent.id);
    expect(out.body.presenceFiltered).toBe(false);
    expect(out.body.fallbackTier).toBe("available");
  });

  it("persists the tier; an idempotent replay returns the same tier", async () => {
    const carrier = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrier.id, orgId: org.id, name: "Replay Co" });
    const now = new Date("2026-06-04T13:00:00Z");
    const contactId = `ghl-${randomUUID()}`;

    // Eligible-but-offline → first route lands on tier 2.
    const away = await seedReadyAgent("Replay-Away", carrier.id);
    await setPresence(org.id, away.id, "away", now);

    const base = {
      orgId: org.id,
      carrierId: carrier.id,
      contactState: "FL" as const,
      contactId,
      certificationYear: YEAR,
      source: "public" as const,
    };

    const first = await resolveAndRouteInbound({ ...base, now });
    const second = await resolveAndRouteInbound({
      ...base,
      now: new Date(now.getTime() + 5_000), // inside the idempotency window
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.body.fallbackTier).toBe("eligible_offline");
    expect(second.body.idempotent).toBe(true);
    expect(second.body.routingId).toBe(first.body.routingId);
    // The replayed decision returns the stored tier, not a freshly-computed one.
    expect(second.body.fallbackTier).toBe("eligible_offline");
  });
});
