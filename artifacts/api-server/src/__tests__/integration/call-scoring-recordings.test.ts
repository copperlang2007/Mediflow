/**
 * Call recordings → Speech-to-Text → score (phase 2b): routes and the
 * transcription job (lib/callScoring/recordings.ts).
 *
 * Object storage and Google are swapped for fakes; everything else (RBAC, the
 * database, encryption, ingest and scoring) is real.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const { dbF, clerkF, jobsF, storageF } = vi.hoisted(() => ({
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
  storageF: (): Record<string, unknown> => {
    const g = globalThis as unknown as { __REC_OBJECTS__: Map<string, { size: number; contentType: string }>; __REC_SIGNED__: Array<{ key: string; contentType: string }> };
    g.__REC_OBJECTS__ = new Map();
    g.__REC_SIGNED__ = [];
    class MockObjectStorageService {
      callRecordingKey(orgId: string, id: string): string {
        return `call-recordings/${orgId}/${id}`;
      }
      async getCallRecordingUploadURL(key: string, contentType: string): Promise<string> {
        g.__REC_SIGNED__.push({ key, contentType });
        return `https://storage.example/${key}?signed=1`;
      }
      async deleteCallRecording(key: string): Promise<void> {
        g.__REC_OBJECTS__.delete(key);
      }
      async getCallRecordingMetadata(key: string): Promise<{ size: number; contentType: string } | null> {
        return g.__REC_OBJECTS__.get(key) ?? null;
      }
    }
    return { ObjectStorageService: MockObjectStorageService, ObjectNotFoundError: class extends Error {} };
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/objectStorage", storageF);

import { eq } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import { bootTestDb, clearEnqueuedJobs, getEnqueuedJobs, shutdownTestDb, withAuth } from "../helpers/testApp";
import { safeReason } from "../../lib/callScoring/speech";
import { seedAgent, seedContact, seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";

const objects = () => (globalThis as unknown as { __REC_OBJECTS__: Map<string, { size: number; contentType: string }> }).__REC_OBJECTS__;
const signed = () => (globalThis as unknown as { __REC_SIGNED__: Array<{ key: string; contentType: string }> }).__REC_SIGNED__;

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;
let speech: typeof import("../../lib/callScoring/speech");
let recordings: typeof import("../../lib/callScoring/recordings");

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let compliance: { id: string };
let agentUser: { id: string };
let otherAdmin: { id: string };
let agentProfile: { id: string };
let otherOrgAgent: { id: string };

const OP = "projects/p1/locations/us/operations/op-1";
const ENV_KEYS = ["SPEECH_TO_TEXT_PROVIDER", "PRIVATE_OBJECT_DIR", "GOOGLE_CLOUD_PROJECT"] as const;
const savedEnv: Record<string, string | undefined> = {};

function setSpeechOn(on: boolean): void {
  if (on) {
    process.env.SPEECH_TO_TEXT_PROVIDER = "google";
    process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
    process.env.GOOGLE_CLOUD_PROJECT = "p1";
  } else {
    delete process.env.SPEECH_TO_TEXT_PROVIDER;
  }
}

let unique = 0;
/** A stereo call with the agent on the left channel: agent says the required disclosures. */
function stereoResults(): unknown[] {
  unique++;
  const r = (channelTag: number, transcript: string, start: number) => ({
    channelTag,
    resultEndOffset: `${start + 2}s`,
    alternatives: [{ transcript }],
  });
  return [
    r(1, "Thank you for calling Sunrise Benefits, my name is Dana Brooks and I'm a licensed insurance agent.", 0),
    r(1, "This call is being recorded.", 4),
    r(2, `Okay, call number ${unique} ${Date.now()}.`, 7),
    r(1, "We do not offer every plan available in your area. Currently we represent 7 organizations which offer 42 products in your area. Please contact Medicare.gov, 1-800-MEDICARE, or your local State Health Insurance Program.", 10),
  ];
}

