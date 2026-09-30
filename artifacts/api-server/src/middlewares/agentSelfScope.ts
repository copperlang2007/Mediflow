/**
 * Self-scoped access for the `agent` role.
 *
 * Back-office roles are gated by the usual `agent:<action>` permission. The
 * `agent` role deliberately has NO `agent:*` permission (it must not browse the
 * roster), so these helpers admit it ONLY when the `:param` agent profile is the
 * caller's own (agents.user_id = caller, same org). Any other agent id — another
 * agent in the org or one in a different org — is answered with the same 404 as
 * a missing agent, so ids cannot be probed.
 */
import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, agentsTable } from "@workspace/db";
import { can, type Action } from "../lib/permissions";
import type { AuthenticatedRequest } from "./requireAuth";

/** True when this authenticated request is a plain `agent` (self-scoped) role. */
export function isSelfScopedAgent(req: Request): boolean {
  return (req as AuthenticatedRequest).userRole === "agent";
}

/** Id of the agent profile linked to this user in this org, or null. */
export async function callerAgentId(req: Request): Promise<string | null> {
  const a = req as AuthenticatedRequest;
  const [row] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, a.orgId), eq(agentsTable.userId, a.userId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * `requirePermission("agent", action)` for back-office roles; for the `agent`
 * role, allow only when `req.params[param]` is their own agent profile.
 */
export function requireAgentPermissionOrSelf(
  action: Action,
  param: string,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const a = req as AuthenticatedRequest;
    if (!a.userRole) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (can(a.userRole, "agent", action)) {
      next();
      return;
    }
    if (a.userRole === "agent" && can(a.userRole, "agent_onboarding", action)) {
      const raw = req.params[param];
      const target = Array.isArray(raw) ? raw[0] : raw;
      const own = await callerAgentId(req);
      if (own && target === own) {
        next();
        return;
      }
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.status(403).json({ error: "Forbidden" });
  };
}

/**
 * Softphone scope for one request.
 *   all   - back-office role with `contact:read`; behaviour unchanged.
 *   agent - plain `agent` with `call:create`: ONLY contacts assigned to the
 *           caller's own linked, ACTIVE agent profile (same org).
 */
export type SoftphoneScope = { kind: "all" } | { kind: "agent"; agentId: string };

/** Agent profile statuses that may use the softphone (same rule as placing a call). */
const SOFTPHONE_AGENT_STATUSES: readonly string[] = ["active"];

/**
 * Gate for the softphone read routes the dialer page uses. Back-office roles
 * keep needing `contact:read`. The `agent` role (which deliberately lacks the
 * global `contact:read`) is admitted when it has `call:create` AND its user is
 * linked to an ACTIVE agent profile in this org; the resolved profile id is put
 * on `res.locals.softphoneScope` so handlers narrow every query to it. An
 * unlinked agent gets 404, a non-active one 409 - fail closed, nothing leaked.
 */
export async function requireSoftphoneAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const a = req as AuthenticatedRequest;
  if (!a.userRole) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (can(a.userRole, "contact", "read")) {
    res.locals.softphoneScope = { kind: "all" } satisfies SoftphoneScope;
    next();
    return;
  }
  if (a.userRole === "agent" && can(a.userRole, "call", "create")) {
    const [row] = await db
      .select({ id: agentsTable.id, status: agentsTable.status })
      .from(agentsTable)
      .where(and(eq(agentsTable.orgId, a.orgId), eq(agentsTable.userId, a.userId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Agent profile not found", code: "AGENT_NOT_LINKED" });
      return;
    }
    if (!SOFTPHONE_AGENT_STATUSES.includes(row.status)) {
      res.status(409).json({ error: "Your agent profile is not active", code: "AGENT_NOT_ACTIVE" });
      return;
    }
    res.locals.softphoneScope = { kind: "agent", agentId: row.id } satisfies SoftphoneScope;
    next();
    return;
  }
  res.status(403).json({ error: "Forbidden" });
}

export function softphoneScope(res: Response): SoftphoneScope {
  // Fail closed if a handler is ever mounted without the gate: an empty agent id matches no contact.
  return (res.locals.softphoneScope as SoftphoneScope | undefined) ?? { kind: "agent", agentId: "" };
}
