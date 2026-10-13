/**
 * Call scoring on TEXT transcripts (phase 2a).
 *
 *   GET   /call-scoring/config                              what is / is not set up
 *   POST  /call-scoring/transcripts                         paste or upload + score (rules, AI if set up)
 *   POST  /call-scoring/transcripts/:id/rescore             new automatic result; history kept
 *   POST  /call-scoring/transcripts/:id/agent-speaker       reviewer says which voice is the agent, then rescores
 *   GET   /call-scoring/transcripts                         list + filters
 *   GET   /call-scoring/transcripts/:id                     detail: findings with quotes and positions
 *   PATCH /call-scoring/transcripts/:id/criteria/:criterionId   human override (auto result untouched)
 *   GET   /call-scoring/summary                             pass / fail / review counts by agent and rubric
 *   GET   /call-scoring/dnc-review                          possible do-not-contact requests
 *   POST  /call-scoring/dnc-review/:findingId/resolve       a person confirms (add_opt_out) or dismisses
 *   POST  /call-scoring/import                              bulk look-back: files + optional CSV manifest
 *   POST  /call-scoring/recordings/upload-url               start a recording upload (signed URL, phase 2b)
 *   POST  /call-scoring/recordings/:id/uploaded             confirm the upload; queue transcription
 *   GET   /call-scoring/recordings                          recordings and where each one is
 *
 * Audio is only transcribed through Google Speech-to-Text when it is set up
 * (lib/callScoring/speech.ts); otherwise audio is refused with a clear
 * "not set up" message. Nothing is ever invented. Transcripts, quotes and
 * notes are PHI and are stored encrypted (lib/callScoring/seal.ts). Scores
 * assist review; they are not legal advice or a compliance certification.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  CALL_RECORDING_LAYOUTS,
  CALL_TRANSCRIPT_FORMATS,
  CALL_TRANSCRIPT_SOURCES,
  agentsTable,
  callRecordingsTable,
  callSessionsTable,
  contactsTable,
  auditLogTable,
  callScoreFindingsTable,
  callScoreReviewsTable,
  callScoresTable,

  db,
} from "@workspace/db";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { requireMfa } from "../middlewares/requireMfa";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";
import { isSelfScopedAgent } from "../middlewares/agentSelfScope";
import { parseCsvTolerant, parseFlexibleDate, CsvFileError } from "../lib/csvImport";
import { logger } from "../lib/logger";
import { open, seal } from "../lib/callScoring/seal";
import { PARSE_LIMITS } from "../lib/callScoring/parse";
import { DEFAULT_RUBRIC_ID, builtInRubrics, getRubric } from "../lib/callScoring/rubrics";
import { resolveAiReviewer } from "../lib/callScoring/aiReviewer";
import { ingestTranscript, rescoreTranscript, resolveRubric, type IngestResult } from "../lib/callScoring/ingest";
import { assignAgentSpeaker } from "../lib/callScoring/speakerAssign";
import { DISCLAIMER, buildDetail, buildList, buildSummary } from "../lib/callScoring/detail";
import { listDncQueue, resolveDncFinding } from "../lib/callScoring/dncReview";
import { loadTranscriptRow, retainUntil, type ScopeFilter } from "../lib/callScoring/store";
import { speechSetup } from "../lib/callScoring/speech";
import { importCallLog, readCallLog } from "../lib/callScoring/enrollhereCallLog";
import { dailyRecordingLimit, lockRecordings, purgeTime, recordingsToday, UPLOAD_URL_TTL_MS, type RecordingDetails } from "../lib/callScoring/recordings";
import { enqueue, JOB_NAMES, transcribeJobKey } from "../lib/jobs";
import type { Rubric, TranscriptFormat } from "../lib/callScoring/types";

const router: IRouter = Router();

/** One transcript file: a 1 MB text file is roughly 15 hours of speech. */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_IMPORT_FILES = 50;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_PASTE_CHARS = 500_000;

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".mp4", ".ogg", ".oga", ".flac", ".aac", ".wma", ".webm", ".amr", ".opus", ".aiff"];
const TEXT_EXTENSIONS = [".txt", ".vtt", ".srt", ".json"];
export const AUDIO_NOT_SET_UP =
  "Audio transcription is not set up yet, so recordings can't be scored directly. Upload a transcript (TXT, VTT, SRT or JSON) instead. Nothing is transcribed or guessed for you.";
/** Recordings go straight to storage, not through this server: a long call fits. */
export const MAX_RECORDING_BYTES = 500 * 1024 * 1024;
const RECORDING_EXTENSIONS = [".mp3", ".wav", ".m4a", ".mp4", ".ogg", ".oga", ".flac", ".webm", ".opus", ".aac", ".amr"];
const RECORDING_TYPE_RE = /^(audio\/[a-z0-9.+-]+|application\/ogg|video\/(mp4|webm))$/;

// Reads of transcripts are PHI reads: audited. Summary/config carry no PHI.
router.use(
  routerAuditMiddleware(router, "call_scoring", undefined, {
    includeReads: true,
    shouldAudit: (req) => !/\/call-scoring\/(summary|config)$/.test(req.path) && !(req as Request & { skipAudit?: boolean }).skipAudit,
    getResourceId: (req) => {
      const p = req.params as Record<string, string | undefined>;
      return p.id ?? p.findingId ?? null;
    },
  }),
);

// ---- helpers ---------------------------------------------------------------

async function scopeOf(req: Request): Promise<ScopeFilter | undefined> {
  if (!isSelfScopedAgent(req)) return undefined;
  const a = req as AuthenticatedRequest;
  return { agentUserId: a.userId };
}

const param = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

/** Empty strings from HTML forms mean "not provided". */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const phoneField = optional(
  z
    .string()
    .trim()
    .max(30)
    .refine((v) => {
      const d = v.replace(/\D/g, "");
      return d.length >= 7 && d.length <= 15;
    }, "phone must contain 7-15 digits"),
);
const boolField = optional(z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]));

