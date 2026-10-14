import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { getAuth } from "../lib/auth/identity";
import { linkNewUser, resolveUserId } from "../lib/auth/users";
import { db, usersTable, organizationsTable, userInvitationsTable } from "@workspace/db";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";
import { seedDefaultCarriers } from "../lib/carrierSeed";
import { isDemoMode, demoUserId } from "../lib/demoMode";
import { mfaEnforced } from "../middlewares/requireMfa";
import { getOrgSessionTimeout } from "../middlewares/requireAuth";

// The email is not taken from the request: it is the verified email on the
// sign-in token. A client-sent `email` field is ignored.
const ProvisionSchema = z.object({
  fullName: z.string().min(1).max(100),
  orgName: z.string().min(1).max(100).optional(),
  orgSlug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
});

const router: IRouter = Router();

/**
 * GET /auth/status
 *
 * Reports whether the signed-in user has an agencyBRIDGE account yet. The web
 * app calls this immediately after sign-in to decide between the app shell,
 * the verify-your-email step and the create-your-agency screen. Deliberately
 * NOT behind `requireAuth` — an unprovisioned user is precisely the case this
 * endpoint exists to describe, and `requireAuth` rejects them.
 */
router.get("/auth/status", async (req: Request, res: Response): Promise<void> => {
  // Demo mode (a hard no-op under NODE_ENV=production, see lib/demoMode):
  // every demo request is the seeded demo user, exactly as requireAuth resolves it.
  const auth = isDemoMode() ? null : getAuth(req);
  if (!isDemoMode() && !auth?.subject) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const userId = isDemoMode() ? demoUserId() : await resolveUserId(auth!);
  const [user] = userId
    ? await db
        .select({
          id: usersTable.id,
          orgId: usersTable.orgId,
          role: usersTable.role,
          isActive: usersTable.isActive,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1)
    : [];

  if (!user) {
    // emailVerified: an account is only created (or an earlier one linked)
    // once Identity Platform has verified the email, so the web app asks the
    // user to click the link in their inbox first.
    res.json({ provisioned: false, active: false, emailVerified: auth?.emailVerified === true });
    return;
  }

  res.json({
    provisioned: true,
    active: user.isActive,
    orgId: user.orgId,
    role: user.role,
    emailVerified: isDemoMode() || auth?.emailVerified === true,
    // Every authenticated route answers 403 mfa_required until the user has
    // a second factor; the web app shows the enrollment screen instead.
    mfaRequired: mfaEnforced(),
    // The browser signs the user out after this many idle minutes.
    sessionTimeoutMinutes: await getOrgSessionTimeout(user.orgId),
    mfaEnrolled: isDemoMode() || auth?.mfa === true,
  });
});

router.post("/auth/provision", async (req: Request, res: Response): Promise<void> => {
  const auth = getAuth(req);
  if (!auth.subject) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const subject = auth.subject;

  const existingId = await resolveUserId(auth);
  const existing = existingId ? await db.select().from(usersTable).where(eq(usersTable.id, existingId)).limit(1) : [];

  if (existing[0]) {
    await db
      .update(usersTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(usersTable.id, existing[0].id));
    res.json({ user: existing[0], isNew: false });
    return;
  }

  if (!auth.emailVerified || !auth.email) {
    res.status(403).json({
      error: "Verify your email address first: open the link we sent you, then try again.",
      code: "EMAIL_NOT_VERIFIED",
    });
    return;
  }
  const email = auth.email;

  const bodyParsed = ProvisionSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid request body", details: bodyParsed.error.issues });
    return;
  }

  const { fullName, orgName, orgSlug } = bodyParsed.data;

  // Someone who was invited must join the org that invited them, not create a
  // second empty one. Without this check the invitation flow silently loses:
  // the invitee signs up normally, lands in a fresh org of their own, and the
  // pending invitation sits unused while the admin sees a seat consumed and no
  // colleague. The client is expected to route to the accept screen on 409.
  const [pendingInvite] = await db
    .select({ id: userInvitationsTable.id })
    .from(userInvitationsTable)
    .where(
      and(
        sql`lower(${userInvitationsTable.email}) = ${email.trim().toLowerCase()}`,
        eq(userInvitationsTable.status, "pending"),
        gt(userInvitationsTable.expiresAt, sql`now()`),
      ),
    )
    .limit(1);

  if (pendingInvite) {
    res.status(409).json({
      error:
        "You have a pending invitation to an existing agency. Use the link in your invitation email to join it.",
      code: "invitation_pending",
    });
    return;
  }

  const orgId = randomUUID();
  const slug = orgSlug ?? orgName?.toLowerCase().replace(/[^a-z0-9]/g, "-") ?? orgId;

  const { org, user } = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizationsTable)
      .values({
        id: orgId,
        name: orgName ?? `${fullName}'s Agency`,
        slug: `${slug}-${orgId.slice(0, 8)}`,
        planTier: "starter",
      })
      .returning();

    // A new user's id is its sign-in identity's subject.
    const [user] = await tx
      .insert(usersTable)
      .values({
        id: subject,
        orgId: org.id,
        email,
        fullName,
        role: "agency_admin",
        isActive: true,
        lastLoginAt: new Date(),
      })
      .returning();
    await linkNewUser(tx, subject, user.id, "provision");
    return { org, user };
  });

  // Seed the default Medicare carriers so the Carrier Certification Matrix
  // works out of the box. Failures here shouldn't block provisioning — admins
  // can re-run via POST /carriers/seed.
  try {
    const seeded = await seedDefaultCarriers(org.id);
    logger.info({ orgId: org.id, seeded }, "Seeded default carriers for new org");
  } catch (err) {
    logger.error({ err, orgId: org.id }, "Failed to seed default carriers");
  }

  logger.info({ userId: user.id, orgId: org.id }, "New user provisioned");

  res.status(201).json({ user, org, isNew: true });
});

export default router;
