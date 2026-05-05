import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/users/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
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
});

router.patch("/users/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const { fullName, avatarUrl } = req.body as { fullName?: string; avatarUrl?: string };

  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (fullName != null) updates.fullName = fullName;
  if (avatarUrl != null) updates.avatarUrl = avatarUrl;

  const [user] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, authReq.userId))
    .returning();

  res.json(user);
});

router.get(
  "/users",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { role, isActive } = req.query as { role?: string; isActive?: string };

    let query = db
      .select()
      .from(usersTable)
      .where(eq(usersTable.orgId, authReq.orgId))
      .$dynamic();

    if (role) {
      query = query.where(
        and(
          eq(usersTable.orgId, authReq.orgId),
          eq(usersTable.role, role as any)
        )
      );
    }
    if (isActive !== undefined) {
      query = query.where(
        and(
          eq(usersTable.orgId, authReq.orgId),
          eq(usersTable.isActive, isActive === "true")
        )
      );
    }

    const users = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.orgId, authReq.orgId));

    res.json(users);
  }
);

router.patch(
  "/users/:userId/role",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const { role } = req.body as { role: string };

    if (!role) {
      res.status(400).json({ error: "role is required" });
      return;
    }

    const [user] = await db
      .update(usersTable)
      .set({ role: role as any })
      .where(
        and(eq(usersTable.id, raw), eq(usersTable.orgId, authReq.orgId))
      )
      .returning();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(user);
  }
);

export default router;
