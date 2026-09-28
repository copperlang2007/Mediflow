/**
 * Shared appointment helpers (stage2/calendar-branding).
 *
 * Used by both the REST routes (routes/appointments.ts) and the automation
 * engine's `create_appointment` action (workers/runAutomationRules.ts) so the
 * two paths validate and store an appointment identically — in particular,
 * both encrypt free-text notes and both refuse a contact or agent that belongs
 * to a different organization.
 */
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  agentsTable,
  appointmentsTable,
  contactsTable,
  encryptPii,
  decryptPii,
  APPOINTMENT_TYPES,
  APPOINTMENT_STATUSES,
  APPOINTMENT_LOCATION_TYPES,
  type Appointment,
  type AppointmentLocationType,
  type AppointmentStatus,
  type AppointmentType,
} from "@workspace/db";
import { PHI_PRIVILEGED_ROLES, type Role } from "./permissions";
import { logger } from "./logger";

export { APPOINTMENT_TYPES, APPOINTMENT_STATUSES, APPOINTMENT_LOCATION_TYPES };

/** Longest single appointment we accept. Anything longer is almost surely a typo. */
export const MAX_APPOINTMENT_MS = 12 * 60 * 60 * 1000;

export const MAX_NOTES_LENGTH = 4000;

export function encryptNotes(notes: string | null | undefined): Buffer | null {
  const trimmed = notes?.trim();
  if (!trimmed) return null;
  return encryptPii(trimmed).encrypted;
}

export function decryptNotes(enc: Buffer | Uint8Array | null | undefined): string | null {
  if (!enc) return null;
  try {
    return decryptPii(enc);
  } catch (err) {
    // A key rotation without re-encryption would land here. Never surface
    // ciphertext; report the note as unreadable instead.
    logger.error({ err }, "Failed to decrypt appointment notes");
    return null;
  }
}

/** Returns the id of the agent profile linked to this user in this org, if any. */
export async function ownAgentId(orgId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, orgId), eq(agentsTable.userId, userId)))
    .limit(1);
  return row?.id ?? null;
}

export async function agentInOrg(agentId: string, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.id, agentId), eq(agentsTable.orgId, orgId)))
    .limit(1);
  return Boolean(row);
}

/** A live (not soft-deleted) contact in this org, or null. */
export async function contactInOrg(
  contactId: string,
  orgId: string,
): Promise<{ id: string; assignedAgentId: string | null } | null> {
  const [row] = await db
    .select({ id: contactsTable.id, assignedAgentId: contactsTable.assignedAgentId })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.id, contactId),
        eq(contactsTable.orgId, orgId),
        isNull(contactsTable.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Who may read an appointment's notes in plaintext: the PHI-privileged roles
 * (same set that sees contact DOB / MBI), the agent the appointment belongs
 * to, and the person who wrote the note. Everyone else sees `notesMasked`.
 */
export function canReadNotes(
  appt: Pick<Appointment, "createdBy">,
  viewer: { userId: string; role: Role; ownAgentId: string | null; apptAgentId: string | null },
): boolean {
  if (PHI_PRIVILEGED_ROLES.has(viewer.role)) return true;
  if (appt.createdBy && appt.createdBy === viewer.userId) return true;
  if (viewer.ownAgentId && viewer.apptAgentId === viewer.ownAgentId) return true;
  return false;
}

export interface NewAppointmentInput {
  orgId: string;
  title: string;
  type?: AppointmentType;
  status?: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  contactId?: string | null;
  agentId?: string | null;
  notes?: string | null;
  locationType?: AppointmentLocationType;
  locationDetail?: string | null;
  meetingUrl?: string | null;
  createdBy?: string | null;
}

/**
 * Inserts an appointment. Callers are responsible for authorization; this
 * helper only re-checks that the linked contact / agent live in `orgId` so no
 * caller can create a cross-tenant link by accident.
 */
export async function insertAppointment(input: NewAppointmentInput): Promise<Appointment> {
  if (!(input.endsAt.getTime() > input.startsAt.getTime())) {
    throw new AppointmentValidationError("endsAt must be after startsAt");
  }
  if (input.endsAt.getTime() - input.startsAt.getTime() > MAX_APPOINTMENT_MS) {
    throw new AppointmentValidationError("Appointments can be at most 12 hours long");
  }
  if (input.contactId && !(await contactInOrg(input.contactId, input.orgId))) {
    throw new AppointmentValidationError("Contact not found");
  }
  if (input.agentId && !(await agentInOrg(input.agentId, input.orgId))) {
    throw new AppointmentValidationError("Agent not found");
  }
  const [row] = await db
    .insert(appointmentsTable)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      contactId: input.contactId ?? null,
      agentId: input.agentId ?? null,
      type: input.type ?? "consultation",
      title: input.title,
      notesEncrypted: encryptNotes(input.notes),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: input.status ?? "pending",
      locationType: input.locationType ?? "office",
      locationDetail: input.locationDetail ?? null,
      meetingUrl: input.meetingUrl ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row;
}

export class AppointmentValidationError extends Error {
  readonly statusCode = 400;
}
