/**
 * Automatic carrier-statement intake: configure the watched folder and work the
 * review list.
 *
 *   GET    /commissions/ingest                 source config + files (filter by status)
 *   PUT    /commissions/ingest/source          create / update the watched folder
 *   POST   /commissions/ingest/check           poll now
 *   POST   /commissions/ingest/files/:id/approve   reconcile a held / flagged statement
 *   POST   /commissions/ingest/files/:id/retry     forget a failed / flagged file so the next poll re-reads it
 *   POST   /commissions/ingest/files/:id/dismiss   stop tracking a flagged file that has NOT been posted
 *                                                  (refused once its statement is reconciled: money is already
 *                                                  credited; use approve to accept it)
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  db,
  carriersTable,
  commissionStatementsTable,
  statementIngestFilesTable,
  statementIngestSourcesTable,
  STATEMENT_INGEST_FILE_STATUSES,
  STATEMENT_INGEST_MODES,
} from "@workspace/db";
import { requireAuth, requirePermission, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { requireMfa } from "../middlewares/requireMfa";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";
import { enqueue, JOB_NAMES } from "../lib/jobs";
import { approveHeldFile } from "../lib/statementIngest/ingest";

const router: IRouter = Router();

router.use(
  routerAuditMiddleware(router, "commission", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

const idParam = (req: Request): string => {
  const raw = req.params.id;
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
};

const SourceSchema = z.object({
  folderId: z.string().trim().min(1).max(200),
  mode: z.enum(STATEMENT_INGEST_MODES),
  enabled: z.boolean().default(true),
  /** { "<folder or file name>": "<carrier id>" } */
  carrierFolderMap: z.record(z.string().min(1).max(200), z.string().min(1)).default({}),
});

router.get(
  "/commissions/ingest",
  requireAuth,
  requirePermission("commission", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    let statuses: Array<(typeof STATEMENT_INGEST_FILE_STATUSES)[number]> | null = null;
    if (status !== undefined) {
      const requested = status.split(",").map((s) => s.trim()).filter(Boolean);
      const valid = new Set<string>(STATEMENT_INGEST_FILE_STATUSES);
      const unknown = requested.filter((s) => !valid.has(s));
      // A typo must not silently fall back to "everything".
      if (unknown.length > 0) {
        res.status(400).json({
          error: `Invalid status: ${unknown.join(", ")}`,
          validStatuses: STATEMENT_INGEST_FILE_STATUSES,
        });
        return;
      }
      // An empty value (`?status=`, a cleared filter field) means "no filter", as it always has.
      if (requested.length > 0) statuses = requested as Array<(typeof STATEMENT_INGEST_FILE_STATUSES)[number]>;
    }

    const [source] = await db
      .select()
      .from(statementIngestSourcesTable)
      .where(eq(statementIngestSourcesTable.orgId, orgId))
      .limit(1);
    const files = await db
      .select()
      .from(statementIngestFilesTable)
      .where(
        statuses
          ? and(eq(statementIngestFilesTable.orgId, orgId), inArray(statementIngestFilesTable.status, statuses))
          : eq(statementIngestFilesTable.orgId, orgId),
      )
      .orderBy(desc(statementIngestFilesTable.createdAt))
      .limit(100);
    res.json({ source: source ?? null, files });
  },
);

router.put(
  "/commissions/ingest/source",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    const parsed = SourceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    // A mapping may only point at this org's own carriers.
    const carrierIds = [...new Set(Object.values(data.carrierFolderMap))];
    if (carrierIds.length > 0) {
      const owned = await db
        .select({ id: carriersTable.id })
        .from(carriersTable)
        .where(and(eq(carriersTable.orgId, orgId), inArray(carriersTable.id, carrierIds)));
      if (owned.length !== carrierIds.length) {
        res.status(400).json({ error: "carrierFolderMap references a carrier that is not in this organization" });
        return;
      }
    }

    const [existing] = await db
      .select({ id: statementIngestSourcesTable.id })
      .from(statementIngestSourcesTable)
      .where(and(eq(statementIngestSourcesTable.orgId, orgId), eq(statementIngestSourcesTable.kind, "drive")))
      .limit(1);

    const values = {
      folderId: data.folderId,
      mode: data.mode,
      enabled: data.enabled,
      carrierFolderMap: data.carrierFolderMap,
      lastError: null,
    };
    if (existing) {
      const [row] = await db
        .update(statementIngestSourcesTable)
        .set(values)
        .where(eq(statementIngestSourcesTable.id, existing.id))
        .returning();
      res.json(row);
      return;
    }
    const [row] = await db
      .insert(statementIngestSourcesTable)
      .values({ id: randomUUID(), orgId, kind: "drive", ...values })
      .returning();
    res.status(201).json(row);
  },
);

