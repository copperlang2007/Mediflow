/**
 * User invitations — the only path by which a second person joins an agency.
 *
 * Before this table existed, `POST /auth/provision` created a brand-new
 * organization for every sign-up. A multi-tenant product in which a
 * tenant can only ever contain one user is not multi-tenant in the way that
 * matters commercially, and it is the reason seats could be sold but never
 * filled. An invitation is the missing edge: an existing admin names an email
 * and a role, and the person who accepts lands in *that* org instead of a new
 * empty one.
 *
 * Two things are deliberate about the token:
 *
 *  1. **Only the hash is stored.** `token_hash` is the SHA-256 of a
 *     128-bit random value that exists in plaintext exactly twice — in the
 *     email, and in the response to the admin who created it. A database
 *     read (or a leaked backup) therefore does not yield a usable invitation.
 *
 *  2. **The hash is globally unique, not org-unique.** Acceptance looks an
 *     invitation up by token alone, before any org context exists — the
 *     accepting user has no org yet, which is the whole point. A collision
 *     across orgs would be a cross-tenant admission bug, so the uniqueness
 *     is enforced by the database rather than by the lookup query.
 *
 * A pending invitation holds a seat (see `lib/billing/seats.ts`). That is the
 * difference between an admin on a 5-seat plan learning at invite time that
 * they are out of seats, and five invitees discovering it one by one at accept
 * time, when none of them can do anything about it.
 */
import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { organizationsTable, usersTable, userRoleEnum } from "./core";

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

export const userInvitationsTable = pgTable(
  "user_invitations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    /** Always stored lowercased — the accept path matches case-insensitively. */
    email: text("email").notNull(),
    role: userRoleEnum("role").notNull().default("agent"),
    /** SHA-256 hex of the raw token. The raw token is never persisted. */
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    status: invitationStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** The `users.id` created by accepting this invitation. */
    acceptedUserId: text("accepted_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("user_invitations_token_hash_key").on(t.tokenHash),
    index("user_invitations_org_status_idx").on(t.orgId, t.status),
    // One live invitation per address per org. Partial, so a revoked or
    // expired invitation does not block re-inviting the same person — the
    // common case after a typo or a bounced email.
    uniqueIndex("user_invitations_org_email_pending_key")
      .on(t.orgId, t.email)
      .where(sql`status = 'pending'`),
  ],
);

export const insertUserInvitationSchema = createInsertSchema(
  userInvitationsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertUserInvitation = z.infer<typeof insertUserInvitationSchema>;
export type UserInvitation = typeof userInvitationsTable.$inferSelect;
