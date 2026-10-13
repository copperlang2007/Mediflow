/**
 * Team invitations — seat management for an agency.
 *
 * This is the path by which an organization gains a second member. See
 * `lib/db/src/schema/invitations.ts` for why it did not exist before, and
 * `lib/billing/seats.ts` for what a seat counts.
 *
 * Two endpoints here are intentionally not org-scoped, because the caller has
 * no org yet — that is the entire point of accepting an invitation. Both
 * resolve the org *from the token hash*, never from client input.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { getAuth } from "@clerk/express";
import {
  db,
  userInvitationsTable,
  usersTable,
  organizationsTable,
} from "@workspace/db";

import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";
import {
  getSeatUsage,
  requireSeat,
  lockOrgSeats,
} from "../lib/billing/seats";
import {
  PlanLimitError,
  planLimitResponse,
  invalidateEntitlements,
} from "../lib/billing/entitlements";
import { sendEmail, invitationEmailHtml, isEmailConfigured } from "../lib/email";
import { logger } from "../lib/logger";

/** How long an invitation stays acceptable. */
export const INVITE_TTL_DAYS = 7;

/**
 * Roles an admin may hand out. `super_admin` is excluded deliberately: an
 * invitation is a link in an inbox, and a link should not be able to mint the
 * role that can grant every other role. Promote after acceptance instead,
 * through `PATCH /users/:id/role`, which already gates super_admin behind an
 * existing super_admin.
 */
const INVITABLE_ROLES = [
  "agency_admin",
  "compliance_manager",
  "agent_support",
  "viewer",
  "agent",
] as const;

const ROLE_LABELS: Record<(typeof INVITABLE_ROLES)[number], string> = {
  agency_admin: "Agency Admin",
  compliance_manager: "Compliance Manager",
  agent_support: "Agent Support",
  viewer: "Viewer",
  agent: "Agent",
};

const CreateInvitationSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(INVITABLE_ROLES).default("agent"),
});

const AcceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  fullName: z.string().min(1).max(100),
});

/** Hex SHA-256 of the raw token. Only this is ever persisted. */
function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

/**
 * Thrown when the deployment cannot build a usable invitation link.
 *
 * `APP_BASE_URL` falls back to the Vite dev server for local work. In
 * production that fallback is worse than an error: the invitation would be
 * created, the email sent, and the link would point at the recipient's own
 * machine. The feature would look like it worked and silently fail for every
 * invitee. Refusing to create the invitation at all is the honest failure.
 */
export class AppBaseUrlUnconfiguredError extends Error {
  readonly statusCode = 503;
  constructor() {
    super("APP_BASE_URL is not set");
  }
}

export function appBaseUrl(): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new AppBaseUrlUnconfiguredError();
  }
  return "http://localhost:5173";
}

export function acceptUrlFor(token: string): string {
  return `${appBaseUrl()}/accept-invite?token=${encodeURIComponent(token)}`;
}

/** Shared 503 for a deployment that cannot produce a working invite link. */
function baseUrlUnconfigured(res: Response): void {
  logger.error(
    "APP_BASE_URL is not set — refusing to issue an invitation whose link would be unusable",
  );
  res.status(503).json({
    error:
      "This deployment is not configured to send invitations. Set APP_BASE_URL and try again.",
    code: "app_base_url_unconfigured",
  });
}

/** Public shape — never leaks `tokenHash`. */
export function serialize(row: typeof userInvitationsTable.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    invitedByUserId: row.invitedByUserId,
    createdAt: row.createdAt,
  };
}

const router: IRouter = Router();

