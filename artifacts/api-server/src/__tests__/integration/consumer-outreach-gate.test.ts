/**
 * Integration test: the consumer outreach compliance gate.
 *
 * Every SMS / email job that targets a contact is re-checked at send time
 * (lib/compliance/consumerOutreach.ts + consumerDelivery.ts). Covers:
 *   - an opt-out recorded in E.164 blocks a contact stored as "(512) 555-0100"
 *   - do_not_contact status and per-contact opt-out flags block both channels
 *   - automated SMS needs TCPA consent unless the org turned the rule off
 *   - automated SMS outside the recipient's texting hours is deferred, not sent
 *   - manual agent SMS skips consent/hours but not opt-outs
 *   - automated email gets the unsubscribe footer + List-Unsubscribe headers
 *   - automated sends are written to the contact's message history
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const { dbF, sendSMSMock, sendEmailMock } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
  sendSMSMock: vi.fn(async () => ({ success: true as const, sid: "SM-test", status: "queued" })),
  sendEmailMock: vi.fn(async () => ({ success: true as const, id: "em-test" })),
}));

vi.mock("@workspace/db", dbF);
vi.mock("../../lib/sms", () => ({ sendSMS: sendSMSMock }));
vi.mock("../../lib/email", () => ({ sendEmail: sendEmailMock }));

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedContact, type TestDb } from "../helpers/testDb";
import {
  contactsTable,
  optOutsTable,
  orgSettingsTable,
  messagesTable,
  messageThreadsTable,
} from "@workspace/db/schema";

let db: TestDb;
let gate: typeof import("../../lib/compliance/consumerOutreach");
let delivery: typeof import("../../lib/compliance/consumerDelivery");

// Monday 2026-09-28 16:00Z = noon EDT / 9am PDT — inside every window.
const MIDDAY = new Date("2026-09-28T16:00:00Z");
// Monday 2026-09-28 02:30Z = Sunday 10:30pm EDT — outside the window.
const LATE_NIGHT = new Date("2026-09-28T02:30:00Z");

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  gate = await import("../../lib/compliance/consumerOutreach");
  delivery = await import("../../lib/compliance/consumerDelivery");
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  sendSMSMock.mockClear();
  sendEmailMock.mockClear();
});

async function newOrg(): Promise<string> {
  const org = await seedOrg(db, { id: `org-gate-${randomUUID().slice(0, 8)}` });
  return org.id;
}

async function newContact(
  orgId: string,
  fields: Partial<typeof contactsTable.$inferInsert> = {},
): Promise<string> {
  const c = await seedContact(db, { orgId, email: `c-${randomUUID().slice(0, 6)}@example.com` });
  await db
    .update(contactsTable)
    .set({
      phone: `(512) 555-${String(Math.floor(Math.random() * 9000) + 1000)}`,
      stateCode: "GA",
      tcpaConsentAt: new Date("2026-01-15T00:00:00Z"),
      tcpaConsentSource: "web_form:https://example.com/quote",
      ...fields,
    })
    .where(eq(contactsTable.id, c.id));
  return c.id;
}

const auto = (orgId: string, contactId: string) => ({ orgId, contactId, automated: true });

describe("SMS gate", () => {
  it("sends to a consented contact inside texting hours", async () => {
    const orgId = await newOrg();
    const contactId = await newContact(orgId);
    const d = await gate.evaluateConsumerSms(auto(orgId, contactId), MIDDAY);
    expect(d.action).toBe("send");
  });

  it("blocks when the number is on the opt-out log in a different format", async () => {
    const orgId = await newOrg();
    const contactId = await newContact(orgId, { phone: "(512) 555-0142" });
    await db.insert(optOutsTable).values({ id: randomUUID(), orgId, phone: "+15125550142", channel: "sms" });
    const d = await gate.evaluateConsumerSms(auto(orgId, contactId), MIDDAY);
    expect(d).toEqual({ action: "block", reason: "opted_out" });
    // Manual sends are blocked by opt-outs too.
    const manual = await gate.evaluateConsumerSms({ orgId, contactId, automated: false }, MIDDAY);
    expect(manual).toEqual({ action: "block", reason: "opted_out" });
  });

  it("blocks do_not_contact and flagged contacts", async () => {
    const orgId = await newOrg();
    const dnc = await newContact(orgId, { status: "do_not_contact" });
    const flagged = await newContact(orgId, { optOutSms: true });
    expect(await gate.evaluateConsumerSms(auto(orgId, dnc), MIDDAY)).toEqual({ action: "block", reason: "opted_out" });
    expect(await gate.evaluateConsumerSms(auto(orgId, flagged), MIDDAY)).toEqual({ action: "block", reason: "opted_out" });
  });

  it("requires TCPA consent for automated SMS unless the org turns it off", async () => {
    const orgId = await newOrg();
    const contactId = await newContact(orgId, { tcpaConsentAt: null, tcpaConsentSource: null });
    expect(await gate.evaluateConsumerSms(auto(orgId, contactId), MIDDAY)).toEqual({
      action: "block",
      reason: "no_tcpa_consent",
    });
    // Manual one-to-one texting is not gated on consent.
    const manual = await gate.evaluateConsumerSms({ orgId, contactId, automated: false }, MIDDAY);
    expect(manual.action).toBe("send");

    await db.insert(orgSettingsTable).values({ id: randomUUID(), orgId, requireSmsConsent: false });
    expect((await gate.evaluateConsumerSms(auto(orgId, contactId), MIDDAY)).action).toBe("send");
  });

  it("defers automated SMS outside texting hours to the next window", async () => {
    const orgId = await newOrg();
    const contactId = await newContact(orgId);
    const d = await gate.evaluateConsumerSms(auto(orgId, contactId), LATE_NIGHT);
    expect(d.action).toBe("defer");
    if (d.action === "defer") expect(d.until.toISOString()).toBe("2026-09-28T12:00:00.000Z");
  });

  it("does not text a contact from another org", async () => {
    const orgA = await newOrg();
    const orgB = await newOrg();
    const contactId = await newContact(orgA);
    expect(await gate.evaluateConsumerSms(auto(orgB, contactId), MIDDAY)).toEqual({
      action: "block",
      reason: "contact_not_found",
    });
  });
});

describe("deliverScheduledSms", () => {
  it("re-enqueues instead of sending when outside texting hours", async () => {
    const orgId = await newOrg();
    const contactId = await newContact(orgId);
    const defer = vi.fn(async () => undefined);
    const outcome = await delivery.deliverScheduledSms(
      { to: "", body: "Your plan review is due", consumer: auto(orgId, contactId) },
      defer,
      LATE_NIGHT,
    );
    expect(outcome).toBe("deferred");
    expect(defer).toHaveBeenCalledTimes(1);
    expect(sendSMSMock).not.toHaveBeenCalled();
  });

  it("sends to the contact's current number and records it in message history", async () => {
    const orgId = await newOrg();
    const contactId = await newContact(orgId, { phone: "(512) 555-0199" });
    const outcome = await delivery.deliverScheduledSms(
      { to: "+19999999999", body: "Reminder: AEP starts Oct 15", consumer: auto(orgId, contactId) },
      async () => undefined,
      MIDDAY,
    );
    expect(outcome).toBe("sent");
    expect(sendSMSMock).toHaveBeenCalledWith("(512) 555-0199", "Reminder: AEP starts Oct 15", "system");

    const rows = await db
      .select({ status: messagesTable.status, body: messagesTable.body })
      .from(messagesTable)
      .innerJoin(messageThreadsTable, eq(messagesTable.threadId, messageThreadsTable.id))
      .where(and(eq(messageThreadsTable.contactId, contactId), eq(messageThreadsTable.channel, "sms")));
    expect(rows).toEqual([{ status: "sent", body: "Reminder: AEP starts Oct 15" }]);
  });

  it("never sends a blocked message", async () => {
    const orgId = await newOrg();
    const contactId = await newContact(orgId, { optOutSms: true });
    const outcome = await delivery.deliverScheduledSms(
      { to: "", body: "x", consumer: auto(orgId, contactId) },
      async () => undefined,
      MIDDAY,
    );
    expect(outcome).toBe("blocked");
    expect(sendSMSMock).not.toHaveBeenCalled();
  });
});

describe("email gate + delivery", () => {
  it("blocks opted-out contacts, including via the opt-out log", async () => {
    const orgId = await newOrg();
    const flagged = await newContact(orgId, { optOutEmail: true });
    expect(await gate.evaluateConsumerEmail(auto(orgId, flagged))).toEqual({ action: "block", reason: "opted_out" });

    const logged = await newContact(orgId, { email: "Logged.Out@Example.com" });
    await db.insert(optOutsTable).values({ id: randomUUID(), orgId, email: "logged.out@example.com", channel: "email" });
    expect(await gate.evaluateConsumerEmail(auto(orgId, logged))).toEqual({ action: "block", reason: "opted_out" });
  });

  it("adds the unsubscribe footer and one-click headers to automated email", async () => {
    const orgId = await newOrg();
    const contactId = await newContact(orgId);
    const outcome = await delivery.deliverScheduledEmail({
      to: "",
      subject: "Your 2027 plan options",
      html: "<p>Hello</p>",
      consumer: auto(orgId, contactId),
    });
    expect(outcome).toBe("sent");
    const call = sendEmailMock.mock.calls[0] as unknown as [
      { html: string; headers?: Record<string, string> },
    ];
    const sent = call[0];
    expect(sent.html).toContain("<p>Hello</p>");
    expect(sent.html).toMatch(/\/api\/public\/unsubscribe\?t=/);
    expect(sent.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("sends internal (non-consumer) mail unchanged", async () => {
    const outcome = await delivery.deliverScheduledEmail({
      to: "compliance@agency.example",
      subject: "License expiring",
      html: "<p>x</p>",
    });
    expect(outcome).toBe("sent");
    const call = sendEmailMock.mock.calls[0] as unknown as [{ html: string; headers?: unknown }];
    expect(call[0].html).toBe("<p>x</p>");
    expect(call[0].headers).toBeUndefined();
  });
});