router.post(
  "/commissions/ingest/check",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    const [source] = await db
      .select({ id: statementIngestSourcesTable.id })
      .from(statementIngestSourcesTable)
      .where(and(eq(statementIngestSourcesTable.orgId, orgId), eq(statementIngestSourcesTable.enabled, true)))
      .limit(1);
    if (!source) {
      res.status(404).json({ error: "No enabled statement folder is configured" });
      return;
    }
    const jobId = await enqueue(JOB_NAMES.STATEMENT_INGEST_POLL, { sourceId: source.id });
    if (!jobId) {
      res.status(503).json({ error: "Could not queue the check; the next scheduled poll will pick up new files" });
      return;
    }
    res.status(202).json({ queued: true });
  },
);

router.post(
  "/commissions/ingest/files/:id/approve",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    const status = await approveHeldFile(orgId, idParam(req));
    if (!status) {
      res.status(409).json({ error: "Nothing to approve: the file is not held, has no statement, or is already being processed" });
      return;
    }
    res.json({ status });
  },
);

router.post(
  "/commissions/ingest/files/:id/retry",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    // Only rows that never produced a statement can be re-read; deleting the ledger row
    // lets the next poll treat the file as new. A row with a statement is never deleted.
    const [row] = await db
      .select()
      .from(statementIngestFilesTable)
      .where(and(eq(statementIngestFilesTable.id, idParam(req)), eq(statementIngestFilesTable.orgId, orgId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    if (row.statementId || !["failed", "needs_review"].includes(row.status)) {
      res.status(409).json({ error: "Only failed or flagged files that created no statement can be retried" });
      return;
    }
    await db.delete(statementIngestFilesTable).where(eq(statementIngestFilesTable.id, row.id));
    res.json({ retried: true });
  },
);

router.post(
  "/commissions/ingest/files/:id/dismiss",
  requireAuth,
  requireMfa,
  requirePermission("commission", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req as AuthenticatedRequest;
    const [row] = await db
      .select({
        id: statementIngestFilesTable.id,
        status: statementIngestFilesTable.status,
        statementStatus: commissionStatementsTable.status,
      })
      .from(statementIngestFilesTable)
      .leftJoin(commissionStatementsTable, eq(commissionStatementsTable.id, statementIngestFilesTable.statementId))
      .where(and(eq(statementIngestFilesTable.id, idParam(req)), eq(statementIngestFilesTable.orgId, orgId)))
      .limit(1);
    if (!row || !["needs_review", "failed"].includes(row.status)) {
      res.status(404).json({ error: "No flagged or failed file with that id" });
      return;
    }
    // Dismiss only stops tracking a file; it cannot take back a posting. Once the
    // statement is reconciled its lines are already credited to agents' payouts.
    if (row.statementStatus === "reconciled") {
      res.status(409).json({
        error: "This statement is already reconciled and its payouts are credited, so it cannot be dismissed. Use approve to accept it, or correct it from the Commissions page.",
      });
      return;
    }
    // The status may have changed since the read above (another admin, or a worker).
    const [updated] = await db
      .update(statementIngestFilesTable)
      .set({ status: "dismissed" })
      .where(and(eq(statementIngestFilesTable.id, row.id), inArray(statementIngestFilesTable.status, ["needs_review", "failed"])))
      .returning({ id: statementIngestFilesTable.id });
    if (!updated) {
      res.status(409).json({ error: "The file changed state while dismissing; refresh and check its status" });
      return;
    }
    res.json({ status: "dismissed" });
  },
);

export default router;
