/**
 * Enrollments — the operational record of a beneficiary's coverage.
 *
 *   GET    /enrollments                  — list, filterable by contact/year/status
 *   GET    /contacts/:id/plan-enrollments — coverage history for one beneficiary
 *   POST   /enrollments                  — record an enrollment
 *   PATCH  /enrollments/:id              — correct or advance one
 *   DELETE /enrollments/:id              — remove a mistakenly-entered record
 *
 * Authorization rides on the existing `contact` resource rather than
 * introducing a parallel one: an enrollment is coverage attached to a
 * beneficiary, and anyone who may read or write that beneficiary's record may
 * do the same to their coverage. A separate `enrollment` resource would have
 * to be kept in lockstep with `contact` forever, and would drift.
 *
 * Every handler establishes tenancy the same way the rest of the codebase
 * does: the contact is resolved inside the caller's org first, so a foreign
 * `contactId` 404s rather than writing across tenants.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, desc, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  enrollmentsTable,
  contactsTable,
  carriersTable,
} from "@workspace/db";

import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { safeLimit, safeOffset } from "../lib/listGuards";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const PLAN_TYPES = ["MA", "PDP", "MAPD", "supp", "other"] as const;
const STATUSES = [
  "pending",
  "active",
  "terminated",
  "cancelled",
  "declined",
] as const;

/** ISO calendar date (yyyy-mm-dd) — the column type is `date`, not timestamp. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (yyyy-mm-dd)");

const CreateSchema = z.object({
  contactId: z.string().min(1),
  carrierId: z.string().min(1).nullish(),
  agentId: z.string().min(1).nullish(),
  planId: z.string().max(100).nullish(),
  planName: z.string().max(200).nullish(),
  planType: z.enum(PLAN_TYPES),
  planYear: z.number().int().min(2000).max(2100),
  policyNumber: z.string().max(100).nullish(),
  applicationDate: isoDate.nullish(),
  effectiveDate: isoDate,
  effectuated: z.boolean().optional(),
  disenrolledDate: isoDate.nullish(),
  status: z.enum(STATUSES).optional(),
  notes: z.string().max(2000).nullish(),
});

const UpdateSchema = CreateSchema.partial().omit({ contactId: true });

/**
 * Resolves a contact inside the caller's org.
 * Returns null (and the caller 404s) for a contact in another tenant.
 */
async function contactInOrg(
  contactId: string,
  orgId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * True when an error (or anything it wraps) is a Postgres unique violation.
 *
 * Drizzle wraps driver errors in its own error type, so the pg error code
 * lives on a `cause` further down the chain rather than on the thrown object.
 * Matching the SQLSTATE (23505) is stable; matching message text is not.
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    const e = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === "23505") return true;
    if (
      typeof e.constraint === "string" &&
      e.constraint.includes("enrollments_contact_year_type_carrier_key")
    ) {
      return true;
    }
    cur = e.cause;
  }
  // Last resort for drivers that only surface text (pglite in tests).
  return /duplicate key value violates unique constraint/i.test(String(err));
}

/** Shared select shape — joins the carrier so the UI need not fetch names. */
const enrollmentColumns = {
  id: enrollmentsTable.id,
  orgId: enrollmentsTable.orgId,
  contactId: enrollmentsTable.contactId,
  carrierId: enrollmentsTable.carrierId,
  carrierName: carriersTable.name,
  agentId: enrollmentsTable.agentId,
  planId: enrollmentsTable.planId,
  planName: enrollmentsTable.planName,
  planType: enrollmentsTable.planType,
  planYear: enrollmentsTable.planYear,
  policyNumber: enrollmentsTable.policyNumber,
  applicationDate: enrollmentsTable.applicationDate,
  effectiveDate: enrollmentsTable.effectiveDate,
  effectuated: enrollmentsTable.effectuated,
  disenrolledDate: enrollmentsTable.disenrolledDate,
  status: enrollmentsTable.status,
  notes: enrollmentsTable.notes,
  createdAt: enrollmentsTable.createdAt,
  updatedAt: enrollmentsTable.updatedAt,
};

router.get(
  "/enrollments",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const q = req.query as Record<string, string | undefined>;

    const conditions: SQL[] = [eq(enrollmentsTable.orgId, authReq.orgId)];
    if (q.contactId) {
      conditions.push(eq(enrollmentsTable.contactId, q.contactId));
    }
    if (q.planYear && /^\d{4}$/.test(q.planYear)) {
      conditions.push(eq(enrollmentsTable.planYear, Number(q.planYear)));
    }
    if (q.status && (STATUSES as readonly string[]).includes(q.status)) {
      conditions.push(
        eq(enrollmentsTable.status, q.status as (typeof STATUSES)[number]),
      );
    }
    if (q.carrierId) {
      conditions.push(eq(enrollmentsTable.carrierId, q.carrierId));
    }

    const rows = await db
      .select(enrollmentColumns)
      .from(enrollmentsTable)
      .leftJoin(carriersTable, eq(carriersTable.id, enrollmentsTable.carrierId))
      .where(and(...conditions))
      .orderBy(desc(enrollmentsTable.planYear), desc(enrollmentsTable.effectiveDate))
      .limit(safeLimit(q.limit, 100))
      .offset(safeOffset(q.offset));

    res.json(rows);
  },
);

