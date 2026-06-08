/**
 * Callback SLA queue — re-attempt sweep tests (lib/leadQueue/callbacks.ts →
 * sweepLeadCallbacks). The sweep re-checks every `open` callback against
 * current routability:
 *
 *   - a ready-to-sell + available agent now exists → `resolved` (recording the
 *     agent it would route to), attempts incremented;
 *   - SLA passed with still nobody → `expired`;
 *   - still un-routable but within SLA → stays `open`, attempts incremented.
 *
 * The sweep reuses findReadyToSellAgents + getAvailableAgentIds, which read the
 * `@workspace/db` default handle — so this suite wires that handle to a pglite
 * instance via the standard test harness (rather than injecting db) and pins
 * the clock so SLA/now is deterministic.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

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
  leadCallbacksTable,
  agentsTable,
  stateLicensesTable,
  carrierCertificationsTable,
  ahipRecordsTable,
  agentPresenceTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";

let testDb: TestDb;
let sweepLeadCallbacks: typeof import("../../lib/leadQueue/callbacks").sweepLeadCallbacks;

const YEAR = 2026;
const FUTURE = new Date("2027-01-01T00:00:00Z");
const NOW = new Date("2026-06-06T10:00:00Z");

let orgId: string;
let carrierId: string;

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  sweepLeadCallbacks = (await import("../../lib/leadQueue/callbacks"))
    .sweepLeadCallbacks;
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(async () => {
  // The sweep scans `open` callbacks globally, so clear between tests to keep
  // each summary count isolated.
  await testDb.delete(leadCallbacksTable);
  const org = await seedOrg(testDb, { id: `cb-${randomUUID().slice(0, 8)}` });
  orgId = org.id;
  carrierId = `carrier-${randomUUID()}`;
  await testDb
    .insert(carriersTable)
    .values({ id: carrierId, orgId, name: "Sweep Co" });
});

/** A ready-to-sell agent for (carrierId, FL), optionally marked available. */
async function seedReadyAgent(opts: {
  lastName: string;
  available?: boolean;
}): Promise<string> {
  const agent = await seedAgent(testDb, { orgId, lastName: opts.lastName });
  await testDb
    .update(agentsTable)
    .set({ status: "active", phone: "+15551234567" })
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
  if (opts.available) {
    await testDb.insert(agentPresenceTable).values({
      agentId: agent.id,
      orgId,
      status: "available",
      source: "heartbeat",
      lastSeenAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
  }
  return agent.id;
}

async function seedCallback(opts: { slaDueAt: Date }): Promise<string> {
  const id = `cb-${randomUUID()}`;
  await testDb.insert(leadCallbacksTable).values({
    id,
    orgId,
    contactId: `ghl-${randomUUID()}`,
    carrierId,
    stateCode: "FL",
    certificationYear: YEAR,
    status: "open",
    slaDueAt: opts.slaDueAt,
    attempts: 0,
    createdAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    updatedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
  });
  return id;
}

async function getCallback(id: string) {
  const [row] = await testDb
    .select()
    .from(leadCallbacksTable)
    .where(eq(leadCallbacksTable.id, id));
  return row;
}

describe("Lead callback sweep — re-attempt + SLA", () => {
  it("resolves an open callback once a ready-to-sell available agent exists", async () => {
    const agentId = await seedReadyAgent({ lastName: "Avail", available: true });
    const id = await seedCallback({
      slaDueAt: new Date(NOW.getTime() + 20 * 60 * 1000),
    });

    const summary = await sweepLeadCallbacks({ now: () => NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.resolved).toBe(1);

    const cb = await getCallback(id);
    expect(cb.status).toBe("resolved");
    expect(cb.resolvedAgentId).toBe(agentId);
    expect(cb.resolvedAt).not.toBeNull();
    expect(cb.attempts).toBe(1);
    expect(cb.lastAttemptAt).not.toBeNull();
  });

  it("expires an open callback past its SLA with still nobody available", async () => {
    const id = await seedCallback({
      slaDueAt: new Date(NOW.getTime() - 1 * 60 * 1000),
    });

    const summary = await sweepLeadCallbacks({ now: () => NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.expired).toBe(1);

    const cb = await getCallback(id);
    expect(cb.status).toBe("expired");
    expect(cb.attempts).toBe(1);
    expect(cb.resolvedAgentId).toBeNull();
  });

  it("leaves a still-un-routable callback open within SLA (attempts incremented)", async () => {
    // A ready-to-sell agent exists but is NOT available → un-routable now; SLA
    // not yet passed.
    await seedReadyAgent({ lastName: "Offline", available: false });
    const id = await seedCallback({
      slaDueAt: new Date(NOW.getTime() + 15 * 60 * 1000),
    });

    const summary = await sweepLeadCallbacks({ now: () => NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.stillOpen).toBe(1);
    expect(summary.resolved).toBe(0);
    expect(summary.expired).toBe(0);

    const cb = await getCallback(id);
    expect(cb.status).toBe("open");
    expect(cb.attempts).toBe(1);
    expect(cb.lastAttemptAt).not.toBeNull();
  });

  it("prefers resolving even when SLA has passed, if an agent is now available", async () => {
    const agentId = await seedReadyAgent({ lastName: "Late", available: true });
    const id = await seedCallback({
      slaDueAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    });

    const summary = await sweepLeadCallbacks({ now: () => NOW });
    expect(summary.resolved).toBe(1);
    expect(summary.expired).toBe(0);

    const cb = await getCallback(id);
    expect(cb.status).toBe("resolved");
    expect(cb.resolvedAgentId).toBe(agentId);
  });
});
