/**
 * The do-not-contact review queue and its resolution.
 *
 * The detector (dnc.ts) only ever RAISES a possible request. Nothing changes
 * until a person resolves it here:
 *
 *  - "add_opt_out": records the opt-out through lib/compliance/optOut
 *    (`recordPhoneOptOut`, source "call_review"), which is idempotent, and
 *    writes an audit row in the same transaction. The reviewer must CONFIRM the
 *    single number that asked for no contact (`phoneSource`); only that number
 *    is recorded, and a contact is attached only if it owns that number. If the
 *    number matches several contacts and the transcript was not linked to one,
 *    the reviewer must pick.
 *  - "dismiss": records why it is not a request (a note is required).
 *
 * A resolution is unique per (org, transcript, position) in the database, so
 * two reviewers clicking at once produce exactly one opt-out and one audit row,
 * and a rescore cannot re-open a resolved request.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
  callScoresTable,
} from "@workspace/db";
import { recordEmailOptOut, recordPhoneOptOut } from "../compliance/optOut";
import { phoneMatchKey, phoneMatchKeySql } from "../compliance/phone";
import { normalizePhone } from "../csvImport";
import { MAX_PHONE_CANDIDATES, matchContactByPhone, matchContactsByPhoneKeys, openTranscript, type AnyDb } from "./store";
import { open, seal, type TranscriptPayload } from "./seal";

export type DncAction = "add_opt_out" | "dismiss";
export type DncStatus = "open" | "opt_out_added" | "dismissed";
/** Where the confirmed number comes from: the transcript's, the contact's, or typed by the reviewer. */
export type PhoneSource = "transcript" | "contact" | "typed";

export interface DncCandidate {
  id: string;
  name: string;
  phoneLast4: string | null;
  /** Masked (first letter and domain only). */
  maskedEmail: string | null;
}

/** A number the reviewer may confirm. Only the last four digits are ever sent to the browser. */
export interface DncNumberOption {
  source: "transcript" | "contact";
  last4: string | null;
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
  contact: { id: string; name: string; phoneLast4: string | null; maskedEmail: string | null } | null;
  contactMatch: string;
  /** Contacts sharing the transcript's phone number, when it was ambiguous (bounded). */
  candidates: DncCandidate[];
  /** True when more contacts share the number than `candidates` lists. */
  moreCandidates: boolean;
  /** "email" when the client asked to stop EMAIL only: it is resolved through the email opt-out and needs a linked client with an email. */
  channel: "phone" | "email";
  /** True when the words did not name a channel, so the reviewer confirms which one. */
  channelAssumed: boolean;
  /** For email requests: whether the linked client has an email address on file (never the address itself). */
  emailOnFile: boolean | null;
  /** The numbers on file for this request; the reviewer confirms one (or types another). */
  numbers: DncNumberOption[];
  agent: { id: string; name: string } | null;
  resolution: { action: DncAction; note: string | null; reviewerName: string | null; at: string } | null;
}

