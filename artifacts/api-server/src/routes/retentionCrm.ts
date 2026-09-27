import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql, desc, gte, lte, isNull } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import {
  db,
  contactsTable,
  retentionFlagsTable,
  activitiesTable,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { serializeContact } from "../lib/serializeContact";

const router: IRouter = Router();

// GET /retention/birthdays — contacts with birthday in next 30 days
router.get(
  "/retention/birthdays",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const days = Math.min(parseInt((req.query.days as string) ?? "30", 10) || 30, 90);
    // Birthday year-wrap-aware query:
    // Convert birthday and window boundaries to day-of-year (1..366).
    // If endDoy >= startDoy the window is a normal range; if endDoy < startDoy the window
    // wraps around Dec→Jan, so we use OR (>= start OR <= end).
    const contacts = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.orgId, authReq.orgId),
          sql`${contactsTable.dob} IS NOT NULL`,
          sql`(
            CASE
              WHEN EXTRACT(DOY FROM (NOW() + INTERVAL '1 day' * ${days})) >= EXTRACT(DOY FROM NOW())
              THEN
                EXTRACT(DOY FROM DATE_TRUNC('year', NOW()) + (EXTRACT(MONTH FROM ${contactsTable.dob}) - 1) * INTERVAL '1 month' + (EXTRACT(DAY FROM ${contactsTable.dob}) - 1) * INTERVAL '1 day')
                BETWEEN EXTRACT(DOY FROM NOW()) AND EXTRACT(DOY FROM (NOW() + INTERVAL '1 day' * ${days}))
              ELSE
                EXTRACT(DOY FROM DATE_TRUNC('year', NOW()) + (EXTRACT(MONTH FROM ${contactsTable.dob}) - 1) * INTERVAL '1 month' + (EXTRACT(DAY FROM ${contactsTable.dob}) - 1) * INTERVAL '1 day')
                >= EXTRACT(DOY FROM NOW())
                OR
                EXTRACT(DOY FROM DATE_TRUNC('year', NOW()) + (EXTRACT(MONTH FROM ${contactsTable.dob}) - 1) * INTERVAL '1 month' + (EXTRACT(DAY FROM ${contactsTable.dob}) - 1) * INTERVAL '1 day')
                <= EXTRACT(DOY FROM (NOW() + INTERVAL '1 day' * ${days}))
            END
          )`,
        ),
      )
      .orderBy(
        sql`EXTRACT(MONTH FROM ${contactsTable.dob}) * 100 + EXTRACT(DAY FROM ${contactsTable.dob})`,
      )
      .limit(200);
    res.json(contacts.map((c) => serializeContact(c, authReq.userRole)));
  },
);

// GET /retention/anniversaries — contacts approaching 1-year enrollment mark
router.get(
  "/retention/anniversaries",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const days = Math.min(parseInt((req.query.days as string) ?? "30", 10) || 30, 90);
    // Contacts enrolled for close to (N*365) days — plan anniversary approaching
    const contacts = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.orgId, authReq.orgId),
          sql`${contactsTable.status} = 'enrolled'`,
          sql`${contactsTable.planYear} IS NOT NULL`,
          // Plan year matches current year -1 (first year anniversary)
          sql`${contactsTable.planYear} = EXTRACT(YEAR FROM NOW())::int - 1`,
        ),
      )
      .orderBy(desc(contactsTable.updatedAt))
      .limit(200);
    res.json(contacts.map((c) => serializeContact(c, authReq.userRole)));
  },
);

// GET /retention/aep — AEP-eligible contacts
router.get(
  "/retention/aep",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { stateCode, planType, county } = req.query as Record<string, string | undefined>;
    const conditions = [
      eq(contactsTable.orgId, authReq.orgId),
      sql`${contactsTable.status} IN ('enrolled', 'retained', 'prospect')`,
    ];
    if (stateCode) conditions.push(eq(contactsTable.stateCode, stateCode));
    if (planType) conditions.push(eq(contactsTable.currentPlanType, planType as "MA" | "PDP" | "MAPD" | "supp" | "other"));
    if (county) conditions.push(eq(contactsTable.county, county));

    const contacts = await db.select().from(contactsTable).where(and(...conditions)).orderBy(desc(contactsTable.updatedAt)).limit(500);
    res.json(contacts.map((c) => serializeContact(c, authReq.userRole)));
  },
);

// GET /retention/at-risk — contacts with no recent activity
router.get(
  "/retention/at-risk",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const thresholdDays = Math.min(parseInt((req.query.days as string) ?? "60", 10) || 60, 365);
    const cutoff = new Date(Date.now() - thresholdDays * 86400000);

    // Find enrolled/retained contacts with no activity after the cutoff
    const atRisk = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.orgId, authReq.orgId),
          sql`${contactsTable.status} IN ('enrolled', 'retained')`,
          sql`NOT EXISTS (
            SELECT 1 FROM activities a
            WHERE a.contact_id = ${contactsTable.id}
            AND a.created_at >= ${cutoff}
          )`,
        ),
      )
      .orderBy(sql`${contactsTable.updatedAt} ASC`)
      .limit(500);

    res.json(atRisk.map((c) => serializeContact(c, authReq.userRole)));
  },
);

