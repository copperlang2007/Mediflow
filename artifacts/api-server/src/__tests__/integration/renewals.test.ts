/**
 * Renewals endpoints (routes/renewals.ts) against a database built ONLY from
 * the SQL migrations in lib/db/migrations — the same way `pnpm --filter
 * @workspace/db run migrate` builds the render.yaml demo DB.
 *
 *   GET  /api/renewals                          — expiring licenses + certs
 *   POST /api/renewals/:resourceType/:id/snooze — hide for N days
 *   POST /api/renewals/:resourceType/:id/resolve — hide for a year
 *
 * Regression guard: `renewal_snoozes` used to exist only via `db push`, so a
 * migrate-only database failed every GET /api/renewals with
 * `relation "renewal_snoozes" does not exist`. Migration 0049 backfills it.
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

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  carriersTable,
  carrierCertificationsTable,
  renewalSnoozesTable,
  stateLicensesTable,
} from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";
import type { TestDbHandle } from "../helpers/testDb";
import type { Express } from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0049 = path.resolve(
  __dirname,
  "../../../../../lib/db/migrations/0049_renewal_snoozes.sql",
);

const DAY_MS = 24 * 60 * 60 * 1000;

let app: Express;
let request: typeof import("supertest");
let handle: TestDbHandle;

let admin: { id: string };
let licenseId: string;
let certId: string;
let otherOrgLicenseId: string;

beforeAll(async () => {
  handle = await bootTestDb();
  const db = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  const org = await seedOrg(db, { id: "renewals-org" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  const agent = await seedAgent(db, {
    orgId: org.id,
    firstName: "Rita",
    lastName: "Renew",
  });

  licenseId = "renewals-lic-1";
  await db.insert(stateLicensesTable).values({
    id: licenseId,
    agentId: agent.id,
    stateCode: "TX",
    licenseType: "life_health",
    status: "active",
    expiryDate: new Date(Date.now() + 20 * DAY_MS),
  });

  await db.insert(carriersTable).values({
    id: "renewals-carrier",
    orgId: org.id,
    name: "Acme Health",
  });
  certId = "renewals-cert-1";
  await db.insert(carrierCertificationsTable).values({
    id: certId,
    agentId: agent.id,
    carrierId: "renewals-carrier",
    certificationYear: new Date().getFullYear(),
    status: "passed",
    expiryDate: new Date(Date.now() + 45 * DAY_MS),
  });

  // A license in another org — snoozing it must 404, not write a row.
  const otherOrg = await seedOrg(db, { id: "renewals-other-org" });
  const otherAgent = await seedAgent(db, { orgId: otherOrg.id });
  otherOrgLicenseId = "renewals-other-lic";
  await db.insert(stateLicensesTable).values({
    id: otherOrgLicenseId,
    agentId: otherAgent.id,
    stateCode: "FL",
    licenseType: "life_health",
    status: "active",
    expiryDate: new Date(Date.now() + 10 * DAY_MS),
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("renewal_snoozes migration", () => {
  it("is created by the SQL migrations", async () => {
    const res = await handle.pg.query<{ exists: string | null }>(
      `SELECT to_regclass('public.renewal_snoozes')::text AS exists`,
    );
    expect(res.rows[0]?.exists).toBe("renewal_snoozes");
  });

  it("0049 is idempotent (safe on DBs that got the table via db push)", async () => {
    const sql = fs.readFileSync(MIGRATION_0049, "utf8");
    for (const stmt of sql.split(/-->\s*statement-breakpoint/g)) {
      if (stmt.trim()) await handle.pg.exec(stmt);
    }
  });
});

describe("GET /api/renewals", () => {
  it("returns expiring licenses and certifications", async () => {
    const res = await request(app)
      .get("/api/renewals")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.daysAhead).toBe(90);
    const ids = res.body.renewals.map((r: { id: string }) => r.id);
    expect(ids).toEqual([licenseId, certId]);
    expect(res.body.renewals[0]).toMatchObject({
      type: "license",
      urgency: "critical",
    });
    expect(res.body.renewals[1]).toMatchObject({
      type: "certification",
      urgency: "warning",
    });
    // Other org's license never leaks in.
    expect(ids).not.toContain(otherOrgLicenseId);
  });
});

describe("POST /api/renewals/:resourceType/:id/snooze", () => {
  it("snoozes a license and hides it from GET", async () => {
    const res = await request(app)
      .post(`/api/renewals/license/${licenseId}/snooze`)
      .set(withAuth(admin.id))
      .send({ days: 14 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      days: 14,
      resourceType: "license",
      resourceId: licenseId,
    });

    const rows = await handle.db
      .select()
      .from(renewalSnoozesTable)
      .where(eq(renewalSnoozesTable.resourceId, licenseId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBe("renewals-org");
    expect(rows[0]!.createdBy).toBe(admin.id);

    const list = await request(app)
      .get("/api/renewals")
      .set(withAuth(admin.id));
    expect(list.status).toBe(200);
    expect(list.body.renewals.map((r: { id: string }) => r.id)).toEqual([
      certId,
    ]);
  });

  it("rejects an unknown resource type", async () => {
    const res = await request(app)
      .post(`/api/renewals/widget/${licenseId}/snooze`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(400);
  });

  it("404s on another org's license without writing a snooze", async () => {
    const res = await request(app)
      .post(`/api/renewals/license/${otherOrgLicenseId}/snooze`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(404);
    const rows = await handle.db
      .select()
      .from(renewalSnoozesTable)
      .where(eq(renewalSnoozesTable.resourceId, otherOrgLicenseId));
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/renewals/:resourceType/:id/resolve", () => {
  it("resolves a certification and hides it from GET", async () => {
    const res = await request(app)
      .post(`/api/renewals/certification/${certId}/resolve`)
      .set(withAuth(admin.id))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resolved: true,
      resourceType: "certification",
      resourceId: certId,
    });

    const list = await request(app)
      .get("/api/renewals")
      .set(withAuth(admin.id));
    expect(list.status).toBe(200);
    expect(list.body.renewals).toEqual([]);
    expect(list.body.total).toBe(0);
  });
});
