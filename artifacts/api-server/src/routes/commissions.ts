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
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
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
});

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

    const [row] = await db
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
        status: "pending",
        uploadedByUserId: authReq.userId,
      })
      .returning();

    res.status(201).json({
      ...row,
      // Keep buffer in-memory on the server filesystem under storageKey is a
      // future concern; for now stash it on the response so the parse step
      // can be run via a separate request that re-uploads, OR we can parse
      // immediately. We do the immediate path in `parse` below using a
      // base64 round-trip when storage is not configured.
      _hint: "POST /commissions/statements/:id/parse with the same file to extract line items",
    });

    // Defer-then-encode: stash the buffer as base64 on the row's raw via
    // line_items? No — we keep the parser inline by holding the file in
    // memory under a session-scoped map. Instead the client should call
    // parse with the file body again, or use the inline parse param below.
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
      normalized = parseStatement(carrier.name, req.file.buffer);
    } catch (err) {
      if (err instanceof UnknownCarrierError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    if (normalized.length === 0) {
      await db
        .update(commissionStatementsTable)
        .set({ status: "parsed" })
        .where(eq(commissionStatementsTable.id, id));
      res.json({ inserted: 0, statementId: id });
      return;
    }

    const rows = normalized.map((n) => ({
      id: randomUUID(),
      statementId: id,
      orgId: authReq.orgId,
      contactId: null,
      memberId: n.memberId,
      policyNumber: n.policyNumber,
      planType: n.planType,
      planYear: n.planYear,
      periodStart: n.periodStart,
      periodEnd: n.periodEnd,
      premium: n.premium,
      commissionAmount: n.commissionAmount,
      type: n.type,
      writingAgentId: null,
      matchStatus: "unmatched" as const,
      raw: {
        ...n.raw,
        contactFirstName: n.contactFirstName,
        contactLastName: n.contactLastName,
        contactDob: n.contactDob,
        contactStateCode: n.contactStateCode,
      },
    }));

    // Insert in chunks to keep parameter count manageable
    const chunkSize = 200;
    for (let i = 0; i < rows.length; i += chunkSize) {
      await db.insert(commissionLineItemsTable).values(rows.slice(i, i + chunkSize));
    }

    await db
      .update(commissionStatementsTable)
      .set({ status: "parsed" })
      .where(eq(commissionStatementsTable.id, id));

    res.json({ inserted: rows.length, statementId: id });
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

    const rows = await db
      .select()
      .from(commissionStatementsTable)
      .where(and(...conditions))
      .orderBy(desc(commissionStatementsTable.statementDate))
      .limit(safeLimit(req.query.limit))
      .offset(safeOffset(req.query.offset));
    res.json(rows);
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
      ...row.statement,
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

    const rows = await db
      .select()
      .from(commissionLineItemsTable)
      .where(and(...conditions))
      .orderBy(asc(commissionLineItemsTable.createdAt))
      .limit(safeLimit(req.query.limit, 200, 1000))
      .offset(safeOffset(req.query.offset));
    res.json(rows);
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

    res.json({ lineItems, payouts });
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

router.get(
  "/commissions/missed-payments",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const daysOverdueRaw = onlyParam(req.query.days_overdue);
    const days = daysOverdueRaw ? parseInt(daysOverdueRaw, 10) : 0;

    const conditions = [eq(missedPaymentAlertsTable.orgId, authReq.orgId)];
    if (Number.isFinite(days) && days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      conditions.push(lte(missedPaymentAlertsTable.detectedAt, cutoff));
    }

    const rows = await db
      .select()
      .from(missedPaymentAlertsTable)
      .where(and(...conditions))
      .orderBy(desc(missedPaymentAlertsTable.detectedAt))
      .limit(safeLimit(req.query.limit, 100, 500))
      .offset(safeOffset(req.query.offset));
    res.json(rows);
  },
);

export default router;
