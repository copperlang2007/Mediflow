import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { db, auditLogTable, usersTable } from "@workspace/db";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { routerAuditMiddleware } from "../middlewares/auditMiddleware";
import { safeLimit, safeOffset } from "../lib/listGuards";

const router: IRouter = Router();

// Audit log reads are themselves audited — full access traceability.
router.use(routerAuditMiddleware(router, "audit_log", undefined, { includeReads: true }));

router.get(
  "/audit-log",
  requireAuth,
  requireRole("super_admin", "agency_admin", "compliance_manager"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const { userId, action, resourceType, startDate, endDate, limit, offset } =
      req.query as {
        userId?: string;
        action?: string;
        resourceType?: string;
        startDate?: string;
        endDate?: string;
        limit?: string;
        offset?: string;
      };

    const limitNum = safeLimit(limit, 50, 500);
    const offsetNum = safeOffset(offset);

    const conditions = [eq(auditLogTable.orgId, authReq.orgId)];
    if (userId) conditions.push(eq(auditLogTable.userId, userId));
    if (action) conditions.push(eq(auditLogTable.action, action));
    if (resourceType)
      conditions.push(eq(auditLogTable.resourceType, resourceType));
    if (startDate)
      conditions.push(gte(auditLogTable.createdAt, new Date(startDate)));
    if (endDate)
      conditions.push(lte(auditLogTable.createdAt, new Date(endDate)));

    const [entries, totalResult] = await Promise.all([
      db
        .select()
        .from(auditLogTable)
        .where(and(...conditions))
        .orderBy(sql`${auditLogTable.createdAt} DESC`)
        .limit(limitNum)
        .offset(offsetNum),
      db
        .select({ count: sql<number>`count(*)` })
        .from(auditLogTable)
        .where(and(...conditions)),
    ]);

    const userIds = [...new Set(entries.map((e) => e.userId).filter(Boolean))];
    const users =
      userIds.length > 0
        ? await db
            .select({ id: usersTable.id, fullName: usersTable.fullName })
            .from(usersTable)
            .where(sql`${usersTable.id} = ANY(${userIds})`)
        : [];

    const userMap = new Map(users.map((u) => [u.id, u.fullName]));

    const enriched = entries.map((e) => ({
      ...e,
      userFullName: e.userId ? (userMap.get(e.userId) ?? null) : null,
    }));

    res.json({
      entries: enriched,
      total: Number(totalResult[0]?.count ?? 0),
      limit: limitNum,
      offset: offsetNum,
    });
  }
);

export default router;
