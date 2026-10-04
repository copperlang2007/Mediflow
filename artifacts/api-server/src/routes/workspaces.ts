/**
 * Workspaces — platform-owner agency provisioning (stage2/calendar-branding).
 *
 *   GET  /admin/agencies/overview  — every agency with live member/agent/client counts
 *   GET  /admin/platform/metrics   — revenue, commissions and 12-month growth across every agency
 *   POST /admin/agencies           — create an agency and invite its first admin
 *
 * super_admin only, MFA-gated like the existing GET /admin/agencies.
 *
 * Sign-in is handled by Clerk, so nothing like a temporary login is issued. A new agency is created
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
  commissionLineItemsTable,
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
import { PLANS, isPlanTier } from "../lib/billing/plans";
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

/** First day of each of the last 12 months (UTC), oldest first, as "YYYY-MM". */
export function lastTwelveMonths(now: Date = new Date()): string[] {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

const toCents = (amount: string | number | null | undefined): number =>
  Math.round(Number(amount ?? 0) * 100);

router.get(
  "/admin/platform/metrics",
  requireAuth,
  requireMfa,
  requireRole("super_admin"),
  // tenant-isolation-exempt: platform-owner rollup across every tenant, super_admin only.
  async (_req: Request, res: Response): Promise<void> => {
    const months = lastTwelveMonths();
    const windowStart = `${months[0]}-01`;
    const monthOf = (col: ReturnType<typeof sql>) => sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM')`;
    // A line item's month is its statement period, falling back to when it was recorded.
    const commissionMonth = sql<string>`to_char(coalesce(${commissionLineItemsTable.periodStart}::timestamp, ${commissionLineItemsTable.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM')`;

    const [subs, orgGrowth, clientGrowth, orgBase, clientBase, commissionTotals, commissionByMonth] =
      await Promise.all([
        db.select().from(subscriptionsTable),
        db
          .select({ month: monthOf(sql`${organizationsTable.createdAt}`), n: sql<number>`count(*)::int` })
          .from(organizationsTable)
          .where(sql`${organizationsTable.createdAt} >= ${windowStart}::timestamptz`)
          .groupBy(sql`1`),
        db
          .select({ month: monthOf(sql`${contactsTable.createdAt}`), n: sql<number>`count(*)::int` })
          .from(contactsTable)
          .where(and(isNull(contactsTable.deletedAt), sql`${contactsTable.createdAt} >= ${windowStart}::timestamptz`))
          .groupBy(sql`1`),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(organizationsTable)
          .where(sql`${organizationsTable.createdAt} < ${windowStart}::timestamptz`),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(contactsTable)
          .where(and(isNull(contactsTable.deletedAt), sql`${contactsTable.createdAt} < ${windowStart}::timestamptz`)),
        db
          .select({
            orgId: commissionLineItemsTable.orgId,
            allTime: sql<string>`coalesce(sum(${commissionLineItemsTable.commissionAmount}), 0)::text`,
            last12: sql<string>`coalesce(sum(${commissionLineItemsTable.commissionAmount}) filter (where ${commissionMonth} >= ${months[0]}), 0)::text`,
          })
          .from(commissionLineItemsTable)
          // Nothing dated after the current month counts as earned yet (a
          // mistyped or far-future period must not inflate any total).
          .where(sql`${commissionMonth} <= ${months[11]}`)
          .groupBy(commissionLineItemsTable.orgId),
        db
          .select({
            month: commissionMonth,
            amount: sql<string>`coalesce(sum(${commissionLineItemsTable.commissionAmount}), 0)::text`,
          })
          .from(commissionLineItemsTable)
          .groupBy(sql`1`),
      ]);

    // Revenue: list price of each ACTIVE paid subscription. Stripe is the
    // system of record, so this is an estimate (no seat overage, discounts or
    // proration); it is labelled that way for the reader via `basis`.
    const priceOf = (tier: string): number => (isPlanTier(tier) ? PLANS[tier].monthlyPriceCents : 0);
    const byPlan = new Map<string, { agencies: number; mrrCents: number }>();
    let mrrCents = 0;
    let atRiskCents = 0;
    let payingAgencies = 0;
    let trialingAgencies = 0;
    let pastDueAgencies = 0;
    const perOrg = new Map<string, { status: string; planTier: string; mrrCents: number }>();
    for (const sub of subs) {
      const price = priceOf(sub.planTier);
      const counted = sub.status === "active" && price > 0;
      perOrg.set(sub.orgId, { status: sub.status, planTier: sub.planTier, mrrCents: counted ? price : 0 });
      if (counted) {
        payingAgencies += 1;
        mrrCents += price;
        const row = byPlan.get(sub.planTier) ?? { agencies: 0, mrrCents: 0 };
        row.agencies += 1;
        row.mrrCents += price;
        byPlan.set(sub.planTier, row);
      }
      if (sub.status === "trialing") trialingAgencies += 1;
      if (sub.status === "past_due") {
        pastDueAgencies += 1;
        atRiskCents += price;
      }
    }

    const commissionsByOrg = new Map(
      commissionTotals.map((r) => [r.orgId, { allTimeCents: toCents(r.allTime), last12Cents: toCents(r.last12) }]),
    );
    const commissionMonthCents = new Map(commissionByMonth.map((r) => [r.month, toCents(r.amount)]));
    const orgByMonth = new Map(orgGrowth.map((r) => [r.month, Number(r.n)]));
    const clientByMonth = new Map(clientGrowth.map((r) => [r.month, Number(r.n)]));

    let totalAgencies = Number(orgBase[0]?.n ?? 0);
    let totalClients = Number(clientBase[0]?.n ?? 0);
    const growth = months.map((month) => {
      const newAgencies = orgByMonth.get(month) ?? 0;
      const newClients = clientByMonth.get(month) ?? 0;
      totalAgencies += newAgencies;
      totalClients += newClients;
      return {
        month,
        newAgencies,
        totalAgencies,
        newClients,
        totalClients,
        commissionsCents: commissionMonthCents.get(month) ?? 0,
      };
    });

    const allOrgIds = new Set<string>([...perOrg.keys(), ...commissionsByOrg.keys()]);
    res.json({
      generatedAt: new Date().toISOString(),
      months,
      revenue: {
        basis: "list_price",
        mrrCents,
        arrCents: mrrCents * 12,
        payingAgencies,
        trialingAgencies,
        pastDueAgencies,
        atRiskCents,
        byPlan: [...byPlan.entries()]
          .map(([tier, v]) => ({ tier, ...v }))
          .sort((a, b) => b.mrrCents - a.mrrCents),
      },
      commissions: {
        allTimeCents: [...commissionsByOrg.values()].reduce((s, v) => s + v.allTimeCents, 0),
        last12MonthsCents: [...commissionsByOrg.values()].reduce((s, v) => s + v.last12Cents, 0),
      },
      growth,
      agencies: [...allOrgIds].map((orgId) => ({
        orgId,
        subscriptionStatus: perOrg.get(orgId)?.status ?? "none",
        planTier: perOrg.get(orgId)?.planTier ?? null,
        mrrCents: perOrg.get(orgId)?.mrrCents ?? 0,
        commissionsLast12MonthsCents: commissionsByOrg.get(orgId)?.last12Cents ?? 0,
        commissionsAllTimeCents: commissionsByOrg.get(orgId)?.allTimeCents ?? 0,
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
