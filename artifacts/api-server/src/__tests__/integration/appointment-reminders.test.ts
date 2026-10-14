/**
 * Appointment reminder sweep + `create_appointment` automation action
 * (stage2/calendar-branding).
 *
 * Reminder pins: channels come from the shared consumer outreach gate — SMS
 * respects the contact's opt-out, the STOP list, TCPA consent and texting
 * hours (deferred, never sent at night); email respects its opt-out; jobs
 * carry consumer context so the gate re-checks at send time;
 * the claim makes the sweep idempotent; content carries no notes.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

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
    const base = jobsMockFactory();
    const baseEnqueue = base.enqueue as (name: string, data: unknown) => Promise<string>;
    return {
      ...base,
      // Tests flip this to simulate pg-boss being unavailable.
      enqueue: async (name: string, data: unknown): Promise<string> => {
        if ((globalThis as { __FAIL_ENQUEUE__?: boolean }).__FAIL_ENQUEUE__) {
          throw new Error("queue unavailable");
        }
        return baseEnqueue(name, data);
      },
    };
  },
}));

vi.mock("@workspace/db", dbF);
vi.mock("../../lib/auth/identity", authF);
vi.mock("../../lib/jobs", jobsF);

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  appointmentsTable,
  contactsTable,
  optOutsTable,
  orgBrandingTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  getEnqueuedJobs,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import { seedOrg, seedAgent, seedContact, seedAutomationRule, type TestDb } from "../helpers/testDb";

let testDb: TestDb;
let worker: typeof import("../../workers/appointmentReminders").appointmentRemindersWorker;
let runRules: typeof import("../../workers/runAutomationRules").runAutomationRulesWorker;
let org: { id: string };
let agent: { id: string };

// 12:00 in New York (EDT) — inside the 08:00–21:00 window.
const NOON_NY = new Date("2026-10-12T16:00:00.000Z");
// 02:00 in New York — outside it.
const NIGHT_NY = new Date("2026-10-12T06:00:00.000Z");

async function contact(over: {
  phone?: string | null;
  email?: string | null;
  stateCode?: string | null;
  optOutSms?: boolean;
  optOutEmail?: boolean;
  /** Documented TCPA consent; on by default (the org requires it for automated SMS). */
  consent?: boolean;
}) {
  const c = await seedContact(testDb, { orgId: org.id, firstName: "Rita" });
  await testDb
    .update(contactsTable)
    .set({
      phone: over.phone === undefined ? `+1555${Math.floor(1000000 + Math.random() * 8999999)}` : over.phone,
      email: over.email === undefined ? `${c.id}@example.test` : over.email,
      stateCode: over.stateCode === undefined ? "NY" : over.stateCode,
      optOutSms: over.optOutSms ?? false,
      optOutEmail: over.optOutEmail ?? false,
      tcpaConsentAt: over.consent === false ? null : new Date("2026-01-05T15:00:00Z"),
      tcpaConsentSource: over.consent === false ? null : "signed SOA form #123",
    })
    .where(eq(contactsTable.id, c.id));
  const [row] = await testDb.select().from(contactsTable).where(eq(contactsTable.id, c.id));
  return row;
}

async function appt(contactId: string, startsAt: Date, status: "confirmed" | "pending" | "cancelled" = "confirmed") {
  const id = randomUUID();
  await testDb.insert(appointmentsTable).values({
    id,
    orgId: org.id,
    contactId,
    agentId: agent.id,
    type: "review",
    title: "Plan review",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    status,
    locationType: "phone",
  });
  return id;
}

function jobsTo(to: string) {
  return getEnqueuedJobs().filter((j) => (j.data as { to?: string }).to === to);
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  worker = (await import("../../workers/appointmentReminders")).appointmentRemindersWorker;
  runRules = (await import("../../workers/runAutomationRules")).runAutomationRulesWorker;
  org = await seedOrg(testDb, { name: "Reminder Org" });
  agent = await seedAgent(testDb, { orgId: org.id, firstName: "Carla", lastName: "Reyes" });
  await testDb.insert(orgBrandingTable).values({ orgId: org.id, productName: "Sunrise", emailFromName: "Sunrise Advisors" });
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => clearEnqueuedJobs());

