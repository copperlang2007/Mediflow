/**
 * Integration test: automation-rule messages to consumers carry the compliance
 * context that the send-time gate needs (lib/compliance/consumerDelivery.ts).
 *
 *   - send_sms / send_email on a contact trigger → job carries
 *     consumer { contactId, automated: true }.
 *   - an explicit `to` in the rule config is an internal notification → no
 *     consumer context.
 *   - a consumer send with no contact record to check opt-outs against is not
 *     enqueued at all.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { dbF, jobsF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  jobsF: async (): Promise<Record<string, unknown>> => {
    const { jobsMockFactory } = await import("../helpers/testApp");
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("../../lib/jobs", jobsF);

import { randomUUID } from "node:crypto";
import { bootTestDb, shutdownTestDb, getEnqueuedJobs, clearEnqueuedJobs } from "../helpers/testApp";
import { seedOrg, seedContact, seedAutomationRule, type TestDb } from "../helpers/testDb";

let db: TestDb;
let runAutomationRulesWorker: typeof import("../../workers/runAutomationRules").runAutomationRulesWorker;

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  ({ runAutomationRulesWorker } = await import("../../workers/runAutomationRules"));
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => clearEnqueuedJobs());

type Job = { name: string; data: Record<string, unknown> };
const jobs = () => getEnqueuedJobs() as Job[];

describe("automation rules → consumer outreach context", () => {
  it("tags contact-targeted SMS and email as automated consumer outreach", async () => {
    const org = await seedOrg(db, { id: `org-auto-${randomUUID().slice(0, 8)}` });
    const contact = await seedContact(db, { orgId: org.id, email: "lead@example.com" });
    await seedAutomationRule(db, {
      orgId: org.id,
      triggerType: "contact_created",
      actions: [
        { type: "send_sms", config: { body: "Thanks for reaching out" } },
        { type: "send_email", config: { subject: "Welcome", html: "<p>Hi</p>" } },
      ],
    });

    await runAutomationRulesWorker({ orgId: org.id, trigger: "contact_created", resourceType: "contact", resourceId: contact.id });

    const sms = jobs().find((j) => j.name === "send-scheduled-sms");
    const email = jobs().find((j) => j.name === "send-scheduled-email");
    expect(sms?.data.consumer).toEqual({ orgId: org.id, contactId: contact.id, automated: true });
    expect(email?.data.consumer).toEqual({ orgId: org.id, contactId: contact.id, automated: true });
  });

  it("treats an explicit recipient as an internal notification", async () => {
    const org = await seedOrg(db, { id: `org-auto-${randomUUID().slice(0, 8)}` });
    const contact = await seedContact(db, { orgId: org.id });
    await seedAutomationRule(db, {
      orgId: org.id,
      triggerType: "contact_created",
      actions: [{ type: "send_email", config: { to: "manager@agency.example", subject: "New lead", html: "<p>x</p>" } }],
    });

    await runAutomationRulesWorker({ orgId: org.id, trigger: "contact_created", resourceType: "contact", resourceId: contact.id });

    const email = jobs().find((j) => j.name === "send-scheduled-email");
    expect(email?.data.to).toBe("manager@agency.example");
    expect(email?.data.consumer).toBeUndefined();
  });

  it("does not send to a consumer address with no contact behind it", async () => {
    const org = await seedOrg(db, { id: `org-auto-${randomUUID().slice(0, 8)}` });
    await seedAutomationRule(db, {
      orgId: org.id,
      triggerType: "lead_created",
      actions: [{ type: "send_sms", config: { body: "Hello" } }],
    });

    await runAutomationRulesWorker({
      orgId: org.id,
      trigger: "lead_created",
      resourceType: "lead",
      resourceId: `lead-${randomUUID()}`,
      context: { phone: "+15125550100" },
    });

    expect(jobs().filter((j) => j.name === "send-scheduled-sms")).toHaveLength(0);
  });
});