const IngestFields = z.object({
  rubricId: optional(z.string().trim().max(64)),
  contactId: optional(z.string().trim().max(100)),
  phone: phoneField,
  callSessionId: optional(z.string().trim().max(100)),
  agentId: optional(z.string().trim().max(100)),
  source: optional(z.enum(CALL_TRANSCRIPT_SOURCES)),
  externalRef: optional(z.string().trim().max(120)),
  callDate: optional(z.string().trim().max(40)),
  ai: boolField,
});

function parseCallDate(raw: string | undefined): Date | null | "invalid" {
  if (!raw) return null;
  const iso = parseFlexibleDate(raw);
  if (iso) return new Date(`${iso}T00:00:00.000Z`);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  return buf.toString("utf8");
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
};

function formatFor(filename: string): TranscriptFormat | undefined {
  const e = extOf(filename).slice(1);
  return (CALL_TRANSCRIPT_FORMATS as readonly string[]).includes(e) ? (e as TranscriptFormat) : undefined;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 20, fieldSize: MAX_PASTE_CHARS } });
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_IMPORT_FILES + 1, fields: 20 },
});

function multerGuard(handler: (req: Request, res: Response, cb: (err?: unknown) => void) => void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (err?: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: `That file is larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB. Split it into shorter calls.`, code: "file_too_large" });
      } else if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") {
        res.status(400).json({ error: `Too many files (the limit is ${MAX_IMPORT_FILES}) or an unexpected upload field.`, code: "too_many_files" });
      } else {
        res.status(400).json({ error: "The upload could not be read.", code: "bad_upload" });
      }
    });
  };
}

function sendIngest(res: Response, result: IngestResult): void {
  if (result.kind === "ok") {
    res.status(201).json(result.summary);
  } else if (result.kind === "duplicate") {
    res.status(409).json({ error: "This transcript was already scored.", code: "duplicate", transcriptId: result.transcriptId });
  } else {
    res.status(result.httpStatus).json({ error: result.message, code: result.code });
  }
}

function aiModeFrom(ai: boolean | undefined): "auto" | "off" {
  return ai === false ? "off" : "auto";
}

// ---- config ----------------------------------------------------------------

/** Audio sent to a transcript route: point at the recording upload when it exists. */
function audioRefusal(): { error: string; code: string } {
  return speechSetup().ready
    ? { error: "This is a recording. Use Upload recording to have it transcribed and scored.", code: "use_recording_upload" }
    : { error: AUDIO_NOT_SET_UP, code: "audio_transcription_not_set_up" };
}

function audioConfig() {
  const setup = speechSetup();
  return setup.ready
    ? { supported: true, message: setup.message, maxBytes: MAX_RECORDING_BYTES, acceptedFormats: RECORDING_EXTENSIONS, layouts: CALL_RECORDING_LAYOUTS }
    : { supported: false, message: AUDIO_NOT_SET_UP };
}

router.get(
  "/call-scoring/config",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "read"),
  (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    const aiConfigured = resolveAiReviewer() !== null;
    res.json({
      orgId: authReq.orgId,
      rubrics: builtInRubrics.map((r) => ({ id: r.id, name: r.name, version: r.version, description: r.description, passThreshold: r.passThreshold })),
      defaultRubricId: DEFAULT_RUBRIC_ID,
      ai: aiConfigured
        ? { status: "configured", message: "AI review is set up. Only PHI-redacted text is sent, through the HIPAA-gated provider." }
        : { status: "needs_setup", message: "AI review is not set up. Rule checks and the do-not-contact check still run; judgment items are marked needs review." },
      audio: audioConfig(),
      limits: {
        maxFileBytes: MAX_FILE_BYTES,
        maxImportFiles: MAX_IMPORT_FILES,
        maxPasteChars: MAX_PASTE_CHARS,
        maxManifestBytes: MAX_MANIFEST_BYTES,
        acceptedFormats: TEXT_EXTENSIONS,
        maxTranscriptChars: PARSE_LIMITS.maxChars,
      },
      sources: CALL_TRANSCRIPT_SOURCES,
      canCreate: ["super_admin", "agency_admin", "compliance_manager"].includes(authReq.userRole),
      canReview: ["super_admin", "agency_admin", "compliance_manager"].includes(authReq.userRole),
      disclaimer: DISCLAIMER,
    });
  },
);

// ---- create ----------------------------------------------------------------

router.post(
  "/call-scoring/transcripts",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "create"),
  multerGuard((req, res, cb) => upload.single("file")(req, res, cb)),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = IngestFields.safeParse(body);
    if (!fields.success) {
      res.status(400).json({ error: "Check the fields you entered.", code: "invalid", details: fields.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      return;
    }
    const f = fields.data;
    const file = (req as Request & { file?: Express.Multer.File }).file;

    let content: string;
    let filename: string | null = null;
    let format: TranscriptFormat | undefined;
    if (file) {
      const ext = extOf(file.originalname);
      if (AUDIO_EXTENSIONS.includes(ext) || /^(audio|video)\//.test(file.mimetype)) {
        res.status(415).json(audioRefusal());
        return;
      }
      if (!TEXT_EXTENSIONS.includes(ext)) {
        res.status(415).json({ error: "Upload a TXT, VTT, SRT or JSON transcript.", code: "unsupported_file" });
        return;
      }
      content = decodeText(file.buffer);
      filename = file.originalname.slice(0, 200);
      format = formatFor(file.originalname);
    } else {
      const text = body["text"];
      if (typeof text !== "string" || !text.trim()) {
        res.status(400).json({ error: "Paste the transcript text or upload a file.", code: "no_transcript" });
        return;
      }
      if (text.length > MAX_PASTE_CHARS) {
        res.status(413).json({ error: `Pasted text is limited to ${MAX_PASTE_CHARS.toLocaleString()} characters. Upload a file or split the call.`, code: "text_too_large" });
        return;
      }
      content = text;
      const hint = body["format"];
      format = typeof hint === "string" && (CALL_TRANSCRIPT_FORMATS as readonly string[]).includes(hint) ? (hint as TranscriptFormat) : "paste";
    }

    const rubric = resolveRubric(f.rubricId, getRubric(DEFAULT_RUBRIC_ID) as Rubric);
    if (!rubric) {
      res.status(400).json({ error: "Unknown rubric.", code: "unknown_rubric" });
      return;
    }
    const callDate = parseCallDate(f.callDate);
    if (callDate === "invalid") {
      res.status(400).json({ error: "The call date is not a valid date.", code: "invalid_date" });
      return;
    }

    const result = await ingestTranscript({
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      content,
      filename,
      format,
      rubric,
      source: f.source ?? "upload",
      externalRef: f.externalRef ?? null,
      callDate,
      phone: f.phone ?? null,
      contactId: f.contactId ?? null,
      callSessionId: f.callSessionId ?? null,
      agentId: f.agentId ?? null,
      aiMode: aiModeFrom(f.ai),
    });
    sendIngest(res, result);
  },
);

