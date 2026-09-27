/**
 * Marketing-material approval — endpoint tests (routes/marketing.ts):
 *
 *   GET   /api/marketing-materials[?status=&materialType=]  — worked list
 *   GET   /api/marketing-materials/summary                  — status counts
 *   GET   /api/marketing-materials/:id                      — single
 *   POST  /api/marketing-materials                          — submit / draft
 *   PATCH /api/marketing-materials/:id                      — edit / review
 *
 * Gated on `compliance_report`: compliance_manager / agency_admin own review;
 * a `developer` reads but can't submit; an `agent_support` role gets neither.
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
import { auditLogTable, marketingMaterialsTable } from "@workspace/db/schema";

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;

let org: { id: string };
let admin: { id: string };
// A second compliance user: decisions must be recorded by someone other than
// the submitter (separation of duties).
let reviewer: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(testDb, { id: "mkt-org" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  reviewer = await seedUser(testDb, { orgId: org.id, role: "compliance_manager" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("POST /marketing-materials", () => {
  it("submits a piece for review, stamps the submitter, and audits it", async () => {
    const res = await request(app)
      .post("/api/marketing-materials")
      .set(withAuth(admin.id))
      .send({
        title: "Fall AEP flyer",
        materialType: "flyer",
        description: "MA plan highlights flyer for AEP",
        carrierName: "Acme Health",
        fileUrl: "https://assets.example.com/flyer.pdf",
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("submitted");
    expect(res.body.submittedByUserId).toBe(admin.id);
    expect(res.body.submittedAt).toBeTruthy();

    const audit = await testDb
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.resourceType, "marketing_material"),
          eq(auditLogTable.resourceId, res.body.id),
        ),
      );
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe("create");
  });

  it("can save a draft (not yet submitted for review)", async () => {
    const res = await request(app)
      .post("/api/marketing-materials")
      .set(withAuth(admin.id))
      .send({ title: "WIP mailer", asDraft: true });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.submittedAt).toBeNull();
  });

  it("rejects a bad file URL (400)", async () => {
    const res = await request(app)
      .post("/api/marketing-materials")
      .set(withAuth(admin.id))
      .send({ title: "x", fileUrl: "not-a-url" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /marketing-materials/:id — review decision", () => {
  async function submit(title = "Piece"): Promise<string> {
    const res = await request(app)
      .post("/api/marketing-materials")
      .set(withAuth(admin.id))
      .send({ title });
    return res.body.id;
  }

  it("approving stamps reviewer + window and audits the change", async () => {
    const id = await submit("Approvable email");
    const res = await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(reviewer.id))
      .send({
        status: "approved",
        cmsMaterialId: "Y0001_FLY123_M",
        effectiveDate: "2026-10-01T00:00:00.000Z",
        expiresAt: "2027-09-30T00:00:00.000Z",
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.reviewedByUserId).toBe(reviewer.id);
    expect(res.body.reviewedAt).toBeTruthy();
    expect(res.body.cmsMaterialId).toBe("Y0001_FLY123_M");

    const audit = await testDb
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.resourceType, "marketing_material"),
          eq(auditLogTable.resourceId, id),
        ),
      );
    // create + approve.
    expect(audit.length).toBe(2);
  });

  it("requesting changes then resubmitting clears the prior decision stamp", async () => {
    const id = await submit("Needs work");
    await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(reviewer.id))
      .send({ status: "changes_requested", reviewNotes: "Add the disclaimer." });

    const resubmit = await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(admin.id))
      .send({ status: "submitted" });
    expect(resubmit.status).toBe(200);
    expect(resubmit.body.status).toBe("submitted");
    expect(resubmit.body.reviewedAt).toBeNull();
    expect(resubmit.body.reviewedByUserId).toBeNull();
  });

  it("refuses a decision from the person who submitted the piece (403)", async () => {
    const id = await submit("Self-review attempt");
    for (const status of ["approved", "rejected", "changes_requested"]) {
      const res = await request(app)
        .patch(`/api/marketing-materials/${id}`)
        .set(withAuth(admin.id))
        .send({ status });
      expect(res.status).toBe(403);
    }
    const [row] = await testDb
      .select({ status: marketingMaterialsTable.status })
      .from(marketingMaterialsTable)
      .where(eq(marketingMaterialsTable.id, id));
    expect(row.status).toBe("submitted");
  });

  it("locks the content of an approved piece until it is resubmitted", async () => {
    const id = await submit("Locked flyer");
    const approved = await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(reviewer.id))
      .send({ status: "approved" });
    expect(approved.status).toBe(200);

    const edit = await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(admin.id))
      .send({ fileUrl: "https://cdn.example.com/swapped.pdf" });
    expect(edit.status).toBe(409);

    // Non-content metadata (review notes) is still editable.
    const notes = await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(reviewer.id))
      .send({ reviewNotes: "Filed with carrier." });
    expect(notes.status).toBe(200);

    // Resubmitting with the new content is allowed and clears the approval.
    const resubmit = await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(admin.id))
      .send({ status: "submitted", fileUrl: "https://cdn.example.com/swapped.pdf" });
    expect(resubmit.status).toBe(200);
    expect(resubmit.body.status).toBe("submitted");
    expect(resubmit.body.reviewedByUserId).toBeNull();
  });

  it("makes whoever resubmits the submitter, so they cannot approve their own swap", async () => {
    const third = await seedUser(testDb, { orgId: org.id, role: "compliance_manager" });
    const id = await submit("Swap target");
    await request(app).patch(`/api/marketing-materials/${id}`).set(withAuth(reviewer.id)).send({ status: "approved" });

    const swap = await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(third.id))
      .send({ status: "submitted", fileUrl: "https://cdn.example.com/swap.pdf" });
    expect(swap.status).toBe(200);
    expect(swap.body.submittedByUserId).toBe(third.id);

    const selfApprove = await request(app)
      .patch(`/api/marketing-materials/${id}`)
      .set(withAuth(third.id))
      .send({ status: "approved" });
    expect(selfApprove.status).toBe(403);
  });

  it("404s an unknown id", async () => {
    const res = await request(app)
      .patch("/api/marketing-materials/nope")
      .set(withAuth(admin.id))
      .send({ status: "approved" });
    expect(res.status).toBe(404);
  });
});

describe("GET list + summary", () => {
  it("lists with submitter name and reports summary counts", async () => {
    const list = await request(app)
      .get("/api/marketing-materials")
      .set(withAuth(admin.id));
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.body[0].submitterName).toBe("Test User");

    const summary = await request(app)
      .get("/api/marketing-materials/summary")
      .set(withAuth(admin.id));
    expect(summary.status).toBe(200);
    expect(summary.body.approved).toBeGreaterThanOrEqual(1);
    expect(summary.body.pendingReview).toBe(
      summary.body.submitted + summary.body.in_review,
    );
    expect(typeof summary.body.expiringSoon).toBe("number");
  });

  it("filters by status", async () => {
    const res = await request(app)
      .get("/api/marketing-materials?status=approved")
      .set(withAuth(admin.id));
    expect(res.status).toBe(200);
    for (const r of res.body) expect(r.material.status).toBe("approved");
  });
});

describe("marketing — RBAC", () => {
  it("lets a developer read but not submit; blocks agent_support entirely", async () => {
    const dev = await seedUser(testDb, { orgId: org.id, role: "developer" });
    const support = await seedUser(testDb, { orgId: org.id, role: "agent_support" });

    const devRead = await request(app)
      .get("/api/marketing-materials")
      .set(withAuth(dev.id));
    expect(devRead.status).toBe(200);
    const devCreate = await request(app)
      .post("/api/marketing-materials")
      .set(withAuth(dev.id))
      .send({ title: "nope" });
    expect(devCreate.status).toBe(403);

    const supportRead = await request(app)
      .get("/api/marketing-materials")
      .set(withAuth(support.id));
    expect(supportRead.status).toBe(403);
  });
});