router.use(
  routerAuditMiddleware(router, "invitation", undefined, {
    includeReads: false,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

/**
 * GET /invitations — the org's invitations plus current seat usage.
 *
 * Seat usage rides along because the two are read together in every UI that
 * shows them: an admin deciding whether to invite needs the remaining count in
 * the same response, not a second round trip that can disagree with the first.
 */
router.get(
  "/invitations",
  requireAuth,
  requirePermission("invitation", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    await expirePastDue(authReq.orgId);

    const [rows, seats] = await Promise.all([
      db
        .select()
        .from(userInvitationsTable)
        .where(eq(userInvitationsTable.orgId, authReq.orgId))
        .orderBy(desc(userInvitationsTable.createdAt))
        .limit(200),
      getSeatUsage(authReq.orgId),
    ]);

    res.json({ data: rows.map(serialize), seats });
  },
);

/** GET /invitations/seats — seat usage on its own, for the billing screen. */
router.get(
  "/invitations/seats",
  requireAuth,
  requirePermission("invitation", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    await expirePastDue(authReq.orgId);
    res.json(await getSeatUsage(authReq.orgId));
  },
);

/**
 * POST /invitations — invite someone into this org.
 *
 * The seat check, the uniqueness check and the insert share one transaction
 * under an advisory lock, so two admins racing for the last seat cannot both
 * win. The email is sent after commit: a send failure must not roll back an
 * invitation that already exists, and the admin can resend.
 */
router.post(
  "/invitations",
  requireAuth,
  requirePermission("invitation", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = CreateInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    // Checked before any write: an invitation that cannot produce a working
    // link should not exist, and should not consume a seat.
    try {
      appBaseUrl();
    } catch (err) {
      if (err instanceof AppBaseUrlUnconfiguredError) return baseUrlUnconfigured(res);
      throw err;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const { role } = parsed.data;
    const { raw, hash } = newToken();

    let created: typeof userInvitationsTable.$inferSelect;
    try {
      created = await db.transaction(async (tx) => {
        await lockOrgSeats(authReq.orgId, tx);
        await expirePastDue(authReq.orgId, tx);

        // Already a member? Inviting again would either fail at accept time or
        // silently mint a second row for the same person.
        const [existingUser] = await tx
          .select({ id: usersTable.id, isActive: usersTable.isActive })
          .from(usersTable)
          .where(
            and(
              eq(usersTable.orgId, authReq.orgId),
              sql`lower(${usersTable.email}) = ${email}`,
            ),
          )
          .limit(1);

        if (existingUser) {
          throw new AlreadyMemberError(existingUser.isActive);
        }

        await requireSeat(authReq.orgId, tx);

        const [row] = await tx
          .insert(userInvitationsTable)
          .values({
            id: randomUUID(),
            orgId: authReq.orgId,
            email,
            role,
            tokenHash: hash,
            invitedByUserId: authReq.userId,
            status: "pending",
            expiresAt: new Date(
              Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
            ),
          })
          .returning();

        return row;
      });
    } catch (err) {
      if (err instanceof AlreadyMemberError) {
        res.status(409).json({
          error: err.isActive
            ? "That person is already a member of this agency."
            : "That person is a deactivated member of this agency. Reactivate them instead.",
          code: err.isActive ? "already_member" : "member_inactive",
        });
        return;
      }
      if (err instanceof PlanLimitError) {
        res.status(err.statusCode).json(planLimitResponse(err));
        return;
      }
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: "There is already a pending invitation for that address.",
          code: "invitation_pending",
        });
        return;
      }
      throw err;
    }

    await deliver(created, authReq, raw);

    // The raw token is returned exactly once, so an admin can hand over the
    // link directly when email is not configured or the message bounces.
    res.status(201).json({
      invitation: serialize(created),
      acceptUrl: acceptUrlFor(raw),
      emailSent: isEmailConfigured(),
      seats: await getSeatUsage(authReq.orgId),
    });
  },
);

/** POST /invitations/:id/resend — new token, fresh expiry, same seat. */
router.post(
  "/invitations/:id/resend",
  requireAuth,
  requirePermission("invitation", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = paramId(req);

    try {
      appBaseUrl();
    } catch (err) {
      if (err instanceof AppBaseUrlUnconfiguredError) return baseUrlUnconfigured(res);
      throw err;
    }

    const { raw, hash } = newToken();

    let row: typeof userInvitationsTable.$inferSelect | undefined;
    try {
      row = await db.transaction(async (tx) => {
        await lockOrgSeats(authReq.orgId, tx);

        const [current] = await tx
          .select()
          .from(userInvitationsTable)
          .where(
            and(
              eq(userInvitationsTable.id, id),
              eq(userInvitationsTable.orgId, authReq.orgId),
              sql`${userInvitationsTable.status} in ('pending', 'expired')`,
            ),
          )
          .limit(1);

        if (!current) return undefined;

        // A lapsed invitation has already given its seat back, and the agency
        // may have spent it in the meantime. Reviving one is therefore a seat
        // purchase like any other; resending a still-live invitation is not,
        // because it never stopped holding its seat.
        const stillHoldsSeat =
          current.status === "pending" &&
          current.expiresAt.getTime() > Date.now();
        if (!stillHoldsSeat) {
          await requireSeat(authReq.orgId, tx);
        }

        const [updated] = await tx
          .update(userInvitationsTable)
          .set({
            tokenHash: hash,
            expiresAt: new Date(
              Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
            ),
            status: "pending",
          })
          .where(eq(userInvitationsTable.id, current.id))
          .returning();

        return updated;
      });
    } catch (err) {
      if (err instanceof PlanLimitError) {
        res.status(err.statusCode).json(planLimitResponse(err));
        return;
      }
      throw err;
    }

    if (!row) {
      res.status(404).json({ error: "Invitation not found" });
      return;
    }

    await deliver(row, authReq, raw);

    res.json({
      invitation: serialize(row),
      acceptUrl: acceptUrlFor(raw),
      emailSent: isEmailConfigured(),
      seats: await getSeatUsage(authReq.orgId),
    });
  },
);

/**
 * DELETE /invitations/:id — revoke, freeing the seat it held.
 *
 * The row is kept rather than deleted: who invited whom, and who withdrew it,
 * is exactly the sort of thing an agency gets asked about later.
 */
router.delete(
  "/invitations/:id",
  requireAuth,
  requirePermission("invitation", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const id = paramId(req);

    const [row] = await db
      .update(userInvitationsTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(userInvitationsTable.id, id),
          eq(userInvitationsTable.orgId, authReq.orgId),
          eq(userInvitationsTable.status, "pending"),
        ),
      )
      .returning();

    if (!row) {
      res.status(404).json({ error: "Pending invitation not found" });
      return;
    }

    res.json({
      invitation: serialize(row),
      seats: await getSeatUsage(authReq.orgId),
    });
  },
);

