/**
 * Call scoring routes (routes/callScoring.ts): auth and permissions, org and
 * agent scoping, upload limits and bad files, contact matching, encryption,
 * human overrides on an immutable result, the do-not-contact review queue
 * (a person confirms; exactly one opt-out and one audit row; idempotent),
 * bulk import with a manifest, and the AI step (redacted text only, honest
 * "needs_setup").
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
    return jobsMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);

// The AI reviewer is the only thing swapped: the real (HIPAA-gated) one is used when unset.
vi.mock("../../lib/callScoring/aiReviewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/callScoring/aiReviewer")>();
  return {
    ...actual,
    resolveAiReviewer: () => {
      const client = (globalThis as { __CS_AI_CLIENT__?: unknown }).__CS_AI_CLIENT__;
      return client ? actual.createAiReviewer(client as never, "test-model") : null;
    },
  };
});

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import type { LiteCriterion } from "../../lib/callScoring/store";

// Loaded after the test database boots (they import @workspace/db).
let detailLib: typeof import("../../lib/callScoring/detail");
let dncLib: typeof import("../../lib/callScoring/dncReview");
let storeLib: typeof import("../../lib/callScoring/store");
import { seedAgent, seedContact, seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;

const settle = () => new Promise((r) => setTimeout(r, 200));

let org: { id: string };
let otherOrg: { id: string };
// Several agency admins that all read as "Alex Admin": the API allows 100 requests a minute per user,
// and this file makes more than that, so `admin.id` rotates through the pool.
const adminPool: Array<{ id: string }> = [];
let adminTurn = 0;
const admin = {
  get id(): string {
    return adminPool[adminTurn++ % adminPool.length]!.id;
  },
};
let compliance: { id: string };
let viewer: { id: string };
let support: { id: string };
let otherAdmin: { id: string };
let agentUser: { id: string };
let otherAgentUser: { id: string };
let agentProfile: { id: string };
let otherAgentProfile: { id: string };
let contactUnique: { id: string };
let contactDupA: { id: string };
let contactDupB: { id: string };
let otherOrgContact: { id: string };
let ownSession: { id: string };
let otherSession: { id: string };

const PHONE_UNIQUE = "+13105550111";
const PHONE_DUP = "+13105550122";

let counter = 0;
/** A unique, labelled transcript. `extra` lines are appended (client speech unless prefixed). */
function transcriptText(extra: string[] = []): string {
  counter++;
  return [
    "Agent: Thank you for calling Sunrise Benefits, my name is Dana Brooks and I'm a licensed insurance agent.",
    "Agent: This call is being recorded.",
    "Customer: Okay.",
    "Agent: We do not offer every plan available in your area. Currently we represent 7 organizations which offer 42 products in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program.",
    `Customer: Nice weather number ${counter}-${randomUUID().slice(0, 8)} today.`,
    ...extra,
  ].join("\n");
}

const post = (userId: string, body: Record<string, unknown>) =>
  request(app).post("/api/call-scoring/transcripts").set(withAuth(userId)).send(body);

async function createScored(text: string, extra: Record<string, unknown> = {}, userId = admin.id) {
  const res = await post(userId, { text, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { transcriptId: string; scoreId: string; compliance: string; dncFlagCount: number; ai: { status: string }; notes: Array<{ code: string }>; contact: { id: string | null; match: string } };
}

async function setPhone(contactId: string, phone: string) {
  await handle.db.update(schema.contactsTable).set({ phone }).where(eq(schema.contactsTable.id, contactId));
}

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  detailLib = await import("../../lib/callScoring/detail");
  dncLib = await import("../../lib/callScoring/dncReview");
  storeLib = await import("../../lib/callScoring/store");
  request = ((await import("supertest")) as any).default;
  const db = handle.db;

  org = await seedOrg(db, { id: "cs-org" });
  otherOrg = await seedOrg(db, { id: "cs-other-org" });
  for (let i = 0; i < 12; i++) adminPool.push(await seedUser(db, { orgId: org.id, role: "agency_admin", fullName: "Alex Admin" }));
  compliance = await seedUser(db, { orgId: org.id, role: "compliance_manager", fullName: "Casey Compliance" });
  viewer = await seedUser(db, { orgId: org.id, role: "viewer" });
  support = await seedUser(db, { orgId: org.id, role: "agent_support" });
  otherAdmin = await seedUser(db, { orgId: otherOrg.id, role: "agency_admin" });
  agentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  otherAgentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  agentProfile = await seedAgent(db, { orgId: org.id, firstName: "Dana", lastName: "Brooks", email: "dana@agency.example" });
  otherAgentProfile = await seedAgent(db, { orgId: org.id, firstName: "Sam", lastName: "Ortiz" });
  await db.update(schema.agentsTable).set({ userId: agentUser.id }).where(eq(schema.agentsTable.id, agentProfile.id));
  await db.update(schema.agentsTable).set({ userId: otherAgentUser.id }).where(eq(schema.agentsTable.id, otherAgentProfile.id));

  contactUnique = await seedContact(db, { orgId: org.id, firstName: "Uma", lastName: "Unique" });
  contactDupA = await seedContact(db, { orgId: org.id, firstName: "Dee", lastName: "Dup" });
  contactDupB = await seedContact(db, { orgId: org.id, firstName: "Dot", lastName: "Dup" });
  otherOrgContact = await seedContact(db, { orgId: otherOrg.id, firstName: "Olga", lastName: "Other" });
  await setPhone(contactUnique.id, "(310) 555-0111");
  await setPhone(contactDupA.id, "310-555-0122");
  await setPhone(contactDupB.id, PHONE_DUP);
  await setPhone(otherOrgContact.id, PHONE_UNIQUE);

  const session = async (userId: string, agentId: string) => {
    const id = `cs-session-${randomUUID()}`;
    await db.insert(schema.callSessionsTable).values({ id, orgId: org.id, userId, agentId, toNumber: PHONE_UNIQUE, status: "completed" });
    return { id };
  };
  ownSession = await session(agentUser.id, agentProfile.id);
  otherSession = await session(otherAgentUser.id, otherAgentProfile.id);
});

afterAll(async () => {
  await shutdownTestDb();
});

beforeEach(() => {
  (globalThis as { __CS_AI_CLIENT__?: unknown }).__CS_AI_CLIENT__ = undefined;
});

describe("auth and permissions", () => {
  it("requires sign-in", async () => {
    await request(app).get("/api/call-scoring/transcripts").expect(401);
    await request(app).post("/api/call-scoring/transcripts").send({ text: "x" }).expect(401);
    await request(app).get("/api/call-scoring/dnc-review").expect(401);
  });

  it("viewer and agent_support cannot read, create, review or import", async () => {
    for (const u of [viewer, support]) {
      await request(app).get("/api/call-scoring/transcripts").set(withAuth(u.id)).expect(403);
      await request(app).get("/api/call-scoring/config").set(withAuth(u.id)).expect(403);
      await post(u.id, { text: transcriptText() }).expect(403);
      await request(app).get("/api/call-scoring/dnc-review").set(withAuth(u.id)).expect(403);
      await request(app).post("/api/call-scoring/import").set(withAuth(u.id)).attach("files", Buffer.from("Agent: hi"), "a.txt").expect(403);
    }
  });

  it("an agent can read but never create, rescore, review, import or see the do-not-contact queue", async () => {
    await request(app).get("/api/call-scoring/transcripts").set(withAuth(agentUser.id)).expect(200);
    await request(app).get("/api/call-scoring/config").set(withAuth(agentUser.id)).expect(200);
    await post(agentUser.id, { text: transcriptText() }).expect(403);
    const t = await createScored(transcriptText());
    await request(app).post(`/api/call-scoring/transcripts/${t.transcriptId}/rescore`).set(withAuth(agentUser.id)).send({}).expect(403);
    await request(app).patch(`/api/call-scoring/transcripts/${t.transcriptId}/criteria/rapport`).set(withAuth(agentUser.id)).send({ verdict: "pass", note: "ok ok" }).expect(403);
    await request(app).get("/api/call-scoring/dnc-review").set(withAuth(agentUser.id)).expect(403);
    await request(app).post("/api/call-scoring/import").set(withAuth(agentUser.id)).attach("files", Buffer.from("Agent: hi"), "a.txt").expect(403);
  });

  it("compliance managers can do everything an agency admin can", async () => {
    const res = await post(compliance.id, { text: transcriptText() });
    expect(res.status).toBe(201);
    await request(app).get("/api/call-scoring/dnc-review").set(withAuth(compliance.id)).expect(200);
  });
});

