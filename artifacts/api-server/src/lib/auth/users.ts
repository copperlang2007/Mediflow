/**
 * Which agencyBRIDGE user a verified sign-in is (ADR 0006, step 4).
 *
 *   1. A recorded link in `user_identities` (provider, subject) → users.id.
 *   2. A user whose id is the subject itself: everyone provisioned since the
 *      move to Identity Platform (create-your-agency, invitation accept).
 *   3. One-time migration of an account created under Clerk: when the token
 *      carries an email Identity Platform has VERIFIED (the person proved they
 *      read that inbox) and exactly one Clerk-era user (id `user_…`) with no
 *      link yet has that email, the link is recorded and used from then on.
 *      Never on an unverified email, never when two users share the email,
 *      and never onto an account that is already linked, so a sign-in cannot
 *      be attached to someone else's account or to a second agency.
 *
 * Returns null when the identity has no agencyBRIDGE account yet (the web app
 * then offers create-your-agency, or the invitation it came from).
 */
<<<<<<< HEAD
import { and, eq, isNull, sql } from "drizzle-orm";
=======
import { and, eq, isNull, like, sql } from "drizzle-orm";
>>>>>>> origin/main
import { db, userIdentitiesTable, usersTable } from "@workspace/db";
import { logger } from "../logger";
import { IDENTITY_PROVIDER, type IdentityAuth } from "./identity";

/** Users created under Clerk carry Clerk's id format. */
const CLERK_ID_PREFIX = "user_";

export async function resolveUserId(auth: IdentityAuth): Promise<string | null> {
  const subject = auth.subject;
  if (!subject) return null;

  const [linked] = await db
    .select({ userId: userIdentitiesTable.userId })
    .from(userIdentitiesTable)
    .where(and(eq(userIdentitiesTable.provider, IDENTITY_PROVIDER), eq(userIdentitiesTable.subject, subject)))
    .limit(1);
  if (linked) return linked.userId;

  const [own] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, subject)).limit(1);
  if (own) return own.id;

  if (!auth.emailVerified || !auth.email) return null;
  const candidates = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .leftJoin(
      userIdentitiesTable,
      and(eq(userIdentitiesTable.userId, usersTable.id), eq(userIdentitiesTable.provider, IDENTITY_PROVIDER)),
    )
    .where(
      and(
        sql`lower(${usersTable.email}) = ${auth.email}`,
<<<<<<< HEAD
        // Literal prefix: in LIKE, `_` would match any character.
        sql`starts_with(${usersTable.id}, ${CLERK_ID_PREFIX})`,
=======
        like(usersTable.id, `${CLERK_ID_PREFIX}%`),
>>>>>>> origin/main
        isNull(userIdentitiesTable.userId),
      ),
    )
    .limit(2);
  if (candidates.length !== 1) {
    if (candidates.length > 1) logger.warn({ subject }, "Sign-in email matches more than one earlier account; not linked");
    return null;
  }
  const userId = candidates[0]!.id;
  // Both keys are unique: a concurrent link of the same identity or the same
  // user loses here, and the winner's link is read back below.
  await db
    .insert(userIdentitiesTable)
    .values({ provider: IDENTITY_PROVIDER, subject, userId, linkedVia: "verified_email" })
    .onConflictDoNothing();
  const [after] = await db
    .select({ userId: userIdentitiesTable.userId })
    .from(userIdentitiesTable)
    .where(and(eq(userIdentitiesTable.provider, IDENTITY_PROVIDER), eq(userIdentitiesTable.subject, subject)))
    .limit(1);
  if (after) logger.info({ userId: after.userId }, "Earlier account linked to its new sign-in");
  return after?.userId ?? null;
}

/** Record that a newly provisioned user signs in with this identity (its id is the subject). */
export async function linkNewUser(tx: Pick<typeof db, "insert">, subject: string, userId: string, via: string): Promise<void> {
  await tx.insert(userIdentitiesTable).values({ provider: IDENTITY_PROVIDER, subject, userId, linkedVia: via }).onConflictDoNothing();
}
