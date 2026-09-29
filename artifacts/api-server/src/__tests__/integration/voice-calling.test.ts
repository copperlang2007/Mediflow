/**
 * Native browser calling (Twilio Voice): call sessions, preclearance backstops,
 * access token, the signed TwiML webhook, status callbacks and dispositions.
 *
 * Twilio itself is never contacted — the API only MINTS a token and RECEIVES
 * webhooks — so "mocking Twilio" here means signing webhook requests with the
 * test auth token exactly as Twilio would.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

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
import { seedOrg, seedUser, seedAgent, seedContact, type TestDb } from "../helpers/testDb";
import * as schema from "@workspace/db/schema";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Express } from "express";

const AUTH_TOKEN = "test-twilio-auth-token";
const PUBLIC_HOST = "https://mediflow.test";
const API_KEY_SECRET = "test-api-key-secret-value";
const VOICE_ENV = {
  TWILIO_ACCOUNT_SID: "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  TWILIO_API_KEY_SID: "SKbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  TWILIO_API_KEY_SECRET: API_KEY_SECRET,
  TWILIO_TWIML_APP_SID: "APcccccccccccccccccccccccccccccccc",
  TWILIO_VOICE_CALLER_ID: "+15035550100",
} as const;

// Noon in Portland (PDT) — inside the 8am–9pm window.
const NOON_PT = new Date("2026-06-15T19:00:00Z");
const NIGHT_PT = new Date("2026-06-15T10:00:00Z"); // 3am PDT

let app: Express;
let request: typeof import("supertest");
let db: TestDb;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let adminNoProfile: { id: string };
let support: { id: string };
let viewer: { id: string };
let compliance: { id: string };
let agentUser1: { id: string };
let agentUser2: { id: string };
let otherAdmin: { id: string };
let agent1: { id: string };
let agent2: { id: string };
let adminAgent: { id: string };
let supportAgent: { id: string };

let seq = 0;
/** A fresh, valid, unique US number (503 area, 555-01xx exchange-safe). */
function nextPhone(): { formatted: string; e164: string } {
  seq += 1;
  const line = String(1000 + seq);
  return { formatted: `(503) 555-${line}`, e164: `+1503555${line}` };
}

async function license(agentId: string): Promise<void> {
  await db.insert(schema.stateLicensesTable).values({
    id: randomUUID(), agentId, stateCode: "OR", licenseType: "life_health", status: "active",
    expiryDate: new Date("2030-01-01"),
  });
}

async function newContact(opts: {
  orgId?: string;
  assignedAgentId?: string | null;
  consent?: boolean;
  phone?: string | null;
  state?: string | null;
} = {}): Promise<{ id: string; e164: string }> {
  const p = nextPhone();
  const c = await seedContact(db, { orgId: opts.orgId ?? org.id, firstName: "Call", lastName: `Target${seq}` });
  await db
    .update(schema.contactsTable)
    .set({
      phone: opts.phone === undefined ? p.formatted : opts.phone,
      stateCode: opts.state === undefined ? "OR" : opts.state,
      assignedAgentId: opts.assignedAgentId ?? null,
      currentPlanType: "supp", // no AHIP / carrier-cert requirement
      ...(opts.consent === false ? {} : { tcpaConsentAt: new Date("2026-01-01"), tcpaConsentSource: "web form" }),
    })
    .where(eq(schema.contactsTable.id, c.id));
  return { id: c.id, e164: p.e164 };
}

function sign(url: string, params: Record<string, string>): string {
  const str = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", AUTH_TOKEN).update(str, "utf8").digest("base64");
}

async function postTwilio(
  path: string,
  params: Record<string, string>,
  opts: { badSignature?: boolean; noSignature?: boolean } = {},
) {
  const req = request(app).post(path).type("form");
  if (!opts.noSignature) {
    req.set("X-Twilio-Signature", opts.badSignature ? "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" : sign(`${PUBLIC_HOST}${path}`, params));
  }
  return req.send(params);
}

const VOICE = "/api/webhooks/twilio/voice";
const STATUS = "/api/webhooks/twilio/voice-status";
const NOTICE = "/api/webhooks/twilio/voice-notice";

function newSid(): string {
  return `CA${randomUUID().replace(/-/g, "")}`;
}

async function place(userId: string, contactId: string, extra: Record<string, unknown> = {}) {
  return request(app).post("/api/softphone/calls").set(A(userId)).send({ contactId, ...extra });
}

async function sessionRow(id: string) {
  const [row] = await db.select().from(schema.callSessionsTable).where(eq(schema.callSessionsTable.id, id));
  return row!;
}