router.post(
  "/call-scoring/transcripts/:id/rescore",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = z.object({ rubricId: optional(z.string().trim().max(64)), ai: boolField }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Check the fields you entered.", code: "invalid" });
      return;
    }
    const rubric = resolveRubric(parsed.data.rubricId, getRubric(DEFAULT_RUBRIC_ID) as Rubric);
    if (!rubric) {
      res.status(400).json({ error: "Unknown rubric.", code: "unknown_rubric" });
      return;
    }
    const result = await rescoreTranscript({
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      transcriptId: param(req.params.id),
      rubric,
      aiMode: aiModeFrom(parsed.data.ai),
    });
    if (result.kind === "ok") res.status(201).json(result.summary);
    else if (result.kind === "error") res.status(result.httpStatus).json({ error: result.message, code: result.code });
    else res.status(409).json({ error: "Unexpected duplicate.", code: "duplicate" });
  },
);

router.post(
  "/call-scoring/transcripts/:id/agent-speaker",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = z
      .object({ agentSpeaker: z.string().trim().min(1).max(40), rubricId: optional(z.string().trim().max(64)), ai: boolField })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Choose which voice is the agent.", code: "invalid" });
      return;
    }
    const rubric = resolveRubric(parsed.data.rubricId, getRubric(DEFAULT_RUBRIC_ID) as Rubric);
    if (!rubric) {
      res.status(400).json({ error: "Unknown rubric.", code: "unknown_rubric" });
      return;
    }
    const result = await assignAgentSpeaker({
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      transcriptId: param(req.params.id),
      agentLabel: parsed.data.agentSpeaker,
      rubric,
      // Not given: keep the call's earlier AI setting.
      ...(parsed.data.ai === undefined ? {} : { aiMode: aiModeFrom(parsed.data.ai) }),
    });
    if (result.kind === "ok") res.status(201).json(result.summary);
    else if (result.kind === "error") res.status(result.httpStatus).json({ error: result.message, code: result.code });
    else res.status(409).json({ error: "Unexpected duplicate.", code: "duplicate" });
  },
);

// ---- read ------------------------------------------------------------------

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  compliance: optional(z.enum(["pass", "fail", "review"])),
  dnc: optional(z.enum(["open"])),
  rubricId: optional(z.string().trim().max(64)),
  agentId: optional(z.string().trim().max(100)),
  contactId: optional(z.string().trim().max(100)),
  source: optional(z.enum(CALL_TRANSCRIPT_SOURCES)),
  from: optional(z.coerce.date()),
  to: optional(z.coerce.date()),
});

router.get(
  "/call-scoring/transcripts",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const q = ListQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "Invalid filters.", code: "invalid" });
      return;
    }
    const scope = await scopeOf(req);
    res.json(
      await buildList({
        orgId: authReq.orgId,
        ...(scope ? { scope } : {}),
        ...q.data,
      }),
    );
  },
);

router.get(
  "/call-scoring/summary",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const q = ListQuery.pick({ from: true, to: true, source: true, agentId: true }).safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "Invalid filters.", code: "invalid" });
      return;
    }
    const scope = await scopeOf(req);
    res.json({ ...(await buildSummary({ orgId: authReq.orgId, ...(scope ? { scope } : {}), ...q.data })), disclaimer: DISCLAIMER });
  },
);

// Registered BEFORE /transcripts/:id-style params so "dnc-review" is never read as an id.
const DncListQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("open"),
  transcriptId: optional(z.string().trim().max(100)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

router.get(
  "/call-scoring/dnc-review",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "review"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const q = DncListQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "Invalid filters.", code: "invalid" });
      return;
    }
    const out = await listDncQueue(db, { orgId: authReq.orgId, ...q.data });
    res.json({
      ...out,
      note: "These are possible requests, found by wording. Nothing is added to the do-not-contact list until a person confirms it.",
    });
  },
);

const ResolveBody = z.object({
  action: z.enum(["add_opt_out", "dismiss"]),
  note: optional(z.string().trim().max(2000)),
  contactId: optional(z.string().trim().max(100)),
  phoneSource: optional(z.enum(["transcript", "contact", "typed"])),
  channel: optional(z.enum(["phone", "email"])),
  alsoOptOutEmail: boolField,
  phone: phoneField,
});

router.post(
  "/call-scoring/dnc-review/:findingId/resolve",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "review"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const body = ResolveBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "Choose add_opt_out or dismiss.", code: "invalid" });
      return;
    }
    const result = await resolveDncFinding({
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      findingId: param(req.params.findingId),
      ...body.data,
    });
    if (!result.ok) {
      res.status(result.httpStatus).json({ error: result.message, code: result.code, ...(result.candidates ? { candidates: result.candidates } : {}) });
      return;
    }
    res.status(200).json({
      status: result.status,
      action: result.action,
      optOut: result.optOut,
    });
  },
);

