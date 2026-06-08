/**
 * Phase 5 — in-platform transcript parsing + agent-assist (spec §6
 * call.transcript.ready, §8 AI consolidation, §10 Phase 5 row).
 *
 * Exit criterion under test: a `call.transcript.ready` event is parsed
 * IN-PLATFORM via the MediFlow AI provider and the structured result is
 * persisted on the dial ticket — and no PHI is ever sent to the dialer's LLM
 * path. We assert:
 *
 *   - call.transcript.ready triggers a parse via a MOCKED aiProvider client
 *     and persists the structured result (+ an audit row).
 *   - the parse goes through the aiProvider path (the injected client's
 *     chat.completions.create is the only thing invoked) — not a direct SDK.
 *   - NO outbound HTTP call to the dialer happens during parsing (global fetch
 *     is never touched; the dialer is never contacted).
 *   - a non-transcript event does not parse.
 *   - the transcript-ready → transcript-purged interaction still works (the
 *     hash is recorded and a matching purge confirms), and parsing does not
 *     retain raw transcript text on the ticket (only the hash + parsed result).
 *
 * The AI client is INJECTED, so the suite is fully offline.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto, { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";

const { dbF } = vi.hoisted(() => ({
  dbF: async (): Promise<Record<string, unknown>> => {
    const { dbMockFactory } = await import("../helpers/testApp");
    return dbMockFactory();
  },
}));
vi.mock("@workspace/db", dbF);

import { bootTestDb, shutdownTestDb } from "../helpers/testApp";
import { seedOrg, seedUser } from "../helpers/testDb";
import type { TestDb } from "../helpers/testDb";
import type { TranscriptAiClient } from "../../lib/dialer/transcriptParse";

let db: TestDb;
let dispatchEvent: typeof import("../../lib/dialer/handlers").dispatchEvent;
let transcriptHash: typeof import("../../lib/dialer/handlers").transcriptHash;
let dialTicketsTable: typeof import("@workspace/db").dialTicketsTable;
let auditLogTable: typeof import("@workspace/db").auditLogTable;
let taskInstancesTable: typeof import("@workspace/db").taskInstancesTable;

beforeAll(async () => {
  const handle = await bootTestDb();
  db = handle.db;
  const handlers = await import("../../lib/dialer/handlers");
  dispatchEvent = handlers.dispatchEvent;
  transcriptHash = handlers.transcriptHash;
  const dbExports = await import("@workspace/db");
  dialTicketsTable = dbExports.dialTicketsTable;
  auditLogTable = dbExports.auditLogTable;
  taskInstancesTable = dbExports.taskInstancesTable;
});

afterAll(async () => {
  await shutdownTestDb();
});

const ASSIST_JSON = JSON.stringify({
  summary: "The beneficiary asked about a plan change and requested a callback.",
  suggestedDisposition: { code: "CALLBACK", category: "FOLLOW_UP", confidence: 0.8 },
  riskFlags: [
    { kind: "SOA_GAP", severity: "medium", detail: "No scope of appointment on file." },
  ],
  actionItems: ["Schedule a follow-up call", "Collect a signed SOA"],
});

/**
 * A mock AI client matching the injectable `TranscriptAiClient` surface. It
 * records its calls so we can assert the parse went through the aiProvider
 * path (and not a direct SDK construction or a dialer round-trip).
 */
