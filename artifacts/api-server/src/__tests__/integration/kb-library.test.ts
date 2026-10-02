/**
 * Knowledge Base library (migration 0065): platform-wide articles that every
 * agency can read and each agency switches on or off for itself.
 *   - the migration seeds the starting set (guides on, Medicare notes off);
 *   - every staff role can read, only agency owners can choose;
 *   - one agency's choice never changes another agency's view;
 *   - the AI assistant only sees library articles the agency has switched on.
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

import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";
import type { TestDbHandle } from "../helpers/testDb";

let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let request: any;
let handle: TestDbHandle;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let agentUser: { id: string };
let viewer: { id: string };
let otherAdmin: { id: string };

const REFERENCE_ID = "lib-ab-comm-1"; // Medicare note, off by default
const GUIDE_ID = "lib-mf-knowledge-base"; // Mediflow guide, on by default

type LibraryArticle = { id: string; kind: string; enabled: boolean; chosen: boolean; needsReview: boolean };

async function library(userId: string, qs = ""): Promise<{ status: number; body: { articles: LibraryArticle[]; stats: { total: number; enabled: number } } }> {
  const res = await request(app).get(`/api/kb/library${qs}`).set(withAuth(userId));
  return { status: res.status, body: res.body };
}

async function find(userId: string, id: string): Promise<LibraryArticle | undefined> {
  return (await library(userId)).body.articles.find((a) => a.id === id);
}

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(handle.db, { id: "kbl-org" });
  otherOrg = await seedOrg(handle.db, { id: "kbl-other-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  agentUser = await seedUser(handle.db, { orgId: org.id, role: "agent" });
  viewer = await seedUser(handle.db, { orgId: org.id, role: "viewer" });
  otherAdmin = await seedUser(handle.db, { orgId: otherOrg.id, role: "agency_admin" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("KB library — starting content and defaults", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/kb/library");
    expect(res.status).toBe(401);
  });

  it("is seeded by the migration: 31 guides on, 61 Medicare notes off", async () => {
    const { status, body } = await library(admin.id);
    expect(status).toBe(200);
    expect(body.stats.total).toBe(92);
    expect(body.stats.enabled).toBe(31);
    expect(body.articles.filter((a) => a.kind === "mediflow_guide")).toHaveLength(31);
    const notes = body.articles.filter((a) => a.kind === "medicare_reference");
    expect(notes).toHaveLength(61);
    expect(notes.every((a) => !a.enabled && a.needsReview)).toBe(true);
    expect(body.articles.filter((a) => a.kind === "mediflow_guide").every((a) => a.enabled && !a.chosen)).toBe(true);
  });

  it("lets every staff role read", async () => {
    for (const id of [agentUser.id, viewer.id, admin.id]) {
      expect((await library(id)).status).toBe(200);
    }
  });

  it("filters by kind and search", async () => {
    const guides = await library(admin.id, "?kind=mediflow_guide");
    expect(guides.body.articles.every((a) => a.kind === "mediflow_guide")).toBe(true);
    const found = await library(admin.id, "?search=pepm");
    expect(found.body.articles.map((a) => a.id)).toContain(REFERENCE_ID);
  });
});

describe("KB library — an agency chooses for itself", () => {
  it("forbids non-owners from choosing", async () => {
    for (const id of [agentUser.id, viewer.id]) {
      const res = await request(app).put("/api/kb/library/choices").set(withAuth(id)).send({ ids: [REFERENCE_ID], enabled: true });
      expect(res.status).toBe(403);
    }
  });

  it("rejects bad bodies and unknown ids without changing anything", async () => {
    const bad = await request(app).put("/api/kb/library/choices").set(withAuth(admin.id)).send({ ids: [], enabled: true });
    expect(bad.status).toBe(400);
    const unknown = await request(app)
      .put("/api/kb/library/choices")
      .set(withAuth(admin.id))
      .send({ ids: [REFERENCE_ID, "lib-does-not-exist"], enabled: true });
    expect(unknown.status).toBe(404);
    expect((await find(admin.id, REFERENCE_ID))?.enabled).toBe(false);
  });

  it("switches an article on or off for one agency only", async () => {
    const on = await request(app).put("/api/kb/library/choices").set(withAuth(admin.id)).send({ ids: [REFERENCE_ID], enabled: true });
    expect(on.status).toBe(200);
    const off = await request(app).put("/api/kb/library/choices").set(withAuth(admin.id)).send({ ids: [GUIDE_ID], enabled: false });
    expect(off.status).toBe(200);

    expect(await find(admin.id, REFERENCE_ID)).toMatchObject({ enabled: true, chosen: true });
    expect(await find(admin.id, GUIDE_ID)).toMatchObject({ enabled: false, chosen: true });
    // The other agency still sees the defaults.
    expect(await find(otherAdmin.id, REFERENCE_ID)).toMatchObject({ enabled: false, chosen: false });
    expect(await find(otherAdmin.id, GUIDE_ID)).toMatchObject({ enabled: true, chosen: false });

    // Changing it again updates the same choice.
    await request(app).put("/api/kb/library/choices").set(withAuth(admin.id)).send({ ids: [REFERENCE_ID], enabled: false });
    expect(await find(admin.id, REFERENCE_ID)).toMatchObject({ enabled: false, chosen: true });
  });
});

describe("KB library → AI assistant context", () => {
  it("includes only library articles the agency has switched on", async () => {
    const { buildKnowledgeBaseContext } = await import("../../lib/kbContext");
    const question = "how are Medicare Advantage commissions paid pepm";

    // Off by default: not offered to the assistant.
    expect(await buildKnowledgeBaseContext(otherOrg.id, question)).not.toContain("How Medicare Advantage commissions work");

    await request(app).put("/api/kb/library/choices").set(withAuth(otherAdmin.id)).send({ ids: [REFERENCE_ID], enabled: true });
    expect(await buildKnowledgeBaseContext(otherOrg.id, question)).toContain("How Medicare Advantage commissions work");
    // The first agency never switched it on.
    expect(await buildKnowledgeBaseContext(org.id, question)).not.toContain("How Medicare Advantage commissions work");
  });

  it("stops offering a guide once the agency switches it off", async () => {
    const { buildKnowledgeBaseContext } = await import("../../lib/kbContext");
    const question = "knowledge base articles switch on assistant";
    expect(await buildKnowledgeBaseContext(otherOrg.id, question)).toContain("Knowledge Base");
    // `org` switched this guide off in the previous block.
    expect(await buildKnowledgeBaseContext(org.id, question)).not.toContain("Knowledge Base: your articles");
  });
});

describe("KB library → retrieval ranking", () => {
  it("keeps the best match even when more than 25 library articles match", async () => {
    const { buildKnowledgeBaseContext } = await import("../../lib/kbContext");
    const { kbLibraryArticlesTable } = await import("@workspace/db");
    // 30 weak matches (the word only in the body) plus one strong match
    // (keyword + title). Inserted AFTER the weak ones so an unordered LIMIT
    // would be free to drop it.
    await handle.db.insert(kbLibraryArticlesTable).values(
      Array.from({ length: 30 }, (_, i) => ({
        id: `lib-rank-weak-${i}`,
        key: `rank-weak-${i}`,
        category: "Ranking test",
        title: `Weak note ${i}`,
        content: "mentions zorblax once in passing",
        keywords: [],
        kind: "mediflow_guide" as const,
        defaultEnabled: true,
        needsReview: false,
      })),
    );
    await handle.db.insert(kbLibraryArticlesTable).values({
      id: "lib-rank-strong",
      key: "rank-strong",
      category: "Ranking test",
      title: "Zorblax handbook",
      content: "zorblax details",
      keywords: ["zorblax"],
      kind: "mediflow_guide",
      defaultEnabled: true,
      needsReview: false,
    });
    const block = await buildKnowledgeBaseContext(org.id, "zorblax");
    expect(block).toContain("Zorblax handbook");
  });
});

describe("KB library — platform editor (super_admin only)", () => {
  let superAdmin: { id: string };
  let createdId: string;

  beforeAll(async () => {
    superAdmin = await seedUser(handle.db, { orgId: org.id, role: "super_admin" });
  });

  const body = {
    category: "Mediflow Guide: Test",
    title: "Editor test article",
    content: "Written in the platform editor.",
    keywords: ["Editor", " test ", "editor"],
  };

  it("forbids agency owners and other staff from writing the library", async () => {
    for (const id of [admin.id, agentUser.id, viewer.id]) {
      const create = await request(app).post("/api/kb/library/articles").set(withAuth(id)).send(body);
      expect(create.status).toBe(403);
      const patch = await request(app).patch(`/api/kb/library/articles/${GUIDE_ID}`).set(withAuth(id)).send({ title: "hijack" });
      expect(patch.status).toBe(403);
      const del = await request(app).delete(`/api/kb/library/articles/${GUIDE_ID}`).set(withAuth(id));
      expect(del.status).toBe(403);
    }
    expect((await find(admin.id, GUIDE_ID))?.id).toBe(GUIDE_ID);
  });

  it("rejects bad input", async () => {
    const empty = await request(app).post("/api/kb/library/articles").set(withAuth(superAdmin.id)).send({ ...body, title: "  " });
    expect(empty.status).toBe(400);
    const badKind = await request(app).post("/api/kb/library/articles").set(withAuth(superAdmin.id)).send({ ...body, kind: "nope" });
    expect(badKind.status).toBe(400);
    const nothing = await request(app).patch(`/api/kb/library/articles/${GUIDE_ID}`).set(withAuth(superAdmin.id)).send({});
    expect(nothing.status).toBe(400);
  });

  it("creates an article that every agency sees with its defaults", async () => {
    const res = await request(app).post("/api/kb/library/articles").set(withAuth(superAdmin.id)).send(body);
    expect(res.status).toBe(201);
    createdId = res.body.id;
    expect(res.body.keywords).toEqual(["editor", "test"]);
    expect(res.body).toMatchObject({ kind: "mediflow_guide", defaultEnabled: true, needsReview: false });
    for (const id of [admin.id, otherAdmin.id]) {
      expect(await find(id, createdId)).toMatchObject({ enabled: true, chosen: false });
    }
  });

  it("edits an article for every agency, and keeps each agency's own choice", async () => {
    await request(app).put("/api/kb/library/choices").set(withAuth(otherAdmin.id)).send({ ids: [createdId], enabled: false });
    const res = await request(app)
      .patch(`/api/kb/library/articles/${createdId}`)
      .set(withAuth(superAdmin.id))
      .send({ title: "Editor test article (edited)", needsReview: true, defaultEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Editor test article (edited)");
    // Agency with no choice follows the new default; the agency that chose keeps its choice.
    expect(await find(admin.id, createdId)).toMatchObject({ enabled: false, chosen: false, needsReview: true });
    expect(await find(otherAdmin.id, createdId)).toMatchObject({ enabled: false, chosen: true });
    const missing = await request(app).patch("/api/kb/library/articles/lib-nope").set(withAuth(superAdmin.id)).send({ title: "x" });
    expect(missing.status).toBe(404);
  });

  it("deletes an article, and every agency's choice for it goes with it", async () => {
    const del = await request(app).delete(`/api/kb/library/articles/${createdId}`).set(withAuth(superAdmin.id));
    expect(del.status).toBe(204);
    expect(await find(admin.id, createdId)).toBeUndefined();
    expect(await find(otherAdmin.id, createdId)).toBeUndefined();
    const again = await request(app).delete(`/api/kb/library/articles/${createdId}`).set(withAuth(superAdmin.id));
    expect(again.status).toBe(404);
  });
});
