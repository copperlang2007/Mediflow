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
  | "agent";

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
  | "dashboard";

export type Action = "read" | "create" | "update" | "delete" | "admin";

type PermissionMatrix = Record<Resource, Partial<Record<Action, Role[]>>>;

/**
 * For each resource/action, lists the roles that are ALLOWED.
 * If an action is absent the default is ["super_admin"] only.
 */
const MATRIX: PermissionMatrix = {
  org: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    update: ["super_admin", "agency_admin"],
    admin: ["super_admin"],
  },
  user: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent"],
    create: ["super_admin", "agency_admin"],
    update: ["super_admin", "agency_admin", "viewer", "agent"],
    delete: ["super_admin"],
    admin: ["super_admin"],
  },
  agent: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
    admin: ["super_admin", "agency_admin"],
  },
  license: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  certification: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  ahip: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  task_template: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  task_instance: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  document: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager"],
    delete: ["super_admin", "agency_admin"],
  },
  contact: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  lead: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  deal: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "agent_support"],
    update: ["super_admin", "agency_admin", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  activity: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  communication: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    create: ["super_admin", "agency_admin", "agent_support"],
    update: ["super_admin", "agency_admin"],
    delete: ["super_admin"],
  },
  automation: {
    read: ["super_admin", "agency_admin", "compliance_manager", "viewer"],
    create: ["super_admin", "agency_admin"],
    update: ["super_admin", "agency_admin"],
    delete: ["super_admin", "agency_admin"],
    admin: ["super_admin"],
  },
  notification: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent"],
    update: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer", "agent"],
    delete: ["super_admin"],
  },
  audit_log: {
    read: ["super_admin", "agency_admin", "compliance_manager"],
  },
  storage: {
    read: ["super_admin", "agency_admin", "compliance_manager", "agent_support", "viewer"],
    create: ["super_admin", "agency_admin", "compliance_manager", "agent_support"],
    delete: ["super_admin", "agency_admin"],
  },
  compliance_report: {
    read: ["super_admin", "agency_admin", "compliance_manager"],
    create: ["super_admin", "agency_admin", "compliance_manager"],
    admin: ["super_admin", "agency_admin"],
  },
  retention_alert: {
    read: ["super_admin", "agency_admin", "compliance_manager"],
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
    ],
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
