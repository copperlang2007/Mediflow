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
import { logger } from "../logger";
import { rescoreTranscript, type IngestResult } from "./ingest";
import { open, seal, type TranscriptPayload } from "./seal";
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
  /** Test seam: the scoring step that follows the save. */
  rescore?: typeof rescoreTranscript;
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

  // Marks this choice. A scoring run only saves if this is still the latest choice.
  const assignedAt = new Date().toISOString();
  const saved = await db.transaction(async (tx) => {
    const updated = await tx
      .update(callTranscriptsTable)
      .set({
        transcriptEncrypted: seal({
          ...payload,
          utterances: applied.utterances,
          speakerAssignment: { agentLabel: input.agentLabel, userId: input.userId, at: assignedAt },
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

  // The choice is saved by now. If scoring again fails, say so plainly: the roles
  // are kept, the old score is still shown, and pressing the button again retries.
  const notRescored = fail(
    502,
    "rescore_failed",
    "Your choice was saved, but the call could not be scored again just now. The score shown is the earlier one. Press the button again to retry.",
  );
  try {
    const result = await (input.rescore ?? rescoreTranscript)({
      orgId: input.orgId,
      userId: input.userId,
      userRole: input.userRole,
      transcriptId: row.id,
      rubric: input.rubric,
      aiMode: input.aiMode,
      // Two reviewers choosing at once: only the latest choice may save a score.
      stillOwned: async (tx) => {
        const [current] = await tx
          .select({ sealed: callTranscriptsTable.transcriptEncrypted })
          .from(callTranscriptsTable)
          .where(and(eq(callTranscriptsTable.id, row.id), eq(callTranscriptsTable.orgId, input.orgId)))
          .limit(1);
        return open<TranscriptPayload>(current?.sealed)?.speakerAssignment?.at === assignedAt;
      },
    });
    if (result.kind === "duplicate") {
      return fail(409, "superseded", "Someone else chose a different voice for this call just now. Reload the call to see the latest result.");
    }
    return result.kind === "ok" ? result : notRescored;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "unknown", transcriptId: row.id }, "call scoring: rescore after speaker choice failed");
    return notRescored;
  }
}
