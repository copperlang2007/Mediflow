/**
 * Marketing-material approval routes.
 *
 * Submit a marketing piece, move it through compliance review
 * (submitted → in_review → approved | rejected | changes_requested → retired),
 * and record an audit-log entry on submit and on every status change so the
 * agency can prove on a CMS audit that everything in use was approved and
 * current. Approved pieces carry an effective window (effective_date /
 * expires_at) and optional CMS material id.
 *
 * Gated on the existing `compliance_report` resource — marketing review is a
 * compliance function (super_admin / agency_admin / compliance_manager own it).
 * No PHI: these are marketing assets, not beneficiary records.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, sql, lt, gte } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  marketingMaterialsTable,
  usersTable,
  auditLogTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const MATERIAL_TYPES = [
  "flyer",
  "social_post",
  "email",
  "mailer",
  "tv",
  "radio",
  "web",
  "business_card",
  "presentation",
  "script",
  "other",
] as const;
const STATUSES = [
  "draft",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "changes_requested",
  "retired",
] as const;

type Status = (typeof STATUSES)[number];

/** Statuses where the reviewer has made a decision (sets reviewed_at/by). */
const DECISION_STATUSES = new Set<Status>([
  "approved",
  "rejected",
  "changes_requested",
]);

/** Fields that define what was reviewed; editing them voids an approval. */
const CONTENT_FIELDS = ["title", "materialType", "description", "fileUrl", "carrierName"] as const;

/** "Expiring soon" horizon for approved pieces. */
const EXPIRING_SOON_DAYS = 30;

async function writeAudit(
  orgId: string,
  userId: string,
  action: "create" | "update",
  materialId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId,
      userId,
      userRole: null,
      action,
      resourceType: "marketing_material",
      resourceId: materialId,
      changes,
    });
  } catch (err) {
    logger.error({ err, orgId, materialId }, "marketing: failed to write audit log");
  }
}