/**
 * GET /invitations/lookup?token=… — what an invitation link points at.
 *
 * Unauthenticated on purpose: the recipient sees who invited them and to which
 * agency *before* deciding to create an account. The token is the credential;
 * the response carries no org data beyond the name they were invited to.
 *
 * Note for the tenant-isolation guard: this handler satisfies it incidentally,
 * by mentioning `orgId` in the join — not because the guard checked anything.
 * The actual control is that the org is resolved from the token hash and never
 * from a caller-supplied value. Read it as such if you change it.
 */
router.get(
  "/invitations/lookup",
  async (req: Request, res: Response): Promise<void> => {
    const raw = req.query.token;
    if (typeof raw !== "string" || raw.length < 20) {
      res.status(400).json({ error: "Missing or malformed token" });
      return;
    }

    const [row] = await db
      .select({
        email: userInvitationsTable.email,
        role: userInvitationsTable.role,
        status: userInvitationsTable.status,
        expiresAt: userInvitationsTable.expiresAt,
        orgName: organizationsTable.name,
      })
      .from(userInvitationsTable)
      .innerJoin(
        organizationsTable,
        eq(organizationsTable.id, userInvitationsTable.orgId),
      )
      .where(eq(userInvitationsTable.tokenHash, hashToken(raw)))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Invitation not found", code: "invalid" });
      return;
    }

    const state = effectiveState(row.status, row.expiresAt);
    if (state !== "pending") {
      res.status(410).json({ error: `Invitation ${state}`, code: state });
      return;
    }

    res.json({
      email: row.email,
      role: row.role,
      roleLabel: ROLE_LABELS[row.role as keyof typeof ROLE_LABELS] ?? row.role,
      organizationName: row.orgName,
      expiresAt: row.expiresAt,
    });
  },
);

