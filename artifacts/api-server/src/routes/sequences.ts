import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, inArray, isNull, notInArray, sql, desc, asc } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  sequencesTable,
  sequenceStepsTable,
  sequenceEnrollmentsTable,
  contactsTable,
  activitiesTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { enqueue, JOB_NAMES } from "../lib/jobs";

const router: IRouter = Router();

// GET /sequences
router.get(
  "/sequences",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const sequences = await db
      .select({
        sequence: sequencesTable,
        stepCount: sql<number>`(select count(*) from sequence_steps where sequence_id = ${sequencesTable.id})`,
        activeEnrollments: sql<number>`(select count(*) from sequence_enrollments where sequence_id = ${sequencesTable.id} and status = 'active')`,
      })
      .from(sequencesTable)
      .where(eq(sequencesTable.orgId, authReq.orgId))
      .orderBy(desc(sequencesTable.updatedAt));
    res.json(sequences);
  },
);

// POST /sequences
router.post(
  "/sequences",
  requireAuth,
  requirePermission("contact", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const Schema = z.object({
      name: z.string().min(1).max(200),
      description: z.string().optional(),
      triggerType: z.enum(["manual", "lead_created", "enrolled", "birthday", "plan_anniversary", "aep_start", "oep_start", "custom_date"]).optional(),
      triggerConfig: z.record(z.unknown()).optional(),
      status: z.enum(["active", "paused", "draft"]).optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const [seq] = await db.insert(sequencesTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      triggerType: parsed.data.triggerType ?? "manual",
      triggerConfig: parsed.data.triggerConfig ?? null,
      status: parsed.data.status ?? "draft",
    }).returning();
    res.status(201).json(seq);
  },
);

// GET /sequences/:id
router.get(
  "/sequences/:id",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [seq] = await db.select().from(sequencesTable).where(and(eq(sequencesTable.id, id), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!seq) { res.status(404).json({ error: "Sequence not found" }); return; }
    const steps = await db.select().from(sequenceStepsTable).where(eq(sequenceStepsTable.sequenceId, id)).orderBy(asc(sequenceStepsTable.orderIndex));
    res.json({ ...seq, steps });
  },
);

// PATCH /sequences/:id
router.patch(
  "/sequences/:id",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: sequencesTable.id }).from(sequencesTable).where(and(eq(sequencesTable.id, id), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Sequence not found" }); return; }
    const Schema = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().nullable().optional(),
      triggerType: z.enum(["manual", "lead_created", "enrolled", "birthday", "plan_anniversary", "aep_start", "oep_start", "custom_date"]).optional(),
      triggerConfig: z.record(z.unknown()).nullable().optional(),
      status: z.enum(["active", "paused", "draft"]).optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const [updated] = await db.update(sequencesTable).set({ ...parsed.data }).where(and(eq(sequencesTable.id, id), eq(sequencesTable.orgId, authReq.orgId))).returning();
    res.json(updated);
  },
);

