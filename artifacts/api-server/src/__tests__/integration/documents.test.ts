import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// vi.mock is hoisted above all imports. Helper factories live in
// ../helpers/testApp; we reference them through vi.hoisted so the helper
// import inside the factory does not fight the TDZ.
const { dbF, authF, jobsF, storageF, aclF } = vi.hoisted(() => ({
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
  // The download route does `await import("../lib/objectStorage")` and
  // `await import("../lib/objectAcl")` *inside* the handler. We mock both
  // modules so the test never touches a real GCS sidecar.
  storageF: (): Record<string, unknown> => {
    class MockObjectStorageService {
      lastStorageKey: string | null = null;
      async getObjectEntityFile(storageKey: string): Promise<{ name: string }> {
        // Capture the storageKey on the shared spy so tests can assert on it.
        (globalThis as unknown as {
          __TEST_STORAGE_CALLS__: { lastStorageKey: string | null };
        }).__TEST_STORAGE_CALLS__.lastStorageKey = storageKey;
        return { name: storageKey };
      }
      async canAccessObjectEntity(_args: unknown): Promise<boolean> {
        const flag = (globalThis as unknown as {
          __TEST_STORAGE_ACL_RESULT__: boolean;
        }).__TEST_STORAGE_ACL_RESULT__;
        (globalThis as unknown as {
          __TEST_STORAGE_CALLS__: { aclInvoked: boolean };
        }).__TEST_STORAGE_CALLS__.aclInvoked = true;
        return flag;
      }
      async downloadObject(_file: unknown): Promise<Response> {
        // Minimal Response with a stable body so the route can buffer + send.
        return new Response("file-bytes");
      }
    }
    return {
      ObjectStorageService: MockObjectStorageService,
      ObjectNotFoundError: class extends Error {},
    };
  },
  aclF: (): Record<string, unknown> => ({
    ObjectPermission: { READ: "read", WRITE: "write" },
    ObjectAccessGroupType: { ORG_MEMBER: "org_member" },
  }),
}));

vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/objectStorage", storageF);
vi.mock("../../lib/objectAcl", aclF);

import { eq } from "drizzle-orm";
import { documentsTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, seedAgent } from "../helpers/testDb";

import type { Express } from "express";

declare global {
  // eslint-disable-next-line no-var
  var __TEST_STORAGE_CALLS__: {
    lastStorageKey: string | null;
    aclInvoked: boolean;
  };
  // eslint-disable-next-line no-var
  var __TEST_STORAGE_ACL_RESULT__: boolean;
}

let app: Express;
let request: typeof import("supertest");

let orgA: { id: string };
let orgB: { id: string };
let agencyAdmin: { id: string };
let superAdmin: { id: string };
let agentSupport: { id: string };
let viewer: { id: string };
let agentInOrgA: { id: string };
let agentInOrgB: { id: string };

beforeAll(async () => {
  globalThis.__TEST_STORAGE_CALLS__ = {
    lastStorageKey: null,
    aclInvoked: false,
  };
  globalThis.__TEST_STORAGE_ACL_RESULT__ = true;

  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  orgA = await seedOrg(handle.db, { id: "org-docs-a" });
  orgB = await seedOrg(handle.db, { id: "org-docs-b" });

  agencyAdmin = await seedUser(handle.db, { orgId: orgA.id, role: "agency_admin" });
  superAdmin = await seedUser(handle.db, { orgId: orgA.id, role: "super_admin" });
  agentSupport = await seedUser(handle.db, { orgId: orgA.id, role: "agent_support" });
  viewer = await seedUser(handle.db, { orgId: orgA.id, role: "viewer" });

  agentInOrgA = await seedAgent(handle.db, { orgId: orgA.id });
  // BOLA target: an agent that lives in orgB.
  agentInOrgB = await seedAgent(handle.db, { orgId: orgB.id });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  globalThis.__TEST_STORAGE_CALLS__ = {
    lastStorageKey: null,
    aclInvoked: false,
  };
  globalThis.__TEST_STORAGE_ACL_RESULT__ = true;
});

