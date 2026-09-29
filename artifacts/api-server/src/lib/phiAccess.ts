/**
 * Who may see a contact's PHI (date of birth, Medicare ID, health conditions,
 * full enrollment applications) in plaintext:
 *   - the PHI-privileged roles (PHI_PRIVILEGED_ROLES), for every contact;
 *   - a user with the `agent` role whose agent profile is not suspended or
 *     offboarding/offboarded, for the clients they service:
 *       - clients assigned to their agent profile, and
 *       - clients holding a policy they wrote that is still in play: pending
 *         or active, not disenrolled, and not reported ended by the carrier
 *         feed (cancelled, terminated, declined, or a "not in force" status).
 *     A full application opens for its own writing agent (matched on the NPN
 *     or email recorded on the application), not for whoever else sits on a
 *     shared enrollment row.
 *     The writing agent needs the health answers to find the plans a client
 *     qualifies for; the access ends when that policy ends, unless the client
 *     is (also) assigned to them.
 * Other roles never gain PHI through a linked agent profile. Everyone else
 * sees masked values. Full-application views are audited whoever opens them.
 */
import { and, eq, exists, inArray, isNull, not, or, sql, type SQL } from "drizzle-orm";
import { db, agentsTable, contactsTable, enrollmentApplicationsTable, enrollmentsTable } from "@workspace/db";
import type { AuthenticatedRequest } from "../middlewares/requireAuth";
import { isEndedStatus } from "./integrations/enrollhere/policyEvent";
import { PHI_PRIVILEGED_ROLES } from "./permissions";

/** Agent profiles that no longer service anyone. */
const INACTIVE_AGENT_STATUSES = new Set(["suspended", "offboarding", "offboarded"]);

export interface PhiViewerAgent {
  id: string;
  npn: string | null;
  email: string | null;
}

/**
 * The agent-role viewer's own agent profile, which widens their PHI access to
 * the clients they service. Null for every other role (privileged roles need
 * no widening; back-office roles never gain PHI through a linked agent row),
 * for an agent with no linked profile, and for a suspended or offboarded one.
 */
export async function phiViewerAgent(authReq: AuthenticatedRequest): Promise<PhiViewerAgent | null> {
  if (authReq.userRole !== "agent") return null;
  const [row] = await db.select({ id: agentsTable.id, npn: agentsTable.npn, email: agentsTable.email, status: agentsTable.status })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, authReq.orgId), eq(agentsTable.userId, authReq.userId)))
    .limit(1);
  if (!row || INACTIVE_AGENT_STATUSES.has(row.status)) return null;
  return { id: row.id, npn: row.npn, email: row.email };
}

/** Enrollment statuses under which the writing agent still services the policy. */
export const SERVICED_ENROLLMENT_STATUSES = ["pending", "active"] as const;

/**
 * Carrier-feed statuses that mean "not in force" (POL_INACTIVE,
 * POL_NOT_INFORCE, NON_EFFECTUATED). The enrollment keeps `pending` for these,
 * so the servicing checks read the application's own status too. Must match
 * NEGATIVE_INFORCE in lib/integrations/enrollhere/policyEvent.ts.
 */
const NEGATIVE_INFORCE_SQL = "(^|_)(NOT|NON|IN)_?(ACTIVE|INFORCE|IN_FORCE|EFFECTUATED)";

export interface ApplicationAccessFacts {
  assignedAgentId: string | null;
  agentNpn: string | null;
  agentEmail: string | null;
  policyStatus: string | null;
  /** The application's enrollment, when it has one. */
  enrollmentStatus: string | null;
  enrollmentDisenrolledDate: string | null;
  hasEnrollment: boolean;
}

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

/** The application records this agent as its writer (NPN, else email). */
function wroteApplication(viewer: PhiViewerAgent, f: ApplicationAccessFacts): boolean {
  const npn = digits(f.agentNpn);
  if (npn && digits(viewer.npn) === npn) return true;
  const email = f.agentEmail?.trim().toLowerCase();
  return !!email && viewer.email?.trim().toLowerCase() === email;
}

/** The application's policy is still in play. */
function applicationServiced(f: ApplicationAccessFacts): boolean {
  if (isEndedStatus(f.policyStatus)) return false;
  if (!f.hasEnrollment) return true;
  return (SERVICED_ENROLLMENT_STATUSES as readonly string[]).includes(f.enrollmentStatus ?? "") && !f.enrollmentDisenrolledDate;
}

/**
 * May this viewer open a client's full enrollment application? Privileged
 * roles always; otherwise the viewer must be the client's assigned agent, or
 * the application's own writing agent while its policy is still in play.
 */
export function mayViewFullApplication(
  userRole: AuthenticatedRequest["userRole"],
  viewer: PhiViewerAgent | null,
  f: ApplicationAccessFacts,
): boolean {
  if (PHI_PRIVILEGED_ROLES.has(userRole)) return true;
  if (!viewer) return false;
  if (f.assignedAgentId === viewer.id) return true;
  return wroteApplication(viewer, f) && applicationServiced(f);
}

/** Columns for ApplicationAccessFacts; join enrollmentsTable (left) and contactsTable. */
export const applicationAccessColumns = {
  assignedAgentId: contactsTable.assignedAgentId,
  agentNpn: enrollmentApplicationsTable.agentNpn,
  agentEmail: enrollmentApplicationsTable.agentEmail,
  policyStatus: enrollmentApplicationsTable.policyStatus,
  enrollmentStatus: sql<string | null>`${enrollmentsTable.status}::text`,
  enrollmentDisenrolledDate: enrollmentsTable.disenrolledDate,
  hasEnrollment: sql<boolean>`${enrollmentsTable.id} is not null`,
};

/**
 * Contacts this agent services: assigned to them, or holding a policy they
 * wrote that is still in play (pending/active, not disenrolled, and no
 * application on it reporting "not in force").
 */
export function servicedByAgent(agentId: string): SQL {
  return or(
    eq(contactsTable.assignedAgentId, agentId),
    exists(
      db.select({ one: sql`1` }).from(enrollmentsTable).where(and(
        eq(enrollmentsTable.contactId, contactsTable.id),
        eq(enrollmentsTable.agentId, agentId),
        inArray(enrollmentsTable.status, [...SERVICED_ENROLLMENT_STATUSES]),
        isNull(enrollmentsTable.disenrolledDate),
        not(exists(
          db.select({ one: sql`1` }).from(enrollmentApplicationsTable).where(and(
            eq(enrollmentApplicationsTable.enrollmentId, enrollmentsTable.id),
            sql`upper(coalesce(${enrollmentApplicationsTable.policyStatus}, '')) ~ ${NEGATIVE_INFORCE_SQL}`,
          )),
        )),
      )),
    ),
  )!;
}