describe("appointment reminders", () => {
  it("texts and emails inside calling hours, once", async () => {
    const c = await contact({});
    const id = await appt(c.id, new Date(NOON_NY.getTime() + 3 * 3600_000));
    await worker(NOON_NY);
    const sms = jobsTo(c.phone!);
    const email = jobsTo(c.email!);
    expect(sms).toHaveLength(1);
    expect(sms[0].name).toBe("send-scheduled-sms");
    expect((sms[0].data as { body: string }).body).toContain("Sunrise");
    expect((sms[0].data as { body: string }).body).toContain("Carla Reyes");
    expect(email).toHaveLength(1);
    expect((email[0].data as { fromName?: string }).fromName).toBe("Sunrise Advisors");

    const [row] = await testDb.select().from(appointmentsTable).where(eq(appointmentsTable.id, id));
    expect(row.reminderSentAt).not.toBeNull();

    clearEnqueuedJobs();
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(0);
    expect(jobsTo(c.email!)).toHaveLength(0);
  });

  it("respects the contact's SMS and email opt-outs", async () => {
    const noSms = await contact({ optOutSms: true });
    const noEmail = await contact({ optOutEmail: true });
    await appt(noSms.id, new Date(NOON_NY.getTime() + 2 * 3600_000 + 60_000));
    await appt(noEmail.id, new Date(NOON_NY.getTime() + 2 * 3600_000 + 60_000));
    await worker(NOON_NY);
    expect(jobsTo(noSms.phone!)).toHaveLength(0);
    expect(jobsTo(noSms.email!)).toHaveLength(1);
    expect(jobsTo(noEmail.phone!)).toHaveLength(1);
    expect(jobsTo(noEmail.email!)).toHaveLength(0);
  });

  it("respects the STOP list even when the contact flag is not set", async () => {
    const c = await contact({});
    await testDb.insert(optOutsTable).values({ id: randomUUID(), orgId: org.id, phone: c.phone, channel: "sms" });
    await appt(c.id, new Date(NOON_NY.getTime() + 4 * 3600_000));
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(0);
    expect(jobsTo(c.email!)).toHaveLength(1);
  });

  it("matches the STOP list on the E.164 form of a formatted contact phone", async () => {
    const digits = `${Math.floor(1000000 + Math.random() * 8999999)}`;
    const c = await contact({ phone: `(555) ${digits.slice(0, 3)}-${digits.slice(3)}` });
    await testDb.insert(optOutsTable).values({ id: randomUUID(), orgId: org.id, phone: `+1555${digits}`, channel: "sms" });
    await appt(c.id, new Date(NOON_NY.getTime() + 4 * 3600_000));
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(0);
    expect(jobsTo(c.email!)).toHaveLength(1);
  });

  it("honours a STOP recorded under another org (shared Twilio number)", async () => {
    const other = await seedOrg(testDb, { name: "Other STOP Org" });
    const c = await contact({});
    await testDb.insert(optOutsTable).values({ id: randomUUID(), orgId: other.id, phone: c.phone, channel: "sms" });
    await appt(c.id, new Date(NOON_NY.getTime() + 4 * 3600_000));
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(0);
    expect(jobsTo(c.email!)).toHaveLength(1);
  });

  it("only suppresses the channel the opt-out was recorded for, and email only in its own org", async () => {
    const other = await seedOrg(testDb, { name: "Other Email Org" });
    const c = await contact({});
    // An email-channel row carrying the phone must not silence SMS…
    await testDb.insert(optOutsTable).values({ id: randomUUID(), orgId: org.id, phone: c.phone, email: null, channel: "email" });
    // …and another org's email suppression must not silence this org's email.
    await testDb.insert(optOutsTable).values({ id: randomUUID(), orgId: other.id, email: c.email, channel: "email" });
    await appt(c.id, new Date(NOON_NY.getTime() + 4 * 3600_000));
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(1);
    expect(jobsTo(c.email!)).toHaveLength(1);
  });

  it("honours the org's email suppression list case-insensitively", async () => {
    const c = await contact({});
    await testDb.insert(optOutsTable).values({ id: randomUUID(), orgId: org.id, email: c.email!.toUpperCase(), channel: "email" });
    await appt(c.id, new Date(NOON_NY.getTime() + 4 * 3600_000));
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(1);
    expect(jobsTo(c.email!)).toHaveLength(0);
  });

  it("releases the claim when enqueue fails so the next sweep retries", async () => {
    const c = await contact({});
    const id = await appt(c.id, new Date(NOON_NY.getTime() + 5 * 3600_000));
    (globalThis as { __FAIL_ENQUEUE__?: boolean }).__FAIL_ENQUEUE__ = true;
    try {
      await worker(NOON_NY);
    } finally {
      (globalThis as { __FAIL_ENQUEUE__?: boolean }).__FAIL_ENQUEUE__ = false;
    }
    const [row] = await testDb.select().from(appointmentsTable).where(eq(appointmentsTable.id, id));
    expect(row.reminderSentAt).toBeNull();

    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(1);
    expect(jobsTo(c.email!)).toHaveLength(1);
    const [after] = await testDb.select().from(appointmentsTable).where(eq(appointmentsTable.id, id));
    expect(after.reminderSentAt).not.toBeNull();
  });

  it("defers outside calling hours instead of texting at night", async () => {
    const c = await contact({});
    const id = await appt(c.id, new Date(NIGHT_NY.getTime() + 10 * 3600_000));
    await worker(NIGHT_NY);
    expect(jobsTo(c.phone!)).toHaveLength(0);
    expect(jobsTo(c.email!)).toHaveLength(0);
    const [row] = await testDb.select().from(appointmentsTable).where(eq(appointmentsTable.id, id));
    expect(row.reminderSentAt).toBeNull();
  });

  it("sends email only when the appointment is too close to wait for the window", async () => {
    const c = await contact({});
    await appt(c.id, new Date(NIGHT_NY.getTime() + 60 * 60_000));
    await worker(NIGHT_NY);
    expect(jobsTo(c.phone!)).toHaveLength(0);
    expect(jobsTo(c.email!)).toHaveLength(1);
  });

  it("holds a contact with no state to the texting window in every continental zone", async () => {
    // 09:00 in New York is 06:00 in California: not yet texting hours everywhere.
    const nineNy = new Date("2026-10-12T13:00:00.000Z");
    const early = await contact({ stateCode: null });
    await appt(early.id, new Date(nineNy.getTime() + 5 * 3600_000));
    const summary = await worker(nineNy);
    expect(summary.deferred).toBeGreaterThanOrEqual(1);
    expect(jobsTo(early.phone!)).toHaveLength(0);

    // Noon in New York is 09:00 in California: inside the window everywhere.
    const c = await contact({ stateCode: null });
    await appt(c.id, new Date(NOON_NY.getTime() + 5 * 3600_000));
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(1);
    expect(jobsTo(c.email!)).toHaveLength(1);
  });

  it("does not text a contact without documented TCPA consent (email still goes)", async () => {
    const c = await contact({ consent: false });
    await appt(c.id, new Date(NOON_NY.getTime() + 3 * 3600_000));
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(0);
    const email = jobsTo(c.email!);
    expect(email).toHaveLength(1);
    // Re-checked at send time by the shared gate.
    expect((email[0].data as { consumer?: { contactId: string; automated: boolean } }).consumer).toEqual({
      orgId: org.id,
      contactId: c.id,
      automated: true,
    });
  });

  it("skips cancelled and far-future appointments", async () => {
    const c = await contact({});
    await appt(c.id, new Date(NOON_NY.getTime() + 3 * 3600_000), "cancelled");
    await appt(c.id, new Date(NOON_NY.getTime() + 3 * 86_400_000));
    await worker(NOON_NY);
    expect(jobsTo(c.phone!)).toHaveLength(0);
    expect(jobsTo(c.email!)).toHaveLength(0);
  });
});

