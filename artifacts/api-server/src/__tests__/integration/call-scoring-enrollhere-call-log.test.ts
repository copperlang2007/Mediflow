/**
 * EnrollHere call-log import (lib/callScoring/enrollhereCallLog.ts) and the
 * `fetching` step that downloads each recording (lib/callScoring/recordings.ts).
 *
 * Object storage, EnrollHere's recording host and Google are fakes; the
 * database, RBAC, encryption, ingest and scoring are real. All values are fake.
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
    class MockObjectStorageService {
      callRecordingKey(orgId: string, id: string): string {
        return `call-recordings/${orgId}/${id}`;
      }
    }
    return { ObjectStorageService: MockObjectStorageService, ObjectNotFoundError: class extends Error {} };
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/objectStorage", storageF);

import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import { bootTestDb, clearEnqueuedJobs, getEnqueuedJobs, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedAgent, seedOrg, seedUser } from "../helpers/testDb";
import type { Express } from "express";

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;
let speech: typeof import("../../lib/callScoring/speech");
let recordings: typeof import("../../lib/callScoring/recordings");
let callLog: typeof import("../../lib/callScoring/enrollhereCallLog");
let link: typeof import("../../lib/callScoring/enrollhereRecordingLink");
let decryptPii: (b: Uint8Array) => string;

let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let agentUser: { id: string };
let otherAdmin: { id: string };
let agentProfile: { id: string };

const ENV_KEYS = ["SPEECH_TO_TEXT_PROVIDER", "PRIVATE_OBJECT_DIR", "GOOGLE_CLOUD_PROJECT", "CALL_RECORDINGS_DAILY_LIMIT"] as const;
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

const AGENT_EMAIL = "dana.brooks@agency.example";
const HEADERS = [
  "Agency ID", "Agency", "Agent Email", "Agent First Name", "Agent Last Name", "Billable Seconds", "Created At",
  "Duration", "Duration In Call", "ID", "Lead First Name", "Lead Last Name", "Lead Phone", "Lead State",
  "Recording URL", "Result", "INSUREitALL · Medicare ID", "INSUREitALL · Carrier", "INSUREitALL · APT #, Unit#, Etc",
];
const recUrl = (callId: string, sig = "abc%2Bdef%3D%3D") =>
  `https://storage.googleapis.com/enroll-here-dialer-telnyx-call-recording/x/2026-10-09/c/${callId}/recording-1.mp3?GoogleAccessId=svc%40example.iam.gserviceaccount.com&Expires=1792004363&Signature=${sig}`;

function row(o: Partial<Record<(typeof HEADERS)[number], string>>): string[] {
  const base: Record<string, string> = {
    "Agency ID": "AGY1", Agency: "Sunrise Benefits", "Agent Email": AGENT_EMAIL, "Agent First Name": "Dana", "Agent Last Name": "Brooks",
    "Billable Seconds": "501", "Created At": "10/09/2026, 1:54:25 PM", Duration: "504260", "Duration In Call": "500460",
    ID: "call-1", "Lead First Name": "Pat", "Lead Last Name": "Example", "Lead Phone": "13105550111", "Lead State": "TN",
    "Recording URL": recUrl("call-1"), Result: "Call Back", "INSUREitALL · Medicare ID": "1EG4TE5MK73",
    "INSUREitALL · Carrier": "-", "INSUREitALL · APT #, Unit#, Etc": "-",
  };
  return HEADERS.map((h) => (o[h] ?? base[h])!);
}
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (rows: string[][]) => Buffer.from([HEADERS, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n");

const standardFile = () =>
  csv([
    row({ ID: "call-1" }),
    row({ ID: "call-short", "Duration In Call": "25000", "Recording URL": recUrl("call-short") }),
    row({ ID: "call-nolink", "Recording URL": "" }),
    row({ ID: "call-badlink", "Recording URL": "https://evil.example/recording.mp3" }),
  ]);

const importFile = (userId: string, buf: Buffer, rubricId?: string) => {
  const r = request(app).post("/api/call-scoring/enrollhere-call-log").set(withAuth(userId));
  if (rubricId) r.field("rubricId", rubricId);
  return r.attach("file", buf, { filename: "Call_Logs.csv", contentType: "text/csv" });
};

async function payloadsOf(orgId: string) {
  return handle.db
    .select()
    .from(schema.integrationPayloadsTable)
    .where(and(eq(schema.integrationPayloadsTable.orgId, orgId), eq(schema.integrationPayloadsTable.source, "enrollhere_call_log")));
}
async function rowOf(id: string) {
  const [r] = await handle.db.select().from(schema.callRecordingsTable).where(eq(schema.callRecordingsTable.id, id));
  return r;
}

/** In-memory bucket for the fetching step. */
function fakeStore() {
  const objects = new Map<string, { size: number; contentType: string }>();
  return {
    objects,
    async getCallRecordingMetadata(key: string) {
      return objects.get(key) ?? null;
    },
    async saveCallRecording(key: string, body: Readable, contentType: string) {
      let size = 0;
      for await (const chunk of body) size += (chunk as Buffer).length;
      objects.set(key, { size, contentType });
    },
  };
}
function fakeFetch(status: number, bytes = 2048, contentType = "audio/mpeg") {
  const calls: Array<{ url: string; redirect: string }> = [];
  const impl = async (url: URL, init: { redirect: "error"; signal: AbortSignal }) => {
    calls.push({ url: url.toString(), redirect: init.redirect });
    return new Response(status === 200 ? new Uint8Array(bytes) : "denied", { status, headers: { "content-type": contentType } });
  };
  return { impl, calls };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  speech = await import("../../lib/callScoring/speech");
  recordings = await import("../../lib/callScoring/recordings");
  callLog = await import("../../lib/callScoring/enrollhereCallLog");
  link = await import("../../lib/callScoring/enrollhereRecordingLink");
  ({ decryptPii } = (await import("@workspace/db")) as unknown as { decryptPii: (b: Uint8Array) => string });
  request = ((await import("supertest")) as any).default;
  const db = handle.db;
  org = await seedOrg(db, { id: "ehcl-org" });
  otherOrg = await seedOrg(db, { id: "ehcl-other-org" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin" });
  agentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  otherAdmin = await seedUser(db, { orgId: otherOrg.id, role: "agency_admin" });
  agentProfile = await seedAgent(db, { orgId: org.id, firstName: "Dana", lastName: "Brooks", email: AGENT_EMAIL });
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
  delete process.env.CALL_RECORDINGS_DAILY_LIMIT;
  clearEnqueuedJobs();
  speech.setSpeechHttpForTests(null);
});

describe("recording links and call-log values", () => {
  it("accepts only EnrollHere's recording storage over https", () => {
    expect(link.enrollhereRecordingUrl(recUrl("x"))).not.toBeNull();
    for (const bad of [
      recUrl("x").replace("https:", "http:"),
      "https://storage.googleapis.com/some-other-bucket/a.mp3",
      "https://user:pw@storage.googleapis.com/enroll-here-dialer-x/a.mp3",
      "https://storage.googleapis.com:8443/enroll-here-dialer-x/a.mp3",
      "https://evil.example/enroll-here-dialer-x/a.mp3",
      "https://storage.googleapis.com.evil.example/enroll-here-dialer-x/a.mp3",
      "not a url",
      "",
    ]) {
      expect(link.enrollhereRecordingUrl(bad), bad).toBeNull();
    }
  });

  it("reads Created At as US Central wall time, across daylight saving", () => {
    expect(callLog.parseCallLogTime("10/09/2026, 1:54:25 PM")?.toISOString()).toBe("2026-10-09T18:54:25.000Z");
    expect(callLog.parseCallLogTime("12/01/2026, 9:00:00 AM")?.toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect(callLog.parseCallLogTime("10/09/2026, 12:05:00 AM")?.toISOString()).toBe("2026-10-09T05:05:00.000Z");
    expect(callLog.parseCallLogTime("13/45/2026, 1:00 PM")).toBeNull();
    expect(callLog.parseCallLogTime("yesterday")).toBeNull();
  });

  it("uses Duration In Call (milliseconds), falling back to Billable Seconds", () => {
    expect(callLog.callSeconds({ "Duration In Call": "500460" })).toBe(500);
    expect(callLog.callSeconds({ "Duration In Call": "", "Billable Seconds": "42" })).toBe(42);
    expect(callLog.callSeconds({})).toBeNull();
  });
});

describe("importing an EnrollHere call log", () => {
  it("keeps every column encrypted, and queues only scorable calls with a valid link", async () => {
    const res = await importFile(admin.id, standardFile());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      rows: 4,
      stored: 4,
      queued: 1,
      duplicates: 0,
      notScored: { short: 1, noRecording: 1, badLink: 1, notTranscribed: 0 },
      errors: 0,
      rubricId: "iia-2026-qa",
    });
    // No values from the file in the response: ids, line numbers and outcomes only.
    expect(JSON.stringify(res.body)).not.toMatch(/1EG4TE5MK73|3105550111|Pat|Signature/);

    const stored = await payloadsOf(org.id);
    expect(stored.map((p) => p.externalId).sort()).toEqual(["call-1", "call-badlink", "call-nolink", "call-short"]);
    const first = stored.find((p) => p.externalId === "call-1")!;
    expect(Buffer.from(first.payloadEncrypted).toString("latin1")).not.toContain("1EG4TE5MK73");
    const values = JSON.parse(decryptPii(first.payloadEncrypted)) as Record<string, string>;
    expect(Object.keys(values)).toHaveLength(HEADERS.length);
    expect(values["INSUREitALL · Medicare ID"]).toBe("1EG4TE5MK73");
    expect(values["INSUREitALL · APT #, Unit#, Etc"]).toBe("-");
    expect(values["Recording URL"]).toBe(recUrl("call-1"));
    expect(first.retainUntil.getTime()).toBeGreaterThan(Date.now() + 9 * 365 * 86_400_000);

    const recId = res.body.results.find((r: { callId: string }) => r.callId === "call-1").recordingId as string;
    expect(recId).toBe(callLog.recordingIdFor(org.id, "call-1"));
    const rec = (await rowOf(recId))!;
    expect(rec).toMatchObject({
      orgId: org.id,
      status: "fetching",
      layout: "mono",
      source: "enrollhere_download",
      rubricId: "iia-2026-qa",
      agentId: agentProfile.id,
      createdBy: admin.id,
      objectKey: `call-recordings/${org.id}/${recId}`,
    });
    expect(rec.callDate?.toISOString()).toBe("2026-10-09T18:54:25.000Z");
    // The link is a credential: sealed on the row, never in the clear.
    expect(Buffer.from(rec.detailsEncrypted!).toString("latin1")).not.toContain("storage.googleapis.com");
    expect(getEnqueuedJobs().filter((j) => j.name === "transcribe-recording").map((j) => j.data)).toEqual([{ recordingId: recId }]);
  });

  it("importing the same export again stores nothing twice and queues nothing", async () => {
    const res = await importFile(admin.id, standardFile());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: 4, stored: 0, duplicates: 4, queued: 0, requeued: 0 });
    expect(await payloadsOf(org.id)).toHaveLength(4);
    expect(getEnqueuedJobs()).toHaveLength(0);
  });

  it("refuses a file that is not a call log, and agents may not import", async () => {
    const notLog = await importFile(admin.id, Buffer.from("name,phone\nPat,3105550111\n"));
    expect(notLog.status).toBe(400);
    expect(notLog.body.code).toBe("not_a_call_log");
    await importFile(agentUser.id, standardFile()).expect(403);
    const noFile = await request(app).post("/api/call-scoring/enrollhere-call-log").set(withAuth(admin.id)).field("rubricId", "iia-2026-qa");
    expect(noFile.status).toBe(400);
  });

  it("keeps each agency's calls apart: the same call ID in another agency is its own record", async () => {
    const res = await importFile(otherAdmin.id, csv([row({ ID: "call-1" })]));
    expect(res.body).toMatchObject({ stored: 1, queued: 1, duplicates: 0 });
    const theirs = await payloadsOf(otherOrg.id);
    expect(theirs).toHaveLength(1);
    const recId = callLog.recordingIdFor(otherOrg.id, "call-1");
    expect(recId).not.toBe(callLog.recordingIdFor(org.id, "call-1"));
    const rec = (await rowOf(recId))!;
    expect(rec.orgId).toBe(otherOrg.id);
    // The other agency has no agent with that email.
    expect(rec.agentId).toBeNull();
  });

  it("still stores every value when audio transcription is not set up", async () => {
    setSpeechOn(false);
    const res = await importFile(admin.id, csv([row({ ID: "call-nostt", "Recording URL": recUrl("call-nostt") })]));
    expect(res.body).toMatchObject({ stored: 1, queued: 0, notScored: { notTranscribed: 1 } });
    expect((await payloadsOf(org.id)).some((p) => p.externalId === "call-nostt")).toBe(true);
    expect(await rowOf(callLog.recordingIdFor(org.id, "call-nostt"))).toBeUndefined();
    // Once it is set up, importing the file again queues the call.
    setSpeechOn(true);
    const again = await importFile(admin.id, csv([row({ ID: "call-nostt", "Recording URL": recUrl("call-nostt") })]));
    expect(again.body).toMatchObject({ requeued: 1, duplicates: 0 });
    expect((await rowOf(callLog.recordingIdFor(org.id, "call-nostt")))?.status).toBe("fetching");
  });
});

