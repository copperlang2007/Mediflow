/**
 * "This voice is the agent": save a reviewer's choice on a recording's
 * transcript, then score the call again so every check uses the right person.
 *
 * Nothing is guessed. The choice, who made it and when are kept sealed with the
 * transcript; the audit log gets counts only, never words. The earlier score
 * stays as history (a rescore adds a new result; reviews are not carried over).
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { auditLogTable, callTranscriptsTable, db } from "@workspace/db";
import { rescoreTranscript, type IngestResult } from "./ingest";
import { seal } from "./seal";
import { applyAgentSpeaker } from "./speakerRoles";
import { loadTranscriptRow, openTranscript } from "./store";
import type { Rubric } from "./types";

type Failure = Extract<IngestResult, { kind: "error" }>;

export async function assignAgentSpeaker(input: {
  orgId: string;
  userId: string;
  userRole: string;
  transcriptId: string;
  agentLabel: string;
  rubric: Rubric;
  aiMode: "auto" | "off";
}): Promise<IngestResult> {
  const fail = (httpStatus: number, code: string, message: string): Failure => ({ kind: "error", httpStatus, code, message });

  const row = await loadTranscriptRow(db, input.orgId, input.transcriptId);
  if (!row) return fail(404, "not_found", "Transcript not found.");
  const payload = openTranscript(row);
  if (!payload || !payload.utterances.length) {
    return fail(409, "text_unavailable", "The transcript text is no longer available to score.");
  }
  const applied = applyAgentSpeaker(payload.utterances, input.agentLabel);
  if (!applied.ok) return fail(422, "speaker_not_assignable", applied.message);

  const saved = await db.transaction(async (tx) => {
    const updated = await tx
      .update(callTranscriptsTable)
      .set({
        transcriptEncrypted: seal({
          ...payload,
          utterances: applied.utterances,
          speakerAssignment: { agentLabel: input.agentLabel, userId: input.userId, at: new Date().toISOString() },
        }),
        speakerMode: applied.speakerMode,
      })
      .where(and(eq(callTranscriptsTable.id, row.id), eq(callTranscriptsTable.orgId, input.orgId), isNull(callTranscriptsTable.purgedAt)))
      .returning({ id: callTranscriptsTable.id });
    if (!updated.length) return false;
    await tx.insert(auditLogTable).values({
      id: randomUUID(),
      orgId: input.orgId,
      userId: input.userId,
      userRole: input.userRole,
      action: "call_speaker_assigned",
      resourceType: "call_transcript",
      resourceId: row.id,
      changes: {
        speakerMode: applied.speakerMode,
        agentTurns: applied.utterances.filter((u) => u.role === "agent").length,
        clientTurns: applied.utterances.filter((u) => u.role === "client").length,
      },
    });
    return true;
  });
  if (!saved) return fail(409, "text_unavailable", "The transcript text is no longer available to score.");

  return rescoreTranscript({
    orgId: input.orgId,
    userId: input.userId,
    userRole: input.userRole,
    transcriptId: row.id,
    rubric: input.rubric,
    aiMode: input.aiMode,
  });
}
