import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { randomUUID } from "crypto";

const router: IRouter = Router();

// In-memory SSE subscriber registry: userId → Set<Response>
const sseClients = new Map<string, Set<Response>>();

/** Broadcast a notification event to all open SSE connections for a user. */
export function broadcastNotification(userId: string, payload: Record<string, unknown>): void {
  const clients = sseClients.get(userId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(payload);
  for (const res of clients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      // connection gone — will be cleaned up on close
    }
  }
}

/**
 * GET /notifications/stream
 * Server-Sent Events endpoint for real-time notification push.
 */
router.get("/notifications/stream", requireAuth, (req: Request, res: Response): void => {
  const authReq = req as AuthenticatedRequest;
  const { userId } = authReq;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Send a heartbeat every 25 seconds to keep the connection alive through proxies
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  // Register this connection
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId)!.add(res);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.get(userId)?.delete(res);
    if (sseClients.get(userId)?.size === 0) sseClients.delete(userId);
  });
});

router.get("/notifications", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const { unreadOnly, limit } = req.query as { unreadOnly?: string; limit?: string };
  const limitNum = Math.min(parseInt(limit ?? "50", 10) || 50, 200);

  const conditions: ReturnType<typeof eq>[] = [eq(notificationsTable.userId, authReq.userId)];
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
});

router.get("/notifications/count", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;

  const notifications = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, authReq.userId),
        isNull(notificationsTable.readAt),
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
        isNull(notificationsTable.readAt),
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
        eq(notificationsTable.userId, authReq.userId),
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