router.get(
  "/call-scoring/transcripts/:id",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const detail = await buildDetail(authReq.orgId, param(req.params.id), await scopeOf(req));
    if (!detail) {
      // Same answer for "missing", "another org" and "not your call".
      res.status(404).json({ error: "Transcript not found.", code: "not_found" });
      return;
    }
    res.json(detail);
  },
);

// ---- human review ----------------------------------------------------------

const OverrideBody = z
  .object({
    verdict: z.enum(["pass", "partial", "fail", "na", "revert"]),
    fraction: z.number().min(0.1).max(0.9).optional(),
    note: optional(z.string().trim().max(2000)),
  })
  .superRefine((b, ctx) => {
    if (b.verdict !== "revert" && (b.note ?? "").length < 3) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "Add a short note saying why." });
    }
  });

router.patch(
  "/call-scoring/transcripts/:id/criteria/:criterionId",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "review"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const body = OverrideBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: body.error.issues[0]?.message ?? "Check the fields you entered.", code: "invalid" });
      return;
    }
    const transcript = await loadTranscriptRow(db, authReq.orgId, param(req.params.id));
    if (!transcript) {
      res.status(404).json({ error: "Transcript not found.", code: "not_found" });
      return;
    }
    const criterionId = param(req.params.criterionId);
    const [score] = await db
      .select({ id: callScoresTable.id, rubricId: callScoresTable.rubricId })
      .from(callScoresTable)
      .where(and(eq(callScoresTable.orgId, authReq.orgId), eq(callScoresTable.transcriptId, transcript.id)))
      .orderBy(desc(callScoresTable.createdAt), desc(callScoresTable.id))
      .limit(1);
    const [criterionRow] = score
      ? await db
          .select({ id: callScoreFindingsTable.id })
          .from(callScoreFindingsTable)
          .where(
            and(
              eq(callScoreFindingsTable.orgId, authReq.orgId),
              eq(callScoreFindingsTable.scoreId, score.id),
              eq(callScoreFindingsTable.criterionId, criterionId),
              ne(callScoreFindingsTable.kind, "dnc"),
            ),
          )
          .limit(1)
      : [];
    if (!score || !criterionRow) {
      res.status(404).json({ error: "That criterion is not part of this score.", code: "criterion_not_found" });
      return;
    }
    const { verdict, fraction, note } = body.data;
    if (verdict === "partial") {
      // By rubric id, not version: an item that is all-or-nothing today was on older versions too.
      const meta = getRubric(score.rubricId)?.criteria.find((c) => c.id === criterionId);
      if (meta?.allOrNothing) {
        res.status(400).json({ error: "This item is all-or-nothing: grade it pass or fail.", code: "all_or_nothing" });
        return;
      }
    }
    await db.transaction(async (tx) => {
      await tx.insert(callScoreReviewsTable).values({
        id: randomUUID(),
        orgId: authReq.orgId,
        transcriptId: transcript.id,
        scoreId: score.id,
        kind: "override",
        criterionId,
        verdict,
        fraction: verdict === "partial" ? (fraction ?? 0.5) : null,
        noteEncrypted: note ? seal({ note }) : null,
        reviewerUserId: authReq.userId,
        reviewerRole: authReq.userRole,
      });
      await tx.insert(auditLogTable).values({
        id: randomUUID(),
        orgId: authReq.orgId,
        userId: authReq.userId,
        userRole: authReq.userRole,
        action: verdict === "revert" ? "call_score_override_revert" : "call_score_override",
        resourceType: "call_transcript",
        resourceId: transcript.id,
        // The note is PHI-adjacent free text: never copied into the audit log.
        changes: { scoreId: score.id, criterionId, verdict },
      });
    });
    const detail = await buildDetail(authReq.orgId, transcript.id, undefined);
    res.json(detail);
  },
);

// ---- bulk look-back import ---------------------------------------------------

interface ManifestRow {
  phone?: string;
  contactId?: string;
  agent?: string;
  date?: string;
  reference?: string;
}

const MANIFEST_COLUMNS: Record<keyof ManifestRow | "filename", string[]> = {
  filename: ["filename", "file", "file name", "file_name", "recording", "recording file"],
  phone: ["phone", "phone number", "phone_number", "number", "caller", "client phone"],
  contactId: ["contactid", "contact id", "contact_id", "contact"],
  agent: ["agent", "agent id", "agent_id", "agent email", "agent name", "rep"],
  date: ["date", "call date", "call_date", "recorded", "recorded at"],
  reference: ["reference", "ref", "recording id", "recording_id", "external ref", "external_ref", "id"],
};

function readManifest(buf: Buffer): { byFilename: Map<string, ManifestRow>; rows: number; problems: string[] } {
  const parsed = parseCsvTolerant(buf);
  const problems: string[] = parsed.issues.filter((i) => i.severity === "error").map((i) => `Row ${i.row}: ${i.message}`);
  const col = (headers: string[], names: string[]) => headers.find((h) => names.includes(h.trim().toLowerCase()));
  const fileCol = col(parsed.headers, MANIFEST_COLUMNS.filename);
  if (!fileCol) throw new CsvFileError('The manifest needs a "filename" column.');
  const cols = {
    phone: col(parsed.headers, MANIFEST_COLUMNS.phone),
    contactId: col(parsed.headers, MANIFEST_COLUMNS.contactId),
    agent: col(parsed.headers, MANIFEST_COLUMNS.agent),
    date: col(parsed.headers, MANIFEST_COLUMNS.date),
    reference: col(parsed.headers, MANIFEST_COLUMNS.reference),
  };
  const byFilename = new Map<string, ManifestRow>();
  for (const r of parsed.rows) {
    const name = (r[fileCol] ?? "").trim();
    if (!name) continue;
    const pick = (c: string | undefined) => ((c ? r[c] : "") ?? "").trim() || undefined;
    byFilename.set(name.toLowerCase(), {
      ...(pick(cols.phone) ? { phone: pick(cols.phone) } : {}),
      ...(pick(cols.contactId) ? { contactId: pick(cols.contactId) } : {}),
      ...(pick(cols.agent) ? { agent: pick(cols.agent) } : {}),
      ...(pick(cols.date) ? { date: pick(cols.date) } : {}),
      ...(pick(cols.reference) ? { reference: pick(cols.reference) } : {}),
    });
  }
  return { byFilename, rows: parsed.rows.length, problems };
}

