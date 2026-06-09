/**
 * CTM complaint tracking routes.
 *
 * Beneficiary complaints are compliance system-of-record items (see
 * `complaints` schema). These routes let a compliance owner log a complaint,
 * triage it (category + severity → SLA), work it through its status workflow,
 * and resolve it — with an audit-log entry on create and on every status
 * change so the agency can produce the record on a CMS audit.
 *
 * Permissions piggy-back on the existing `compliance_report` resource:
 * complaints are compliance artifacts owned by compliance_manager /
 * agency_admin. PHI never enters subject/description (the `contactId` link is
 * the way back to beneficiary data).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc, sql, lt, inArray } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  complaintsTable,
  contactsTable,
  agentsTable,
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

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const CATEGORIES = [
  "marketing",
  "enrollment",
  "benefits",
  "access",
  "privacy",
  "agent_conduct",
  "billing",
  "other",
] as const;
const SOURCES = [
  "cms_ctm",
  "beneficiary_direct",
  "carrier",
  "internal",
  "other",
] as const;
const STATUSES = ["open", "investigating", "resolved", "closed"] as const;

type Severity = (typeof SEVERITIES)[number];

/**
 * Resolution SLA window per severity, in days. Critical complaints (e.g. an
 * urgent CTM case or a privacy breach) must be turned around fast; low-severity
 * items get a longer runway. Mirrors the spirit of CMS complaint turnaround
 * tiers without hard-coding a specific contract's calendar.
 */
const SLA_DAYS: Record<Severity, number> = {
  critical: 2,
  high: 5,
  medium: 10,
  low: 30,
};

/** Compute the resolution due date from severity, relative to `from`. */
export function complaintDueDate(severity: Severity, from: Date): Date {
  return new Date(from.getTime() + SLA_DAYS[severity] * 86_400_000);
}

/** Statuses that mean the complaint is no longer actively open. */
const TERMINAL_STATUSES = new Set(["resolved", "closed"]);

async function writeAudit(
  orgId: string,
  userId: string,
  action: "create" | "update",
  complaintId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      id: randomUUID(),
      orgId,
      userId,
      userRole: null,
      action,
      resourceType: "complaint",
      resourceId: complaintId,
      changes,
    });
  } catch (err) {
    logger.error({ err, orgId, complaintId }, "complaints: failed to write audit log");
  }
}

// GET /complaints/summary — counts for the worked-list header + nav badge.
// Registered BEFORE /complaints/:id so "summary" isn't matched as an id.
router.get(
  "/complaints/summary",
  requireAuth,
  requirePermission("compliance_report", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();
    const [byStatus, overdue] = await Promise.all([
      db
        .select({ status: complaintsTable.status, count: sql<number>`count(*)` })
        .from(complaintsTable)
        .where(eq(complaintsTable.orgId, authReq.orgId))
        .groupBy(complaintsTable.status),
      db
        .select({ count: sql<number>`count(*)` })
        .from(complaintsTable)
        .where(
          and(
            eq(complaintsTable.orgId, authReq.orgId),
            inArray(complaintsTable.status, ["open", "investigating"]),
            sql`${complaintsTable.dueAt} IS NOT NULL`,
            lt(complaintsTable.dueAt, now),
          ),
        ),
    ]);
    const counts: Record<string, number> = {
      open: 0,
      investigating: 0,
      resolved: 0,
      closed: 0,
    };
    for (const row of byStatus) counts[row.status] = Number(row.count);
    const active = counts.open + counts.investigating;
    res.json({
      ...counts,
      active,
      overdue: Number(overdue[0]?.count ?? 0),
      total: counts.open + counts.investigating + counts.resolved + counts.closed,
    });
  },
);

