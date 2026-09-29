/**
 * Who may see a contact's PHI (date of birth, Medicare ID, health conditions,
 * full enrollment applications) in plaintext:
 *   - the PHI-privileged roles (PHI_PRIVILEGED_ROLES), for every contact;
 *   - an agent, for the clients they service: the contact's assigned agent,
 *     and (for an application) the agent who wrote it. They need the health
 *     answers to find the plans a client qualifies for.
 * Everyone else sees masked values. Full-application views are audited
 * whoever opens them.
 */
import type { AuthenticatedRequest } from "../middlewares/requireAuth";
import { ownAgentId } from "./appointments";
import { PHI_PRIVILEGED_ROLES } from "./permissions";

/**
 * The viewer's own agent profile id, which widens their PHI access to the
 * clients they service; null for privileged roles (who need no widening) and
 * for a user with no linked agent profile.
 */
export async function phiViewerAgentId(authReq: AuthenticatedRequest): Promise<string | null> {
  if (PHI_PRIVILEGED_ROLES.has(authReq.userRole)) return null;
  return ownAgentId(authReq.orgId, authReq.userId);
}

/**
 * May this viewer open a client's full enrollment application? Privileged
 * roles always; otherwise the viewer's agent profile must be the client's
 * assigned agent or the agent who wrote the application.
 */
export function mayViewFullApplication(
  userRole: AuthenticatedRequest["userRole"],
  viewerAgentId: string | null,
  assignedAgentId: string | null,
  writingAgentId: string | null,
): boolean {
  if (PHI_PRIVILEGED_ROLES.has(userRole)) return true;
  return !!viewerAgentId && (viewerAgentId === assignedAgentId || viewerAgentId === writingAgentId);
}