/** "jane.doe@example.com" -> "j***@example.com". The full address is never sent to the browser. */
export function maskEmail(email: string | null | undefined): string | null {
  const e = (email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return null;
  return `${e[0]}***${e.slice(at)}`;
}

const last4 = (phone: string | null | undefined): string | null => {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
};
const fullName = (f: string | null, l: string | null) => `${f ?? ""} ${l ?? ""}`.trim() || "Unnamed contact";

/**
 * Possible do-not-contact requests from the CURRENT score of each transcript
 * (a superseded score's flags are not double counted). Everything the page
 * needs (resolutions, contacts, agents, ambiguous matches) is fetched in
 * batches keyed by the page's ids, never per row.
 */
export async function listDncQueue(
  handle: AnyDb,
  args: { orgId: string; status: "open" | "resolved" | "all"; limit: number; offset: number; transcriptId?: string | undefined },
): Promise<{ items: DncQueueItem[]; total: number }> {
  const f = callScoreFindingsTable;
  const currentScores = sql`(SELECT DISTINCT ON (transcript_id) id FROM call_scores WHERE org_id = ${args.orgId} ORDER BY transcript_id, created_at DESC, id DESC)`;
  const resolvedExists = sql`EXISTS (SELECT 1 FROM call_score_reviews r WHERE r.org_id = ${f.orgId} AND r.transcript_id = ${f.transcriptId} AND r.kind = 'dnc_resolution' AND r.fingerprint = ${f.fingerprint})`;
  const where = and(
    eq(f.orgId, args.orgId),
    eq(f.kind, "dnc"),
    sql`${f.scoreId} IN ${currentScores}`,
    args.status === "open" ? sql`NOT ${resolvedExists}` : args.status === "resolved" ? resolvedExists : undefined,
    args.transcriptId ? eq(f.transcriptId, args.transcriptId) : undefined,
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
    })
    .from(f)
    .innerJoin(callTranscriptsTable, and(eq(callTranscriptsTable.id, f.transcriptId), eq(callTranscriptsTable.orgId, f.orgId)))
    .where(where)
    .orderBy(desc(f.createdAt), desc(f.id))
    .limit(args.limit)
    .offset(args.offset);
  if (!rows.length) return { items: [], total: n };

  const transcriptIds = [...new Set(rows.map((r) => r.finding.transcriptId))];

  // One query for every resolution on the page (with the reviewer's name).
  const resolutionRows = await handle
    .select({
      transcriptId: callScoreReviewsTable.transcriptId,
      fingerprint: callScoreReviewsTable.fingerprint,
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
        eq(callScoreReviewsTable.kind, "dnc_resolution"),
        inArray(callScoreReviewsTable.transcriptId, transcriptIds),
      ),
    );
  const resolutions = new Map(resolutionRows.map((x) => [`${x.transcriptId}|${x.fingerprint}`, x]));

  // The encrypted transcript (which holds the phone given with the upload) is
  // NOT part of the page query. It is fetched, in one batch, only for the
  // transcripts that still have an OPEN request on this page: that is the only
  // case where the reviewer needs to see which number to confirm. Resolved
  // rows never decrypt it.
  const openTranscriptIds = [
    ...new Set(rows.filter((r) => !resolutions.has(`${r.finding.transcriptId}|${r.finding.fingerprint}`)).map((r) => r.finding.transcriptId)),
  ];
  const payloadPhone = new Map<string, string | null>();
  if (openTranscriptIds.length) {
    const encRows = await handle
      .select({ id: callTranscriptsTable.id, enc: callTranscriptsTable.transcriptEncrypted })
      .from(callTranscriptsTable)
      .where(and(eq(callTranscriptsTable.orgId, args.orgId), inArray(callTranscriptsTable.id, openTranscriptIds)));
    for (const e of encRows) payloadPhone.set(e.id, open<{ phone: string | null }>(e.enc)?.phone ?? null);
  }

  // One query for the linked contacts, one for the agents.
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => Boolean(x)))];
  const contactRows = contactIds.length
    ? await handle
        .select({ id: contactsTable.id, first: contactsTable.firstName, last: contactsTable.lastName, phone: contactsTable.phone, email: contactsTable.email })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, args.orgId), inArray(contactsTable.id, contactIds)))
    : [];
  const contacts = new Map(contactRows.map((c) => [c.id, c]));
  const agentIds = [...new Set(rows.map((r) => r.agentId).filter((x): x is string => Boolean(x)))];
  const agentRows = agentIds.length
    ? await handle
        .select({ id: agentsTable.id, first: agentsTable.firstName, last: agentsTable.lastName })
        .from(agentsTable)
        .where(and(eq(agentsTable.orgId, args.orgId), inArray(agentsTable.id, agentIds)))
    : [];
  const agents = new Map(agentRows.map((a) => [a.id, a]));

  // Ambiguous phone matches: one query for every distinct number on the page.
  const ambiguousKeys = new Set<string>();
  for (const r of rows) {
    if (r.contactId || r.contactMatch !== "phone_ambiguous") continue;
    if (resolutions.has(`${r.finding.transcriptId}|${r.finding.fingerprint}`)) continue;
    const key = phoneMatchKey(payloadPhone.get(r.finding.transcriptId) ?? null);
    if (key && key.length >= 10) ambiguousKeys.add(key);
  }
  const matches = await matchContactsByPhoneKeys(handle, args.orgId, [...ambiguousKeys]);

  const items: DncQueueItem[] = rows.map((r) => {
    const payload = open<{ quote: string | null; channel?: "phone" | "email"; channelAssumed?: boolean }>(r.finding.evidenceEncrypted);
    const channel: "phone" | "email" = payload?.channel === "email" ? "email" : "phone";
    const channelAssumed = payload?.channelAssumed === true;
    const resolution = resolutions.get(`${r.finding.transcriptId}|${r.finding.fingerprint}`);
    const c = r.contactId ? contacts.get(r.contactId) : undefined;
    const contact: DncQueueItem["contact"] = c ? { id: c.id, name: fullName(c.first, c.last), phoneLast4: last4(c.phone), maskedEmail: maskEmail(c.email) } : null;
    const tPhone = payloadPhone.get(r.finding.transcriptId) ?? null;

    let candidates: DncCandidate[] = [];
    let moreCandidates = false;
    if (!contact && !resolution && r.contactMatch === "phone_ambiguous") {
      const key = phoneMatchKey(tPhone);
      const m = key ? matches.get(key) : undefined;
      candidates = (m?.candidates ?? []).map((x) => ({ id: x.id, name: fullName(x.first, x.last), phoneLast4: last4(x.phone), maskedEmail: maskEmail(x.email) }));
      moreCandidates = m?.more ?? false;
    }

    const numbers: DncNumberOption[] = [];
    if ((channel === "phone" || channelAssumed) && !resolution) {
      const tKey = phoneMatchKey(tPhone);
      if (tKey && tKey.length >= 10) numbers.push({ source: "transcript", last4: last4(tPhone) });
      const cKey = phoneMatchKey(c?.phone ?? null);
      if (cKey && cKey.length >= 10 && cKey !== tKey) numbers.push({ source: "contact", last4: last4(c?.phone) });
    }

    const a = r.agentId ? agents.get(r.agentId) : undefined;
    const note = resolution ? open<{ note: string }>(resolution.note)?.note ?? null : null;
    return {
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
      moreCandidates,
      channel,
      channelAssumed,
      emailOnFile: c ? Boolean(c.email && c.email.trim()) : null,
      numbers,
      agent: a ? { id: a.id, name: fullName(a.first, a.last) } : null,
      resolution: resolution
        ? {
            action: resolution.verdict === "opt_out_added" ? "add_opt_out" : "dismiss",
            note,
            reviewerName: resolution.reviewerName,
            at: resolution.at.toISOString(),
          }
        : null,
    };
  });
  return { items, total: n };
}

