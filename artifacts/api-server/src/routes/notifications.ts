import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import {
  requireAuth,
  requirePermission,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { auditMiddleware } from "../middlewares/auditMiddleware";
import {
  addSseSubscriber,
  removeSseSubscriber,
  broadcastToUser,
} from "../lib/sseManager";
import { safeLimit } from "../lib/listGuards";

const router: IRouter = Router();

router.use(
  auditMiddleware("notification", undefined, {
    includeReads: true,
    getResourceId: (req) => {
      const raw = req.params.id;
      return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
    },
  }),
);

router.get(
  "/notifications/stream",
  requireAuth,
  requirePermission("notification", "read"),
  (req: Request, res: Response): void => {
    const authReq = req as AuthenticatedRequest;
    const { userId } = authReq;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    res.write(": connected\n\n");
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 25_000);

    addSseSubscriber(userId, res);

    req.on("close", () => {
      clearInterval(heartbeat);
      removeSseSubscriber(userId, res);
    });
  },
);

router.get(
  "/notifications",
  requireAuth,
  requirePermission("notification", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { unreadOnly, limit } = req.query as { unreadOnly?: string; limit?: string };
    const limitNum = safeLimit(limit, 50, 1000);

    const conditions: ReturnType<typeof eq>[] = [
      eq(notificationsTable.userId, authReq.userId),
    ];
    if (unreadOnly === "true") {
      conditions.push(isNull(notificationsTable.readAt) as ReturnType<typeof eq>);
    }

    const notifications = await db
      .select()
      .from(notificationsTable)
      .where(and(...conditions))
      .orderBy(notificationsTable.createdAt)
      .limit(limitNum);

    res.json(notifications);
  },
);

router.get(
  "/notifications/count",
  requireAuth,
  requirePermission("notification", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const notifications = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.userId, authReq.userId),
          isNull(notificationsTable.readAt),
        ),
      );

    res.json({ unread: notifications.length });
  },
);

router.post(
  "/notifications/read-all",
  requireAuth,
  requirePermission("notification", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.userId, authReq.userId),
          isNull(notificationsTable.readAt),
        ),
      );

    broadcastToUser(authReq.userId, { type: "unread_count", unread: 0 });

    res.json({ success: true });
  },
);

router.patch(
  "/notifications/:id/read",
  requireAuth,
  requirePermission("notification", "update"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const [notification] = await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.id, raw),
          eq(notificationsTable.userId, authReq.userId),
        ),
      )
      .returning();

    if (!notification) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    res.json(notification);
  },
);

export default router;