/** Place a call as `admin` and return everything the webhook needs. */
async function startedCall(userId = admin.id) {
  const contact = await newContact();
  const res = await place(userId, contact.id);
  expect(res.status).toBe(201);
  return { contact, sessionId: res.body.callSessionId as string, to: res.body.to as string };
}

function voiceParams(sessionId: string, to: string, userId: string, sid = newSid()): Record<string, string> {
  return { CallSid: sid, callSessionId: sessionId, To: to, From: `client:${userId.replace(/[^A-Za-z0-9_]/g, "_")}` };
}

// The test clock jumps around; a fresh Clerk session id per test keeps the
// auth middleware's idle-session cache from timing the user out.
let sessionSalt = randomUUID();
function A(userId: string): Record<string, string> {
  return withAuth(userId, `s-${userId}-${sessionSalt}`);
}

const savedEnv: Record<string, string | undefined> = {};
function setVoiceEnv(on: boolean): void {
  for (const [k, v] of Object.entries(VOICE_ENV)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
}

beforeAll(async () => {
  for (const k of [...Object.keys(VOICE_ENV), "TWILIO_AUTH_TOKEN", "TWILIO_WEBHOOK_PUBLIC_HOST", "DEMO_MODE"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_WEBHOOK_PUBLIC_HOST = PUBLIC_HOST;
  delete process.env.DEMO_MODE;

  const handle = await bootTestDb();
  db = handle.db;
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;

  org = await seedOrg(db, { id: "vc-org" });
  otherOrg = await seedOrg(db, { id: "vc-other-org" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  adminNoProfile = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  support = await seedUser(db, { orgId: org.id, role: "agent_support" });
  viewer = await seedUser(db, { orgId: org.id, role: "viewer" });
  compliance = await seedUser(db, { orgId: org.id, role: "compliance_manager" });
  agentUser1 = await seedUser(db, { orgId: org.id, role: "agent" });
  agentUser2 = await seedUser(db, { orgId: org.id, role: "agent" });
  otherAdmin = await seedUser(db, { orgId: otherOrg.id, role: "agency_admin" });

  agent1 = await seedAgent(db, { orgId: org.id, firstName: "Ann" });
  agent2 = await seedAgent(db, { orgId: org.id, firstName: "Bo" });
  adminAgent = await seedAgent(db, { orgId: org.id, firstName: "Admin" });
  supportAgent = await seedAgent(db, { orgId: org.id, firstName: "Sup" });
  await db.update(schema.agentsTable).set({ userId: agentUser1.id }).where(eq(schema.agentsTable.id, agent1.id));
  await db.update(schema.agentsTable).set({ userId: agentUser2.id }).where(eq(schema.agentsTable.id, agent2.id));
  await db.update(schema.agentsTable).set({ userId: admin.id }).where(eq(schema.agentsTable.id, adminAgent.id));
  await db.update(schema.agentsTable).set({ userId: support.id }).where(eq(schema.agentsTable.id, supportAgent.id));
  for (const a of [agent1, agent2, adminAgent, supportAgent]) await license(a.id);
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await shutdownTestDb();
});

beforeEach(() => {
  sessionSalt = randomUUID();
  setVoiceEnv(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOON_PT);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("auth + permission", () => {
  it("POST /softphone/calls requires auth", async () => {
    const res = await request(app).post("/api/softphone/calls").send({ contactId: "x" });
    expect(res.status).toBe(401);
  });

  it("viewer and compliance_manager cannot place calls or mint tokens", async () => {
    const c = await newContact();
    for (const u of [viewer, compliance]) {
      expect((await place(u.id, c.id)).status).toBe(403);
      expect((await request(app).get("/api/softphone/voice-token").set(A(u.id))).status).toBe(403);
    }
  });

  it("the browser cannot name a destination: extra fields are rejected", async () => {
    const c = await newContact();
    for (const extra of [{ phone: "+15035559999" }, { to: "+15035559999" }, { number: "5035559999" }]) {
      const res = await place(admin.id, c.id, extra);
      expect(res.status).toBe(400);
    }
    const rows = await db.select().from(schema.callSessionsTable).where(eq(schema.callSessionsTable.contactId, c.id));
    expect(rows).toHaveLength(0);
  });

  it("dials the contact's stored number, returned as E.164", async () => {
    const c = await newContact();
    const res = await place(admin.id, c.id);
    expect(res.status).toBe(201);
    expect(res.body.to).toBe(c.e164);
    const row = await sessionRow(res.body.callSessionId);
    expect(row).toMatchObject({
      orgId: org.id, contactId: c.id, userId: admin.id, agentId: adminAgent.id,
      direction: "outbound", toNumber: c.e164, fromNumber: VOICE_ENV.TWILIO_VOICE_CALLER_ID,
      status: "initiated", recordingEnabled: false,
    });
    expect((row.preclearanceResult as { precleared: boolean }).precleared).toBe(true);
  });

  it("writes an audit row for placed and blocked calls (no phone numbers in it)", async () => {
    const ok = await newContact();
    const okRes = await place(admin.id, ok.id);
    const bad = await newContact({ consent: false });
    const badRes = await place(admin.id, bad.id);
    expect(badRes.status).toBe(409);
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogTable)
        .where(and(eq(schema.auditLogTable.resourceType, "call"), eq(schema.auditLogTable.orgId, org.id)));
      const ids = rows.map((r) => r.resourceId);
      expect(ids).toContain(okRes.body.callSessionId);
      expect(ids).toContain(badRes.body.callSessionId);
      expect(JSON.stringify(rows.map((r) => r.changes))).not.toMatch(/\+1503|\(503\)/);
    });
  });
});

describe("org + agent scoping", () => {
  it("another org's admin cannot call an org contact (404, no session row)", async () => {
    const c = await newContact();
    const res = await place(otherAdmin.id, c.id);
    expect(res.status).toBe(404);
    const rows = await db.select().from(schema.callSessionsTable).where(eq(schema.callSessionsTable.contactId, c.id));
    expect(rows).toHaveLength(0);
  });

  it("an agent may call only contacts assigned to their own agent profile", async () => {
    const mine = await newContact({ assignedAgentId: agent1.id });
    const theirs = await newContact({ assignedAgentId: agent2.id });
    const unassigned = await newContact();
    expect((await place(agentUser1.id, mine.id)).status).toBe(201);
    expect((await place(agentUser1.id, theirs.id)).status).toBe(404);
    expect((await place(agentUser1.id, unassigned.id)).status).toBe(404);
    // Back-office roles are not narrowed.
    expect((await place(support.id, theirs.id)).status).toBe(201);
  });

  it("GET /softphone/calls: agents see only their own, admins see the org, other orgs see nothing", async () => {
    const a = await newContact({ assignedAgentId: agent1.id });
    const b = await newContact({ assignedAgentId: agent2.id });
    const r1 = await place(agentUser1.id, a.id);
    const r2 = await place(agentUser2.id, b.id);

    const mine = await request(app).get("/api/softphone/calls?limit=50").set(A(agentUser1.id));
    expect(mine.status).toBe(200);
    const mineIds = mine.body.data.map((r: { id: string }) => r.id);
    expect(mineIds).toContain(r1.body.callSessionId);
    expect(mineIds).not.toContain(r2.body.callSessionId);
    expect(mine.body.data.every((r: { userId: string }) => r.userId === agentUser1.id)).toBe(true);

    const all = await request(app).get("/api/softphone/calls?limit=50").set(A(admin.id));
    const allIds = all.body.data.map((r: { id: string }) => r.id);
    expect(allIds).toEqual(expect.arrayContaining([r1.body.callSessionId, r2.body.callSessionId]));

    const other = await request(app).get("/api/softphone/calls?limit=50").set(A(otherAdmin.id));
    expect(other.status).toBe(200);
    expect(other.body.data).toHaveLength(0);

    expect((await request(app).get("/api/softphone/calls").set(A(viewer.id))).status).toBe(403);
  });
});

describe("preclearance blocks each store a blocked row and return 409 with the reason", () => {
  async function expectBlocked(
    res: { status: number; body: { code?: string; reasons?: { code: string }[]; callSessionId?: string } },
    code: string,
  ) {
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
    expect(res.body.reasons?.map((r) => r.code)).toContain(code);
    const row = await sessionRow(res.body.callSessionId!);
    expect(row.status).toBe("blocked");
    expect(row.blockedReason).toContain(code);
    expect(row.twilioCallSid).toBeNull();
    expect((row.preclearanceResult as { precleared: boolean }).precleared).toBe(false);
  }

  it("number opted out by ANOTHER org (shared number, formatted differently)", async () => {
    const c = await newContact();
    await db.insert(schema.optOutsTable).values({ id: randomUUID(), orgId: otherOrg.id, phone: c.e164, channel: "sms" });
    await expectBlocked(await place(admin.id, c.id), "DNC");
  });

  it("outside calling hours in the contact's timezone", async () => {
    const c = await newContact();
    vi.setSystemTime(NIGHT_PT);
    await expectBlocked(await place(admin.id, c.id), "OUTSIDE_CALLING_HOURS");
  });

  it("no documented consent", async () => {
    const c = await newContact({ consent: false });
    await expectBlocked(await place(admin.id, c.id), "NO_CONSENT");
  });

  it("contact marked do_not_contact", async () => {
    const c = await newContact();
    await db.update(schema.contactsTable).set({ status: "do_not_contact" }).where(eq(schema.contactsTable.id, c.id));
    await expectBlocked(await place(admin.id, c.id), "DNC");
  });

  it("invalid / missing number", async () => {
    const bad = await newContact({ phone: "12345" });
    await expectBlocked(await place(admin.id, bad.id), "INVALID_NUMBER");
    const none = await newContact({ phone: null });
    await expectBlocked(await place(admin.id, none.id), "INVALID_NUMBER");
  });

  it("caller with no agent profile and an unassigned contact fails closed", async () => {
    const c = await newContact();
    await expectBlocked(await place(adminNoProfile.id, c.id), "AGENT_NOT_ELIGIBLE");
  });

  it("agent without an active license for the contact's state", async () => {
    const c = await newContact({ state: "TX" });
    await expectBlocked(await place(admin.id, c.id), "AGENT_NOT_LICENSED");
  });

  it("over the attempt limit inside the window", async () => {
    const c = await newContact();
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.callSessionsTable).values({
        id: randomUUID(), orgId: org.id, contactId: c.id, userId: admin.id, toNumber: c.e164,
        status: "completed", createdAt: new Date(NOON_PT.getTime() - (2 + i) * 3_600_000),
      });
    }
    await expectBlocked(await place(admin.id, c.id), "MAX_ATTEMPTS_EXCEEDED");
  });

  it("attempts outside the window do not count", async () => {
    const c = await newContact();
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.callSessionsTable).values({
        id: randomUUID(), orgId: org.id, contactId: c.id, userId: admin.id, toNumber: c.e164,
        status: "completed", createdAt: new Date(NOON_PT.getTime() - (30 + i) * 3_600_000),
      });
    }
    expect((await place(admin.id, c.id)).status).toBe(201);
  });

  it("inside the redial cooldown", async () => {
    const c = await newContact();
    await db.insert(schema.callSessionsTable).values({
      id: randomUUID(), orgId: org.id, contactId: c.id, userId: admin.id, toNumber: c.e164,
      status: "no_answer", createdAt: new Date(NOON_PT.getTime() - 5 * 60_000),
    });
    await expectBlocked(await place(admin.id, c.id), "REDIAL_COOLDOWN");
  });

  it("blocked attempts do not themselves count toward limits, but a second live call right away is a cooldown hit", async () => {
    const c = await newContact();
    expect((await place(admin.id, c.id)).status).toBe(201);
    await expectBlocked(await place(admin.id, c.id), "REDIAL_COOLDOWN");
  });

  it("two parallel requests cannot both pass the cooldown", async () => {
    const c = await newContact();
    const [a, b] = await Promise.all([place(admin.id, c.id), place(admin.id, c.id)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it("returns 503 needs_setup (no session row) when Twilio env is missing", async () => {
    const c = await newContact();
    setVoiceEnv(false);
    const res = await place(admin.id, c.id);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("needs_setup");
    expect(res.body.missing).toContain("TWILIO_VOICE_CALLER_ID");
    const rows = await db.select().from(schema.callSessionsTable).where(eq(schema.callSessionsTable.contactId, c.id));
    expect(rows).toHaveLength(0);
  });
});

describe("GET /softphone/voice-token", () => {
  it("requires auth", async () => {
    expect((await request(app).get("/api/softphone/voice-token")).status).toBe(401);
  });

  it("503 needs_setup with the missing env NAMES only", async () => {
    setVoiceEnv(false);
    const res = await request(app).get("/api/softphone/voice-token").set(A(admin.id));
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("needs_setup");
    expect(res.body.missing.sort()).toEqual(Object.keys(VOICE_ENV).sort());
    expect(JSON.stringify(res.body)).not.toContain(API_KEY_SECRET);

    process.env.TWILIO_ACCOUNT_SID = VOICE_ENV.TWILIO_ACCOUNT_SID;
    process.env.TWILIO_API_KEY_SID = VOICE_ENV.TWILIO_API_KEY_SID;
    const partial = await request(app).get("/api/softphone/voice-token").set(A(admin.id));
    expect(partial.status).toBe(503);
    expect(partial.body.missing.sort()).toEqual(
      ["TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID", "TWILIO_VOICE_CALLER_ID"].sort(),
    );
  });

  it("a malformed caller id is reported as needing setup", async () => {
    process.env.TWILIO_VOICE_CALLER_ID = "not-a-number";
    const res = await request(app).get("/api/softphone/voice-token").set(A(admin.id));
    expect(res.status).toBe(503);
    expect(res.body.missing).toEqual(["TWILIO_VOICE_CALLER_ID"]);
  });

  it("mints a short-lived HS256 JWT with a VoiceGrant for the signed-in user", async () => {
    const res = await request(app).get("/api/softphone/voice-token").set(A(agentUser1.id));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(Object.keys(res.body).sort()).toEqual(["expiresAt", "identity", "token", "ttlSeconds"]);

    const [h, p, s] = (res.body.token as string).split(".");
    const header = JSON.parse(Buffer.from(h!, "base64url").toString());
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(header).toMatchObject({ alg: "HS256", typ: "JWT" });
    // Signature verifies against the API key secret (and only that).
    const expected = createHmac("sha256", API_KEY_SECRET).update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);

    expect(claims.iss).toBe(VOICE_ENV.TWILIO_API_KEY_SID);
    expect(claims.sub).toBe(VOICE_ENV.TWILIO_ACCOUNT_SID);
    expect(claims.grants.identity).toBe(agentUser1.id.replace(/[^A-Za-z0-9_]/g, "_"));
    expect(res.body.identity).toBe(claims.grants.identity);
    expect(claims.grants.voice.outgoing.application_sid).toBe(VOICE_ENV.TWILIO_TWIML_APP_SID);
    expect(claims.grants.voice.incoming).toBeUndefined();
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(new Date(res.body.expiresAt).getTime()).toBe(claims.exp * 1000);
    // No secret material anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain(API_KEY_SECRET);
    expect(JSON.stringify(claims)).not.toContain(API_KEY_SECRET);
  });
});

describe("POST /api/webhooks/twilio/voice", () => {
  it("rejects a bad or missing signature (403) and does not touch the session", async () => {
    const { sessionId, to } = await startedCall();
    const params = voiceParams(sessionId, to, admin.id);
    const bad = await postTwilio(VOICE, params, { badSignature: true });
    expect(bad.status).toBe(403);
    expect(bad.text).not.toContain("<Dial");
    const none = await postTwilio(VOICE, params, { noSignature: true });
    expect(none.status).toBe(403);
    expect((await sessionRow(sessionId)).status).toBe("initiated");
  });

  it("rejects a signature computed for different parameters", async () => {
    const { sessionId, to } = await startedCall();
    const params = voiceParams(sessionId, to, admin.id);
    const signedFor = sign(`${PUBLIC_HOST}${VOICE}`, { ...params, To: "+15035550999" });
    const res = await request(app).post(VOICE).type("form").set("X-Twilio-Signature", signedFor).send(params);
    expect(res.status).toBe(403);
    expect((await sessionRow(sessionId)).status).toBe("initiated");
  });

  it("host pinning: a signature over the request's Host header is not accepted", async () => {
    const { sessionId, to } = await startedCall();
    const params = voiceParams(sessionId, to, admin.id);
    const forged = sign(`https://evil.example${VOICE}`, params);
    const res = await request(app)
      .post(VOICE).type("form")
      .set("Host", "evil.example").set("X-Forwarded-Proto", "https")
      .set("X-Twilio-Signature", forged).send(params);
    expect(res.status).toBe(403);
  });

  it("happy path: TwiML dials the STORED number only, answerOnBridge, no recording", async () => {
    const { sessionId, to } = await startedCall();
    const sid = newSid();
    const res = await postTwilio(VOICE, {
      ...voiceParams(sessionId, to, admin.id, sid),
      // Anything else in the request must never influence the destination.
      Called: "+19995550000", Dial: "+19995550001", Number: "+19995550002",
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.text).toContain(`<Number>${to}</Number>`);
    expect(res.text).toContain(`callerId="${VOICE_ENV.TWILIO_VOICE_CALLER_ID}"`);
    expect(res.text).toContain('answerOnBridge="true"');
    expect(res.text).not.toContain("record=");
    expect(res.text).not.toContain("<Say>");
    expect(res.text).not.toMatch(/9995550/);
    expect(res.text.match(/<Number/g)).toHaveLength(1);
    const row = await sessionRow(sessionId);
    expect(row.status).toBe("ringing");
    expect(row.twilioCallSid).toBe(sid);
  });

  it("a session is single-use: replay (same or new CallSid) is rejected and leaves the live call alone", async () => {
    const { sessionId, to } = await startedCall();
    const sid = newSid();
    const first = await postTwilio(VOICE, voiceParams(sessionId, to, admin.id, sid));
    expect(first.text).toContain("<Dial");
    for (const replaySid of [sid, newSid()]) {
      const replay = await postTwilio(VOICE, voiceParams(sessionId, to, admin.id, replaySid));
      expect(replay.status).toBe(200);
      expect(replay.text).toContain("<Reject");
      expect(replay.text).not.toContain("<Dial");
    }
    const row = await sessionRow(sessionId);
    expect(row.status).toBe("ringing"); // not clobbered to blocked
    expect(row.twilioCallSid).toBe(sid);
  });

  it("two simultaneous deliveries: exactly one dials", async () => {
    const { sessionId, to } = await startedCall();
    const [a, b] = await Promise.all([
      postTwilio(VOICE, voiceParams(sessionId, to, admin.id)),
      postTwilio(VOICE, voiceParams(sessionId, to, admin.id)),
    ]);
    const dialed = [a, b].filter((r) => r.text.includes("<Dial"));
    expect(dialed).toHaveLength(1);
  });

  it("an expired session (older than 2 minutes) is rejected and marked blocked", async () => {
    const { sessionId, to } = await startedCall();
    vi.setSystemTime(new Date(NOON_PT.getTime() + 3 * 60_000));
    const res = await postTwilio(VOICE, voiceParams(sessionId, to, admin.id));
    expect(res.text).toContain("<Reject");
    const row = await sessionRow(sessionId);
    expect(row.status).toBe("blocked");
    expect(row.blockedReason).toContain("expired");
  });

  it("a number that does not match the stored one is rejected and marked blocked", async () => {
    const { sessionId } = await startedCall();
    const res = await postTwilio(VOICE, voiceParams(sessionId, "+15035550777", admin.id));
    expect(res.text).toContain("<Reject");
    expect(res.text).not.toContain("5550777");
    const row = await sessionRow(sessionId);
    expect(row.status).toBe("blocked");
    expect(row.blockedReason).toContain("number_mismatch");
  });

  it("a session used by a different Twilio identity is rejected", async () => {
    const { sessionId, to } = await startedCall();
    const res = await postTwilio(VOICE, voiceParams(sessionId, to, agentUser2.id));
    expect(res.text).toContain("<Reject");
    expect((await sessionRow(sessionId)).status).toBe("blocked");
  });

  it("unknown, missing or malformed session id / CallSid is rejected", async () => {
    const good = await startedCall();
    for (const params of [
      voiceParams(randomUUID(), "+15035550101", admin.id),
      { ...voiceParams(good.sessionId, good.to, admin.id), callSessionId: "" },
      voiceParams(good.sessionId, good.to, admin.id, "not-a-sid"),
    ]) {
      const res = await postTwilio(VOICE, params);
      expect(res.status).toBe(200);
      expect(res.text).toContain("<Reject");
    }
    expect((await sessionRow(good.sessionId)).status).toBe("initiated");
  });

  it("a blocked preclearance row can never be dialed", async () => {
    const c = await newContact({ consent: false });
    const blocked = await place(admin.id, c.id);
    expect(blocked.status).toBe(409);
    const res = await postTwilio(VOICE, voiceParams(blocked.body.callSessionId, c.e164, admin.id));
    expect(res.text).toContain("<Reject");
    expect((await sessionRow(blocked.body.callSessionId)).twilioCallSid).toBeNull();
  });

  it("re-checks opt-outs at dial time: a STOP after preclearance wins", async () => {
    const { contact, sessionId, to } = await startedCall();
    await db.insert(schema.optOutsTable).values({ id: randomUUID(), orgId: otherOrg.id, phone: contact.e164, channel: "sms" });
    const res = await postTwilio(VOICE, voiceParams(sessionId, to, admin.id));
    expect(res.text).toContain("<Reject");
    const row = await sessionRow(sessionId);
    expect(row.status).toBe("blocked");
    expect(row.blockedReason).toContain("opted_out");
  });

  it("recording OFF by default; when enabled the callee hears a notice before bridging", async () => {
    const { sessionId, to } = await startedCall();
    await db.update(schema.callSessionsTable).set({ recordingEnabled: true }).where(eq(schema.callSessionsTable.id, sessionId));
    const res = await postTwilio(VOICE, voiceParams(sessionId, to, admin.id));
    expect(res.text).toContain('record="record-from-answer-dual"');
    expect(res.text).toContain(`<Number url="/api/webhooks/twilio/voice-notice"`);

    const notice = await postTwilio(NOTICE, { CallSid: newSid() });
    expect(notice.status).toBe(200);
    expect(notice.text).toContain("<Say>");
    expect((await postTwilio(NOTICE, { CallSid: newSid() }, { badSignature: true })).status).toBe(403);
  });

  it("writes an audit row for a dial and for a rejection (reasons only)", async () => {
    const { sessionId, to } = await startedCall();
    await postTwilio(VOICE, voiceParams(sessionId, to, admin.id));
    const replay = await startedCall();
    await postTwilio(VOICE, voiceParams(replay.sessionId, "+15035550778", admin.id));
    const rows = await db.select().from(schema.auditLogTable).where(eq(schema.auditLogTable.resourceType, "call"));
    const dialed = rows.find((r) => r.resourceId === sessionId && r.action === "call_voice_dialed");
    const rejected = rows.find((r) => r.resourceId === replay.sessionId && r.action === "call_voice_rejected");
    expect(dialed).toBeTruthy();
    expect(rejected).toBeTruthy();
    expect(JSON.stringify(rejected!.changes)).not.toMatch(/\+1503/);
  });
});

describe("POST /api/webhooks/twilio/voice-status", () => {
  async function ringing() {
    const started = await startedCall();
    const sid = newSid();
    const res = await postTwilio(VOICE, voiceParams(started.sessionId, started.to, admin.id, sid));
    expect(res.text).toContain("<Dial");
    return { ...started, sid };
  }

  async function callLogs(contactId: string) {
    return db
      .select()
      .from(schema.activitiesTable)
      .where(and(eq(schema.activitiesTable.contactId, contactId), eq(schema.activitiesTable.type, "call_log")));
  }

  it("rejects a bad signature and changes nothing", async () => {
    const { sessionId, sid } = await ringing();
    const res = await postTwilio(STATUS, { CallSid: sid, CallStatus: "completed", CallDuration: "30" }, { badSignature: true });
    expect(res.status).toBe(403);
    expect((await sessionRow(sessionId)).status).toBe("ringing");
  });

  it("completion updates the row and writes exactly one call_log; redelivery is a no-op", async () => {
    const { contact, sessionId, sid } = await ringing();
    await postTwilio(STATUS, { CallSid: sid, CallStatus: "in-progress" });
    expect((await sessionRow(sessionId)).status).toBe("in_progress");
    expect((await sessionRow(sessionId)).answeredAt).not.toBeNull();

    const done = { CallSid: sid, CallStatus: "completed", CallDuration: "134" };
    expect((await postTwilio(STATUS, done)).status).toBe(200);
    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({ status: "completed", durationSeconds: 134 });
    expect(row.endedAt).not.toBeNull();

    // Twilio retries, plus an out-of-order late "in-progress".
    await postTwilio(STATUS, done);
    await postTwilio(STATUS, done);
    await postTwilio(STATUS, { CallSid: sid, CallStatus: "in-progress" });
    await postTwilio(STATUS, { CallSid: sid, CallStatus: "ringing" });

    const logs = await callLogs(contact.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.body).toContain("Completed");
    expect(logs[0]!.body).toContain("2m 14s");
    expect(logs[0]!.metadata).toMatchObject({ callSessionId: sessionId, outcome: "completed", durationSeconds: 134 });
    expect(JSON.stringify(logs[0])).not.toMatch(/\+1503|\(503\)/);
    const final = await sessionRow(sessionId);
    expect(final.status).toBe("completed");
    expect(final.activityId).toBe(logs[0]!.id);
  });

  it("concurrent duplicate completions still log the call once", async () => {
    const { contact, sid } = await ringing();
    const done = { CallSid: sid, CallStatus: "completed", CallDuration: "10" };
    await Promise.all([postTwilio(STATUS, done), postTwilio(STATUS, done), postTwilio(STATUS, done)]);
    expect(await callLogs(contact.id)).toHaveLength(1);
  });

  it("the <Dial action> callee outcome wins, and the later browser-leg 'completed' changes nothing", async () => {
    const { contact, sessionId, sid } = await ringing();
    await postTwilio(STATUS, { CallSid: sid, DialCallStatus: "no-answer", DialCallDuration: "0", CallStatus: "in-progress" });
    expect((await sessionRow(sessionId)).status).toBe("no_answer");
    await postTwilio(STATUS, { CallSid: sid, CallStatus: "completed", CallDuration: "31" });
    const row = await sessionRow(sessionId);
    expect(row.status).toBe("no_answer");
    const logs = await callLogs(contact.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.body).toContain("No answer");
  });

  it("an unknown CallSid or unmapped status is acknowledged and ignored", async () => {
    const { sessionId, sid } = await ringing();
    expect((await postTwilio(STATUS, { CallSid: newSid(), CallStatus: "completed" })).status).toBe(200);
    expect((await postTwilio(STATUS, { CallSid: sid, CallStatus: "mystery" })).status).toBe(200);
    expect((await postTwilio(STATUS, { CallStatus: "completed" })).status).toBe(200);
    expect((await sessionRow(sessionId)).status).toBe("ringing");
  });
});

describe("PATCH /softphone/calls/:id (disposition + notes)", () => {
  async function completedCall(userId = admin.id) {
    const started = await startedCall(userId);
    const sid = newSid();
    await postTwilio(VOICE, voiceParams(started.sessionId, started.to, userId, sid));
    await postTwilio(STATUS, { CallSid: sid, CallStatus: "completed", CallDuration: "60" });
    return started;
  }
  const patch = (userId: string, id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/softphone/calls/${id}`).set(A(userId)).send(body);

  it("owner saves a disposition and notes; the call_log activity gets the disposition", async () => {
    const { sessionId } = await completedCall();
    const res = await patch(admin.id, sessionId, { dispositionCode: "FOLLOW_UP", notes: "  call back Tuesday  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dispositionCode: "FOLLOW_UP", notes: "call back Tuesday", status: "completed" });
    const row = await sessionRow(sessionId);
    expect(row.dispositionCode).toBe("FOLLOW_UP");
    const [act] = await db.select().from(schema.activitiesTable).where(eq(schema.activitiesTable.id, row.activityId!));
    expect(act!.metadata).toMatchObject({ disposition: "FOLLOW_UP" });
  });

  it("validation: unknown code, oversize notes, empty body", async () => {
    const { sessionId } = await completedCall();
    expect((await patch(admin.id, sessionId, { dispositionCode: "BOGUS" })).status).toBe(400);
    expect((await patch(admin.id, sessionId, { notes: "x".repeat(2001) })).status).toBe(400);
    expect((await patch(admin.id, sessionId, {})).status).toBe(400);
  });

  it("owner or admin only; other agents and other orgs get 404; viewers 403", async () => {
    const contact = await newContact({ assignedAgentId: agent1.id });
    const placed = await place(agentUser1.id, contact.id);
    const id = placed.body.callSessionId as string;

    expect((await patch(agentUser2.id, id, { notes: "nope" })).status).toBe(404);
    expect((await patch(support.id, id, { notes: "nope" })).status).toBe(404);
    expect((await patch(otherAdmin.id, id, { notes: "nope" })).status).toBe(404);
    expect((await patch(viewer.id, id, { notes: "nope" })).status).toBe(403);
    expect((await sessionRow(id)).notes).toBeNull();

    expect((await patch(agentUser1.id, id, { notes: "mine" })).status).toBe(200);
    expect((await patch(admin.id, id, { notes: "admin edit" })).status).toBe(200);
    expect((await sessionRow(id)).notes).toBe("admin edit");
  });

  it("a blocked call cannot be dispositioned", async () => {
    const c = await newContact({ consent: false });
    const blocked = await place(admin.id, c.id);
    expect((await patch(admin.id, blocked.body.callSessionId, { dispositionCode: "NEUTRAL" })).status).toBe(409);
  });

  it("DO_NOT_CALL creates an opt-out (idempotently) and blocks the next call attempt", async () => {
    const { contact, sessionId } = await completedCall();
    const res = await patch(admin.id, sessionId, { dispositionCode: "DO_NOT_CALL" });
    expect(res.status).toBe(200);
    // Saving it twice must not duplicate or fail.
    expect((await patch(admin.id, sessionId, { dispositionCode: "DO_NOT_CALL" })).status).toBe(200);

    const optOuts = await db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id));
    const mine = optOuts.filter((o) => o.phone === contact.e164);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ channel: "sms", source: "call_disposition" });
    const [c] = await db.select().from(schema.contactsTable).where(eq(schema.contactsTable.id, contact.id));
    expect(c!.optOutSms).toBe(true);

    // Time passes (past the cooldown); the opt-out still blocks.
    vi.setSystemTime(new Date(NOON_PT.getTime() + 60 * 60_000));
    sessionSalt = randomUUID();
    const again = await place(admin.id, contact.id);
    expect(again.status).toBe(409);
    expect(again.body.reasons.map((r: { code: string }) => r.code)).toContain("DNC");

    const audit = await db.select().from(schema.auditLogTable).where(eq(schema.auditLogTable.action, "call_dnc_opt_out"));
    expect(audit.some((a) => a.resourceId === sessionId)).toBe(true);
  });
});

describe("GET /softphone/dispositions", () => {
  it("includes DO_NOT_CALL alongside the shared categories", async () => {
    const res = await request(app).get("/api/softphone/dispositions").set(A(admin.id));
    const codes = res.body.data.map((d: { code: string }) => d.code);
    expect(codes).toEqual(expect.arrayContaining(["POSITIVE", "FOLLOW_UP", "DO_NOT_CALL"]));
  });
});