function mockAiClient(content: string = ASSIST_JSON): {
  client: TranscriptAiClient;
  calls: { model: string; messages: unknown }[];
} {
  const calls: { model: string; messages: unknown }[] = [];
  const client: TranscriptAiClient = {
    chat: {
      completions: {
        create: async (args) => {
          calls.push({ model: args.model, messages: args.messages });
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  return { client, calls };
}

async function seedTicket(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(dialTicketsTable).values({ id, orgId, status: "ISSUED" });
  return id;
}

function readyEnvelope(orgId: string, ticketId: string, transcript: string) {
  return {
    eventId: `evt_${randomUUID()}`,
    schemaVersion: 1,
    type: "call.transcript.ready",
    occurredAt: new Date().toISOString(),
    orgId,
    dialTicketId: ticketId,
    data: { transcriptText: transcript, redacted: false },
  };
}

describe("Phase 5 — in-platform transcript parsing (§6, §8)", () => {
  it("parses on call.transcript.ready via the injected AI client and persists the structured result", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const ticketId = await seedTicket(org.id);
    const transcript = "Agent: Hello. Beneficiary: I'd like a callback about my plan.";
    const { client, calls } = mockAiClient();

    const env = readyEnvelope(org.id, ticketId, transcript);
    const result = await dispatchEvent(env, { aiClient: client });
    expect(result).toMatchObject({ ok: true, handled: true, note: "transcript_parsed" });

    // The parse went through the injected aiProvider path exactly once.
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBeTypeOf("string");

    const [ticket] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));

    // Structured agent-assist persisted.
    const parsed = ticket?.transcriptParsed as Record<string, unknown>;
    expect(parsed).toBeTruthy();
    expect(parsed.summary).toContain("callback");
    expect((parsed.suggestedDisposition as Record<string, unknown>).category).toBe("FOLLOW_UP");
    expect(parsed.riskFlags).toHaveLength(1);
    expect(parsed.actionItems).toHaveLength(2);
    expect(ticket?.transcriptParsedAt).not.toBeNull();

    // Transcript hash recorded (anchors the later purge, §6.1) and the raw
    // transcript text is NOT retained on the ticket.
    expect(ticket?.transcriptHash).toBe(transcriptHash(transcript));
    expect(JSON.stringify(ticket)).not.toContain(transcript);
  });

  it("audits the in-platform parse (resourceType dialer_transcript_parsed, parsedInPlatform=true)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const ticketId = await seedTicket(org.id);
    const { client } = mockAiClient();

    const env = readyEnvelope(org.id, ticketId, "Some call transcript.");
    await dispatchEvent(env, { aiClient: client });

    const audit = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, org.id),
          eq(auditLogTable.resourceType, "dialer_transcript_parsed"),
          eq(auditLogTable.resourceId, ticketId),
        ),
      );
    expect(audit).toHaveLength(1);
    const changes = audit[0].changes as Record<string, unknown>;
    expect(changes.parsedInPlatform).toBe(true);
    expect(changes.eventId).toBe(env.eventId);
    // No raw transcript in the audit trail.
    expect(JSON.stringify(changes)).not.toContain("Some call transcript");
  });

  it("does NOT contact the dialer (no outbound fetch) during parsing — PHI stays MediFlow-side", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const ticketId = await seedTicket(org.id);
    const { client } = mockAiClient();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const env = readyEnvelope(org.id, ticketId, "Transcript with PHI-like content.");
      await dispatchEvent(env, { aiClient: client });
      // Parsing must never make an outbound HTTP call (the only AI egress is
      // the injected client; the dialer is never contacted).
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does NOT parse a non-transcript event", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const ticketId = await seedTicket(org.id);
    const { client, calls } = mockAiClient();

    const env = {
      eventId: `evt_${randomUUID()}`,
      schemaVersion: 1,
      type: "call.completed",
      occurredAt: new Date().toISOString(),
      orgId: org.id,
      dialTicketId: ticketId,
      dialerCallId: `call_${randomUUID().slice(0, 8)}`,
      data: { duration: 30, endedReason: "COMPLETED" },
    };
    await dispatchEvent(env, { aiClient: client });

    expect(calls).toHaveLength(0);
    const [ticket] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    expect(ticket?.transcriptParsed).toBeNull();
    expect(ticket?.transcriptParsedAt).toBeNull();
  });

  it("acks (does not throw) when AI is unavailable — parse is best-effort", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const ticketId = await seedTicket(org.id);

    // Inject `null` to simulate an unconfigured AI provider.
    const env = readyEnvelope(org.id, ticketId, "Transcript text.");
    const result = await dispatchEvent(env, { aiClient: null });
    expect(result).toMatchObject({ ok: true, handled: true, note: "transcript_ready_unparsed" });

    const [ticket] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    // Hash still recorded (purge can still be verified) but no parsed result.
    expect(ticket?.transcriptHash).toBe(transcriptHash("Transcript text."));
    expect(ticket?.transcriptParsed).toBeNull();
  });

  it("records the hash so a matching transcript.purged still confirms (§6.1 interaction)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const ticketId = await seedTicket(org.id);
    const transcript = "Call transcript for purge interaction.";
    const hash = crypto.createHash("sha256").update(transcript, "utf8").digest("hex");
    const { client } = mockAiClient();

    await dispatchEvent(readyEnvelope(org.id, ticketId, transcript), { aiClient: client });

    const purged = {
      eventId: `evt_${randomUUID()}`,
      schemaVersion: 1,
      type: "call.transcript.purged",
      occurredAt: new Date().toISOString(),
      orgId: org.id,
      dialTicketId: ticketId,
      data: { purgedAt: new Date().toISOString(), transcriptHash: hash },
    };
    await dispatchEvent(purged);

    const [ticket] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    expect(ticket?.transcriptHash).toBe(hash);
    expect(ticket?.transcriptPurgeConfirmedAt).not.toBeNull();
    // The parsed agent-assist survives the purge (it's derived, non-raw).
    expect(ticket?.transcriptParsed).toBeTruthy();
  });
});

