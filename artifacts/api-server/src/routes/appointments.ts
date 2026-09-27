/**
 * Calendar appointments (stage2/calendar-branding).
 *
 *   GET    /appointments?from&to[&agentId&contactId&status]  — range list + status counts
 *   GET    /appointments/contact-options?search               — picker: contacts the caller may book
 *   GET    /appointments/agent-options                        — picker: agents the caller may book for
 *   GET    /appointments/:id
 *   POST   /appointments
 *   PATCH  /appointments/:id
 *   DELETE /appointments/:id
 *
 * Authorization mirrors contacts/tasks: every query is filtered on
 * `authReq.orgId`, and the RBAC matrix (`appointment` resource) admits the
 * roles. On top of that the `agent` role is narrowed to *their own* calendar:
 * they only ever see, create, edit or delete rows whose `agent_id` is their
 * own agent profile, and may only link contacts assigned to them. Back-office
 * roles see and manage the whole org, as they do for contacts.
 *
 * Notes are encrypted at rest (lib/appointments.ts) and only returned in
 * plaintext to PHI-privileged roles, the owning agent and the note's author.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq, gte, ilike, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  agentsTable,
  appointmentsTable,
  contactsTable,
  type Appointment,
} from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import {
  APPOINTMENT_LOCATION_TYPES,
  APPOINTMENT_STATUSES,
  APPOINTMENT_TYPES,
  AppointmentValidationError,
  MAX_APPOINTMENT_MS,
  MAX_NOTES_LENGTH,
  agentInOrg,
  canReadNotes,
  contactInOrg,
  decryptNotes,
  encryptNotes,
  insertAppointment,
  ownAgentId,
} from "../lib/appointments";
import { safeLimit } from "../lib/listGuards";

const router: IRouter = Router();

/** Longest range one list call may cover (a month view spans ≤ 6 weeks). */
const MAX_RANGE_MS = 100 * 24 * 60 * 60 * 1000;

const audit = auditMiddleware("appointment", undefined, {
  includeReads: false,
  getResourceId: (req) => {
    const raw = req.params.id;
    return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  },
});

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Must be an ISO date-time");

const httpsUrl = z
  .string()
  .max(500)
  .url()
  .refine((v) => v.startsWith("https://"), "Meeting links must start with https://");

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: z.enum(APPOINTMENT_TYPES).default("consultation"),
  status: z.enum(APPOINTMENT_STATUSES).default("pending"),
  startsAt: isoDate,
  endsAt: isoDate,
  contactId: z.string().min(1).nullable().optional(),
  agentId: z.string().min(1).nullable().optional(),
  notes: z.string().max(MAX_NOTES_LENGTH).nullable().optional(),
  locationType: z.enum(APPOINTMENT_LOCATION_TYPES).default("office"),
  locationDetail: z.string().trim().max(300).nullable().optional(),
  meetingUrl: httpsUrl.nullable().optional(),
});

const UpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  type: z.enum(APPOINTMENT_TYPES).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  startsAt: isoDate.optional(),
  endsAt: isoDate.optional(),
  contactId: z.string().min(1).nullable().optional(),
  agentId: z.string().min(1).nullable().optional(),
  notes: z.string().max(MAX_NOTES_LENGTH).nullable().optional(),
  locationType: z.enum(APPOINTMENT_LOCATION_TYPES).optional(),
  locationDetail: z.string().trim().max(300).nullable().optional(),
  meetingUrl: httpsUrl.nullable().optional(),
});

function paramId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

function isAgentRole(authReq: AuthenticatedRequest): boolean {
  return authReq.userRole === "agent";
}

interface Viewer {
  userId: string;
  role: AuthenticatedRequest["userRole"];
  ownAgentId: string | null;
}

async function viewerFor(authReq: AuthenticatedRequest): Promise<Viewer> {
  return {
    userId: authReq.userId,
    role: authReq.userRole,
    ownAgentId: await ownAgentId(authReq.orgId, authReq.userId),
  };
}

type Joined = {
  appt: Appointment;
  contactFirstName: string | null;
  contactLastName: string | null;
  agentFirstName: string | null;
  agentLastName: string | null;
};

