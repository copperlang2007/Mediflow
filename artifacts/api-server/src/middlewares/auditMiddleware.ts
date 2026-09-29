import { type Request, type Response, type NextFunction, type IRouter } from "express";
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

type AuditOptions = {
  includeReads?: boolean;
  viewOnlyReads?: boolean;
  getResourceId?: (req: Request) => string | null;
  /** Evaluated when the response finishes; return false to skip the audit row (e.g. an idempotent no-op). */
  shouldAudit?: (req: Request, res: Response) => boolean;
};

/**
 * Per-route audit middleware: every request that reaches it is audited.
 * Use it inline in a route's handler chain. For a whole router, use
 * `routerAuditMiddleware` instead — `router.use(auditMiddleware(...))` on a
 * router mounted at the root would also audit every request handled by
 * routers mounted after it.
 */
export function auditMiddleware(
  resource: ResourceResolver,
  action?: ActionResolver,
  options: AuditOptions = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const write = prepareAuditEntry(resource, action, options, req, res);
    if (write) res.on("finish", write);
    next();
  };
}

type PendingRouterAudit = { router: IRouter; write: () => void };
const pendingRouterAudits = new WeakMap<Response, PendingRouterAudit[]>();

/**
 * Router-wide audit middleware: `router.use(routerAuditMiddleware(router, ...))`.
 *
 * `routes/index.ts` mounts every feature router at the root, so a router's
 * root-level middleware runs for every request that passes through it on the
 * way to a later router — and several routers share prefixes such as
 * `/agents`, so scoping by path is not enough. Instead, once the response
 * finishes, only the middleware whose router owns the route that actually
 * handled the request (`req.route`) writes an entry. All router-level audits
 * for one request share a single `finish` listener.
 */
export function routerAuditMiddleware(
  router: IRouter,
  resource: ResourceResolver,
  action?: ActionResolver,
  options: AuditOptions = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const write = prepareAuditEntry(resource, action, options, req, res);
    if (write) {
      let pending = pendingRouterAudits.get(res);
      if (!pending) {
        const entries: PendingRouterAudit[] = [];
        pending = entries;
        pendingRouterAudits.set(res, entries);
        res.once("finish", () => {
          const route: unknown = req.route;
          if (!route) return;
          entries.find((p) => routerOwnsRoute(p.router, route))?.write();
        });
      }
      pending.push({ router, write });
    }
    next();
  };
}

function routerOwnsRoute(router: IRouter, route: unknown): boolean {
  return router.stack.some((layer) => {
    if (layer.route) return layer.route === route;
    // A sub-router mounted with `router.use(subRouter)`.
    const nested = (layer.handle as Partial<IRouter>).stack;
    return Array.isArray(nested) && routerOwnsRoute(layer.handle as unknown as IRouter, route);
  });
}

/**
 * Returns the function that writes this request's audit entry once the
 * response finishes, or null when the request is not audited (a read without
 * `includeReads`, or not a view-only read under `viewOnlyReads`).
 */
function prepareAuditEntry(
  resource: ResourceResolver,
  action: ActionResolver | undefined,
  options: AuditOptions,
  req: Request,
  res: Response,
): (() => void) | null {
  const { includeReads = false, viewOnlyReads = false, getResourceId } = options;
  const httpMethod = req.method.toUpperCase();
  const isRead = httpMethod === "GET" || httpMethod === "HEAD";

  if ((isRead && !includeReads) || (viewOnlyReads && (!req.get("X-MediFlow-View-Org") || (!isRead && req.get("X-MediFlow-Support-Edit") !== "true")))) {
    return null;
  }

  const startedAt = Date.now();

  return () => {
    const authReq = req as AuthenticatedRequest;
    if (options.shouldAudit && !options.shouldAudit(req, res)) return;
    if (viewOnlyReads && !authReq.viewOnly && !authReq.supportEdit) return;
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
      ...(authReq.supportEdit ? { supportEdit: true, supportReason: authReq.supportReason, realOrgId: authReq.realOrgId, viewingOrgId: authReq.viewingOrgId } : {}),
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
  };
}

function extractIdParam(req: Request): string | null {
  if (typeof req.params.id === "string") return req.params.id;
  if (Array.isArray(req.params.id)) return req.params.id[0] ?? null;
  return null;
}
