/**
 * Native call scoring (phase 2a: text transcripts only, no speech-to-text).
 *
 * - `call_transcripts`     the transcript itself, stored ONLY as AES-256-GCM
 *                          ciphertext (`encryptPii`), plus a keyed digest (HMAC)
 *                          of the ORIGINAL canonical speech so a re-import can
 *                          be recognised without keeping plaintext. It is not
 *                          computed from redacted text, so two calls that differ
 *                          only in masked values stay distinct. A unique index
 *                          on (org_id, content_digest) makes the check atomic.
 *                          The transcript's phone number lives only inside the
 *                          ciphertext (no plaintext phone column). Optionally linked to a
 *                          contact and/or a native `call_sessions` row.
 * - `call_scores`          one IMMUTABLE automatic result per scoring run.
 *                          A rescore inserts a new row; nothing edits one
 *                          (a database trigger enforces it).
 * - `call_score_findings`  one row per criterion result / piece of evidence and
 *                          per possible do-not-contact request. The quote and
 *                          rationale are encrypted; positions are stored so the
 *                          UI can jump to the exact words.
 * - `call_score_reviews`   append-only human decisions on top of the immutable
 *                          result: criterion overrides and do-not-contact
 *                          resolutions. Notes are encrypted.
 *
 * Everything is org scoped. No MBI is ever stored here; the redaction step also
 * runs before any AI call. Scores assist review; they are not legal advice and
 * are not a compliance certification.
 */
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  real,
  customType,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable, usersTable } from "./core";
import { contactsTable } from "./crm";
import { agentsTable } from "./agents";
import { callSessionsTable } from "./voice";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const CALL_TRANSCRIPT_SOURCES = [
  "upload",
  "import",
  "enrollhere_download",
  "dialer",
  "other",
  "recording",
] as const;
export type CallTranscriptSource = (typeof CALL_TRANSCRIPT_SOURCES)[number];

export const CALL_TRANSCRIPT_FORMATS = ["paste", "txt", "vtt", "srt", "json"] as const;
export type CallTranscriptFormat = (typeof CALL_TRANSCRIPT_FORMATS)[number];

export const CALL_CONTACT_MATCHES = [
  "none",
  "explicit",
  "phone_unique",
  "phone_ambiguous",
] as const;
export type CallContactMatch = (typeof CALL_CONTACT_MATCHES)[number];