function serialize(row: Joined, viewer: Viewer) {
  const { appt } = row;
  const readable = canReadNotes(appt, {
    userId: viewer.userId,
    role: viewer.role,
    ownAgentId: viewer.ownAgentId,
    apptAgentId: appt.agentId,
  });
  const hasNotes = Boolean(appt.notesEncrypted);
  return {
    id: appt.id,
    contactId: appt.contactId,
    agentId: appt.agentId,
    type: appt.type,
    title: appt.title,
    notes: readable ? decryptNotes(appt.notesEncrypted) : null,
    notesMasked: hasNotes && !readable,
    startsAt: appt.startsAt,
    endsAt: appt.endsAt,
    status: appt.status,
    locationType: appt.locationType,
    locationDetail: appt.locationDetail,
    meetingUrl: appt.meetingUrl,
    reminderSentAt: appt.reminderSentAt,
    createdBy: appt.createdBy,
    createdAt: appt.createdAt,
    updatedAt: appt.updatedAt,
    contact: appt.contactId
      ? { id: appt.contactId, firstName: row.contactFirstName, lastName: row.contactLastName }
      : null,
    agent: appt.agentId
      ? { id: appt.agentId, firstName: row.agentFirstName, lastName: row.agentLastName }
      : null,
  };
}

function joinedSelect() {
  return db
    .select({
      appt: appointmentsTable,
      contactFirstName: contactsTable.firstName,
      contactLastName: contactsTable.lastName,
      agentFirstName: agentsTable.firstName,
      agentLastName: agentsTable.lastName,
    })
    .from(appointmentsTable)
    .leftJoin(
      contactsTable,
      and(
        eq(contactsTable.id, appointmentsTable.contactId),
        eq(contactsTable.orgId, appointmentsTable.orgId),
      ),
    )
    .leftJoin(
      agentsTable,
      and(
        eq(agentsTable.id, appointmentsTable.agentId),
        eq(agentsTable.orgId, appointmentsTable.orgId),
      ),
    );
}

async function loadOne(orgId: string, id: string): Promise<Joined | undefined> {
  const [row] = await joinedSelect()
    .where(and(eq(appointmentsTable.id, id), eq(appointmentsTable.orgId, orgId)))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------

router.get(
  "/appointments",
  requireAuth,
  requirePermission("appointment", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const q = req.query as Record<string, string | undefined>;

    const from = q.from ? new Date(q.from) : null;
    const to = q.to ? new Date(q.to) : null;
    if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      res.status(400).json({ error: "from and to (ISO date-times) are required" });
      return;
    }
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_RANGE_MS) {
      res.status(400).json({ error: "Range must be positive and at most 100 days" });
      return;
    }

    const viewer = await viewerFor(authReq);
    const conditions: SQL[] = [
      eq(appointmentsTable.orgId, authReq.orgId),
      gte(appointmentsTable.startsAt, from),
      lt(appointmentsTable.startsAt, to),
    ];

    if (isAgentRole(authReq)) {
      // An agent sees their own calendar only. No agent profile = nothing.
      if (!viewer.ownAgentId) {
        res.json({ data: [], summary: emptySummary(), scope: "own" });
        return;
      }
      conditions.push(eq(appointmentsTable.agentId, viewer.ownAgentId));
    } else if (q.agentId) {
      conditions.push(eq(appointmentsTable.agentId, q.agentId));
    }
    if (q.contactId) conditions.push(eq(appointmentsTable.contactId, q.contactId));
    if (q.status && (APPOINTMENT_STATUSES as readonly string[]).includes(q.status)) {
      conditions.push(eq(appointmentsTable.status, q.status as Appointment["status"]));
    }

    const rows = await joinedSelect()
      .where(and(...conditions))
      .orderBy(asc(appointmentsTable.startsAt))
      .limit(safeLimit(q.limit, 1000, 2000));

    const summary = emptySummary();
    for (const r of rows) {
      summary.total += 1;
      summary[r.appt.status] += 1;
    }

    res.json({
      data: rows.map((r) => serialize(r, viewer)),
      summary,
      scope: isAgentRole(authReq) ? "own" : "org",
    });
  },
);

