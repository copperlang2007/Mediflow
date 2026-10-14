/**
 * Agency white-label branding API (stage2/calendar-branding).
 *
 * Pins: every org member can read their own org's branding (the shell needs
 * it), only owners can change it, colours must be hex with readable contrast,
 * fonts come from the allowlist, asset URLs are storage paths or https, and
 * one org's branding never leaks into another's.
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
import { organizationsTable } from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser, type TestDb } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let orgA: { id: string };
let orgB: { id: string };
let adminA: { id: string };
let agentA: { id: string };
let complianceA: { id: string };
let adminB: { id: string };

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  app = (await import("../../app")).default;
  request = (await import("supertest")).default;
  orgA = await seedOrg(testDb, { name: "Brand Alpha" });
  orgB = await seedOrg(testDb, { name: "Brand Beta" });
  adminA = await seedUser(testDb, { orgId: orgA.id, role: "agency_admin" });
  agentA = await seedUser(testDb, { orgId: orgA.id, role: "agent" });
  complianceA = await seedUser(testDb, { orgId: orgA.id, role: "compliance_manager" });
  adminB = await seedUser(testDb, { orgId: orgB.id, role: "agency_admin" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("branding", () => {
  it("requires auth", async () => {
    expect((await request(app).get("/api/organizations/me/branding")).status).toBe(401);
  });

  it("returns defaults when nothing is set, readable by an agent", async () => {
    const res = await request(app).get("/api/organizations/me/branding").set(withAuth(agentA.id));
    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.orgName).toBe("Brand Alpha");
    expect(res.body.defaults.productName).toBe("agencyBRIDGE");
    expect(res.body.options.displayFonts).toContain("Outfit");
  });

  it("only owners may change it", async () => {
    const asAgent = await request(app)
      .put("/api/organizations/me/branding")
      .set(withAuth(agentA.id))
      .send({ productName: "Nope" });
    expect(asAgent.status).toBe(403);
    const asCompliance = await request(app)
      .put("/api/organizations/me/branding")
      .set(withAuth(complianceA.id))
      .send({ productName: "Nope" });
    expect(asCompliance.status).toBe(403);
  });

  it("saves a valid brand and normalises hex to lowercase", async () => {
    const res = await request(app)
      .put("/api/organizations/me/branding")
      .set(withAuth(adminA.id))
      .send({
        productName: "Sunrise Senior",
        tagline: "Medicare made simple",
        primaryColor: "#1E3A5F",
        accentColor: "#0f766e",
        displayFont: "Poppins",
        bodyFont: "Inter",
        logoUrl: "/objects/uploads/abc-123",
        markUrl: "https://cdn.example.com/mark.svg",
        emailFromName: "Sunrise Senior Advisors",
      });
    expect(res.status).toBe(200);
    expect(res.body.primaryColor).toBe("#1e3a5f");
    expect(res.body.isDefault).toBe(false);
    expect(res.body.logoUrl).toBe("/objects/uploads/abc-123");
    const [org] = await testDb
      .select({ logoUrl: organizationsTable.logoUrl })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgA.id));
    expect(org.logoUrl).toBe("/objects/uploads/abc-123");
  });

  it("does not leak into another org", async () => {
    const res = await request(app).get("/api/organizations/me/branding").set(withAuth(adminB.id));
    expect(res.body.productName).toBeNull();
    expect(res.body.isDefault).toBe(true);
  });

  it("rejects bad hex, unknown fonts, unsafe URLs and markup in names", async () => {
    const put = (b: Record<string, unknown>) =>
      request(app).put("/api/organizations/me/branding").set(withAuth(adminA.id)).send(b);
    expect((await put({ primaryColor: "red" })).status).toBe(400);
    expect((await put({ primaryColor: "#12345" })).status).toBe(400);
    expect((await put({ displayFont: "Comic Sans MS" })).status).toBe(400);
    expect((await put({ logoUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await put({ faviconUrl: "http://insecure.example.com/f.ico" })).status).toBe(400);
    expect((await put({ productName: "<script>" })).status).toBe(400);
    expect((await put({ emailFromName: "Evil\r\nBcc: x@y.z" })).status).toBe(400);
    expect((await put({ unknownField: 1 })).status).toBe(400);
  });

  it("rejects unreadable (low-contrast) colours and warns on borderline ones", async () => {
    const low = await request(app)
      .put("/api/organizations/me/branding")
      .set(withAuth(adminA.id))
      .send({ accentColor: "#ffeb3b" });
    expect(low.status).toBe(400);
    expect(low.body.code).toBe("low_contrast");

    const borderline = await request(app)
      .put("/api/organizations/me/branding")
      .set(withAuth(adminA.id))
      .send({ accentColor: "#e0701a" });
    expect(borderline.status).toBe(200);
    expect(borderline.body.warnings.length).toBeGreaterThan(0);
  });

  it("reset restores defaults and clears the logo", async () => {
    const res = await request(app).delete("/api/organizations/me/branding").set(withAuth(adminA.id));
    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.logoUrl).toBeNull();
  });
});