describe("config: honest about what is not set up", () => {
  it("says audio transcription is not set up and AI review needs setup", async () => {
    const res = await request(app).get("/api/call-scoring/config").set(withAuth(admin.id)).expect(200);
    expect(res.body.audio.supported).toBe(false);
    expect(res.body.audio.message).toMatch(/not set up/i);
    expect(res.body.ai.status).toBe("needs_setup");
    expect(res.body.rubrics.map((r: { id: string }) => r.id)).toEqual(["medicare-tpmo", "general-sales"]);
    expect(res.body.disclaimer).toMatch(/not legal advice/i);
    expect(res.body.limits.acceptedFormats).toEqual([".txt", ".vtt", ".srt", ".json"]);
    expect(res.body.canCreate).toBe(true);
  });
});

describe("creating and scoring a transcript", () => {
  it("scores pasted text with rules, stores it encrypted, and reports needs_setup for AI", async () => {
    const text = transcriptText(["Customer: My favourite colour is marigold."]);
    const t = await createScored(text);
    expect(t.compliance).toMatch(/pass|fail|review/);
    expect(t.ai.status).toBe("needs_setup");
    expect(t.notes.map((n) => n.code)).toEqual(expect.arrayContaining(["timing_estimated", "ai_needs_setup"]));

    const [row] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, t.transcriptId));
    const sealed = Buffer.from(row!.transcriptEncrypted!);
    expect(sealed.length).toBeGreaterThan(40);
    const raw = sealed.toString("utf8") + sealed.toString("latin1");
    expect(raw).not.toContain("Sunrise Benefits");
    expect(raw).not.toContain("marigold");
    expect(row!.contentDigest.length).toBe(32);
    expect(row!.retainUntil.getTime() - row!.createdAt.getTime()).toBeGreaterThanOrEqual(3650 * 86_400_000 - 1000);
    expect(row!.orgId).toBe(org.id);
    expect(row!.speakerMode).toBe("labelled");

    const findings = await handle.db.select().from(schema.callScoreFindingsTable).where(eq(schema.callScoreFindingsTable.scoreId, t.scoreId));
    expect(findings.length).toBeGreaterThan(5);
    for (const f of findings) {
      expect(f.orgId).toBe(org.id);
      if (f.evidenceEncrypted) expect(Buffer.from(f.evidenceEncrypted).toString("latin1")).not.toContain("Sunrise");
    }
    // No AI ran and judgment items are honest about it.
    const judgment = findings.find((f) => f.criterionId === "informed_enrollment")!;
    expect(judgment.verdict).toBe("needs_review");
  });

  it("accepts an uploaded VTT file and keeps the filename only inside the encrypted payload", async () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Agent: Thanks for calling, this is Dana, a licensed agent. ${randomUUID()}

2
00:00:04.500 --> 00:00:06.000
Customer: Hi Dana.`;
    const res = await request(app)
      .post("/api/call-scoring/transcripts")
      .set(withAuth(admin.id))
      .field("externalRef", "REC-1001")
      .attach("file", Buffer.from(vtt), "Jane Roe 2025-03-01.vtt");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.timing).toBe("recorded");
    const [row] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, res.body.transcriptId));
    expect(row!.format).toBe("vtt");
    expect(row!.externalRef).toBe("REC-1001");
    expect(JSON.stringify(row)).not.toContain("Jane Roe");
    const detail = await request(app).get(`/api/call-scoring/transcripts/${res.body.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(detail.body.transcript.filename).toBe("Jane Roe 2025-03-01.vtt");
  });

  it("with no speaker labels, says so and treats every speaker as unknown", async () => {
    const t = await createScored(`Hello thanks for calling\nHi I have a question ${randomUUID()}\nSure go ahead`);
    expect(t.notes.map((n) => n.code)).toContain("speakers_unlabelled");
    const detail = await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(detail.body.transcript.speakerMode).toBe("unlabelled");
    expect(detail.body.utterances.every((u: { role: string }) => u.role === "unknown")).toBe(true);
  });

  it("flags a missing disclaimer as a critical failure", async () => {
    const t = await createScored(`Agent: Hi this is Sam, let me tell you about a great plan. ${randomUUID()}\nCustomer: Okay.`);
    expect(t.compliance).toBe("fail");
  });

  it("recognises the same speech as a duplicate", async () => {
    const text = transcriptText();
    const first = await createScored(text);
    const again = await post(admin.id, { text });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("duplicate");
    expect(again.body.transcriptId).toBe(first.transcriptId);
  });

  it("uses the general rubric when asked and rejects an unknown rubric", async () => {
    const ok = await post(admin.id, { text: transcriptText(), rubricId: "general-sales" });
    expect(ok.status).toBe(201);
    expect(ok.body.rubric.id).toBe("general-sales");
    await post(admin.id, { text: transcriptText(), rubricId: "nope" }).expect(400);
  });
});

describe("upload limits and bad files", () => {
  it("rejects a file over the size limit", async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, "a");
    const res = await request(app).post("/api/call-scoring/transcripts").set(withAuth(admin.id)).attach("file", big, "big.txt");
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("file_too_large");
  });

  it("rejects audio with a clear not-set-up message and creates nothing", async () => {
    const before = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.orgId, org.id));
    const res = await request(app).post("/api/call-scoring/transcripts").set(withAuth(admin.id)).attach("file", Buffer.from("ID3fakeaudio"), "call.mp3");
    expect(res.status).toBe(415);
    expect(res.body.code).toBe("audio_transcription_not_set_up");
    expect(res.body.error).toMatch(/not set up/i);
    const after = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.orgId, org.id));
    expect(after.length).toBe(before.length);
  });

  it("rejects unsupported types, empty, binary and unreadable content, with safe messages", async () => {
    await request(app).post("/api/call-scoring/transcripts").set(withAuth(admin.id)).attach("file", Buffer.from("%PDF-1.4"), "x.pdf").expect(415);
    await request(app).post("/api/call-scoring/transcripts").set(withAuth(admin.id)).attach("file", Buffer.from("   \n"), "empty.txt").expect(400);
    await request(app).post("/api/call-scoring/transcripts").set(withAuth(admin.id)).attach("file", Buffer.from("abc\u0000def"), "bin.txt").expect(400);
    const bad = await request(app).post("/api/call-scoring/transcripts").set(withAuth(admin.id)).attach("file", Buffer.from("{secret client words"), "bad.json");
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("secret");
    await post(admin.id, {}).expect(400);
    await post(admin.id, { text: "x".repeat(500_001) }).expect(413);
    await post(admin.id, { text: transcriptText(), phone: "12" }).expect(400);
    await post(admin.id, { text: transcriptText(), callDate: "not a date" }).expect(400);
  });
});

describe("linking to a client", () => {
  it("links by explicit contact id, but never to another org's contact", async () => {
    const ok = await createScored(transcriptText(), { contactId: contactUnique.id });
    expect(ok.contact).toEqual({ id: contactUnique.id, match: "explicit" });
    const bad = await post(admin.id, { text: transcriptText(), contactId: otherOrgContact.id });
    expect(bad.status).toBe(404);
  });

  it("links by phone only when exactly one client in the org has that number", async () => {
    // The other org has a contact with the same number: it must not count.
    const unique = await createScored(transcriptText(), { phone: "(310) 555-0111" });
    expect(unique.contact).toEqual({ id: contactUnique.id, match: "phone_unique" });

    const ambiguous = await createScored(transcriptText(), { phone: PHONE_DUP });
    expect(ambiguous.contact).toEqual({ id: null, match: "phone_ambiguous" });
    expect(ambiguous.notes.map((n) => n.code)).toContain("contact_ambiguous");

    const none = await createScored(transcriptText(), { phone: "+13105559999" });
    expect(none.contact).toEqual({ id: null, match: "none" });
  });

  it("takes the agent and client from a call session in this org, and rejects a foreign one", async () => {
    const t = await createScored(transcriptText(), { callSessionId: ownSession.id });
    const [row] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, t.transcriptId));
    expect(row!.callSessionId).toBe(ownSession.id);
    expect(row!.agentId).toBe(agentProfile.id);
    await post(admin.id, { text: transcriptText(), callSessionId: "does-not-exist" }).expect(404);
    await post(admin.id, { text: transcriptText(), agentId: "nope" }).expect(404);
  });
});