export const callTranscriptsTable = pgTable(
  "call_transcripts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: text("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
    callSessionId: text("call_session_id").references(() => callSessionsTable.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
    source: text("source").notNull().default("upload"),
    format: text("format").notNull(),
    /** Caller-supplied reference such as a recording id. Never put a client name here. */
    externalRef: text("external_ref"),
    callDate: timestamp("call_date", { withTimezone: true }),
    contactMatch: text("contact_match").notNull().default("none"),
    /** AES-256-GCM JSON payload (utterances + labels + filename). Null once purged. */
    transcriptEncrypted: bytea("transcript_encrypted"),
    /** Keyed HMAC of the original canonical speech (duplicate detection). Unique per org. */
    contentDigest: bytea("content_digest").notNull(),
    speakerMode: text("speaker_mode").notNull(),
    timing: text("timing").notNull(),
    utteranceCount: integer("utterance_count").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    createdBy: text("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    /** Never earlier than the CMS 10-year floor. */
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("call_transcripts_org_id_created_at_idx").on(t.orgId, t.createdAt),
    uniqueIndex("call_transcripts_org_digest_uidx").on(t.orgId, t.contentDigest),
    index("call_transcripts_contact_id_idx").on(t.contactId),
    index("call_transcripts_call_session_id_idx").on(t.callSessionId),
  ],
);

export type CallTranscript = typeof callTranscriptsTable.$inferSelect;

export const CALL_COMPLIANCE_STATUSES = ["pass", "fail", "review"] as const;
export type CallComplianceStatus = (typeof CALL_COMPLIANCE_STATUSES)[number];

export const CALL_AI_STATUSES = ["used", "needs_setup", "failed", "skipped"] as const;
export type CallAiStatus = (typeof CALL_AI_STATUSES)[number];

export const callScoresTable = pgTable(
  "call_scores",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    transcriptId: text("transcript_id")
      .notNull()
      .references(() => callTranscriptsTable.id, { onDelete: "cascade" }),
    rubricId: text("rubric_id").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    score: integer("score").notNull(),
    complianceStatus: text("compliance_status").notNull(),
    criticalFailureCount: integer("critical_failure_count").notNull().default(0),
    needsReviewCount: integer("needs_review_count").notNull().default(0),
    dncFlagCount: integer("dnc_flag_count").notNull().default(0),
    method: text("method").notNull().default("rules"),
    aiStatus: text("ai_status").notNull().default("skipped"),
    aiModel: text("ai_model"),
    /** A fixed, non-PHI reason code/message; never provider output. */
    aiError: text("ai_error"),
    speakerMode: text("speaker_mode").notNull(),
    scoredBy: text("scored_by").references(() => usersTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("call_scores_org_id_created_at_idx").on(t.orgId, t.createdAt),
    index("call_scores_transcript_id_created_at_idx").on(t.transcriptId, t.createdAt),
  ],
);

export type CallScore = typeof callScoresTable.$inferSelect;

export const callScoreFindingsTable = pgTable(
  "call_score_findings",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    scoreId: text("score_id")
      .notNull()
      .references(() => callScoresTable.id, { onDelete: "cascade" }),
    transcriptId: text("transcript_id")
      .notNull()
      .references(() => callTranscriptsTable.id, { onDelete: "cascade" }),
    criterionId: text("criterion_id").notNull(),
    criterionName: text("criterion_name").notNull(),
    /** required | prohibited | judgment | dnc */
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    /** pass | partial | fail | na | needs_review | flag (possible do-not-contact request) */
    verdict: text("verdict").notNull(),
    needsReview: boolean("needs_review").notNull().default(false),
    /** rules | llm | rules+llm */
    source: text("source").notNull(),
    /** agent | client | unknown */
    speaker: text("speaker"),
    utteranceIndex: integer("utterance_index"),
    endUtteranceIndex: integer("end_utterance_index"),
    /** Character offset of the quote inside utterance `utteranceIndex`. */
    startOffset: integer("start_offset"),
    /** Character offset where the quote ends inside utterance `endUtteranceIndex`. */
    endOffset: integer("end_offset"),
    startSeconds: real("start_seconds"),
    /** Share of the criterion's points earned (0..1), repeated on each row of the criterion. */
    fraction: real("fraction").notNull().default(0),
    maxPoints: real("max_points").notNull().default(0),
    /** Stable position key (no text) so a rescore does not re-open a resolved request. */
    fingerprint: text("fingerprint").notNull(),
    /** AES-256-GCM JSON: { quote, rationale, coaching }. */
    evidenceEncrypted: bytea("evidence_encrypted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("call_score_findings_score_id_idx").on(t.scoreId),
    index("call_score_findings_org_kind_idx").on(t.orgId, t.kind, t.createdAt),
    index("call_score_findings_transcript_id_idx").on(t.transcriptId),
  ],
);

export type CallScoreFinding = typeof callScoreFindingsTable.$inferSelect;

export const callScoreReviewsTable = pgTable(
  "call_score_reviews",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    transcriptId: text("transcript_id")
      .notNull()
      .references(() => callTranscriptsTable.id, { onDelete: "cascade" }),
    scoreId: text("score_id")
      .notNull()
      .references(() => callScoresTable.id, { onDelete: "cascade" }),
    /** override | dnc_resolution */
    kind: text("kind").notNull(),
    criterionId: text("criterion_id"),
    fingerprint: text("fingerprint"),
    /** override: pass | partial | fail | na | revert. dnc_resolution: opt_out_added | dismissed. */
    verdict: text("verdict").notNull(),
    fraction: real("fraction"),
    /** AES-256-GCM note text. */
    noteEncrypted: bytea("note_encrypted"),
    contactId: text("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
    optOutRecorded: boolean("opt_out_recorded").notNull().default(false),
    reviewerUserId: text("reviewer_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewerRole: text("reviewer_role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("call_score_reviews_score_id_idx").on(t.scoreId, t.createdAt),
    index("call_score_reviews_org_transcript_idx").on(t.orgId, t.transcriptId),
    uniqueIndex("call_score_reviews_dnc_once_key")
      .on(t.orgId, t.transcriptId, t.fingerprint)
      .where(sql`${t.kind} = 'dnc_resolution'`),
  ],
);

export type CallScoreReview = typeof callScoreReviewsTable.$inferSelect;

/**
 * Call recordings sent to speech-to-text (phase 2b).
 *
 * The audio lives in the private object store (GCS, under PRIVATE_OBJECT_DIR)
 * at a key the server chose; this row tracks it through transcription into a
 * scored `call_transcripts` row. The original file name is PHI-adjacent and is
 * kept only inside `details_encrypted`. Retained like transcripts: never
 * earlier than the CMS 10-year floor.
 */
export const CALL_RECORDING_STATUSES = ["uploading", "queued", "transcribing", "scored", "failed"] as const;
export type CallRecordingStatus = (typeof CALL_RECORDING_STATUSES)[number];

/** mono = one mixed track (speakers separated by voice); stereo = agent and client on separate channels. */
export const CALL_RECORDING_LAYOUTS = ["mono", "agent_left", "agent_right"] as const;
export type CallRecordingLayout = (typeof CALL_RECORDING_LAYOUTS)[number];

export const callRecordingsTable = pgTable(
  "call_recordings",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    status: text("status").notNull().default("uploading"),
    layout: text("layout").notNull().default("mono"),
    /** Object key relative to PRIVATE_OBJECT_DIR, chosen by the server. */
    objectKey: text("object_key").notNull(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    /** AES-256-GCM JSON: file name, phone, external reference. */
    detailsEncrypted: bytea("details_encrypted"),
    agentId: text("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
    contactId: text("contact_id").references(() => contactsTable.id, { onDelete: "set null" }),
    callSessionId: text("call_session_id").references(() => callSessionsTable.id, {
      onDelete: "set null",
    }),
    callDate: timestamp("call_date", { withTimezone: true }),
    rubricId: text("rubric_id"),
    aiMode: text("ai_mode").notNull().default("auto"),
    source: text("source").notNull().default("upload"),
    /** The speech provider's long-running operation name while transcribing. */
    operationName: text("operation_name"),
    transcriptId: text("transcript_id").references(() => callTranscriptsTable.id, { onDelete: "set null" }),
    /** Plain-language reason, safe to show; never contains transcript text. */
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    durationSeconds: integer("duration_seconds"),
    createdBy: text("created_by").references(() => usersTable.id, { onDelete: "set null" }),
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("call_recordings_org_created_idx").on(t.orgId, t.createdAt),
    index("call_recordings_status_idx").on(t.status),
  ],
);

export type CallRecording = typeof callRecordingsTable.$inferSelect;