function fakeGoogle(opts: { start?: "ok" | "error"; poll: "running" | "done" | "failed"; results?: unknown[] }): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  speech.setSpeechHttpForTests(async (req) => {
    calls.push({ url: req.url, method: req.method });
    if (req.method === "POST") {
      if (opts.start === "error") throw new Error("503 from Google");
      return { name: OP };
    }
    if (opts.poll === "running") return { done: false };
    if (opts.poll === "failed") return { done: true, error: { message: "Permission denied on gs://test-bucket/private/x" } };
    return {
      done: true,
      response: { results: { "gs://x": { inlineResult: { transcript: { results: opts.results ?? stereoResults() } }, metadata: { totalBilledDuration: "95s" } } } },
    };
  });
  return calls;
}

const startBody = (extra: Record<string, unknown> = {}) => ({
  filename: "enrollhere-call-0412.mp3",
  contentType: "audio/mpeg",
  sizeBytes: 4_000_000,
  layout: "agent_left",
  phone: "+13105550111",
  externalRef: "EH-0412",
  ...extra,
});

/** Start an upload, "upload" the bytes, and confirm. Returns the recording id. */
async function uploadAndConfirm(userId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const start = await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(userId)).send(startBody(extra));
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const id = start.body.recordingId as string;
  objects().set(`call-recordings/${org.id}/${id}`, { size: 4_000_000, contentType: "audio/mpeg" });
  const done = await request(app).post(`/api/call-scoring/recordings/${id}/uploaded`).set(withAuth(userId)).send({});
  expect(done.status, JSON.stringify(done.body)).toBe(202);
  return id;
}

async function rowOf(id: string) {
  const [row] = await handle.db.select().from(schema.callRecordingsTable).where(eq(schema.callRecordingsTable.id, id));
  return row!;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  speech = await import("../../lib/callScoring/speech");
  recordings = await import("../../lib/callScoring/recordings");
  request = ((await import("supertest")) as any).default;
  const db = handle.db;
  org = await seedOrg(db, { id: "rec-org" });
  otherOrg = await seedOrg(db, { id: "rec-other-org" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  compliance = await seedUser(db, { orgId: org.id, role: "compliance_manager" });
  agentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  otherAdmin = await seedUser(db, { orgId: otherOrg.id, role: "agency_admin" });
  agentProfile = await seedAgent(db, { orgId: org.id, firstName: "Dana", lastName: "Brooks" });
  otherOrgAgent = await seedAgent(db, { orgId: otherOrg.id, firstName: "Olga", lastName: "Other" });
});

afterAll(async () => {
  speech.setSpeechHttpForTests(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await shutdownTestDb();
});

beforeEach(() => {
  setSpeechOn(true);
  clearEnqueuedJobs();
  speech.setSpeechHttpForTests(null);
});

describe("when Speech-to-Text is not set up", () => {
  it("says so in config, refuses to start an upload, and keeps refusing audio on the transcript route", async () => {
    setSpeechOn(false);
    const cfg = await request(app).get("/api/call-scoring/config").set(withAuth(admin.id)).expect(200);
    expect(cfg.body.audio.supported).toBe(false);
    const res = await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(admin.id)).send(startBody());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("audio_transcription_not_set_up");
    const audio = await request(app)
      .post("/api/call-scoring/transcripts")
      .set(withAuth(admin.id))
      .attach("file", Buffer.from("ID3"), { filename: "call.mp3", contentType: "audio/mpeg" });
    expect(audio.status).toBe(415);
    expect(audio.body.code).toBe("audio_transcription_not_set_up");
  });

  it("a queued recording fails with the setup message instead of hanging", async () => {
    const id = await uploadAndConfirm(admin.id);
    setSpeechOn(false);
    expect(await recordings.processRecording(id)).toBe("finished");
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/not set up/i);
  });
});