describe("reading: org scoping and agent scoping", () => {
  it("another org sees nothing and gets 404 on detail, rescore, override and finding actions", async () => {
    const t = await createScored(transcriptText(["Customer: Stop calling me."]));
    await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(otherAdmin.id)).expect(404);
    await request(app).post(`/api/call-scoring/transcripts/${t.transcriptId}/rescore`).set(withAuth(otherAdmin.id)).send({}).expect(404);
    await request(app).patch(`/api/call-scoring/transcripts/${t.transcriptId}/criteria/rapport`).set(withAuth(otherAdmin.id)).send({ verdict: "pass", note: "nope nope" }).expect(404);
    const list = await request(app).get("/api/call-scoring/transcripts").set(withAuth(otherAdmin.id)).expect(200);
    expect(list.body.items).toHaveLength(0);
    const queue = await request(app).get("/api/call-scoring/dnc-review").set(withAuth(otherAdmin.id)).expect(200);
    expect(queue.body.items).toHaveLength(0);
    const [finding] = await handle.db
      .select()
      .from(schema.callScoreFindingsTable)
      .where(and(eq(schema.callScoreFindingsTable.transcriptId, t.transcriptId), eq(schema.callScoreFindingsTable.kind, "dnc")));
    await request(app).post(`/api/call-scoring/dnc-review/${finding!.id}/resolve`).set(withAuth(otherAdmin.id)).send({ action: "dismiss", note: "not mine" }).expect(404);
    const summary = await request(app).get("/api/call-scoring/summary").set(withAuth(otherAdmin.id)).expect(200);
    expect(summary.body.totals.total).toBe(0);
  });

  it("an agent sees only calls linked to a session they placed", async () => {
    const own = await createScored(transcriptText(), { callSessionId: ownSession.id });
    const theirs = await createScored(transcriptText(), { callSessionId: otherSession.id });
    const unlinked = await createScored(transcriptText());

    const list = await request(app).get("/api/call-scoring/transcripts?limit=100").set(withAuth(agentUser.id)).expect(200);
    const ids = list.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(own.transcriptId);
    expect(ids).not.toContain(theirs.transcriptId);
    expect(ids).not.toContain(unlinked.transcriptId);

    await request(app).get(`/api/call-scoring/transcripts/${own.transcriptId}`).set(withAuth(agentUser.id)).expect(200);
    await request(app).get(`/api/call-scoring/transcripts/${theirs.transcriptId}`).set(withAuth(agentUser.id)).expect(404);
    await request(app).get(`/api/call-scoring/transcripts/${unlinked.transcriptId}`).set(withAuth(agentUser.id)).expect(404);

    const sum = await request(app).get("/api/call-scoring/summary").set(withAuth(agentUser.id)).expect(200);
    const adminSum = await request(app).get("/api/call-scoring/summary").set(withAuth(admin.id)).expect(200);
    expect(sum.body.totals.total).toBeLessThan(adminSum.body.totals.total);
    expect(sum.body.totals.total).toBeGreaterThanOrEqual(1);
  });

  it("detail shows every finding with its quote, speaker and exact position, plus the utterances to jump to", async () => {
    const text = transcriptText(["Agent: Honestly this is the best plan out there."]);
    const t = await createScored(text);
    const d = await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(d.body.disclaimer).toMatch(/not legal advice/i);
    const sup = d.body.criteria.find((c: { criterionId: string }) => c.criterionId === "no_superlatives");
    expect(sup.status).toBe("fail");
    expect(sup.citation).toContain("422.2262");
    const ev = sup.evidence[0];
    expect(ev.quote).toMatch(/best plan/i);
    expect(ev.speaker).toBe("agent");
    const u = d.body.utterances[ev.utteranceIndex];
    expect(u.text.slice(ev.startOffset, ev.endOffset)).toBe(ev.quote);
    expect(typeof ev.startSeconds).toBe("number");
    expect(d.body.score.effective.compliance).toBeDefined();
    expect(d.body.score.auto.compliance).toBe(d.body.score.effective.compliance);
    const tpmo = d.body.criteria.find((c: { criterionId: string }) => c.criterionId === "tpmo_disclaimer");
    expect(tpmo.status).toBe("pass");
    expect(tpmo.evidence.length).toBeGreaterThanOrEqual(3);
  });

  it("lists with filters", async () => {
    const t = await createScored(transcriptText(), { contactId: contactUnique.id, agentId: agentProfile.id });
    const byContact = await request(app).get(`/api/call-scoring/transcripts?contactId=${contactUnique.id}&limit=100`).set(withAuth(admin.id)).expect(200);
    expect(byContact.body.items.map((i: { id: string }) => i.id)).toContain(t.transcriptId);
    expect(byContact.body.items.every((i: { contact: { id: string } }) => i.contact.id === contactUnique.id)).toBe(true);
    const item = byContact.body.items.find((i: { id: string }) => i.id === t.transcriptId);
    expect(item.agent.name).toBe("Dana Brooks");
    const failing = await request(app).get("/api/call-scoring/transcripts?compliance=fail&limit=100").set(withAuth(admin.id)).expect(200);
    expect(failing.body.items.every((i: { compliance: string }) => i.compliance === "fail")).toBe(true);
    await request(app).get("/api/call-scoring/transcripts?compliance=bogus").set(withAuth(admin.id)).expect(400);
    await request(app).get("/api/call-scoring/transcripts?limit=1000").set(withAuth(admin.id)).expect(400);
  });
});

