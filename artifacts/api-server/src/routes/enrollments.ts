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
  agentsTable,
} from "@workspace/db";

/** The transaction handle Drizzle hands to `db.transaction(...)`. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 * Resolves a carrier inside the caller's org.
 *
 * `carriers.org_id` is NOT NULL — carriers are tenant data, not global
 * reference data. Without this check a caller could attach another agency's
 * carrier to their own enrollment, and the carrier-name join would then read
 * that foreign row straight back out in the response.
 */
async function carrierInOrg(
  carrierId: string,
  orgId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: carriersTable.id })
    .from(carriersTable)
    .where(and(eq(carriersTable.id, carrierId), eq(carriersTable.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Resolves an agent inside the caller's org.
 *
 * Same invariant as `carrierInOrg`, and it was missed on the same table:
 * `agents.org_id` is NOT NULL, so accepting an unchecked `agentId` would let
 * one agency attach another agency's agent to its enrollment — on the very
 * table intended to spine commission payouts, where a foreign writing agent
 * is a money problem, not just a data one.
 */
async function agentInOrg(
  agentId: string,
  orgId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

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

/**
 * Mirrors an enrollment back onto the legacy `contacts.current_*` columns.
 *
 * Those columns are not dropped yet, and several consumers still read them —
 * the AEP cockpit, churn scoring, retention CRM filters, automation-rule
 * context, and the AI context builder. If enrollments were written without
 * updating them, coverage recorded through this API would be invisible to all
 * of those, which is worse than the flattening it replaces.
 *
 * Only the beneficiary's CURRENT coverage belongs in a single-value column, so
 * this writes the latest active enrollment by plan year and effective date —
 * and clears the columns when no active coverage remains. It is a projection,
 * not a second source of truth: `enrollments` is authoritative, and this
 * function is deleted in the release that drops the columns.
 */
async function syncContactCoverageProjection(
  contactId: string,
  orgId: string,
  tx?: DbTransaction,
): Promise<void> {
  const [current] = await (tx ?? db)
    .select({
      planType: enrollmentsTable.planType,
      carrierId: enrollmentsTable.carrierId,
      planYear: enrollmentsTable.planYear,
    })
    .from(enrollmentsTable)
    .where(
      and(
        eq(enrollmentsTable.orgId, orgId),
        eq(enrollmentsTable.contactId, contactId),
        eq(enrollmentsTable.status, "active"),
      ),
    )
    .orderBy(
      desc(enrollmentsTable.planYear),
      desc(enrollmentsTable.effectiveDate),
      // Deterministic tiebreaker, and not an arbitrary one.
      //
      // A dual-enrolled beneficiary (MA/MAPD plus a standalone PDP) commonly
      // has both enrollments in the same plan year with the same effective
      // date — the 0040 backfill guarantees it, since it sets every backfilled
      // effective date to 1 January. Ordering on (plan year, effective date)
      // alone leaves the winner to row order, so the projection could land on
      // either plan.
      //
      // That is not a cosmetic coin flip. `aepCockpit.ts` and
      // `lib/aepRenewal/generate.ts` both filter `contacts.current_plan_type`
      // through MA_PLAN_TYPES = ('MA','MAPD'). If PDP won the tie, the
      // beneficiary silently vanished from AEP renewal task generation and the
      // cockpit counts — a regression against the feature this table exists to
      // enable.
      //
      // MA/MAPD therefore outranks everything else, and `id` breaks any
      // remaining tie so the result is stable across runs.
      sql`CASE WHEN ${enrollmentsTable.planType} IN ('MA','MAPD') THEN 0 ELSE 1 END`,
      desc(enrollmentsTable.id),
    )
    .limit(1);

  await (tx ?? db)
    .update(contactsTable)
    .set({
      currentPlanType: current?.planType ?? null,
      currentCarrierId: current?.carrierId ?? null,
      planYear: current?.planYear ?? null,
    })
    .where(and(eq(contactsTable.id, contactId), eq(contactsTable.orgId, orgId)));
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
      .leftJoin(
        carriersTable,
        and(
          eq(carriersTable.id, enrollmentsTable.carrierId),
          eq(carriersTable.orgId, authReq.orgId),
        ),
      )
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
      .leftJoin(
        carriersTable,
        and(
          eq(carriersTable.id, enrollmentsTable.carrierId),
          eq(carriersTable.orgId, authReq.orgId),
        ),
      )
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

    if (data.carrierId && !(await carrierInOrg(data.carrierId, authReq.orgId))) {
      res.status(404).json({ error: "Carrier not found" });
      return;
    }

    if (data.agentId && !(await agentInOrg(data.agentId, authReq.orgId))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    try {
      // Insert and projection in one transaction: a crash between them would
      // otherwise leave `contacts.current_*` describing coverage that differs
      // from the enrollments table, and the AEP filters read the projection.
      const created = await db.transaction(async (tx) => {
      const [row] = await tx
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

        await syncContactCoverageProjection(data.contactId, authReq.orgId, tx);
        return row;
      });

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

    if (d.carrierId && !(await carrierInOrg(d.carrierId, authReq.orgId))) {
      res.status(404).json({ error: "Carrier not found" });
      return;
    }

    if (d.agentId && !(await agentInOrg(d.agentId, authReq.orgId))) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    let updated;
    try {
      updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(enrollmentsTable)
          .set(updates)
          .where(
            and(
              eq(enrollmentsTable.id, id),
              eq(enrollmentsTable.orgId, authReq.orgId),
            ),
          )
          .returning();

        // Status, plan year, carrier or plan type may have changed which
        // enrollment counts as current.
        if (row) {
          await syncContactCoverageProjection(row.contactId, authReq.orgId, tx);
        }
        return row;
      });
    } catch (err) {
      // Moving an enrollment onto an existing carrier + plan type + year
      // collides with the same unique index POST guards against, and must
      // answer the same way rather than surfacing a 500.
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

    const deleted = await db.transaction(async (tx) => {
      const [row] = await tx
        .delete(enrollmentsTable)
        .where(
          and(
            eq(enrollmentsTable.id, id),
            eq(enrollmentsTable.orgId, authReq.orgId),
          ),
        )
        .returning({
          id: enrollmentsTable.id,
          contactId: enrollmentsTable.contactId,
        });

      // Removing the current enrollment must not leave stale coverage behind.
      if (row) {
        await syncContactCoverageProjection(row.contactId, authReq.orgId, tx);
      }
      return row;
    });

    if (!deleted) {
      res.status(404).json({ error: "Enrollment not found" });
      return;
    }

    res.status(204).send();
  },
);

export default router;