// GET /complaints — worked-list with filters.
router.get(
  "/complaints",
  requireAuth,
  requirePermission("compliance_report", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { status, severity, category, source, contactId, overdue } =
      req.query as Record<string, string | undefined>;

    const conditions = [eq(complaintsTable.orgId, authReq.orgId)];
    if (status && (STATUSES as readonly string[]).includes(status))
      conditions.push(eq(complaintsTable.status, status as (typeof STATUSES)[number]));
    if (severity && (SEVERITIES as readonly string[]).includes(severity))
      conditions.push(eq(complaintsTable.severity, severity as Severity));
    if (category && (CATEGORIES as readonly string[]).includes(category))
      conditions.push(eq(complaintsTable.category, category as (typeof CATEGORIES)[number]));
    if (source && (SOURCES as readonly string[]).includes(source))
      conditions.push(eq(complaintsTable.source, source as (typeof SOURCES)[number]));
    if (contactId) conditions.push(eq(complaintsTable.contactId, contactId));
    if (overdue === "true") {
      conditions.push(inArray(complaintsTable.status, ["open", "investigating"]));
      conditions.push(sql`${complaintsTable.dueAt} IS NOT NULL`);
      conditions.push(lt(complaintsTable.dueAt, new Date()));
    }

    const rows = await db
      .select({
        complaint: complaintsTable,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
        agentFirstName: agentsTable.firstName,
        agentLastName: agentsTable.lastName,
        assigneeName: usersTable.fullName,
      })
      .from(complaintsTable)
      .leftJoin(contactsTable, eq(complaintsTable.contactId, contactsTable.id))
      .leftJoin(agentsTable, eq(complaintsTable.agentId, agentsTable.id))
      .leftJoin(usersTable, eq(complaintsTable.assignedToUserId, usersTable.id))
      // Active first, then SLA-soonest, then newest.
      .orderBy(
        sql`CASE ${complaintsTable.status} WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END`,
        sql`${complaintsTable.dueAt} ASC NULLS LAST`,
        desc(complaintsTable.createdAt),
      )
      .limit(500);
    res.json(rows);
  },
);

