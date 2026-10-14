/**
 * Call scoring routes carry PHI, so privileged roles must have MFA enrolled
 * (same gate as the other PHI/admin routes). Like mfa-required.test.ts this
 * flips NODE_ENV out of "test" so requireMfa actually enforces.
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

import { bootTestDb, shutdownTestDb, withMfaAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let admin: { id: string };
let compliance: { id: string };

const originalNodeEnv = process.env.NODE_ENV;
const originalMfaRequired = process.env.MFA_REQUIRED;

beforeAll(async () => {
  process.env.NODE_ENV = "production";
  process.env.MFA_REQUIRED = "true";
  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  const org = await seedOrg(handle.db, { id: "cs-mfa-org" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  compliance = await seedUser(handle.db, { orgId: org.id, role: "compliance_manager" });
});

afterAll(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalMfaRequired === undefined) delete process.env.MFA_REQUIRED;
  else process.env.MFA_REQUIRED = originalMfaRequired;
  await shutdownTestDb();
});

describe("call scoring requires MFA for privileged roles", () => {
  const routes: Array<[string, string]> = [
    ["get", "/api/call-scoring/config"],
    ["get", "/api/call-scoring/transcripts"],
    ["get", "/api/call-scoring/summary"],
    ["get", "/api/call-scoring/transcripts/some-id"],
    ["post", "/api/call-scoring/transcripts"],
    ["post", "/api/call-scoring/transcripts/some-id/rescore"],
    ["patch", "/api/call-scoring/transcripts/some-id/criteria/rapport"],
    ["get", "/api/call-scoring/dnc-review"],
    ["post", "/api/call-scoring/dnc-review/some-id/resolve"],
    ["post", "/api/call-scoring/import"],
  ];

  it.each(routes)("%s %s is refused without MFA", async (method, url) => {
    for (const u of [admin, compliance]) {
      const res = await (request(app) as any)[method](url).set(withMfaAuth(u.id, false)).send({});
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.error).toBe("mfa_required");
    }
  });

  it("lets an MFA-enrolled admin through", async () => {
    const res = await request(app).get("/api/call-scoring/config").set(withMfaAuth(admin.id, true));
    expect(res.status).toBe(200);
    expect(res.body.ai.status).toBe("needs_setup");
  });
});