// GET /marketing-materials/summary — counts for the worked-list header.
// Registered BEFORE /:id so "summary" isn't matched as an id.
router.get(
  "/marketing-materials/summary",
  requireAuth,
  requirePermission("compliance_report", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();
    const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * 86_400_000);
    const [byStatus, expiringSoon, expired] = await Promise.all([
      db
        .select({ status: marketingMaterialsTable.status, count: sql<number>`count(*)` })
        .from(marketingMaterialsTable)
        .where(eq(marketingMaterialsTable.orgId, authReq.orgId))
        .groupBy(marketingMaterialsTable.status),
      db
        .select({ count: sql<number>`count(*)` })
        .from(marketingMaterialsTable)
        .where(
          and(
            eq(marketingMaterialsTable.orgId, authReq.orgId),
            eq(marketingMaterialsTable.status, "approved"),
            sql`${marketingMaterialsTable.expiresAt} IS NOT NULL`,
            gte(marketingMaterialsTable.expiresAt, now),
            lt(marketingMaterialsTable.expiresAt, soon),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)` })
        .from(marketingMaterialsTable)
        .where(
          and(
            eq(marketingMaterialsTable.orgId, authReq.orgId),
            eq(marketingMaterialsTable.status, "approved"),
            sql`${marketingMaterialsTable.expiresAt} IS NOT NULL`,
            lt(marketingMaterialsTable.expiresAt, now),
          ),
        ),
    ]);
    const counts: Record<string, number> = {};
    for (const s of STATUSES) counts[s] = 0;
    for (const r of byStatus) counts[r.status] = Number(r.count);
    const pendingReview = counts.submitted + counts.in_review;
    res.json({
      ...counts,
      pendingReview,
      expiringSoon: Number(expiringSoon[0]?.count ?? 0),
      expired: Number(expired[0]?.count ?? 0),
      total: STATUSES.reduce((sum, s) => sum + counts[s], 0),
    });
  },
);

// GET /marketing-materials — worked-list with filters.
router.get(
  "/marketing-materials",
  requireAuth,
  requirePermission("compliance_report", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { status, materialType } = req.query as Record<string, string | undefined>;
    const conditions = [eq(marketingMaterialsTable.orgId, authReq.orgId)];
    if (status && (STATUSES as readonly string[]).includes(status))
      conditions.push(eq(marketingMaterialsTable.status, status as Status));
    if (materialType && (MATERIAL_TYPES as readonly string[]).includes(materialType))
      conditions.push(eq(marketingMaterialsTable.materialType, materialType as (typeof MATERIAL_TYPES)[number]));

    const submitter = usersTable;
    const rows = await db
      .select({
        material: marketingMaterialsTable,
        submitterName: submitter.fullName,
      })
      .from(marketingMaterialsTable)
      .leftJoin(submitter, eq(marketingMaterialsTable.submittedByUserId, submitter.id))
      .where(and(...conditions))
      // Pending review first, then newest.
      .orderBy(
        sql`CASE ${marketingMaterialsTable.status} WHEN 'submitted' THEN 0 WHEN 'in_review' THEN 1 WHEN 'changes_requested' THEN 2 WHEN 'approved' THEN 3 WHEN 'rejected' THEN 4 WHEN 'retired' THEN 5 ELSE 6 END`,
        desc(marketingMaterialsTable.createdAt),
      )
      .limit(500);
    res.json(rows);
  },
);

// GET /marketing-materials/:id
router.get(
  "/marketing-materials/:id",
  requireAuth,
  requirePermission("compliance_report", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [row] = await db
      .select()
      .from(marketingMaterialsTable)
      .where(
        and(
          eq(marketingMaterialsTable.id, id),
          eq(marketingMaterialsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Marketing material not found" });
      return;
    }
    res.json(row);
  },
);

const CreateSchema = z.object({
  title: z.string().min(1).max(500),
  materialType: z.enum(MATERIAL_TYPES).optional(),
  description: z.string().max(5000).optional().nullable(),
  fileUrl: z.string().url().max(2000).optional().nullable(),
  carrierName: z.string().max(300).optional().nullable(),
  cmsMaterialId: z.string().max(200).optional().nullable(),
  // Allow submitting straight as a draft (not yet up for review).
  asDraft: z.boolean().optional(),
});

// POST /marketing-materials — submit a piece for review (or save a draft).
router.post(
  "/marketing-materials",
  requireAuth,
  requirePermission("compliance_report", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const status: Status = data.asDraft ? "draft" : "submitted";
    const now = new Date();
    const id = randomUUID();

    const [row] = await db
      .insert(marketingMaterialsTable)
      .values({
        id,
        orgId: authReq.orgId,
        title: data.title,
        materialType: data.materialType ?? "other",
        status,
        description: data.description ?? null,
        fileUrl: data.fileUrl ?? null,
        carrierName: data.carrierName ?? null,
        cmsMaterialId: data.cmsMaterialId ?? null,
        submittedByUserId: authReq.userId,
        submittedAt: status === "submitted" ? now : null,
        createdBy: authReq.userId,
      })
      .returning();

    await writeAudit(authReq.orgId, authReq.userId, "create", id, {
      status,
      materialType: row!.materialType,
    });
    res.status(201).json(row);
  },
);

const UpdateSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    title: z.string().min(1).max(500).optional(),
    materialType: z.enum(MATERIAL_TYPES).optional(),
    description: z.string().max(5000).optional().nullable(),
    fileUrl: z.string().url().max(2000).optional().nullable(),
    carrierName: z.string().max(300).optional().nullable(),
    cmsMaterialId: z.string().max(200).optional().nullable(),
    reviewNotes: z.string().max(5000).optional().nullable(),
    effectiveDate: z.string().optional().nullable(),
    expiresAt: z.string().optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

// PATCH /marketing-materials/:id — edit / review-decision.
router.patch(
  "/marketing-materials/:id",
  requireAuth,
  requirePermission("compliance_report", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    const [existing] = await db
      .select()
      .from(marketingMaterialsTable)
      .where(
        and(
          eq(marketingMaterialsTable.id, id),
          eq(marketingMaterialsTable.orgId, authReq.orgId),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Marketing material not found" });
      return;
    }

    // Separation of duties: the person who submitted a piece cannot be the
    // one who approves or rejects it — an auditor needs two people on record.
    if (
      data.status !== undefined &&
      DECISION_STATUSES.has(data.status) &&
      existing.submittedByUserId === authReq.userId
    ) {
      res.status(403).json({
        error: "You submitted this material, so a different reviewer must record the decision.",
      });
      return;
    }

    // An approval covers the exact content that was reviewed. Changing the
    // content of an approved piece without resubmitting it would leave an
    // unreviewed asset carrying an "approved" stamp.
    const contentChanged = CONTENT_FIELDS.some(
      (f) => data[f] !== undefined && data[f] !== existing[f],
    );
    if (existing.status === "approved" && contentChanged && data.status !== "submitted") {
      res.status(409).json({
        error: "Approved material is locked. Resubmit it for review to change its content.",
      });
      return;
    }

    const patch: Partial<typeof marketingMaterialsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (data.title !== undefined) patch.title = data.title;
    if (data.materialType !== undefined) patch.materialType = data.materialType;
    if (data.description !== undefined) patch.description = data.description;
    if (data.fileUrl !== undefined) patch.fileUrl = data.fileUrl;
    if (data.carrierName !== undefined) patch.carrierName = data.carrierName;
    if (data.cmsMaterialId !== undefined) patch.cmsMaterialId = data.cmsMaterialId;
    if (data.reviewNotes !== undefined) patch.reviewNotes = data.reviewNotes;
    if (data.effectiveDate !== undefined)
      patch.effectiveDate = data.effectiveDate ? new Date(data.effectiveDate) : null;
    if (data.expiresAt !== undefined)
      patch.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;

    const statusChanged = data.status !== undefined && data.status !== existing.status;
    if (data.status !== undefined) {
      patch.status = data.status;
      // A reviewer decision stamps who/when. Resubmitting (back to submitted)
      // clears the prior decision stamp.
      if (DECISION_STATUSES.has(data.status)) {
        patch.reviewedByUserId = authReq.userId;
        patch.reviewedAt = new Date();
      } else if (data.status === "submitted") {
        patch.submittedAt = new Date();
        patch.reviewedByUserId = null;
        patch.reviewedAt = null;
      }
    }

    const [row] = await db
      .update(marketingMaterialsTable)
      .set(patch)
      .where(
        and(
          eq(marketingMaterialsTable.id, id),
          eq(marketingMaterialsTable.orgId, authReq.orgId),
        ),
      )
      .returning();

    if (statusChanged) {
      await writeAudit(authReq.orgId, authReq.userId, "update", id, {
        statusFrom: existing.status,
        statusTo: data.status,
      });
    }
    res.json(row);
  },
);

export default router;