/**
 * POST /invitations/accept — join the org named by the token.
 *
 * Requires a signed-in Clerk identity (that id becomes `users.id`) but not a
 * agencyBRIDGE account, which is precisely what this creates. The account's email
 * comes from the invitation, never from the request: the admin invited a
 * specific address and that is what the seat list must show.
 *
 * The seat is re-checked here, not merely at invite time. Between invitation
 * and acceptance an org can downgrade its plan, and a link issued under a
 * larger plan must not smuggle a seat past the smaller one.
 *
 * Note for the tenant-isolation guard: as with `lookup`, this handler mentions
 * `orgId` and so passes automatically. The real control is that every org
 * reference below is read out of the invitation the token hash resolved to.
 * A change that lets the request body influence `orgId` would not be caught.
 */
router.post(
  "/invitations/accept",
  async (req: Request, res: Response): Promise<void> => {
    const auth = getAuth(req);
    if (!auth?.userId) {
      // Booleans only: enough to tell "no token sent" from "token rejected"
      // without logging anything about the person or the invitation.
      logger.warn(
        {
          hasBearer: /^Bearer\s+\S+/i.test(req.headers.authorization ?? ""),
          hasSessionCookie: /(?:^|;\s*)__session=/.test(req.headers.cookie ?? ""),
          host: req.headers["x-forwarded-host"] ?? req.headers.host,
        },
        "Invitation accept refused: no verified Clerk session",
      );
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const clerkUserId = auth.userId;

    const parsed = AcceptInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const { token, fullName } = parsed.data;

    // Already provisioned? Accepting would either move them between orgs or
    // duplicate them. Both are worse than saying no.
    const [already] = await db
      .select({ orgId: usersTable.orgId })
      .from(usersTable)
      .where(eq(usersTable.id, clerkUserId))
      .limit(1);

    if (already) {
      res.status(409).json({
        error:
          "This account already belongs to an agency. Sign out and use a different account to accept.",
        code: "already_provisioned",
      });
      return;
    }

    try {
      const result = await db.transaction(async (tx) => {
        const [invite] = await tx
          .select()
          .from(userInvitationsTable)
          .where(eq(userInvitationsTable.tokenHash, hashToken(token)))
          .limit(1);

        if (!invite) throw new InviteUnusableError("invalid", 404);

        const state = effectiveState(invite.status, invite.expiresAt);
        if (state !== "pending") throw new InviteUnusableError(state, 410);

        await lockOrgSeats(invite.orgId, tx);
        // This invitation's own reservation becomes the new member's seat, so
        // it must not be counted against itself (see requireSeat).
        await requireSeat(invite.orgId, tx, { excludeInvitationId: invite.id });

        // Re-checked inside the transaction, not only before it: two concurrent
        // accepts by the same Clerk identity would both pass an outside check
        // and the loser would hit the users primary key, surfacing as a 500
        // rather than the documented conflict.
        const [raced] = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.id, clerkUserId))
          .limit(1);
        if (raced) throw new AlreadyProvisionedError();

        const [user] = await tx
          .insert(usersTable)
          .values({
            id: clerkUserId,
            orgId: invite.orgId,
            email: invite.email,
            fullName,
            role: invite.role,
            isActive: true,
            lastLoginAt: new Date(),
          })
          .returning();

        // Conditional on `pending` so two simultaneous accepts of the same
        // link cannot both claim it — the loser updates zero rows.
        const claimed = await tx
          .update(userInvitationsTable)
          .set({
            status: "accepted",
            acceptedAt: new Date(),
            acceptedUserId: clerkUserId,
          })
          .where(
            and(
              eq(userInvitationsTable.id, invite.id),
              eq(userInvitationsTable.status, "pending"),
            ),
          )
          .returning();

        if (claimed.length === 0) {
          throw new InviteUnusableError("accepted", 410);
        }

        return { user, orgId: invite.orgId };
      });

      invalidateEntitlements(result.orgId);
      logger.info(
        { userId: result.user.id, orgId: result.orgId },
        "User joined org via invitation",
      );

      res.status(201).json({ user: result.user });
    } catch (err) {
      // Belt and braces for the same race: even the in-transaction check above
      // can be beaten under a weaker isolation level, and the primary key is
      // the only thing that cannot be.
      if (err instanceof AlreadyProvisionedError || isUsersPkViolation(err)) {
        res.status(409).json({
          error:
            "This account already belongs to an agency. Sign out and use a different account to accept.",
          code: "already_provisioned",
        });
        return;
      }
      if (err instanceof InviteUnusableError) {
        res
          .status(err.statusCode)
          .json({ error: `Invitation ${err.code}`, code: err.code });
        return;
      }
      if (err instanceof PlanLimitError) {
        res.status(err.statusCode).json({
          ...planLimitResponse(err),
          error:
            "This agency has no seats available. Ask an administrator to free a seat or upgrade.",
        });
        return;
      }
      throw err;
    }
  },
);