describe("human review keeps the automatic result immutable", () => {
  it("an override changes the effective result but never the stored automatic one", async () => {
    const t = await createScored(transcriptText(["Agent: Honestly this is the best plan out there."]));
    const scoreBefore = (await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.id, t.scoreId)))[0]!;
    const findingsBefore = await handle.db.select().from(schema.callScoreFindingsTable).where(eq(schema.callScoreFindingsTable.scoreId, t.scoreId));

    // A note is required (unless reverting).
    await request(app).patch(`/api/call-scoring/transcripts/${t.transcriptId}/criteria/no_superlatives`).set(withAuth(admin.id)).send({ verdict: "pass" }).expect(400);
    await request(app).patch(`/api/call-scoring/transcripts/${t.transcriptId}/criteria/not_a_criterion`).set(withAuth(admin.id)).send({ verdict: "pass", note: "fine by me" }).expect(404);

    const res = await request(app)
      .patch(`/api/call-scoring/transcripts/${t.transcriptId}/criteria/no_superlatives`)
      .set(withAuth(compliance.id))
      .send({ verdict: "pass", note: "Quoted from an approved script." })
      .expect(200);
    const crit = res.body.criteria.find((c: { criterionId: string }) => c.criterionId === "no_superlatives");
    expect(crit.status).toBe("pass");
    expect(crit.autoStatus).toBe("fail");
    expect(crit.human).toMatchObject({ verdict: "pass", note: "Quoted from an approved script.", reviewerName: "Casey Compliance", reviewerRole: "compliance_manager" });
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.score.effective.score).toBeGreaterThan(res.body.score.auto.score);

    // Stored automatic result is byte-for-byte unchanged.
    const scoreAfter = (await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.id, t.scoreId)))[0]!;
    expect(scoreAfter).toEqual(scoreBefore);
    const findingsAfter = await handle.db.select().from(schema.callScoreFindingsTable).where(eq(schema.callScoreFindingsTable.scoreId, t.scoreId));
    expect(findingsAfter.map((f) => [f.id, f.verdict])).toEqual(findingsBefore.map((f) => [f.id, f.verdict]));

    // The note is stored encrypted and never copied to the audit log.
    const [rev] = await handle.db.select().from(schema.callScoreReviewsTable).where(eq(schema.callScoreReviewsTable.transcriptId, t.transcriptId));
    expect(Buffer.from(rev!.noteEncrypted!).toString("latin1")).not.toContain("approved script");
    await settle();
    const audits = await handle.db.select().from(schema.auditLogTable).where(and(eq(schema.auditLogTable.resourceId, t.transcriptId), eq(schema.auditLogTable.action, "call_score_override")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.changes)).not.toContain("approved script");

    // Revert restores the automatic grade in the effective view.
    const reverted = await request(app).patch(`/api/call-scoring/transcripts/${t.transcriptId}/criteria/no_superlatives`).set(withAuth(admin.id)).send({ verdict: "revert" }).expect(200);
    expect(reverted.body.criteria.find((c: { criterionId: string }) => c.criterionId === "no_superlatives").status).toBe("fail");
    expect(reverted.body.reviews).toHaveLength(2);
  });

  it("the database refuses to edit a stored score or finding, and review history is append-only", async () => {
    const t = await createScored(transcriptText());
    await expect(handle.pg.exec(`UPDATE call_scores SET score = 1 WHERE id = '${t.scoreId}'`)).rejects.toThrow(/immutable/);
    await expect(handle.pg.exec(`UPDATE call_score_findings SET verdict = 'pass' WHERE score_id = '${t.scoreId}'`)).rejects.toThrow(/immutable/);
    await request(app)
      .patch(`/api/call-scoring/transcripts/${t.transcriptId}/criteria/rapport`)
      .set(withAuth(admin.id))
      .send({ verdict: "pass", note: "Warm and patient." })
      .expect(200);
    await expect(handle.pg.exec(`UPDATE call_score_reviews SET verdict = 'fail' WHERE transcript_id = '${t.transcriptId}'`)).rejects.toThrow(/immutable/);
  });

  it("a human grade on an unreviewed critical item moves the call out of 'review'", async () => {
    const text = [
      "Agent: Thank you for calling, my name is Dana Brooks and I'm a licensed insurance agent.",
      "Agent: This call is being recorded.",
      "Agent: We do not offer every plan available in your area. Currently we represent 7 organizations which offer 42 products in your area. Please contact Medicare.gov or 1-800-MEDICARE.",
      "Agent: Before we look at plans I need to confirm the scope of appointment.",
      `Customer: Okay ${randomUUID()}.`,
    ].join("\n");
    const t = await createScored(text);
    expect(t.compliance).toBe("review"); // informed_enrollment (critical) is ungraded without AI
    const res = await request(app)
      .patch(`/api/call-scoring/transcripts/${t.transcriptId}/criteria/informed_enrollment`)
      .set(withAuth(admin.id))
      .send({ verdict: "na", note: "No enrollment was taken on this call." })
      .expect(200);
    expect(res.body.score.auto.compliance).toBe("review");
    expect(res.body.score.effective.compliance).toBe("pass");
    const list = await request(app).get("/api/call-scoring/transcripts?limit=100").set(withAuth(admin.id)).expect(200);
    const item = list.body.items.find((i: { id: string }) => i.id === t.transcriptId);
    expect(item.compliance).toBe("pass");
    expect(item.autoCompliance).toBe("review");
    expect(item.reviewed).toBe(true);
  });

  it("rescoring adds a new automatic result and keeps the earlier one as history", async () => {
    const t = await createScored(transcriptText());
    const again = await request(app).post(`/api/call-scoring/transcripts/${t.transcriptId}/rescore`).set(withAuth(admin.id)).send({ rubricId: "general-sales" }).expect(201);
    expect(again.body.scoreId).not.toBe(t.scoreId);
    const scores = await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.transcriptId, t.transcriptId));
    expect(scores).toHaveLength(2);
    const d = await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(d.body.score.id).toBe(again.body.scoreId);
    expect(d.body.score.rubric.id).toBe("general-sales");
    expect(d.body.previousScores.map((s: { id: string }) => s.id)).toEqual([t.scoreId]);
  });

  it("summarises by agent and by rubric from real rows", async () => {
    await createScored(transcriptText(), { agentId: agentProfile.id });
    const res = await request(app).get("/api/call-scoring/summary").set(withAuth(admin.id)).expect(200);
    expect(res.body.totals.total).toBe(res.body.totals.pass + res.body.totals.fail + res.body.totals.review);
    const dana = res.body.byAgent.find((a: { agentId: string | null }) => a.agentId === agentProfile.id);
    expect(dana.name).toBe("Dana Brooks");
    expect(dana.total).toBeGreaterThanOrEqual(1);
    expect(res.body.byRubric.find((r: { rubricId: string }) => r.rubricId === "medicare-tpmo")).toBeTruthy();
    expect(res.body.disclaimer).toMatch(/not a compliance certification/i);
  });
});

describe("audit trail", () => {
  it("logs create and PHI reads without any transcript text, phone or filename", async () => {
    const text = transcriptText(["Customer: My cell is 310-555-0177 and I am Jane Roe."]);
    const t = await createScored(text, { phone: "+13105550177" });
    await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(admin.id)).expect(200);
    await settle();
    const rows = await handle.db.select().from(schema.auditLogTable).where(eq(schema.auditLogTable.resourceId, t.transcriptId));
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["create", "read"]));
    const dump = JSON.stringify(rows);
    for (const secret of ["Sunrise", "Jane Roe", "310-555-0177", "3105550177", "Nice weather"]) expect(dump).not.toContain(secret);
    expect(rows.find((r) => r.action === "read")!.resourceType).toBe("call_scoring");
    expect(rows.find((r) => r.action === "create")!.resourceType).toBe("call_transcript");
  });
});

