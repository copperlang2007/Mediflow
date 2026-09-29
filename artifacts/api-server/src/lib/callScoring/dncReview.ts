/**
 * The do-not-contact review queue and its resolution.
 *
 * The detector (dnc.ts) only ever RAISES a possible request. Nothing changes
 * until a person resolves it here:
 *
 *  - "add_opt_out": records the opt-out through lib/compliance/optOut
 *    (`recordPhoneOptOut`, source "call_review"), which is idempotent, and
 *    writes an audit row in the same transaction. It needs a contact or a
 *    phone number. If the number matches several contacts and the transcript
 *    was not linked to one, the reviewer must pick.
 *  - "dismiss": records why it is not a request (a note is required).
 *
 * A resolution is unique per (org, transcript, position) in the database, so
 * two reviewers clicking at once produce exactly one opt-out and one audit row,
 * and a rescore cannot re-open a resolved request.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLogTable,
  callScoreFindingsTable,
  callScoreReviewsTable,
  callTranscriptsTable,
  contactsTable,
  db,
  optOutsTable,
  usersTable,
  agentsTable,
} from "@workspace/db";
import { recordPhoneOptOut } from "../compliance/optOut";
import { phoneMatchKey, phoneMatchKeySql } from "../compliance/phone";
import { normalizePhone } from "../csvImport";
import { matchContactByPhone, openTranscript, type AnyDb } from "./store";
import { open, seal } from "./seal";

export type DncAction = "add_opt_out" | "dismiss";
export type DncStatus = "open" | "opt_out_added" | "dismissed";

export interface DncCandidate {
  id: string;
  name: string;
  phoneLast4: string | null;
}

export interface DncQueueItem {
  findingId: string;
  transcriptId: string;
  fingerprint: string;
  status: DncStatus;
  quote: string | null;
  speaker: "client" | "unknown";
  utteranceIndex: number | null;
  startOffset: number | null;
  endOffset: number | null;
  startSeconds: number | null;
  createdAt: string;
  callDate: string | null;
  externalRef: string | null;
  speakerMode: string;
  contact: { id: string; name: string; phoneLast4: string | null } | null;
  contactMatch: string;
  /** Contacts sharing the transcript's phone number, when it was ambiguous. */
  candidates: DncCandidate[];
  agent: { id: string; name: string } | null;
  resolution: { action: DncAction; note: string | null; reviewerName: string | null; at: string } | null;
}

const last4 = (phone: string | null | undefined): string | null => {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
};
const fullName = (f: string | null, l: string | null) => `${f ?? ""} ${l ?? ""}`.trim() || "Unnamed contact";

/**
 * Possible do-not-contact requests from the CURRENT score of each transcript
 * (a superseded score's flags are not double counted).
 */