describe("starting an upload", () => {
  it("reports audio as supported in config", async () => {
    const cfg = await request(app).get("/api/call-scoring/config").set(withAuth(admin.id)).expect(200);
    expect(cfg.body.audio).toMatchObject({ supported: true, layouts: ["mono", "agent_left", "agent_right"] });
  });

  it("points audio sent to the transcript route at the recording upload", async () => {
    const audio = await request(app)
      .post("/api/call-scoring/transcripts")
      .set(withAuth(admin.id))
      .attach("file", Buffer.from("ID3"), { filename: "call.mp3", contentType: "audio/mpeg" });
    expect(audio.status).toBe(415);
    expect(audio.body.code).toBe("use_recording_upload");
  });

  it("returns a signed URL for a server-chosen key, and stores the details encrypted", async () => {
    const res = await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(compliance.id)).send(startBody({ agentId: agentProfile.id, key: "call-recordings/rec-other-org/steal" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.method).toBe("PUT");
    // Create-only: the signed URL cannot overwrite the object once it exists.
    expect(res.body.headers).toEqual({ "Content-Type": "audio/mpeg", "x-goog-if-generation-match": "0" });
    const row = await rowOf(res.body.recordingId);
    expect(row.objectKey).toBe(`call-recordings/${org.id}/${row.id}`);
    expect(signed().at(-1)).toEqual({ key: row.objectKey, contentType: "audio/mpeg" });
    expect(row.status).toBe("uploading");
    expect(row.agentId).toBe(agentProfile.id);
    expect(row.retainUntil.getTime()).toBeGreaterThan(Date.now() + 9 * 365 * 86_400_000);
    const raw = Buffer.from(row.detailsEncrypted!).toString("latin1");
    expect(raw).not.toContain("enrollhere-call-0412");
    expect(raw).not.toContain("3105550111");
  });

  it("refuses non-audio, oversize files and another agency's agent", async () => {
    const post = (b: Record<string, unknown>) => request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(admin.id)).send(startBody(b));
    expect((await post({ filename: "notes.txt", contentType: "text/plain" })).status).toBe(415);
    expect((await post({ contentType: "application/octet-stream" })).status).toBe(415);
    const ogg = await post({ filename: "call.ogg", contentType: "application/ogg" });
    expect(ogg.status).toBe(201);
    expect(signed().at(-1)?.contentType).toBe("application/ogg");
    expect((await post({ sizeBytes: 600 * 1024 * 1024 })).status).toBe(413);
    const cross = await post({ agentId: otherOrgAgent.id });
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe("agent_not_found");
    expect((await post({ rubricId: "no-such-rubric" })).status).toBe(400);
    const gone = await seedContact(handle.db, { orgId: org.id, firstName: "Gone", lastName: "Contact" });
    await handle.db.update(schema.contactsTable).set({ deletedAt: new Date() }).where(eq(schema.contactsTable.id, gone.id));
    const deleted = await post({ contactId: gone.id });
    expect(deleted.status).toBe(404);
    expect(deleted.body.code).toBe("contact_not_found");
  });

  it("is limited to people who can score calls", async () => {
    await request(app).post("/api/call-scoring/recordings/upload-url").send(startBody()).expect(401);
    await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(agentUser.id)).send(startBody()).expect(403);
    await request(app).get("/api/call-scoring/recordings").set(withAuth(agentUser.id)).expect(403);
  });
});

