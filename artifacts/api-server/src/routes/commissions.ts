/**
 * Commissions module routes (AgencyBloc parity).
 *
 * Three sub-resources:
 *   /commission-schedules    rate cards CRUD
 *   /commission-hierarchies  upline split grid
 *   /commissions/...         statements, line items, payouts, missed-payments
 *
 * The statement upload flow is upload -> parse -> reconcile. Parse pulls
 * rows from CSV via the carrier-specific parser registry. Reconcile
 * matches contacts/agents and computes payouts; it can be run inline or
 * dispatched to pg-boss.
 */
import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { and, asc, desc, eq, getTableColumns, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import multer from "multer";
import {
  db,
  agentCommissionPayoutsTable,
  agentsTable,
  carriersTable,
  commissionHierarchiesTable,
  commissionLineItemsTable,
  commissionSchedulesTable,
  commissionStatementsTable,
  contactsTable,
  missedPaymentAlertsTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { requireMfa } from "../middlewares/requireMfa";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";

import { enqueue, JOB_NAMES } from "../lib/jobs";
import {
  parseStatement,
  UnknownCarrierError,
  type NormalizedLineItem,
} from "../lib/commissionParsers";
import { reconcileStatement } from "../workers/reconcileCommissionStatement";
import { insertLineItems } from "../lib/commissions/insertLineItems";
import { can, type Role } from "../lib/permissions";
import {
  displayStatementStatus,
  statementVariance,
} from "../lib/commissions/statementStatus";

/**
 * Adds the shared review fields to a statement row: the variance between the
 * carrier's total and the parsed lines, and the status to SHOW (a reconciled
 * statement whose lines don't add up reads "reconciled_with_variance").
 */
function withStatementReview<
  T extends {
    status: string;
    totalAmount: string | null;
    lineItemCount?: number | null;
    lineItemTotal?: string | null;
  },
>(row: T) {
  const lineItemCount = Number(row.lineItemCount ?? 0);
  const lineItemTotal = Number(Number(row.lineItemTotal ?? 0).toFixed(2));
  const variance = statementVariance(row.totalAmount, lineItemTotal, lineItemCount);
  return {
    ...row,
    lineItemCount,
    lineItemTotal,
    variance,
    displayStatus: displayStatementStatus(row.status, variance),
  };
}

const router: IRouter = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.use(
  routerAuditMiddleware(router, "commission", undefined, {

    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

// ─── Pagination guards (inlined; lib/listGuards.ts not yet on main) ────

function safeLimit(raw: unknown, fallback = 50, max = 200): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function safeOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

const onlyParam = (raw: unknown): string | undefined => {
  if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : undefined;
  return typeof raw === "string" ? raw : undefined;
};

// ─── Commission schedules ──────────────────────────────────────────────

const CreateScheduleSchema = z.object({
  carrierId: z.string().min(1),
  planType: z.enum(["MA", "PDP", "MAPD", "supp", "other"]),
  contractYear: z.number().int().min(1900).max(3000),
  initialPct: z.number().min(0).max(100).optional().nullable(),
  renewalPct: z.number().min(0).max(100).optional().nullable(),
  flatAmount: z.number().min(0).optional().nullable(),
  effectiveFrom: z.string().min(1),
  effectiveTo: z.string().nullable().optional(),
});

const UpdateScheduleSchema = CreateScheduleSchema.partial().extend({
  status: z.enum(["active", "archived"]).optional(),
});

router.post(
  "/commission-schedules",
  requireAuth,
  requireMfa,
  requirePermission("commission", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const [row] = await db
      .insert(commissionSchedulesTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        carrierId: data.carrierId,
        planType: data.planType,
        contractYear: data.contractYear,
        initialPct: data.initialPct != null ? String(data.initialPct) : null,
        renewalPct: data.renewalPct != null ? String(data.renewalPct) : null,
        flatAmount: data.flatAmount != null ? String(data.flatAmount) : null,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
        status: "active",
      })
      .returning();
    res.status(201).json(row);
  },
);

router.get(
  "/commission-schedules",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const carrierId = onlyParam(req.query.carrierId);
    const yearRaw = onlyParam(req.query.year);
    const year = yearRaw ? parseInt(yearRaw, 10) : undefined;

    const conditions = [eq(commissionSchedulesTable.orgId, authReq.orgId)];
    if (carrierId) conditions.push(eq(commissionSchedulesTable.carrierId, carrierId));
    if (year && Number.isFinite(year)) {
      conditions.push(eq(commissionSchedulesTable.contractYear, year));
    }

    const rows = await db
      .select()
      .from(commissionSchedulesTable)
      .where(and(...conditions))
      .orderBy(desc(commissionSchedulesTable.contractYear))
      .limit(safeLimit(req.query.limit))
      .offset(safeOffset(req.query.offset));

    res.json(rows);
  },
);

router.patch(
  "/commission-schedules/:id",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const parsed = UpdateScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const updates: Record<string, unknown> = {};
    const data = parsed.data;
    if (data.carrierId !== undefined) updates.carrierId = data.carrierId;
    if (data.planType !== undefined) updates.planType = data.planType;
    if (data.contractYear !== undefined) updates.contractYear = data.contractYear;
    if (data.initialPct !== undefined) updates.initialPct = data.initialPct == null ? null : String(data.initialPct);
    if (data.renewalPct !== undefined) updates.renewalPct = data.renewalPct == null ? null : String(data.renewalPct);
    if (data.flatAmount !== undefined) updates.flatAmount = data.flatAmount == null ? null : String(data.flatAmount);
    if (data.effectiveFrom !== undefined) updates.effectiveFrom = data.effectiveFrom;
    if (data.effectiveTo !== undefined) updates.effectiveTo = data.effectiveTo;
    if (data.status !== undefined) updates.status = data.status;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [row] = await db
      .update(commissionSchedulesTable)
      .set(updates)
      .where(
        and(
          eq(commissionSchedulesTable.id, id),
          eq(commissionSchedulesTable.orgId, authReq.orgId),
        ),
      )
      .returning();

    if (!row) {
      res.status(404).json({ error: "Commission schedule not found" });
      return;
    }

    res.json(row);
  },
);

router.delete(
  "/commission-schedules/:id",
  requireAuth,
  requireMfa,
  // PR #49 caught the asymmetry: POST/PATCH allow agency_admin via
  // commission:create / commission:update, but DELETE required
  // commission:delete (super_admin only). An admin who can create a
  // bad rate card should be able to delete it themselves without
  // flagging super-admin attention. Aligning DELETE to commission:update.
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [row] = await db
      .delete(commissionSchedulesTable)
      .where(
        and(
          eq(commissionSchedulesTable.id, id),
          eq(commissionSchedulesTable.orgId, authReq.orgId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Commission schedule not found" });
      return;
    }
    res.sendStatus(204);
  },
);

// ─── Commission hierarchies ────────────────────────────────────────────

const CreateHierarchySchema = z.object({
  writingAgentId: z.string().min(1),
  uplineAgentId: z.string().nullable().optional(),
  splitPct: z.number().min(0).max(100),
  effectiveFrom: z.string().min(1),
  effectiveTo: z.string().nullable().optional(),
});

router.post(
  "/commission-hierarchies",
  requireAuth,
  requireMfa,
  requirePermission("commission", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateHierarchySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const [row] = await db
      .insert(commissionHierarchiesTable)
      .values({
        id: randomUUID(),
        orgId: authReq.orgId,
        writingAgentId: data.writingAgentId,
        uplineAgentId: data.uplineAgentId ?? null,
        splitPct: String(data.splitPct),
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
      })
      .returning();
    res.status(201).json(row);
  },
);

router.get(
  "/commission-hierarchies",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = onlyParam(req.query.agentId);

    const conditions = [eq(commissionHierarchiesTable.orgId, authReq.orgId)];
    if (agentId) conditions.push(eq(commissionHierarchiesTable.writingAgentId, agentId));

    const rows = await db
      .select()
      .from(commissionHierarchiesTable)
      .where(and(...conditions))
      .orderBy(desc(commissionHierarchiesTable.effectiveFrom))
      .limit(safeLimit(req.query.limit))
      .offset(safeOffset(req.query.offset));
    res.json(rows);
  },
);

// ─── Statement upload / parse / reconcile ─────────────────────────────

const StatementMetaSchema = z.object({
  carrierId: z.string().min(1),
  statementDate: z.string().min(1),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  totalAmount: z.union([z.string(), z.number()]).optional().nullable(),
  // "true" = read the file straight away (the upload screen does this). Left
  // off, the statement stays pending until POST .../parse is sent the file.
  parse: z.enum(["true", "false"]).optional(),
});

/** The uploaded file could not be turned into statement lines (a problem with the file, not the server). */
class StatementReadError extends Error {}

/**
 * Turn a statement file into normalized lines. Only problems with the file
 * (no reader for the carrier, unreadable content) are thrown as
 * StatementReadError, so callers can tell them apart from database failures.
 */
function readStatementFile(carrierName: string, buffer: Buffer): NormalizedLineItem[] {
  try {
    return parseStatement(carrierName, buffer);
  } catch (err) {
    if (err instanceof UnknownCarrierError) throw new StatementReadError(err.message);
    throw new StatementReadError(
      "Could not read that file. Check it is a text or CSV statement from this carrier.",
    );
  }
}

router.post(
  "/commissions/statements",
  requireAuth,
  requireMfa,
  requirePermission("commission", "create"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const parsed = StatementMetaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    // Verify carrier belongs to org
    const [carrier] = await db
      .select({ id: carriersTable.id, name: carriersTable.name })
      .from(carriersTable)
      .where(
        and(eq(carriersTable.id, data.carrierId), eq(carriersTable.orgId, authReq.orgId)),
      )
      .limit(1);
    if (!carrier) {
      res.status(404).json({ error: "Carrier not found" });
      return;
    }

    const id = randomUUID();
    // For now we just record the original filename as the storage key —
    // actual blob upload to object storage is out of scope for this PR.
    const storageKey = `commission-statements/${authReq.orgId}/${id}/${req.file.originalname}`;

    // The file is not stored (no blob storage yet), so it can only be read
    // while this request still holds it. With `parse=true` we read it now;
    // otherwise the caller re-sends it to POST .../parse.
    let normalized: NormalizedLineItem[] | null = null;
    let readError: string | null = null;
    if (data.parse === "true") {
      try {
        normalized = readStatementFile(carrier.name, req.file.buffer);
      } catch (err) {
        if (!(err instanceof StatementReadError)) throw err;
        readError = err.message;
      }
    }

    // Statement + lines + status go in together: a database failure leaves
    // nothing half-written and surfaces as a normal server error (not as a
    // "couldn't read your file" message).
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(commissionStatementsTable)
        .values({
          id,
          orgId: authReq.orgId,
          carrierId: data.carrierId,
          statementDate: data.statementDate,
          periodStart: data.periodStart,
          periodEnd: data.periodEnd,
          totalAmount: data.totalAmount != null ? String(data.totalAmount) : null,
          currency: "USD",
          source: "csv_upload",
          storageKey,
          status: normalized ? "parsed" : "pending",
          uploadedByUserId: authReq.userId,
        })
        .returning();
      if (normalized && normalized.length > 0) {
        await insertLineItems(tx, id, authReq.orgId, normalized);
      }
      return created!;
    });

    if (data.parse === "true") {
      res
        .status(201)
        .json({ ...row, parse: normalized ? { inserted: normalized.length } : { error: readError } });
      return;
    }

    res.status(201).json({
      ...row,
      _hint: "POST /commissions/statements/:id/parse with the same file to extract line items",
    });
  },
);