// GET /retention/flags
router.get(
  "/retention/flags",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { flagType, resolved } = req.query as Record<string, string | undefined>;
    const conditions = [eq(retentionFlagsTable.orgId, authReq.orgId)];
    if (flagType) conditions.push(eq(retentionFlagsTable.flagType, flagType as "at_risk" | "anniversary_due" | "birthday_soon" | "aep_eligible" | "oep_eligible"));
    if (resolved === "false") conditions.push(isNull(retentionFlagsTable.resolvedAt));
    if (resolved === "true") conditions.push(sql`${retentionFlagsTable.resolvedAt} IS NOT NULL`);

    const flags = await db
      .select({ flag: retentionFlagsTable, contactFirstName: contactsTable.firstName, contactLastName: contactsTable.lastName, contactPhone: contactsTable.phone, contactEmail: contactsTable.email })
      .from(retentionFlagsTable)
      .innerJoin(contactsTable, eq(retentionFlagsTable.contactId, contactsTable.id))
      .where(and(...conditions))
      .orderBy(desc(retentionFlagsTable.createdAt))
      .limit(500);

    res.json(flags);
  },
);

// POST /retention/flags
router.post(
  "/retention/flags",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const Schema = z.object({
      contactId: z.string(),
      flagType: z.enum(["at_risk", "anniversary_due", "birthday_soon", "aep_eligible", "oep_eligible"]),
      dueDate: z.string().optional().nullable(),
    });
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid request body", details: parsed.error.issues }); return; }

    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.id, parsed.data.contactId), eq(contactsTable.orgId, authReq.orgId))).limit(1);
    if (!contact) { res.status(400).json({ error: "Contact not found" }); return; }

    const [flag] = await db.insert(retentionFlagsTable).values({
      id: randomUUID(),
      orgId: authReq.orgId,
      contactId: parsed.data.contactId,
      flagType: parsed.data.flagType,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    }).returning();
    res.status(201).json(flag);
  },
);

// PATCH /retention/flags/:id/resolve
router.patch(
  "/retention/flags/:id/resolve",
  requireAuth,
  requirePermission("contact", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [flag] = await db.select({ id: retentionFlagsTable.id, contactId: retentionFlagsTable.contactId }).from(retentionFlagsTable).where(and(eq(retentionFlagsTable.id, id), eq(retentionFlagsTable.orgId, authReq.orgId))).limit(1);
    if (!flag) { res.status(404).json({ error: "Flag not found" }); return; }
    await db.update(retentionFlagsTable).set({ resolvedAt: new Date() }).where(and(eq(retentionFlagsTable.id, id), eq(retentionFlagsTable.orgId, authReq.orgId)));
    res.json({ success: true });
  },
);

// GET /retention/summary — counts for nav badges
router.get(
  "/retention/summary",
  requireAuth,
  requirePermission("contact", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const now = new Date();
    const cutoff60 = new Date(now.getTime() - 60 * 86400000);

    const [birthdayCount, atRiskCount, openFlagsCount] = await Promise.all([
      // Same year-wrap-aware day-of-year window as GET /retention/birthdays.
      // The window end is computed in SQL: interpolating a JS Date into
      // `EXTRACT(DOY FROM $1)` leaves the parameter untyped and Postgres
      // rejects the query ("could not determine data type"), which 500'd
      // this endpoint.
      db.select({ count: sql<number>`count(*)` }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), sql`${contactsTable.dob} IS NOT NULL`, sql`(CASE WHEN EXTRACT(DOY FROM (NOW() + INTERVAL '30 days')) >= EXTRACT(DOY FROM NOW()) THEN EXTRACT(DOY FROM DATE_TRUNC('year', NOW()) + (EXTRACT(MONTH FROM ${contactsTable.dob}) - 1) * INTERVAL '1 month' + (EXTRACT(DAY FROM ${contactsTable.dob}) - 1) * INTERVAL '1 day') BETWEEN EXTRACT(DOY FROM NOW()) AND EXTRACT(DOY FROM (NOW() + INTERVAL '30 days')) ELSE EXTRACT(DOY FROM DATE_TRUNC('year', NOW()) + (EXTRACT(MONTH FROM ${contactsTable.dob}) - 1) * INTERVAL '1 month' + (EXTRACT(DAY FROM ${contactsTable.dob}) - 1) * INTERVAL '1 day') >= EXTRACT(DOY FROM NOW()) OR EXTRACT(DOY FROM DATE_TRUNC('year', NOW()) + (EXTRACT(MONTH FROM ${contactsTable.dob}) - 1) * INTERVAL '1 month' + (EXTRACT(DAY FROM ${contactsTable.dob}) - 1) * INTERVAL '1 day') <= EXTRACT(DOY FROM (NOW() + INTERVAL '30 days')) END)`)),
      db.select({ count: sql<number>`count(*)` }).from(contactsTable).where(and(eq(contactsTable.orgId, authReq.orgId), sql`${contactsTable.status} IN ('enrolled', 'retained')`, sql`NOT EXISTS (SELECT 1 FROM activities a WHERE a.contact_id = ${contactsTable.id} AND a.created_at >= ${cutoff60})`)),
      db.select({ count: sql<number>`count(*)` }).from(retentionFlagsTable).where(and(eq(retentionFlagsTable.orgId, authReq.orgId), isNull(retentionFlagsTable.resolvedAt))),
    ]);

    res.json({
      birthdaysInNext30Days: Number(birthdayCount[0]?.count ?? 0),
      atRiskContacts: Number(atRiskCount[0]?.count ?? 0),
      openFlags: Number(openFlagsCount[0]?.count ?? 0),
    });
  },
);

export default router;
