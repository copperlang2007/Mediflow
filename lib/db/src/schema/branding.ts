/**
 * Per-agency white-label branding (stage2/calendar-branding).
 *
 * One optional row per organization. No row (or a NULL column) means "use the
 * agencyBRIDGE default" for that attribute — the web app's BrandingProvider
 * falls back field by field, so an agency can change only its accent colour
 * and keep everything else.
 *
 * `logo_url` stays on `organizations` (it predates this table and other
 * screens read it); the mark and favicon live here. Colours are validated
 * `#rrggbb` hex and fonts come from a fixed allowlist — both enforced in the
 * route (routes/branding.ts), because both are injected into CSS at runtime.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable, usersTable } from "./core";

export const orgBrandingTable = pgTable("org_branding", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  productName: text("product_name"),
  tagline: text("tagline"),
  primaryColor: text("primary_color"),
  accentColor: text("accent_color"),
  displayFont: text("display_font"),
  bodyFont: text("body_font"),
  markUrl: text("mark_url"),
  faviconUrl: text("favicon_url"),
  emailFromName: text("email_from_name"),
  updatedBy: text("updated_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type OrgBranding = typeof orgBrandingTable.$inferSelect;
