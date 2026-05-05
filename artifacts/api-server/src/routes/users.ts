import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { db, usersTable } from "@workspace/db";
import {
  requireAuth,
  requireRole,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import { type Role } from "../lib/permissions";

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
  auditMiddleware("user", undefined, {
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
    const { role, isActive } = req.query as {
      role?: string;
      isActive?: string;
    };

    const conditions = [eq(usersTable.orgId, authReq.orgId)];

    if (role && isValidRole(role)) {
      conditions.push(eq(usersTable.role, role));
    }
    if (isActive !== undefined) {
      conditions.push(eq(usersTable.isActive, isActive === "true"));
    }

    const users = await db
      .select()
      .from(usersTable)
      .where(and(...conditions));

    res.json(users);
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

export default router;