describe("confirming an upload", () => {
  it("refuses until the file is in storage, then queues transcription once", async () => {
    const start = await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(admin.id)).send(startBody());
    const id = start.body.recordingId as string;
    const notYet = await request(app).post(`/api/call-scoring/recordings/${id}/uploaded`).set(withAuth(admin.id)).send({});
    expect(notYet.status).toBe(409);
    expect(getEnqueuedJobs()).toHaveLength(0);

    objects().set(`call-recordings/${org.id}/${id}`, { size: 1234, contentType: "audio/mpeg" });
    await request(app).post(`/api/call-scoring/recordings/${id}/uploaded`).set(withAuth(admin.id)).send({}).expect(202);
    const again = await request(app).post(`/api/call-scoring/recordings/${id}/uploaded`).set(withAuth(admin.id)).send({});
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("queued");
    expect(getEnqueuedJobs()).toEqual([{ name: "transcribe-recording", data: { recordingId: id } }]);
    expect((await rowOf(id)).sizeBytes).toBe(1234);
  });

  it("fails a file that turned out larger than the limit", async () => {
    const start = await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(admin.id)).send(startBody());
    const id = start.body.recordingId as string;
    objects().set(`call-recordings/${org.id}/${id}`, { size: 501 * 1024 * 1024, contentType: "audio/mpeg" });
    await request(app).post(`/api/call-scoring/recordings/${id}/uploaded`).set(withAuth(admin.id)).send({}).expect(413);
    expect((await rowOf(id)).status).toBe("failed");
    // The oversized object is deleted, not kept.
    expect(objects().has(`call-recordings/${org.id}/${id}`)).toBe(false);
    expect(getEnqueuedJobs()).toHaveLength(0);
  });

  it("another agency cannot confirm or list it", async () => {
    const start = await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(admin.id)).send(startBody());
    const id = start.body.recordingId as string;
    await request(app).post(`/api/call-scoring/recordings/${id}/uploaded`).set(withAuth(otherAdmin.id)).send({}).expect(404);
    const list = await request(app).get("/api/call-scoring/recordings").set(withAuth(otherAdmin.id)).expect(200);
    expect(list.body.recordings.map((r: { id: string }) => r.id)).not.toContain(id);
  });
});

describe("transcription job", () => {
  it("starts, polls, then scores the call as Agent / Client turns", async () => {
    const id = await uploadAndConfirm(admin.id, { agentId: agentProfile.id });
    const calls = fakeGoogle({ poll: "running" });

    expect(await recordings.processRecording(id)).toBe("poll");
    let row = await rowOf(id);
    expect(row.status).toBe("transcribing");
    expect(row.operationName).toBe(OP);
    expect(calls[0]!.url).toContain("/v2/projects/p1/locations/us/recognizers/_:batchRecognize");

    expect(await recordings.processRecording(id)).toBe("poll");
    expect((await rowOf(id)).status).toBe("transcribing");

    fakeGoogle({ poll: "done" });
    expect(await recordings.processRecording(id)).toBe("finished");
    row = await rowOf(id);
    expect(row.status, row.error ?? "").toBe("scored");
    expect(row.durationSeconds).toBe(95);
    expect(row.transcriptId).toBeTruthy();

    const [t] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, row.transcriptId!));
    expect(t!.orgId).toBe(org.id);
    expect(t!.source).toBe("recording");
    expect(t!.agentId).toBe(agentProfile.id);

    const detail = await request(app).get(`/api/call-scoring/transcripts/${row.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(JSON.stringify(detail.body)).toContain("licensed insurance agent");

    // A finished recording is left alone.
    expect(await recordings.processRecording(id)).toBe("finished");
  });

  it("splits a mono recording by voice without guessing who is the agent", async () => {
    const id = await uploadAndConfirm(admin.id, { layout: "mono" });
    const words = [
      { word: "Hello", startOffset: "0s", endOffset: "0.4s", speakerLabel: "1" },
      { word: `caller-${Date.now()}`, startOffset: "1s", endOffset: "1.4s", speakerLabel: "2" },
    ];
    fakeGoogle({ poll: "done", results: [{ alternatives: [{ transcript: "Hello caller", words }] }] });
    await recordings.processRecording(id);
    await recordings.processRecording(id);
    const row = await rowOf(id);
    expect(row.status, row.error ?? "").toBe("scored");
    const detail = await request(app).get(`/api/call-scoring/transcripts/${row.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(JSON.stringify(detail.body)).toMatch(/Speaker 1/);
  });

  it("records a safe reason when Google fails", async () => {
    const id = await uploadAndConfirm(admin.id);
    fakeGoogle({ poll: "failed" });
    await recordings.processRecording(id);
    expect(await recordings.processRecording(id)).toBe("finished");
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/permission/i);
    expect(row.error).not.toContain("test-bucket");
  });

  it("retries a failed start, then gives up after three attempts", async () => {
    const id = await uploadAndConfirm(admin.id);
    fakeGoogle({ start: "error", poll: "running" });
    expect(await recordings.processRecording(id)).toBe("retry_start");
    expect(await recordings.processRecording(id)).toBe("retry_start");
    expect(await recordings.processRecording(id)).toBe("finished");
    const row = await rowOf(id);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
  });

  it("fails when no speech was found", async () => {
    const id = await uploadAndConfirm(admin.id);
    fakeGoogle({ poll: "done", results: [] });
    await recordings.processRecording(id);
    await recordings.processRecording(id);
    expect((await rowOf(id)).error).toMatch(/no speech/i);
  });

  it("stops a transcription that runs past the time limit", async () => {
    const id = await uploadAndConfirm(admin.id);
    const calls = fakeGoogle({ poll: "running" });
    await recordings.processRecording(id);
    await handle.db
      .update(schema.callRecordingsTable)
      .set({ updatedAt: new Date(Date.now() - recordings.TRANSCRIBE_TIMEOUT_MS - 1000) })
      .where(eq(schema.callRecordingsTable.id, id));
    expect(await recordings.processRecording(id)).toBe("finished");
    expect((await rowOf(id)).error).toMatch(/too long and was stopped/i);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith(`${OP}:cancel`))).toBe(true);
  });
});

