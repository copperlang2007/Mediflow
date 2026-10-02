/**
 * Knowledge Base — short reference articles an agency writes for its staff
 * (plan rules, carrier quirks, internal how-tos). Migration 0053.
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
  uniqueIndex,
  primaryKey,
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

/**
 * Knowledge Base library (migration 0065) — articles shared by the whole
 * platform, not owned by any agency. Each agency decides which ones to use
 * through `kb_library_choices`; with no choice the article's
 * `defaultEnabled` applies. `needsReview` marks notes whose figures or rules
 * may be out of date (they default to off).
 */
export const kbLibraryArticlesTable = pgTable(
  "kb_library_articles",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    keywords: text("keywords")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    kind: text("kind", { enum: ["mediflow_guide", "medicare_reference"] }).notNull(),
    defaultEnabled: boolean("default_enabled").notNull().default(true),
    needsReview: boolean("needs_review").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("kb_library_articles_key_idx").on(t.key)],
);

export const kbLibraryChoicesTable = pgTable(
  "kb_library_choices",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    articleId: text("article_id")
      .notNull()
      .references(() => kbLibraryArticlesTable.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    updatedBy: text("updated_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "kb_library_choices_pk", columns: [t.orgId, t.articleId] })],
);

export type KbLibraryArticle = typeof kbLibraryArticlesTable.$inferSelect;