export async function listDncQueue(
  handle: AnyDb,
  args: { orgId: string; status: "open" | "resolved" | "all"; limit: number; offset: number },
): Promise<{ items: DncQueueItem[]; total: number }> {
  const f = callScoreFindingsTable;
  const currentScores = sql`(SELECT DISTINCT ON (transcript_id) id FROM call_scores WHERE org_id = ${args.orgId} ORDER BY transcript_id, created_at DESC, id DESC)`;
  const resolvedExists = sql`EXISTS (SELECT 1 FROM call_score_reviews r WHERE r.org_id = ${f.orgId} AND r.transcript_id = ${f.transcriptId} AND r.kind = 'dnc_resolution' AND r.fingerprint = ${f.fingerprint})`;
  const where = and(
    eq(f.orgId, args.orgId),
    eq(f.kind, "dnc"),
    sql`${f.scoreId} IN ${currentScores}`,
    args.status === "open" ? sql`NOT ${resolvedExists}` : args.status === "resolved" ? resolvedExists : undefined,
  );

  const [{ n } = { n: 0 }] = await handle.select({ n: sql<number>`count(*)::int` }).from(f).where(where);
  const rows = await handle
    .select({
      finding: f,
      contactId: callTranscriptsTable.contactId,
      contactMatch: callTranscriptsTable.contactMatch,
      agentId: callTranscriptsTable.agentId,
      callDate: callTranscriptsTable.callDate,
      externalRef: callTranscriptsTable.externalRef,
      speakerMode: callTranscriptsTable.speakerMode,
      transcriptEncrypted: callTranscriptsTable.transcriptEncrypted,
    })
    .from(f)
    .innerJoin(callTranscriptsTable, and(eq(callTranscriptsTable.id, f.transcriptId), eq(callTranscriptsTable.orgId, f.orgId)))
    .where(where)
    .orderBy(desc(f.createdAt), desc(f.id))
    .limit(args.limit)
    .offset(args.offset);

  const items: DncQueueItem[] = [];
  for (const r of rows) {
    const payload = open<{ quote: string | null }>(r.finding.evidenceEncrypted);
    const [resolution] = await handle
      .select({
        verdict: callScoreReviewsTable.verdict,
        note: callScoreReviewsTable.noteEncrypted,
        at: callScoreReviewsTable.createdAt,
        reviewerName: usersTable.fullName,
      })
      .from(callScoreReviewsTable)
      .leftJoin(usersTable, eq(usersTable.id, callScoreReviewsTable.reviewerUserId))
      .where(
        and(
          eq(callScoreReviewsTable.orgId, args.orgId),
          eq(callScoreReviewsTable.transcriptId, r.finding.transcriptId),
          eq(callScoreReviewsTable.kind, "dnc_resolution"),
          eq(callScoreReviewsTable.fingerprint, r.finding.fingerprint),
        ),
      )
      .limit(1);

    let contact: DncQueueItem["contact"] = null;
    if (r.contactId) {
      const [c] = await handle
        .select({ id: contactsTable.id, first: contactsTable.firstName, last: contactsTable.lastName, phone: contactsTable.phone })
        .from(contactsTable)
        .where(and(eq(contactsTable.id, r.contactId), eq(contactsTable.orgId, args.orgId)))
        .limit(1);
      if (c) contact = { id: c.id, name: fullName(c.first, c.last), phoneLast4: last4(c.phone) };
    }
    let candidates: DncCandidate[] = [];
    if (!contact && r.contactMatch === "phone_ambiguous") {
      const phone = open<{ phone: string | null }>(r.transcriptEncrypted)?.phone ?? null;
      if (phone) {
        const m = await matchContactByPhone(handle, args.orgId, phone);
        for (const id of m.candidateIds) {
          const [c] = await handle
            .select({ id: contactsTable.id, first: contactsTable.firstName, last: contactsTable.lastName, phone: contactsTable.phone })
            .from(contactsTable)
            .where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, args.orgId)))
            .limit(1);
          if (c) candidates.push({ id: c.id, name: fullName(c.first, c.last), phoneLast4: last4(c.phone) });
        }
      }
    }
    let agent: DncQueueItem["agent"] = null;
    if (r.agentId) {
      const [a] = await handle
        .select({ id: agentsTable.id, first: agentsTable.firstName, last: agentsTable.lastName })
        .from(agentsTable)
        .where(and(eq(agentsTable.id, r.agentId), eq(agentsTable.orgId, args.orgId)))
        .limit(1);
      if (a) agent = { id: a.id, name: fullName(a.first, a.last) };
    }
    const note = resolution ? open<{ note: string }>(resolution.note)?.note ?? null : null;
    items.push({
      findingId: r.finding.id,
      transcriptId: r.finding.transcriptId,
      fingerprint: r.finding.fingerprint,
      status: resolution ? (resolution.verdict === "opt_out_added" ? "opt_out_added" : "dismissed") : "open",
      quote: payload?.quote ?? null,
      speaker: r.finding.speaker === "client" ? "client" : "unknown",
      utteranceIndex: r.finding.utteranceIndex,
      startOffset: r.finding.startOffset,
      endOffset: r.finding.endOffset,
      startSeconds: r.finding.startSeconds,
      createdAt: r.finding.createdAt.toISOString(),
      callDate: r.callDate ? r.callDate.toISOString() : null,
      externalRef: r.externalRef,
      speakerMode: r.speakerMode,
      contact,
      contactMatch: r.contactMatch,
      candidates,
      agent,
      resolution: resolution
        ? {
            action: resolution.verdict === "opt_out_added" ? "add_opt_out" : "dismiss",
            note,
            reviewerName: resolution.reviewerName,
            at: resolution.at.toISOString(),
          }
        : null,
    });
  }
  return { items, total: n };
}

