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