describe("do-not-contact review", () => {
  async function dncTranscript(extra: Record<string, unknown> = {}, line = "Customer: Please stop calling me.") {
    const t = await createScored(transcriptText([line]), extra);
    const [finding] = await handle.db
      .select()
      .from(schema.callScoreFindingsTable)
      .where(and(eq(schema.callScoreFindingsTable.transcriptId, t.transcriptId), eq(schema.callScoreFindingsTable.kind, "dnc")));
    return { ...t, findingId: finding!.id };
  }
  const resolve = (userId: string, findingId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/call-scoring/dnc-review/${findingId}/resolve`).set(withAuth(userId)).send(body);
  const optOutsFor = async (phone: string) =>
    (await handle.db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id))).filter((o) => o.phone === phone);
  const dncAudits = async (transcriptId: string) => {
    await settle();
    return (await handle.db.select().from(schema.auditLogTable).where(eq(schema.auditLogTable.resourceId, transcriptId))).filter((r) => r.action.startsWith("call_dnc_"));
  };

  it("raises a possible request with the exact quote and NEVER applies an opt-out by itself", async () => {
    const before = await handle.db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id));
    const t = await dncTranscript({ contactId: contactUnique.id });
    expect(t.dncFlagCount).toBe(1);
    expect(t.compliance).not.toBe("pass");
    const after = await handle.db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id));
    expect(after.length).toBe(before.length);
    const [c] = await handle.db.select().from(schema.contactsTable).where(eq(schema.contactsTable.id, contactUnique.id));
    expect(c!.optOutSms).toBe(false);

    const q = await request(app).get("/api/call-scoring/dnc-review").set(withAuth(admin.id)).expect(200);
    const item = q.body.items.find((i: { findingId: string }) => i.findingId === t.findingId);
    expect(item.quote).toBe("Please stop calling me.");
    expect(item.speaker).toBe("client");
    expect(item.status).toBe("open");
    expect(item.contact.name).toBe("Uma Unique");
    expect(q.body.note).toMatch(/until a person confirms/i);

    const detail = await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(detail.body.dnc[0]).toMatchObject({ status: "open", quote: "Please stop calling me.", speaker: "client" });
    expect(detail.body.score.effective.openDnc).toBe(1);
  });

  it("does not raise anything for the agent's words or a negated phrase", async () => {
    const t = await createScored(
      transcriptText(["Agent: If you ever want us to stop calling, just say so.", "Customer: I'd never say stop calling, you are lovely."]),
    );
    expect(t.dncFlagCount).toBe(0);
  });

  it("add_opt_out records exactly one opt-out and one audit row, and is idempotent", async () => {
    const t = await dncTranscript({ contactId: contactUnique.id, phone: PHONE_UNIQUE });
    const first = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "transcript", note: "Confirmed on the recording." });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ status: "resolved", action: "add_opt_out" });

    const rows = await optOutsFor(PHONE_UNIQUE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("call_review");
    const [c] = await handle.db.select().from(schema.contactsTable).where(eq(schema.contactsTable.id, contactUnique.id));
    expect(c!.optOutSms).toBe(true);

    const audits1 = await dncAudits(t.transcriptId);
    expect(audits1.filter((a) => a.action === "call_dnc_opt_out")).toHaveLength(1);
    expect(adminPool.map((a) => a.id)).toContain(audits1[0]!.userId);
    const dump = JSON.stringify(audits1);
    expect(dump).not.toContain("stop calling");
    expect(dump).not.toContain("3105550111");
    expect(dump).not.toContain("recording");

    // Second click: same answer, no second opt-out, no second audit row.
    const second = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "transcript" });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("already_resolved");
    expect(await optOutsFor(PHONE_UNIQUE)).toHaveLength(1);
    expect((await dncAudits(t.transcriptId)).filter((a) => a.action === "call_dnc_opt_out")).toHaveLength(1);

    // A different decision after the fact is refused.
    const flip = await resolve(admin.id, t.findingId, { action: "dismiss", note: "changed my mind" });
    expect(flip.status).toBe(409);

    // Resolved items leave the open queue; effective compliance no longer counts it.
    const open = await request(app).get("/api/call-scoring/dnc-review").set(withAuth(admin.id)).expect(200);
    expect(open.body.items.map((i: { findingId: string }) => i.findingId)).not.toContain(t.findingId);
    const resolved = await request(app).get("/api/call-scoring/dnc-review?status=resolved").set(withAuth(admin.id)).expect(200);
    const done = resolved.body.items.find((i: { findingId: string }) => i.findingId === t.findingId);
    expect(done.status).toBe("opt_out_added");
    expect(done.resolution.reviewerName).toBe("Alex Admin");
    expect(done.resolution.note).toBe("Confirmed on the recording.");
    const detail = await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(detail.body.score.effective.openDnc).toBe(0);
  });

  it("two reviewers clicking at once still produce exactly one opt-out and one audit row", async () => {
    const phone = "+13105550133";
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "Race", lastName: "Condition" });
    await setPhone(c.id, phone);
    const t = await dncTranscript({ contactId: c.id });
    const [a, b] = await Promise.all([
      resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "contact" }),
      resolve(compliance.id, t.findingId, { action: "add_opt_out", phoneSource: "contact" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.status, b.body.status].sort()).toEqual(["already_resolved", "resolved"]);
    expect(await optOutsFor(phone)).toHaveLength(1);
    expect((await dncAudits(t.transcriptId)).filter((x) => x.action === "call_dnc_opt_out")).toHaveLength(1);
  });

  it("works by phone number alone when no client is linked", async () => {
    const t = await dncTranscript({ phone: "+13105550144" });
    const res = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "transcript" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.optOut).toMatchObject({ phonesRecorded: 1, contactId: null });
    expect(await optOutsFor("+13105550144")).toHaveLength(1);
  });

  it("needs a contact or a phone", async () => {
    const t = await dncTranscript();
    const res = await resolve(admin.id, t.findingId, { action: "add_opt_out" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("phone_required");
    // A typed number works.
    const ok = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "typed", phone: "(310) 555-0155" });
    expect(ok.status).toBe(200);
    expect(await optOutsFor("+13105550155")).toHaveLength(1);
  });

  it("makes the reviewer pick when the phone matches several clients, and then records it on the transcript", async () => {
    const t = await dncTranscript({ phone: PHONE_DUP });
    const q = await request(app).get("/api/call-scoring/dnc-review").set(withAuth(admin.id)).expect(200);
    const item = q.body.items.find((i: { findingId: string }) => i.findingId === t.findingId);
    expect(item.contactMatch).toBe("phone_ambiguous");
    expect(item.candidates.map((c: { id: string }) => c.id).sort()).toEqual([contactDupA.id, contactDupB.id].sort());
    expect(item.contact).toBeNull();

    const refused = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "transcript" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("pick_contact");
    expect(refused.body.candidates).toHaveLength(2);
    expect(await optOutsFor(PHONE_DUP)).toHaveLength(0);

    const bad = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "transcript", contactId: otherOrgContact.id });
    expect(bad.status).toBe(404);

    const picked = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "transcript", contactId: contactDupA.id });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    expect(await optOutsFor(PHONE_DUP)).toHaveLength(1);
    const [row] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, t.transcriptId));
    expect(row!.contactId).toBe(contactDupA.id);
    expect(row!.contactMatch).toBe("explicit");
  });

  it("dismiss needs a note, records it, and adds no opt-out", async () => {
    const t = await dncTranscript({ phone: "+13105550166" });
    const noNote = await resolve(admin.id, t.findingId, { action: "dismiss" });
    expect(noNote.status).toBe(400);
    expect(noNote.body.code).toBe("note_required");
    const ok = await resolve(admin.id, t.findingId, { action: "dismiss", note: "Client was joking about a neighbour." });
    expect(ok.status).toBe(200);
    expect(await optOutsFor("+13105550166")).toHaveLength(0);
    const audits = await dncAudits(t.transcriptId);
    expect(audits.filter((a) => a.action === "call_dnc_dismiss")).toHaveLength(1);
    expect(audits.filter((a) => a.action === "call_dnc_opt_out")).toHaveLength(0);
    expect(JSON.stringify(audits)).not.toContain("joking");
    const again = await resolve(admin.id, t.findingId, { action: "dismiss", note: "again" });
    expect(again.body.status).toBe("already_resolved");
  });

  it("a rescore does not re-open a resolved request", async () => {
    const t = await dncTranscript({ phone: "+13105550188" });
    await resolve(admin.id, t.findingId, { action: "dismiss", note: "Not a request." }).expect(200);
    await request(app).post(`/api/call-scoring/transcripts/${t.transcriptId}/rescore`).set(withAuth(admin.id)).send({}).expect(201);
    const q = await request(app).get("/api/call-scoring/dnc-review?limit=200").set(withAuth(admin.id)).expect(200);
    expect(q.body.items.filter((i: { transcriptId: string }) => i.transcriptId === t.transcriptId)).toHaveLength(0);
    const all = await request(app).get("/api/call-scoring/dnc-review?status=all&limit=200").set(withAuth(admin.id)).expect(200);
    const mine = all.body.items.filter((i: { transcriptId: string }) => i.transcriptId === t.transcriptId);
    expect(mine).toHaveLength(1); // only the current score's flag
    expect(mine[0].status).toBe("dismissed");
  });

  it("validates the action and the finding id", async () => {
    const t = await dncTranscript({ phone: "+13105550199" });
    await resolve(admin.id, t.findingId, { action: "delete_everything" }).expect(400);
    await resolve(admin.id, "no-such-finding", { action: "dismiss", note: "whatever" }).expect(404);
    // A non-DNC finding id is not resolvable through this endpoint.
    const [other] = await handle.db
      .select()
      .from(schema.callScoreFindingsTable)
      .where(and(eq(schema.callScoreFindingsTable.transcriptId, t.transcriptId), eq(schema.callScoreFindingsTable.kind, "required")));
    await resolve(admin.id, other!.id, { action: "dismiss", note: "whatever" }).expect(404);
  });
});

describe("review fixes: confirming exactly one number", () => {
  async function dnc(extra: Record<string, unknown>) {
    const t = await createScored(transcriptText(["Customer: Do not call me again."]), extra);
    const [finding] = await handle.db
      .select()
      .from(schema.callScoreFindingsTable)
      .where(and(eq(schema.callScoreFindingsTable.transcriptId, t.transcriptId), eq(schema.callScoreFindingsTable.kind, "dnc")));
    return { ...t, findingId: finding!.id };
  }
  const resolve = (userId: string, findingId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/call-scoring/dnc-review/${findingId}/resolve`).set(withAuth(userId)).send(body);
  const optOuts = async (phone: string) =>
    (await handle.db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id))).filter((o) => o.phone === phone);
  const reviewRows = (transcriptId: string) =>
    handle.db.select().from(schema.callScoreReviewsTable).where(eq(schema.callScoreReviewsTable.transcriptId, transcriptId));

  it("refuses to add an opt-out until the reviewer says which number", async () => {
    const t = await dnc({ phone: "+13105550210" });
    const res = await resolve(admin.id, t.findingId, { action: "add_opt_out" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("phone_required");
    expect(await optOuts("+13105550210")).toHaveLength(0);
    // "contact" with no contact on the call, and "typed" with no number, are refused too.
    expect((await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "contact" })).status).toBe(400);
    expect((await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "typed" })).status).toBe(400);
  });

  it("records only the confirmed number, and attaches the contact only if it owns that number", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "Two", lastName: "Numbers" });
    await setPhone(c.id, "(310) 555-0201");
    const t = await dnc({ contactId: c.id, phone: "+13105550202" }); // the call's number is NOT the contact's number

    const q = await request(app).get("/api/call-scoring/dnc-review?limit=200").set(withAuth(admin.id)).expect(200);
    const item = q.body.items.find((i: { findingId: string }) => i.findingId === t.findingId);
    expect(item.numbers).toEqual([
      { source: "transcript", last4: "0202" },
      { source: "contact", last4: "0201" },
    ]);
    expect(JSON.stringify(item)).not.toContain("3105550202");
    expect(JSON.stringify(item)).not.toContain("3105550201");

    const res = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "transcript" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.optOut).toMatchObject({ phonesRecorded: 1, contactId: null });
    expect(await optOuts("+13105550202")).toHaveLength(1);
    expect(await optOuts("+13105550201")).toHaveLength(0);
    const [contactRow] = await handle.db.select().from(schema.contactsTable).where(eq(schema.contactsTable.id, c.id));
    expect(contactRow!.optOutSms).toBe(false);
    const [review] = await reviewRows(t.transcriptId);
    expect(review!.contactId).toBeNull();
    const [tr] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, t.transcriptId));
    expect(tr!.contactId).toBe(c.id); // the link the uploader made is left alone
  });

  it("choosing the contact's own number records that number and attaches the contact", async () => {
    const c = await seedContact(handle.db, { orgId: org.id, firstName: "Own", lastName: "Number" });
    await setPhone(c.id, "(310) 555-0203");
    const t = await dnc({ contactId: c.id, phone: "+13105550204" });
    const res = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "contact" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.optOut).toMatchObject({ phonesRecorded: 1, contactId: c.id });
    expect(await optOuts("+13105550203")).toHaveLength(1);
    expect(await optOuts("+13105550204")).toHaveLength(0);
    const [contactRow] = await handle.db.select().from(schema.contactsTable).where(eq(schema.contactsTable.id, c.id));
    expect(contactRow!.optOutSms).toBe(true);
  });

  it("a typed number is the only one recorded", async () => {
    const t = await dnc({ phone: "+13105550205" });
    const res = await resolve(admin.id, t.findingId, { action: "add_opt_out", phoneSource: "typed", phone: "(310) 555-0206" });
    expect(res.status).toBe(200);
    expect(await optOuts("+13105550206")).toHaveLength(1);
    expect(await optOuts("+13105550205")).toHaveLength(0);
  });
});

