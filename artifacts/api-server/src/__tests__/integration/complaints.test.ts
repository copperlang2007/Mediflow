/**
 * CTM complaint tracking — endpoint tests (routes/complaints.ts):
 *
 *   GET   /api/complaints[?status=&severity=&overdue=]  — worked list
 *   GET   /api/complaints/summary                       — status counts + overdue
 *   GET   /api/complaints/:id                           — single, with names
 *   POST  /api/complaints                               — log a complaint
 *   PATCH /api/complaints/:id                           — advance / resolve
 *
 * Reads/writes gate on the `compliance_report` resource: compliance_manager /
 * agency_admin own complaints; a `developer` role can read but not create; an
 * `agent_support` role can do neither.
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

import { eq, and } from "drizzle-orm";
import { auditLogTable, complaintsTable } from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedContact, seedAgent } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
let contact: { id: string };
let agent: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "cmpl-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  contact = await seedContact(testDb, {
    orgId: org.id,
    firstName: "Mabel",
    lastName: "Reyes",
    status: "enrolled",
  });
  agent = await seedAgent(testDb, {
    orgId: org.id,
    firstName: "Dana",
    lastName: "Cole",
  });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("POST /complaints", () => {
  it("logs a complaint, derives the SLA from severity, and audits it", async () => {
    const receivedAt = "2026-06-01T00:00:00.000Z";
    const res = await request(app)
      .post("/api/complaints")
      .set(withAuth(admin.id))
      .send({
        subject: "Agent used a non-approved flyer",
        description: "Beneficiary reports a mailer not on the CMS-filed list.",
        source: "cms_ctm",
        category: "marketing",
        severity: "critical",
        contactId: contact.id,
        agentId: agent.id,
        ctmCaseId: "CTM-2026-00123",
        receivedAt,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    expect(res.body.severity).toBe("critical");
    // critical = 2-day SLA from receivedAt.
    expect(new Date(res.body.dueAt).toISOString()).toBe(
      "2026-06-03T00:00:00.000Z",
    );
    expect(res.body.createdBy).toBe(admin.id);

    const audit = await testDb
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.resourceType, "complaint"),
          eq(auditLogTable.resourceId, res.body.id),
        ),
      );
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe("create");
  });

  it("rejects a contact from another org (400)", async () => {
    const otherOrg = await seedOrg(testDb, { id: "cmpl-other-org" });
    const otherContact = await seedContact(testDb, {
      orgId: otherOrg.id,
      status: "enrolled",
    });
    const res = await request(app)
      .post("/api/complaints")
      .set(withAuth(admin.id))
      .send({ subject: "x", contactId: otherContact.id });
    expect(res.status).toBe(400);
  });

  it("validates the body (empty subject → 400)", async () => {
    const res = await request(app)
      .post("/api/complaints")
      .set(withAuth(admin.id))
      .send({ subject: "" });
    expect(res.status).toBe(400);
  });
});

describe("GET /complaints + /summary", () => {
  it("lists complaints with joined names and reports summary counts", async () => {
    const list = await request(app)
      .get("/api/complaints")
      .set(withAuth(admin.id));
    expect(list.status).toBe(200);
    const found = list.body.find(
      (r: { complaint: { ctmCaseId: string } }) =>
        r.complaint.ctmCaseId === "CTM-2026-00123",
    );
    expect(found).toBeTruthy();
    expect(found.contactFirstName).toBe("Mabel");
    expect(found.agentLastName).toBe("Cole");
    expect(found.assigneeName).toBeNull();

    const summary = await request(app)
      .get("/api/complaints/summary")
      .set(withAuth(admin.id));
    expect(summary.status).toBe(200);
    expect(summary.body.open).toBeGreaterThanOrEqual(1);
    // The critical complaint received 2026-06-01 is past its due date now.
    expect(summary.body.overdue).toBeGreaterThanOrEqual(1);
    expect(summary.body.active).toBe(
      summary.body.open + summary.body.investigating,
    );
  });

  it("filters by overdue=true", async () => {
    const res = await request(app)
      .get("/api/complaints?overdue=true")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    for (const r of res.body) {
      expect(["open", "investigating"]).toContain(r.complaint.status);
      expect(new Date(r.complaint.dueAt).getTime()).toBeLessThan(Date.now());
    }
  });
});

describe("PATCH /complaints/:id", () => {
  async function createComplaint(severity = "medium"): Promise<string> {
    const res = await request(app)
      .post("/api/complaints")
      .set(withAuth(admin.id))
      .send({ subject: "Test complaint", severity, receivedAt: "2026-06-01T00:00:00.000Z" });
    return res.body.id;
  }

  it("resolving sets resolvedAt and audits the status change; reopening clears it", async () => {
    const id = await createComplaint();
    const resolve = await request(app)
      .patch(`/api/complaints/${id}`)
      .set(withAuth(admin.id))
      .send({ status: "resolved", resolutionNotes: "Educated agent; flyer pulled." });
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe("resolved");
    expect(resolve.body.resolvedAt).toBeTruthy();

    const audit = await testDb
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.resourceType, "complaint"),
          eq(auditLogTable.resourceId, id),
        ),
      );
    // create + the resolve status-change.
    expect(audit.length).toBe(2);

    const reopen = await request(app)
      .patch(`/api/complaints/${id}`)
      .set(withAuth(admin.id))
      .send({ status: "investigating" });
    expect(reopen.status).toBe(200);
    expect(reopen.body.resolvedAt).toBeNull();
  });

  it("changing severity while active recomputes the SLA", async () => {
    const id = await createComplaint("low"); // 30-day SLA
    const res = await request(app)
      .patch(`/api/complaints/${id}`)
      .set(withAuth(admin.id))
      .send({ severity: "critical" }); // → 2-day SLA from receivedAt
    expect(res.status).toBe(200);
    expect(new Date(res.body.dueAt).toISOString()).toBe(
      "2026-06-03T00:00:00.000Z",
    );
  });

  it("404s an unknown id", async () => {
    const res = await request(app)
      .patch("/api/complaints/does-not-exist")
      .set(withAuth(admin.id))
      .send({ status: "closed" });
    expect(res.status).toBe(404);
  });
});

describe("complaints — RBAC", () => {
  it("lets a developer read but not create; blocks agent_support entirely", async () => {
    const dev = await seedUser(testDb, { orgId: org.id, role: "developer" });
    const support = await seedUser(testDb, { orgId: org.id, role: "agent_support" });

    const devRead = await request(app)
      .get("/api/complaints")
      .set(withAuth(dev.id));
    expect(devRead.status).toBe(200);
    const devCreate = await request(app)
      .post("/api/complaints")
      .set(withAuth(dev.id))
      .send({ subject: "nope" });
    expect(devCreate.status).toBe(403);

    const supportRead = await request(app)
      .get("/api/complaints")
      .set(withAuth(support.id));
    expect(supportRead.status).toBe(403);
  });
});