interface ImportFileResult {
  filename: string;
  status: "scored" | "duplicate" | "error";
  transcriptId?: string;
  scoreId?: string;
  compliance?: "pass" | "fail" | "review";
  score?: number;
  dncFlags?: number;
  contactMatch?: string;
  speakerMode?: string;
  code?: string;
  error?: string;
  warnings: string[];
}

router.post(
  "/call-scoring/import",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "create"),
  multerGuard((req, res, cb) =>
    importUpload.fields([
      { name: "files", maxCount: MAX_IMPORT_FILES },
      { name: "manifest", maxCount: 1 },
    ])(req, res, cb),
  ),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const files = ((req as Request & { files?: Record<string, Express.Multer.File[]> }).files ?? {}) as Record<string, Express.Multer.File[]>;
    const transcripts = files["files"] ?? [];
    const manifestFile = files["manifest"]?.[0];
    if (!transcripts.length) {
      res.status(400).json({ error: "Choose at least one transcript file.", code: "no_files" });
      return;
    }
    const fields = z
      .object({ rubricId: optional(z.string().trim().max(64)), source: optional(z.enum(CALL_TRANSCRIPT_SOURCES)) })
      .safeParse(req.body ?? {});
    if (!fields.success) {
      res.status(400).json({ error: "Check the fields you entered.", code: "invalid" });
      return;
    }
    const rubric = resolveRubric(fields.data.rubricId, getRubric(DEFAULT_RUBRIC_ID) as Rubric);
    if (!rubric) {
      res.status(400).json({ error: "Unknown rubric.", code: "unknown_rubric" });
      return;
    }
    const source = fields.data.source ?? "enrollhere_download";

    let manifest: ReturnType<typeof readManifest> | null = null;
    if (manifestFile) {
      if (manifestFile.size > MAX_MANIFEST_BYTES) {
        res.status(413).json({ error: "The manifest file is too large.", code: "manifest_too_large" });
        return;
      }
      try {
        manifest = readManifest(manifestFile.buffer);
      } catch (err) {
        if (err instanceof CsvFileError) {
          res.status(400).json({ error: err.message, code: "bad_manifest" });
          return;
        }
        throw err;
      }
    }

    // Agents in this org, for the manifest's agent column (id, email or full name).
    const agentRows = manifest
      ? await db
          .select({ id: agentsTable.id, first: agentsTable.firstName, last: agentsTable.lastName, email: agentsTable.email })
          .from(agentsTable)
          .where(eq(agentsTable.orgId, authReq.orgId))
      : [];
    const agentByKey = new Map<string, string | null>();
    const addKey = (k: string, id: string) => agentByKey.set(k, agentByKey.has(k) ? null : id); // null = ambiguous
    for (const a of agentRows) {
      addKey(a.id.toLowerCase(), a.id);
      if (a.email) addKey(a.email.toLowerCase(), a.id);
      addKey(`${a.first} ${a.last}`.trim().toLowerCase(), a.id);
    }

    const results: ImportFileResult[] = [];
    const used = new Set<string>();
    let agentAmbiguousName = 0;
    let agentNotFound = 0;
    const ambiguousAgentKeys = new Set<string>();
    for (const f of transcripts) {
      const filename = f.originalname.slice(0, 200);
      const warnings: string[] = [];
      const ext = extOf(filename);
      if (AUDIO_EXTENSIONS.includes(ext) || /^(audio|video)\//.test(f.mimetype)) {
        const refusal = audioRefusal();
        results.push({ filename, status: "error", code: refusal.code, error: refusal.error, warnings });
        continue;
      }
      if (!TEXT_EXTENSIONS.includes(ext)) {
        results.push({ filename, status: "error", code: "unsupported_file", error: "Not a TXT, VTT, SRT or JSON transcript.", warnings });
        continue;
      }
      const m = manifest?.byFilename.get(filename.toLowerCase());
      if (manifest && !m) warnings.push("Not listed in the manifest, so it has no phone, agent or date.");
      if (m) used.add(filename.toLowerCase());

      let agentId: string | null = null;
      if (m?.agent) {
        const hit = agentByKey.get(m.agent.trim().toLowerCase());
        if (hit) agentId = hit;
        else if (hit === null) {
          agentAmbiguousName++;
          ambiguousAgentKeys.add(m.agent.trim().toLowerCase());
          warnings.push("The agent in the manifest matches more than one person, so no agent was set.");
        } else {
          agentNotFound++;
          warnings.push("The agent in the manifest was not found, so no agent was set.");
        }
      }
      let callDate: Date | null = null;
      if (m?.date) {
        const d = parseCallDate(m.date);
        if (d === "invalid") warnings.push("The date in the manifest could not be read, so it was left blank.");
        else callDate = d;
      }
      let phone: string | null = null;
      if (m?.phone) {
        const digits = m.phone.replace(/\D/g, "");
        if (digits.length >= 7 && digits.length <= 15) phone = m.phone.slice(0, 30);
        else warnings.push("The phone number in the manifest is not valid, so it was ignored.");
      }

      try {
        // Decoded once and reused by the retry below.
        const content = decodeText(f.buffer);
        let out = await ingestTranscript({
          orgId: authReq.orgId,
          userId: authReq.userId,
          userRole: authReq.userRole,
          content,
          filename,
          format: formatFor(filename),
          rubric,
          source,
          externalRef: m?.reference?.slice(0, 120) ?? null,
          callDate,
          phone,
          contactId: m?.contactId ?? null,
          callSessionId: null,
          agentId,
          aiMode: "off",
        });
        if (out.kind === "error" && out.code === "contact_not_found" && m?.contactId) {
          // A bad contact id in the manifest must not sink the file: fall back to the phone number.
          warnings.push("The contactId in the manifest was not found, so it was ignored.");
          out = await ingestTranscript({
            orgId: authReq.orgId,
            userId: authReq.userId,
            userRole: authReq.userRole,
            content,
            filename,
            format: formatFor(filename),
            rubric,
            source,
            externalRef: m.reference?.slice(0, 120) ?? null,
            callDate,
            phone,
            contactId: null,
            callSessionId: null,
            agentId,
            aiMode: "off",
          });
        }
        if (out.kind === "ok") {
          results.push({
            filename,
            status: "scored",
            transcriptId: out.summary.transcriptId,
            scoreId: out.summary.scoreId,
            compliance: out.summary.compliance,
            score: out.summary.score,
            dncFlags: out.summary.dncFlagCount,
            contactMatch: out.summary.contact.match,
            speakerMode: out.summary.speakerMode,
            warnings,
          });
        } else if (out.kind === "duplicate") {
          results.push({ filename, status: "duplicate", transcriptId: out.transcriptId, code: "duplicate", error: "Already scored earlier (same text).", warnings });
        } else {
          results.push({ filename, status: "error", code: out.code, error: out.message, warnings });
        }
      } catch (err) {
        // One bad file must not stop the batch. Never log the text or the file name.
        logger.error({ err, orgId: authReq.orgId }, "call scoring import: file failed");
        results.push({ filename, status: "error", code: "failed", error: "This file could not be scored.", warnings });
      }
    }

    if (agentAmbiguousName > 0) {
      // Ids of the agents that share the ambiguous name/email key: no names, emails or file names.
      const conflictingAgentIds = agentRows
        .filter((ag) => [ag.id.toLowerCase(), (ag.email ?? "").toLowerCase(), `${ag.first} ${ag.last}`.trim().toLowerCase()].some((k) => ambiguousAgentKeys.has(k)))
        .map((ag) => ag.id);
      logger.warn({ orgId: authReq.orgId, agentAmbiguousName, conflictingAgentIds }, "call scoring import: manifest agent matched more than one agent");
    }

    const scored = results.filter((r) => r.status === "scored");
    const summary = {
      files: results.length,
      scored: scored.length,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      errors: results.filter((r) => r.status === "error").length,
      byCompliance: {
        pass: scored.filter((r) => r.compliance === "pass").length,
        fail: scored.filter((r) => r.compliance === "fail").length,
        review: scored.filter((r) => r.compliance === "review").length,
      },
      filesWithWarnings: results.filter((r) => (r.warnings?.length ?? 0) > 0).length,
      agentAmbiguousName,
      agentNotFound,
      possibleDncFiles: scored.filter((r) => (r.dncFlags ?? 0) > 0).length,
      possibleDncRequests: scored.reduce((n, r) => n + (r.dncFlags ?? 0), 0),
      unlabelledSpeakers: scored.filter((r) => r.speakerMode === "unlabelled").length,
      needContactPick: scored.filter((r) => r.contactMatch === "phone_ambiguous").length,
      notLinkedToClient: scored.filter((r) => r.contactMatch === "none").length,
      manifest: manifest
        ? {
            rows: manifest.rows,
            unmatchedManifestRows: [...manifest.byFilename.keys()].filter((k) => !used.has(k)).length,
            problems: manifest.problems.slice(0, 20),
          }
        : null,
      aiReview: "Not run for bulk imports (rules and the do-not-contact check only). Use Rescore on a call to add AI review.",
      note: "Possible do-not-contact requests are in the Do-not-contact review queue. Nothing was added to the do-not-contact list.",
    };
    res.status(200).json({ summary, results });
  },
);

