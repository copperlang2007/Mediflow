/**
 * Integration tests for the HIPAA security fixes on POST /api/contacts/bulk:
 *
 *   H1 — export_csv is the largest PHI egress path in the app. It must now
 *        require the same step-up confirmation (X-Confirm-Export header) as
 *        the report/admin CSV exports, AND write a `data_export_log` row so
 *        the export-anomaly detection worker can see it.
 *   M1 — assign_agent must reject an agentId that belongs to another org.
 *   M2 — set_status must reject a status value outside the canonical enum.
 *
 * Also includes a regression check that the non-export bulk actions
 * (add_tag) still work unchanged with no confirmation header.
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

import { eq } from "drizzle-orm";
import { contactsTable, dataExportLogTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";

import type { Express } from "express";
import type { TestDbHandle } from "../helpers/testDb";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;

let handle: TestDbHandle;
let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let orgAgent: { id: string };
let foreignAgent: { id: string };

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(handle.db, { id: "bulk-export-org" });
  otherOrg = await seedOrg(handle.db, { id: "bulk-export-other-org" });
  // super_admin so PHI columns are not masked in the export.
  admin = await seedUser(handle.db, { orgId: org.id, role: "super_admin" });
  orgAgent = await seedAgent(handle.db, { orgId: org.id });
  foreignAgent = await seedAgent(handle.db, { orgId: otherOrg.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("POST /api/contacts/bulk — H1: export_csv step-up confirm + audit log", () => {
  it("rejects export_csv without the X-Confirm-Export header (428)", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "NoConfirm" });

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids: [c.id], action: "export_csv" });

    expect(res.status).toBe(428);
    expect(res.body.code).toBe("EXPORT_CONFIRM_REQUIRED");
  });

  it("exports CSV and writes a data_export_log row when confirmed", async () => {
    const a = await seedContact(handle.db, { orgId: org.id, firstName: "ExpA" });
    const b = await seedContact(handle.db, { orgId: org.id, firstName: "ExpB" });

    const before = await handle.db
      .select()
      .from(dataExportLogTable)
      .where(eq(dataExportLogTable.orgId, org.id));

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .set("X-Confirm-Export", "true")
      .send({ ids: [a.id, b.id], action: "export_csv" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("ExpA");
    expect(res.text).toContain("ExpB");

    const after = await handle.db
      .select()
      .from(dataExportLogTable)
      .where(eq(dataExportLogTable.orgId, org.id));

    // Exactly one new data_export_log row, visible to exportAnomalyCheck.
    expect(after.length).toBe(before.length + 1);
    const logged = after.find(
      (r) => !before.some((bRow) => bRow.id === r.id),
    );
    expect(logged?.exportType).toBe("contacts_csv");
    expect(logged?.recordCount).toBe(2);
    expect(logged?.userId).toBe(admin.id);
  });
});

describe("POST /api/contacts/bulk — M1: assign_agent org validation", () => {
  it("rejects assigning a contact to an agent from another org (400)", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "AssignFail" });

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids: [c.id], action: "assign_agent", payload: { agentId: foreignAgent.id } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Assigned agent not found");
  });

  it("allows assigning a contact to an agent in the caller's org", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "AssignOk" });

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids: [c.id], action: "assign_agent", payload: { agentId: orgAgent.id } });

    expect(res.status).toBe(200);
    const [row] = await handle.db
      .select({ assignedAgentId: contactsTable.assignedAgentId })
      .from(contactsTable)
      .where(eq(contactsTable.id, c.id));
    expect(row.assignedAgentId).toBe(orgAgent.id);
  });
});

describe("M1: single-contact agent org validation (create + PATCH)", () => {
  it("POST /contacts rejects an assignedAgentId from another org (400)", async () => {
    const res = await request(app)
      .post("/api/contacts")
      .set(withAuth(admin.id))
      .send({ firstName: "Cross", lastName: "Org", assignedAgentId: foreignAgent.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Assigned agent not found");
  });

  it("PATCH /contacts/:id rejects an assignedAgentId from another org (400)", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "PatchAssign" });

    const res = await request(app)
      .patch(`/api/contacts/${c.id}`)
      .set(withAuth(admin.id))
      .send({ assignedAgentId: foreignAgent.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Assigned agent not found");
  });

  it("PATCH /contacts/:id allows an assignedAgentId from the caller's org", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "PatchAssignOk" });

    const res = await request(app)
      .patch(`/api/contacts/${c.id}`)
      .set(withAuth(admin.id))
      .send({ assignedAgentId: orgAgent.id });

    expect(res.status).toBe(200);
    expect(res.body.assignedAgentId).toBe(orgAgent.id);
  });
});

describe("POST /api/contacts/bulk — M2: set_status enum validation", () => {
  it("rejects a bogus status string (400)", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "StatusFail" });

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids: [c.id], action: "set_status", payload: { status: "not-a-real-status" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid status");
  });

  it("accepts a valid status value", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "StatusOk" });

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids: [c.id], action: "set_status", payload: { status: "enrolled" } });

    expect(res.status).toBe(200);
    const [row] = await handle.db
      .select({ status: contactsTable.status })
      .from(contactsTable)
      .where(eq(contactsTable.id, c.id));
    expect(row.status).toBe("enrolled");
  });
});

describe("POST /api/contacts/bulk — regression: non-export actions unchanged", () => {
  it("add_tag still succeeds with no confirmation header", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "TagReg" });

    const res = await request(app)
      .post("/api/contacts/bulk")
      .set(withAuth(admin.id))
      .send({ ids: [c.id], action: "add_tag", payload: { tag: "vip" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ affected: 1 });
    const [row] = await handle.db
      .select({ tags: contactsTable.tags })
      .from(contactsTable)
      .where(eq(contactsTable.id, c.id));
    expect(row.tags).toContain("vip");
  });
});