// DELETE /sequences/:id
router.delete(
  "/sequences/:id",
  requireAuth,
  requirePermission("contact", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [existing] = await db.select({ id: sequencesTable.id }).from(sequencesTable).where(and(eq(sequencesTable.id, id), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Sequence not found" }); return; }
    await db.delete(sequencesTable).where(and(eq(sequencesTable.id, id), eq(sequencesTable.orgId, authReq.orgId)));
    res.status(204).send();
  },
);

// ---- Steps ----

router.get(
  "/sequences/:id/steps",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [seq] = await db.select({ id: sequencesTable.id }).from(sequencesTable).where(and(eq(sequencesTable.id, id), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!seq) { res.status(404).json({ error: "Sequence not found" }); return; }
    const steps = await db.select().from(sequenceStepsTable).where(eq(sequenceStepsTable.sequenceId, id)).orderBy(asc(sequenceStepsTable.orderIndex));
    res.json(steps);
  },
);

router.post(
  "/sequences/:id/steps",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [seq] = await db.select({ id: sequencesTable.id }).from(sequencesTable).where(and(eq(sequencesTable.id, id), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!seq) { res.status(404).json({ error: "Sequence not found" }); return; }
    const Schema = z.object({
      stepType: z.enum(["sms", "email", "task", "wait"]),
      orderIndex: z.number().int().optional(),
      delayValue: z.number().int().min(0).optional(),
      delayUnit: z.enum(["minutes", "hours", "days"]).optional(),
      config: z.record(z.unknown()).optional(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const maxOrder = await db.select({ m: sql<number>`coalesce(max(${sequenceStepsTable.orderIndex}), -1)` }).from(sequenceStepsTable).where(eq(sequenceStepsTable.sequenceId, id));
    const orderIndex = parsed.data.orderIndex ?? Number(maxOrder[0]?.m ?? -1) + 1;
    const [step] = await db.insert(sequenceStepsTable).values({
      id: randomUUID(), sequenceId: id, stepType: parsed.data.stepType,
      orderIndex, delayValue: parsed.data.delayValue ?? 0,
      delayUnit: parsed.data.delayUnit ?? "days", config: parsed.data.config ?? null,
    }).returning();
    res.status(201).json(step);
  },
);

router.patch(
  "/sequences/:id/steps/:sid",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const seqId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const sid = Array.isArray(req.params.sid) ? req.params.sid[0] : req.params.sid;
    const [seq] = await db.select({ id: sequencesTable.id }).from(sequencesTable).where(and(eq(sequencesTable.id, seqId), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!seq) { res.status(404).json({ error: "Sequence not found" }); return; }
    const [step] = await db.select({ id: sequenceStepsTable.id }).from(sequenceStepsTable).where(and(eq(sequenceStepsTable.id, sid), eq(sequenceStepsTable.sequenceId, seqId))).limit(1);
    if (!step) { res.status(404).json({ error: "Step not found" }); return; }
    const Schema = z.object({ stepType: z.enum(["sms", "email", "task", "wait"]).optional(), orderIndex: z.number().int().optional(), delayValue: z.number().int().min(0).optional(), delayUnit: z.enum(["minutes", "hours", "days"]).optional(), config: z.record(z.unknown()).nullable().optional() });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }
    const [updated] = await db.update(sequenceStepsTable).set({ ...parsed.data }).where(eq(sequenceStepsTable.id, sid)).returning();
    res.json(updated);
  },
);

router.delete(
  "/sequences/:id/steps/:sid",
  requireAuth,
  requirePermission("contact", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const seqId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const sid = Array.isArray(req.params.sid) ? req.params.sid[0] : req.params.sid;
    const [seq] = await db.select({ id: sequencesTable.id }).from(sequencesTable).where(and(eq(sequencesTable.id, seqId), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!seq) { res.status(404).json({ error: "Sequence not found" }); return; }
    await db.delete(sequenceStepsTable).where(and(eq(sequenceStepsTable.id, sid), eq(sequenceStepsTable.sequenceId, seqId)));
    res.status(204).send();
  },
);

// ---- Enrollments ----

// POST /sequences/:id/enroll
router.post(
  "/sequences/:id/enroll",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const seqId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [seq] = await db.select().from(sequencesTable).where(and(eq(sequencesTable.id, seqId), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!seq) { res.status(404).json({ error: "Sequence not found" }); return; }

    const Schema = z.object({ contactIds: z.string().array().min(1).max(200) });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    const steps = await db.select().from(sequenceStepsTable).where(eq(sequenceStepsTable.sequenceId, seqId)).orderBy(asc(sequenceStepsTable.orderIndex));

    // ---- Set-based bulk enroll ------------------------------------------------
    // Previously this loop did up to 5 round-trips per contact (~5N + 1). We
    // now collapse it to a fixed number of queries: 1 contact lookup, 1
    // active-enrollment lookup, 1 batch enrollment insert, 1 batch activity
    // insert, and N parallel enqueue calls (pg-boss `send` is per-job).
    const contactIds = parsed.data.contactIds;
    const skipped: string[] = [];

    // 1) Verify contacts in one query.
    const foundContactRows = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(
        and(
          inArray(contactsTable.id, contactIds),
          eq(contactsTable.orgId, authReq.orgId),
          isNull(contactsTable.deletedAt),
        ),
      );
    const foundIds = new Set(foundContactRows.map((r) => r.id));

    // 2) Check existing active enrollments in one query (only among found
    //    contacts — saves bandwidth and avoids leaking non-org rows even if
    //    the FK index were ever loose).
    const foundIdsArr = [...foundIds];
    const existingActiveRows = foundIdsArr.length
      ? await db
          .select({ contactId: sequenceEnrollmentsTable.contactId })
          .from(sequenceEnrollmentsTable)
          .where(
            and(
              eq(sequenceEnrollmentsTable.sequenceId, seqId),
              inArray(sequenceEnrollmentsTable.contactId, foundIdsArr),
              eq(sequenceEnrollmentsTable.status, "active"),
            ),
          )
      : [];
    const alreadyEnrolled = new Set(existingActiveRows.map((r) => r.contactId));

    // 3) Compute final enroll-list. Preserve original input order so any
    //    downstream consumers that iterate the response see deterministic
    //    ordering.
    const enrollList: string[] = [];
    for (const id of contactIds) {
      if (!foundIds.has(id) || alreadyEnrolled.has(id)) {
        skipped.push(id);
      } else {
        enrollList.push(id);
      }
    }

    if (enrollList.length > 0) {
      const now = new Date();
      // The authoritative pointer for "what step runs next" is the
      // FIRST step's stable id (sorted by order_index). If the
      // sequence is empty (no steps configured), nextStepId stays
      // null and the worker will gracefully complete the enrollment
      // on first run.
      const firstStepId = steps[0]?.id ?? null;

      // 4) Batch insert enrollments.
      await db.insert(sequenceEnrollmentsTable).values(
        enrollList.map((contactId) => ({
          id: randomUUID(),
          sequenceId: seqId,
          contactId,
          status: "active" as const,
          nextStepIndex: 0,
          nextStepId: firstStepId,
          nextStepAt: now,
        })),
      );

      // 5) Batch insert activities.
      await db.insert(activitiesTable).values(
        enrollList.map((contactId) => ({
          id: randomUUID(),
          orgId: authReq.orgId,
          contactId,
          type: "sequence_enrolled" as const,
          body: `Enrolled in sequence: ${seq.name}`,
          createdBy: authReq.userId,
        })),
      );

      // 6) Kick off first step immediately only for actionable step types
      //    (sms/email). wait and task steps are handled by the scheduler on
      //    their delay schedule, not immediately. pg-boss `send` is per-job;
      //    parallelize so the wall-clock cost is one RTT, not N.
      const firstStep = steps[0];
      if (firstStep && (firstStep.stepType === "sms" || firstStep.stepType === "email")) {
        const channel = firstStep.stepType;
        await Promise.all(
          enrollList.map((contactId) =>
            enqueue(JOB_NAMES.SEND_SEQUENCE_STEP, {
              sequenceId: seqId,
              contactId,
              stepId: firstStep.id,
              stepIndex: 0,
              channel,
            }),
          ),
        );
      }
    }

    res.json({ enrolled: enrollList.length, skipped: skipped.length });
  },
);

// GET /sequences/:id/enrollments
router.get(
  "/sequences/:id/enrollments",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const seqId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [seq] = await db.select({ id: sequencesTable.id }).from(sequencesTable).where(and(eq(sequencesTable.id, seqId), eq(sequencesTable.orgId, authReq.orgId))).limit(1);
    if (!seq) { res.status(404).json({ error: "Sequence not found" }); return; }
    const enrollments = await db
      .select({ enrollment: sequenceEnrollmentsTable, contactFirstName: contactsTable.firstName, contactLastName: contactsTable.lastName, contactEmail: contactsTable.email })
      .from(sequenceEnrollmentsTable)
      .innerJoin(contactsTable, eq(sequenceEnrollmentsTable.contactId, contactsTable.id))
      .where(eq(sequenceEnrollmentsTable.sequenceId, seqId))
      .orderBy(desc(sequenceEnrollmentsTable.enrolledAt));
    res.json(enrollments);
  },
);

// PATCH /sequences/:id/enrollments/:eid — pause/cancel
//
// Concurrency note: the previous handler unconditionally set
// `completedAt = now()` whenever the payload requested `cancelled`,
// without checking the prior status. A second cancel call after a real
// cancellation would overwrite the original `completedAt`, losing the
// genuine first-cancellation timestamp. (For non-cancel transitions, the
// `completedAt` field is left untouched.)
//
// The fix is to gate the cancel transition on a conditional UPDATE that
// excludes already-terminal statuses (`cancelled`, `completed`). Only the
// caller whose UPDATE actually performs the transition writes the
// `completedAt` timestamp; later cancel calls fall through to a no-op
// 200 with the original timestamp preserved.
router.patch(
  "/sequences/:id/enrollments/:eid",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const seqId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const eid = Array.isArray(req.params.eid) ? req.params.eid[0] : req.params.eid;
    const Schema = z.object({ status: z.enum(["active", "paused", "cancelled"]) });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    const result = await db.transaction(async (tx) => {
      const [seq] = await tx
        .select({ id: sequencesTable.id })
        .from(sequencesTable)
        .where(and(eq(sequencesTable.id, seqId), eq(sequencesTable.orgId, authReq.orgId)))
        .limit(1);
      if (!seq) { return { kind: "seq-not-found" as const }; }

      if (parsed.data.status === "cancelled") {
        // Conditional UPDATE — only transition to cancelled if not
        // already in a terminal state. The `completedAt` timestamp is
        // only written by the caller that actually performs the
        // transition, so subsequent cancel calls cannot overwrite it.
        const [updated] = await tx
          .update(sequenceEnrollmentsTable)
          .set({ status: "cancelled", completedAt: new Date() })
          .where(
            and(
              eq(sequenceEnrollmentsTable.id, eid),
              eq(sequenceEnrollmentsTable.sequenceId, seqId),
              notInArray(sequenceEnrollmentsTable.status, ["cancelled", "completed"]),
            ),
          )
          .returning();

        if (updated) {
          return { kind: "ok" as const, row: updated };
        }

        // Either the enrollment doesn't exist (-> 404) or it's already
        // terminal (-> 200 idempotent, preserve original completedAt).
        const [existing] = await tx
          .select()
          .from(sequenceEnrollmentsTable)
          .where(and(eq(sequenceEnrollmentsTable.id, eid), eq(sequenceEnrollmentsTable.sequenceId, seqId)))
          .limit(1);
        if (!existing) { return { kind: "enrollment-not-found" as const }; }
        return { kind: "ok" as const, row: existing };
      }

      // Non-cancel transitions: just update status, don't touch
      // completedAt. We still want to 404 if the row doesn't exist.
      const [updated] = await tx
        .update(sequenceEnrollmentsTable)
        .set({ status: parsed.data.status })
        .where(and(eq(sequenceEnrollmentsTable.id, eid), eq(sequenceEnrollmentsTable.sequenceId, seqId)))
        .returning();
      if (!updated) { return { kind: "enrollment-not-found" as const }; }
      return { kind: "ok" as const, row: updated };
    });

    if (result.kind === "seq-not-found") { res.status(404).json({ error: "Sequence not found" }); return; }
    if (result.kind === "enrollment-not-found") { res.status(404).json({ error: "Enrollment not found" }); return; }
    res.json(result.row);
  },
);

export default router;
