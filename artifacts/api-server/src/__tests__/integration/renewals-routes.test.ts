/**
 * /api/renewals end to end on a database built only from the checked-in SQL
 * migrations (the pglite harness replays lib/db/migrations/*.sql). Before
 * migration 0049 there was no CREATE TABLE for `renewal_snoozes`, so the list
 * and both snooze routes failed with `relation "renewal_snoozes" does not exist`.
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
import {
  stateLicensesTable,
  carriersTable,
  carrierCertificationsTable,
  renewalSnoozesTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let admin: { id: string; orgId: string };
let otherAdmin: { id: string };
let licenseId: string;
let certId: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);

beforeAll(async () => {
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  const org = await seedOrg(handle.db, { id: "renewals-org" });
  const other = await seedOrg(handle.db, { id: "renewals-other-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  otherAdmin = await seedUser(handle.db, { orgId: other.id, role: "agency_admin" });
  const agent = await seedAgent(handle.db, { orgId: org.id, firstName: "Rita", lastName: "Renew" });

  licenseId = `lic-${randomUUID()}`;
  await handle.db.insert(stateLicensesTable).values({
    id: licenseId, agentId: agent.id, stateCode: "TX", licenseType: "Life & Health",
    status: "active", expiryDate: inDays(20),
  });

  const carrierId = `car-${randomUUID()}`;
  await handle.db.insert(carriersTable).values({ id: carrierId, orgId: org.id, name: "Humana" });
  certId = `cert-${randomUUID()}`;
  await handle.db.insert(carrierCertificationsTable).values({
    id: certId, agentId: agent.id, carrierId, certificationYear: new Date().getFullYear(),
    status: "passed", expiryDate: inDays(50),
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

const list = async (userId: string) => request(app).get("/api/renewals").set(withAuth(userId));

describe("GET /api/renewals", () => {
  it("lists expiring licenses and certifications with urgency", async () => {
    const res = await list(admin.id);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.renewals.map((r: any) => [r.id, r]));
    expect(byId[licenseId]).toMatchObject({ type: "license", urgency: "critical", agentName: "Rita Renew" });
    expect(byId[certId]).toMatchObject({ type: "certification", urgency: "warning", detail: "Humana" });
  });

  it("does not show another org's renewals", async () => {
    const res = await list(otherAdmin.id);
    expect(res.status).toBe(200);
    expect(res.body.renewals).toEqual([]);
  });
});

describe("snooze and resolve", () => {
  it("snoozing a license hides it from the list", async () => {
    const res = await request(app)
      .post(`/api/renewals/license/${licenseId}/snooze`)
      .set(withAuth(admin.id))
      .send({ days: 14 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ days: 14, resourceType: "license", resourceId: licenseId });

    const after = await list(admin.id);
    expect(after.body.renewals.map((r: any) => r.id)).not.toContain(licenseId);
  });

  it("resolving a certification hides it and stores a year-long snooze", async () => {
    const res = await request(app)
      .post(`/api/renewals/certification/${certId}/resolve`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resolved: true, resourceType: "certification", resourceId: certId });

    const after = await list(admin.id);
    expect(after.body.renewals.map((r: any) => r.id)).not.toContain(certId);

    const handle = await bootTestDb();
    const [row] = await handle.db
      .select()
      .from(renewalSnoozesTable)
      .where(eq(renewalSnoozesTable.resourceId, certId));
    expect(row?.orgId).toBe(admin.orgId);
    expect(row!.snoozedUntil.getTime()).toBeGreaterThan(inDays(360).getTime());
  });

  it("rejects an unknown resource type", async () => {
    const res = await request(app)
      .post(`/api/renewals/policy/${licenseId}/snooze`)
      .set(withAuth(admin.id));
    expect(res.status).toBe(400);
  });

  it("cannot snooze another org's license", async () => {
    const res = await request(app)
      .post(`/api/renewals/license/${licenseId}/snooze`)
      .set(withAuth(otherAdmin.id));
    expect(res.status).toBe(404);
  });
});