describe("review fixes: agent access is by user, not by shared licensed profile", () => {
  it("an agent cannot read a transcript from a call another USER placed under the same agent profile", async () => {
    const id = `cs-shared-${randomUUID()}`;
    await handle.db
      .insert(schema.callSessionsTable)
      .values({ id, orgId: org.id, userId: otherAgentUser.id, agentId: agentProfile.id, toNumber: PHONE_UNIQUE, status: "completed" });
    const t = await createScored(transcriptText(), { callSessionId: id });
    await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(agentUser.id)).expect(404);
    const list = await request(app).get("/api/call-scoring/transcripts?limit=100").set(withAuth(agentUser.id)).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(t.transcriptId);
    // The user who did place it can read it.
    await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(otherAgentUser.id)).expect(200);
  });
});

describe("review fixes: keyed digest dedup", () => {
  it("does not collapse two calls that differ only in a masked value", async () => {
    const shared = randomUUID();
    const one = await post(admin.id, { text: `Agent: Please confirm your number.\nCustomer: It is 310-555-0101 ${shared}` });
    const two = await post(admin.id, { text: `Agent: Please confirm your number.\nCustomer: It is 310-555-0102 ${shared}` });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    expect(two.body.transcriptId).not.toBe(one.body.transcriptId);
  });

  it("two concurrent uploads of the same call produce exactly one transcript and one duplicate answer", async () => {
    const ref = `dup-${randomUUID()}`;
    const text = transcriptText();
    const [a, b, c] = await Promise.all([
      post(admin.id, { text, externalRef: ref }),
      post(admin.id, { text, externalRef: ref }),
      post(admin.id, { text, externalRef: ref }),
    ]);
    const statuses = [a.status, b.status, c.status].sort();
    expect(statuses, JSON.stringify([a.body, b.body, c.body])).toEqual([201, 409, 409]);
    const rows = (await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.orgId, org.id))).filter((r) => r.externalRef === ref);
    expect(rows).toHaveLength(1);
    const winner = [a, b, c].find((r) => r.status === 201)!;
    for (const loser of [a, b, c].filter((r) => r.status === 409)) {
      expect(loser.body.code).toBe("duplicate");
      expect(loser.body.transcriptId).toBe(winner.body.transcriptId);
    }
    // One score, one audit "create" row.
    const scores = await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.transcriptId, rows[0]!.id));
    expect(scores).toHaveLength(1);
  });

  it("the same speech is a duplicate in one org but not across orgs", async () => {
    const text = transcriptText();
    await createScored(text);
    const otherOrgAdmin = otherAdmin;
    const res = await post(otherOrgAdmin.id, { text });
    expect(res.status).toBe(201);
  });

  it("stores no plaintext phone column", async () => {
    const [row] = await handle.db.select().from(schema.callTranscriptsTable).limit(1);
    expect(Object.keys(row!)).not.toContain("phoneLast10");
  });
});

describe("review fixes: filters apply before the cap", () => {
  it("finds an old match hidden behind many newer non-matches, with a correct total", async () => {
    const capOrg = await seedOrg(handle.db, { id: `cs-cap-${randomUUID().slice(0, 8)}` });
    const capAdmin = await seedUser(handle.db, { orgId: capOrg.id, role: "agency_admin" });
    // Oldest: one general-sales call with a possible do-not-contact request.
    await createScored(`Agent: Hi this is Sam from Acme.\nCustomer: Stop calling me. ${randomUUID()}`, { rubricId: "general-sales" }, capAdmin.id);
    for (let i = 0; i < 5; i++) await createScored(transcriptText(), {}, capAdmin.id);

    const base = { orgId: capOrg.id, limit: 50, offset: 0, cap: 2, batch: 2 };
    const byRubric = await detailLib.buildList({ ...base, rubricId: "general-sales" });
    expect(byRubric.total).toBe(1);
    expect(byRubric.items).toHaveLength(1);
    expect(byRubric.truncated).toBe(false);

    const byDnc = await detailLib.buildList({ ...base, dnc: "open" });
    expect(byDnc.total).toBe(1);
    expect(byDnc.items[0]!.openDnc).toBe(1);

    // Unfiltered, the cap applies to matching rows and says so.
    const all = await detailLib.buildList(base);
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(2);
    expect(all.truncated).toBe(true);

    // With room, everything is there and nothing is marked truncated.
    const roomy = await detailLib.buildList({ ...base, cap: 100, batch: 2 });
    expect(roomy.total).toBe(6);
    expect(roomy.truncated).toBe(false);
    // Paging over the filtered set.
    const page2 = await detailLib.buildList({ ...base, cap: 100, limit: 4, offset: 4 });
    expect(page2.items).toHaveLength(2);
    expect(page2.total).toBe(6);
  });
});

