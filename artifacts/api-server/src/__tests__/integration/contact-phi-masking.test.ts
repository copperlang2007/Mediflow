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

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let org: { id: string };
let superAdmin: { id: string };
let agencyAdmin: { id: string };
let agentSupport: { id: string };
let contactWithPhi: { id: string };

const REAL_MEDICARE_ID = "1AB-CD-EF23";
const REAL_HEALTH_CONDITIONS = ["diabetes", "hypertension"];
const REAL_DOB = new Date("1955-04-12T00:00:00Z");

beforeAll(async () => {
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  org = await seedOrg(handle.db, { id: "phi-org" });
  superAdmin = await seedUser(handle.db, { orgId: org.id, role: "super_admin" });
  agencyAdmin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  agentSupport = await seedUser(handle.db, { orgId: org.id, role: "agent_support" });

  contactWithPhi = await seedContact(handle.db, {
    orgId: org.id,
    medicareId: REAL_MEDICARE_ID,
    dob: REAL_DOB,
    healthConditions: REAL_HEALTH_CONDITIONS,
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("Contact PHI masking", () => {
  it("GET /contacts/:id as agent_support masks dob/medicareId/healthConditions", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contactWithPhi.id}`)
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(res.body.dob).toBeNull();
    expect(res.body.medicareId).toBe("***-**-****");
    expect(res.body.healthConditions).toEqual([]);
  });

  it("GET /contacts/:id as super_admin returns real PHI values", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contactWithPhi.id}`)
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.medicareId).toBe(REAL_MEDICARE_ID);
    expect(res.body.healthConditions).toEqual(REAL_HEALTH_CONDITIONS);
    // dob is serialized as ISO string by Express; just verify it's not null.
    expect(res.body.dob).not.toBeNull();
  });

  it("GET /contacts/:id as agency_admin returns real PHI values", async () => {
    const res = await request(app)
      .get(`/api/contacts/${contactWithPhi.id}`)
      .set(withAuth(agencyAdmin.id));
    expect(res.status).toBe(200);
    expect(res.body.medicareId).toBe(REAL_MEDICARE_ID);
  });

  it("POST /contacts as agent_support returns a MASKED response (PR #29 — would leak PHI without the fix)", async () => {
    const res = await request(app)
      .post("/api/contacts")
      .set(withAuth(agentSupport.id))
      .send({
        firstName: "Echo",
        lastName: "Tester",
        medicareId: "9XX-YY-ZZ77",
        dob: "1960-01-01",
        healthConditions: ["asthma"],
      });
    expect(res.status).toBe(201);
    expect(res.body.medicareId).toBe("***-**-****");
    expect(res.body.dob).toBeNull();
    expect(res.body.healthConditions).toEqual([]);
  });

  it("POST /contacts/bulk export_csv as agent_support emits NO medicareId in the CSV", async () => {
    // export_csv requires step-up confirmation (H1) — send the confirm header.
    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(agentSupport.id))
      .set("X-Confirm-Export", "true")
      .send({ ids: [contactWithPhi.id], action: "export_csv" });
    expect(res.status).toBe(200);
    const body = String(res.text ?? res.body ?? "");
    expect(body.split("\n")[0].toLowerCase()).not.toContain("medicare");
    expect(body).not.toContain("***-**-****");
    expect(body).not.toContain(REAL_MEDICARE_ID);
  });

  it("POST /contacts/bulk export_csv as super_admin emits NO medicareId in the CSV", async () => {
    // export_csv requires step-up confirmation (H1) — send the confirm header.
    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(superAdmin.id))
      .set("X-Confirm-Export", "true")
      .send({ ids: [contactWithPhi.id], action: "export_csv" });
    expect(res.status).toBe(200);
    const body = String(res.text ?? res.body ?? "");
    expect(body.split("\n")[0].toLowerCase()).not.toContain("medicare");
    expect(body).not.toContain(REAL_MEDICARE_ID);
  });
});