describe("Phase 5 — auto compliance flagging from a flagged transcript (§6, §9)", () => {
  /** Parse result: model suggests a COMPLIANCE-category disposition. */
  const COMPLIANCE_CATEGORY_JSON = JSON.stringify({
    summary: "The beneficiary asked not to be contacted again.",
    suggestedDisposition: { code: "DNC_REQUEST", category: "COMPLIANCE", confidence: 0.9 },
    riskFlags: [
      { kind: "DNC_REQUEST", severity: "medium", detail: "Beneficiary requested do-not-call." },
    ],
    actionItems: ["Add to internal DNC list"],
  });

  /** Parse result: clean call, but ONE high-severity risk flag present. */
  const HIGH_SEVERITY_JSON = JSON.stringify({
    summary: "Standard sales call; possible scope-of-appointment issue.",
    suggestedDisposition: { code: "CALLBACK", category: "FOLLOW_UP", confidence: 0.7 },
    riskFlags: [
      { kind: "SOA_GAP", severity: "high", detail: "Agent discussed products outside the agreed scope." },
    ],
    actionItems: ["Obtain a corrected SOA"],
  });

  /** Parse result: clean — non-COMPLIANCE category, only low/medium flags. */
  const CLEAN_JSON = JSON.stringify({
    summary: "Friendly informational call; no concerns.",
    suggestedDisposition: { code: "CALLBACK", category: "FOLLOW_UP", confidence: 0.8 },
    riskFlags: [
      { kind: "SOA_GAP", severity: "medium", detail: "No SOA on file yet." },
    ],
    actionItems: ["Schedule a follow-up"],
  });

  it("raises an oversight task when the parse suggests a COMPLIANCE disposition, assigned to the compliance manager", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    const cm = await seedUser(db, { orgId: org.id, role: "compliance_manager" });
    const ticketId = await seedTicket(org.id);
    const { client } = mockAiClient(COMPLIANCE_CATEGORY_JSON);

    const env = readyEnvelope(org.id, ticketId, "Beneficiary: please don't call me again.");
    const result = await dispatchEvent(env, { aiClient: client });
    // Storing the parse still happens, and the webhook still acks.
    expect(result).toMatchObject({ ok: true, handled: true, note: "transcript_parsed" });
    const [ticket] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    expect(ticket?.transcriptParsed).toBeTruthy();

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].orgId).toBe(org.id);
    expect(tasks[0].status).toBe("open");
    expect(tasks[0].priority).toBe("urgent");
    expect(tasks[0].assignedToUserId).toBe(cm.id);
    expect(tasks[0].title.toLowerCase()).toContain("compliance");

    // Audited as a compliance oversight task with the transcript trigger.
    const audit = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.orgId, org.id),
          eq(auditLogTable.resourceType, "compliance_oversight_task"),
          eq(auditLogTable.resourceId, tasks[0].id),
        ),
      );
    expect(audit).toHaveLength(1);
    const changes = audit[0].changes as Record<string, unknown>;
    expect(changes.trigger).toBe("transcript");
    expect(changes.eventId).toBe(env.eventId);
  });

  it("raises an oversight task when the parse carries a high-severity risk flag (non-COMPLIANCE category)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    await seedUser(db, { orgId: org.id, role: "agency_admin" });
    const ticketId = await seedTicket(org.id);
    const { client } = mockAiClient(HIGH_SEVERITY_JSON);

    const env = readyEnvelope(org.id, ticketId, "Agent: let me also tell you about a dental plan…");
    await dispatchEvent(env, { aiClient: client });

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    expect(tasks).toHaveLength(1);
    // Falls back to agency_admin when no compliance_manager exists.
    expect(tasks[0].assignedToUserId).not.toBeNull();
  });

  it("does NOT raise a task for a clean parse (non-COMPLIANCE, no high-severity flags)", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    await seedUser(db, { orgId: org.id, role: "compliance_manager" });
    const ticketId = await seedTicket(org.id);
    const { client } = mockAiClient(CLEAN_JSON);

    const env = readyEnvelope(org.id, ticketId, "Agent: thanks for your time today.");
    const result = await dispatchEvent(env, { aiClient: client });
    // Parse still stored; just no oversight task.
    expect(result).toMatchObject({ ok: true, handled: true, note: "transcript_parsed" });
    const [ticket] = await db
      .select()
      .from(dialTicketsTable)
      .where(eq(dialTicketsTable.id, ticketId));
    expect(ticket?.transcriptParsed).toBeTruthy();

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    expect(tasks).toHaveLength(0);
  });

  it("is idempotent — re-processing the same event does not create a second task", async () => {
    const org = await seedOrg(db, { id: `org-${randomUUID().slice(0, 8)}` });
    await seedUser(db, { orgId: org.id, role: "compliance_manager" });
    const ticketId = await seedTicket(org.id);
    const { client } = mockAiClient(COMPLIANCE_CATEGORY_JSON);

    // Same envelope (same eventId) processed twice — simulates a re-entry /
    // reconciliation pass over an already-handled event.
    const env = readyEnvelope(org.id, ticketId, "Beneficiary: stop calling me.");
    await dispatchEvent(env, { aiClient: client });
    await dispatchEvent(env, { aiClient: client });

    const tasks = await db
      .select()
      .from(taskInstancesTable)
      .where(eq(taskInstancesTable.orgId, org.id));
    expect(tasks).toHaveLength(1);
  });
});
