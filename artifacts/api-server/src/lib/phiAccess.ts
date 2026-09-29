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

/**
 * The application records this agent as its writer: by NPN when it carries
 * one (a mismatched NPN never falls back to email), else by email.
 */
function wroteApplication(viewer: PhiViewerAgent, f: ApplicationAccessFacts): boolean {
  const npn = digits(f.agentNpn);
  if (npn) return digits(viewer.npn) === npn;
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

/** SQL twin of isEndedStatus() (lib/integrations/enrollhere/policyEvent.ts) on a raw policy status. */
function endedStatusSql(col: SQL): SQL {
  const u = sql`upper(coalesce(${col}, ''))`;
  return sql`(${u} ~ ${NEGATIVE_INFORCE_SQL} or (${u} !~ 'INFORCE|IN_FORCE|ACTIVE|EFFECTUATED' and ${u} ~ 'CANCEL|WITHDRAW|RESCIND|TERMINAT|DISENROLL|LAPSE|DECLIN|REJECT|DENIED|DENY'))`;
}

/**
 * Contacts this agent services:
 *   - assigned to them; or
 *   - holding an application this agent wrote (its NPN, else its email, as in
 *     wroteApplication) whose policy is still in play: not reported ended,
 *     and its enrollment (if any) pending/active and not disenrolled; or
 *   - holding a pending/active, not disenrolled enrollment recorded with this
 *     agent that carries no application (a manual or CSV entry). An
 *     enrollment with applications is judged by their writers instead, since
 *     a shared enrollment row keeps only its first writer.
 */
export function servicedByAgent(viewer: PhiViewerAgent): SQL {
  const a = enrollmentApplicationsTable;
  const e = enrollmentsTable;
  const npn = digits(viewer.npn);
  const email = viewer.email?.trim().toLowerCase() ?? "";
  const appNpn = sql`regexp_replace(coalesce(${a.agentNpn}, ''), '[^0-9]', '', 'g')`;
  const wroteIt = sql`(case when ${appNpn} <> '' then ${appNpn} = ${npn} else ${email} <> '' and lower(trim(coalesce(${a.agentEmail}, ''))) = ${email} end)`;
  const enrollmentLive = and(inArray(e.status, [...SERVICED_ENROLLMENT_STATUSES]), isNull(e.disenrolledDate));
  return or(
    eq(contactsTable.assignedAgentId, viewer.id),
    exists(
      db.select({ one: sql`1` }).from(a)
        .leftJoin(e, eq(e.id, a.enrollmentId))
        .where(and(
          eq(a.contactId, contactsTable.id),
          wroteIt,
          not(endedStatusSql(sql`${a.policyStatus}`)),
          or(isNull(a.enrollmentId), enrollmentLive),
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
