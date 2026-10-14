/**
 * Listening to a call's recording (GET /call-scoring/transcripts/:id/audio):
 * a reviewer may listen to any call in their agency, an agent only to their own,
 * every listen is logged before a link is given out and the log holds no link,
 * the link is short-lived and never cached, and every refusal gives a plain
 * answer without leaking whether another agency's call exists.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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
  // Only the two operations playback uses are faked; everything else in the module stays real.
  storageF: async (importOriginal: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> => {
    const actual = await importOriginal();
    class FakeStorage {
      async getCallRecordingMetadata(key: string) {
        const fail = (globalThis as { __PB_FAIL__?: Map<string, string> }).__PB_FAIL__;
        if (fail?.get(key) === "metadata") throw new Error(`storage down for ${key}`);
        const objects = (globalThis as { __PB_OBJECTS__?: Map<string, { size: number; contentType: string | null }> }).__PB_OBJECTS__;
        return objects?.get(key) ?? null;
      }
      async getCallRecordingReadURL(key: string, ttl = 600) {
        const fail = (globalThis as { __PB_FAIL__?: Map<string, string> }).__PB_FAIL__;
        if (fail?.get(key) === "sign") throw new Error(`signing failed for ${key}`);
        return `https://storage.example/${key}?read=1&ttl=${ttl}`;
      }
    }
    return { ...actual, ObjectStorageService: FakeStorage };
  },
}));
vi.mock("@workspace/db", dbF);
vi.mock("@clerk/express", clerkF);
vi.mock("../../lib/jobs", jobsF);
vi.mock("../../lib/objectStorage", storageF);

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Express } from "express";
import * as schema from "@workspace/db/schema";
import { bootTestDb, shutdownTestDb, withAuth } from "../helpers/testApp";
import { seedAgent, seedOrg, seedUser } from "../helpers/testDb";

let app: Express;
let request: typeof import("supertest");
let handle: Awaited<ReturnType<typeof bootTestDb>>;
let org: { id: string };
let otherOrg: { id: string };
let admin: { id: string };
let viewer: { id: string };
let otherAdmin: { id: string };
let agentUser: { id: string };
let otherAgentUser: { id: string };
let agentProfile: { id: string };
let otherAgentProfile: { id: string };

const objects = () => {
  const g = globalThis as { __PB_OBJECTS__?: Map<string, { size: number; contentType: string | null }> };
  return (g.__PB_OBJECTS__ ??= new Map());
};

/** A scored text call; `recording` adds a stored, scored recording linked to it. */
async function makeCall(opts: { callSessionId?: string; recording?: "scored" | "failed" | "none"; audioInStorage?: boolean } = {}) {
  const text = `Agent: Thank you for calling, this call is being recorded. ${randomUUID()}\nCustomer: Okay.`;
  const res = await request(app)
    .post("/api/call-scoring/transcripts")
    .set(withAuth(admin.id))
    .send({ text, ...(opts.callSessionId ? { callSessionId: opts.callSessionId } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const transcriptId = res.body.transcriptId as string;
  const kind = opts.recording ?? "scored";
  let recordingId: string | null = null;
  if (kind !== "none") {
    recordingId = randomUUID();
    const objectKey = `call-recordings/${org.id}/${recordingId}`;
    await handle.db.insert(schema.callRecordingsTable).values({
      id: recordingId,
      orgId: org.id,
      status: kind,
      objectKey,
      transcriptId,
      retainUntil: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000),
    });
    if (opts.audioInStorage ?? true) objects().set(objectKey, { size: 4_000_000, contentType: "audio/mpeg" });
  }
  return { transcriptId, recordingId };
}

const listen = (userId: string, transcriptId: string) => request(app).get(`/api/call-scoring/transcripts/${transcriptId}/audio`).set(withAuth(userId));
const listenAudits = async (transcriptId: string) =>
  handle.db
    .select()
    .from(schema.auditLogTable)
    .where(and(eq(schema.auditLogTable.resourceId, transcriptId), eq(schema.auditLogTable.action, "call_recording_listen")));

beforeAll(async () => {
  handle = await bootTestDb();
  app = (await import("../../app")).default;
  request = ((await import("supertest")) as any).default;
  const db = handle.db;
  org = await seedOrg(db, { id: "cs-pb-org" });
  otherOrg = await seedOrg(db, { id: "cs-pb-other" });
  admin = await seedUser(db, { orgId: org.id, role: "agency_admin", fullName: "Alex Admin" });
  viewer = await seedUser(db, { orgId: org.id, role: "viewer" });
  otherAdmin = await seedUser(db, { orgId: otherOrg.id, role: "agency_admin" });
  agentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  otherAgentUser = await seedUser(db, { orgId: org.id, role: "agent" });
  agentProfile = await seedAgent(db, { orgId: org.id, firstName: "Dana", lastName: "Brooks", email: "dana-pb@agency.example" });
  otherAgentProfile = await seedAgent(db, { orgId: org.id, firstName: "Sam", lastName: "Ortiz" });
  await db.update(schema.agentsTable).set({ userId: agentUser.id }).where(eq(schema.agentsTable.id, agentProfile.id));
  await db.update(schema.agentsTable).set({ userId: otherAgentUser.id }).where(eq(schema.agentsTable.id, otherAgentProfile.id));
});

afterAll(async () => {
  await shutdownTestDb();
});

describe("listening to a recording", () => {
  it("gives a reviewer a ten-minute link, never cached, and logs the listen first", async () => {
    const { transcriptId, recordingId } = await makeCall();
    const res = await listen(admin.id, transcriptId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body.expiresInSeconds).toBe(600);
    expect(res.body.contentType).toBe("audio/mpeg");
    expect(res.body.url).toBe(`https://storage.example/call-recordings/${org.id}/${recordingId}?read=1&ttl=600`);

    const audits = await listenAudits(transcriptId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(admin.id);
    expect(audits[0]!.changes).toEqual({ recordingId, linkSeconds: 600 });
    // The log never holds the link or any storage path.
    expect(JSON.stringify(audits[0])).not.toContain("storage.example");
    expect(JSON.stringify(audits[0])).not.toContain("call-recordings/");
  });

  it("logs every listen separately", async () => {
    const { transcriptId } = await makeCall();
    await listen(admin.id, transcriptId).expect(200);
    await listen(admin.id, transcriptId).expect(200);
    expect(await listenAudits(transcriptId)).toHaveLength(2);
  });

  it("the call page learns whether there is a recording to play", async () => {
    const withAudio = await makeCall();
    const textOnly = await makeCall({ recording: "none" });
    const a = await request(app).get(`/api/call-scoring/transcripts/${withAudio.transcriptId}`).set(withAuth(admin.id)).expect(200);
    const b = await request(app).get(`/api/call-scoring/transcripts/${textOnly.transcriptId}`).set(withAuth(admin.id)).expect(200);
    expect(a.body.transcript.recordingAvailable).toBe(true);
    expect(b.body.transcript.recordingAvailable).toBe(false);
  });

  it("says plainly when a call has no recording, and logs nothing", async () => {
    const { transcriptId } = await makeCall({ recording: "none" });
    const res = await listen(admin.id, transcriptId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no_recording");
    expect(await listenAudits(transcriptId)).toHaveLength(0);
  });

  it("ignores a recording that never finished scoring", async () => {
    const { transcriptId } = await makeCall({ recording: "failed" });
    const res = await listen(admin.id, transcriptId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("no_recording");
  });

  it("says plainly when the audio is gone from storage, and logs nothing", async () => {
    const { transcriptId } = await makeCall({ audioInStorage: false });
    const res = await listen(admin.id, transcriptId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("audio_unavailable");
    expect(await listenAudits(transcriptId)).toHaveLength(0);
  });

  it.each(["metadata", "sign"])("answers 503 without leaking the object key when storage fails (%s), and logs nothing", async (mode) => {
    const { transcriptId, recordingId } = await makeCall();
    const objectKey = `call-recordings/${org.id}/${recordingId}`;
    const g = globalThis as { __PB_FAIL__?: Map<string, string> };
    (g.__PB_FAIL__ ??= new Map()).set(objectKey, mode);
    try {
      const res = await listen(admin.id, transcriptId);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code).toBe("storage_unavailable");
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(JSON.stringify(res.body)).not.toContain(objectKey);
      expect(JSON.stringify(res.body)).not.toContain(recordingId!);
      if (mode === "metadata") expect(await listenAudits(transcriptId)).toHaveLength(0);
    } finally {
      g.__PB_FAIL__.delete(objectKey);
    }
  });

  it("gives no link when the listen cannot be logged", async () => {
    const { transcriptId } = await makeCall();
    const realInsert = handle.db.insert.bind(handle.db) as (table: unknown) => any;
    const spy = vi.spyOn(handle.db, "insert").mockImplementation(((table: unknown) => {
      const builder = realInsert(table);
      if (table !== schema.auditLogTable) return builder;
      return {
        values: (v: { action?: string }) =>
          v?.action === "call_recording_listen" ? Promise.reject(new Error("audit write failed")) : builder.values(v),
      };
    }) as never);
    try {
      const res = await listen(admin.id, transcriptId);
      expect(spy).toHaveBeenCalled();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toHaveProperty("url");
      expect(JSON.stringify(res.body)).not.toContain("storage.example");
    } finally {
      spy.mockRestore();
    }
    expect(await listenAudits(transcriptId)).toHaveLength(0);
  });

  it("never writes the recording's object key to the server log when playback fails", async () => {
    const { logger } = await import("../../lib/logger");
    const captured: unknown[] = [];
    // Errors stringify to {} by default, so keep message, stack, cause and own fields.
    // pino-http hands over raw req/res (sockets, circular); real pino serializes them to method/url/status only.
    const record = (args: unknown[]) => {
      const seen = new WeakSet<object>();
      captured.push(
        JSON.stringify(args, (k, v) => {
          if (k === "req" || k === "res") return undefined;
          if (v && typeof v === "object") {
            if (seen.has(v)) return "[circular]";
            seen.add(v);
          }
          return v instanceof Error ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause } : v;
        }),
      );
    };
    const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
    const spies: Array<{ mockRestore: () => void }> = [];
    const wrap = (l: any) => {
      for (const level of levels) {
        spies.push(vi.spyOn(l, level).mockImplementation(((...args: unknown[]) => record(args)) as never));
      }
    };
    wrap(logger);
    // Each request's logger (req.log) is a child of the app logger.
    const realChild = logger.child.bind(logger);
    spies.push(
      vi.spyOn(logger, "child").mockImplementation(((...a: unknown[]) => {
        const c = (realChild as (...x: unknown[]) => unknown)(...a);
        wrap(c);
        return c;
      }) as never),
    );

    const g = globalThis as { __PB_FAIL__?: Map<string, string> };
    const realInsert = handle.db.insert.bind(handle.db) as (table: unknown) => any;
    const bodies: string[] = [];
    let objectKeys: string[] = [];
    try {
      // (a) The listen cannot be logged; the database error carries real ids, as drizzle's does.
      const a = await makeCall();
      const keyA = `call-recordings/${org.id}/${a.recordingId}`;
      const insertSpy = vi.spyOn(handle.db, "insert").mockImplementation(((table: unknown) => {
        const builder = realInsert(table);
        if (table !== schema.auditLogTable) return builder;
        return {
          values: (v: { action?: string }) =>
            v?.action === "call_recording_listen"
              ? Promise.reject(
                  new Error(
                    `Failed query: insert into "audit_log" ("id", "org_id", "user_id", "action", "resource_id") values (default, $1, $2, $3, $4)\nparams: ${org.id},${admin.id},call_recording_listen,${a.transcriptId}`,
                  ),
                )
              : builder.values(v),
        };
      }) as never);
      spies.push(insertSpy);
      const resA = await listen(admin.id, a.transcriptId);
      expect(insertSpy).toHaveBeenCalled();
      expect(resA.status).toBeGreaterThanOrEqual(500);
      bodies.push(JSON.stringify(resA.body));
      insertSpy.mockRestore();

      // (b) Storage fails with a message that contains the key; the route answers 503.
      const b = await makeCall();
      const keyB = `call-recordings/${org.id}/${b.recordingId}`;
      (g.__PB_FAIL__ ??= new Map()).set(keyB, "metadata");
      try {
        const resB = await listen(admin.id, b.transcriptId);
        expect(resB.status, JSON.stringify(resB.body)).toBe(503);
        bodies.push(JSON.stringify(resB.body));
      } finally {
        g.__PB_FAIL__.delete(keyB);
      }
      objectKeys = [keyA, keyB];
    } finally {
      for (const s of spies) s.mockRestore();
    }

    // The log was actually captured (request lines at least), so the checks below mean something.
    const everything = captured.join("\n");
    expect(everything).toContain("audit_log");
    for (const key of objectKeys) {
      expect(everything).not.toContain(key);
      for (const body of bodies) expect(body).not.toContain(key);
    }
  });

  it("an agent can listen to calls from phone sessions they placed, and no one else's", async () => {
    // An agent's own call is one linked to a call session they placed.
    const session = async (userId: string, agentId: string) => {
      const id = `cs-pb-session-${randomUUID()}`;
      await handle.db.insert(schema.callSessionsTable).values({ id, orgId: org.id, userId, agentId, toNumber: "+13105550111", status: "completed" });
      return id;
    };
    const own = await makeCall({ callSessionId: await session(agentUser.id, agentProfile.id) });
    const theirs = await makeCall({ callSessionId: await session(otherAgentUser.id, otherAgentProfile.id) });
    const unlinked = await makeCall();
    const ok = await listen(agentUser.id, own.transcriptId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const denied = await listen(agentUser.id, theirs.transcriptId);
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe("not_found");
    expect(await listenAudits(theirs.transcriptId)).toHaveLength(0);
    // A call not linked to any phone session belongs to no agent.
    await listen(agentUser.id, unlinked.transcriptId).expect(404);
    const audits = await listenAudits(own.transcriptId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(agentUser.id);
  });

  it("another agency gets the same 404 as a missing call; read-only users 403; signed-out 401", async () => {
    const { transcriptId } = await makeCall();
    const other = await listen(otherAdmin.id, transcriptId);
    const missing = await listen(otherAdmin.id, "does-not-exist");
    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    await listen(viewer.id, transcriptId).expect(403);
    await request(app).get(`/api/call-scoring/transcripts/${transcriptId}/audio`).expect(401);
    expect(await listenAudits(transcriptId)).toHaveLength(0);
  });
});
