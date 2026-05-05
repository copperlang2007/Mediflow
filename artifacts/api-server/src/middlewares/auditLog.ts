import { type Request, type Response, type NextFunction } from "express";
import { db, auditLogTable } from "@workspace/db";
import { type AuthenticatedRequest } from "./requireAuth";
import { randomUUID } from "crypto";

export const auditLog = (action: string, resourceType: string) => {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const originalJson = res.json.bind(res);

    res.json = function (data: unknown) {
      setImmediate(async () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            await db.insert(auditLogTable).values({
              id: randomUUID(),
              orgId: authReq.orgId,
              userId: authReq.userId,
              userRole: authReq.userRole,
              action,
              resourceType,
              resourceId:
                (req.params.id as string) ||
                ((data as Record<string, unknown>)?.id as string) ||
                null,
              changes: (req.body as Record<string, unknown>) || null,
              ipAddress:
                (req.headers["x-forwarded-for"] as string) ||
                req.socket.remoteAddress ||
                null,
              userAgent: req.headers["user-agent"] || null,
            });
          }
        } catch {
        }
      });
      return originalJson(data);
    };

    next();
  };
};