// Inline parser — accepts the file again because we don't have blob storage
// wired up here. The same multer config as /statements applies.
router.post(
  "/commissions/statements/:id/parse",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  upload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [statement] = await db
      .select({
        id: commissionStatementsTable.id,
        orgId: commissionStatementsTable.orgId,
        carrierId: commissionStatementsTable.carrierId,
      })
      .from(commissionStatementsTable)
      .where(
        and(
          eq(commissionStatementsTable.id, id),
          eq(commissionStatementsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    if (!statement) {
      res.status(404).json({ error: "Statement not found" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded for parsing" });
      return;
    }

    const [carrier] = await db
      .select({ id: carriersTable.id, name: carriersTable.name })
      .from(carriersTable)
      .where(eq(carriersTable.id, statement.carrierId))
      .limit(1);
    if (!carrier) {
      res.status(404).json({ error: "Carrier not found" });
      return;
    }

    let normalized: NormalizedLineItem[];
    try {
      normalized = readStatementFile(carrier.name, req.file.buffer);
    } catch (err) {
      if (err instanceof StatementReadError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // One parse at a time per statement, and only while it still has no lines:
    // a second (or concurrent) request must not append the same lines again.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`commission-statement-parse:${id}`}))`);
      const [current] = await tx
        .select({ status: commissionStatementsTable.status })
        .from(commissionStatementsTable)
        .where(
          and(
            eq(commissionStatementsTable.id, id),
            eq(commissionStatementsTable.orgId, authReq.orgId),
          ),
        )
        .limit(1);
      if (!current) return { kind: "missing" as const };
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(commissionLineItemsTable)
        .where(
          and(
            eq(commissionLineItemsTable.statementId, id),
            eq(commissionLineItemsTable.orgId, authReq.orgId),
          ),
        );
      const readable = current.status === "pending" || (current.status === "parsed" && n === 0);
      if (!readable) return { kind: "already_read" as const };
      const inserted =
        normalized.length > 0 ? await insertLineItems(tx, id, authReq.orgId, normalized) : 0;
      await tx
        .update(commissionStatementsTable)
        .set({ status: "parsed" })
        .where(
          and(
            eq(commissionStatementsTable.id, id),
            eq(commissionStatementsTable.orgId, authReq.orgId),
          ),
        );
      return { kind: "ok" as const, inserted };
    });

    if (result.kind === "missing") {
      res.status(404).json({ error: "Statement not found" });
      return;
    }
    if (result.kind === "already_read") {
      res.status(409).json({ error: "This statement has already been read. Upload it again as a new statement if it needs re-reading." });
      return;
    }
    res.json({ inserted: result.inserted, statementId: id });
  },
);

router.post(
  "/commissions/statements/:id/reconcile",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [statement] = await db
      .select({ id: commissionStatementsTable.id })
      .from(commissionStatementsTable)
      .where(
        and(
          eq(commissionStatementsTable.id, id),
          eq(commissionStatementsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    if (!statement) {
      res.status(404).json({ error: "Statement not found" });
      return;
    }

    const async_ = onlyParam(req.query.async) === "true";
    if (async_) {
      await enqueue(JOB_NAMES.RECONCILE_COMMISSION_STATEMENT, {
        statementId: id,
        orgId: authReq.orgId,
      });
      res.json({ queued: true, statementId: id });
      return;
    }

    const result = await reconcileStatement(id, authReq.orgId);
    res.json({ statementId: id, ...result });
  },
);

router.get(
  "/commissions/statements",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const status = onlyParam(req.query.status);
    const from = onlyParam(req.query.from);
    const to = onlyParam(req.query.to);

    const conditions = [eq(commissionStatementsTable.orgId, authReq.orgId)];
    if (status) conditions.push(eq(commissionStatementsTable.status, status));
    if (from) conditions.push(gte(commissionStatementsTable.statementDate, from));
    if (to) conditions.push(lte(commissionStatementsTable.statementDate, to));

    // Per-statement line totals (org-scoped) so every row carries the same
    // variance / displayStatus the detail and Reconciliation pages show.
    const itemAgg = db
      .select({
        statementId: commissionLineItemsTable.statementId,
        lineItemCount: sql<number>`count(*)::int`.as("line_item_count"),
        lineItemTotal: sql<string>`coalesce(sum(${commissionLineItemsTable.commissionAmount}), 0)::text`.as(
          "line_item_total",
        ),
      })
      .from(commissionLineItemsTable)
      .where(eq(commissionLineItemsTable.orgId, authReq.orgId))
      .groupBy(commissionLineItemsTable.statementId)
      .as("item_agg");

    // Carrier name joined in (org-scoped) so the list can show it.
    const rows = await db
      .select({
        ...getTableColumns(commissionStatementsTable),
        carrierName: carriersTable.name,
        lineItemCount: itemAgg.lineItemCount,
        lineItemTotal: itemAgg.lineItemTotal,
      })
      .from(commissionStatementsTable)
      .leftJoin(
        carriersTable,
        and(
          eq(commissionStatementsTable.carrierId, carriersTable.id),
          eq(carriersTable.orgId, authReq.orgId),
        ),
      )
      .leftJoin(itemAgg, eq(itemAgg.statementId, commissionStatementsTable.id))
      .where(and(...conditions))
      .orderBy(desc(commissionStatementsTable.statementDate))
      .limit(safeLimit(req.query.limit))
      .offset(safeOffset(req.query.offset));
    res.json(rows.map((r) => withStatementReview(r)));
  },
);

// Single statement with its carrier name and line-item match counts, for
// the statement detail page.
router.get(
  "/commissions/statements/:id",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [row] = await db
      .select({
        statement: commissionStatementsTable,
        carrierName: carriersTable.name,
      })
      .from(commissionStatementsTable)
      .leftJoin(carriersTable, eq(carriersTable.id, commissionStatementsTable.carrierId))
      .where(
        and(
          eq(commissionStatementsTable.id, id),
          eq(commissionStatementsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Statement not found" });
      return;
    }

    const [counts] = await db
      .select({
        lineItemCount: sql<number>`count(*)::int`,
        unmatchedCount: sql<number>`count(*) FILTER (WHERE ${commissionLineItemsTable.matchStatus} = 'unmatched')::int`,
        lineItemTotal: sql<string>`coalesce(sum(${commissionLineItemsTable.commissionAmount}), 0)::text`,
      })
      .from(commissionLineItemsTable)
      .where(
        and(
          eq(commissionLineItemsTable.statementId, id),
          eq(commissionLineItemsTable.orgId, authReq.orgId),
        ),
      );
    const lineItemCount = Number(counts?.lineItemCount ?? 0);
    const unmatchedCount = Number(counts?.unmatchedCount ?? 0);

    res.json({
      ...withStatementReview({
        ...row.statement,
        lineItemCount,
        lineItemTotal: counts?.lineItemTotal ?? "0",
      }),
      carrierName: row.carrierName ?? null,
      lineItemCount,
      // "manual" matches count as matched, same as the detail page's
      // client-side fallback.
      matchedCount: lineItemCount - unmatchedCount,
      unmatchedCount,
    });
  },
);

router.get(
  "/commissions/statements/:id/line-items",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const matchStatus = onlyParam(req.query.match_status);

    const conditions = [
      eq(commissionLineItemsTable.statementId, id),
      eq(commissionLineItemsTable.orgId, authReq.orgId),
    ];
    if (matchStatus) {
      conditions.push(eq(commissionLineItemsTable.matchStatus, matchStatus));
    }

    // Names for matched rows so the table reads "Margaret Anderson" rather
    // than "Member MBR-1000". Both joins are org-scoped. The client name is
    // only returned to roles that may read contacts (contact:read); others
    // get null and the page falls back to "Linked client". Member ids are
    // never echoed in a name field.
    const showContact = can(authReq.userRole as Role, "contact", "read");
    const rows = await db
      .select({
        item: commissionLineItemsTable,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
        agentFirstName: agentsTable.firstName,
        agentLastName: agentsTable.lastName,
      })
      .from(commissionLineItemsTable)
      .leftJoin(
        contactsTable,
        and(
          eq(contactsTable.id, commissionLineItemsTable.contactId),
          eq(contactsTable.orgId, authReq.orgId),
        ),
      )
      .leftJoin(
        agentsTable,
        and(
          eq(agentsTable.id, commissionLineItemsTable.writingAgentId),
          eq(agentsTable.orgId, authReq.orgId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(commissionLineItemsTable.createdAt))
      .limit(safeLimit(req.query.limit, 200, 1000))
      .offset(safeOffset(req.query.offset));
    const fullName = (f: string | null, l: string | null): string | null =>
      f || l ? `${f ?? ""} ${l ?? ""}`.trim() : null;
    res.json(
      rows.map((r) => ({
        ...r.item,
        contactName: showContact ? fullName(r.contactFirstName, r.contactLastName) : null,
        writingAgentName: fullName(r.agentFirstName, r.agentLastName),
      })),
    );
  },
);

const PatchLineItemSchema = z.object({
  contactId: z.string().nullable().optional(),
  writingAgentId: z.string().nullable().optional(),
  match_status: z.enum(["matched", "unmatched", "manual"]),
});

router.patch(
  "/commissions/line-items/:id",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const parsed = PatchLineItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const updates: Record<string, unknown> = { matchStatus: data.match_status };
    if (data.contactId !== undefined) updates.contactId = data.contactId;
    if (data.writingAgentId !== undefined) updates.writingAgentId = data.writingAgentId;
    const [row] = await db
      .update(commissionLineItemsTable)
      .set(updates)
      .where(
        and(
          eq(commissionLineItemsTable.id, id),
          eq(commissionLineItemsTable.orgId, authReq.orgId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Line item not found" });
      return;
    }
    res.json(row);
  },
);

// ─── Per-agent commission breakdown ───────────────────────────────────

router.get(
  "/agents/:id/commissions",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // Self + admin gate: agents may read their own; others need broader perms
    if (authReq.userRole === "agent") {
      const [self] = await db
        .select({ userId: agentsTable.userId })
        .from(agentsTable)
        .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, authReq.orgId)))
        .limit(1);
      if (!self || self.userId !== authReq.userId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }

    const period = onlyParam(req.query.period); // YYYY-MM
    const type = onlyParam(req.query.type);

    const lineItemConds = [
      eq(commissionLineItemsTable.orgId, authReq.orgId),
      eq(commissionLineItemsTable.writingAgentId, agentId),
    ];
    if (type) lineItemConds.push(eq(commissionLineItemsTable.type, type));
    if (period && /^\d{4}-\d{2}$/.test(period)) {
      const [y, m] = period.split("-").map(Number);
      const startISO = `${period}-01`;
      const endDate = new Date(Date.UTC(y, m, 0));
      const endISO = endDate.toISOString().slice(0, 10);
      lineItemConds.push(gte(commissionLineItemsTable.periodStart, startISO));
      lineItemConds.push(lte(commissionLineItemsTable.periodEnd, endISO));
    }

    const [lineItems, payouts] = await Promise.all([
      db
        .select()
        .from(commissionLineItemsTable)
        .where(and(...lineItemConds))
        .orderBy(desc(commissionLineItemsTable.createdAt))
        .limit(safeLimit(req.query.limit, 100, 500))
        .offset(safeOffset(req.query.offset)),
      db
        .select()
        .from(agentCommissionPayoutsTable)
        .where(
          and(
            eq(agentCommissionPayoutsTable.orgId, authReq.orgId),
            eq(agentCommissionPayoutsTable.agentId, agentId),
          ),
        )
        .orderBy(desc(agentCommissionPayoutsTable.periodStart)),
    ]);

    // Summary fields for the agent profile's Commissions tab. Derived only
    // from the rows above (payouts are unbounded per agent; line items are
    // the paged window), so the figures always match what the tab renders.
    const thisYear = String(new Date().getUTCFullYear());
    let lifetimeEarned = 0;
    let ytdEarned = 0;
    let pendingPayouts = 0;
    for (const p of payouts) {
      const earned = Number(p.earned ?? 0);
      lifetimeEarned += earned;
      if (String(p.periodStart).startsWith(thisYear)) ytdEarned += earned;
      if (p.status !== "paid") pendingPayouts += earned;
    }
    const latest = payouts[0];
    const periods = payouts.map((p) => ({
      id: p.id,
      period: `${p.periodStart} – ${p.periodEnd}`,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      earned: p.earned,
      paid: p.paid,
      status: p.status,
      paidAt: p.paidAt,
    }));

    res.json({
      lineItems,
      payouts,
      periods,
      lifetimeEarned: Number(lifetimeEarned.toFixed(2)),
      ytdEarned: Number(ytdEarned.toFixed(2)),
      currentPeriodEarned: latest ? Number(Number(latest.earned ?? 0).toFixed(2)) : 0,
      pendingPayouts: Number(pendingPayouts.toFixed(2)),
    });
  },
);

// POST /agents/:id/commissions/:periodId/mark-paid — the "Mark paid"
// button on an agent's Commissions tab. `periodId` is the payout row id
// (agent_commission_payouts.id). Same gate as the payout upsert below
// (commission:update + MFA), org-scoped, and scoped to the agent in the
// path so a payout id from another agent 404s. Paid amount defaults to
// the earned amount when nothing was recorded as paid yet. Audit-logged
// by the router-level auditMiddleware like every other commission write.
router.post(
  "/agents/:id/commissions/:periodId/mark-paid",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = onlyParam(req.params.id) ?? "";
    const payoutId = onlyParam(req.params.periodId) ?? "";

    const [existing] = await db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.id, payoutId),
          eq(agentCommissionPayoutsTable.orgId, authReq.orgId),
          eq(agentCommissionPayoutsTable.agentId, agentId),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Payout not found" });
      return;
    }
    if (existing.status === "paid") {
      res.status(409).json({ error: "Payout is already marked paid" });
      return;
    }

    const paidAmount = Number(existing.paid ?? 0) > 0 ? existing.paid : existing.earned;
    const [row] = await db
      .update(agentCommissionPayoutsTable)
      .set({
        status: "paid",
        paid: paidAmount,
        paidAt: new Date(),
        paidByUserId: authReq.userId,
      })
      .where(
        and(
          eq(agentCommissionPayoutsTable.id, existing.id),
          eq(agentCommissionPayoutsTable.orgId, authReq.orgId),
        ),
      )
      .returning();
    res.json(row);
  },
);

// ─── Agent self-serve view ────────────────────────────────────────────
//
// GET /commissions/me — an agent's own commission statements + a
// paid-vs-pending summary. Unlike the admin surfaces above this is NOT
// gated on `commission:read` (agents don't hold that permission); the
// authorization model is "your own agentId". We resolve the caller's
// agent row the same way the queue heartbeat does (agentsTable where
// userId + orgId match the Clerk session) so an agent can only ever see
// their own payouts. Returns 404 when the caller has no linked agent.
//
// The per-agent "statement" here is a row in agent_commission_payouts
// (period + earned + paid + status), which is the only table with a
// clean direct agentId FK. A payout counts as paid when its status is
// "paid"; everything else (open/approved/held) is pending.
router.get(
  "/commissions/me",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const [agent] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.userId, authReq.userId),
          eq(agentsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);

    if (!agent) {
      res
        .status(404)
        .json({ error: "No agent record is linked to your account." });
      return;
    }

    const statements = await db
      .select()
      .from(agentCommissionPayoutsTable)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, authReq.orgId),
          eq(agentCommissionPayoutsTable.agentId, agent.id),
        ),
      )
      .orderBy(desc(agentCommissionPayoutsTable.periodStart))
      .limit(safeLimit(req.query.limit, 100, 500))
      .offset(safeOffset(req.query.offset));

    // Summary math is computed from the rows we fetched so it always
    // matches what the client renders. `paid` rows contribute their
    // `paid` amount to totalPaid; all other statuses contribute their
    // outstanding (earned) amount to totalPending.
    let totalPaid = 0;
    let totalPending = 0;
    let paidCount = 0;
    let pendingCount = 0;
    for (const s of statements) {
      if (s.status === "paid") {
        totalPaid += Number(s.paid ?? 0);
        paidCount += 1;
      } else {
        totalPending += Number(s.earned ?? 0);
        pendingCount += 1;
      }
    }

    res.json({
      data: statements,
      summary: {
        totalPaid: Number(totalPaid.toFixed(2)),
        totalPending: Number(totalPending.toFixed(2)),
        paidCount,
        pendingCount,
        statementCount: statements.length,
      },
      asOf: new Date().toISOString(),
    });
  },
);

