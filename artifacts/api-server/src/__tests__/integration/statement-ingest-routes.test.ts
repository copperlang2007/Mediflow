/**
 * /api/commissions/ingest: configure the watched folder and work the review list.
 * Org-scoped, gated on commission:read / commission:update (+ MFA for writes).
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
import { carriersTable, commissionStatementsTable, statementIngestFilesTable, statementIngestSourcesTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth, clearEnqueuedJobs } from "../helpers/testApp";
import { seedOrg, seedUser, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let db: TestDb;
let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let support: { id: string };
let otherAdmin: { id: string };
let humanaId: string;
let otherCarrierId: string;

async function seedFile(orgId: string, sourceId: string, over: Partial<typeof statementIngestFilesTable.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(statementIngestFilesTable).values({
    id, orgId, sourceId, externalId: `ext-${id}`, checksum: "c", fileName: "a.csv", status: "needs_review", reason: "x", ...over,
  });
  return id;
}

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  org = await seedOrg(db);
  otherOrg = await seedOrg(db);
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  support = await seedUser(db, { orgId: org.id, role: "agent_support" });
  otherAdmin = await seedUser(db, { orgId: otherOrg.id, role: "agency_admin" });
  humanaId = `carrier-${randomUUID()}`;
  otherCarrierId = `carrier-${randomUUID()}`;
  await db.insert(carriersTable).values([
    { id: humanaId, orgId: org.id, name: "Humana", isActive: true },
    { id: otherCarrierId, orgId: otherOrg.id, name: "Humana", isActive: true },
  ]);
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => clearEnqueuedJobs());

describe("PUT /api/commissions/ingest/source", () => {
  it("creates the source, then updates the same one", async () => {
    const created = await request(app)
      .put("/api/commissions/ingest/source")
      .set(withAuth(admin.id))
      .send({ folderId: "folder-1", mode: "hold" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ folderId: "folder-1", mode: "hold", enabled: true });

    const updated = await request(app)
      .put("/api/commissions/ingest/source")
      .set(withAuth(admin.id))
      .send({ folderId: "folder-2", mode: "auto", carrierFolderMap: { "Q3 Payments": humanaId } });
    expect(updated.status).toBe(200);
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body).toMatchObject({ folderId: "folder-2", mode: "auto" });
  });

  it("rejects a bad mode and an empty folder", async () => {
    const res = await request(app).put("/api/commissions/ingest/source").set(withAuth(admin.id)).send({ folderId: "", mode: "yolo" });
    expect(res.status).toBe(400);
  });

  it("rejects a mapping to another org's carrier", async () => {
    const res = await request(app)
      .put("/api/commissions/ingest/source")
      .set(withAuth(admin.id))
      .send({ folderId: "f", mode: "hold", carrierFolderMap: { X: otherCarrierId } });
    expect(res.status).toBe(400);
  });

  it("is forbidden to a read-only role", async () => {
    const res = await request(app).put("/api/commissions/ingest/source").set(withAuth(support.id)).send({ folderId: "f", mode: "hold" });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/commissions/ingest", () => {
  it("lists only this org's files, filtered by status", async () => {
    const [mine] = await db.select().from(statementIngestSourcesTable).where(eq(statementIngestSourcesTable.orgId, org.id));
    const flagged = await seedFile(org.id, mine.id, { status: "needs_review" });
    await seedFile(org.id, mine.id, { status: "held" });

    const [otherSrc] = await db
      .insert(statementIngestSourcesTable)
      .values({ id: randomUUID(), orgId: otherOrg.id, kind: "drive", folderId: "ofolder", mode: "hold" })
      .returning();
    const foreign = await seedFile(otherOrg.id, otherSrc.id);

    const res = await request(app).get("/api/commissions/ingest?status=needs_review").set(withAuth(support.id));
    expect(res.status).toBe(200);
    const ids = res.body.files.map((f: { id: string }) => f.id);
    expect(ids).toContain(flagged);
    expect(ids).not.toContain(foreign);
    expect(res.body.files.every((f: { status: string }) => f.status === "needs_review")).toBe(true);
    expect(res.body.source.orgId).toBe(org.id);
  });
});

describe("file actions", () => {
  let sourceId: string;
  beforeAll(async () => {
    const [mine] = await db.select().from(statementIngestSourcesTable).where(eq(statementIngestSourcesTable.orgId, org.id));
    sourceId = mine.id;
  });

  it("retry deletes a failed file's ledger row so the next poll re-reads it", async () => {
    const id = await seedFile(org.id, sourceId, { status: "failed" });
    const res = await request(app).post(`/api/commissions/ingest/files/${id}/retry`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(await db.select().from(statementIngestFilesTable).where(eq(statementIngestFilesTable.id, id))).toHaveLength(0);
  });

  it("retry refuses a file that already produced a statement, and a held file", async () => {
    const statementId = `stmt-${randomUUID()}`;
    await db.insert(commissionStatementsTable).values({
      id: statementId, orgId: org.id, carrierId: humanaId, statementDate: "2026-01-31",
      periodStart: "2026-01-01", periodEnd: "2026-01-31", currency: "USD", source: "api", status: "reconciled",
    });
    const withStatement = await seedFile(org.id, sourceId, { status: "needs_review", statementId });
    const held = await seedFile(org.id, sourceId, { status: "held" });
    for (const id of [withStatement, held]) {
      const res = await request(app).post(`/api/commissions/ingest/files/${id}/retry`).set(withAuth(admin.id));
      expect(res.status).toBe(409);
      expect(await db.select().from(statementIngestFilesTable).where(eq(statementIngestFilesTable.id, id))).toHaveLength(1);
    }
  });

  it("dismiss clears a flagged file", async () => {
    const id = await seedFile(org.id, sourceId, { status: "needs_review" });
    const res = await request(app).post(`/api/commissions/ingest/files/${id}/dismiss`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(statementIngestFilesTable).where(eq(statementIngestFilesTable.id, id));
    expect(row.status).toBe("dismissed");
  });

  it("another org cannot act on this org's files", async () => {
    const id = await seedFile(org.id, sourceId, { status: "needs_review" });
    for (const action of ["retry", "dismiss", "approve"]) {
      const res = await request(app).post(`/api/commissions/ingest/files/${id}/${action}`).set(withAuth(otherAdmin.id));
      expect([404, 409]).toContain(res.status);
    }
    const [row] = await db.select().from(statementIngestFilesTable).where(eq(statementIngestFilesTable.id, id));
    expect(row.status).toBe("needs_review");
  });

  it("approve returns 409 when there is no statement to reconcile", async () => {
    const id = await seedFile(org.id, sourceId, { status: "needs_review", statementId: null });
    const res = await request(app).post(`/api/commissions/ingest/files/${id}/approve`).set(withAuth(admin.id));
    expect(res.status).toBe(409);
  });
});

describe("POST /api/commissions/ingest/check", () => {
  it("queues a poll for the org's enabled source", async () => {
    const res = await request(app).post("/api/commissions/ingest/check").set(withAuth(admin.id));
    expect(res.status).toBe(202);
    const queued = (globalThis.__TEST_ENQUEUED__ ?? []) as Array<{ name: string }>;
    expect(queued.some((j) => j.name === "statement-ingest-poll")).toBe(true);
  });

  it("404s when the org has no source", async () => {
    const bare = await seedOrg(db);
    const bareAdmin = await seedUser(db, { orgId: bare.id, role: "agency_admin" });
    const res = await request(app).post("/api/commissions/ingest/check").set(withAuth(bareAdmin.id));
    expect(res.status).toBe(404);
  });
});
