import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { db, usersTable } from "@workspace/db";
import {
  requireAuth,
  requireRole,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";

import { type Role } from "../lib/permissions";
import { safeLimit, safeOffset } from "../lib/listGuards";
import {
  getSeatUsage,
  requireSeat,
  lockOrgSeats,
} from "../lib/billing/seats";
import {
  PlanLimitError,
  planLimitResponse,
} from "../lib/billing/entitlements";

const UpdateMeSchema = z.object({
  fullName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().optional(),
});

const UpdateUserRoleSchema = z.object({
  role: z.enum([
    "super_admin",
    "agency_admin",
    "compliance_manager",
    "agent_support",
    "viewer",
  ]),
});

const SetActiveSchema = z.object({
  isActive: z.boolean(),
});

const VALID_ROLES: Role[] = [
  "super_admin",
  "agency_admin",
  "compliance_manager",
  "agent_support",
  "viewer",
];

function isValidRole(value: string): value is Role {
  return (VALID_ROLES as string[]).includes(value);
}

const router: IRouter = Router();

// Group-level audit: covers reads and writes on user resources automatically.
router.use(
  routerAuditMiddleware(router, "user", undefined, {

    includeReads: true,
    getResourceId: (req) => {
      const raw = req.params.userId ?? req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

router.get(
  "/users/me",
  requireAuth,
  requirePermission("user", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, authReq.userId))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(user);
  },
);

router.patch(
  "/users/me",
  requireAuth,
  requirePermission("user", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = UpdateMeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const { fullName, avatarUrl } = parsed.data;

    const updates: Partial<typeof usersTable.$inferInsert> = {};
    if (fullName != null) updates.fullName = fullName;
    if (avatarUrl != null) updates.avatarUrl = avatarUrl;

    const [user] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, authReq.userId))
      .returning();

    res.json(user);
  },
);

router.get(
  "/users",
  requireAuth,
  requirePermission("user", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { role, isActive, limit, offset } = req.query as {
      role?: string;
      isActive?: string;
      limit?: string;
      offset?: string;
    };

    const conditions = [eq(usersTable.orgId, authReq.orgId)];

    if (role && isValidRole(role)) {
      conditions.push(eq(usersTable.role, role));
    }
    if (isActive !== undefined) {
      conditions.push(eq(usersTable.isActive, isActive === "true"));
    }

    // Per-route cap of 200 (default 50). Matches the contract documented in
    // the PR — list endpoints must never return unbounded result sets.
    const limitNum = safeLimit(limit, 50, 200);
    const offsetNum = safeOffset(offset);

    const [users, totalRes] = await Promise.all([
      db
        .select()
        .from(usersTable)
        .where(and(...conditions))
        .limit(limitNum)
        .offset(offsetNum),
      db
        .select({ count: sql<number>`count(*)` })
        .from(usersTable)
        .where(and(...conditions)),
    ]);

    res.json({
      data: users,
      total: Number(totalRes[0]?.count ?? 0),
      limit: limitNum,
      offset: offsetNum,
    });
  },
);

router.patch(
  "/users/:userId/role",
  requireAuth,
  requirePermission("user", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.userId)
      ? req.params.userId[0]
      : req.params.userId;

    const parsed = UpdateUserRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const { role } = parsed.data;

    // Prevent non-super_admins from granting super_admin
    if (role === "super_admin" && authReq.userRole !== "super_admin") {
      res.status(403).json({ error: "Only super_admins can grant super_admin role" });
      return;
    }

    const [user] = await db
      .update(usersTable)
      .set({ role })
      .where(and(eq(usersTable.id, raw), eq(usersTable.orgId, authReq.orgId)))
      .returning();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(user);
  },
);

/**
 * PATCH /users/:userId/active — deactivate or reactivate a member.
 *
 * This is the other half of seat management. Deactivating is how an agency
 * frees a seat when someone leaves: the row stays (their audit trail, their
 * assigned contacts and tasks all reference it) but the login stops working —
 * `requireAuth` rejects an inactive user — and the seat returns to the pool.
 *
 * Reactivating consumes a seat and can therefore fail with 402, under the same
 * lock as an invitation so the two paths cannot both claim the last one.
 *
 * An admin cannot deactivate themselves: an agency that locks its only
 * administrator out has no way back in without support intervention.
 */
router.patch(
  "/users/:userId/active",
  requireAuth,
  requirePermission("seat", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.userId)
      ? req.params.userId[0]
      : req.params.userId;

    const parsed = SetActiveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const { isActive } = parsed.data;

    if (!isActive && raw === authReq.userId) {
      res.status(400).json({
        error: "You cannot deactivate your own account.",
        code: "self_deactivation",
      });
      return;
    }

    try {
      const user = await db.transaction(async (tx) => {
        await lockOrgSeats(authReq.orgId, tx);

        const [current] = await tx
          .select({ isActive: usersTable.isActive })
          .from(usersTable)
          .where(and(eq(usersTable.id, raw), eq(usersTable.orgId, authReq.orgId)))
          .limit(1);

        if (!current) return null;

        // Only a transition into `active` consumes a seat. Re-asserting a
        // state the user is already in must not fail on a full plan.
        if (isActive && !current.isActive) {
          await requireSeat(authReq.orgId, tx);
        }

        const [updated] = await tx
          .update(usersTable)
          .set({ isActive })
          .where(and(eq(usersTable.id, raw), eq(usersTable.orgId, authReq.orgId)))
          .returning();

        return updated;
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      res.json({ user, seats: await getSeatUsage(authReq.orgId) });
    } catch (err) {
      if (err instanceof PlanLimitError) {
        res.status(err.statusCode).json(planLimitResponse(err));
        return;
      }
      throw err;
    }
  },
);

export default router;
