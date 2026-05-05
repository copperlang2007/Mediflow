import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { randomUUID } from "crypto";

const router: IRouter = Router();

router.get("/notifications", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const { unreadOnly, limit } = req.query as { unreadOnly?: string; limit?: string };
  const limitNum = Math.min(parseInt(limit ?? "50", 10) || 50, 200);

  const conditions = [eq(notificationsTable.userId, authReq.userId)];
  if (unreadOnly === "true") {
    conditions.push(isNull(notificationsTable.readAt));
  }

  const notifications = await db
    .select()
    .from(notificationsTable)
    .where(and(...conditions))
    .orderBy(notificationsTable.createdAt)
    .limit(limitNum);

  res.json(notifications);
});

router.get("/notifications/count", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;

  const notifications = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, authReq.userId),
        isNull(notificationsTable.readAt)
      )
    );

  res.json({ unread: notifications.length });
});

router.post("/notifications/read-all", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;

  await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationsTable.userId, authReq.userId),
        isNull(notificationsTable.readAt)
      )
    );

  res.json({ success: true });
});

router.patch("/notifications/:id/read", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [notification] = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationsTable.id, raw),
        eq(notificationsTable.userId, authReq.userId)
      )
    )
    .returning();

  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  res.json(notification);
});

export default router;