const UpsertPayoutSchema = z.object({
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  paid: z.union([z.string(), z.number()]).optional(),
  status: z.enum(["open", "approved", "paid", "held"]).optional(),
});

router.post(
  "/agents/:id/commissions/payouts",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const agentId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const parsed = UpsertPayoutSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    const updates: Record<string, unknown> = {};
    if (data.paid !== undefined) updates.paid = String(data.paid);
    if (data.status !== undefined) {
      updates.status = data.status;
      if (data.status === "paid") {
        updates.paidAt = new Date();
        updates.paidByUserId = authReq.userId;
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [row] = await db
      .update(agentCommissionPayoutsTable)
      .set(updates)
      .where(
        and(
          eq(agentCommissionPayoutsTable.orgId, authReq.orgId),
          eq(agentCommissionPayoutsTable.agentId, agentId),
          eq(agentCommissionPayoutsTable.periodStart, data.periodStart),
          eq(agentCommissionPayoutsTable.periodEnd, data.periodEnd),
        ),
      )
      .returning();

    if (!row) {
      res.status(404).json({ error: "Payout not found for that period" });
      return;
    }
    res.json(row);
  },
);

// ─── Org-wide KPI summary ─────────────────────────────────────────────
//
// GET /commissions/summary[?period=YYYY-MM] — the stat cards on the
// commissions page. Figures come from agent_commission_payouts for one
// calendar month:
//   - `period` query param when given, else
//   - the month of the most recent payout period (carrier statements land
//     after the month closes, so the current month is usually still empty),
//     else the current month.
// Paid/pending use the same rule as /commissions/me: a "paid" payout
// contributes its paid amount; any other status contributes its earned
// amount to pending. Missed payments counts unresolved alerts (not
// period-bound: an open alert stays actionable until resolved).

function monthBounds(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

router.get(
  "/commissions/summary",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const periodParam = onlyParam(req.query.period);
    if (periodParam !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodParam)) {
      res.status(400).json({ error: "period must be YYYY-MM" });
      return;
    }

    let year: number;
    let month: number;
    if (periodParam) {
      [year, month] = periodParam.split("-").map(Number) as [number, number];
    } else {
      const [latest] = await db
        .select({ periodStart: sql<string | null>`max(${agentCommissionPayoutsTable.periodStart})::text` })
        .from(agentCommissionPayoutsTable)
        .where(eq(agentCommissionPayoutsTable.orgId, authReq.orgId));
      const anchor = latest?.periodStart
        ? new Date(`${latest.periodStart}T00:00:00Z`)
        : new Date();
      year = anchor.getUTCFullYear();
      month = anchor.getUTCMonth() + 1;
    }
    const { start, end } = monthBounds(year, month);

    const [[totals], [missed]] = await Promise.all([
      db
        .select({
          earned: sql<string>`coalesce(sum(${agentCommissionPayoutsTable.earned}), 0)::text`,
          paid: sql<string>`coalesce(sum(${agentCommissionPayoutsTable.paid}) FILTER (WHERE ${agentCommissionPayoutsTable.status} = 'paid'), 0)::text`,
          pending: sql<string>`coalesce(sum(${agentCommissionPayoutsTable.earned}) FILTER (WHERE ${agentCommissionPayoutsTable.status} <> 'paid'), 0)::text`,
          agents: sql<number>`count(DISTINCT ${agentCommissionPayoutsTable.agentId})::int`,
        })
        .from(agentCommissionPayoutsTable)
        .where(
          and(
            eq(agentCommissionPayoutsTable.orgId, authReq.orgId),
            gte(agentCommissionPayoutsTable.periodStart, start),
            lte(agentCommissionPayoutsTable.periodStart, end),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(missedPaymentAlertsTable)
        .where(
          and(
            eq(missedPaymentAlertsTable.orgId, authReq.orgId),
            isNull(missedPaymentAlertsTable.resolvedAt),
          ),
        ),
    ]);

    const periodLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    res.json({
      period: `${year}-${String(month).padStart(2, "0")}`,
      periodLabel,
      periodStart: start,
      periodEnd: end,
      earnedThisPeriod: Number(Number(totals?.earned ?? 0).toFixed(2)),
      paidThisPeriod: Number(Number(totals?.paid ?? 0).toFixed(2)),
      pendingThisPeriod: Number(Number(totals?.pending ?? 0).toFixed(2)),
      agentsOnPayouts: Number(totals?.agents ?? 0),
      missedPaymentsCount: Number(missed?.count ?? 0),
    });
  },
);

// ─── Missed payments ──────────────────────────────────────────────────

// GET /commissions/missed-payments[?days_overdue=N&status=open|resolved|all]
// Open (unresolved) alerts by default — the same set the summary card
// counts — so resolving one removes it from the list. Each row carries the
// contact's name and how many days it has been outstanding.
router.get(
  "/commissions/missed-payments",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const daysOverdueRaw = onlyParam(req.query.days_overdue);
    const days = daysOverdueRaw ? parseInt(daysOverdueRaw, 10) : 0;
    const status = onlyParam(req.query.status) ?? "open";
    if (!["open", "resolved", "all"].includes(status)) {
      res.status(400).json({ error: "status must be open, resolved or all" });
      return;
    }

    const conditions = [eq(missedPaymentAlertsTable.orgId, authReq.orgId)];
    if (status === "open") conditions.push(isNull(missedPaymentAlertsTable.resolvedAt));
    if (status === "resolved") conditions.push(isNotNull(missedPaymentAlertsTable.resolvedAt));
    if (Number.isFinite(days) && days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      conditions.push(lte(missedPaymentAlertsTable.detectedAt, cutoff));
    }

    const rows = await db
      .select({
        alert: missedPaymentAlertsTable,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
      })
      .from(missedPaymentAlertsTable)
      .leftJoin(
        contactsTable,
        and(
          eq(missedPaymentAlertsTable.contactId, contactsTable.id),
          eq(contactsTable.orgId, authReq.orgId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(missedPaymentAlertsTable.detectedAt))
      .limit(safeLimit(req.query.limit, 100, 500))
      .offset(safeOffset(req.query.offset));

    const now = Date.now();
    res.json(
      rows.map(({ alert, contactFirstName, contactLastName }) => {
        let expectedPeriodEnd: string | null = null;
        if (alert.expectedPeriod) {
          const [y, m] = String(alert.expectedPeriod).split("-").map(Number);
          if (y && m) expectedPeriodEnd = monthBounds(y, m).end;
        }
        const name = [contactFirstName, contactLastName].filter(Boolean).join(" ");
        return {
          ...alert,
          contactName: name || null,
          expectedPeriodStart: alert.expectedPeriod,
          expectedPeriodEnd,
          daysOverdue: Math.max(
            0,
            Math.floor((now - new Date(alert.detectedAt).getTime()) / 86_400_000),
          ),
        };
      }),
    );
  },
);

// POST /commissions/missed-payments/:id/resolve — "Mark resolved" on the
// commissions page. commission:update + MFA like the other commission
// writes; org-scoped (another org's alert 404s); resolving twice is a 409
// so the original resolution note is never overwritten. Audit-logged by the
// router-level auditMiddleware.
const ResolveMissedPaymentSchema = z.object({
  note: z.string().max(2000).optional().nullable(),
});

router.post(
  "/commissions/missed-payments/:id/resolve",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = onlyParam(req.params.id) ?? "";
    const parsed = ResolveMissedPaymentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const note = parsed.data.note?.trim() || null;

    const [existing] = await db
      .select({ id: missedPaymentAlertsTable.id, resolvedAt: missedPaymentAlertsTable.resolvedAt })
      .from(missedPaymentAlertsTable)
      .where(
        and(
          eq(missedPaymentAlertsTable.id, id),
          eq(missedPaymentAlertsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Missed payment not found" });
      return;
    }
    if (existing.resolvedAt) {
      res.status(409).json({ error: "Missed payment is already resolved" });
      return;
    }

    const [row] = await db
      .update(missedPaymentAlertsTable)
      .set({ resolvedAt: new Date(), resolutionNote: note })
      .where(
        and(
          eq(missedPaymentAlertsTable.id, id),
          eq(missedPaymentAlertsTable.orgId, authReq.orgId),
          isNull(missedPaymentAlertsTable.resolvedAt),
        ),
      )
      .returning();
    if (!row) {
      res.status(409).json({ error: "Missed payment is already resolved" });
      return;
    }
    res.json(row);
  },
);

export default router;