describe("automation action: create_appointment", () => {
  it("books an appointment for the trigger's contact and agent at the contact's local time", async () => {
    const c = await contact({ stateCode: "CA" });
    await testDb.update(contactsTable).set({ assignedAgentId: agent.id }).where(eq(contactsTable.id, c.id));
    await seedAutomationRule(testDb, {
      orgId: org.id,
      triggerType: "lead_created",
      actions: [
        {
          type: "create_appointment",
          config: {
            title: "Intro call",
            type: "consultation",
            startOffsetDays: 2,
            startTime: "09:30",
            durationMinutes: 45,
            notes: "Asked about dental",
          },
        },
      ],
    });

    await runRules({
      orgId: org.id,
      trigger: "lead_created",
      resourceType: "lead",
      resourceId: "lead-x",
      context: { contactId: c.id, agentId: agent.id },
    });

    const rows = await testDb.select().from(appointmentsTable).where(eq(appointmentsTable.contactId, c.id));
    expect(rows).toHaveLength(1);
    const a = rows[0];
    expect(a.title).toBe("Intro call");
    expect(a.agentId).toBe(agent.id);
    expect(a.status).toBe("pending");
    expect(a.endsAt.getTime() - a.startsAt.getTime()).toBe(45 * 60_000);
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(a.startsAt);
    expect(local).toBe("09:30");
    expect(a.notesEncrypted).toBeTruthy();

    // A re-delivered trigger does not double-book.
    await runRules({
      orgId: org.id,
      trigger: "lead_created",
      resourceType: "lead",
      resourceId: "lead-x",
      context: { contactId: c.id, agentId: agent.id },
    });
    const again = await testDb.select().from(appointmentsTable).where(eq(appointmentsTable.contactId, c.id));
    expect(again).toHaveLength(1);
  });

  it("fails the action (not the org) when the contact belongs to another org", async () => {
    const other = await seedOrg(testDb, { name: "Elsewhere" });
    const foreign = await seedContact(testDb, { orgId: other.id });
    const rule = await seedAutomationRule(testDb, {
      orgId: org.id,
      triggerType: "contact_created",
      actions: [{ type: "create_appointment", config: { contactId: foreign.id, startsAt: "2026-11-01T15:00:00Z" } }],
    });
    await runRules({ orgId: org.id, trigger: "contact_created", resourceType: "contact", resourceId: "nope" });
    const rows = await testDb.select().from(appointmentsTable).where(eq(appointmentsTable.contactId, foreign.id));
    expect(rows).toHaveLength(0);
    expect(rule.id).toBeTruthy();
  });
});
