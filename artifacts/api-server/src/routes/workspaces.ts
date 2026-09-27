/**
 * Workspaces — platform-owner agency provisioning (stage2/calendar-branding).
 *
 *   GET  /admin/agencies/overview  — every agency with live member/agent/client counts
 *   POST /admin/agencies           — create an agency and invite its first admin
 *
 * super_admin only, MFA-gated like the existing GET /admin/agencies.
 *
 * There are no temporary passwords: sign-in is Clerk. A new agency is created
 * empty and its first administrator is invited through the normal invitation
 * flow (routes/invitations.ts) — the same hashed single-use token, the same
 * seat accounting, the same accept screen. The super_admin who provisions the
 * agency does NOT become a member of it.
 *
 * Both handlers are cross-tenant by design — listing and creating tenants is
 * the whole job — and are restricted to the platform-owner role for that
 * reason.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  db,
  agentsTable,
  auditLogTable,
  contactsTable,
  organizationsTable,
  userInvitationsTable,
  usersTable,
  subscriptionsTable,
} from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { requireMfa } from "../middlewares/requireMfa";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { lockOrgSeats, requireSeat } from "../lib/billing/seats";
import { PlanLimitError, deriveEntitlements, planLimitResponse } from "../lib/billing/entitlements";
import { isEmailConfigured } from "../lib/email";
import {
  AppBaseUrlUnconfiguredError,
  INVITE_TTL_DAYS,
  acceptUrlFor,
  appBaseUrl,
  deliver,
  isUniqueViolation,
  newToken,
  serialize as serializeInvitation,
} from "./invitations";

const router: IRouter = Router();

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

const CreateAgencySchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_RE, "Use 3-48 lowercase letters, digits and hyphens"),
  adminEmail: z.string().trim().toLowerCase().email().max(255),
});

router.get(
  "/admin/agencies/overview",
  requireAuth,
  requireMfa,
  requireRole("super_admin"),
  // tenant-isolation-exempt: platform-owner view across every tenant, super_admin only.
  async (_req: Request, res: Response): Promise<void> => {
    const [orgs, users, agents, contacts, invites, subs] = await Promise.all([
      db
        .select({
          id: organizationsTable.id,
          name: organizationsTable.name,
          slug: organizationsTable.slug,
          planTier: organizationsTable.planTier,
          createdAt: organizationsTable.createdAt,
        })
        .from(organizationsTable)
        .orderBy(asc(organizationsTable.name)),
      db
        .select({ orgId: usersTable.orgId, n: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(eq(usersTable.isActive, true))
        .groupBy(usersTable.orgId),
      db
        .select({ orgId: agentsTable.orgId, n: sql<number>`count(*)::int` })
        .from(agentsTable)
        .groupBy(agentsTable.orgId),
      db
        .select({ orgId: contactsTable.orgId, n: sql<number>`count(*)::int` })
        .from(contactsTable)
        .where(isNull(contactsTable.deletedAt))
        .groupBy(contactsTable.orgId),
      db
        .select({ orgId: userInvitationsTable.orgId, n: sql<number>`count(*)::int` })
        .from(userInvitationsTable)
        .where(
          and(
            eq(userInvitationsTable.status, "pending"),
            sql`${userInvitationsTable.expiresAt} > now()`,
          ),
        )
        .groupBy(userInvitationsTable.orgId),
      db.select().from(subscriptionsTable),
    ]);
    // Effective plan = what entitlements enforce (same as /billing and
    // /organizations/me), not the legacy organizations.plan_tier column.
    const subByOrg = new Map(subs.map((s) => [s.orgId, s]));
    const byOrg = (rows: Array<{ orgId: string; n: number }>) =>
      new Map(rows.map((r) => [r.orgId, Number(r.n)]));
    const u = byOrg(users);
    const a = byOrg(agents);
    const c = byOrg(contacts);
    const i = byOrg(invites);
    res.json({
      agencies: orgs.map((o) => ({
        ...o,
        planTier: deriveEntitlements(o.id, subByOrg.get(o.id) ?? null).tier,
        users: u.get(o.id) ?? 0,
        agents: a.get(o.id) ?? 0,
        clients: c.get(o.id) ?? 0,
        pendingInvitations: i.get(o.id) ?? 0,
      })),
    });
  },
);

class SlugTakenError extends Error {}
class EmailTakenError extends Error {}

router.post(
  "/admin/agencies",
  requireAuth,
  requireMfa,
  requireRole("super_admin"),
  auditMiddleware("org", "create", {
    getResourceId: (req) => (req.res?.locals.createdOrgId as string | undefined) ?? null,
  }),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const parsed = CreateAgencySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const { name, slug, adminEmail } = parsed.data;

    // An agency whose first admin can't get a working link would be stranded.
    try {
      appBaseUrl();
    } catch (err) {
      if (err instanceof AppBaseUrlUnconfiguredError) {
        res.status(503).json({
          error:
            "This deployment is not configured to send invitations. Set APP_BASE_URL and try again.",
          code: "app_base_url_unconfigured",
        });
        return;
      }
      throw err;
    }

    const orgId = randomUUID();
    const { raw, hash } = newToken();

    let result: {
      org: typeof organizationsTable.$inferSelect;
      invitation: typeof userInvitationsTable.$inferSelect;
    };
    try {
      result = await db.transaction(async (tx) => {
        const [slugRow] = await tx
          .select({ id: organizationsTable.id })
          .from(organizationsTable)
          .where(eq(organizationsTable.slug, slug))
          .limit(1);
        if (slugRow) throw new SlugTakenError();

        // A Clerk identity belongs to exactly one agency; accepting would fail
        // later with `already_provisioned`. Say so now, to the operator.
        const [emailRow] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(sql`lower(${usersTable.email}) = ${adminEmail}`)
          .limit(1);
        if (emailRow) throw new EmailTakenError();

        const [org] = await tx
          .insert(organizationsTable)
          .values({ id: orgId, name, slug })
          .returning();

        await lockOrgSeats(orgId, tx);
        await requireSeat(orgId, tx);

        const [invitation] = await tx
          .insert(userInvitationsTable)
          .values({
            id: randomUUID(),
            orgId,
            email: adminEmail,
            role: "agency_admin",
            tokenHash: hash,
            invitedByUserId: authReq.userId,
            status: "pending",
            expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
          })
          .returning();

        // The new tenant's own audit trail starts with who created it.
        await tx.insert(auditLogTable).values({
          id: randomUUID(),
          orgId,
          userId: authReq.userId,
          userRole: authReq.userRole,
          action: "create",
          resourceType: "org",
          resourceId: orgId,
          ipAddress: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          changes: {
            provisionedBy: authReq.userId,
            provisionedFromOrgId: authReq.realOrgId ?? authReq.orgId,
            slug,
            firstAdminInvitationId: invitation.id,
          },
        });

        return { org, invitation };
      });
    } catch (err) {
      if (err instanceof SlugTakenError || (isUniqueViolation(err) && /slug/.test(String(err)))) {
        res.status(409).json({ error: "That slug is already taken.", code: "slug_taken" });
        return;
      }
      if (err instanceof EmailTakenError) {
        res.status(409).json({
          error: "That address already belongs to an agency member. Use a different address.",
          code: "email_taken",
        });
        return;
      }
      if (err instanceof PlanLimitError) {
        res.status(err.statusCode).json(planLimitResponse(err));
        return;
      }
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "That slug is already taken.", code: "slug_taken" });
        return;
      }
      throw err;
    }

    res.locals.createdOrgId = result.org.id;
    await deliver(result.invitation, authReq, raw);

    res.status(201).json({
      agency: {
        id: result.org.id,
        name: result.org.name,
        slug: result.org.slug,
        planTier: result.org.planTier,
        createdAt: result.org.createdAt,
      },
      invitation: serializeInvitation(result.invitation),
      // Returned once so the operator can hand the link over when email is
      // not configured. Never stored in plaintext.
      acceptUrl: acceptUrlFor(raw),
      emailSent: isEmailConfigured(),
    });
  },
);

export default router;
