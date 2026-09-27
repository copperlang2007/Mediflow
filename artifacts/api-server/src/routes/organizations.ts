import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, organizationsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware, scopeToRouter } from "../middlewares/auditMiddleware";
import { requireMfa } from "../middlewares/requireMfa";

const UpdateOrgSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  logoUrl: z.string().url().nullable().optional(),
});

const router: IRouter = Router();

router.use(scopeToRouter(router, auditMiddleware("org", undefined, { includeReads: true })));

router.get(
  "/admin/agencies",
  requireAuth,
  requireMfa,
  requireRole("super_admin"),
  async (_req: Request, res: Response): Promise<void> => {
    const agencies = await db
      .select({ id: organizationsTable.id, name: organizationsTable.name, slug: organizationsTable.slug })
      .from(organizationsTable);
    res.json({ agencies });
  },
);
router.get(
  "/organizations/me",
  requireAuth,
  requirePermission("org", "read"),
  async (req: Request, res: Response): Promise<void> => {
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
  },
);

router.patch(
  "/organizations/me",
  requireAuth,
  requirePermission("org", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const parsed = UpdateOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const { name, logoUrl } = parsed.data;

    const updates: Partial<typeof organizationsTable.$inferInsert> = {};
    if (name != null) updates.name = name;
    if (logoUrl != null) updates.logoUrl = logoUrl;

    const [org] = await db
      .update(organizationsTable)
      .set(updates)
      .where(eq(organizationsTable.id, authReq.orgId))
      .returning();

    res.json(org);
  },
);

export default router;
