import { Router, type IRouter, type Request, type Response } from "express";
import { eq, ne, and, sql, desc, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  leadsTable,
  contactsTable,
  activitiesTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";

import { enqueue, JOB_NAMES } from "../lib/jobs";
import { safeLimit, safeOffset } from "../lib/listGuards";
import { logger } from "../lib/logger";
import { captureWorkerError } from "../lib/sentry";
import { serializeContact } from "../lib/serializeContact";

const router: IRouter = Router();

router.use(
  routerAuditMiddleware(router, "lead", undefined, {

    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

const CreateLeadSchema = z.object({
  contactId: z.string(),
  source: z.string().max(100).optional().nullable(),
  sourceDetail: z.string().max(200).optional().nullable(),
  score: z.number().int().min(0).max(100).optional(),
  status: z.enum(["new", "contacted", "qualified", "disqualified", "converted"]).optional(),
  assignedAgentId: z.string().optional().nullable(),
});

const UpdateLeadSchema = z.object({
  source: z.string().max(100).optional().nullable(),
  sourceDetail: z.string().max(200).optional().nullable(),
  score: z.number().int().min(0).max(100).optional(),
  status: z.enum(["new", "contacted", "qualified", "disqualified", "converted"]).optional(),
  assignedAgentId: z.string().optional().nullable(),
});

// GET /leads
router.get(
  "/leads",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { status, assignedAgentId, limit, offset } = req.query as Record<string, string | undefined>;

    const conditions: SQL[] = [eq(leadsTable.orgId, authReq.orgId)];
    if (status && status !== "all") {
      conditions.push(eq(leadsTable.status, status as "new" | "contacted" | "qualified" | "disqualified" | "converted"));
    }
    if (assignedAgentId) {
      conditions.push(eq(leadsTable.assignedAgentId, assignedAgentId));
    }

    const limitNum = safeLimit(limit, 50, 1000);
    const offsetNum = safeOffset(offset);

    const [leads, totalRes] = await Promise.all([
      db
        .select({ lead: leadsTable, contact: contactsTable })
        .from(leadsTable)
        .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
        .where(and(...conditions))
        .orderBy(desc(leadsTable.createdAt))
        .limit(limitNum)
        .offset(offsetNum),
      db.select({ count: sql<number>`count(*)` }).from(leadsTable).where(and(...conditions)),
    ]);

    // Mask contact PHI (MBI/DOB/health) for non-privileged roles.
    const data = leads.map((row) => ({
      lead: row.lead,
      contact: serializeContact(row.contact, authReq.userRole),
    }));
    res.json({ data, total: Number(totalRes[0]?.count ?? 0) });
  },
);

// POST /leads
router.post(
  "/leads",
  requireAuth,
  requirePermission("contact", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateLeadSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    // Verify contact belongs to org
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, parsed.data.contactId), eq(contactsTable.orgId, authReq.orgId))).limit(1);
    if (!contact) { res.status(400).json({ error: "Contact not found in this organisation" }); return; }

    const [lead] = await db.insert(leadsTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      contactId: parsed.data.contactId,
      source: parsed.data.source ?? null,
      sourceDetail: parsed.data.sourceDetail ?? null,
      score: parsed.data.score ?? 0,
      status: parsed.data.status ?? "new",
      assignedAgentId: parsed.data.assignedAgentId ?? null,
    }).returning();

    // Fire event-triggered automation rules for "lead_created"
    enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
      orgId: authReq.orgId,
      trigger: "lead_created",
      resourceType: "lead",
      resourceId: lead.id,
      context: { contactId: parsed.data.contactId, source: parsed.data.source ?? null },
    }).catch((err) => {
      logger.warn(
        {
          err,
          jobName: JOB_NAMES.RUN_AUTOMATION_RULES,
          trigger: "lead_created",
          orgId: authReq.orgId,
          leadId: lead.id,
          contactId: parsed.data.contactId,
        },
        "Failed to enqueue automation job",
      );
      captureWorkerError(err, {
        worker: "leads",
        route: "POST /leads",
        jobName: JOB_NAMES.RUN_AUTOMATION_RULES,
        trigger: "lead_created",
        orgId: authReq.orgId,
        leadId: lead.id,
        contactId: parsed.data.contactId,
      });
    });

    res.status(201).json(lead);
  },
);

