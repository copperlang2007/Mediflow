/**
 * Who may see a contact's PHI (date of birth, Medicare ID, health conditions,
 * full enrollment applications) in plaintext:
 *   - the PHI-privileged roles (PHI_PRIVILEGED_ROLES), for every contact;
 *   - a user with the `agent` role, for the clients they service:
 *       - clients assigned to their agent profile, and
 *       - clients holding a policy they wrote that is still pending or
 *         active (not cancelled, terminated, declined or disenrolled).
 *     The writing agent needs the health answers to find the plans a client
 *     qualifies for; the access ends when that policy ends, unless the client
 *     is (also) assigned to them.
 * Other roles never gain PHI through a linked agent profile. Everyone else
 * sees masked values. Full-application views are audited whoever opens them.
 */
import { and, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, contactsTable, enrollmentsTable } from "@workspace/db";
import type { AuthenticatedRequest } from "../middlewares/requireAuth";
import { ownAgentId } from "./appointments";
import { PHI_PRIVILEGED_ROLES } from "./permissions";

/**
 * The agent-role viewer's own agent profile id, which widens their PHI access
 * to the clients they service. Null for every other role (privileged roles
 * need no widening; back-office roles never gain PHI through a linked agent
 * row) and for an agent with no linked profile.
 */
export async function phiViewerAgentId(authReq: AuthenticatedRequest): Promise<string | null> {
  if (authReq.userRole !== "agent") return null;
  return ownAgentId(authReq.orgId, authReq.userId);
}

/** Enrollment statuses under which the writing agent still services the policy. */
export const SERVICED_ENROLLMENT_STATUSES = ["pending", "active"] as const;

/**
 * May this viewer open a client's full enrollment application? Privileged
 * roles always; otherwise the viewer's agent profile must be the client's
 * assigned agent, or the agent who wrote the application's policy while that
 * policy is still serviced (callers pass `writingAgentId` only then).
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

/** A still-serviced enrollment's writing agent, else null (for joins on enrollmentsTable). */
export const servicedWritingAgentId = sql<string | null>`case when ${enrollmentsTable.status} in ('pending', 'active') and ${enrollmentsTable.disenrolledDate} is null then ${enrollmentsTable.agentId} end`;

/** Contacts this agent services: assigned to them, or holding a still-serviced policy they wrote. */
export function servicedByAgent(agentId: string): SQL {
  return or(
    eq(contactsTable.assignedAgentId, agentId),
    exists(
      db.select({ one: sql`1` }).from(enrollmentsTable).where(and(
        eq(enrollmentsTable.contactId, contactsTable.id),
        eq(enrollmentsTable.agentId, agentId),
        inArray(enrollmentsTable.status, [...SERVICED_ENROLLMENT_STATUSES]),
        isNull(enrollmentsTable.disenrolledDate),
      )),
    ),
  )!;
}
