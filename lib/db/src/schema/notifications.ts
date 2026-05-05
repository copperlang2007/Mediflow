import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable, usersTable } from "./core";

export const notificationsTable = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    priority: text("priority").notNull().default("normal"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    actionUrl: text("action_url"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("notifications_user_id_idx").on(t.userId),
    index("notifications_user_id_read_at_idx").on(t.userId, t.readAt),
  ],
);

export const insertNotificationSchema = createInsertSchema(
  notificationsTable
).omit({ createdAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notificationsTable.$inferSelect;