describe("listing recordings", () => {
  it("shows status and the file name, newest first", async () => {
    const id = await uploadAndConfirm(compliance.id, { filename: "listed-call.wav", contentType: "audio/wav" });
    const res = await request(app).get("/api/call-scoring/recordings").set(withAuth(admin.id)).expect(200);
    const first = res.body.recordings[0];
    expect(first).toMatchObject({ id, status: "queued", filename: "listed-call.wav" });
    expect(first.detailsEncrypted).toBeUndefined();
    expect(res.body.audio.supported).toBe(true);
  });
});

describe("review fixes", () => {
  it("two jobs racing on one recording start only one transcription", async () => {
    const id = await uploadAndConfirm(admin.id);
    const calls = fakeGoogle({ poll: "running" });
    const outcomes = await Promise.all([recordings.processRecording(id), recordings.processRecording(id)]);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(outcomes.sort()).toEqual(["finished", "poll"]);
    expect((await rowOf(id)).operationName).toBe(OP);
  });

  it("a start that died before saving its operation is retried, not failed", async () => {
    const id = await uploadAndConfirm(admin.id);
    await handle.db
      .update(schema.callRecordingsTable)
      .set({ status: "transcribing", operationName: null, updatedAt: new Date() })
      .where(eq(schema.callRecordingsTable.id, id));
    expect(await recordings.processRecording(id)).toBe("poll");
    await handle.db
      .update(schema.callRecordingsTable)
      .set({ updatedAt: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(schema.callRecordingsTable.id, id));
    expect(await recordings.processRecording(id)).toBe("retry_start");
    expect((await rowOf(id)).status).toBe("queued");
  });

  it("an already-scored call links to the existing transcript without an error", async () => {
    const results = stereoResults();
    const first = await uploadAndConfirm(admin.id);
    fakeGoogle({ poll: "done", results });
    await recordings.processRecording(first);
    await recordings.processRecording(first);
    const second = await uploadAndConfirm(admin.id);
    await recordings.processRecording(second);
    await recordings.processRecording(second);
    const [a, b] = [await rowOf(first), await rowOf(second)];
    expect(b.status).toBe("scored");
    expect(b.transcriptId).toBe(a.transcriptId);
    expect(b.error).toBeNull();
  });

  it("a duplicate uploaded under another checklist gets a score under that checklist", async () => {
    const results = stereoResults();
    const first = await uploadAndConfirm(admin.id);
    fakeGoogle({ poll: "done", results });
    await recordings.processRecording(first);
    await recordings.processRecording(first);
    const second = await uploadAndConfirm(admin.id, { rubricId: "general-sales" });
    await recordings.processRecording(second);
    await recordings.processRecording(second);
    const b = await rowOf(second);
    expect(b.status, b.error ?? "").toBe("scored");
    expect(b.transcriptId).toBe((await rowOf(first)).transcriptId);
    const scores = await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.transcriptId, b.transcriptId!));
    expect(scores.map((x) => x.rubricId).sort()).toEqual(["general-sales", "medicare-tpmo"].sort());
  });

  it("keeps the uploader's source on the transcript", async () => {
    const id = await uploadAndConfirm(admin.id, { source: "enrollhere_download" });
    fakeGoogle({ poll: "done" });
    await recordings.processRecording(id);
    await recordings.processRecording(id);
    const row = await rowOf(id);
    const [t] = await handle.db.select().from(schema.callTranscriptsTable).where(eq(schema.callTranscriptsTable.id, row.transcriptId!));
    expect(t!.source).toBe("enrollhere_download");
  });

  it("a stale job cannot turn a scored recording into a failure", async () => {
    const id = await uploadAndConfirm(admin.id);
    fakeGoogle({ poll: "running" });
    await recordings.processRecording(id);
    await handle.db
      .update(schema.callRecordingsTable)
      .set({ updatedAt: new Date(Date.now() - recordings.TRANSCRIBE_TIMEOUT_MS - 1000) })
      .where(eq(schema.callRecordingsTable.id, id));
    // While this job polls (and is about to time out), another job finishes scoring.
    speech.setSpeechHttpForTests(async (req) => {
      if (req.method === "GET") {
        await handle.db.update(schema.callRecordingsTable).set({ status: "scored", error: null }).where(eq(schema.callRecordingsTable.id, id));
        return { done: false };
      }
      return {};
    });
    expect(await recordings.processRecording(id)).toBe("finished");
    const row = await rowOf(id);
    expect(row.status).toBe("scored");
    expect(row.error).toBeNull();
  });

  it("an interrupted start is retried, and gives up after the attempt limit", async () => {
    const id = await uploadAndConfirm(admin.id);
    const stall = (attempts: number) =>
      handle.db
        .update(schema.callRecordingsTable)
        .set({ status: "transcribing", operationName: null, attempts, updatedAt: new Date(Date.now() - 11 * 60 * 1000) })
        .where(eq(schema.callRecordingsTable.id, id));
    await stall(1);
    expect(await recordings.processRecording(id)).toBe("retry_start");
    expect((await rowOf(id)).status).toBe("queued");
    expect((await rowOf(id)).attempts).toBe(1);
    await stall(3);
    expect(await recordings.processRecording(id)).toBe("finished");
    expect((await rowOf(id)).status).toBe("failed");
  });

  it("rescores a duplicate only once per checklist", async () => {
    const results = stereoResults();
    fakeGoogle({ poll: "done", results });
    const run = async (rubricId?: string) => {
      const id = await uploadAndConfirm(admin.id, rubricId ? { rubricId } : {});
      await recordings.processRecording(id);
      await recordings.processRecording(id);
      return rowOf(id);
    };
    const first = await run();
    await run("general-sales");
    await run();
    await run("general-sales");
    const scores = await handle.db.select().from(schema.callScoresTable).where(eq(schema.callScoresTable.transcriptId, first.transcriptId!));
    expect(scores).toHaveLength(2);
  });

  it("deletes the audio of uploads refused at the daily limit or abandoned", async () => {
    process.env.CALL_RECORDINGS_DAILY_LIMIT = "1";
    try {
      const org5 = await seedOrg(handle.db, { id: `rec-del-${Date.now()}` });
      const u = await seedUser(handle.db, { orgId: org5.id, role: "agency_admin" });
      const post = () => request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(u.id)).send(startBody());
      const a = await post();
      await handle.db.update(schema.callRecordingsTable).set({ createdAt: new Date(Date.now() - 16 * 60 * 1000) }).where(eq(schema.callRecordingsTable.id, a.body.recordingId));
      const b = await post();
      const keyOf = (rid: string) => `call-recordings/${org5.id}/${rid}`;
      for (const r of [a, b]) objects().set(keyOf(r.body.recordingId), { size: 10, contentType: "audio/mpeg" });
      await request(app).post(`/api/call-scoring/recordings/${a.body.recordingId}/uploaded`).set(withAuth(u.id)).send({}).expect(202);
      await request(app).post(`/api/call-scoring/recordings/${b.body.recordingId}/uploaded`).set(withAuth(u.id)).send({}).expect(429);
      expect(objects().has(keyOf(b.body.recordingId))).toBe(false);
      expect((await rowOf(b.body.recordingId)).status).toBe("failed");
    } finally {
      delete process.env.CALL_RECORDINGS_DAILY_LIMIT;
    }

    const start = await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(admin.id)).send(startBody());
    const rid = start.body.recordingId as string;
    await handle.db
      .update(schema.callRecordingsTable)
      .set({ createdAt: new Date(Date.now() - recordings.UPLOAD_ABANDONED_AFTER_MS - 60_000) })
      .where(eq(schema.callRecordingsTable.id, rid));
    const deleted: string[] = [];
    await recordings.sweepStalledRecordings(async () => true, new Date(), async (key) => void deleted.push(key));
    expect(deleted).toContain(`call-recordings/${org.id}/${rid}`);
  });

  it("logs only the kind of Google failure, never the bucket path", () => {
    expect(safeReason("could not read object gs://test-bucket/private/call-recordings/x")).not.toContain("gs://");
    expect(safeReason("Audio duration exceeds the limit")).toMatch(/too long/);
  });

  it("caps recordings per agency per day", async () => {
    process.env.CALL_RECORDINGS_DAILY_LIMIT = "1";
    try {
      const org2 = await seedOrg(handle.db, { id: `rec-cap-${Date.now()}` });
      const capAdmin = await seedUser(handle.db, { orgId: org2.id, role: "agency_admin" });
      const post = () => request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(capAdmin.id)).send(startBody());
      expect((await post()).status).toBe(201);
      const second = await post();
      expect(second.status).toBe(429);
      expect(second.body.code).toBe("daily_limit");

      // A rejected upload is never transcribed, so it frees its slot.
      await handle.db.update(schema.callRecordingsTable).set({ status: "failed" }).where(eq(schema.callRecordingsTable.orgId, org2.id));
      expect((await post()).status).toBe(201);

      // A burst cannot slip past the cap together.
      process.env.CALL_RECORDINGS_DAILY_LIMIT = "3";
      const org3 = await seedOrg(handle.db, { id: `rec-burst-${Date.now()}` });
      const burstAdmin = await seedUser(handle.db, { orgId: org3.id, role: "agency_admin" });
      const burst = await Promise.all(
        Array.from({ length: 6 }, () => request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(burstAdmin.id)).send(startBody())),
      );
      expect(burst.filter((r) => r.status === 201)).toHaveLength(3);
      expect(burst.filter((r) => r.status === 429)).toHaveLength(3);
    } finally {
      delete process.env.CALL_RECORDINGS_DAILY_LIMIT;
    }
  });

  it("counts billed failures, frees expired upload links, and enforces the cap again at confirm", async () => {
    process.env.CALL_RECORDINGS_DAILY_LIMIT = "1";
    try {
      const org4 = await seedOrg(handle.db, { id: `rec-cap2-${Date.now()}` });
      const capAdmin = await seedUser(handle.db, { orgId: org4.id, role: "agency_admin" });
      const post = () => request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(capAdmin.id)).send(startBody());
      const rows = () => handle.db.select().from(schema.callRecordingsTable).where(eq(schema.callRecordingsTable.orgId, org4.id));

      // A link nobody used stops counting once it has expired (15 minutes).
      const first = await post();
      expect(first.status).toBe(201);
      await handle.db
        .update(schema.callRecordingsTable)
        .set({ createdAt: new Date(Date.now() - 16 * 60 * 1000) })
        .where(eq(schema.callRecordingsTable.id, first.body.recordingId));
      const second = await post();
      expect(second.status).toBe(201);

      // A failure after Google was called still counts.
      await handle.db.update(schema.callRecordingsTable).set({ status: "failed", attempts: 1 }).where(eq(schema.callRecordingsTable.id, second.body.recordingId));
      expect((await post()).status).toBe(429);
      await handle.db.delete(schema.callRecordingsTable).where(eq(schema.callRecordingsTable.orgId, org4.id));

      // Two links issued while under the cap: only one can be confirmed.
      const a = await post();
      await handle.db
        .update(schema.callRecordingsTable)
        .set({ createdAt: new Date(Date.now() - 16 * 60 * 1000) })
        .where(eq(schema.callRecordingsTable.id, a.body.recordingId));
      const b = await post();
      for (const r of [a, b]) objects().set(`call-recordings/${org4.id}/${r.body.recordingId}`, { size: 10, contentType: "audio/mpeg" });
      await request(app).post(`/api/call-scoring/recordings/${a.body.recordingId}/uploaded`).set(withAuth(capAdmin.id)).send({}).expect(202);
      const over = await request(app).post(`/api/call-scoring/recordings/${b.body.recordingId}/uploaded`).set(withAuth(capAdmin.id)).send({});
      expect(over.status).toBe(429);
      // Refused uploads are not kept: the row fails and the audio is deleted.
      expect((await rows()).find((r) => r.id === b.body.recordingId)!.status).toBe("failed");
    } finally {
      delete process.env.CALL_RECORDINGS_DAILY_LIMIT;
    }
  });

  it("the sweeper re-queues stalled recordings once and fails abandoned uploads", async () => {
    const stalled = await uploadAndConfirm(admin.id);
    const old = new Date(Date.now() - recordings.STALLED_AFTER_MS - 60_000);
    await handle.db.update(schema.callRecordingsTable).set({ checkedAt: old, updatedAt: old }).where(eq(schema.callRecordingsTable.id, stalled));
    const start = await request(app).post("/api/call-scoring/recordings/upload-url").set(withAuth(admin.id)).send(startBody());
    const abandoned = start.body.recordingId as string;
    await handle.db
      .update(schema.callRecordingsTable)
      .set({ createdAt: new Date(Date.now() - recordings.UPLOAD_ABANDONED_AFTER_MS - 60_000) })
      .where(eq(schema.callRecordingsTable.id, abandoned));

    const requeued: string[] = [];
    const out = await recordings.sweepStalledRecordings(async (id) => (requeued.push(id), true));
    expect(requeued).toContain(stalled);
    expect(out.abandoned).toBeGreaterThanOrEqual(1);
    expect((await rowOf(abandoned)).status).toBe("failed");

    // Claimed: an immediate second sweep does not queue it again.
    const again: string[] = [];
    await recordings.sweepStalledRecordings(async (id) => (again.push(id), true));
    expect(again).not.toContain(stalled);
  });
});
