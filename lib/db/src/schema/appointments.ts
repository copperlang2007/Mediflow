/**
 * Appointments — the calendar behind /calendar (stage2/calendar-branding).
 *
 * One row per booked meeting between an agent and (optionally) a contact.
 * Org-scoped like every other tenant table. The free-text `notes` field can
 * carry health details an agent jots down ("wants to keep Dr. Patel"), so it
 * is stored ONLY as AES-256-GCM ciphertext via the shared PII helpers
 * (`encryptPii` / `decryptPii`) — there is no plaintext notes column. The
 * `title` is shown on the calendar grid to everyone who can read the calendar
 * and the UI tells users to keep it free of health information.
 *
 * `reminder_sent_at` is the idempotency claim for the reminder sweep
 * (workers/appointmentReminders.ts): the worker sets it with a conditional
 * UPDATE … WHERE reminder_sent_at IS NULL, so two overlapping sweeps can never
 * both text the same client.
 */
import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { organizationsTable, usersTable } from "./core";
import { agentsTable } from "./agents";
import { contactsTable } from "./crm";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const APPOINTMENT_TYPES = [
  "enrollment",
  "review",
  "renewal",
  "consultation",
  "other",
] as const;
export const APPOINTMENT_STATUSES = [
  "confirmed",
  "pending",
  "completed",
  "cancelled",
  "no_show",
] as const;
export const APPOINTMENT_LOCATION_TYPES = [
  "office",
  "phone",
  "video",
  "home",
] as const;

export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export type AppointmentLocationType = (typeof APPOINTMENT_LOCATION_TYPES)[number];

export const appointmentTypeEnum = pgEnum("appointment_type", APPOINTMENT_TYPES);
export const appointmentStatusEnum = pgEnum("appointment_status", APPOINTMENT_STATUSES);
export const appointmentLocationTypeEnum = pgEnum(
  "appointment_location_type",
  APPOINTMENT_LOCATION_TYPES,
);

export const appointmentsTable = pgTable(
  "appointments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    // Deleting a contact (retention purge) takes their appointments with it.
    contactId: text("contact_id").references(() => contactsTable.id, {
      onDelete: "cascade",
    }),
    agentId: text("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    type: appointmentTypeEnum("type").notNull().default("consultation"),
    title: text("title").notNull(),
    /** AES-256-GCM ciphertext of the free-text notes (may hold PHI). */
    notesEncrypted: bytea("notes_encrypted"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: appointmentStatusEnum("status").notNull().default("pending"),
    locationType: appointmentLocationTypeEnum("location_type")
      .notNull()
      .default("office"),
    locationDetail: text("location_detail"),
    meetingUrl: text("meeting_url"),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("appointments_org_starts_idx").on(t.orgId, t.startsAt),
    index("appointments_agent_starts_idx").on(t.agentId, t.startsAt),
  ],
);

export type Appointment = typeof appointmentsTable.$inferSelect;
export type InsertAppointment = typeof appointmentsTable.$inferInsert;
