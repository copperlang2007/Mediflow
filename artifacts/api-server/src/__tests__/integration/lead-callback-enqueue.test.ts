/**
 * Callback SLA queue — enqueue-on-drop tests (lib/leadQueue/service.ts +
 * callbacks.ts). Verifies that an inbound route ending in `no_agent_available`
 * captures the lead as an `open` `lead_callbacks` row, that a successful route
 * does NOT, and that a repeat miss for the same (contact, carrier) dedups
 * rather than duplicating.
 *
 * Runs against the service directly (not over HTTP) so the `now` clock — and
 * therefore the SLA deadline — is deterministic.
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
  leadCallbacksTable,
  agentsTable,
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

async function seedReadyAgent(
  lastName: string,
  carrierId: string,
): Promise<{ id: string }> {
  const agent = await seedAgent(testDb, { orgId: org.id, lastName });
  await testDb
    .update(agentsTable)
    .set({ status: "active", phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}` })
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

function callbacksFor(carrierId: string) {
  return testDb
    .select()
    .from(leadCallbacksTable)
    .where(
      and(
        eq(leadCallbacksTable.orgId, org.id),
        eq(leadCallbacksTable.carrierId, carrierId),
      ),
    );
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  resolveAndRouteInbound = (await import("../../lib/leadQueue/service"))
    .resolveAndRouteInbound;

  org = await seedOrg(testDb, { id: "lcb-org" });
  carrierA = { id: `carrier-${randomUUID()}` };
  await testDb
    .insert(carriersTable)
    .values({ id: carrierA.id, orgId: org.id, name: "Acme Health" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("callback enqueue on no_agent_available", () => {
  it("captures an open callback with SLA + fields when nobody is available", async () => {
    const carrier = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrier.id, orgId: org.id, name: "NoOne Co" });
    const now = new Date("2026-06-05T10:00:00Z");
    const contactId = `ghl-${randomUUID()}`;

    const out = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrier.id,
      contactState: "FL",
      contactId,
      certificationYear: YEAR,
      availableOnly: false,
      source: "public",
      now,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.status).toBe("no_agent_available");

    const rows = await callbacksFor(carrier.id);
    expect(rows.length).toBe(1);
    const cb = rows[0];
    expect(cb.status).toBe("open");
    expect(cb.orgId).toBe(org.id);
    expect(cb.contactId).toBe(contactId);
    expect(cb.carrierId).toBe(carrier.id);
    expect(cb.stateCode).toBe("FL");
    expect(cb.certificationYear).toBe(YEAR);
    expect(cb.attempts).toBe(0);
    // SLA = now + 30 min default.
    expect(new Date(cb.slaDueAt).getTime()).toBe(
      now.getTime() + 30 * 60 * 1000,
    );
  });

  it("does NOT capture a callback when the route succeeds", async () => {
    const carrier = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrier.id, orgId: org.id, name: "Staffed Co" });
    await seedReadyAgent("Routed", carrier.id);

    const out = await resolveAndRouteInbound({
      orgId: org.id,
      carrierId: carrier.id,
      contactState: "FL",
      contactId: `ghl-${randomUUID()}`,
      certificationYear: YEAR,
      availableOnly: false,
      source: "public",
      now: new Date("2026-06-05T11:00:00Z"),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.status).toBe("routed");

    expect((await callbacksFor(carrier.id)).length).toBe(0);
  });

  it("dedups a second miss for the same (contact, carrier) — bumps, no duplicate", async () => {
    const carrier = { id: `carrier-${randomUUID()}` };
    await testDb
      .insert(carriersTable)
      .values({ id: carrier.id, orgId: org.id, name: "Dedup Co" });
    const contactId = `ghl-${randomUUID()}`;
    const base = {
      orgId: org.id,
      carrierId: carrier.id,
      contactState: "FL" as const,
      contactId,
      certificationYear: YEAR,
      availableOnly: false,
      source: "public" as const,
    };

    // First miss: inserts. Second miss is OUTSIDE the idempotency window so it
    // re-routes (and re-misses), but must dedup the callback rather than stack.
    await resolveAndRouteInbound({
      ...base,
      now: new Date("2026-06-05T12:00:00Z"),
    });
    await resolveAndRouteInbound({
      ...base,
      now: new Date("2026-06-05T12:05:00Z"), // 5 min later, past 60s idempotency
    });

    const rows = await callbacksFor(carrier.id);
    expect(rows.length).toBe(1);
    // SLA was bumped to the second miss + 30m.
    expect(new Date(rows[0].slaDueAt).getTime()).toBe(
      new Date("2026-06-05T12:05:00Z").getTime() + 30 * 60 * 1000,
    );
  });
});
