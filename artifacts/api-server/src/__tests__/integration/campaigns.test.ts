/**
 * Omnichannel campaigns — routes/campaigns.ts, routes/campaignsPublic.ts,
 * workers/campaignSend.ts.
 *
 * Covers: audience exclusion of opt-outs + STOP list, org scoping,
 * permissions (sends are admin-only), idempotent fan-out (claim-before-send,
 * concurrent workers), unsubscribe token validation, webhook signature
 * rejection, and the email-only confirmed re-opt-in.
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
    const base = jobsMockFactory();
    return {
      ...base,
      JOB_NAMES: { ...(base.JOB_NAMES as Record<string, string>), CAMPAIGN_SEND: "campaign-send" },
    };
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);

import crypto, { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  auditLogTable,
  campaignRecipientsTable,
  campaignsTable,
  campaignSettingsTable,
  contactsTable,
  messagesTable,
  messageThreadsTable,
  optOutsTable,
} from "@workspace/db/schema";
import {
  bootTestDb,
  shutdownTestDb,
  withAuth,
  getEnqueuedJobs,
  clearEnqueuedJobs,
} from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { Express } from "express";

const SECRET = "test-unsubscribe-secret-0123456789abcdef";
const WHSEC = `whsec_${Buffer.from("resend-webhook-signing-key").toString("base64")}`;
const TWILIO_TOKEN = "twilio-test-auth-token";
const PUBLIC_HOST = "https://app.test.example";

let app: Express;
let request: typeof import("supertest");
let testDb: TestDb;
let worker: typeof import("../../workers/campaignSend").campaignSendWorker;
let tokens: typeof import("../../lib/campaigns/unsubscribeToken");
let svix: typeof import("../../lib/campaigns/svix");

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let support: { id: string };
let viewer: { id: string };
let otherAdmin: { id: string };

const realFetch = globalThis.fetch;
type SentMail = { to: string[]; subject: string; html: string; headers?: Record<string, string> };
let sentEmails: SentMail[] = [];
let sentSms: Array<Record<string, string>> = [];

function installProviderFetch(): void {
  let n = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://api.resend.com")) {
      sentEmails.push(JSON.parse(String(init?.body)) as SentMail);
      n++;
      return new Response(JSON.stringify({ id: `re_${n}_${randomUUID()}` }), { status: 200 });
    }
    if (u.startsWith("https://api.twilio.com")) {
      sentSms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      n++;
      return new Response(JSON.stringify({ sid: `SM${n}${randomUUID().replace(/-/g, "")}`, status: "queued" }), { status: 201 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
}

async function contact(
  orgId: string,
  over: Partial<typeof contactsTable.$inferInsert> = {},
): Promise<string> {
  const id = `c-${randomUUID()}`;
  await testDb.insert(contactsTable).values({
    id,
    orgId,
    firstName: over.firstName ?? "Pat",
    lastName: "Lee",
    email: `${id}@example.com`,
    phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
    status: "enrolled",
    stateCode: "TX",
    ...over,
  });
  return id;
}

beforeAll(async () => {
  const handle = await bootTestDb();
  testDb = handle.db;
  process.env.CAMPAIGN_UNSUBSCRIBE_SECRET = SECRET;
  process.env.APP_BASE_URL = PUBLIC_HOST;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
  process.env.TWILIO_FROM_NUMBER = "+15550000000";
  process.env.TWILIO_WEBHOOK_PUBLIC_HOST = PUBLIC_HOST;
  process.env.CAMPAIGN_SEND_RATE_PER_SECOND = "100000";

  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  worker = (await import("../../workers/campaignSend")).campaignSendWorker;
  tokens = await import("../../lib/campaigns/unsubscribeToken");
  svix = await import("../../lib/campaigns/svix");

  org = await seedOrg(testDb, { id: "camp-org", name: "Sunrise Medicare Agency" });
  otherOrg = await seedOrg(testDb, { id: "camp-org-2" });
  admin = await seedUser(testDb, { orgId: org.id, role: "agency_admin" });
  support = await seedUser(testDb, { orgId: org.id, role: "agent_support" });
  viewer = await seedUser(testDb, { orgId: org.id, role: "viewer" });
  otherAdmin = await seedUser(testDb, { orgId: otherOrg.id, role: "agency_admin" });

  await testDb.insert(campaignSettingsTable).values({
    orgId: org.id,
    senderName: "Sunrise Medicare Agency",
    physicalAddress: "100 Main St, Austin, TX 78701",
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await shutdownTestDb();
});

beforeEach(() => {
  clearEnqueuedJobs();
  sentEmails = [];
  sentSms = [];
  installProviderFetch();
});

// ---------------------------------------------------------------------------

describe("audience preview", () => {
  it("excludes opted-out contacts, the email suppression list and the STOP list", async () => {
    const tag = `aud-${randomUUID().slice(0, 6)}`;
    await contact(org.id, { tags: [tag] });
    await contact(org.id, { tags: [tag], optOutEmail: true, optOutSms: true });
    const suppressed = await contact(org.id, { tags: [tag] });
    const [s] = await testDb.select().from(contactsTable).where(eq(contactsTable.id, suppressed));
    await testDb.insert(optOutsTable).values({ id: randomUUID(), orgId: org.id, email: s!.email!.toUpperCase(), channel: "email" });
    const stopped = await contact(org.id, { tags: [tag] });
    const [st] = await testDb.select().from(contactsTable).where(eq(contactsTable.id, stopped));
    // STOP list rows may come from any org — the Twilio number is shared.
    await testDb.insert(optOutsTable).values({ id: randomUUID(), orgId: otherOrg.id, phone: st!.phone!, channel: "sms" });
    await contact(org.id, { tags: [tag], email: null, phone: null });
    await contact(org.id, { tags: [tag], status: "do_not_contact" });
    await contact(otherOrg.id, { tags: [tag] });

    const email = await request(app)
      .post("/api/campaigns/audience/preview")
      .set(withAuth(admin.id))
      .send({ channel: "email", audience: { tags: [tag] } });
    expect(email.status).toBe(200);
    expect(email.body).toEqual({ matched: 5, eligible: 2, optedOut: 2, missingAddress: 1 });

    const sms = await request(app)
      .post("/api/campaigns/audience/preview")
      .set(withAuth(admin.id))
      .send({ channel: "sms", audience: { tags: [tag] } });
    expect(sms.body).toEqual({ matched: 5, eligible: 2, optedOut: 2, missingAddress: 1 });
  });

  it("filters by birthday month and state and rejects unknown filter keys", async () => {
    const tag = `bday-${randomUUID().slice(0, 6)}`;
    await contact(org.id, { tags: [tag], dob: new Date("1955-03-10T12:00:00Z"), stateCode: "FL" });
    await contact(org.id, { tags: [tag], dob: new Date("1955-07-10T12:00:00Z"), stateCode: "FL" });
    const res = await request(app)
      .post("/api/campaigns/audience/preview")
      .set(withAuth(admin.id))
      .send({ channel: "email", audience: { tags: [tag], birthdayMonth: 3, states: ["fl"] } });
    expect(res.body.eligible).toBe(1);

    const bad = await request(app)
      .post("/api/campaigns/audience/preview")
      .set(withAuth(admin.id))
      .send({ channel: "email", audience: { healthConditions: ["diabetes"] } });
    expect(bad.status).toBe(400);
  });
});

describe("permissions and org scoping", () => {
  it("viewer cannot read; agent_support can draft but not send", async () => {
    expect((await request(app).get("/api/campaigns").set(withAuth(viewer.id))).status).toBe(403);

    const draft = await request(app)
      .post("/api/campaigns")
      .set(withAuth(support.id))
      .send({ channel: "email", name: "Support draft", subject: "Hi", body: "<p>Hi</p>" });
    expect(draft.status).toBe(201);

    const send = await request(app).post(`/api/campaigns/${draft.body.id}/send`).set(withAuth(support.id)).send({});
    expect(send.status).toBe(403);
    expect((await request(app).put("/api/campaigns/settings").set(withAuth(support.id)).send({ senderName: "x" })).status).toBe(403);
  });

  it("another org cannot see, edit or send this org's campaign", async () => {
    const c = await request(app)
      .post("/api/campaigns")
      .set(withAuth(admin.id))
      .send({ channel: "email", name: "Scoped", subject: "Hi", body: "<p>Hi</p>" });
    expect(c.status).toBe(201);

    expect((await request(app).get(`/api/campaigns/${c.body.id}`).set(withAuth(otherAdmin.id))).status).toBe(404);
    expect((await request(app).patch(`/api/campaigns/${c.body.id}`).set(withAuth(otherAdmin.id)).send({ name: "x" })).status).toBe(404);
    expect((await request(app).post(`/api/campaigns/${c.body.id}/send`).set(withAuth(otherAdmin.id)).send({})).status).toBe(404);
    const list = await request(app).get("/api/campaigns").set(withAuth(otherAdmin.id));
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(c.body.id);
  });

  it("refuses to send email without a mailing address on file (CAN-SPAM)", async () => {
    await contact(otherOrg.id);
    const c = await request(app)
      .post("/api/campaigns")
      .set(withAuth(otherAdmin.id))
      .send({ channel: "email", name: "No address", subject: "Hi", body: "<p>Hi</p>" });
    const send = await request(app).post(`/api/campaigns/${c.body.id}/send`).set(withAuth(otherAdmin.id)).send({});
    expect(send.status).toBe(409);
    expect(send.body.code).toBe("sender_address_missing");
  });
});

describe("send fan-out", () => {
  async function createAndSend(channel: "email" | "sms", tag: string) {
    const c = await request(app)
      .post("/api/campaigns")
      .set(withAuth(admin.id))
      .send({
        channel,
        name: `Fan-out ${tag}`,
        subject: channel === "email" ? "Hello {{first_name}}" : undefined,
        body: channel === "email" ? "<p>Hi {{first_name}}, from {{agency_name}}</p>" : "Hi {{first_name}}, AEP starts Oct 15.",
        audience: { tags: [tag] },
      });
    expect(c.status).toBe(201);
    const s = await request(app).post(`/api/campaigns/${c.body.id}/send`).set(withAuth(admin.id)).send({});
    expect(s.status).toBe(200);
    expect(s.body.status).toBe("scheduled");
    return c.body.id as string;
  }

  it("sends each eligible recipient exactly once, even with concurrent/retried jobs", async () => {
    const tag = `fan-${randomUUID().slice(0, 6)}`;
    const ok1 = await contact(org.id, { tags: [tag], firstName: "Ana" });
    const ok2 = await contact(org.id, { tags: [tag], firstName: "Ben" });
    const opted = await contact(org.id, { tags: [tag], optOutEmail: true });
    const id = await createAndSend("email", tag);
    expect(getEnqueuedJobs().some((j) => j.name === "campaign-send")).toBe(true);

    const payload = { campaignId: id, orgId: org.id };
    const noSleep = { sleep: async () => undefined };
    await Promise.all([worker(payload, noSleep), worker(payload, noSleep)]);
    await worker(payload, noSleep); // a pg-boss retry

    expect(sentEmails).toHaveLength(2);
    const recips = await testDb.select().from(campaignRecipientsTable).where(eq(campaignRecipientsTable.campaignId, id));
    expect(recips).toHaveLength(3);
    const byContact = Object.fromEntries(recips.map((r) => [r.contactId, r]));
    expect(byContact[ok1]!.status).toBe("sent");
    expect(byContact[ok2]!.status).toBe("sent");
    expect(byContact[opted]!.status).toBe("skipped_opt_out");

    // CAN-SPAM: headers, footer with address, signed link.
    const mail = sentEmails[0]!;
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.test\.example\/api\/campaigns\/v1\/unsubscribe\/.+>$/);
    expect(mail.html).toContain("100 Main St, Austin, TX 78701");
    expect(mail.subject).toMatch(/^Hello (Ana|Ben)$/);

    // Timeline: outbound messages written to the contact's email thread.
    const msgs = await testDb
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .innerJoin(messageThreadsTable, eq(messageThreadsTable.id, messagesTable.threadId))
      .where(and(eq(messageThreadsTable.contactId, ok1), eq(messageThreadsTable.channel, "email")));
    expect(msgs).toHaveLength(1);

    const [camp] = await testDb.select().from(campaignsTable).where(eq(campaignsTable.id, id));
    expect(camp!.status).toBe("sent");
    expect(camp!.sentCount).toBe(2);
    expect(camp!.skippedCount).toBe(1);
  });

  it("SMS: adds the STOP line to the first message only and honours quiet hours", async () => {
    const tag = `sms-${randomUUID().slice(0, 6)}`;
    await contact(org.id, { tags: [tag], stateCode: "CA" });
    const id1 = await createAndSend("sms", tag);
    // 18:00 UTC = 11:00 in California — inside the window.
    const noon = { sleep: async () => undefined, now: () => new Date("2027-03-10T18:00:00Z") };
    await worker({ campaignId: id1, orgId: org.id }, noon);
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0]!.Body).toMatch(/Reply STOP to opt out\.$/);
    expect(sentSms[0]!.StatusCallback).toBe(`${PUBLIC_HOST}/api/campaigns/v1/webhooks/twilio-status`);

    const id2 = await createAndSend("sms", tag);
    // 06:00 UTC = 22:00 the previous evening in California — quiet hours.
    const night = { sleep: async () => undefined, now: () => new Date("2027-03-11T06:00:00Z") };
    clearEnqueuedJobs();
    await worker({ campaignId: id2, orgId: org.id }, night);
    expect(sentSms).toHaveLength(1);
    const again = getEnqueuedJobs().find((j) => j.name === "campaign-send");
    expect(again).toBeTruthy();

    await worker({ campaignId: id2, orgId: org.id }, noon);
    expect(sentSms).toHaveLength(2);
    expect(sentSms[1]!.Body).not.toMatch(/Reply STOP/);
  });
});

describe("unsubscribe endpoint", () => {
  it("rejects forged, tampered and malformed tokens with one generic response", async () => {
    const forged = tokens.signUnsubscribeToken({ kind: "c", id: "anything" }, "some-other-secret-that-is-long-enough-000");
    for (const t of [forged!, "not-a-token", `${forged!.split(".")[0]}.AAAA`]) {
      const res = await request(app).post(`/api/campaigns/v1/unsubscribe/${t}`).send({});
      expect(res.status).toBe(400);
      expect(res.text).toContain("This link isn");
    }
    // Valid signature for an id that doesn't exist: same page (no enumeration).
    const unknown = tokens.signUnsubscribeToken({ kind: "r", id: randomUUID() });
    const res = await request(app).get(`/api/campaigns/v1/unsubscribe/${unknown}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("This link isn");
  });

  it("one-click POST opts the contact out, suppresses the address and audits it", async () => {
    const cid = await contact(org.id);
    const t = tokens.signUnsubscribeToken({ kind: "c", id: cid })!;
    const page = await request(app).get(`/api/campaigns/v1/unsubscribe/${t}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Sunrise Medicare Agency");

    const res = await request(app)
      .post(`/api/campaigns/v1/unsubscribe/${t}`)
      .type("form")
      .send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    const [c] = await testDb.select().from(contactsTable).where(eq(contactsTable.id, cid));
    expect(c!.optOutEmail).toBe(true);
    const sup = await testDb
      .select()
      .from(optOutsTable)
      .where(and(eq(optOutsTable.orgId, org.id), eq(optOutsTable.email, c!.email!.toLowerCase())));
    expect(sup).toHaveLength(1);
    const audit = await testDb
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.resourceId, cid), eq(auditLogTable.action, "email_unsubscribe")));
    expect(audit).toHaveLength(1);

    // Idempotent.
    await request(app).post(`/api/campaigns/v1/unsubscribe/${t}`).type("form").send("List-Unsubscribe=One-Click");
    expect(
      await testDb.select().from(optOutsTable).where(and(eq(optOutsTable.orgId, org.id), eq(optOutsTable.email, c!.email!.toLowerCase()))),
    ).toHaveLength(1);
  });
});

describe("tracking webhooks", () => {
  it("Resend: 503 without a secret, 401 on a bad signature, applies a signed event once", async () => {
    const body = JSON.stringify({ type: "email.opened", data: { email_id: "re_missing" } });
    delete process.env.RESEND_WEBHOOK_SECRET;
    const none = await request(app).post("/api/campaigns/v1/webhooks/resend").set("content-type", "application/json").send(body);
    expect(none.status).toBe(503);

    process.env.RESEND_WEBHOOK_SECRET = WHSEC;
    const ts = String(Math.floor(Date.now() / 1000));
    const bad = await request(app)
      .post("/api/campaigns/v1/webhooks/resend")
      .set({ "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": "v1,AAAA" })
      .send(body);
    expect(bad.status).toBe(401);

    // A real recipient to update.
    const tag = `wh-${randomUUID().slice(0, 6)}`;
    await contact(org.id, { tags: [tag] });
    const c = await request(app)
      .post("/api/campaigns")
      .set(withAuth(admin.id))
      .send({ channel: "email", name: "Webhook", subject: "Hi", body: "<p>Hi</p>", audience: { tags: [tag] } });
    await request(app).post(`/api/campaigns/${c.body.id}/send`).set(withAuth(admin.id)).send({});
    await worker({ campaignId: c.body.id, orgId: org.id }, { sleep: async () => undefined });
    const [rec] = await testDb.select().from(campaignRecipientsTable).where(eq(campaignRecipientsTable.campaignId, c.body.id));
    expect(rec!.providerMessageId).toBeTruthy();

    const send = async (svixId: string, type: string) => {
      const payload = JSON.stringify({ type, data: { email_id: rec!.providerMessageId } });
      const sig = svix.signSvixPayload(WHSEC, svixId, ts, payload);
      return request(app)
        .post("/api/campaigns/v1/webhooks/resend")
        .set({ "content-type": "application/json", "svix-id": svixId, "svix-timestamp": ts, "svix-signature": sig })
        .send(payload);
    };
    expect((await send("msg_d", "email.delivered")).status).toBe(200);
    expect((await send("msg_o", "email.opened")).status).toBe(200);
    const dup = await send("msg_o", "email.opened");
    expect(dup.body.duplicate).toBe(true);

    const [after] = await testDb.select().from(campaignRecipientsTable).where(eq(campaignRecipientsTable.id, rec!.id));
    expect(after!.status).toBe("delivered");
    expect(after!.openedAt).toBeTruthy();
    const [camp] = await testDb.select().from(campaignsTable).where(eq(campaignsTable.id, c.body.id));
    expect(camp!.openedCount).toBe(1);
    expect(camp!.deliveredCount).toBe(1);
  });

  it("Twilio status callback rejects a bad signature and accepts a valid one", async () => {
    const path = "/api/campaigns/v1/webhooks/twilio-status";
    const params = { MessageSid: "SMdoesnotexist", MessageStatus: "delivered" };
    const bad = await request(app).post(path).type("form").set("X-Twilio-Signature", "nope").send(params);
    expect(bad.status).toBe(403);

    const str = `${PUBLIC_HOST}${path}` + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join("");
    const sig = crypto.createHmac("sha1", TWILIO_TOKEN).update(str, "utf8").digest("base64");
    const good = await request(app).post(path).type("form").set("X-Twilio-Signature", sig).send(params);
    expect(good.status).toBe(204);
  });
});

describe("opt-out management", () => {
  it("never re-opts-in SMS from the UI; email needs confirmation and is audited", async () => {
    const cid = await contact(org.id, { optOutEmail: true, optOutSms: true });

    const sms = await request(app)
      .post("/api/campaigns/opt-outs/sms/resubscribe")
      .set(withAuth(admin.id))
      .send({ contactId: cid, confirm: true, reason: "Client asked" });
    expect(sms.status).toBe(403);

    const noConfirm = await request(app)
      .post("/api/campaigns/opt-outs/email/resubscribe")
      .set(withAuth(admin.id))
      .send({ contactId: cid, reason: "Client asked" });
    expect(noConfirm.status).toBe(400);

    const cross = await request(app)
      .post("/api/campaigns/opt-outs/email/resubscribe")
      .set(withAuth(otherAdmin.id))
      .send({ contactId: cid, confirm: true, reason: "Client asked in writing" });
    expect(cross.status).toBe(404);

    const ok = await request(app)
      .post("/api/campaigns/opt-outs/email/resubscribe")
      .set(withAuth(admin.id))
      .send({ contactId: cid, confirm: true, reason: "Client asked in writing on 3/1" });
    expect(ok.status).toBe(200);
    const [c] = await testDb.select().from(contactsTable).where(eq(contactsTable.id, cid));
    expect(c!.optOutEmail).toBe(false);
    expect(c!.optOutSms).toBe(true);
    const audit = await testDb
      .select()
      .from(auditLogTable)
      .where(and(eq(auditLogTable.resourceId, cid), eq(auditLogTable.action, "email_resubscribe")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(admin.id);
  });

  it("lists opt-outs for the caller's org only", async () => {
    await contact(otherOrg.id, { optOutEmail: true, firstName: "Elsewhere" });
    const res = await request(app).get("/api/campaigns/opt-outs?channel=email").set(withAuth(admin.id));
    expect(res.status).toBe(200);
    expect(res.body.items.some((i: { name: string | null }) => i.name?.startsWith("Elsewhere"))).toBe(false);
  });
});

describe("overview", () => {
  it("returns rates only when tracking is connected", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const off = await request(app).get("/api/campaigns/overview?channel=email").set(withAuth(admin.id));
    expect(off.status).toBe(200);
    expect(off.body.trackingConnected).toBe(false);
    expect(off.body.openRate).toBeNull();
    expect(off.body.sent).toBeGreaterThan(0);

    process.env.RESEND_WEBHOOK_SECRET = WHSEC;
    const on = await request(app).get("/api/campaigns/overview?channel=email").set(withAuth(admin.id));
    expect(on.body.trackingConnected).toBe(true);
    expect(typeof on.body.openRate).toBe("number");
  });
});