function emptySummary(): Record<"total" | Appointment["status"], number> {
  return { total: 0, confirmed: 0, pending: 0, completed: 0, cancelled: 0, no_show: 0 };
}

router.get(
  "/appointments/contact-options",
  requireAuth,
  requirePermission("appointment", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const conditions: SQL[] = [
      eq(contactsTable.orgId, authReq.orgId),
      isNull(contactsTable.deletedAt),
    ];
    if (isAgentRole(authReq)) {
      const own = await ownAgentId(authReq.orgId, authReq.userId);
      if (!own) {
        res.json({ data: [] });
        return;
      }
      conditions.push(eq(contactsTable.assignedAgentId, own));
    }
    if (search) {
      const like = `%${search}%`;
      conditions.push(
        or(
          ilike(contactsTable.firstName, like),
          ilike(contactsTable.lastName, like),
          sql`(${contactsTable.firstName} || ' ' || ${contactsTable.lastName}) ILIKE ${like}`,
        ) as SQL,
      );
    }
    // Names only — this picker never needs (and never returns) PHI.
    const rows = await db
      .select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        assignedAgentId: contactsTable.assignedAgentId,
      })
      .from(contactsTable)
      .where(and(...conditions))
      .orderBy(asc(contactsTable.lastName), asc(contactsTable.firstName))
      .limit(safeLimit(req.query.limit, 20, 50));
    res.json({ data: rows });
  },
);

router.get(
  "/appointments/agent-options",
  requireAuth,
  requirePermission("appointment", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const conditions: SQL[] = [eq(agentsTable.orgId, authReq.orgId)];
    if (isAgentRole(authReq)) {
      conditions.push(eq(agentsTable.userId, authReq.userId));
    }
    const rows = await db
      .select({
        id: agentsTable.id,
        firstName: agentsTable.firstName,
        lastName: agentsTable.lastName,
        userId: agentsTable.userId,
      })
      .from(agentsTable)
      .where(and(...conditions))
      .orderBy(asc(agentsTable.lastName), asc(agentsTable.firstName))
      .limit(500);
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        isMe: r.userId === authReq.userId,
      })),
    });
  },
);

router.get(
  "/appointments/:id",
  requireAuth,
  requirePermission("appointment", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const row = await loadOne(authReq.orgId, paramId(req));
    const viewer = await viewerFor(authReq);
    if (!row || (isAgentRole(authReq) && row.appt.agentId !== viewer.ownAgentId)) {
      res.status(404).json({ error: "Appointment not found" });
      return;
    }
    res.json(serialize(row, viewer));
  },
);

