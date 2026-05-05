import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, organizationsTable } from "@workspace/db";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";

const router: IRouter = Router();

router.get("/organizations/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;

  const [org] = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.id, authReq.orgId))
    .limit(1);

  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }

  res.json(org);
});

router.patch(
  "/organizations/me",
  requireAuth,
  requireRole("super_admin", "agency_admin"),
  auditMiddleware("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { name, logoUrl } = req.body as { name?: string; logoUrl?: string };

    const updates: Partial<typeof organizationsTable.$inferInsert> = {};
    if (name != null) updates.name = name;
    if (logoUrl != null) updates.logoUrl = logoUrl;

    const [org] = await db
      .update(organizationsTable)
      .set(updates)
      .where(eq(organizationsTable.id, authReq.orgId))
      .returning();

    res.json(org);
  }
);

export default router;