export type ResolveResult =
  | {
      ok: true;
      status: "resolved" | "already_resolved";
      action: DncAction;
      optOut: { phonesRecorded: number; alreadyOnList: number; contactId: string | null } | null;
    }
  | { ok: false; httpStatus: number; code: string; message: string; candidates?: DncCandidate[] };

const actionOf = (verdict: string): DncAction => (verdict === "opt_out_added" ? "add_opt_out" : "dismiss");

/** E.164 for a 10/11-digit US number, the raw text otherwise; null when there are fewer than 10 digits. */
function dialable(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = phoneMatchKey(raw);
  if (!key || key.length < 10) return null;
  return normalizePhone(raw) ?? raw.trim();
}

export async function resolveDncFinding(args: {
  orgId: string;
  userId: string;
  userRole: string;
  findingId: string;
  action: DncAction;
  note?: string | undefined;
  contactId?: string | undefined;
  phone?: string | undefined;
}): Promise<ResolveResult> {
  const { orgId } = args;
  const [finding] = await db
    .select()
    .from(callScoreFindingsTable)
    .where(and(eq(callScoreFindingsTable.id, args.findingId), eq(callScoreFindingsTable.orgId, orgId), eq(callScoreFindingsTable.kind, "dnc")))
    .limit(1);
  if (!finding) return { ok: false, httpStatus: 404, code: "not_found", message: "Request not found." };
  const [transcript] = await db
    .select()
    .from(callTranscriptsTable)
    .where(and(eq(callTranscriptsTable.id, finding.transcriptId), eq(callTranscriptsTable.orgId, orgId)))
    .limit(1);
  if (!transcript) return { ok: false, httpStatus: 404, code: "not_found", message: "Request not found." };

  const existingFor = async (h: AnyDb) => {
    const [row] = await h
      .select({ verdict: callScoreReviewsTable.verdict, contactId: callScoreReviewsTable.contactId })
      .from(callScoreReviewsTable)
      .where(
        and(
          eq(callScoreReviewsTable.orgId, orgId),
          eq(callScoreReviewsTable.transcriptId, transcript.id),
          eq(callScoreReviewsTable.kind, "dnc_resolution"),
          eq(callScoreReviewsTable.fingerprint, finding.fingerprint),
        ),
      )
      .limit(1);
    return row ?? null;
  };
  const alreadyResult = (verdict: string, contactId: string | null): ResolveResult =>
    actionOf(verdict) === args.action
      ? {
          ok: true,
          status: "already_resolved",
          action: args.action,
          optOut: args.action === "add_opt_out" ? { phonesRecorded: 0, alreadyOnList: 0, contactId } : null,
        }
      : {
          ok: false,
          httpStatus: 409,
          code: "already_resolved",
          message: `This request was already resolved as "${actionOf(verdict) === "add_opt_out" ? "opt-out added" : "dismissed"}".`,
        };

  const prior = await existingFor(db);
  if (prior) return alreadyResult(prior.verdict, prior.contactId);

  const note = args.note?.trim() ?? "";
  const reviewBase = {
    orgId,
    transcriptId: transcript.id,
    scoreId: finding.scoreId,
    kind: "dnc_resolution" as const,
    fingerprint: finding.fingerprint,
    reviewerUserId: args.userId,
    reviewerRole: args.userRole,
    noteEncrypted: note ? seal({ note }) : null,
  };
  const audit = (action: string, changes: Record<string, unknown>) => ({
    id: randomUUID(),
    orgId,
    userId: args.userId,
    userRole: args.userRole,
    action,
    resourceType: "call_transcript",
    resourceId: transcript.id,
    // Never the quote, the phone number, or the note.
    changes: { findingId: finding.id, fingerprint: finding.fingerprint, ...changes },
  });

  if (args.action === "dismiss") {
    if (note.length < 3) {
      return { ok: false, httpStatus: 400, code: "note_required", message: "Say why this is not a do-not-contact request (a short note)." };
    }
    return db.transaction(async (tx): Promise<ResolveResult> => {
      const [inserted] = await tx
        .insert(callScoreReviewsTable)
        .values({ id: randomUUID(), ...reviewBase, verdict: "dismissed", optOutRecorded: false })
        .onConflictDoNothing()
        .returning({ id: callScoreReviewsTable.id });
      if (!inserted) {
        const again = await existingFor(tx);
        return again ? alreadyResult(again.verdict, again.contactId) : { ok: false, httpStatus: 409, code: "conflict", message: "Try again." };
      }
      await tx.insert(auditLogTable).values(audit("call_dnc_dismiss", { via: "call_review" }));
      return { ok: true, status: "resolved", action: "dismiss", optOut: null };
    });
  }

  // ---- add_opt_out: never automatic, always a person's click ----------------
  let contact: { id: string; phone: string | null } | null = null;
  const wantedContactId = args.contactId ?? transcript.contactId ?? null;
  if (wantedContactId) {
    const [c] = await db
      .select({ id: contactsTable.id, phone: contactsTable.phone })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, wantedContactId), eq(contactsTable.orgId, orgId), sql`${contactsTable.deletedAt} IS NULL`))
      .limit(1);
    if (!c && args.contactId) return { ok: false, httpStatus: 404, code: "contact_not_found", message: "Contact not found." };
    contact = c ?? null;
  }
  const payload = openTranscript(transcript);
  if (!contact && transcript.contactMatch === "phone_ambiguous") {
    const candidates: DncCandidate[] = [];
    const m = payload?.phone ? await matchContactByPhone(db, orgId, payload.phone) : null;
    for (const id of m?.candidateIds ?? []) {
      const [c] = await db
        .select({ id: contactsTable.id, first: contactsTable.firstName, last: contactsTable.lastName, phone: contactsTable.phone })
        .from(contactsTable)
        .where(and(eq(contactsTable.id, id), eq(contactsTable.orgId, orgId)))
        .limit(1);
      if (c) candidates.push({ id: c.id, name: fullName(c.first, c.last), phoneLast4: last4(c.phone) });
    }
    return {
      ok: false,
      httpStatus: 409,
      code: "pick_contact",
      message: "More than one client uses this phone number. Pick the right one (or enter a number) before adding the opt-out.",
      candidates,
    };
  }

  const phones: string[] = [];
  const seen = new Set<string>();
  for (const raw of [contact?.phone, payload?.phone, args.phone]) {
    const p = dialable(raw);
    const key = p ? phoneMatchKey(p) : null;
    if (p && key && !seen.has(key)) {
      seen.add(key);
      phones.push(p);
    }
  }
  if (!phones.length) {
    return {
      ok: false,
      httpStatus: 400,
      code: "phone_required",
      message: "An opt-out needs a client with a phone number, or a phone number typed in.",
    };
  }

  return db.transaction(async (tx): Promise<ResolveResult> => {
    // The unique index makes this the single winner if two people click at once.
    const [inserted] = await tx
      .insert(callScoreReviewsTable)
      .values({ id: randomUUID(), ...reviewBase, verdict: "opt_out_added", contactId: contact?.id ?? null, optOutRecorded: true })
      .onConflictDoNothing()
      .returning({ id: callScoreReviewsTable.id });
    if (!inserted) {
      const again = await existingFor(tx);
      return again ? alreadyResult(again.verdict, again.contactId) : { ok: false, httpStatus: 409, code: "conflict", message: "Try again." };
    }
    let alreadyOnList = 0;
    for (const phone of phones) {
      const key = phoneMatchKey(phone)!;
      const [existing] = await tx
        .select({ id: optOutsTable.id })
        .from(optOutsTable)
        .where(and(eq(optOutsTable.orgId, orgId), sql`${phoneMatchKeySql(optOutsTable.phone)} = ${key}`))
        .limit(1);
      if (existing) alreadyOnList++;
      await recordPhoneOptOut(tx, { orgId, contactId: contact?.id ?? null, phone, source: "call_review" });
    }
    if (contact && contact.id !== transcript.contactId) {
      // The reviewer identified the client: keep that on the record.
      await tx
        .update(callTranscriptsTable)
        .set({ contactId: contact.id, contactMatch: "explicit" })
        .where(and(eq(callTranscriptsTable.id, transcript.id), eq(callTranscriptsTable.orgId, orgId)));
    }
    await tx
      .insert(auditLogTable)
      .values(audit("call_dnc_opt_out", { via: "call_review", contactId: contact?.id ?? null, phonesRecorded: phones.length, alreadyOnList }));
    return { ok: true, status: "resolved", action: "add_opt_out", optOut: { phonesRecorded: phones.length, alreadyOnList, contactId: contact?.id ?? null } };
  });
}