// ---- recordings (phase 2b) ---------------------------------------------------

const dailyLimitMessage = (limit: number) =>
  `Your agency has started ${limit} recordings in the last 24 hours, the daily limit. Try again later, or ask the administrator to raise it.`;

const RecordingStart = IngestFields.omit({ source: true }).extend({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.coerce.number().int().min(1),
  layout: z.enum(CALL_RECORDING_LAYOUTS).default("mono"),
  source: optional(z.enum(CALL_TRANSCRIPT_SOURCES)),
});

/** Linked records must be this agency's own; checked before anything is stored. */
async function linkProblem(orgId: string, f: { agentId?: string; contactId?: string; callSessionId?: string }): Promise<{ code: string; message: string } | null> {
  if (f.agentId) {
    const [a] = await db.select({ id: agentsTable.id }).from(agentsTable).where(and(eq(agentsTable.id, f.agentId), eq(agentsTable.orgId, orgId))).limit(1);
    if (!a) return { code: "agent_not_found", message: "Agent not found." };
  }
  if (f.contactId) {
    const [c] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, f.contactId), eq(contactsTable.orgId, orgId), isNull(contactsTable.deletedAt))).limit(1);
    if (!c) return { code: "contact_not_found", message: "Contact not found." };
  }
  if (f.callSessionId) {
    const [c] = await db.select({ id: callSessionsTable.id }).from(callSessionsTable).where(and(eq(callSessionsTable.id, f.callSessionId), eq(callSessionsTable.orgId, orgId))).limit(1);
    if (!c) return { code: "call_not_found", message: "Call not found." };
  }
  return null;
}

