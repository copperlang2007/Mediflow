import {
  pgTable,
  text,
  boolean,
  timestamp,
  integer,
  pgEnum,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./core";

export const agentStatusEnum = pgEnum("agent_status", [
  "onboarding",
  "active",
  "suspended",
  "offboarding",
  "offboarded",
]);

export const licenseStatusEnum = pgEnum("license_status", [
  "active",
  "pending",
  "expired",
  "suspended",
  "not_appointed",
]);

export const certStatusEnum = pgEnum("cert_status", [
  "not_started",
  "in_progress",
  "passed",
  "failed",
  "waived",
]);

export const techAccountStatusEnum = pgEnum("tech_account_status", [
  "provisioned",
  "pending",
  "deprovisioned",
]);

export const agentsTable = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: text("user_id"),
    npn: text("npn"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    avatarUrl: text("avatar_url"),
    status: agentStatusEnum("status").notNull().default("onboarding"),
    hireDate: timestamp("hire_date", { withTimezone: true }),
    offboardDate: timestamp("offboard_date", { withTimezone: true }),
    managerId: text("manager_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("agents_org_id_idx").on(t.orgId),
    index("agents_org_id_status_idx").on(t.orgId, t.status),
  ],
);

export const insertAgentSchema = createInsertSchema(agentsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agentsTable.$inferSelect;

export const stateLicensesTable = pgTable(
  "state_licenses",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    stateCode: text("state_code").notNull(),
    licenseType: text("license_type").notNull(),
    licenseNumber: text("license_number"),
    issueDate: timestamp("issue_date", { withTimezone: true }),
    expiryDate: timestamp("expiry_date", { withTimezone: true }),
    status: licenseStatusEnum("status").notNull().default("pending"),
    renewalSubmittedAt: timestamp("renewal_submitted_at", {
      withTimezone: true,
    }),
    documentKey: text("document_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("state_licenses_agent_id_idx").on(t.agentId),
    index("state_licenses_agent_id_status_idx").on(t.agentId, t.status),
    index("state_licenses_agent_id_expiry_date_idx").on(
      t.agentId,
      t.expiryDate,
    ),
  ],
);

export const insertStateLicenseSchema = createInsertSchema(
  stateLicensesTable
).omit({ createdAt: true, updatedAt: true });
export type InsertStateLicense = z.infer<typeof insertStateLicenseSchema>;
export type StateLicense = typeof stateLicensesTable.$inferSelect;

export const licenseRenewalAlertsTable = pgTable(
  "license_renewal_alerts",
  {
    id: text("id").primaryKey(),
    licenseId: text("license_id")
      .notNull()
      .references(() => stateLicensesTable.id, { onDelete: "cascade" }),
    alertDaysBefore: integer("alert_days_before").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    notificationId: text("notification_id"),
  },
  (t) => [
    uniqueIndex("license_renewal_alerts_license_threshold_unique").on(t.licenseId, t.alertDaysBefore),
  ],
);

export type LicenseRenewalAlert = typeof licenseRenewalAlertsTable.$inferSelect;

export const renewalSnoozesTable = pgTable("renewal_snoozes", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RenewalSnooze = typeof renewalSnoozesTable.$inferSelect;

export const carriersTable = pgTable("carriers", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  name: text("name").notNull(),
  cmsContractNumber: text("cms_contract_number"),
  logoUrl: text("logo_url"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertCarrierSchema = createInsertSchema(carriersTable).omit({
  createdAt: true,
});
export type InsertCarrier = z.infer<typeof insertCarrierSchema>;
export type Carrier = typeof carriersTable.$inferSelect;

export const carrierCertificationsTable = pgTable(
  "carrier_certifications",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    carrierId: text("carrier_id")
      .notNull()
      .references(() => carriersTable.id),
    certificationYear: integer("certification_year").notNull(),
    status: certStatusEnum("status").notNull().default("not_started"),
    completedDate: timestamp("completed_date", { withTimezone: true }),
    expiryDate: timestamp("expiry_date", { withTimezone: true }),
    score: real("score"),
    documentKey: text("document_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("carrier_certs_agent_id_idx").on(t.agentId),
    uniqueIndex("carrier_certs_agent_carrier_year_unique").on(t.agentId, t.carrierId, t.certificationYear),
  ],
);

export const insertCarrierCertSchema = createInsertSchema(
  carrierCertificationsTable
).omit({ createdAt: true, updatedAt: true });
export type InsertCarrierCert = z.infer<typeof insertCarrierCertSchema>;
export type CarrierCertification =
  typeof carrierCertificationsTable.$inferSelect;

export const ahipRecordsTable = pgTable(
  "ahip_records",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    certificationYear: integer("certification_year").notNull(),
    status: certStatusEnum("status").notNull().default("not_started"),
    score: real("score"),
    completedDate: timestamp("completed_date", { withTimezone: true }),
    documentKey: text("document_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("ahip_records_agent_id_year_unique").on(t.agentId, t.certificationYear),
  ],
);

export const insertAhipRecordSchema = createInsertSchema(ahipRecordsTable).omit(
  { createdAt: true, updatedAt: true }
);
export type InsertAhipRecord = z.infer<typeof insertAhipRecordSchema>;
export type AhipRecord = typeof ahipRecordsTable.$inferSelect;

export const certRenewalAlertsTable = pgTable(
  "cert_renewal_alerts",
  {
    id: text("id").primaryKey(),
    certId: text("cert_id")
      .notNull()
      .references(() => carrierCertificationsTable.id, { onDelete: "cascade" }),
    alertDaysBefore: integer("alert_days_before").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    notificationId: text("notification_id"),
  },
  (t) => [
    uniqueIndex("cert_renewal_alerts_cert_threshold_unique").on(t.certId, t.alertDaysBefore),
  ],
);

export type CertRenewalAlert = typeof certRenewalAlertsTable.$inferSelect;

export const techStackAccountsTable = pgTable("tech_stack_accounts", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agentsTable.id, { onDelete: "cascade" }),
  platformName: text("platform_name").notNull(),
  platformCategory: text("platform_category"),
  status: techAccountStatusEnum("status").notNull().default("pending"),
  accountIdentifier: text("account_identifier"),
  provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
  deprovisionedAt: timestamp("deprovisioned_at", { withTimezone: true }),
  notes: text("notes"),
});

export type TechStackAccount = typeof techStackAccountsTable.$inferSelect;

export const platformRequirementsTable = pgTable("platform_requirements", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizationsTable.id),
  platformName: text("platform_name").notNull(),
  platformCategory: text("platform_category"),
  isRequired: boolean("is_required").notNull().default(true),
  onboardingOrder: integer("onboarding_order").notNull().default(0),
  requiredForRole: text("required_for_role"),
});

export type PlatformRequirement = typeof platformRequirementsTable.$inferSelect;
