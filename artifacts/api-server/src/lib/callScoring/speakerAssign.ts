/**
 * "This voice is the agent": save a reviewer's choice on a recording's
 * transcript, then score the call again so every check uses the right person.
 *
 * Nothing is guessed. The choice, who made it and when are kept sealed with the
 * transcript; the audit log gets counts only, never words. The earlier score
 * stays as history (a rescore adds a new result; reviews are not carried over).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { auditLogTable, callScoresTable, callTranscriptsTable, db } from "@workspace/db";
import { logger } from "../logger";
import { rescoreTranscript, type IngestResult } from "./ingest";
import { open, seal, type TranscriptPayload } from "./seal";
import { applyAgentSpeaker } from "./speakerRoles";
import { loadTranscriptRow } from "./store";
import type { Rubric } from "./types";

type Failure = Extract<IngestResult, { kind: "error" }>;
type Saved = { ok: true } | { ok: false; failure: Failure };

export async function assignAgentSpeaker(input: {
  orgId: string;
  userId: string;
  userRole: string;
  transcriptId: string;
  agentLabel: string;
  rubric: Rubric;
  /** Omit to keep however the call was scored before: rules-only stays rules-only. */
  aiMode?: "auto" | "off";
  /** Test seam: the scoring step that follows the save. */
  rescore?: typeof rescoreTranscript;
}): Promise<IngestResult> {
  const fail = (httpStatus: number, code: string, message: string): Failure => ({ kind: "error", httpStatus, code, message });

  const row = await loadTranscriptRow(db, input.orgId, input.transcriptId);
  if (!row) return fail(404, "not_found", "Transcript not found.");

  // A call deliberately scored rules-only must not start going to the AI reviewer just because a speaker was chosen.
  let aiMode = input.aiMode;
  if (!aiMode) {
    const [latest] = await db
      .select({ ai: callScoresTable.aiStatus })
      .from(callScoresTable)
      .where(and(eq(callScoresTable.transcriptId, row.id), eq(callScoresTable.orgId, input.orgId)))
      .orderBy(desc(callScoresTable.createdAt), desc(callScoresTable.id))
      .limit(1);
    aiMode = latest?.ai === "skipped" ? "off" : "auto";
  }

  // Marks this choice. A scoring run only saves if this is still the latest choice.
  const assignedAt = new Date().toISOString();
  const assignmentId = randomUUID();
  const saved: Saved = await db.transaction(async (tx) => {
    // Read the sealed text again under a row lock, so a choice someone else made a
    // moment ago is built on, never overwritten with an older copy.
    const [current] = await tx
      .select({ sealed: callTranscriptsTable.transcriptEncrypted })
      .from(callTranscriptsTable)
      .where(and(eq(callTranscriptsTable.id, row.id), eq(callTranscriptsTable.orgId, input.orgId), isNull(callTranscriptsTable.purgedAt)))
      .for("update")
      .limit(1);
    const payload = open<TranscriptPayload>(current?.sealed);
    if (!payload || !payload.utterances.length) {
      return { ok: false, failure: fail(409, "text_unavailable", "The transcript text is no longer available to score.") };
    }
    const applied = applyAgentSpeaker(payload.utterances, input.agentLabel, { reassigning: Boolean(payload.speakerAssignment) });
    if (!applied.ok) return { ok: false, failure: fail(422, "speaker_not_assignable", applied.message) };

    await tx
      .update(callTranscriptsTable)
      .set({
        transcriptEncrypted: seal({
          ...payload,
          utterances: applied.utterances,
          speakerAssignment: { agentLabel: input.agentLabel, userId: input.userId, at: assignedAt, id: assignmentId },
        }),
        speakerMode: applied.speakerMode,
      })
      .where(and(eq(callTranscriptsTable.id, row.id), eq(callTranscriptsTable.orgId, input.orgId)));
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
    return { ok: true };
  });
  if (!saved.ok) return saved.failure;

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
      aiMode,
      // Two reviewers choosing at once: only the latest choice may save a score.
      stillOwned: async (tx) => {
        // Locked until the score is committed: a newer choice waits for it. (Taken exclusively from the start,
        // because the score save writes to this row too and a share-then-update upgrade can deadlock.)
        const [current] = await tx
          .select({ sealed: callTranscriptsTable.transcriptEncrypted })
          .from(callTranscriptsTable)
          .where(and(eq(callTranscriptsTable.id, row.id), eq(callTranscriptsTable.orgId, input.orgId)))
          .for("update")
          .limit(1);
        return open<TranscriptPayload>(current?.sealed)?.speakerAssignment?.id === assignmentId;
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
