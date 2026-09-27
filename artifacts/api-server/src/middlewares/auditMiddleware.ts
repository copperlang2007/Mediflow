import { type Request, type Response, type NextFunction } from "express";
import { db, auditLogTable } from "@workspace/db";
import { type AuthenticatedRequest } from "./requireAuth";
import { type Resource, type Action } from "../lib/permissions";
import { randomUUID } from "crypto";
import { logger } from "../lib/logger";

type ActionResolver = Action | ((req: Request) => Action);
type ResourceResolver = Resource | ((req: Request) => Resource);

function resolveResource(resolver: ResourceResolver, req: Request): Resource {
  return typeof resolver === "function" ? resolver(req) : resolver;
}

function resolveAction(resolver: ActionResolver, req: Request): Action {
  return typeof resolver === "function" ? resolver(req) : resolver;
}

function methodToAction(method: string): Action {
  switch (method.toUpperCase()) {
    case "POST": return "create";
    case "PUT":
    case "PATCH": return "update";
    case "DELETE": return "delete";
    default: return "read";
  }
}

export function auditMiddleware(
  resource: ResourceResolver,
  action?: ActionResolver,
  options: { includeReads?: boolean; viewOnlyReads?: boolean; getResourceId?: (req: Request) => string | null } = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { includeReads = false, viewOnlyReads = false, getResourceId } = options;
    const httpMethod = req.method.toUpperCase();
    const isRead = httpMethod === "GET" || httpMethod === "HEAD";

    if ((isRead && !includeReads) || (viewOnlyReads && (!isRead || !req.get("X-MediFlow-View-Org")))) {
      next();
      return;
    }

    const startedAt = Date.now();

    res.on("finish", () => {
      const authReq = req as AuthenticatedRequest;
      if (viewOnlyReads && !authReq.viewOnly) return;
      const userId = authReq.userId ?? null;
      const orgId = authReq.orgId ?? null;

      if (!orgId) return;

      const resolvedResource = resolveResource(resource, req);
      const resolvedAction = action
        ? resolveAction(action, req)
        : methodToAction(httpMethod);
      const resourceId = getResourceId ? getResourceId(req) : extractIdParam(req);
      const durationMs = Date.now() - startedAt;

      const changes: Record<string, unknown> = {
        method: req.method,
        path: req.path,
        durationMs,
        statusCode: res.statusCode,
        ...(authReq.viewOnly ? { viewOnly: true, realOrgId: authReq.realOrgId, viewingOrgId: authReq.viewingOrgId } : {}),
      };

      db.insert(auditLogTable)
        .values({
          id: randomUUID(),
          orgId,
          userId,
          userRole: authReq.userRole ?? null,
          action: resolvedAction,
          resourceType: resolvedResource,
          resourceId,
          ipAddress: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          changes,
        })
        .execute()
        .catch((err: Error) => logger.error({ err }, "Failed to write audit log entry"));
    });

    next();
  };
}

function extractIdParam(req: Request): string | null {
  if (typeof req.params.id === "string") return req.params.id;
  if (Array.isArray(req.params.id)) return req.params.id[0] ?? null;
  return null;
}

type RouteLayer = {
  route?: { methods: Record<string, boolean> };
  match(path: string): boolean;
};

/**
 * Limit a router-level audit middleware to requests that router actually
 * handles. Routers are mounted at the API root, so a bare
 * `router.use(auditMiddleware(...))` otherwise runs for every request that
 * passes through on its way to a later router and logs it under the wrong
 * resource.
 */
export function scopeToRouter(
  router: { stack: unknown[] },
  middleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toLowerCase();
    const handled = (router.stack as RouteLayer[]).some((layer) => {
      const methods = layer.route?.methods;
      if (!methods) return false;
      const allows = methods[method] || methods._all || (method === "head" && methods.get);
      return !!allows && layer.match(req.path);
    });
    if (!handled) {
      next();
      return;
    }
    middleware(req, res, next);
  };
}