router.post(
  "/appointments",
  requireAuth,
  requirePermission("appointment", "create"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const viewer = await viewerFor(authReq);

    let agentId = d.agentId ?? null;
    if (isAgentRole(authReq)) {
      if (!viewer.ownAgentId) {
        res.status(403).json({
          error: "Your login is not linked to an agent profile yet. Ask an administrator to link it.",
          code: "no_agent_profile",
        });
        return;
      }
      if (agentId && agentId !== viewer.ownAgentId) {
        res.status(403).json({ error: "Agents can only book on their own calendar" });
        return;
      }
      agentId = viewer.ownAgentId;
    }

    if (d.contactId) {
      const contact = await contactInOrg(d.contactId, authReq.orgId);
      if (!contact) {
        res.status(400).json({ error: "Contact not found" });
        return;
      }
      if (isAgentRole(authReq) && contact.assignedAgentId !== viewer.ownAgentId) {
        res.status(403).json({ error: "You can only book contacts assigned to you" });
        return;
      }
    }
    if (agentId && !(await agentInOrg(agentId, authReq.orgId))) {
      res.status(400).json({ error: "Agent not found" });
      return;
    }

    try {
      const appt = await insertAppointment({
        orgId: authReq.orgId,
        title: d.title,
        type: d.type,
        status: d.status,
        startsAt: new Date(d.startsAt),
        endsAt: new Date(d.endsAt),
        contactId: d.contactId ?? null,
        agentId,
        notes: d.notes ?? null,
        locationType: d.locationType,
        locationDetail: d.locationDetail || null,
        meetingUrl: d.meetingUrl || null,
        createdBy: authReq.userId,
      });
      const row = await loadOne(authReq.orgId, appt.id);
      res.status(201).json(serialize(row!, viewer));
    } catch (err) {
      if (err instanceof AppointmentValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

router.patch(
  "/appointments/:id",
  requireAuth,
  requirePermission("appointment", "update"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const id = paramId(req);
    const viewer = await viewerFor(authReq);

    const existing = await loadOne(authReq.orgId, id);
    if (!existing || (isAgentRole(authReq) && existing.appt.agentId !== viewer.ownAgentId)) {
      res.status(404).json({ error: "Appointment not found" });
      return;
    }

    const updates: Partial<typeof appointmentsTable.$inferInsert> = {};
    if (d.title !== undefined) updates.title = d.title;
    if (d.type !== undefined) updates.type = d.type;
    if (d.status !== undefined) updates.status = d.status;
    if (d.locationType !== undefined) updates.locationType = d.locationType;
    if (d.locationDetail !== undefined) updates.locationDetail = d.locationDetail || null;
    if (d.meetingUrl !== undefined) updates.meetingUrl = d.meetingUrl || null;
    if (d.notes !== undefined) updates.notesEncrypted = encryptNotes(d.notes);

    if (d.agentId !== undefined) {
      if (isAgentRole(authReq) && d.agentId !== viewer.ownAgentId) {
        res.status(403).json({ error: "Agents can only book on their own calendar" });
        return;
      }
      if (d.agentId && !(await agentInOrg(d.agentId, authReq.orgId))) {
        res.status(400).json({ error: "Agent not found" });
        return;
      }
      updates.agentId = d.agentId;
    }
    if (d.contactId !== undefined) {
      if (d.contactId) {
        const contact = await contactInOrg(d.contactId, authReq.orgId);
        if (!contact) {
          res.status(400).json({ error: "Contact not found" });
          return;
        }
        if (isAgentRole(authReq) && contact.assignedAgentId !== viewer.ownAgentId) {
          res.status(403).json({ error: "You can only book contacts assigned to you" });
          return;
        }
      }
      updates.contactId = d.contactId;
    }

    const startsAt = d.startsAt ? new Date(d.startsAt) : existing.appt.startsAt;
    const endsAt = d.endsAt ? new Date(d.endsAt) : existing.appt.endsAt;
    if (d.startsAt !== undefined || d.endsAt !== undefined) {
      if (!(endsAt.getTime() > startsAt.getTime())) {
        res.status(400).json({ error: "endsAt must be after startsAt" });
        return;
      }
      if (endsAt.getTime() - startsAt.getTime() > MAX_APPOINTMENT_MS) {
        res.status(400).json({ error: "Appointments can be at most 12 hours long" });
        return;
      }
      updates.startsAt = startsAt;
      updates.endsAt = endsAt;
      // Rescheduled: the client deserves a reminder for the new time.
      if (startsAt.getTime() !== existing.appt.startsAt.getTime()) {
        updates.reminderSentAt = null;
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    await db
      .update(appointmentsTable)
      .set(updates)
      .where(and(eq(appointmentsTable.id, id), eq(appointmentsTable.orgId, authReq.orgId)));

    const row = await loadOne(authReq.orgId, id);
    res.json(serialize(row!, viewer));
  },
);

router.delete(
  "/appointments/:id",
  requireAuth,
  requirePermission("appointment", "delete"),
  audit,
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = paramId(req);
    const conditions: SQL[] = [
      eq(appointmentsTable.id, id),
      eq(appointmentsTable.orgId, authReq.orgId),
    ];
    if (isAgentRole(authReq)) {
      const own = await ownAgentId(authReq.orgId, authReq.userId);
      if (!own) {
        res.status(404).json({ error: "Appointment not found" });
        return;
      }
      conditions.push(eq(appointmentsTable.agentId, own));
    }
    const deleted = await db
      .delete(appointmentsTable)
      .where(and(...conditions))
      .returning({ id: appointmentsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Appointment not found" });
      return;
    }
    res.sendStatus(204);
  },
);

export default router;