// GET /leads/stats — MUST be registered before /leads/:id to prevent route shadowing
router.get(
  "/leads/stats",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const bySource = await db
      .select({ source: leadsTable.source, count: sql<number>`count(*)`, avgScore: sql<number>`avg(${leadsTable.score})` })
      .from(leadsTable)
      .where(eq(leadsTable.orgId, authReq.orgId))
      .groupBy(leadsTable.source);
    const byStatus = await db
      .select({ status: leadsTable.status, count: sql<number>`count(*)` })
      .from(leadsTable)
      .where(eq(leadsTable.orgId, authReq.orgId))
      .groupBy(leadsTable.status);
    res.json({ bySource, byStatus });
  },
);

// GET /leads/:id
router.get(
  "/leads/:id",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [row] = await db
      .select({ lead: leadsTable, contact: contactsTable })
      .from(leadsTable)
      .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
      .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId)))
      .limit(1);
    if (!row) { res.status(404).json({ error: "Lead not found" }); return; }
    res.json({ lead: row.lead, contact: serializeContact(row.contact, authReq.userRole) });
  },
);

// PATCH /leads/:id
//
// Concurrency note: the previous handler read the row, computed
// `existing2.status !== newStatus` in JS, then issued the UPDATE
// unconditionally and fired the `lead_status_changed` automation trigger
// whenever the JS-side compare reported a difference. Two concurrent
// PATCHes both setting the lead to (say) "qualified" would both observe
// the original status "new" in their pre-write read, both write the same
// new status, and both fire the trigger — yielding a duplicate automation
// run for a single logical transition.
//
// The fix performs a conditional UPDATE — `WHERE status != newStatus` —
// so only the caller whose UPDATE actually transitioned the row sees a
// non-empty `returning()`, and only that caller fires the trigger. A
// no-op same-status PATCH still returns 200 with the current row (the
// existing idempotent contract), and PATCHes that only touch non-status
// fields skip the conditional entirely.
router.patch(
  "/leads/:id",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const parsed = UpdateLeadSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const d = parsed.data;

    const updates: Record<string, unknown> = {};
    if (d.source !== undefined) updates.source = d.source;
    if (d.sourceDetail !== undefined) updates.sourceDetail = d.sourceDetail;
    if (d.score !== undefined) updates.score = d.score;
    if (d.status !== undefined) updates.status = d.status;
    if (d.assignedAgentId !== undefined) updates.assignedAgentId = d.assignedAgentId;
    if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

    const result = await db.transaction(async (tx) => {
      // When the payload requests a status change, attempt a conditional
      // UPDATE gated on `status != newStatus`. If exactly one of N
      // concurrent same-status requests transitions the row, the others
      // see `returning()` empty and skip the automation trigger.
      let transitioned = false;
      let oldStatus: typeof leadsTable.$inferSelect["status"] | null = null;

      if (d.status !== undefined) {
        // Read the prior status inside the transaction so we can report
        // an accurate oldStatus on the trigger payload, AND distinguish
        // 404 from no-op-200.
        const [prior] = await tx
          .select({ status: leadsTable.status })
          .from(leadsTable)
          .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId)))
          .limit(1);

        if (!prior) {
          return { kind: "not-found" as const };
        }
        oldStatus = prior.status;

        const [updated] = await tx
          .update(leadsTable)
          .set(updates)
          .where(
            and(
              eq(leadsTable.id, id),
              eq(leadsTable.orgId, authReq.orgId),
              ne(leadsTable.status, d.status),
            ),
          )
          .returning();

        if (updated) {
          transitioned = true;
          return { kind: "updated" as const, row: updated, transitioned, oldStatus };
        }

        // Status was already `d.status` — apply any *other* fields that
        // were in the payload (e.g. score/source bump alongside a no-op
        // status set) and return the row. No trigger fires.
        const otherUpdates = { ...updates };
        delete (otherUpdates as Record<string, unknown>).status;
        if (Object.keys(otherUpdates).length > 0) {
          const [updated2] = await tx
            .update(leadsTable)
            .set(otherUpdates)
            .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId)))
            .returning();
          return { kind: "updated" as const, row: updated2, transitioned: false, oldStatus };
        }

        // Pure no-op: read the row back so the response shape matches.
        const [current] = await tx
          .select()
          .from(leadsTable)
          .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId)))
          .limit(1);
        return { kind: "updated" as const, row: current, transitioned: false, oldStatus };
      }

      // No status field on the payload — update other fields only and
      // do not fire the transition trigger.
      const [updated] = await tx
        .update(leadsTable)
        .set(updates)
        .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId)))
        .returning();
      if (!updated) {
        return { kind: "not-found" as const };
      }
      return { kind: "updated" as const, row: updated, transitioned: false, oldStatus };
    });

    if (result.kind === "not-found") {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    // Fire lead_status_changed automation hook ONLY when the conditional
    // UPDATE actually performed the transition. Two concurrent callers
    // requesting the same target status cannot both arrive here.
    if (result.transitioned && d.status !== undefined && result.oldStatus !== null) {
      enqueue(JOB_NAMES.RUN_AUTOMATION_RULES, {
        orgId: authReq.orgId,
        trigger: "lead_status_changed",
        resourceType: "lead",
        resourceId: id,
        context: { oldStatus: result.oldStatus, newStatus: d.status },
      }).catch((err) => {
        logger.warn(
          {
            err,
            jobName: JOB_NAMES.RUN_AUTOMATION_RULES,
            trigger: "lead_status_changed",
            orgId: authReq.orgId,
            leadId: id,
          },
          "Failed to enqueue automation job",
        );
        captureWorkerError(err, {
          worker: "leads",
          route: "PATCH /leads/:id",
          jobName: JOB_NAMES.RUN_AUTOMATION_RULES,
          trigger: "lead_status_changed",
          orgId: authReq.orgId,
          leadId: id,
        });
      });
    }

    res.json(result.row);
  },
);