router.post(
  "/call-scoring/recordings/upload-url",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const setup = speechSetup();
    if (!setup.ready) {
      res.status(503).json({ error: AUDIO_NOT_SET_UP, code: "audio_transcription_not_set_up" });
      return;
    }
    const parsed = RecordingStart.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Check the fields you entered.", code: "invalid", details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      return;
    }
    const f = parsed.data;
    if (!RECORDING_EXTENSIONS.includes(extOf(f.filename)) || !RECORDING_TYPE_RE.test(f.contentType)) {
      res.status(415).json({ error: "Upload an audio recording: MP3, WAV, M4A, MP4, OGG, FLAC, WEBM, OPUS, AAC or AMR.", code: "unsupported_file" });
      return;
    }
    if (f.sizeBytes > MAX_RECORDING_BYTES) {
      res.status(413).json({ error: `Recordings are limited to ${MAX_RECORDING_BYTES / 1024 / 1024} MB. Split the call or export it at a lower bitrate.`, code: "file_too_large" });
      return;
    }
    if (f.rubricId && !resolveRubric(f.rubricId, getRubric(DEFAULT_RUBRIC_ID) as Rubric)) {
      res.status(400).json({ error: "Unknown rubric.", code: "unknown_rubric" });
      return;
    }
    const callDate = parseCallDate(f.callDate);
    if (callDate === "invalid") {
      res.status(400).json({ error: "The call date is not a valid date.", code: "invalid_date" });
      return;
    }
    const problem = await linkProblem(authReq.orgId, f);
    if (problem) {
      res.status(404).json({ error: problem.message, code: problem.code });
      return;
    }
    const { ObjectStorageService } = await import("../lib/objectStorage");
    const storage = new ObjectStorageService();
    const id = randomUUID();
    const objectKey = storage.callRecordingKey(authReq.orgId, id);
    const details: RecordingDetails = { filename: f.filename, phone: f.phone ?? null, externalRef: f.externalRef ?? null, uploaderRole: authReq.userRole };
    let uploadUrl: string;
    try {
      uploadUrl = await storage.getCallRecordingUploadURL(objectKey, f.contentType, UPLOAD_URL_TTL_MS / 1000);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Call recording: could not sign the upload URL");
      res.status(503).json({ error: "Recording storage is not available right now. Try again in a few minutes.", code: "storage_unavailable" });
      return;
    }
    // Count and insert under a per-agency lock so a burst of requests cannot
    // all see the same count and pass the daily cap together.
    const limit = dailyRecordingLimit();
    const now = new Date();
    const inserted = await db.transaction(async (tx) => {
      await lockRecordings(tx, authReq.orgId);
      // Committed recordings plus links handed out in the last 15 minutes (a
      // link that was never used stops counting once it has expired).
      const started = await recordingsToday(tx, authReq.orgId, now, { includeOpenUploads: true });
      if (started >= limit) return false;
      await tx.insert(callRecordingsTable).values({
      id,
      orgId: authReq.orgId,
      status: "uploading",
      layout: f.layout,
      objectKey,
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
      detailsEncrypted: seal(details),
      agentId: f.agentId ?? null,
      contactId: f.contactId ?? null,
      callSessionId: f.callSessionId ?? null,
      callDate,
      rubricId: f.rubricId ?? null,
      aiMode: aiModeFrom(f.ai),
      source: f.source ?? "upload",
      createdBy: authReq.userId,
      retainUntil: retainUntil(now),
      createdAt: now,
      updatedAt: now,
    });
      return true;
    });
    if (!inserted) {
      logger.warn({ orgId: authReq.orgId, limit }, "Call recording: daily limit reached");
      res.status(429).json({ error: dailyLimitMessage(limit), code: "daily_limit" });
      return;
    }
    // Both headers are part of the signature; the second makes the URL create-only.
    res.status(201).json({
      recordingId: id,
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": f.contentType, "x-goog-if-generation-match": "0" },
      expiresInSeconds: UPLOAD_URL_TTL_MS / 1000,
    });
  },
);

