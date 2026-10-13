/**
 * "This voice is the agent" (POST /call-scoring/transcripts/:id/agent-speaker):
 * a reviewer's choice on a one-track recording gives each voice a role, the call
 * is scored again, the old score stays as history, the audit row carries counts
 * only, and other orgs / read-only roles are refused.
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

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Express } from "express";
import * as schema from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;
let storeLib: typeof import("../../lib/callScoring/store");
let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let viewer: { id: string };
let otherAdmin: { id: string };

/** A one-track recording as speech.ts writes it: voices told apart, roles unknown. */
function oneTrackCall(): string {
  return [
    "Speaker 2: Thank you for calling Sunrise Benefits, my name is Dana Brooks and I'm a licensed insurance agent.",
    "Speaker 2: This call is being recorded.",
    "Speaker 1: Okay.",
    "Speaker 2: We do not offer every plan available in your area. Currently we represent 7 organizations which offer 42 products in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program.",
    `Speaker 1: Nice weather number ${randomUUID().slice(0, 8)} today.`,
  ].join("\n");
}

async function create(text: string): Promise<string> {
  const res = await request(app).post("/api/call-scoring/transcripts").set(withAuth(admin.id)).send({ text });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.transcriptId as string;
}

const choose = (userId: string, id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/call-scoring/transcripts/${id}/agent-speaker`).set(withAuth(userId)).send(body);

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  storeLib = await import("../../lib/callScoring/store");
  request = ((await import("supertest")) as any).default;
  org = await seedOrg(handle.db, { id: "cs-spk-org" });
  otherOrg = await seedOrg(handle.db, { id: "cs-spk-other" });
  admin = await seedUser(handle.db, { orgId: org.id, role: "agency_admin", fullName: "Alex Admin" });
  viewer = await seedUser(handle.db, { orgId: org.id, role: "viewer" });
  otherAdmin = await seedUser(handle.db, { orgId: otherOrg.id, role: "agency_admin" });
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("choosing which voice is the agent", () => {
  it("starts with nobody identified and offers the two voices", async () => {
    const id = await create(oneTrackCall());
    const d = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    expect(d.body.transcript.speakerMode).toBe("unlabelled");
    expect(d.body.transcript.speakers.assignable).toBe(true);
    expect(d.body.transcript.speakers.speakers.map((s: { label: string }) => s.label).sort()).toEqual(["Speaker 1", "Speaker 2"]);
    expect(d.body.transcript.speakerAssignedAt).toBeNull();
  });

  it("saves the roles, scores again, and keeps the earlier score as history", async () => {
    const id = await create(oneTrackCall());
    const before = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);

    const res = await choose(admin.id, id, { agentSpeaker: "Speaker 2" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.speakerMode).toBe("labelled");

    const after = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    expect(after.body.transcript.speakerMode).toBe("labelled");
    expect(after.body.transcript.speakerAssignedAt).toEqual(expect.any(String));
    const roles = after.body.utterances.map((u: { speaker: string; role: string }) => `${u.speaker}=${u.role}`);
    expect(new Set(roles)).toEqual(new Set(["Speaker 2=agent", "Speaker 1=client"]));
    expect(after.body.score.id).not.toBe(before.body.score.id);
    expect(after.body.previousScores.map((s: { id: string }) => s.id)).toContain(before.body.score.id);
  });

  it("can be corrected by choosing the other voice", async () => {
    const id = await create(oneTrackCall());
    await choose(admin.id, id, { agentSpeaker: "Speaker 1" }).expect(201);
    await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201);
    const d = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    const agentSpeakers = new Set(d.body.utterances.filter((u: { role: string }) => u.role === "agent").map((u: { speaker: string }) => u.speaker));
    expect([...agentSpeakers]).toEqual(["Speaker 2"]);
  });

  it("keeps who chose it sealed, and writes counts only to the audit log", async () => {
    const id = await create(oneTrackCall());
    await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201);
    const [row] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, id));
    expect(row!.speakerMode).toBe("labelled");
    expect(storeLib.openTranscript(row!)?.speakerAssignment).toMatchObject({ agentLabel: "Speaker 2", userId: admin.id });
    expect(Buffer.from(row!.transcriptEncrypted!).toString("utf8")).not.toContain("Sunrise");

    const audit = await handle.db
      .select()
      .from(schema.auditLogTable)
      .where(and(eq(schema.auditLogTable.resourceId, id), eq(schema.auditLogTable.action, "call_speaker_assigned")));
    expect(audit).toHaveLength(1);
    const text = JSON.stringify(audit[0]!.changes);
    expect(text).not.toContain("Sunrise");
    expect(text).not.toContain("Speaker");
    expect(audit[0]!.changes).toMatchObject({ speakerMode: "labelled", agentTurns: 3, clientTurns: 2 });
  });

  it("when scoring again fails, keeps the saved choice and says so plainly", async () => {
    const id = await create(oneTrackCall());
    const { assignAgentSpeaker } = await import("../../lib/callScoring/speakerAssign");
    const { getRubric, DEFAULT_RUBRIC_ID } = await import("../../lib/callScoring/rubrics");
    const base = { orgId: org.id, userId: admin.id, userRole: "agency_admin", transcriptId: id, agentLabel: "Speaker 2", rubric: getRubric(DEFAULT_RUBRIC_ID)!, aiMode: "off" as const };

    const thrown = await assignAgentSpeaker({ ...base, rescore: async () => { throw new Error("boom with Sunrise Benefits"); } });
    expect(thrown).toMatchObject({ kind: "error", httpStatus: 502, code: "rescore_failed" });
    const errored = await assignAgentSpeaker({ ...base, rescore: async () => ({ kind: "error", httpStatus: 500, code: "x", message: "y" }) });
    expect(errored).toMatchObject({ kind: "error", code: "rescore_failed" });

    const [row] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, id));
    expect(row!.speakerMode).toBe("labelled");
    // Retrying the real thing works.
    await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201);
  });

  it("when two reviewers choose at once, only the latest choice saves a score", async () => {
    const id = await create(oneTrackCall());
    const { assignAgentSpeaker } = await import("../../lib/callScoring/speakerAssign");
    const { rescoreTranscript } = await import("../../lib/callScoring/ingest");
    const { getRubric, DEFAULT_RUBRIC_ID } = await import("../../lib/callScoring/rubrics");
    const base = { orgId: org.id, userId: admin.id, userRole: "agency_admin", transcriptId: id, rubric: getRubric(DEFAULT_RUBRIC_ID)!, aiMode: "off" as const };
    const scoresOf = async () => (await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.transcriptId, id))).length;
    const before = await scoresOf();

    // Reviewer A picks Speaker 1; before A's scoring saves, reviewer B picks Speaker 2 and finishes.
    const a = await assignAgentSpeaker({
      ...base,
      agentLabel: "Speaker 1",
      rescore: async (args) => {
        await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201);
        return rescoreTranscript(args);
      },
    });
    expect(a).toMatchObject({ kind: "error", httpStatus: 409, code: "superseded" });
    expect(await scoresOf()).toBe(before + 1); // only B's run saved
    const d = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    const agents = new Set(d.body.utterances.filter((u: { role: string }) => u.role === "agent").map((u: { speaker: string }) => u.speaker));
    expect([...agents]).toEqual(["Speaker 2"]);
  });

  it("keeps a call that was scored rules-only rules-only", async () => {
    const res = await request(app).post("/api/call-scoring/transcripts").set(withAuth(admin.id)).send({ text: oneTrackCall(), ai: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.transcriptId as string;
    await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201);
    const d = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    expect(d.body.score.ai.status).toBe("skipped");
  });

  it("a stop-calling request dismissed while the speaker was unknown comes back for review once the client is identified", async () => {
    const id = await create(`${oneTrackCall()}\nSpeaker 1: Please stop calling me.`);
    const [first] = await handle.db
      .select()
      .from(schema.callScoreFindingsTable)
      .where(and(eq(schema.callScoreFindingsTable.transcriptId, id), eq(schema.callScoreFindingsTable.kind, "dnc")));
    await request(app)
      .post(`/api/call-scoring/dnc-review/${first!.id}/resolve`)
      .set(withAuth(admin.id))
      .send({ action: "dismiss", note: "Could not tell who said it." })
      .expect(200);
    const openFlagsFor = async () => {
      const queue = await request(app).get("/api/call-scoring/dnc-review").set(withAuth(admin.id)).expect(200);
      return (queue.body.items as Array<{ transcriptId?: string; transcript?: { id: string } }>).filter((i) => (i.transcriptId ?? i.transcript?.id) === id);
    };
    expect(await openFlagsFor()).toHaveLength(0);

    await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201); // Speaker 1 is now known to be the client
    expect(await openFlagsFor()).toHaveLength(1);
  });

  it("two reviewers pressing together end with one consistent saved choice", async () => {
    const id = await create(oneTrackCall());
    const [a, b] = await Promise.all([choose(admin.id, id, { agentSpeaker: "Speaker 1" }), choose(admin.id, id, { agentSpeaker: "Speaker 2" })]);
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true);
    expect([a.status, b.status]).toContain(201);
    const d = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    const agents = new Set(d.body.utterances.filter((u: { role: string }) => u.role === "agent").map((u: { speaker: string }) => u.speaker));
    expect(agents.size).toBe(1);
    expect(d.body.transcript.speakerMode).toBe("labelled");
  });

  it("a plain rescore that read the old roles saves nothing if a choice lands meanwhile", async () => {
    const id = await create(oneTrackCall());
    const { rescoreTranscript } = await import("../../lib/callScoring/ingest");
    const { getRubric, DEFAULT_RUBRIC_ID } = await import("../../lib/callScoring/rubrics");
    const scoresOf = async () => (await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.transcriptId, id))).length;
    const before = await scoresOf();
    const reviewer = {
      name: "test-reviewer",
      review: async () => {
        // Runs while the rescore is scoring, after it has read the transcript.
        await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201);
        return { criteria: [] };
      },
    };
    const out = await rescoreTranscript({ orgId: org.id, userId: admin.id, userRole: "agency_admin", transcriptId: id, rubric: getRubric(DEFAULT_RUBRIC_ID)!, aiMode: "auto", reviewer });
    expect(out.kind).toBe("duplicate");
    expect(await scoresOf()).toBe(before + 1); // only the choice's own score
  });

  it("gives every choice its own identity, not one derived from the time", async () => {
    const id = await create(oneTrackCall());
    const idOfLatestChoice = async () => {
      const [row] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, id));
      return storeLib.openTranscript(row!)?.speakerAssignment?.id;
    };
    await choose(admin.id, id, { agentSpeaker: "Speaker 1" }).expect(201);
    const first = await idOfLatestChoice();
    await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201);
    const second = await idOfLatestChoice();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it("tells a missing re-score apart even when the choice only swapped the two voices", async () => {
    const id = await create(oneTrackCall());
    const { assignAgentSpeaker } = await import("../../lib/callScoring/speakerAssign");
    const { getRubric, DEFAULT_RUBRIC_ID } = await import("../../lib/callScoring/rubrics");
    const base = { orgId: org.id, userId: admin.id, userRole: "agency_admin", transcriptId: id, rubric: getRubric(DEFAULT_RUBRIC_ID)!, aiMode: "off" as const };
    const scoreCurrent = async () =>
      (await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200)).body.transcript.speakerScoreCurrent as boolean;

    await choose(admin.id, id, { agentSpeaker: "Speaker 1" }).expect(201);
    expect(await scoreCurrent()).toBe(true);

    // Swap the voices; both choices leave the call "labelled", but scoring again fails.
    const failed = await assignAgentSpeaker({ ...base, agentLabel: "Speaker 2", rescore: async () => { throw new Error("boom"); } });
    expect(failed).toMatchObject({ code: "rescore_failed" });
    expect(await scoreCurrent()).toBe(false);

    await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201); // pressing the chosen voice again retries
    expect(await scoreCurrent()).toBe(true);
  });

  it("a stop-calling request that is no longer flagged after the agent is named cannot be acted on from a stale list", async () => {
    // Speaker 1 says it; nobody is identified yet, so it is flagged.
    const id = await create(`${oneTrackCall()}\nSpeaker 1: Please stop calling me.`);
    const [stale] = await handle.db
      .select()
      .from(schema.callScoreFindingsTable)
      .where(and(eq(schema.callScoreFindingsTable.transcriptId, id), eq(schema.callScoreFindingsTable.kind, "dnc")));
    expect(stale).toBeTruthy();

    // A second reviewer names Speaker 1 as the AGENT: those words were the agent's.
    await choose(admin.id, id, { agentSpeaker: "Speaker 1" }).expect(201);

    for (const body of [
      { action: "dismiss", note: "from a stale list" },
      { action: "add_opt_out", phoneSource: "typed", phone: "+13105550199" },
    ]) {
      const res = await request(app).post(`/api/call-scoring/dnc-review/${stale!.id}/resolve`).set(withAuth(admin.id)).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("out_of_date");
    }
    const optOuts = await handle.db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id));
    expect(optOuts.filter((o) => o.phone === "+13105550199")).toHaveLength(0);
  });

  it("while a saved speaker choice has not been scored yet, a stop-calling request cannot be dismissed or turned into an opt-out", async () => {
    const id = await create(`${oneTrackCall()}\nSpeaker 1: Please stop calling me.`);
    const [flag] = await handle.db
      .select()
      .from(schema.callScoreFindingsTable)
      .where(and(eq(schema.callScoreFindingsTable.transcriptId, id), eq(schema.callScoreFindingsTable.kind, "dnc")));
    const { assignAgentSpeaker } = await import("../../lib/callScoring/speakerAssign");
    const { getRubric, DEFAULT_RUBRIC_ID } = await import("../../lib/callScoring/rubrics");

    // The choice (Speaker 1 is the agent) is saved, but scoring again fails, so the old flag is still the "latest" one.
    const failed = await assignAgentSpeaker({
      orgId: org.id,
      userId: admin.id,
      userRole: "agency_admin",
      transcriptId: id,
      agentLabel: "Speaker 1",
      rubric: getRubric(DEFAULT_RUBRIC_ID)!,
      aiMode: "off",
      rescore: async () => {
        throw new Error("boom");
      },
    });
    expect(failed).toMatchObject({ code: "rescore_failed" });

    const resolveFlag = (body: Record<string, unknown>) => request(app).post(`/api/call-scoring/dnc-review/${flag!.id}/resolve`).set(withAuth(admin.id)).send(body);
    const optOutsAdded = async () => (await handle.db.select().from(schema.optOutsTable).where(eq(schema.optOutsTable.orgId, org.id))).filter((o) => o.phone === "+13105550177");
    for (const body of [
      { action: "dismiss", note: "while the call was waiting to be scored" },
      { action: "add_opt_out", phoneSource: "typed", phone: "+13105550177" },
    ]) {
      const res = await resolveFlag(body);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("rescoring_pending");
    }
    expect(await optOutsAdded()).toHaveLength(0);

    // Retrying the choice scores the call under it; the old request is then simply out of date.
    await choose(admin.id, id, { agentSpeaker: "Speaker 1" }).expect(201);
    const after = await resolveFlag({ action: "add_opt_out", phoneSource: "typed", phone: "+13105550177" });
    expect(after.status).toBe(409);
    expect(after.body.code).toBe("out_of_date");
    expect(await optOutsAdded()).toHaveLength(0);
  });

  it("a reviewer cannot sign off criteria on a score that predates a saved speaker choice", async () => {
    const id = await create(oneTrackCall());
    const { assignAgentSpeaker } = await import("../../lib/callScoring/speakerAssign");
    const { getRubric, DEFAULT_RUBRIC_ID } = await import("../../lib/callScoring/rubrics");
    const detailBefore = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    const criterionId = detailBefore.body.criteria[0].criterionId as string;
    const reviewsOf = async () => (await handle.db.select().from(schema.callScoreReviewsTable).where(eq(schema.callScoreReviewsTable.transcriptId, id))).length;
    const override = () => request(app).patch(`/api/call-scoring/transcripts/${id}/criteria/${criterionId}`).set(withAuth(admin.id)).send({ verdict: "pass", note: "checked it" });

    // Allowed before any speaker choice.
    await override().expect(200);
    const baseline = await reviewsOf();

    // The choice is saved but scoring again fails: the score on screen is the old one.
    const failed = await assignAgentSpeaker({
      orgId: org.id,
      userId: admin.id,
      userRole: "agency_admin",
      transcriptId: id,
      agentLabel: "Speaker 2",
      rubric: getRubric(DEFAULT_RUBRIC_ID)!,
      aiMode: "off",
      rescore: async () => {
        throw new Error("boom");
      },
    });
    expect(failed).toMatchObject({ code: "rescore_failed" });
    const refused = await override();
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe("rescoring_pending");
    expect(await reviewsOf()).toBe(baseline);

    // Once the call is scored under the choice, grading works again.
    await choose(admin.id, id, { agentSpeaker: "Speaker 2" }).expect(201);
    await override().expect(200);
    expect(await reviewsOf()).toBe(baseline + 1);
  });

  it("refuses a voice that is not in the call, and a blank choice", async () => {
    const id = await create(oneTrackCall());
    await choose(admin.id, id, { agentSpeaker: "Speaker 9" }).expect(422);
    await choose(admin.id, id, { agentSpeaker: "  " }).expect(400);
    await choose(admin.id, id, {}).expect(400);
  });

  it("refuses a call whose file already names the agent", async () => {
    const id = await create(`Agent: Hi this is Sam. ${randomUUID()}\nCustomer: Okay.`);
    const d = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    expect(d.body.transcript.speakers.assignable).toBe(false);
    await choose(admin.id, id, { agentSpeaker: "Agent" }).expect(422);
  });

  it("another agency gets 404, a read-only user 403, and a signed-out caller 401", async () => {
    const id = await create(oneTrackCall());
    await choose(otherAdmin.id, id, { agentSpeaker: "Speaker 2" }).expect(404);
    await choose(viewer.id, id, { agentSpeaker: "Speaker 2" }).expect(403);
    await request(app).post(`/api/call-scoring/transcripts/${id}/agent-speaker`).send({ agentSpeaker: "Speaker 2" }).expect(401);
    const d = await request(app).get(`/api/call-scoring/transcripts/${id}`).set(withAuth(admin.id)).expect(200);
    expect(d.body.transcript.speakerMode).toBe("unlabelled");
  });
});