describe("Documents integration", () => {
  it("POST /agents/:id/documents (agency_admin) creates a document row scoped to org+agent", async () => {
    const handle = await bootTestDb();
    const res = await request(app)
      .post(`/api/agents/${agentInOrgA.id}/documents`)
      .set(withAuth(agencyAdmin.id))
      .send({
        name: "EO Cert 2026.pdf",
        category: "eo_certificate",
        storageKey: "/objects/uploads/eo-2026",
        mimeType: "application/pdf",
        fileSizeBytes: 2048,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      orgId: orgA.id,
      agentId: agentInOrgA.id,
      name: "EO Cert 2026.pdf",
      category: "eo_certificate",
      storageKey: "/objects/uploads/eo-2026",
    });

    const [row] = await handle.db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.id, res.body.id));
    expect(row).toBeDefined();
    expect(row.orgId).toBe(orgA.id);
    expect(row.agentId).toBe(agentInOrgA.id);
    expect(row.uploadedBy).toBe(agencyAdmin.id);
  });

  it("POST /agents/:id/documents as viewer is rejected by RBAC with 403", async () => {
    const res = await request(app)
      .post(`/api/agents/${agentInOrgA.id}/documents`)
      .set(withAuth(viewer.id))
      .send({
        name: "viewer-attempt.pdf",
        category: "other",
        storageKey: "/objects/uploads/viewer-attempt",
      });
    expect(res.status).toBe(403);
  });

  it("POST /agents/:id/documents for an agent in another org returns 404 (BOLA defense)", async () => {
    // Even with super_admin, the route MUST scope by req.orgId and 404 the
    // cross-org agent lookup, not silently attach the document.
    const res = await request(app)
      .post(`/api/agents/${agentInOrgB.id}/documents`)
      .set(withAuth(superAdmin.id))
      .send({
        name: "leak.pdf",
        category: "other",
        storageKey: "/objects/uploads/leak",
      });
    expect(res.status).toBe(404);
  });

  it("GET /documents (agent_support in orgA) returns only orgA's documents", async () => {
    const handle = await bootTestDb();
    // Seed a doc in orgB that must NOT leak.
    await handle.db.insert(documentsTable).values({
      id: "doc-orgb-leak",
      orgId: orgB.id,
      agentId: agentInOrgB.id,
      name: "orgb-secret.pdf",
      category: "other",
      storageKey: "/objects/uploads/orgb-secret",
    });

    const res = await request(app)
      .get("/api/documents")
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("documents");
    const docs = res.body.documents as Array<{ orgId: string; id: string }>;
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.orgId === orgA.id)).toBe(true);
    expect(docs.find((d) => d.id === "doc-orgb-leak")).toBeUndefined();
  });

  it("GET /documents?agentId=X filters to that agent only", async () => {
    const handle = await bootTestDb();
    const otherAgent = await seedAgent(handle.db, { orgId: orgA.id });
    await handle.db.insert(documentsTable).values([
      {
        id: "doc-target-agent-1",
        orgId: orgA.id,
        agentId: agentInOrgA.id,
        name: "target.pdf",
        category: "other",
        storageKey: "/objects/uploads/target-1",
      },
      {
        id: "doc-other-agent-1",
        orgId: orgA.id,
        agentId: otherAgent.id,
        name: "other.pdf",
        category: "other",
        storageKey: "/objects/uploads/other-1",
      },
    ]);

    const res = await request(app)
      .get(`/api/documents?agentId=${agentInOrgA.id}`)
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    const docs = res.body.documents as Array<{ agentId: string }>;
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.agentId === agentInOrgA.id)).toBe(true);
  });

  it("GET /documents?category=eo_certificate filters to that category only", async () => {
    const handle = await bootTestDb();
    await handle.db.insert(documentsTable).values([
      {
        id: "doc-eo-cat-1",
        orgId: orgA.id,
        agentId: agentInOrgA.id,
        name: "eo.pdf",
        category: "eo_certificate",
        storageKey: "/objects/uploads/eo-cat-1",
      },
      {
        id: "doc-other-cat-1",
        orgId: orgA.id,
        agentId: agentInOrgA.id,
        name: "license.pdf",
        category: "license",
        storageKey: "/objects/uploads/other-cat-1",
      },
    ]);

    const res = await request(app)
      .get("/api/documents?category=eo_certificate")
      .set(withAuth(agentSupport.id));
    expect(res.status).toBe(200);
    const docs = res.body.documents as Array<{ category: string }>;
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.category === "eo_certificate")).toBe(true);
  });

  it("GET /documents/:docId/download (same org) reaches storage with the right storageKey and runs the ACL check", async () => {
    const handle = await bootTestDb();
    const storageKey = "/objects/uploads/download-target";
    await handle.db.insert(documentsTable).values({
      id: "doc-dl-1",
      orgId: orgA.id,
      agentId: agentInOrgA.id,
      name: "download-me.pdf",
      category: "other",
      storageKey,
      mimeType: "application/pdf",
    });

    globalThis.__TEST_STORAGE_ACL_RESULT__ = true;
    const res = await request(app)
      .get("/api/documents/doc-dl-1/download")
      .set(withAuth(agencyAdmin.id));

    expect(res.status).toBe(200);
    expect(globalThis.__TEST_STORAGE_CALLS__.lastStorageKey).toBe(storageKey);
    expect(globalThis.__TEST_STORAGE_CALLS__.aclInvoked).toBe(true);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("GET /documents/:docId/download for a doc in a different org returns 404 (org-scope check)", async () => {
    const handle = await bootTestDb();
    await handle.db.insert(documentsTable).values({
      id: "doc-orgb-dl",
      orgId: orgB.id,
      agentId: agentInOrgB.id,
      name: "orgb.pdf",
      category: "other",
      storageKey: "/objects/uploads/orgb-dl",
    });

    const res = await request(app)
      .get("/api/documents/doc-orgb-dl/download")
      .set(withAuth(agencyAdmin.id));
    expect(res.status).toBe(404);
    // Storage layer must NOT have been touched for a cross-org doc.
    expect(globalThis.__TEST_STORAGE_CALLS__.lastStorageKey).toBeNull();
  });

  it("GET /documents/:docId/download returns 403 when the ACL check denies", async () => {
    const handle = await bootTestDb();
    await handle.db.insert(documentsTable).values({
      id: "doc-acl-deny",
      orgId: orgA.id,
      agentId: agentInOrgA.id,
      name: "denied.pdf",
      category: "other",
      storageKey: "/objects/uploads/acl-deny",
    });

    globalThis.__TEST_STORAGE_ACL_RESULT__ = false;
    const res = await request(app)
      .get("/api/documents/doc-acl-deny/download")
      .set(withAuth(agencyAdmin.id));
    expect(res.status).toBe(403);
    expect(globalThis.__TEST_STORAGE_CALLS__.aclInvoked).toBe(true);
  });

  it("DELETE /documents/:docId (super_admin) removes the row and returns 204", async () => {
    const handle = await bootTestDb();
    await handle.db.insert(documentsTable).values({
      id: "doc-del-1",
      orgId: orgA.id,
      agentId: agentInOrgA.id,
      name: "delete-me.pdf",
      category: "other",
      storageKey: "/objects/uploads/del-1",
    });

    const res = await request(app)
      .delete("/api/documents/doc-del-1")
      .set(withAuth(superAdmin.id));
    expect(res.status).toBe(204);

    const rows = await handle.db
      .select()
      .from(documentsTable)
      .where(eq(documentsTable.id, "doc-del-1"));
    // Hard delete in the route — confirm the row is gone.
    expect(rows.length).toBe(0);
  });
});
