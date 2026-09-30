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
 *     A full application opens for its own writing agent: the agent profile
 *     recorded on the application when it was stored (resolved from its NPN,
 *     else email, only when exactly one profile matched), never re-matched
 *     at read time and never whoever else sits on a shared enrollment row.
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
}

/**
 * The agent-role viewer's own agent profile, which widens their PHI access to
 * the clients they service. Null for every other role (privileged roles need
 * no widening; back-office roles never gain PHI through a linked agent row),
 * for an agent with no linked profile, and for a suspended or offboarded one.
 */
export async function phiViewerAgent(authReq: AuthenticatedRequest): Promise<PhiViewerAgent | null> {
  if (authReq.userRole !== "agent") return null;
  const [row] = await db.select({ id: agentsTable.id, status: agentsTable.status })
    .from(agentsTable)
    .where(and(eq(agentsTable.orgId, authReq.orgId), eq(agentsTable.userId, authReq.userId)))
    .limit(1);
  if (!row || INACTIVE_AGENT_STATUSES.has(row.status)) return null;
  return { id: row.id };
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
  /** The agent profile recorded as the application's writer when it was stored. */
  writingAgentId: string | null;
  policyStatus: string | null;
  /** The application's enrollment, when it has one. */
  enrollmentStatus: string | null;
  enrollmentDisenrolledDate: string | null;
  hasEnrollment: boolean;
}

/**
 * The application's policy is still in play: not reported ended, on an
 * enrollment that is pending/active and not disenrolled. An application with
 * no enrollment (stored before its plan or effective date were known) has no
 * policy lifetime to bound access, so it grants the writer nothing; the
 * assigned agent still sees it.
 */
function applicationServiced(f: ApplicationAccessFacts): boolean {
  if (isEndedStatus(f.policyStatus) || !f.hasEnrollment) return false;
  return (SERVICED_ENROLLMENT_STATUSES as readonly string[]).includes(f.enrollmentStatus ?? "") && !f.enrollmentDisenrolledDate;
}

/**
 * May this viewer open a client's full enrollment application? Privileged
 * roles always; otherwise the viewer must be the client's assigned agent, or
 * the application's recorded writer while its policy is still in play.
 */
export function mayViewFullApplication(
  userRole: AuthenticatedRequest["userRole"],
  viewer: PhiViewerAgent | null,
  f: ApplicationAccessFacts,
): boolean {
  if (PHI_PRIVILEGED_ROLES.has(userRole)) return true;
  if (!viewer) return false;
  if (f.assignedAgentId === viewer.id) return true;
  return f.writingAgentId === viewer.id && applicationServiced(f);
}

/** Columns for ApplicationAccessFacts; join enrollmentsTable (left) and contactsTable. */
export const applicationAccessColumns = {
  assignedAgentId: contactsTable.assignedAgentId,
  writingAgentId: enrollmentApplicationsTable.writingAgentId,
  policyStatus: enrollmentApplicationsTable.policyStatus,
  enrollmentStatus: sql<string | null>`${enrollmentsTable.status}::text`,
  enrollmentDisenrolledDate: enrollmentsTable.disenrolledDate,
  hasEnrollment: sql<boolean>`${enrollmentsTable.id} is not null`,
};

/** SQL twin of isEndedStatus() (lib/integrations/enrollhere/policyEvent.ts) on a raw policy status. */
function endedStatusSql(col: SQL): SQL {
  const u = sql`upper(coalesce(${col}, ''))`;
  return sql`(${u} ~ ${NEGATIVE_INFORCE_SQL} or (${u} !~ 'INFORCE|IN_FORCE|ACTIVE|EFFECTUATED' and ${u} ~ 'CANCEL|WITHDRAW|RESCIND|TERMINAT|DISENROLL|LAPSE|DECLIN|REJECT|DENIED|DENY'))`;
}

/**
 * Contacts this agent services (the same rules as mayViewFullApplication, so
 * the list, the client detail and the full view agree):
 *   - assigned to them; or
 *   - holding an application recorded as theirs whose policy is still in
 *     play (not reported ended; enrollment pending/active, not disenrolled);
 *   - holding a pending/active, not disenrolled enrollment recorded with them
 *     that carries no application (a manual or CSV entry). An enrollment with
 *     applications is judged by their recorded writers instead, since a shared
 *     enrollment row keeps only its first writer.
 */
export function servicedByAgent(viewer: PhiViewerAgent): SQL {
  const a = enrollmentApplicationsTable;
  const e = enrollmentsTable;
  const enrollmentLive = and(inArray(e.status, [...SERVICED_ENROLLMENT_STATUSES]), isNull(e.disenrolledDate));
  return or(
    eq(contactsTable.assignedAgentId, viewer.id),
    exists(
      db.select({ one: sql`1` }).from(a)
        .innerJoin(e, eq(e.id, a.enrollmentId))
        .where(and(
          eq(a.contactId, contactsTable.id),
          eq(a.writingAgentId, viewer.id),
          not(endedStatusSql(sql`${a.policyStatus}`)),
          enrollmentLive,
        )),
    ),
    exists(
      db.select({ one: sql`1` }).from(e).where(and(
        eq(e.contactId, contactsTable.id),
        eq(e.agentId, viewer.id),
        enrollmentLive,
        not(exists(db.select({ one: sql`1` }).from(a).where(eq(a.enrollmentId, e.id)))),
      )),
    ),
  )!;
}
