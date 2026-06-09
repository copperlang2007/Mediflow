/**
 * Marketing-material approval workflow.
 *
 * CMS rules require Medicare Advantage / Part D agencies to use only marketing
 * materials that have been reviewed and, where applicable, filed/approved
 * (CMS marketing review, the "HPMS material ID" world). An agency therefore
 * needs a system of record: agents/staff submit a piece of marketing, a
 * compliance reviewer approves / rejects / requests changes, and approved
 * pieces carry an effective window (and optional CMS material ID) so the
 * agency can prove — on audit — that everything in use was approved and still
 * current.
 *
 * Each `marketing_materials` row is one such piece moving through review:
 *
 *   - **Classify** — `material_type` (flyer, email, social post, mailer, TV,
 *     radio, web, business card, presentation, script, …).
 *   - **Workflow** — `status` moves submitted → in_review →
 *     approved | rejected | changes_requested, and an approved piece can later
 *     be `retired`. `review_notes` + `reviewed_by_user_id` + `reviewed_at`
 *     capture the decision for the audit trail.
 *   - **Proof** — `cms_material_id` (the filed/approved id, when applicable),
 *     `effective_date` / `expires_at` (the window the piece may be used), and
 *     `file_url` (link to the asset in storage).
 *
 * No PHI lives here — these are marketing assets, not beneficiary records.
 */
import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable, usersTable } from "./core";

/** Kind of marketing piece. */
export const marketingMaterialTypeEnum = pgEnum("marketing_material_type", [
  "flyer",
  "social_post",
  "email",
  "mailer",
  "tv",
  "radio",
  "web",
  "business_card",
  "presentation",
  "script",
  "other",
]);

/** Review workflow state. */
export const marketingMaterialStatusEnum = pgEnum("marketing_material_status", [
  "draft",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "changes_requested",
  "retired",
]);

export const marketingMaterialsTable = pgTable(
  "marketing_materials",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    title: text("title").notNull(),
    materialType: marketingMaterialTypeEnum("material_type")
      .notNull()
      .default("other"),
    status: marketingMaterialStatusEnum("status").notNull().default("submitted"),
    description: text("description"),
    // Link to the asset in storage (not the bytes).
    fileUrl: text("file_url"),
    // The carrier / product the piece markets, if specific.
    carrierName: text("carrier_name"),
    // CMS / HPMS filed-or-approved material id, when applicable.
    cmsMaterialId: text("cms_material_id"),
    // Window the approved piece may be used.
    effectiveDate: timestamp("effective_date", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Submission + review trail. SET NULL on user delete to preserve history.
    submittedByUserId: text("submitted_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedByUserId: text("reviewed_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Worked-list: an org's materials by status, newest first (the index
    // covers the status filter; ordering by created_at is a cheap sort).
    index("marketing_materials_org_status_idx").on(t.orgId, t.status),
    // Expiry sweep / "expiring soon" surfacing for approved pieces.
    index("marketing_materials_org_expires_idx").on(t.orgId, t.expiresAt),
  ],
);

export const insertMarketingMaterialSchema = createInsertSchema(
  marketingMaterialsTable,
);
export type InsertMarketingMaterial = z.infer<
  typeof insertMarketingMaterialSchema
>;
export type MarketingMaterial = typeof marketingMaterialsTable.$inferSelect;
