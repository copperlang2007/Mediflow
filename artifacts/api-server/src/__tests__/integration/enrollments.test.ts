/**
 * Enrollments — the operational spine.
 *
 * The properties worth pinning are the ones the flattened `contacts.current_*`
 * columns could not express, plus tenancy:
 *
 *   - a beneficiary can hold an MA plan AND a standalone PDP in the same year
 *   - year-over-year history survives (AEP/OEP switching is legible)
 *   - a duplicate of the same carrier + plan type + year is refused, because
 *     that would double-count a commission
 *   - an enrollment on another tenant's contact is not reachable
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

import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { enrollmentsTable, carriersTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import {
  seedOrg,
  seedUser,
  seedContact,
  type TestDb,
} from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let orgA: { id: string };
let orgB: { id: string };
let adminA: { id: string };
let contactA: { id: string };
let contactB: { id: string };
let carrierId: string;

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = (
    (await import("supertest")) as never as { default: typeof import("supertest") }
  ).default;

  orgA = await seedOrg(testDb, { id: "enroll-org-a" });
  orgB = await seedOrg(testDb, { id: "enroll-org-b" });
  adminA = await seedUser(testDb, { orgId: orgA.id, role: "agency_admin" });
  contactA = await seedContact(testDb, {
    orgId: orgA.id,
    firstName: "Ada",
    lastName: "Beneficiary",
  });
  contactB = await seedContact(testDb, {
    orgId: orgB.id,
    firstName: "Other",
    lastName: "Tenant",
  });

  carrierId = `carrier-${randomUUID()}`;
  await testDb
    .insert(carriersTable)
    .values({ id: carrierId, orgId: orgA.id, name: "Acme Health" });
});

afterAll(async () => {
  await shutdownTestDb();
});

function enrollment(overrides: Record<string, unknown> = {}) {
  return {
    contactId: contactA.id,
    carrierId,
    planType: "MAPD",
    planYear: 2026,
    effectiveDate: "2026-01-01",
    ...overrides,
  };
}

describe("POST /enrollments", () => {
  it("records an enrollment against a beneficiary", async () => {
    const res = await request(app)
      .post("/api/enrollments")
      .set(withAuth(adminA.id))
      .send(enrollment({ policyNumber: "H1234-001", effectuated: true, status: "active" }));

    expect(res.status).toBe(201);
    expect(res.body.contactId).toBe(contactA.id);
    expect(res.body.planType).toBe("MAPD");
    expect(res.body.orgId).toBe(orgA.id);
  });

  it("allows an MA plan and a standalone PDP in the same year", async () => {
    // The case the flattened `contacts.current_plan_type` column could not
    // represent at all — and the reason a beneficiary's second commission
    // stream used to be invisible.
    const res = await request(app)
      .post("/api/enrollments")
      .set(withAuth(adminA.id))
      .send(enrollment({ planType: "PDP", policyNumber: "S5678-002" }));

    expect(res.status).toBe(201);

    const rows = await testDb
      .select()
      .from(enrollmentsTable)
      .where(eq(enrollmentsTable.contactId, contactA.id));
    const types2026 = rows.filter((r) => r.planYear === 2026).map((r) => r.planType);
    expect(types2026).toContain("MAPD");
    expect(types2026).toContain("PDP");
  });

  it("refuses a duplicate carrier + plan type + year", async () => {
    // Two identical enrollments would double-count the commission.
    const res = await request(app)
      .post("/api/enrollments")
      .set(withAuth(adminA.id))
      .send(enrollment());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("duplicate_enrollment");
  });

  it("keeps year-over-year history rather than overwriting", async () => {
    const res = await request(app)
      .post("/api/enrollments")
      .set(withAuth(adminA.id))
      .send(enrollment({ planYear: 2025, effectiveDate: "2025-01-01" }));
    expect(res.status).toBe(201);

    const history = await request(app)
      .get(`/api/contacts/${contactA.id}/plan-enrollments`)
      .set(withAuth(adminA.id));

    expect(history.status).toBe(200);
    const years = history.body.map((e: { planYear: number }) => e.planYear);
    expect(years).toContain(2025);
    expect(years).toContain(2026);
    // Newest plan year first.
    expect(years[0]).toBeGreaterThanOrEqual(years[years.length - 1]);
  });

  it("404s when the contact belongs to another org", async () => {
    const res = await request(app)
      .post("/api/enrollments")
      .set(withAuth(adminA.id))
      .send(enrollment({ contactId: contactB.id }));

    expect(res.status).toBe(404);
  });
});

describe("PATCH /enrollments/:id", () => {
  it("advances an enrollment to terminated with a disenrollment date", async () => {
    const created = await request(app)
      .post("/api/enrollments")
      .set(withAuth(adminA.id))
      .send(enrollment({ planType: "supp", planYear: 2024, effectiveDate: "2024-01-01" }));
    expect(created.status).toBe(201);

    const res = await request(app)
      .patch(`/api/enrollments/${created.body.id}`)
      .set(withAuth(adminA.id))
      .send({ status: "terminated", disenrolledDate: "2024-09-30" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("terminated");
    expect(res.body.disenrolledDate).toBe("2024-09-30");
  });

  it("404s on an enrollment owned by another org", async () => {
    const foreignId = `enr-${randomUUID()}`;
    await testDb.insert(enrollmentsTable).values({
      id: foreignId,
      orgId: orgB.id,
      contactId: contactB.id,
      planType: "MA",
      planYear: 2026,
      effectiveDate: "2026-01-01",
    });

    const res = await request(app)
      .patch(`/api/enrollments/${foreignId}`)
      .set(withAuth(adminA.id))
      .send({ status: "active" });

    expect(res.status).toBe(404);

    // And the foreign row is untouched.
    const [still] = await testDb
      .select({ status: enrollmentsTable.status })
      .from(enrollmentsTable)
      .where(eq(enrollmentsTable.id, foreignId));
    expect(still.status).toBe("pending");
  });
});

describe("GET /enrollments", () => {
  it("returns only the caller's org and filters by plan year", async () => {
    const res = await request(app)
      .get("/api/enrollments?planYear=2026")
      .set(withAuth(adminA.id));

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const e of res.body) {
      expect(e.orgId).toBe(orgA.id);
      expect(e.planYear).toBe(2026);
    }
  });

  it("joins the carrier name so the UI needs one call", async () => {
    const res = await request(app)
      .get(`/api/enrollments?contactId=${contactA.id}`)
      .set(withAuth(adminA.id));

    expect(res.status).toBe(200);
    const withCarrier = res.body.find(
      (e: { carrierId: string | null }) => e.carrierId === carrierId,
    );
    expect(withCarrier?.carrierName).toBe("Acme Health");
  });
});