describe("downloading the recording", () => {
  it("stores the audio without following redirects, drops the link, and queues transcription", async () => {
    const id = callLog.recordingIdFor(org.id, "call-1");
    const store = fakeStore();
    const http = fakeFetch(200, 4096);
    expect(await recordings.processRecording(id, { storage: store, fetchImpl: http.impl })).toBe("poll");
    expect(http.calls).toEqual([{ url: recUrl("call-1"), redirect: "error" }]);
    expect(store.objects.get(`call-recordings/${org.id}/${id}`)).toEqual({ size: 4096, contentType: "audio/mpeg" });
    const rec = (await rowOf(id))!;
    expect(rec.status).toBe("queued");
    expect(rec.sizeBytes).toBe(4096);
    expect(rec.committedAt).not.toBeNull();
    const { open } = await import("../../lib/callScoring/seal");
    const details = open<{ sourceUrl?: string | null; externalRef: string }>(rec.detailsEncrypted!);
    expect(details?.sourceUrl).toBeNull();
    expect(details?.externalRef).toBe("call-1");
  });

  it("an expired link fails at once, and a fresh export queues the call again", async () => {
    await importFile(admin.id, csv([row({ ID: "call-exp", "Recording URL": recUrl("call-exp", "old") })]));
    const id = callLog.recordingIdFor(org.id, "call-exp");
    const http = fakeFetch(403);
    expect(await recordings.processRecording(id, { storage: fakeStore(), fetchImpl: http.impl })).toBe("finished");
    let rec = (await rowOf(id))!;
    expect(rec.status).toBe("failed");
    expect(rec.attempts).toBe(0);
    expect(rec.error).toMatch(/expired/i);
    expect(rec.purgeAfter).not.toBeNull();

    clearEnqueuedJobs();
    const again = await importFile(admin.id, csv([row({ ID: "call-exp", "Recording URL": recUrl("call-exp", "fresh") })]));
    expect(again.body).toMatchObject({ requeued: 1, duplicates: 0 });
    rec = (await rowOf(id))!;
    expect(rec).toMatchObject({ status: "fetching", error: null, purgeAfter: null });
    const ok = fakeFetch(200);
    expect(await recordings.processRecording(id, { storage: fakeStore(), fetchImpl: ok.impl })).toBe("poll");
    expect(ok.calls[0]!.url).toContain("Signature=fresh");
  });

  it("a network failure is retried, then given up on after a day", async () => {
    await importFile(admin.id, csv([row({ ID: "call-net", "Recording URL": recUrl("call-net") })]));
    const id = callLog.recordingIdFor(org.id, "call-net");
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await recordings.processRecording(id, { storage: fakeStore(), fetchImpl: down })).toBe("retry_start");
    expect((await rowOf(id))!.status).toBe("fetching");
    await handle.db.update(schema.callRecordingsTable).set({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(schema.callRecordingsTable.id, id));
    expect(await recordings.processRecording(id, { storage: fakeStore(), fetchImpl: down })).toBe("finished");
    const rec = (await rowOf(id))!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/could not be downloaded/i);
  });

  it("respects the agency's daily recording limit; the call is retried by importing again", async () => {
    process.env.CALL_RECORDINGS_DAILY_LIMIT = "1"; // call-1 is already queued today
    await importFile(admin.id, csv([row({ ID: "call-cap", "Recording URL": recUrl("call-cap") })]));
    const id = callLog.recordingIdFor(org.id, "call-cap");
    const http = fakeFetch(200);
    expect(await recordings.processRecording(id, { storage: fakeStore(), fetchImpl: http.impl })).toBe("finished");
    // Refused before anything is downloaded.
    expect(http.calls).toHaveLength(0);
    const rec = (await rowOf(id))!;
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/daily limit/i);
    expect(rec.purgeAfter).not.toBeNull();
  });

  it("a download times out before the sweep would treat it as stalled", () => {
    expect(link.FETCH_TIMEOUT_MS).toBeLessThan(recordings.STALLED_AFTER_MS);
  });

  it("the sweep never deletes audio of a call a re-import has already revived", async () => {
    await importFile(admin.id, csv([row({ ID: "call-race", "Recording URL": recUrl("call-race", "old") })]));
    const id = callLog.recordingIdFor(org.id, "call-race");
    // Failed and due for purge (as after an expired link)...
    expect(await recordings.processRecording(id, { storage: fakeStore(), fetchImpl: fakeFetch(403).impl })).toBe("finished");
    expect((await rowOf(id))!.status).toBe("failed");
    // ...the sweep lists it, then a fresh export revives it before the delete runs.
    const now = new Date(Date.now() + 1000);
    await importFile(admin.id, csv([row({ ID: "call-race", "Recording URL": recUrl("call-race", "fresh") })]));
    const deleted: string[] = [];
    expect(await recordings.purgeOne(id, now, async (k) => void deleted.push(k))).toBe(false);
    expect(deleted).toEqual([]);
    expect((await rowOf(id))!.status).toBe("fetching");
  });

  it("the sweep does delete a failed call's audio and clears the mark", async () => {
    await importFile(admin.id, csv([row({ ID: "call-purge", "Recording URL": recUrl("call-purge") })]));
    const id = callLog.recordingIdFor(org.id, "call-purge");
    await recordings.processRecording(id, { storage: fakeStore(), fetchImpl: fakeFetch(403).impl });
    const deleted: string[] = [];
    expect(await recordings.purgeOne(id, new Date(Date.now() + 1000), async (k) => void deleted.push(k))).toBe(true);
    expect(deleted).toEqual([`call-recordings/${org.id}/${id}`]);
    expect((await rowOf(id))!.purgeAfter).toBeNull();
  });

  it("the sweep re-queues a download whose job was lost", async () => {
    await importFile(admin.id, csv([row({ ID: "call-lost", "Recording URL": recUrl("call-lost") })]));
    const id = callLog.recordingIdFor(org.id, "call-lost");
    await handle.db.update(schema.callRecordingsTable).set({ checkedAt: null, updatedAt: new Date(Date.now() - 20 * 60 * 1000) }).where(eq(schema.callRecordingsTable.id, id));
    const requeued: string[] = [];
    await recordings.sweepStalledRecordings(async (r) => (requeued.push(r), true), new Date(), async () => {});
    expect(requeued).toContain(id);
  });
});