router.post(
  "/call-scoring/recordings/:id/uploaded",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = param(req.params.id);
    const [row] = await db
      .select()
      .from(callRecordingsTable)
      .where(and(eq(callRecordingsTable.id, id), eq(callRecordingsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Recording not found.", code: "not_found" });
      return;
    }
    if (row.status !== "uploading") {
      res.status(200).json({ recordingId: row.id, status: row.status });
      return;
    }
    const { ObjectStorageService } = await import("../lib/objectStorage");
    const storage = new ObjectStorageService();
    let meta: { size: number; contentType: string | null } | null;
    try {
      meta = await storage.getCallRecordingMetadata(row.objectKey);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Call recording: could not check the upload");
      res.status(503).json({ error: "Recording storage is not available right now. Try again in a few minutes.", code: "storage_unavailable" });
      return;
    }
    if (!meta || meta.size <= 0) {
      res.status(409).json({ error: "The recording has not finished uploading. Upload it again.", code: "not_uploaded" });
      return;
    }
    if (meta.size > MAX_RECORDING_BYTES) {
      // The signed URL cannot bind the length, so an oversized file is not kept.
      await db.update(callRecordingsTable)
        .set({ status: "failed", error: "The recording is larger than the limit.", sizeBytes: meta.size, purgeAfter: purgeTime(row.createdAt), updatedAt: new Date() })
        .where(and(eq(callRecordingsTable.id, row.id), eq(callRecordingsTable.status, "uploading")));
      await deleteNow(storage, row.id, row.objectKey);
      res.status(413).json({ error: `Recordings are limited to ${MAX_RECORDING_BYTES / 1024 / 1024} MB.`, code: "file_too_large" });
      return;
    }
    // The cap is enforced again here, where transcription is committed: links
    // handed out in a burst cannot all be confirmed past it. A refusal is
    // claimed (uploading → failed) under the lock before anything is deleted,
    // so a concurrent confirm that already queued this recording keeps its audio.
    const limit = dailyRecordingLimit();
    const outcome = await db.transaction(async (tx) => {
      await lockRecordings(tx, authReq.orgId);
      const now = new Date();
      const stillUploading = and(eq(callRecordingsTable.id, row.id), eq(callRecordingsTable.status, "uploading"));
      if ((await recordingsToday(tx, authReq.orgId, now)) >= limit) {
        const refused = await tx.update(callRecordingsTable)
          .set({ status: "failed", error: "The daily recording limit was reached. Upload this recording again tomorrow.", purgeAfter: purgeTime(row.createdAt, now), updatedAt: now })
          .where(stillUploading)
          .returning({ id: callRecordingsTable.id });
        return refused.length ? ("over_limit" as const) : ("unchanged" as const);
      }
      const moved = await tx.update(callRecordingsTable)
        .set({ status: "queued", sizeBytes: meta.size, committedAt: now, updatedAt: now })
        .where(stillUploading)
        .returning({ id: callRecordingsTable.id });
      return moved.length ? ("queued" as const) : ("unchanged" as const);
    });
    if (outcome === "over_limit") {
      logger.warn({ orgId: authReq.orgId, limit }, "Call recording: daily limit reached at confirm");
      // Not transcribed, so the uploaded audio is not kept; the user uploads it again later.
      await deleteNow(storage, row.id, row.objectKey);
      res.status(429).json({ error: dailyLimitMessage(limit), code: "daily_limit" });
      return;
    }
    if (outcome === "queued") {
      const jobId = await enqueue(JOB_NAMES.TRANSCRIBE_RECORDING, { recordingId: row.id }, { singletonKey: transcribeJobKey(row.id) });
      if (!jobId) logger.error({ recordingId: row.id }, "Call recording: could not queue transcription");
      res.status(202).json({ recordingId: row.id, status: "queued" });
      return;
    }
    // Another confirm settled it first: report where it ended up.
    const [current] = await db.select({ status: callRecordingsTable.status }).from(callRecordingsTable).where(eq(callRecordingsTable.id, row.id)).limit(1);
    res.status(200).json({ recordingId: row.id, status: current?.status ?? row.status });
  },
);

/**
 * Delete audio that will not be transcribed, best effort. The row's
 * `purge_after` stays set, so the sweep deletes it again after the upload
 * link expires (and retries if this failed).
 */
async function deleteNow(storage: { deleteCallRecording(key: string): Promise<void> }, recordingId: string, objectKey: string): Promise<void> {
  try {
    await storage.deleteCallRecording(objectKey);
  } catch (err) {
    logger.warn({ err: (err as Error).message, recordingId }, "Call recording: could not delete unused audio now; the sweep will retry");
  }
}

const RecordingListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

router.get(
  "/call-scoring/recordings",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const q = RecordingListQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "Invalid filters.", code: "invalid" });
      return;
    }
    const rows = await db
      .select({
        id: callRecordingsTable.id,
        status: callRecordingsTable.status,
        layout: callRecordingsTable.layout,
        sizeBytes: callRecordingsTable.sizeBytes,
        durationSeconds: callRecordingsTable.durationSeconds,
        transcriptId: callRecordingsTable.transcriptId,
        error: callRecordingsTable.error,
        detailsEncrypted: callRecordingsTable.detailsEncrypted,
        createdAt: callRecordingsTable.createdAt,
        updatedAt: callRecordingsTable.updatedAt,
      })
      .from(callRecordingsTable)
      .where(eq(callRecordingsTable.orgId, authReq.orgId))
      .orderBy(desc(callRecordingsTable.createdAt))
      .limit(q.data.limit)
      .offset(q.data.offset);
    res.json({
      recordings: rows.map(({ detailsEncrypted, ...r }) => {
        const details = detailsEncrypted ? open<RecordingDetails>(detailsEncrypted) : null;
        return {
          ...r,
          filename: details?.filename ?? null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
      audio: audioConfig(),
    });
  },
);


// ---- EnrollHere call-log import ---------------------------------------------

/** A call-log export: thousands of rows of ~3 KB each. */
const MAX_CALL_LOG_BYTES = 20 * 1024 * 1024;
/** EnrollHere calls are scored on the IIA 2026 QA scorecard unless another checklist is chosen. */
const CALL_LOG_DEFAULT_RUBRIC_ID = "iia-2026-qa";
const callLogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CALL_LOG_BYTES, files: 1, fields: 5 } });

router.post(
  "/call-scoring/enrollhere-call-log",
  requireAuth,
  requireMfa,
  requirePermission("call_scoring", "create"),
  (req: Request, res: Response, next: NextFunction): void => {
    callLogUpload.single("file")(req, res, (err?: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") res.status(413).json({ error: "That file is larger than 20 MB. Export fewer days at a time.", code: "file_too_large" });
      else res.status(400).json({ error: "The upload could not be read.", code: "bad_upload" });
    });
  },
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "Choose the EnrollHere call-log CSV.", code: "no_file" });
      return;
    }
    const fields = z.object({ rubricId: optional(z.string().trim().max(64)) }).safeParse(req.body ?? {});
    if (!fields.success) {
      res.status(400).json({ error: "Check the fields you entered.", code: "invalid" });
      return;
    }
    const fallback = getRubric(CALL_LOG_DEFAULT_RUBRIC_ID) ?? getRubric(DEFAULT_RUBRIC_ID);
    const rubric = resolveRubric(fields.data.rubricId ?? CALL_LOG_DEFAULT_RUBRIC_ID, fallback as Rubric);
    if (!rubric) {
      res.status(400).json({ error: "Unknown rubric.", code: "unknown_rubric" });
      return;
    }
    let log: ReturnType<typeof readCallLog>;
    try {
      log = readCallLog(file.buffer);
    } catch (err) {
      if (err instanceof CsvFileError) {
        res.status(400).json({ error: err.message, code: "not_a_call_log" });
        return;
      }
      throw err;
    }
    const { ObjectStorageService } = await import("../lib/objectStorage");
    const storage = new ObjectStorageService();
    const summary = await importCallLog({
      orgId: authReq.orgId,
      userId: authReq.userId,
      userRole: authReq.userRole,
      rows: log.rows,
      unreadable: log.unreadable,
      rubricId: rubric.id,
      transcribe: speechSetup().ready,
      objectKey: (orgId, id) => storage.callRecordingKey(orgId, id),
    });
    // Counts only: never values from the file.
    logger.info(
      { orgId: authReq.orgId, rows: summary.rows, stored: summary.stored, queued: summary.queued, requeued: summary.requeued, duplicates: summary.duplicates, errors: summary.errors },
      "EnrollHere call log imported",
    );
    res.status(200).json({ ...summary, rubricId: rubric.id });
  },
);

export default router;