/**
 * Coverage history for one beneficiary — newest plan year first.
 * This is the view that makes AEP/OEP switching legible.
 *
 * Path is `plan-enrollments`, not `enrollments`: `/contacts/:id/enrollments`
 * already exists in routes/contacts.ts and returns *marketing sequence*
 * enrollments (which drip campaigns a contact is in). "Enrollment" is
 * overloaded in this domain, and that endpoint is live — so this one takes an
 * unambiguous path rather than shadowing it.
 */
router.get(
  "/contacts/:id/plan-enrollments",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const contactId = Array.isArray(req.params.id)
      ? req.params.id[0]
      : req.params.id;

    if (!(await contactInOrg(contactId, authReq.orgId))) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const rows = await db
      .select(enrollmentColumns)
      .from(enrollmentsTable)
      .leftJoin(carriersTable, eq(carriersTable.id, enrollmentsTable.carrierId))
      .where(
        and(
          eq(enrollmentsTable.orgId, authReq.orgId),
          eq(enrollmentsTable.contactId, contactId),
        ),
      )
      .orderBy(desc(enrollmentsTable.planYear), desc(enrollmentsTable.effectiveDate));

    res.json(rows);
  },
);

router.post(
  "/enrollments",
  requireAuth,
  requirePermission("contact", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    if (!(await contactInOrg(data.contactId, authReq.orgId))) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    try {
      const [created] = await db
        .insert(enrollmentsTable)
        .values({
          id: randomUUID(),
          orgId: authReq.orgId,
          contactId: data.contactId,
          carrierId: data.carrierId ?? null,
          agentId: data.agentId ?? null,
          planId: data.planId ?? null,
          planName: data.planName ?? null,
          planType: data.planType,
          planYear: data.planYear,
          policyNumber: data.policyNumber ?? null,
          applicationDate: data.applicationDate ?? null,
          effectiveDate: data.effectiveDate,
          effectuated: data.effectuated ?? false,
          disenrolledDate: data.disenrolledDate ?? null,
          status: data.status ?? "pending",
          notes: data.notes ?? null,
        })
        .returning();

      logger.info(
        { orgId: authReq.orgId, enrollmentId: created.id, contactId: data.contactId },
        "Enrollment recorded",
      );
      res.status(201).json(created);
    } catch (err) {
      // The unique index allows an MA plan and a standalone PDP in the same
      // year, but refuses a duplicate of the same carrier + plan type + year —
      // which would double-count the commission.
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error:
            "This beneficiary already has an enrollment with that carrier, plan type, and plan year.",
          code: "duplicate_enrollment",
        });
        return;
      }
      throw err;
    }
  },
);

router.patch(
  "/enrollments/:id",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const updates: Partial<typeof enrollmentsTable.$inferInsert> = {};
    const d = parsed.data;
    if (d.carrierId !== undefined) updates.carrierId = d.carrierId ?? null;
    if (d.agentId !== undefined) updates.agentId = d.agentId ?? null;
    if (d.planId !== undefined) updates.planId = d.planId ?? null;
    if (d.planName !== undefined) updates.planName = d.planName ?? null;
    if (d.planType !== undefined) updates.planType = d.planType;
    if (d.planYear !== undefined) updates.planYear = d.planYear;
    if (d.policyNumber !== undefined) updates.policyNumber = d.policyNumber ?? null;
    if (d.applicationDate !== undefined)
      updates.applicationDate = d.applicationDate ?? null;
    if (d.effectiveDate !== undefined) updates.effectiveDate = d.effectiveDate;
    if (d.effectuated !== undefined) updates.effectuated = d.effectuated;
    if (d.disenrolledDate !== undefined)
      updates.disenrolledDate = d.disenrolledDate ?? null;
    if (d.status !== undefined) updates.status = d.status;
    if (d.notes !== undefined) updates.notes = d.notes ?? null;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updatable fields supplied" });
      return;
    }

    const [updated] = await db
      .update(enrollmentsTable)
      .set(updates)
      .where(
        and(
          eq(enrollmentsTable.id, id),
          eq(enrollmentsTable.orgId, authReq.orgId),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Enrollment not found" });
      return;
    }
    res.json(updated);
  },
);

router.delete(
  "/enrollments/:id",
  requireAuth,
  requirePermission("contact", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [deleted] = await db
      .delete(enrollmentsTable)
      .where(
        and(
          eq(enrollmentsTable.id, id),
          eq(enrollmentsTable.orgId, authReq.orgId),
        ),
      )
      .returning({ id: enrollmentsTable.id });

    if (!deleted) {
      res.status(404).json({ error: "Enrollment not found" });
      return;
    }
    res.status(204).send();
  },
);

export default router;