describe("review fixes: many contacts sharing a number", () => {
  it("returns up to the bound, says there are more, and lets the reviewer pick one beyond the list", async () => {
    const phone = "(310) 555-0300";
    const ids: string[] = [];
    for (let i = 0; i < storeLib.MAX_PHONE_CANDIDATES + 2; i++) {
      const c = await seedContact(handle.db, { orgId: org.id, firstName: `Shared${i}`, lastName: "Number" });
      await setPhone(c.id, phone);
      ids.push(c.id);
    }
    const m = await storeLib.matchContactByPhone(handle.db as never, org.id, phone);
    expect(m.match).toBe("phone_ambiguous");
    expect(m.candidateIds).toHaveLength(storeLib.MAX_PHONE_CANDIDATES);
    expect(m.moreCandidates).toBe(true);

    const t = await createScored(transcriptText(["Customer: Please remove my number."]), { phone: "+13105550300" });
    const q = await request(app).get("/api/call-scoring/dnc-review?limit=200").set(withAuth(admin.id)).expect(200);
    const [finding] = await handle.db
      .select()
      .from(schema.callScoreFindingsTable)
      .where(and(eq(schema.callScoreFindingsTable.transcriptId, t.transcriptId), eq(schema.callScoreFindingsTable.kind, "dnc")));
    const item = q.body.items.find((i: { findingId: string }) => i.findingId === finding!.id);
    expect(item.candidates).toHaveLength(storeLib.MAX_PHONE_CANDIDATES);
    expect(item.moreCandidates).toBe(true);

    const listed = new Set(item.candidates.map((c: { id: string }) => c.id));
    const beyond = ids.find((id) => !listed.has(id))!;
    const res = await request(app)
      .post(`/api/call-scoring/dnc-review/${finding!.id}/resolve`)
      .set(withAuth(admin.id))
      .send({ action: "add_opt_out", phoneSource: "transcript", contactId: beyond });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.optOut.contactId).toBe(beyond);
  });
});

describe("review fixes: the do-not-contact queue is batched", () => {
  it("runs a fixed number of queries however many items are on the page", async () => {
    for (let i = 0; i < 4; i++) await createScored(transcriptText(["Customer: Stop calling me."]), { contactId: contactUnique.id, agentId: agentProfile.id });
    let selects = 0;
    const counting = new Proxy(handle.db as object, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === "select" || prop === "selectDistinct") selects++;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const page = await dncLib.listDncQueue(counting as never, { orgId: org.id, status: "open", limit: 50, offset: 0 });
    expect(page.items.length).toBeGreaterThanOrEqual(5);
    // count + page + resolutions + contacts + agents + ambiguous matches: never per item.
    expect(selects).toBeLessThanOrEqual(7);
    const one = await dncLib.listDncQueue(counting as never, { orgId: org.id, status: "open", limit: 1, offset: 0 });
    expect(one.items).toHaveLength(1);
  });
});

describe("review fixes: assembleEffective is linear", () => {
  it("handles thousands of scores with their criteria, reviews and flags quickly and correctly", () => {
    const N = 3000;
    const scores: Array<{ id: string; transcriptId: string }> = [];
    const lite: LiteCriterion[] = [];
    const reviews: Parameters<typeof storeLib.assembleEffective>[0]["reviews"] = [];
    const dncRows: Parameters<typeof storeLib.assembleEffective>[0]["dncRows"] = [];
    const resolved = new Set<string>();
    for (let i = 0; i < N; i++) {
      const id = `s${i}`;
      scores.push({ id, transcriptId: `t${i}` });
      for (let k = 0; k < 20; k++) {
        lite.push({
          scoreId: id,
          criterionId: `c${k}`,
          name: `C${k}`,
          kind: "required",
          severity: k === 0 ? "critical" : "major",
          verdict: k === 0 ? "needs_review" : "pass",
          fraction: 1,
          maxPoints: 5,
        });
      }
      // Every third call has a human pass on the critical item; every fifth has a flag, half resolved.
      if (i % 3 === 0) {
        reviews.push({ scoreId: id, kind: "override", criterionId: "c0", verdict: "pass", fraction: null, reviewerUserId: "u", createdAt: new Date() });
      }
      if (i % 5 === 0) {
        dncRows.push({ scoreId: id, transcriptId: `t${i}`, fingerprint: "f" });
        if (i % 10 === 0) resolved.add(`t${i}|f`);
      }
    }
    const started = Date.now();
    const out = storeLib.assembleEffective({ scores, lite, reviews, dncRows, resolved });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.size).toBe(N);
    // i=0: overridden to pass and its flag resolved -> pass.
    expect(out.get("s0")!.effective.compliance).toBe("pass");
    // i=1: critical item still unreviewed -> review.
    expect(out.get("s1")!.effective.compliance).toBe("review");
    // i=3: overridden, no flag -> pass. i=5: overridden? no; flag open -> review.
    expect(out.get("s3")!.effective.compliance).toBe("pass");
    expect(out.get("s5")!.openDnc).toBe(1);
    expect(out.get("s10")!.openDnc).toBe(0);
    expect(out.get("s10")!.resolvedDnc).toBe(1);
  });
});