// ---------------------------------------------------------------------------

class AlreadyMemberError extends Error {
  constructor(readonly isActive: boolean) {
    super("already a member");
  }
}

class AlreadyProvisionedError extends Error {
  constructor() {
    super("already provisioned");
  }
}

class InviteUnusableError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(code);
  }
}

/** Postgres unique-violation, unwrapping driver wrappers. */
export function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (
      typeof cur === "object" &&
      "code" in cur &&
      (cur as { code?: unknown }).code === "23505"
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Specifically the `users` primary-key collision, not any unique violation. */
function isUsersPkViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    const c = cur as { constraint?: unknown; message?: unknown };
    const marker = `${String(c.constraint ?? "")} ${String(c.message ?? "")}`;
    if (/users_pkey|"users"/.test(marker)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function paramId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

/**
 * The status a row *should* have right now.
 *
 * `expired` is a derived condition — a row goes stale on a wall-clock
 * boundary, with nothing running to notice. Deriving it on read means an
 * expired invitation is never usable even if the sweep below has not run.
 */
function effectiveState(status: string, expiresAt: Date): string {
  if (status === "pending" && expiresAt.getTime() <= Date.now()) {
    return "expired";
  }
  return status;
}

/**
 * Lazily marks lapsed invitations `expired`.
 *
 * Purely cosmetic for correctness — `effectiveState` and the seat count both
 * apply the expiry independently — but it keeps the admin's list honest
 * without a scheduled job.
 */
async function expirePastDue(
  orgId: string,
  conn: Parameters<typeof lockOrgSeats>[1] = db,
): Promise<void> {
  await conn
    .update(userInvitationsTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(userInvitationsTable.orgId, orgId),
        eq(userInvitationsTable.status, "pending"),
        sql`${userInvitationsTable.expiresAt} <= now()`,
      ),
    );
}

/** Sends the invitation email. Never throws — delivery is best-effort. */
export async function deliver(
  invite: typeof userInvitationsTable.$inferSelect,
  authReq: AuthenticatedRequest,
  rawToken: string,
): Promise<void> {
  if (!isEmailConfigured()) {
    logger.warn(
      { invitationId: invite.id, orgId: invite.orgId },
      "Email not configured — invitation created but not delivered; hand the returned acceptUrl over directly",
    );
    return;
  }

  const [[org], [inviter]] = await Promise.all([
    db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, invite.orgId))
      .limit(1),
    db
      .select({ fullName: usersTable.fullName })
      .from(usersTable)
      .where(eq(usersTable.id, authReq.userId))
      .limit(1),
  ]);

  const result = await sendEmail({
    to: { email: invite.email },
    subject: `You've been invited to ${org?.name ?? "a agencyBRIDGE agency"}`,
    html: invitationEmailHtml({
      agencyName: org?.name ?? "your agency",
      inviterName: inviter?.fullName ?? "An administrator",
      roleLabel:
        ROLE_LABELS[invite.role as keyof typeof ROLE_LABELS] ?? invite.role,
      acceptUrl: acceptUrlFor(rawToken),
      expiresInDays: INVITE_TTL_DAYS,
    }),
    tags: { type: "invitation" },
  });

  if (!result.success) {
    logger.error(
      { invitationId: invite.id, orgId: invite.orgId, error: result.error },
      "Invitation email failed to send",
    );
  }
}

export default router;
