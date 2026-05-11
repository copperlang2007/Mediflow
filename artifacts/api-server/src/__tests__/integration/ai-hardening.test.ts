/**
 * Integration test: AI security hardening (PR #32).
 *
 * Two concerns:
 *   1. Per-endpoint rate limits on the AI routes (`/ai/chat`, `/ai/draft`,
 *      `/ai/compliance-report`) actually return 429 once the per-user cap
 *      is reached, and the cap is per-user (not global).
 *   2. The system prompts built by `lib/aiContext.ts` no longer leak PHI
 *      (Medicare ID, DOB, raw health conditions) and instead summarize.
 *
 * Mocking strategy:
 *   - We do NOT need to mock the OpenAI client. The rate-limit middleware
 *     in `routes/ai.ts` runs BEFORE the upstream call, so even when the
 *     downstream `getOpenAI()` returns `null` and the handler responds 503,
 *     the limiter has already counted the request. The 31st request still
 *     short-circuits to 429 before any OpenAI logic runs.
 *   - The PHI tests invoke `buildContactContext` / `buildAgentContext`
 *     directly against the test DB — no HTTP, no AI client.
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
import { seedOrg, seedUser, seedAgent, seedContact } from "../helpers/testDb";

import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");

let org: { id: string };
let userA: { id: string };
let userB: { id: string };
let complianceUser: { id: string };
let contactWithPhi: { id: string };
let agentWithNpn: { id: string };

const REAL_MEDICARE_ID = "9XX-YY-ZZ77";
const REAL_DOB = new Date("1942-03-15T00:00:00Z");
const REAL_HEALTH_CONDITIONS = ["diabetes", "hypertension"];
const REAL_NPN = "1234567";

beforeAll(async () => {
  // Ensure the OpenAI client returns null inside the route — tests should
  // never make a real upstream call. Leaving the env vars unset achieves this.
  delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;

  const handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = (await import("supertest") as any).default;

  org = await seedOrg(handle.db, { id: "ai-hardening-org" });
  // agency_admin has both `contact:read` and `compliance_report:create`
  userA = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  userB = await seedUser(handle.db, { orgId: org.id, role: "agency_admin" });
  complianceUser = await seedUser(handle.db, {
    orgId: org.id,
    role: "compliance_manager",
  });

  contactWithPhi = await seedContact(handle.db, {
    orgId: org.id,
    firstName: "Phi",
    lastName: "Carrier",
    medicareId: REAL_MEDICARE_ID,
    dob: REAL_DOB,
    healthConditions: REAL_HEALTH_CONDITIONS,
  });

  agentWithNpn = await seedAgent(handle.db, {
    orgId: org.id,
    firstName: "Npn",
    lastName: "Holder",
  });
  // seedAgent doesn't take an NPN field, so set it directly via drizzle.
  const { agentsTable } = await import("@workspace/db/schema");
  const { eq } = await import("drizzle-orm");
  await handle.db
    .update(agentsTable)
    .set({ npn: REAL_NPN })
    .where(eq(agentsTable.id, agentWithNpn.id));
});

afterAll(async () => {
  await shutdownTestDb();
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe("AI rate limits", () => {
  /**
   * /ai/chat is capped at 30/min/user. With OpenAI not configured the route
   * responds 503, but the rate-limit middleware still counts the request, so
   * the 31st attempt returns 429.
   */
  it("/ai/chat returns 429 on the 31st request from the same user", async () => {
    const headers = withAuth(userA.id);
    const body = { message: "hello", history: [], context: { pageType: "other" as const } };

    for (let i = 0; i < 30; i++) {
      const res = await request(app).post("/api/ai/chat").set(headers).send(body);
      // Either 503 (no OpenAI configured) or 200 — never 429 inside the cap.
      expect(res.status).not.toBe(429);
    }

    const blocked = await request(app).post("/api/ai/chat").set(headers).send(body);
    expect(blocked.status).toBe(429);
  });

  /**
   * The per-endpoint limiter is keyed by userId, not IP, so a different user
   * starts with a fresh budget. Verify by sending 31 requests as `userB`
   * AFTER `userA` has been exhausted by the previous test.
   */
  it("/ai/chat budget is per-user, not global (userB unaffected by userA)", async () => {
    const headers = withAuth(userB.id);
    const body = { message: "hi", history: [], context: { pageType: "other" as const } };

    for (let i = 0; i < 30; i++) {
      const res = await request(app).post("/api/ai/chat").set(headers).send(body);
      expect(res.status).not.toBe(429);
    }
    // userB's 31st should now also block — confirms the per-user counter
    // applied independently and reached its own cap.
    const blocked = await request(app).post("/api/ai/chat").set(headers).send(body);
    expect(blocked.status).toBe(429);
  });

  /**
   * /ai/draft is capped at 20/min/user. 21st request → 429.
   * Uses `complianceUser` so previous /ai/chat tests on userA/userB don't
   * cross-contaminate this limiter.
   */
  it("/ai/draft returns 429 on the 21st request from the same user", async () => {
    const headers = withAuth(complianceUser.id);
    // contactId is required by zod; route also looks it up, but a 404 still
    // counts against the rate-limit budget the same as a 200/503 would.
    const body = { channel: "sms" as const, contactId: contactWithPhi.id, goal: "follow up" };

    for (let i = 0; i < 20; i++) {
      const res = await request(app).post("/api/ai/draft").set(headers).send(body);
      expect(res.status).not.toBe(429);
    }

    const blocked = await request(app).post("/api/ai/draft").set(headers).send(body);
    expect(blocked.status).toBe(429);
  });

  /**
   * /ai/compliance-report is capped at 5/min/user. 6th request → 429.
   * Uses a dedicated user (`complianceUser`) so previous tests don't pollute
   * its budget.
   */
  it("/ai/compliance-report returns 429 on the 6th request from the same user", async () => {
    const headers = withAuth(complianceUser.id);

    for (let i = 0; i < 5; i++) {
      const res = await request(app).post("/api/ai/compliance-report").set(headers).send({});
      expect(res.status).not.toBe(429);
    }

    const blocked = await request(app).post("/api/ai/compliance-report").set(headers).send({});
    expect(blocked.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// PHI scrubbing in AI context builders
// ---------------------------------------------------------------------------

describe("AI context PHI scrubbing", () => {
  it("buildContactContext omits Medicare ID, DOB, and raw health conditions", async () => {
    const { buildContactContext } = await import("../../lib/aiContext");
    const ctx = await buildContactContext(contactWithPhi.id, org.id);

    // Medicare ID must not appear anywhere in the system prompt.
    expect(ctx).not.toContain(REAL_MEDICARE_ID);

    // DOB must not appear in any common rendering — ISO date, year alone, or
    // bare year-month-day fragments.
    expect(ctx).not.toContain("1942-03-15");
    expect(ctx).not.toContain("1942");
    expect(ctx).not.toContain("03-15");

    // Raw condition labels must not appear; only a count is acceptable.
    expect(ctx).not.toContain("diabetes");
    expect(ctx).not.toContain("hypertension");
  });

  it("buildContactContext summarizes health conditions as a count", async () => {
    const { buildContactContext } = await import("../../lib/aiContext");
    const ctx = await buildContactContext(contactWithPhi.id, org.id);

    // Post-#32 format renders "<n> documented" instead of the raw list.
    expect(ctx).toMatch(/2\s+documented/);
  });

  it("buildAgentContext renders NPN as a presence flag, not the raw value", async () => {
    const { buildAgentContext } = await import("../../lib/aiContext");
    const ctx = await buildAgentContext(agentWithNpn.id, org.id);

    expect(ctx).not.toContain(REAL_NPN);
    // Post-#32: "NPN on file: yes" (or "missing" when null).
    expect(ctx).toContain("NPN on file:");
    expect(ctx).toMatch(/NPN on file:\s*(yes|missing)/);
  });
});