// POST /leads/:id/convert — convert lead to enrolled contact
//
// Concurrency note: this used to be a read-check-write — SELECT the lead,
// check `status !== "converted"`, then UPDATE/UPDATE/INSERT. Two concurrent
// callers could both pass the check before either wrote, then each would
// insert a duplicate "Lead converted to prospect" activity row and
// double-fire any downstream automations attached to the status change.
//
// The fix is a conditional UPDATE — `WHERE status != 'converted'` — that
// returns the row only when THIS caller is the one that actually performed
// the transition. The contact-status update and activity insert (the
// non-idempotent side effects) then run exactly once per real conversion.
// The conditional update, contact update, and activity insert are wrapped
// in a single transaction so a crash between them cannot leave the system
// half-converted.
router.post(
  "/leads/:id/convert",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const result = await db.transaction(async (tx) => {
      // Conditional UPDATE — only transitions the row if it is not already
      // converted. Postgres serializes concurrent UPDATEs against the same
      // row, so at most one caller will see a non-empty `returning()`.
      const [updated] = await tx
        .update(leadsTable)
        .set({ status: "converted", convertedAt: new Date() })
        .where(
          and(
            eq(leadsTable.id, id),
            eq(leadsTable.orgId, authReq.orgId),
            ne(leadsTable.status, "converted"),
          ),
        )
        .returning();

      if (!updated) {
        // Either the lead does not exist / belongs to another org (404) or
        // it was already converted (409). Disambiguate with a follow-up
        // read inside the same transaction.
        const [existing] = await tx
          .select({ status: leadsTable.status })
          .from(leadsTable)
          .where(and(eq(leadsTable.id, id), eq(leadsTable.orgId, authReq.orgId)))
          .limit(1);
        return { kind: "not-transitioned" as const, existed: Boolean(existing) };
      }

      // Update contact status and write the activity row only for the
      // single caller whose conditional UPDATE was the real transition.
      await tx
        .update(contactsTable)
        .set({ status: "prospect" })
        .where(eq(contactsTable.id, updated.contactId));
      await tx.insert(activitiesTable).values({
        id: randomUUID(),
        orgId: authReq.orgId,
        contactId: updated.contactId,
        type: "status_change",
        body: "Lead converted to prospect",
        createdBy: authReq.userId,
      });

      return { kind: "converted" as const, contactId: updated.contactId };
    });

    if (result.kind === "not-transitioned") {
      if (!result.existed) {
        res.status(404).json({ error: "Lead not found" });
      } else {
        res.status(409).json({ error: "Lead already converted" });
      }
      return;
    }

    res.json({ success: true, contactId: result.contactId });
  },
);

export default router;