// GET /complaints/:id
router.get(
  "/complaints/:id",
  requireAuth,
  requirePermission("compliance_report", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [row] = await db
      .select({
        complaint: complaintsTable,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
        agentFirstName: agentsTable.firstName,
        agentLastName: agentsTable.lastName,
        assigneeName: usersTable.fullName,
      })
      .from(complaintsTable)
      .leftJoin(contactsTable, eq(complaintsTable.contactId, contactsTable.id))
      .leftJoin(agentsTable, eq(complaintsTable.agentId, agentsTable.id))
      .leftJoin(usersTable, eq(complaintsTable.assignedToUserId, usersTable.id))
      .where(and(eq(complaintsTable.id, id), eq(complaintsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }
    res.json(row);
  },
);

const CreateSchema = z.object({
  subject: z.string().min(1).max(500),
  description: z.string().max(5000).optional().nullable(),
  source: z.enum(SOURCES).optional(),
  category: z.enum(CATEGORIES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  contactId: z.string().optional().nullable(),
  agentId: z.string().optional().nullable(),
  ctmCaseId: z.string().max(200).optional().nullable(),
  receivedAt: z.string().optional().nullable(),
  assignedToUserId: z.string().optional().nullable(),
});

// POST /complaints — log a new complaint.
router.post(
  "/complaints",
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

    // Validate org-scoped foreign keys so a complaint can't point at another
    // org's contact/agent/user.
    if (data.contactId) {
      const [c] = await db
        .select({ id: contactsTable.id })
        .from(contactsTable)
        .where(and(eq(contactsTable.id, data.contactId), eq(contactsTable.orgId, authReq.orgId)))
        .limit(1);
      if (!c) {
        res.status(400).json({ error: "Contact not found" });
        return;
      }
    }
    if (data.agentId) {
      const [a] = await db
        .select({ id: agentsTable.id })
        .from(agentsTable)
        .where(and(eq(agentsTable.id, data.agentId), eq(agentsTable.orgId, authReq.orgId)))
        .limit(1);
      if (!a) {
        res.status(400).json({ error: "Agent not found" });
        return;
      }
    }

    const severity = data.severity ?? "medium";
    const receivedAt = data.receivedAt ? new Date(data.receivedAt) : new Date();
    const dueAt = complaintDueDate(severity, receivedAt);
    const id = randomUUID();

    const [row] = await db
      .insert(complaintsTable)
      .values({
        id,
        orgId: authReq.orgId,
        contactId: data.contactId ?? null,
        agentId: data.agentId ?? null,
        source: data.source ?? "beneficiary_direct",
        category: data.category ?? "other",
        severity,
        status: "open",
        subject: data.subject,
        description: data.description ?? null,
        ctmCaseId: data.ctmCaseId ?? null,
        receivedAt,
        dueAt,
        assignedToUserId: data.assignedToUserId ?? null,
        createdBy: authReq.userId,
      })
      .returning();

    await writeAudit(authReq.orgId, authReq.userId, "create", id, {
      severity,
      category: row!.category,
      source: row!.source,
      ctmCaseId: row!.ctmCaseId,
    });

    res.status(201).json(row);
  },
);

const UpdateSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    category: z.enum(CATEGORIES).optional(),
    source: z.enum(SOURCES).optional(),
    subject: z.string().min(1).max(500).optional(),
    description: z.string().max(5000).optional().nullable(),
    ctmCaseId: z.string().max(200).optional().nullable(),
    assignedToUserId: z.string().optional().nullable(),
    resolutionNotes: z.string().max(5000).optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

// PATCH /complaints/:id — update / advance / resolve.
router.patch(
  "/complaints/:id",
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
      .from(complaintsTable)
      .where(and(eq(complaintsTable.id, id), eq(complaintsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Complaint not found" });
      return;
    }

    if (data.assignedToUserId) {
      const [u] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(and(eq(usersTable.id, data.assignedToUserId), eq(usersTable.orgId, authReq.orgId)))
        .limit(1);
      if (!u) {
        res.status(400).json({ error: "Assignee not found" });
        return;
      }
    }

    const patch: Partial<typeof complaintsTable.$inferInsert> = { updatedAt: new Date() };
    if (data.subject !== undefined) patch.subject = data.subject;
    if (data.description !== undefined) patch.description = data.description;
    if (data.category !== undefined) patch.category = data.category;
    if (data.source !== undefined) patch.source = data.source;
    if (data.ctmCaseId !== undefined) patch.ctmCaseId = data.ctmCaseId;
    if (data.assignedToUserId !== undefined) patch.assignedToUserId = data.assignedToUserId;
    if (data.resolutionNotes !== undefined) patch.resolutionNotes = data.resolutionNotes;

    // Severity change recomputes the SLA only while the complaint is still
    // active (don't move a closed item's due date).
    const nextSeverity = data.severity ?? existing.severity;
    if (data.severity !== undefined) patch.severity = data.severity;
    const nextStatus = data.status ?? existing.status;
    const stillActive = !TERMINAL_STATUSES.has(nextStatus);
    if (data.severity !== undefined && stillActive) {
      patch.dueAt = complaintDueDate(nextSeverity, existing.receivedAt);
    }

    if (data.status !== undefined && data.status !== existing.status) {
      patch.status = data.status;
      const becameTerminal = TERMINAL_STATUSES.has(data.status);
      const wasTerminal = TERMINAL_STATUSES.has(existing.status);
      if (becameTerminal && !existing.resolvedAt) patch.resolvedAt = new Date();
      // Reopening clears the resolution timestamp.
      if (!becameTerminal && wasTerminal) patch.resolvedAt = null;
    }

    const [row] = await db
      .update(complaintsTable)
      .set(patch)
      .where(and(eq(complaintsTable.id, id), eq(complaintsTable.orgId, authReq.orgId)))
      .returning();

    if (data.status !== undefined && data.status !== existing.status) {
      await writeAudit(authReq.orgId, authReq.userId, "update", id, {
        statusFrom: existing.status,
        statusTo: data.status,
      });
    }

    res.json(row);
  },
);

export default router;