describe("bulk import (look-back)", () => {
  const file = (name: string, body: string) => ({ name, body: Buffer.from(body) });
  function importReq(userId: string, files: Array<{ name: string; body: Buffer }>, manifest?: string, fields: Record<string, string> = {}) {
    let r = request(app).post("/api/call-scoring/import").set(withAuth(userId));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    for (const f of files) r = r.attach("files", f.body, f.name);
    if (manifest !== undefined) r = r.attach("manifest", Buffer.from(manifest), "manifest.csv");
    return r;
  }

  it("scores each file, applies the manifest, reports per-file results and a DNC summary, and adds no opt-outs", async () => {
    const before = await handle.db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id));
    const good = file("rec-001.txt", transcriptText(["Customer: Stop calling me!"]));
    const clean = file("rec-002.txt", transcriptText());
    const vtt = file(
      "rec-003.vtt",
      `WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nAgent: Hello there, thanks for calling ${randomUUID()}.\n\n2\n00:00:04.500 --> 00:00:06.000\nCustomer: Take me off your list.`,
    );
    const dupOfGood = file("rec-001-copy.txt", good.body.toString());
    const audio = file("rec-004.mp3", "ID3");
    const pdf = file("rec-005.pdf", "%PDF");
    const stray = file("rec-006.txt", transcriptText());
    const manifest = [
      "filename,phone,agent,date,reference",
      `rec-001.txt,(310) 555-0111,dana@agency.example,03/01/2025,ENR-1`,
      `rec-002.txt,${PHONE_DUP},Sam Ortiz,2025-03-02,ENR-2`,
      `rec-003.vtt,+13105550999,${otherAgentProfile.id},not-a-date,ENR-3`,
      `missing-file.txt,+13105550000,,,`,
    ].join("\n");
    const res = await importReq(admin.id, [good, clean, vtt, dupOfGood, audio, pdf, stray], manifest);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const by = Object.fromEntries(res.body.results.map((r: { filename: string }) => [r.filename, r]));

    expect(by["rec-001.txt"]).toMatchObject({ status: "scored", contactMatch: "phone_unique", dncFlags: 1, speakerMode: "labelled" });
    expect(by["rec-002.txt"]).toMatchObject({ status: "scored", contactMatch: "phone_ambiguous", dncFlags: 0 });
    expect(by["rec-003.vtt"]).toMatchObject({ status: "scored", contactMatch: "none", dncFlags: 1 });
    expect(by["rec-003.vtt"].warnings.join(" ")).toMatch(/date/i);
    expect(by["rec-001-copy.txt"]).toMatchObject({ status: "duplicate", transcriptId: by["rec-001.txt"].transcriptId });
    expect(by["rec-004.mp3"]).toMatchObject({ status: "error", code: "audio_transcription_not_set_up" });
    expect(by["rec-005.pdf"]).toMatchObject({ status: "error", code: "unsupported_file" });
    expect(by["rec-006.txt"].warnings.join(" ")).toMatch(/not listed in the manifest/i);

    expect(res.body.summary).toMatchObject({
      files: 7,
      scored: 4,
      duplicates: 1,
      errors: 2,
      possibleDncFiles: 2,
      possibleDncRequests: 2,
      needContactPick: 1,
    });
    expect(res.body.summary.manifest).toMatchObject({ rows: 4, unmatchedManifestRows: 1 });
    expect(res.body.summary.aiReview).toMatch(/not run/i);

    // Manifest metadata landed on the records; agent by email and by id and by name.
    const t1 = (await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, by["rec-001.txt"].transcriptId)))[0]!;
    expect(t1.agentId).toBe(agentProfile.id);
    expect(t1.contactId).toBe(contactUnique.id);
    expect(t1.externalRef).toBe("ENR-1");
    expect(t1.source).toBe("enrollhere_download");
    expect(t1.callDate!.toISOString().slice(0, 10)).toBe("2025-03-01");
    const t2 = (await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, by["rec-002.txt"].transcriptId)))[0]!;
    expect(t2.agentId).toBe(otherAgentProfile.id);
    const t3 = (await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, by["rec-003.vtt"].transcriptId)))[0]!;
    expect(t3.agentId).toBe(otherAgentProfile.id);
    expect(t3.callDate).toBeNull();

    // Rules only: no AI ran; and the DNC hits are in the queue but nothing was added to the list.
    const score = (await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.transcriptId, t1.id)))[0]!;
    expect(score.aiStatus).toBe("skipped");
    const after = await handle.db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id));
    expect(after.length).toBe(before.length);
    const q = await request(app).get("/api/call-scoring/dnc-review?limit=200").set(withAuth(admin.id)).expect(200);
    const queued = q.body.items.map((i: { transcriptId: string }) => i.transcriptId);
    expect(queued).toEqual(expect.arrayContaining([t1.id, t3.id]));
  });

  it("enforces the file-count limit, needs at least one file, and validates the manifest", async () => {
    await request(app).post("/api/call-scoring/import").set(withAuth(admin.id)).expect(400);
    const many = Array.from({ length: 51 }, (_, i) => file(`m${i}.txt`, "Agent: hi"));
    const tooMany = await importReq(admin.id, many);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe("too_many_files");
    const noCol = await importReq(admin.id, [file("a.txt", transcriptText())], "phone,agent\n+13105550111,x");
    expect(noCol.status).toBe(400);
    expect(noCol.body.code).toBe("bad_manifest");
    const big = await importReq(admin.id, [file("big.txt", "x")].concat([{ name: "huge.txt", body: Buffer.alloc(1024 * 1024 + 5, "a") }]));
    expect(big.status).toBe(413);
  });

  it("one bad file does not stop the batch, and the manifest's bad contact id is ignored with a warning", async () => {
    const res = await importReq(
      admin.id,
      [file("ok.txt", transcriptText()), file("bad.json", "{nope"), file("empty.txt", "  ")],
      `filename,contactId\nok.txt,${otherOrgContact.id}`,
    );
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.results.map((r: { filename: string }) => [r.filename, r]));
    expect(by["ok.txt"].status).toBe("scored");
    expect(by["ok.txt"].warnings.join(" ")).toMatch(/contactId/i);
    expect(by["ok.txt"].contactMatch).toBe("none");
    expect(by["bad.json"]).toMatchObject({ status: "error", code: "unreadable" });
    expect(by["empty.txt"]).toMatchObject({ status: "error", code: "unreadable" });
    expect(res.body.summary).toMatchObject({ scored: 1, errors: 2 });
  });
});

describe("the AI step", () => {
  it("only runs when configured, sends PHI-redacted text only, and never trusts unverifiable evidence", async () => {
    const prompts: string[] = [];
    (globalThis as { __CS_AI_CLIENT__?: unknown }).__CS_AI_CLIENT__ = {
      chat: {
        completions: {
          create: async (args: { messages: Array<{ content: string }> }) => {
            prompts.push(args.messages.map((m) => m.content).join("\n"));
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      criteria: [
                        // A "pass" quoting words that are not in the call must not stand.
                        { criterionId: "plan_explanation", status: "pass", scorePercent: 100, rationale: "Explained.", evidence: [{ utteranceId: 0, quote: "the premium is a million dollars" }], coaching: null },
                        // A real quote is accepted.
                        { criterionId: "rapport", status: "pass", scorePercent: 100, rationale: "Warm.", evidence: [{ utteranceId: 0, quote: "Thank you for calling Sunrise Benefits" }], coaching: null },
                      ],
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };
    const cfg = await request(app).get("/api/call-scoring/config").set(withAuth(admin.id)).expect(200);
    expect(cfg.body.ai.status).toBe("configured");

    const text = transcriptText(["Customer: My social is 123-45-6789 and my Medicare number is 1EG4-TE5-MK73, call 310-555-0142."]);
    const t = await createScored(text);
    expect(t.ai.status).toBe("used");
    expect(prompts).toHaveLength(1);
    for (const secret of ["123-45-6789", "1EG4-TE5-MK73", "310-555-0142"]) expect(prompts[0]).not.toContain(secret);
    expect(prompts[0]).toContain("[SSN]");
    expect(prompts[0]).toContain("[MBI]");
    expect(prompts[0]).toContain("1-800-MEDICARE");

    const d = await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(d.body.score.ai).toMatchObject({ status: "used", model: "test-model" });
    const by = Object.fromEntries(d.body.criteria.map((c: { criterionId: string }) => [c.criterionId, c]));
    expect(by.plan_explanation.status).toBe("needs_review");
    expect(by.rapport.status).toBe("pass");
    expect(by.rapport.evidence[0].quote).toContain("Thank you for calling");
    expect(by.informed_enrollment.status).toBe("needs_review"); // AI did not grade it: not silently passed

    // The raw identifiers are still in the encrypted transcript for the reviewer.
    expect(d.body.utterances.map((u: { text: string }) => u.text).join(" ")).toContain("123-45-6789");
  });

  it("a failing AI provider fails closed and never stores provider text", async () => {
    (globalThis as { __CS_AI_CLIENT__?: unknown }).__CS_AI_CLIENT__ = {
      chat: { completions: { create: async () => Promise.reject(new Error("provider echo: Jane Roe 123-45-6789")) } },
    };
    const t = await createScored(transcriptText());
    expect(t.ai.status).toBe("failed");
    const [score] = await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.id, t.scoreId));
    expect(score!.aiStatus).toBe("failed");
    expect(score!.aiError).toBe("The AI reviewer could not be reached.");
    expect(JSON.stringify(score)).not.toContain("Jane");
    const d = await request(app).get(`/api/call-scoring/transcripts/${t.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(d.body.criteria.find((c: { criterionId: string }) => c.criterionId === "rapport").status).toBe("needs_review");
  });

  it("bulk import never calls the AI", async () => {
    let called = 0;
    (globalThis as { __CS_AI_CLIENT__?: unknown }).__CS_AI_CLIENT__ = {
      chat: { completions: { create: async () => ((called += 1), { choices: [{ message: { content: "{\"criteria\":[]}" } }] }) } },
    };
    await request(app).post("/api/call-scoring/import").set(withAuth(admin.id)).attach("files", Buffer.from(transcriptText()), "one.txt").expect(200);
    expect(called).toBe(0);
  });

  it("ai:false skips the AI even when it is configured", async () => {
    let called = 0;
    (globalThis as { __CS_AI_CLIENT__?: unknown }).__CS_AI_CLIENT__ = {
      chat: { completions: { create: async () => ((called += 1), { choices: [{ message: { content: "{\"criteria\":[]}" } }] }) } },
    };
    const t = await createScored(transcriptText(), { ai: false });
    expect(t.ai.status).toBe("skipped");
    expect(called).toBe(0);
  });
});
