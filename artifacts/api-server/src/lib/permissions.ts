/**
 * Centralized RBAC permission matrix.
 *
 * Maps every (resource, action) pair to the minimum set of roles allowed.
 * Evaluated by `can()` — never re-implement inline checks.
 */

export type Role =
  | "super_admin"
  | "agency_admin"
  | "compliance_manager"
  | "agent_support"
  | "viewer"
  | "agent"
  | "developer";

export type Resource =
  | "org"
  | "user"
  | "agent"
  | "license"
  | "certification"
  | "ahip"
  | "task_template"
  | "task_instance"
  | "document"
  | "contact"
  | "lead"
  | "deal"
  | "activity"
  | "communication"
  | "automation"
  | "notification"
  | "audit_log"
  | "storage"
  | "compliance_report"
  | "retention_alert"
  | "dashboard"
  | "commission"
  | "agent_onboarding"
  | "carrier_contracting"
  | "esign"
  | "billing"
  | "invitation"
  | "seat"
  | "dev_console"
  | "kb_article"
  | "appointment";

export type Action = "read" | "create" | "update" | "delete" | "admin";

type PermissionMatrix = Record<Resource, Partial<Record<Action, Role[]>>>;

/**
 * For each resource/action, lists the roles that are ALLOWED.
 * If an action is absent the default is ["super_admin"] only.
 */
const MATRIX: PermissionMatrix = {
  org: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    update: ["super_admin", "agency_admin"],
    admin: ["super_admin"],
  },
  user: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent", "developer"],
    create: ["super_admin", "agency_admin"],
    update: ["super_admin", "agency_admin", "viewer", "agent"],
    delete: ["super_admin"],
    admin: ["super_admin"],
  },
  seat: {
    // Activating or deactivating a member changes what the agency is billed
    // for. That is an owner decision, not a compliance-manager one — but it
    // is emphatically NOT reserved to `super_admin`, which in this product is
    // agencyBRIDGE staff, not the customer.
    read: ["super_admin", "agency_admin"],
    update: ["super_admin", "agency_admin"],
    admin: ["super_admin", "agency_admin"],
  },
  invitation: {
    // Seat management is an owner concern: who joins the agency, and how many
    // seats the invoice carries. Deliberately narrower than `user.read`.
    read: ["super_admin", "agency_admin"],
    create: ["super_admin", "agency_admin"],
    delete: ["super_admin", "agency_admin"],
    admin: ["super_admin", "agency_admin"],
  },
  agent: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
    admin: ["super_admin", "agency_admin"],
  },
  license: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  certification: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  ahip: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  task_template: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  // `agent` gets read + update ONLY; routes/tasks.ts narrows it to rows for
  // the caller's own agent profile / assigned to the caller (status changes
  // only). Never create/delete; task templates stay admin-only.
  task_instance: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "agent"],
    delete: ["super_admin", "agency_admin"],
  },
  document: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  contact: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  lead: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  deal: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "agent_support"],
    update: ["super_admin", "agency_admin", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  activity: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  communication: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "developer"],
    create: ["super_admin", "agency_admin", "agent_support"],
    update: ["super_admin", "agency_admin"],
    delete: ["super_admin"],
  },
  automation: {
    read: ["super_admin", "agency_admin", "compliance_manager", "viewer", "developer"],
    create: ["super_admin", "agency_admin"],
    update: ["super_admin", "agency_admin"],
    delete: ["super_admin", "agency_admin"],
    admin: ["super_admin"],
  },
  notification: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent", "developer"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent"],
    delete: ["super_admin"],
  },
  audit_log: {
    read: ["super_admin", "agency_admin", "compliance_manager", "developer"],
  },
  storage: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  compliance_report: {
    read: ["super_admin", "agency_admin", "compliance_manager", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    admin: ["super_admin", "agency_admin"],
  },
  retention_alert: {
    read: ["super_admin", "agency_admin", "compliance_manager", "developer"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
  },
  dashboard: {
    read: [
      "super_admin",
      "agency_admin",
      "compliance_manager",
      "agent_support",
      "viewer",
      "agent",
      "developer",
    ],
  },
  commission: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "developer"],
    create: ["super_admin", "agency_admin"],
    update: ["super_admin", "agency_admin"],
    delete: ["super_admin"],
  },
  // Onboarding runs are an admin/compliance concern and the agent themselves;
  // we still gate route-level access via `agent` permissions, but expose
  // these resource types for audit-log entries.
  agent_onboarding: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "agent", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent"],
    delete: ["super_admin", "agency_admin"],
  },
  carrier_contracting: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "agent", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  // Native e-signature envelopes (Beta). Mirrors `carrier_contracting`'s
  // matrix — an agent can create/sign their own envelope; admins can act
  // on behalf. Route-level handlers do an additional narrowing check that
  // ties the caller to the envelope's signer-userId.
  esign: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "agent", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent"],
    delete: ["super_admin", "agency_admin"],
  },
  // Subscription + payment method. Deliberately the narrowest matrix in the
  // system: only the people who own the agency's money can see an invoice or
  // change a plan. `compliance_manager` and `agent_support` are excluded on
  // purpose — they administer compliance and agents, not spend.
  billing: {
    read: ["super_admin", "agency_admin"],
    update: ["super_admin", "agency_admin"],
    admin: ["super_admin"],
  },
  dev_console: {
    read: ["super_admin", "developer"],
    admin: ["super_admin", "developer"],
  },
  // Knowledge Base articles (stage 2). Non-PHI reference notes: every staff
  // role in the org may read them (they also feed the AI assistant); only the
  // agency's owners may write them.
  kb_article: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent", "developer"],
    create: ["super_admin", "agency_admin"],
    update: ["super_admin", "agency_admin"],
    delete: ["super_admin", "agency_admin"],
  },
  // Calendar appointments (stage2/calendar-branding). Back office mirrors
  // `contact`; `agent` is added because an agent books their own meetings.
  // routes/appointments.ts narrows the `agent` role to rows whose agent_id is
  // the caller's own agent profile — this matrix only admits the role.
  appointment: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent", "developer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "agent"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "agent"],
    delete: ["super_admin", "agency_admin", "agent"],
  },
};

/**
 * Checks whether the given role is allowed to perform `action` on `resource`.
 */
export function can(role: Role, resource: Resource, action: Action): boolean {
  const allowed = MATRIX[resource]?.[action] ?? ["super_admin"];
  return allowed.includes(role);
}

/**
 * Returns all allowed roles for a given resource/action pair.
 */
export function allowedRoles(resource: Resource, action: Action): Role[] {
  return (MATRIX[resource]?.[action] ?? ["super_admin"]) as Role[];
}

/**
 * Roles allowed to see full PHI / PII in plaintext.
 *
 * Applies to:
 *   - Contact PHI in `routes/contacts.ts` (DOB, Medicare ID, health conditions)
 *   - Agent contracting PII in `routes/onboarding.ts` (SSN, EIN, DOB)
 *
 * Anyone outside this set sees a masked sentinel (e.g. `***-**-****`) and
 * `null` for the date-of-birth field. The design partner expects identical
 * handling for contact PHI and contracting PII, so the canonical set lives
 * here next to the permission matrix instead of in two route files.
 */
export const PHI_PRIVILEGED_ROLES: Set<Role> = new Set<Role>([
  "super_admin",
  "agency_admin",
  "compliance_manager",
]);