export type ResolveResult =
  | {
      ok: true;
      status: "resolved" | "already_resolved";
      action: DncAction;
      optOut: { phonesRecorded: number; emailsRecorded?: number; alreadyOnList: number; contactId: string | null; channel?: "phone" | "email" } | null;
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
  /** Which number the reviewer confirms asked for no contact (required for add_opt_out). */
  phoneSource?: PhoneSource | undefined;
  /** The number itself, when phoneSource is "typed". */
  phone?: string | undefined;
  /** The reviewer's explicit channel when the words did not name one. Otherwise the detected channel is used. */
  channel?: "phone" | "email" | undefined;
  /** Phone requests only: also add the owning client's email to the email opt-out list. Default true (fail-safe). */
  alsoOptOutEmail?: boolean | undefined;
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

  // Is this request still what the call's latest result says? Run inside each action's own
  // transaction with the transcript row locked, so a speaker choice or re-score cannot slip in
  // between the check and the opt-out being recorded.
  const staleCheck = async (h: AnyDb): Promise<ResolveResult | null> => {
    const [locked] = await h
      .select({ sealed: callTranscriptsTable.transcriptEncrypted })
      .from(callTranscriptsTable)
      .where(and(eq(callTranscriptsTable.id, transcript.id), eq(callTranscriptsTable.orgId, orgId)))
      .for("share")
      .limit(1);
    const assignment = open<TranscriptPayload>(locked?.sealed)?.speakerAssignment;
    if (assignment && assignment.scoredId !== assignment.id) {
      // A reviewer's choice is saved but the call has not been scored under it yet, so this list may be wrong.
      return { ok: false, httpStatus: 409, code: "rescoring_pending", message: "The speakers on this call were just changed and it has not been scored again yet. Open the call, wait for the new result (or press the agent voice again), then reload this list." };
    }
    const [latestScore] = await h
      .select({ id: callScoresTable.id })
      .from(callScoresTable)
      .where(and(eq(callScoresTable.transcriptId, transcript.id), eq(callScoresTable.orgId, orgId)))
      .orderBy(desc(callScoresTable.createdAt), desc(callScoresTable.id))
      .limit(1);
    if (latestScore && latestScore.id !== finding.scoreId) {
      const [stillThere] = await h
        .select({ id: callScoreFindingsTable.id })
        .from(callScoreFindingsTable)
        .where(
          and(
            eq(callScoreFindingsTable.orgId, orgId),
            eq(callScoreFindingsTable.scoreId, latestScore.id),
            eq(callScoreFindingsTable.kind, "dnc"),
            eq(callScoreFindingsTable.fingerprint, finding.fingerprint),
          ),
        )
        .limit(1);
      if (!stillThere) {
        return { ok: false, httpStatus: 409, code: "out_of_date", message: "This request is out of date: the call was scored again and these words are no longer flagged. Reload the list." };
      }
    }
    return null;
  };
  const early = await staleCheck(db);
  if (early) return early;

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
      const staleNow = await staleCheck(tx);
      if (staleNow) return staleNow;
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
  const findingPayload = open<{ channel?: "phone" | "email" }>(finding.evidenceEncrypted);
  const effectiveChannel: "phone" | "email" = args.channel ?? (findingPayload?.channel === "email" ? "email" : "phone");
  if (effectiveChannel === "email") {
    // An email-only request ("stop emailing me"): a phone opt-out would leave the
    // email flowing, so this goes through the email opt-out and needs a linked client.
    const wantedId = args.contactId ?? transcript.contactId ?? null;
    let emailContact: { id: string; email: string | null } | null = null;
    if (wantedId) {
      const [c] = await db
        .select({ id: contactsTable.id, email: contactsTable.email })
        .from(contactsTable)
        .where(and(eq(contactsTable.id, wantedId), eq(contactsTable.orgId, orgId), sql`${contactsTable.deletedAt} IS NULL`))
        .limit(1);
      if (!c && args.contactId) return { ok: false, httpStatus: 404, code: "contact_not_found", message: "Contact not found." };
      emailContact = c ?? null;
    }
    if (!emailContact) {
      return {
        ok: false,
        httpStatus: 400,
        code: "contact_required",
        message: "This is a request to stop email. Pick the client whose email should be added to the opt-out list.",
      };
    }
    const emailAddress = emailContact.email?.trim();
    if (!emailAddress) {
      return { ok: false, httpStatus: 400, code: "email_required", message: "That client has no email address on file, so there is nothing to add." };
    }
    const target = emailContact;
    return db.transaction(async (tx): Promise<ResolveResult> => {
      const staleNow = await staleCheck(tx);
      if (staleNow) return staleNow;
      const [inserted] = await tx
        .insert(callScoreReviewsTable)
        .values({ id: randomUUID(), ...reviewBase, verdict: "opt_out_added", contactId: target.id, optOutRecorded: true })
        .onConflictDoNothing()
        .returning({ id: callScoreReviewsTable.id });
      if (!inserted) {
        const again = await existingFor(tx);
        return again ? alreadyResult(again.verdict, again.contactId) : { ok: false, httpStatus: 409, code: "conflict", message: "Try again." };
      }
      const { alreadyOnList } = await recordEmailOptOut(tx, { orgId, contactId: target.id, email: emailAddress, source: "call_review" });
      if (target.id !== transcript.contactId) {
        await tx
          .update(callTranscriptsTable)
          .set({ contactId: target.id, contactMatch: "explicit" })
          .where(and(eq(callTranscriptsTable.id, transcript.id), eq(callTranscriptsTable.orgId, orgId)));
      }
      // Never the quote, the address or the note.
      await tx.insert(auditLogTable).values(audit("call_dnc_opt_out", { via: "call_review", channel: "email", channelChosenByReviewer: Boolean(args.channel), contactId: target.id, emailsRecorded: 1, alreadyOnList: alreadyOnList ? 1 : 0 }));
      return {
        ok: true,
        status: "resolved",
        action: "add_opt_out",
        optOut: { phonesRecorded: 0, emailsRecorded: 1, alreadyOnList: alreadyOnList ? 1 : 0, contactId: target.id, channel: "email" },
      };
    });
  }

  // The reviewer confirms ONE number. Nothing else is recorded.
  if (!args.phoneSource) {
    return {
      ok: false,
      httpStatus: 400,
      code: "phone_required",
      message: "Confirm the single phone number that asked for no contact (or type it) before adding the opt-out.",
    };
  }
  let contact: { id: string; phone: string | null; email: string | null } | null = null;
  const wantedContactId = args.contactId ?? transcript.contactId ?? null;
  if (wantedContactId) {
    const [c] = await db
      .select({ id: contactsTable.id, phone: contactsTable.phone, email: contactsTable.email })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, wantedContactId), eq(contactsTable.orgId, orgId), sql`${contactsTable.deletedAt} IS NULL`))
      .limit(1);
    if (!c && args.contactId) return { ok: false, httpStatus: 404, code: "contact_not_found", message: "Contact not found." };
    contact = c ?? null;
  }
  const payload = openTranscript(transcript);
  if (!contact && transcript.contactMatch === "phone_ambiguous" && args.phoneSource !== "typed") {
    const m = payload?.phone ? await matchContactByPhone(db, orgId, payload.phone) : null;
    const candidates: DncCandidate[] = [];
    if (m?.candidateIds.length) {
      const rows = await db
        .select({ id: contactsTable.id, first: contactsTable.firstName, last: contactsTable.lastName, phone: contactsTable.phone, email: contactsTable.email })
        .from(contactsTable)
        .where(and(eq(contactsTable.orgId, orgId), inArray(contactsTable.id, m.candidateIds)));
      for (const c of rows) candidates.push({ id: c.id, name: fullName(c.first, c.last), phoneLast4: last4(c.phone), maskedEmail: maskEmail(c.email) });
    }
    return {
      ok: false,
      httpStatus: 409,
      code: "pick_contact",
      message: "More than one client uses this phone number. Pick the right one (or type the number) before adding the opt-out.",
      candidates,
    };
  }

  const chosenRaw = args.phoneSource === "transcript" ? payload?.phone : args.phoneSource === "contact" ? contact?.phone : args.phone;
  const phone = dialable(chosenRaw);
  const key = phone ? phoneMatchKey(phone) : null;
  if (!phone || !key) {
    return {
      ok: false,
      httpStatus: 400,
      code: "phone_required",
      message:
        args.phoneSource === "typed"
          ? "Type the full phone number that asked for no contact."
          : "There is no usable phone number from that source. Choose another or type the number.",
    };
  }
  // A contact is attached only when it owns THE confirmed number.
  const linked = contact && phoneMatchKey(contact.phone) === key ? contact : null;

  // The email coupling follows the reviewer's intent (what the screen promised):
  // if the call is linked to a client with an email and the reviewer did not untick
  // the box, that email is added even when the confirmed number is not the
  // client's own. The PHONE is recorded against the client only when it matches.
  const wantsEmail = args.alsoOptOutEmail !== false;
  const emailAddress = contact?.email?.trim() || null;
  const emailTarget = wantsEmail && contact && emailAddress ? { id: contact.id, email: emailAddress } : null;

  return db.transaction(async (tx): Promise<ResolveResult> => {
    const staleNow = await staleCheck(tx);
    if (staleNow) return staleNow;
    // The unique index makes this the single winner if two people click at once.
    const [inserted] = await tx
      .insert(callScoreReviewsTable)
      .values({ id: randomUUID(), ...reviewBase, verdict: "opt_out_added", contactId: linked?.id ?? emailTarget?.id ?? null, optOutRecorded: true })
      .onConflictDoNothing()
      .returning({ id: callScoreReviewsTable.id });
    if (!inserted) {
      const again = await existingFor(tx);
      return again ? alreadyResult(again.verdict, again.contactId) : { ok: false, httpStatus: 409, code: "conflict", message: "Try again." };
    }
    const [existing] = await tx
      .select({ id: optOutsTable.id })
      .from(optOutsTable)
      .where(and(eq(optOutsTable.orgId, orgId), sql`${phoneMatchKeySql(optOutsTable.phone)} = ${key}`))
      .limit(1);
    const alreadyOnList = existing ? 1 : 0;
    await recordPhoneOptOut(tx, { orgId, contactId: linked?.id ?? null, phone, source: "call_review" });
    // A confirmed stop request must not leave email flowing: the linked client's
    // email goes on the email opt-out list in the same transaction (unless the
    // reviewer unticked it).
    let emailRecorded = false;
    if (emailTarget) {
      await recordEmailOptOut(tx, { orgId, contactId: emailTarget.id, email: emailTarget.email, source: "call_review" });
      emailRecorded = true;
    }
    const attach = linked ?? (args.contactId ? emailTarget : null);
    if (attach && attach.id !== transcript.contactId) {
      // The reviewer identified the client: keep that on the record.
      await tx
        .update(callTranscriptsTable)
        .set({ contactId: attach.id, contactMatch: "explicit" })
        .where(and(eq(callTranscriptsTable.id, transcript.id), eq(callTranscriptsTable.orgId, orgId)));
    }
    await tx
      .insert(auditLogTable)
      .values(audit("call_dnc_opt_out", { via: "call_review", phoneSource: args.phoneSource, contactId: linked?.id ?? null, phonesRecorded: 1, phoneLinkedToContact: Boolean(linked), alsoOptOutEmailChoice: wantsEmail, emailAlsoRecorded: emailRecorded, channelChosenByReviewer: Boolean(args.channel), alreadyOnList }));
    return {
      ok: true,
      status: "resolved",
      action: "add_opt_out",
      optOut: { phonesRecorded: 1, ...(emailRecorded ? { emailsRecorded: 1 } : {}), alreadyOnList, contactId: linked?.id ?? emailTarget?.id ?? null },
    };
  });
}
