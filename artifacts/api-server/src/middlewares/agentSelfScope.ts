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
