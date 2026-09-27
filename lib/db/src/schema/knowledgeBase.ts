/**
 * Knowledge Base — short reference articles an agency writes for its staff
 * (plan rules, carrier quirks, internal how-tos). Migration 0050.
 *
 * Articles are org-scoped and must never hold client data (PHI). Active
 * articles that match a question are passed to the AI assistant as clearly
 * delimited reference material (see api-server `lib/kbContext.ts`).
 */
import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable, usersTable } from "./core";

export const kbArticlesTable = pgTable(
  "kb_articles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    keywords: text("keywords")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isActive: boolean("is_active").notNull().default(true),
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
  (t) => [index("kb_articles_org_active_idx").on(t.orgId, t.isActive)],
);

export type KbArticle = typeof kbArticlesTable.$inferSelect;
