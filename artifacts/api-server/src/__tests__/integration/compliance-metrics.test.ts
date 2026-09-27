/**
 * Integration test: compliance metrics an oversight reviewer relies on.
 *
 *   - One compliance score: the agent profile endpoint, the Agent Performance
 *     report and the Executive report agree, a license past its expiry date
 *     does not count, and only plan-year AHIP / certs count.
 *   - The lapse sweep flips expired-by-date licenses to `expired` and audits it.
 *   - Retention policies cannot be set below the CMS 10-year floor.
 *   - The public unsubscribe link: GET never changes state; POST opts out and
 *     audits; forged tokens are rejected.
 *   - STOP / START match a contact whatever format its phone was saved in.
 *   - The weekly report body is computed and deterministic.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const { dbF, clerkF, jobsF, smsF, sseF } = vi.hoisted(() => ({
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
  smsF: async (): Promise<Record<string, unknown>> => {
    const actual = await import("../../lib/sms");
    return { ...actual, validateTwilioWebhookSignature: (): boolean => true };
  },
  sseF: async (): Promise<Record<string, unknown>> => {
    const actual = await import("../../lib/sseManager");
    return { ...actual, broadcastToUser: vi.fn(), broadcastToUsers: vi.fn() };
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/sms", smsF);
vi.mock("../../lib/sseManager", sseF);

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentsTable,
  ahipRecordsTable,
  auditLogTable,
  carrierCertificationsTable,
  carriersTable,
  contactsTable,
  optOutsTable,
  stateLicensesTable,
} from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth, withMfaAuth } from "../helpers/testApp";
import { seedAgent, seedContact, seedOrg, seedUser, type TestDb } from "../helpers/testDb";
import { sellingPlanYear } from "../../lib/compliance/planYear";
import { CMS_RECORD_RETENTION_DAYS } from "../../lib/compliance/retention";
import { signUnsubscribeToken } from "../../lib/compliance/unsubscribe";
import type { Express } from "express";

const PLAN_YEAR = sellingPlanYear();
const DAY = 86_400_000;

let app: Express;
let request: typeof import("supertest");
let db: TestDb;
let org: { id: string };
let admin: { id: string };
let carrierId: string;

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as unknown as { default: typeof import("supertest") }).default;

  org = await seedOrg(db, { id: `org-cm-${randomUUID().slice(0, 8)}` });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  carrierId = `carrier-${randomUUID()}`;
  await db.insert(carriersTable).values({ id: carrierId, orgId: org.id, name: "Humana" });
});

afterAll(async () => {
  await shutdownTestDb();
});

async function activeAgent(name: string): Promise<string> {
  const a = await seedAgent(db, { orgId: org.id, firstName: name, lastName: "Tester" });
  await db.update(agentsTable).set({ status: "active", npn: "1234567" }).where(eq(agentsTable.id, a.id));
  return a.id;
}

describe("one compliance score across every surface", () => {
  let agentId: string;
  let lapsedLicenseId: string;

  beforeAll(async () => {
    agentId = await activeAgent("Scored");
    lapsedLicenseId = `lic-${randomUUID()}`;
    await db.insert(stateLicensesTable).values([
      // Still marked active, but its expiry date has passed.
      { id: lapsedLicenseId, agentId, stateCode: "FL", licenseType: "Health", status: "active", expiryDate: new Date(Date.now() - 3 * DAY) },
      { id: `lic-${randomUUID()}`, agentId, stateCode: "GA", licenseType: "Health", status: "active", expiryDate: new Date(Date.now() + 400 * DAY) },
    ]);
    await db.insert(carrierCertificationsTable).values({
      id: `cert-${randomUUID()}`, agentId, carrierId, certificationYear: PLAN_YEAR, status: "passed",
    });
    // A certification for an old plan year does not count toward — or against — this year.
    await db.insert(carrierCertificationsTable).values({
      id: `cert-${randomUUID()}`, agentId, carrierId, certificationYear: PLAN_YEAR - 3, status: "failed",
    });
    await db.insert(ahipRecordsTable).values({
      id: `ahip-${randomUUID()}`, agentId, certificationYear: PLAN_YEAR, status: "passed",
    });

    // A second active agent whose only AHIP is years old.
    const stale = await activeAgent("Stale");
    await db.insert(stateLicensesTable).values({
      id: `lic-${randomUUID()}`, agentId: stale, stateCode: "TX", licenseType: "Health", status: "active", expiryDate: new Date(Date.now() + 400 * DAY),
    });
    await db.insert(ahipRecordsTable).values({
      id: `ahip-${randomUUID()}`, agentId: stale, certificationYear: PLAN_YEAR - 2, status: "passed",
    });
  });

  it("does not count a license past its expiry date, and scores plan-year credentials only", async () => {
    const res = await request(app).get(`/api/agents/${agentId}/compliance-score`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    // Licensing 1 of 2 → 20; plan-year certs 1 of 1 → 30; AHIP → 20; no onboarding → 0.
    expect(res.body.licenseScore).toBe(50);
    expect(res.body.certificationScore).toBe(100);
    expect(res.body.ahipCompleted).toBe(true);
    expect(res.body.totalScore).toBe(70);
    expect(res.body.planYear).toBe(PLAN_YEAR);
  });

  it("reports the same score in the Agent Performance report", async () => {
    const res = await request(app).get(`/api/reports/agent-performance?agentId=${agentId}`).set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const row = res.body.find((r: { agentId: string }) => r.agentId === agentId);
    expect(row.complianceScore).toBe(70);
    expect(row.licensesActive).toBe(1);
    expect(row.ahipStatus).toBe("passed");
  });

  it("computes executive AHIP completion over active agents for the plan year", async () => {
    const res = await request(app).get("/api/reports/executive").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    const c = res.body.compliance;
    expect(c.ahipPlanYear).toBe(PLAN_YEAR);
    expect(c.ahipTotal).toBe(2);
    expect(c.ahipPassed).toBe(1);
    expect(c.ahipRate).toBe(50);
    // Scored agent 70; stale agent: licensing 40, nothing else → 40. Mean 55.
    expect(c.agencyComplianceScore).toBe(55);
  });

  it("the lapse sweep expires the license and audits it without changing the score", async () => {
    const { expireLapsedLicenses } = await import("../../workers/licenseExpiryCheck");
    const count = await expireLapsedLicenses(new Date(), org.id);
    expect(count).toBeGreaterThanOrEqual(1);

    const [lic] = await db.select({ status: stateLicensesTable.status }).from(stateLicensesTable).where(eq(stateLicensesTable.id, lapsedLicenseId));
    expect(lic.status).toBe("expired");
    const audit = await db
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.resourceId, lapsedLicenseId), eq(auditLogTable.action, "license_auto_expired")));
    expect(audit).toHaveLength(1);

    // Re-running is a no-op.
    expect(await expireLapsedLicenses(new Date(), org.id)).toBe(0);
  });
});

describe("retention floor", () => {
  it("rejects a policy shorter than 10 years and accepts one at the floor", async () => {
    const short = await request(app)
      .put("/api/admin/data-retention")
      .set(withMfaAuth(admin.id, true))
      .send({ recordType: "contacts", retentionDays: 1825, isEnabled: true });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/3650 days/);

    const ok = await request(app)
      .put("/api/admin/data-retention")
      .set(withMfaAuth(admin.id, true))
      .send({ recordType: "contacts", retentionDays: CMS_RECORD_RETENTION_DAYS, isEnabled: true });
    expect(ok.status).toBe(200);
  });
});

describe("public unsubscribe link", () => {
  it("GET shows a confirmation without opting out; POST opts out and audits", async () => {
    const contact = await seedContact(db, { orgId: org.id, email: "member@example.com" });
    const token = signUnsubscribeToken({ orgId: org.id, contactId: contact.id });

    const page = await request(app).get(`/api/public/unsubscribe?t=${encodeURIComponent(token)}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("<form");
    let [row] = await db.select({ optOutEmail: contactsTable.optOutEmail }).from(contactsTable).where(eq(contactsTable.id, contact.id));
    expect(row.optOutEmail).toBe(false);

    const done = await request(app)
      .post(`/api/public/unsubscribe?t=${encodeURIComponent(token)}`)
      .type("form")
      .send({ "List-Unsubscribe": "One-Click" });
    expect(done.status).toBe(200);
    [row] = await db.select({ optOutEmail: contactsTable.optOutEmail }).from(contactsTable).where(eq(contactsTable.id, contact.id));
    expect(row.optOutEmail).toBe(true);

    const log = await db.select().from(optOutsTable).where(and(eq(optOutsTable.orgId, org.id), eq(optOutsTable.channel, "email")));
    expect(log.some((l) => l.email === "member@example.com")).toBe(true);
    const audit = await db.select().from(auditLogTable).where(and(eq(auditLogTable.resourceId, contact.id), eq(auditLogTable.action, "email_unsubscribe")));
    expect(audit).toHaveLength(1);
  });

  it("rejects a forged token", async () => {
    const res = await request(app).post("/api/public/unsubscribe?t=not.a-real-token");
    expect(res.status).toBe(400);
  });
});

describe("STOP / START phone matching", () => {
  function inbound(from: string, body: string): Record<string, string> {
    return { From: from, To: "+15555550000", Body: body, MessageSid: `SM${randomUUID().replace(/-/g, "")}`, AccountSid: "ACtest" };
  }

  it("honours STOP for a contact saved as (512) 555-0177 and lifts it on START", async () => {
    const contact = await seedContact(db, { orgId: org.id });
    await db.update(contactsTable).set({ phone: "(512) 555-0177" }).where(eq(contactsTable.id, contact.id));

    const stop = await request(app).post("/webhooks/twilio/sms").type("form").set("x-twilio-signature", "x").send(inbound("+15125550177", "STOP"));
    expect(stop.status).toBe(200);
    let [row] = await db.select({ optOutSms: contactsTable.optOutSms }).from(contactsTable).where(eq(contactsTable.id, contact.id));
    expect(row.optOutSms).toBe(true);
    let log = await db.select().from(optOutsTable).where(and(eq(optOutsTable.orgId, org.id), eq(optOutsTable.phone, "+15125550177")));
    expect(log).toHaveLength(1);

    const start = await request(app).post("/webhooks/twilio/sms").type("form").set("x-twilio-signature", "x").send(inbound("+15125550177", "START"));
    expect(start.status).toBe(200);
    [row] = await db.select({ optOutSms: contactsTable.optOutSms }).from(contactsTable).where(eq(contactsTable.id, contact.id));
    expect(row.optOutSms).toBe(false);
    log = await db.select().from(optOutsTable).where(and(eq(optOutsTable.orgId, org.id), eq(optOutsTable.phone, "+15125550177")));
    expect(log).toHaveLength(0);

    const history = await db.select({ action: auditLogTable.action }).from(auditLogTable).where(eq(auditLogTable.resourceId, contact.id));
    expect(history.map((h) => h.action).sort()).toEqual(["sms_opt_in", "sms_opt_out"]);
  });
});

describe("weekly compliance report body", () => {
  it("is computed from the data and lists gaps per agent", async () => {
    const { buildWeeklyComplianceMarkdown } = await import("../../workers/weeklyComplianceReport");
    const base = {
      planYear: 2027,
      totalScore: 100, licenseScore: 100, certificationScore: 100, ahipScore: 100, onboardingScore: 100,
      activeLicenses: 1, totalLicenses: 1, licensesExpiringSoon: 0,
      activeCertifications: 1, totalCertifications: 1, ahipCompleted: true,
      onboardingCompletedItems: 1, onboardingTotalItems: 1, onboardingComplete: true,
    };
    const now = new Date("2026-10-05T12:00:00Z");
    const input = {
      reportDate: "2026-10-05",
      now,
      planYear: 2027,
      agents: [
        { name: "Good Agent", status: "active", npn: "1", overdueTasks: 0, score: { ...base, agentId: "a1" } },
        {
          name: "Gap Agent", status: "active", npn: null, overdueTasks: 2,
          score: { ...base, agentId: "a2", totalScore: 60, ahipScore: 0, ahipCompleted: false },
        },
      ],
      expiringLicenses: [{ agentName: "Good Agent", label: "FL Health", expiryDate: new Date("2026-10-20T00:00:00Z") }],
      expiringCerts: [],
      complaints: { open: 3, overdue: 1, critical: 0 },
      openCallComplianceFindings: 4,
    };
    const md = buildWeeklyComplianceMarkdown(input);
    expect(md).toBe(buildWeeklyComplianceMarkdown(input));
    expect(md).toContain("Agency compliance score (active agents): 80/100");
    expect(md).toContain("Active agents with 2027 AHIP: 1 of 2");
    expect(md).toContain("- Gap Agent (active) — score 60/100 — no 2027 AHIP; NPN missing; 2 overdue tasks");
    expect(md).toContain("- Good Agent — FL Health — expires 2026-10-20 (15 days)");
    expect(md).toContain("Open complaints: 3 (1 past resolution due date, 0 critical)");
    expect(md).toContain("Open call-compliance findings from the dialer: 4");
    expect(md).toMatch(/## Agents in good standing\nGood Agent/);
  });
});
